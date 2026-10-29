import { setTimeout as pause } from "node:timers/promises";
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
   * once nothing here says it will go on by itself. A subscription to a child on another host is
   * never followed: its activity is not visible from here.
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
/** What `deliver` says beyond the child's reason, and how the loop proceeds after it. */
interface NotificationView {
  reason?: FinishNotificationReason;
  unsettled?: readonly string[];
  limit?: string;
  repeatsEarlierReply?: boolean;
  subscriptionEnds?: boolean;
}
type Plan =
  | { kind: "final"; view: NotificationView }
  | { kind: "notice"; view: NotificationView }
  | { kind: "quiet" };
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
  /** Empty when nothing says the child will go on by itself. */
  async function unsettledReasons(childAgentId: string): Promise<string[]> {
    let activity: ChildActivity | undefined;
    try {
      activity = await deps.childActivity?.(childAgentId);
    } catch (error) {
      // No answer is the same as a provider with no opinion: do not hold the notification back.
      deps.logger.warn({ err: error, childAgentId }, "Could not tell whether the child settled");
    }
    const reasons: string[] = [];
    const delegated = delegatedBy(childAgentId);
    if (delegated) reasons.push(`waiting on ${plural(delegated, "delegated agent")}`);
    if (activity?.providerBackgroundWork)
      reasons.push("provider reports unfinished background tasks");
    if (activity?.queuedMessages) reasons.push("has queued messages");
    if (activity?.running) reasons.push("started another turn");
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
  async function deliver(
    record: FinishSubscription,
    result: FinishObservationResult,
    permissions: Set<string>,
    signal: AbortSignal,
    view: NotificationView = {},
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
          repeatsEarlierReply: view.repeatsEarlierReply,
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
    if (signal.aborted) return false;
    // A permission request or a not-final notice leaves the subscription in place.
    return reason !== "needs permission" && reason !== "is still working";
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
    let observation: FinishObservationSession | undefined;
    let pending: FinishObservationResult | undefined;
    let acknowledged = false;
    let remoteFailures = 0;
    let retries = 0;
    let warned = false;
    // Only a child on this host whose activity is known can be followed past an ended turn.
    const canFollow = deps.childActivity !== undefined && !record.serverId;
    let following = canFollow ? restoreFollowing(watch.records) : undefined;
    // The not-final notice was acknowledged; recording that is retried without telling again.
    let beginning: Following | undefined;
    // A plan made by a recheck, for the result it synthesized from the last observed turn.
    let planned: Plan | undefined;
    let lastObserved: FinishObservationResult | undefined;
    let lastReply: string | null = null;
    let inflight: Promise<FinishObservationResult | undefined> | undefined;
    const now = deps.now ?? Date.now;
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
    /** While following, wake up now and then: the child may settle without another turn. */
    async function observeOrRecheck(): Promise<
      FinishObservationResult | undefined | typeof RECHECK
    > {
      if (!following) return observeNext();
      // One observation stays in flight across wake-ups, so a result that arrives while a recheck
      // runs is still there for the next pass instead of being consumed unseen.
      inflight ??= observeNext();
      const timer = new AbortController();
      let outcome: FinishObservationResult | undefined | typeof RECHECK;
      try {
        outcome = await Promise.race([
          inflight,
          pause<typeof RECHECK>(deps.recheckIntervalMs ?? RECHECK_INTERVAL_MS, RECHECK, {
            signal: AbortSignal.any([signal, timer.signal]),
          }),
        ]);
      } catch (error) {
        inflight = undefined;
        throw error;
      } finally {
        timer.abort();
      }
      if (outcome !== RECHECK) inflight = undefined;
      return outcome;
    }
    function limitReached(turns: number): string | undefined {
      if (!following) return undefined;
      if (now() - following.since >= FOLLOW_LIMIT_MS) return "24 hours";
      if (turns >= FOLLOW_LIMIT_TURNS) return `${FOLLOW_LIMIT_TURNS} more turns`;
      return undefined;
    }
    function stoppedFollowing(limit: string): Plan {
      return { kind: "final", view: { reason: "stopped following", limit } };
    }
    /** The idle child may have settled, or run out of time, since it last ended a turn. */
    async function recheck(): Promise<void> {
      if (!following || !lastObserved) return;
      const unsettled = await unsettledReasons(record.childAgentId);
      const limit = limitReached(following.turns);
      if (unsettled.length && !limit) return;
      planned = unsettled.length
        ? stoppedFollowing(limit!)
        : { kind: "final", view: { repeatsEarlierReply: true, subscriptionEnds: true } };
      pending = { ...lastObserved, lastMessage: lastReply };
    }
    async function plan(result: FinishObservationResult): Promise<Plan> {
      if (planned) return planned;
      if (!canFollow || reasonFor(result) !== "finished") return { kind: "final", view: {} };
      lastObserved = result;
      lastReply = result.lastMessage ?? lastReply;
      const unsettled = await unsettledReasons(record.childAgentId);
      if (!unsettled.length) return { kind: "final", view: { subscriptionEnds: true } };
      if (!following) return { kind: "notice", view: { reason: "is still working", unsettled } };
      const limit = limitReached(following.turns + 1);
      return limit ? stoppedFollowing(limit) : { kind: "quiet" };
    }
    function next(): void {
      pending = undefined;
      planned = undefined;
      retries = 0;
      warned = false;
    }
    async function end(): Promise<void> {
      await remove(watch);
      stop(watch, group);
    }
    async function acquire(): Promise<FinishObservationResult | undefined> {
      const observed = await observeOrRecheck();
      if (observed === RECHECK) {
        await recheck();
        return pending;
      }
      pending = observed;
      if (!pending) await delay(signal, retries++);
      return pending;
    }
    /** One pass over the result the child ended on. True once the subscription has ended. */
    async function handle(result: FinishObservationResult): Promise<boolean> {
      if (beginning) {
        await persistFollowing(watch, beginning);
        following = beginning;
        beginning = undefined;
        next();
        return false;
      }
      if (!acknowledged) {
        const step = await plan(result);
        if (step.kind === "quiet") {
          const turned = { since: following!.since, turns: following!.turns + 1 };
          await persistFollowing(watch, turned);
          following = turned;
          next();
          return false;
        }
        const ended = await deliver(record, result, permissions, signal, step.view);
        if (step.kind === "notice") {
          if (!signal.aborted) beginning = { since: now(), turns: 0 };
          return false;
        }
        acknowledged = ended;
      }
      if (!acknowledged) {
        next();
        return false;
      }
      // A removal failure retries only the commit, never the already accepted callback.
      await end();
      return true;
    }
    try {
      while (!signal.aborted) {
        try {
          if (await suppressed(record)) {
            await end();
            return;
          }
          const result = pending ?? (await acquire());
          if (!result) continue;
          if (signal.aborted) return;
          await decisions(group);
          if (signal.aborted) return;
          if (await suppressed(record, result)) {
            await end();
            return;
          }
          if (await handle(result)) return;
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
