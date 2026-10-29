import { setImmediate as turn, setTimeout as pause } from "node:timers/promises";
import { HostObservationError } from "../host-operations/index.js";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { FinishObservationResult } from "./internal/observation-buffer.js";
import type { AgentMessageDelivery } from "../agent-messages/index.js";
import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import {
  formatFinishNotificationBody,
  finishNotificationEvents,
  type FinishNotificationReason,
} from "./internal/notification.js";
import { createFailureLog, type FailureLog } from "./internal/failure-log.js";
export { createJsonFinishSubscriptionStore } from "./internal/json-store.js";

/**
 * A subscription that has told its caller "ended its turn, still has background work" stays alive
 * until the child settles or one of these limits ends it. The limits are what keeps two agents
 * that each wait on the other, or a child whose work never finishes, from being followed forever.
 * A day covers a long build or test run that outlives a working session; 50 turns is far more than
 * a child that is merely slow to finish ends, and bounds how long two agents prompting each other
 * can keep a subscription alive. Either one ends the subscription with a "stopped following" note.
 */
export const FOLLOW_LIMIT_MS = 24 * 60 * 60 * 1000;
export const FOLLOW_LIMIT_TURNS = 50;
/** An idle child that is being followed may settle without ever starting another turn. */
const RECHECK_INTERVAL_MS = 10_000;
const RECHECK = Symbol("recheck");

export interface FinishSubscription {
  id: string;
  callerAgentId: string;
  childAgentId: string;
  serverId?: string;
  /** Creation subscriptions stop reporting after the child is detached. */
  requireParentOwnership?: boolean;
  /** Set once the caller was told the child's turn ended with work still pending. */
  followingSince?: string;
  /** Turns the child has ended, unsettled, since `followingSince`. */
  followedTurns?: number;
}
/** What an idle child may still do on its own, as far as this daemon can tell. */
export interface ChildActivity {
  /** It started another turn since the one that just ended. */
  running: boolean;
  /** Its provider reports background work, or a completion it has not yet been told about. */
  providerBackgroundWork: boolean;
  /** Messages addressed to it that have not started a turn yet. */
  queuedMessages: boolean;
  /**
   * The answer above cannot be trusted: its provider has the probe but did not answer it, or the
   * runtime that answered is no longer the child's. Not knowing counts as not settled. The text
   * goes into the notification to the caller.
   */
  uncertain?:
    | "its background state could not be read"
    | "its runtime was replaced while being checked";
}
export interface FinishSubscriptionStore {
  list(): Promise<FinishSubscription[]>;
  put(subscription: FinishSubscription): Promise<void>;
  remove(id: string): Promise<void>;
}
export interface FinishObservationSession {
  next(): Promise<FinishObservationResult>;
  close(): Promise<void>;
}
export interface FinishObservation {
  open(subscription: FinishSubscription, signal: AbortSignal): Promise<FinishObservationSession>;
}
interface Dependencies extends FinishObservation {
  store: FinishSubscriptionStore;
  messages(): AgentMessageDelivery;
  callerIsActive(agentId: string): Promise<boolean>;
  /**
   * Without it every ended turn is final. With it, a local child whose turn ended is only final
   * once nothing here says it will go on by itself and nothing about it is unknown: a rejected
   * call counts as unknown. A subscription to a child on another host is never followed: its
   * activity is not visible from here.
   */
  childActivity?(childAgentId: string): Promise<ChildActivity>;
  serverId: string;
  logger: Logger;
  retryDelayMs?: number;
  recheckIntervalMs?: number;
  now?: () => number;
}
export interface FinishRegistration {
  /** The prompt was accepted. Replaces preceding registrations for this pair. */
  accept(): void;
  /** Rejected dispatch preserves preceding registrations. */
  reject(): Promise<void>;
}
export interface FinishSubscriptions {
  start(): Promise<void>;
  /** Pending notification intent, including registration, recovery and unacknowledged delivery. */
  hasPendingForCaller(agentId: string): boolean;
  register(
    input: Omit<FinishSubscription, "id">,
    pendingDispatch?: boolean,
  ): Promise<FinishRegistration>;
  close(): Promise<void>;
}
interface Watch {
  records: FinishSubscription[];
  controller: AbortController;
  decision: Promise<boolean>;
  decide(accepted: boolean): void;
  pending: boolean;
  task?: Promise<void>;
}
interface Following {
  since: number;
  turns: number;
}
/** What `deliver` says beyond the child's reason. */
interface NotificationView {
  reason?: FinishNotificationReason;
  unsettled?: readonly string[];
  limit?: string;
  settledQuietly?: "same reply" | "later reply";
  subscriptionEnds?: boolean;
}

/**
 * Where one subscription stands in telling its caller about one child. Every state holds only
 * what it needs, and says what comes after it; the main loop in `run` just advances the state.
 * Two things move a `waiting` state: the observation produced a result, or a followed child was
 * due for a recheck.
 */
type Stage = Waiting | Recording | Delivering | typeof ENDING;
interface Waiting {
  kind: "waiting";
  /** Set once the caller was told the child is still working. Only a followed child is rechecked. */
  following?: Following;
  /** The last turn the child ended on, carrying the newest reply it gave. */
  lastEnded?: FinishObservationResult;
  /** The reply the caller last received for this child (null: that notice carried none). */
  told?: string | null;
}
/** The follow mark goes to disk, then `next`. */
interface Recording {
  kind: "recording";
  following: Following;
  next: Stage;
}
/** The caller is told. Retried until the notification is acknowledged, then `next`. */
interface Delivering {
  kind: "delivering";
  result: FinishObservationResult;
  view: NotificationView;
  next: Stage;
}
/** The caller has been told everything: only the record is left to remove. */
const ENDING = { kind: "ending" } as const;
type FollowEvent = { kind: "result"; result: FinishObservationResult } | { kind: "recheck" };
/** Stands in for the last turn when a recovered subscription has observed none yet. */
const NOTHING_OBSERVED: FinishObservationResult = {
  status: "idle",
  final: null,
  lastMessage: null,
  error: null,
};
const UNREADABLE: NonNullable<ChildActivity["uncertain"]> =
  "its background state could not be read";

function tell(result: FinishObservationResult, view: NotificationView, next: Stage): Delivering {
  return { kind: "delivering", result, view, next };
}
function limitReached(following: Following, now: number): string | undefined {
  if (now - following.since >= FOLLOW_LIMIT_MS) return "24 hours";
  if (following.turns >= FOLLOW_LIMIT_TURNS) return `${FOLLOW_LIMIT_TURNS} more turns`;
  return undefined;
}
function key(record: FinishSubscription): string {
  return JSON.stringify([record.callerAgentId, record.childAgentId, record.serverId]);
}
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
function restoreFollowing(records: readonly FinishSubscription[]): Following | undefined {
  // A record without the mark is a newer registration for the same pair: the caller prompted again.
  if (!records.every((record) => record.followingSince)) return undefined;
  const since = Math.min(...records.map((record) => Date.parse(record.followingSince!)));
  if (Number.isNaN(since)) return undefined;
  return { since, turns: Math.max(...records.map((record) => record.followedTurns ?? 0)) };
}

/** Owns durable intent, live observation, supersession, and dispatch acknowledgment. */
export function createFinishSubscriptions(deps: Dependencies): FinishSubscriptions {
  const tasks = new Set<Promise<void>>();
  const watches = new Map<string, Set<Watch>>();
  let closed = false;
  let recovering = true;
  const registering = new Map<string, number>();
  let mutations = Promise.resolve();
  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = mutations.then(action);
    mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  function attach(records: FinishSubscription[], pending: boolean): Watch {
    let decide!: Watch["decide"];
    const decision = new Promise<boolean>((resolve) => {
      decide = resolve;
    });
    const watch: Watch = { records, controller: new AbortController(), pending, decision, decide };
    const group = watches.get(key(records[0]!)) ?? new Set<Watch>();
    group.add(watch);
    watches.set(key(records[0]!), group);
    if (!pending) decide(true);
    watch.task = run(watch, group).catch((error) =>
      deps.logger.error({ err: error }, "Finish subscription failed"),
    );
    tasks.add(watch.task);
    void watch.task.then(() => tasks.delete(watch.task!));
    return watch;
  }
  function stop(watch: Watch, group: Set<Watch>): void {
    watch.controller.abort();
    watch.decide(false);
    group.delete(watch);
    if (!group.size && watches.get(key(watch.records[0]!)) === group)
      watches.delete(key(watch.records[0]!));
  }
  async function remove(watch: Watch): Promise<void> {
    // Only IDs captured by this observer are eligible; newer registrations survive.
    for (const record of watch.records) await deps.store.remove(record.id);
  }
  async function delay(signal: AbortSignal, attempt: number): Promise<void> {
    try {
      await pause(
        Math.min((deps.retryDelayMs ?? 1000) * 2 ** Math.min(attempt, 3), 5000),
        undefined,
        { signal },
      );
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
  async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    let abort!: () => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([operation, cancellation]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async function decisions(group: Set<Watch>): Promise<void> {
    // New candidates may arrive while an older dispatch decision is pending.
    while (true) {
      if (closed) return;
      const pending = [...group].filter((watch) => watch.pending);
      if (!pending.length) return;
      await Promise.all(pending.map((watch) => watch.decision));
    }
  }
  async function suppressed(
    record: FinishSubscription,
    result?: WaitForFinishResult,
  ): Promise<boolean> {
    if (!(await deps.callerIsActive(record.callerAgentId))) return true;
    if (!record.requireParentOwnership || !result?.final) return false;
    const parent = getParentAddressFromLabels(
      result.final.labels,
      record.serverId ?? deps.serverId,
    );
    return parent?.agentId !== record.callerAgentId || parent.serverId !== deps.serverId;
  }
  function reasonFor(result: FinishObservationResult): FinishNotificationReason {
    if (result.reason === "host unreachable" || result.reason === "host removed")
      return result.reason;
    if (!result.final) return "is unavailable";
    if (result.final.status === "closed") return "was closed";
    if (result.status === "error") return "errored";
    if (result.status === "permission") return "needs permission";
    return result.reason ?? "finished";
  }
  function delegatedBy(agentId: string): number {
    let count = 0;
    for (const group of watches.values())
      for (const watch of group) if (watch.records[0]!.callerAgentId === agentId) count++;
    return Math.max(count, registering.has(agentId) ? 1 : 0);
  }
  /** Empty only when nothing says the child will go on by itself, and nothing is left unknown. */
  async function unsettledReasons(childAgentId: string, log: FailureLog): Promise<string[]> {
    const reasons: string[] = [];
    const delegated = delegatedBy(childAgentId);
    if (delegated) reasons.push(`waiting on ${plural(delegated, "delegated agent")}`);
    let activity: ChildActivity | undefined;
    try {
      activity = await deps.childActivity?.(childAgentId);
      log.recovered(childAgentId, { childAgentId }, "Can tell whether the child settled again");
    } catch (error) {
      // Not knowing is not the same as nothing pending: stay subscribed and ask again.
      log.failed(
        childAgentId,
        { err: error, childAgentId },
        "Could not tell whether the child settled",
      );
      reasons.push(UNREADABLE);
    }
    if (activity?.providerBackgroundWork)
      reasons.push("provider reports unfinished background tasks");
    if (activity?.queuedMessages) reasons.push("has queued messages");
    if (activity?.running) reasons.push("started another turn");
    if (activity?.uncertain) reasons.push(activity.uncertain);
    return reasons;
  }
  function persistFollowing(watch: Watch, state: Following): Promise<void> {
    return serialize(async () => {
      // A superseded or closing watch must not write its record back after it was removed.
      if (watch.controller.signal.aborted) return;
      for (const [index, record] of watch.records.entries()) {
        const next = {
          ...record,
          followingSince: new Date(state.since).toISOString(),
          followedTurns: state.turns,
        };
        await deps.store.put(next);
        watch.records[index] = next;
      }
    });
  }
  /** True once every notification was acknowledged; false if the watch ended first. */
  async function deliver(
    record: FinishSubscription,
    result: FinishObservationResult,
    permissions: Set<string>,
    signal: AbortSignal,
    view: NotificationView,
  ): Promise<boolean> {
    const requests = result.final?.pendingPermissions ?? [];
    const reason = view.reason ?? reasonFor(result);
    for (const id of permissions)
      if (!requests.some((request) => request.id === id)) permissions.delete(id);
    const acknowledgments: Promise<unknown>[] = [];
    for (const request of reason === "needs permission" ? requests : [undefined]) {
      if (signal.aborted) return false;
      if (request && permissions.has(request.id)) continue;
      const title = result.final?.title ?? record.childAgentId;
      const receipt = deps.messages().enqueue({
        recipientId: record.callerAgentId,
        prompt: formatFinishNotificationBody({
          childAgentId: record.childAgentId,
          serverId: record.serverId ?? deps.serverId,
          title,
          reason,
          lastAssistantMessage: result.lastMessage,
          permissionRequest: request,
          unsettled: view.unsettled,
          limit: view.limit,
          settledQuietly: view.settledQuietly,
          subscriptionEnds: view.subscriptionEnds,
        }),
        source: {
          kind: "agent-notification",
          agentId: record.childAgentId,
          serverId: record.serverId ?? deps.serverId,
          title,
          event: finishNotificationEvents[reason],
        },
        activeTurnBehavior: "steer",
        unarchive: false,
      });
      acknowledgments.push(
        receipt.dispatched.then(() => {
          if (request) permissions.add(request.id);
          return undefined;
        }),
      );
    }
    await abortable(Promise.all(acknowledgments), signal);
    return !signal.aborted;
  }
  async function run(watch: Watch, group: Set<Watch>): Promise<void> {
    const signal = watch.controller.signal;
    if (!(await watch.decision) || signal.aborted) return;
    const record = {
      ...watch.records[0]!,
      requireParentOwnership: watch.records.every(
        (intent) => intent.requireParentOwnership === true,
      ),
    };
    const permissions = new Set<string>();
    const now = deps.now ?? Date.now;
    // Only a child on this host whose activity is known can be followed past an ended turn.
    const canFollow = deps.childActivity !== undefined && !record.serverId;
    let observation: FinishObservationSession | undefined;
    // One observation stays outstanding between events, so a result that lands while the
    // subscription is busy with something else is still there for the next pass.
    let inflight: Promise<FinishObservationResult | undefined> | undefined;
    let remoteFailures = 0;
    let retries = 0;
    let warned = false;
    const activityLog = createFailureLog(deps.logger);
    async function observeNext(): Promise<FinishObservationResult | undefined> {
      try {
        observation ??= await deps.open(record, signal);
        const result = await abortable(observation.next(), signal);
        remoteFailures = 0;
        return result;
      } catch (error) {
        await observation?.close();
        observation = undefined;
        signal.throwIfAborted();
        if (!(error instanceof HostObservationError) || !record.serverId) throw error;
        if (error.reason === "connecting") return undefined;
        if (error.reason === "unreachable" && ++remoteFailures < 3) return undefined;
        // Host visibility ends this subscription; it says nothing about child completion.
        return {
          status: "error",
          final: null,
          lastMessage: null,
          error: null,
          reason: error.reason === "removed" ? "host removed" : "host unreachable",
        };
      }
    }
    /**
     * The next thing that happens to the subscription: the observation produced a result, or,
     * for a followed child, it is time to look again. undefined: nothing could be observed.
     */
    async function nextEvent(followed: boolean): Promise<FollowEvent | undefined> {
      inflight ??= observeNext();
      const timer = new AbortController();
      try {
        const outcome = await Promise.race([
          inflight,
          ...(followed
            ? [
                pause<typeof RECHECK>(deps.recheckIntervalMs ?? RECHECK_INTERVAL_MS, RECHECK, {
                  signal: AbortSignal.any([signal, timer.signal]),
                }),
              ]
            : []),
        ]);
        if (outcome === RECHECK) return { kind: "recheck" };
        inflight = undefined;
        return outcome ? { kind: "result", result: outcome } : undefined;
      } catch (error) {
        inflight = undefined;
        throw error;
      } finally {
        timer.abort();
      }
    }
    /**
     * Whether the observation already has something the caller has not been told: a result, or a
     * failure. A recheck must never talk over it. The event loop turns once first, so that whatever
     * is already on its way in has arrived.
     */
    async function observationHasNews(): Promise<boolean> {
      if (!inflight) return false;
      const arrived = inflight.then(
        () => true,
        () => true,
      );
      return Promise.race([arrived, turn().then(() => false)]);
    }
    /**
     * Before anything is told or recorded: wait out re-prompts whose dispatch is undecided, and
     * check that the caller still wants to hear. A stage is returned when the answer is no.
     */
    async function holdOff(
      result: FinishObservationResult,
      waiting: Waiting,
    ): Promise<Stage | undefined> {
      await decisions(group);
      if (signal.aborted) return waiting;
      return (await suppressed(record, result)) ? ENDING : undefined;
    }
    /** Event: the child ended a turn, or something else happened to it. */
    async function onResult(waiting: Waiting, result: FinishObservationResult): Promise<Stage> {
      const held = await holdOff(result, waiting);
      if (held) return held;
      const reason = reasonFor(result);
      if (!canFollow || reason !== "finished") {
        // Told as it is. A permission request leaves the subscription waiting for the next result.
        return tell(result, {}, reason === "needs permission" ? waiting : ENDING);
      }
      const unsettled = await unsettledReasons(record.childAgentId, activityLog);
      if (!unsettled.length) return tell(result, { subscriptionEnds: true }, ENDING);
      const lastEnded = {
        ...result,
        lastMessage: result.lastMessage ?? waiting.lastEnded?.lastMessage ?? null,
      };
      const { following } = waiting;
      if (!following) {
        // The mark goes to disk before the caller is told, so a restart in between loses only this
        // notice, never the final reply, and never starts the 24 hours over. The other order would
        // repeat the notice after a restart and reset the limit.
        const begun = { since: now(), turns: 0 };
        const next: Waiting = {
          kind: "waiting",
          following: begun,
          lastEnded,
          told: result.lastMessage,
        };
        const notice = tell(result, { reason: "is still working", unsettled }, next);
        return { kind: "recording", following: begun, next: notice };
      }
      const turned = { since: following.since, turns: following.turns + 1 };
      const limit = limitReached(turned, now());
      if (limit) return tell(lastEnded, { reason: "stopped following", limit }, ENDING);
      const next: Waiting = { kind: "waiting", following: turned, lastEnded, told: waiting.told };
      return { kind: "recording", following: turned, next };
    }
    /**
     * Event: a followed child is due for a look. Its background work may end without waking it,
     * and then no turn ends that would say so. The limits do not depend on anything having been
     * observed, which is what keeps a recovered subscription from being followed forever.
     */
    async function onRecheck(waiting: Waiting): Promise<Stage> {
      const { following } = waiting;
      if (!following) return waiting;
      const limit = limitReached(following, now());
      if (!limit && (await unsettledReasons(record.childAgentId, activityLog)).length)
        return waiting;
      const ended = waiting.lastEnded ?? NOTHING_OBSERVED;
      const held = await holdOff(ended, waiting);
      if (held) return held;
      if (limit) return tell(ended, { reason: "stopped following", limit }, ENDING);
      // The probe took a while. If the child ended a real turn meanwhile, that result is the news.
      if (await observationHasNews()) return waiting;
      const repeats = ended.lastMessage !== null && ended.lastMessage === waiting.told;
      const settledQuietly = repeats ? "same reply" : "later reply";
      return tell(ended, { reason: "finished", settledQuietly, subscriptionEnds: true }, ENDING);
    }
    async function advance(stage: Waiting | Recording | Delivering): Promise<Stage> {
      switch (stage.kind) {
        case "waiting": {
          const event = await nextEvent(stage.following !== undefined);
          if (!event) {
            await delay(signal, retries++);
            return stage;
          }
          return event.kind === "result" ? onResult(stage, event.result) : onRecheck(stage);
        }
        case "recording":
          await persistFollowing(watch, stage.following);
          return stage.next;
        case "delivering":
          // A delivery failure keeps the captured outcome and tries again; it never re-decides.
          return (await deliver(record, stage.result, permissions, signal, stage.view))
            ? stage.next
            : stage;
      }
    }
    try {
      let stage: Stage = {
        kind: "waiting",
        following: canFollow ? restoreFollowing(watch.records) : undefined,
      };
      while (!signal.aborted) {
        try {
          if (stage.kind === "ending" || (await suppressed(record))) {
            // Everything was told, or nobody is left to tell. A removal that fails is retried
            // here alone, never the accepted notification.
            await remove(watch);
            stop(watch, group);
            return;
          }
          const next = await advance(stage);
          if (next !== stage) {
            retries = 0;
            warned = false;
          }
          stage = next;
        } catch (error) {
          if (signal.aborted) return;
          // Delivery and storage failures retain the captured outcome and durable intent.
          // They do not spend the remote-observation budget or change the child's outcome.
          if (!warned) {
            deps.logger.warn(
              { err: error, subscription: record.id },
              "Retrying finish subscription",
            );
            warned = true;
          }
          await delay(signal, retries++);
        }
      }
    } finally {
      await observation?.close();
    }
  }

  return {
    hasPendingForCaller(agentId) {
      if (recovering || registering.has(agentId)) return true;
      for (const group of watches.values()) {
        for (const watch of group) if (watch.records[0]!.callerAgentId === agentId) return true;
      }
      return false;
    },
    start: () =>
      serialize(async () => {
        const groups = new Map<string, FinishSubscription[]>();
        for (const record of await deps.store.list()) {
          const records = groups.get(key(record)) ?? [];
          records.push(record);
          groups.set(key(record), records);
        }
        for (const records of groups.values()) attach(records, false);
        recovering = false;
      }),
    register: (input, pendingDispatch = false) => {
      registering.set(input.callerAgentId, (registering.get(input.callerAgentId) ?? 0) + 1);
      return serialize(async () => {
        if (closed) throw new Error("Finish subscriptions are closed");
        const record: FinishSubscription = {
          ...input,
          serverId: input.serverId === deps.serverId ? undefined : input.serverId,
          id: randomUUID(),
        };
        await deps.store.put(record);
        const group = watches.get(key(record)) ?? new Set<Watch>();
        const predecessors = [...group];
        const watch = attach([record], true);
        const actualGroup = watches.get(key(record))!;
        const registration: FinishRegistration = {
          accept() {
            if (!watch.pending || closed) return;
            watch.pending = false;
            for (const prior of predecessors) stop(prior, actualGroup);
            watch.decide(true);
            void serialize(async () => {
              for (const prior of predecessors) await remove(prior);
            }).catch((error) =>
              deps.logger.error({ err: error }, "Failed to remove superseded finish subscriptions"),
            );
          },
          reject: () =>
            serialize(async () => {
              await remove(watch);
              stop(watch, actualGroup);
            }),
        };
        if (!pendingDispatch) registration.accept();
        return registration;
      }).finally(() => {
        const remaining = registering.get(input.callerAgentId)! - 1;
        if (remaining) registering.set(input.callerAgentId, remaining);
        else registering.delete(input.callerAgentId);
      });
    },
    async close() {
      closed = true;
      await mutations;
      for (const group of watches.values())
        for (const watch of group) {
          watch.controller.abort();
          watch.decide(false);
        }
      await mutations;
      await Promise.all(tasks);
      await deps.store.list();
      // Dispatch may still be pending. The delivery owner drains it after observers stop.
    },
  };
}

export { createFinishObservation } from "./internal/observation.js";
export { createChildActivity } from "./internal/child-activity.js";
