import { createIdleRuntimeCleanup } from "../idle-runtime-cleanup/index.js";
import { HostObservationError } from "../host-operations/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { AgentMessageDelivery } from "../agent-messages/index.js";
import { buildStoredAgentPayload } from "../agent-projections.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  createChildActivity,
  createFinishSubscriptions,
  createJsonFinishSubscriptionStore,
  FOLLOW_LIMIT_MS,
  FOLLOW_LIMIT_TURNS,
  type ChildActivity,
  type FinishObservation,
  type FinishSubscriptions,
} from "./index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Observation implements FinishObservation {
  waits: Array<{
    signal: AbortSignal;
    child: string;
    result: ReturnType<typeof deferred<WaitForFinishResult>>;
  }> = [];
  permission = deferred<void>();
  opening: Promise<void> = Promise.resolve();
  openedSignals: AbortSignal[] = [];
  async open(record: { childAgentId: string }, signal: AbortSignal) {
    this.openedSignals.push(signal);
    await this.opening;
    return { next: () => this.wait(signal, record.childAgentId), close: async () => {} };
  }
  async wait(signal: AbortSignal, child = "child") {
    signal.throwIfAborted();
    const result = deferred<WaitForFinishResult>();
    signal.addEventListener("abort", () => result.reject(new Error("Stopped")), { once: true });
    this.waits.push({ signal, child, result });
    return result.promise;
  }
  afterPermission() {
    return this.permission.promise;
  }
}
class Delivery implements AgentMessageDelivery {
  prompts: string[] = [];
  recipients: string[] = [];
  acknowledgments: Array<ReturnType<typeof deferred<"steered">>> = [];
  enqueue(message: Parameters<AgentMessageDelivery["enqueue"]>[0]) {
    this.prompts.push(String(message.prompt));
    this.recipients.push(message.recipientId);
    const acknowledgment = deferred<"steered">();
    this.acknowledgments.push(acknowledgment);
    return {
      status: "queued" as const,
      messageId: "notification",
      dispatched: acknowledgment.promise,
    };
  }
  async close() {}
  async waitForDispatch() {}
}
const homes: string[] = [];
const services: FinishSubscriptions[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
type ExtraDependencies = Partial<
  Pick<
    Parameters<typeof createFinishSubscriptions>[0],
    "childActivity" | "recheckIntervalMs" | "now"
  >
>;
async function scenario(
  directory?: string,
  removalFailures = 0,
  retryDelayMs = 1,
  extra: ExtraDependencies = {},
) {
  const home = directory ?? (await mkdtemp(join(tmpdir(), "finish-recovery-")));
  if (!directory) homes.push(home);
  const durableStore = createJsonFinishSubscriptionStore(home);
  const store = {
    ...durableStore,
    async remove(id: string) {
      if (removalFailures > 0) {
        removalFailures--;
        throw new Error("Subscription removal unavailable");
      }
      await durableStore.remove(id);
    },
  };
  const observation = new Observation();
  const delivery = new Delivery();
  let active = true;
  const service = createFinishSubscriptions({
    store,
    messages: () => delivery,
    open: observation.open.bind(observation),
    callerIsActive: async () => active,
    serverId: "origin",
    logger: createTestLogger(),
    retryDelayMs,
    ...extra,
  });
  services.push(service);
  await service.start();
  return {
    home,
    store,
    observation,
    delivery,
    service,
    archive: () => {
      active = false;
    },
  };
}
const intent = { callerAgentId: "parent", childAgentId: "child" };
function outcome(status: "idle" | "running" | "closed" | "error" = "closed"): WaitForFinishResult {
  return {
    status: status === "error" ? "error" : "idle",
    final: buildStoredAgentPayload(
      {
        id: "child",
        provider: "codex",
        cwd: "/tmp",
        title: "Child",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        labels: { "paseo.parent-agent-id": "parent" },
        lastStatus: status,
      },
      ["codex"],
    ),
    lastMessage: "Partial work saved",
    error: null,
  };
}
async function until(check: () => boolean) {
  await expect.poll(check).toBe(true);
}

test("retains intent until parent dispatch acknowledgment, then restart sends nothing", async () => {
  const first = await scenario();
  await first.service.register(intent);
  await until(() => first.observation.waits.length === 1);
  first.observation.waits[0]!.result.resolve(outcome());
  await until(() => first.delivery.prompts.length === 1);
  expect(first.delivery.prompts[0]).toContain("was closed");
  expect(first.delivery.prompts[0]).toContain("Partial work saved");
  expect(await first.store.list()).toHaveLength(1);
  first.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await first.store.list()).length).toBe(0);
  await first.service.close();
  const restarted = await scenario(first.home);
  expect(restarted.observation.waits).toHaveLength(0);
});

test("restart coalesces predecessor and queued candidate into one settled notification", async () => {
  const first = await scenario();
  await first.service.register(intent);
  await first.service.register(intent, true);
  expect(await first.store.list()).toHaveLength(2);
  await first.service.close();
  const restarted = await scenario(first.home);
  await until(() => restarted.observation.waits.length === 1);
  restarted.observation.waits[0]!.result.resolve(outcome());
  await until(() => restarted.delivery.prompts.length === 1);
  restarted.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await restarted.store.list()).length).toBe(0);
  expect(restarted.delivery.prompts).toHaveLength(1);
});

test("rejected queued follow-up preserves the predecessor and its buffered finish", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  const pending = await state.service.register(intent, true);
  state.observation.waits[0]!.result.resolve(outcome("idle"));
  await Promise.resolve();
  expect(state.delivery.prompts).toHaveLength(0);
  await pending.reject();
  await until(() => state.delivery.prompts.length === 1);
  expect(await state.store.list()).toHaveLength(1);
});

test("accepted replacement ignores old idle and stale acknowledgment cannot delete new intent", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(outcome("idle"));
  await until(() => state.delivery.prompts.length === 1);
  const next = await state.service.register(intent, true);
  next.accept();
  await until(() => state.observation.waits.length === 2);
  state.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length).toBe(1);
  state.observation.waits[1]!.result.resolve(outcome("idle"));
  await until(() => state.delivery.prompts.length === 2);
});

test("shutdown before dispatch acknowledgment leaves intent for recovery", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(outcome());
  await until(() => state.delivery.prompts.length === 1);
  await state.service.close();
  state.delivery.acknowledgments[0]!.resolve("steered");
  const restarted = await scenario(state.home);
  await until(() => restarted.observation.waits.length === 1);
  restarted.observation.waits[0]!.result.resolve(outcome());
  await until(() => restarted.delivery.prompts.length === 1);
});

test("remote recovery before three failed observations still reports child completion", async () => {
  const first = await scenario();
  await first.service.register({ ...intent, serverId: "remote" });
  await first.service.close();
  const state = await scenario(first.home);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.reject(new HostObservationError("unreachable"));
  await until(() => state.observation.waits.length === 2);
  expect(await state.store.list()).toHaveLength(1);
  expect(state.delivery.prompts).toHaveLength(0);
  state.observation.waits[1]!.result.resolve(outcome("idle"));
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("Server: remote");
});

test("archived parent suppresses delivery and removes obsolete intent", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  state.archive();
  state.observation.waits[0]!.result.resolve(outcome());
  await expect.poll(async () => (await state.store.list()).length).toBe(0);
  expect(state.delivery.prompts).toHaveLength(0);
});

test("permission checkpoint retains intent and completion reports after permission clears", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  const result = outcome("running");
  result.status = "permission";
  result.final!.pendingPermissions = [
    {
      id: "permission",
      name: "Write",
      input: { path: "file" },
      kind: "tool",
    } as (typeof result.final.pendingPermissions)[number],
  ];
  state.observation.waits[0]!.result.resolve(result);
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("respond_to_permission");
  expect(await state.store.list()).toHaveLength(1);
  state.delivery.acknowledgments[0]!.resolve("steered");
  state.observation.permission.resolve();
  await until(() => state.observation.waits.length === 2);
  state.observation.waits[1]!.result.resolve(outcome("idle"));
  await until(() => state.delivery.prompts.length === 2);
});

test("coalesced unconditional follow-up survives detachment of a parent-owned creation", async () => {
  const first = await scenario();
  await first.service.register({ ...intent, requireParentOwnership: true });
  await first.service.register(intent, true);
  await first.service.close();
  const restarted = await scenario(first.home);
  await until(() => restarted.observation.waits.length === 1);
  const detached = outcome();
  detached.final!.labels = {};
  restarted.observation.waits[0]!.result.resolve(detached);
  await until(() => restarted.delivery.prompts.length === 1);
});

test("detached child suppresses a parent-owned creation subscription", async () => {
  const state = await scenario();
  await state.service.register({ ...intent, requireParentOwnership: true });
  await until(() => state.observation.waits.length === 1);
  const detached = outcome();
  detached.final!.labels = {};
  state.observation.waits[0]!.result.resolve(detached);
  await expect.poll(async () => (await state.store.list()).length).toBe(0);
  expect(state.delivery.prompts).toHaveLength(0);
});

test("dispatch failure retains intent and retries the ordinary finish notification", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(outcome());
  await until(() => state.delivery.prompts.length === 1);
  state.delivery.acknowledgments[0]!.reject(new Error("Provider unavailable"));
  await until(() => state.delivery.prompts.length === 2);
  expect(await state.store.list()).toHaveLength(1);
  expect(state.observation.waits).toHaveLength(1);
  state.delivery.acknowledgments[1]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length).toBe(0);
});

test("error and missing-child notifications never claim successful completion", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(outcome("error"));
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("errored");
  await state.service.register({ ...intent, childAgentId: "missing-child" });
  await until(() => state.observation.waits.length === 2);
  state.observation.waits[1]!.result.resolve({
    status: "error",
    final: null,
    error: "Agent not found: missing-child",
    lastMessage: null,
  });
  await until(() => state.delivery.prompts.length === 2);
  expect(state.delivery.prompts[1]).toContain("is unavailable");
  expect(state.delivery.prompts[1]).not.toContain("finished");
});

test("finish notification limits a long last response and points to activity for the remainder", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  const result = outcome("idle");
  result.lastMessage = "x".repeat(4100);
  state.observation.waits[0]!.result.resolve(result);
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("x".repeat(4000));
  expect(state.delivery.prompts[0]).not.toContain("x".repeat(4001));
  expect(state.delivery.prompts[0]).toContain("get_agent_activity");
});

test("three failed remote observations consume intent only after unavailable-notification acknowledgment", async () => {
  const state = await scenario();
  await state.service.register({ ...intent, serverId: "remote" });
  for (let attempt = 0; attempt < 3; attempt++) {
    await until(() => state.observation.waits.length === attempt + 1);
    expect(state.delivery.prompts).toEqual([]);
    state.observation.waits[attempt]!.result.reject(new HostObservationError("unreachable"));
  }
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain(
    "Could not observe child agent child on host remote after three failed attempts.",
  );
  expect(state.delivery.prompts[0]).toContain("Status of child agent child (child) is unknown.");
  expect(state.delivery.prompts[0]).not.toContain("finished.");
  expect(await state.store.list()).toHaveLength(1);
  expect(state.observation.waits).toHaveLength(3);
  state.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length).toBe(0);
  await state.service.close();
  const restarted = await scenario(state.home);
  expect(restarted.observation.waits).toEqual([]);
  expect(restarted.delivery.prompts).toEqual([]);
});

test("connecting does not spend the remote failure budget and recovery before three failures still completes", async () => {
  const state = await scenario();
  await state.service.register({ ...intent, serverId: "remote" });
  for (let attempt = 0; attempt < 4; attempt++) {
    await until(() => state.observation.waits.length === attempt + 1);
    expect(state.delivery.prompts).toEqual([]);
    state.observation.waits[attempt]!.result.reject(new HostObservationError("connecting"));
  }
  for (let attempt = 4; attempt < 6; attempt++) {
    await until(() => state.observation.waits.length === attempt + 1);
    expect(state.delivery.prompts).toEqual([]);
    state.observation.waits[attempt]!.result.reject(new HostObservationError("unreachable"));
  }
  await until(() => state.observation.waits.length === 7);
  expect(state.delivery.prompts).toEqual([]);
  state.observation.waits[6]!.result.resolve(outcome("idle"));
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("finished.");
});

test("removed-host notice retries parent dispatch without observing again or deleting unacknowledged intent", async () => {
  const state = await scenario();
  await state.service.register({ ...intent, serverId: "remote" });
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.reject(new HostObservationError("removed"));
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("Host remote was removed or is unavailable.");
  expect(state.delivery.prompts[0]).toContain("Status of child agent child (child) is unknown.");
  state.delivery.acknowledgments[0]!.reject(new Error("Parent provider unavailable"));
  await until(() => state.delivery.prompts.length === 2);
  expect(state.delivery.prompts[1]).toBe(state.delivery.prompts[0]);
  expect(state.observation.waits).toHaveLength(1);
  expect(await state.store.list()).toHaveLength(1);
  state.delivery.acknowledgments[1]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length).toBe(0);
});

test("failed removal after dispatch acknowledgment retries only storage, preserving the accepted outcome", async () => {
  const state = await scenario(undefined, 2, 1000);
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(outcome("idle"));
  await until(() => state.delivery.prompts.length === 1);
  state.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length, { timeout: 10000 }).toBe(0);
  expect(state.delivery.prompts).toHaveLength(1);
  expect(state.delivery.prompts[0]).toContain("finished.");
  expect(state.observation.waits).toHaveLength(1);
});

test("shutdown during observation setup owns rejection of the already-canceled next result", async () => {
  const state = await scenario();
  const opening = deferred<void>();
  state.observation.opening = opening.promise;
  await state.service.register(intent);
  await until(() => state.observation.openedSignals.length === 1);
  const closing = state.service.close();
  await until(() => state.observation.openedSignals[0]!.aborted);
  opening.resolve();
  await closing;
  expect(await state.store.list()).toHaveLength(1);
  expect(state.delivery.prompts).toEqual([]);
});

test("remote finish intent protects its caller through registration, observation and delivery", async () => {
  const s = await scenario();
  let time = 61 * 60_000;
  let collected = false;
  const runtime = {
    identity: {},
    agentId: "parent",
    parentAgentId: undefined,
    provider: "test",
    sessionId: "parent",
    lastActivityAt: 0,
    isEligible: () => !collected,
    closeIfEligible: async (revalidate: () => boolean) => {
      if (!revalidate()) return false;
      collected = true;
      return true;
    },
  };
  const cleanup = createIdleRuntimeCleanup({
    enabled: true,
    logger: createTestLogger(),
    now: () => time,
    runtimes: () => (collected ? [] : [runtime]),
    isProtected: (agentId) => s.service.hasPendingForCaller(agentId),
    schedule: () => () => {},
  });
  const savedPut = s.store.put.bind(s.store);
  const writing = deferred<void>();
  s.store.put = async (record) => {
    await writing.promise;
    await savedPut(record);
  };
  const registration = s.service.register({ ...intent, serverId: "remote" }, true);
  const protectedDuringRegistration = s.service.hasPendingForCaller?.("parent") ?? false;
  writing.resolve();
  const accepted = await registration;
  expect(protectedDuringRegistration).toBe(true);
  expect((await cleanup.sweep()).collected).toEqual([]);
  expect(s.service.hasPendingForCaller("parent")).toBe(true);
  accepted.accept();
  await until(() => s.observation.waits.length === 1);
  expect(s.service.hasPendingForCaller("parent")).toBe(true);
  s.observation.waits[0]!.result.resolve(outcome());
  await until(() => s.delivery.prompts.length === 1);
  expect(s.service.hasPendingForCaller("parent")).toBe(true);
  s.delivery.acknowledgments[0]!.resolve("steered");
  await until(() => !s.service.hasPendingForCaller("parent"));
  expect(await s.store.list()).toEqual([]);
  time = 62 * 60_000;
  expect((await cleanup.sweep()).collected).toEqual([]);
  time = 122 * 60_000;
  expect((await cleanup.sweep()).collected).toHaveLength(1);
  await cleanup.close();
});

test("finish recovery protects callers before durable intent has loaded", async () => {
  const s = await scenario();
  await s.service.register({ ...intent, serverId: "remote" });
  await s.service.close();
  const loading = deferred<void>();
  const recovered = createFinishSubscriptions({
    store: {
      ...s.store,
      list: async () => {
        await loading.promise;
        return s.store.list();
      },
    },
    messages: () => s.delivery,
    open: s.observation.open.bind(s.observation),
    callerIsActive: async () => true,
    serverId: "origin",
    logger: createTestLogger(),
  });
  services.push(recovered);
  expect(recovered.hasPendingForCaller("parent")).toBe(true);
  const starting = recovered.start();
  expect(recovered.hasPendingForCaller("parent")).toBe(true);
  loading.resolve();
  await starting;
  expect(recovered.hasPendingForCaller("parent")).toBe(true);
  expect(recovered.hasPendingForCaller("unrelated")).toBe(false);
});

// --- Following a child past a turn that ended with background work still running ---

// The suite runs beside hundreds of others, and every followed turn writes the record to disk:
// poll fast and for long instead of failing on a slow machine.
const EVENTUALLY = { interval: 5, timeout: 15_000 } as const;
async function eventually(check: () => boolean) {
  await expect.poll(check, EVENTUALLY).toBe(true);
}

const SETTLED: ChildActivity = {
  running: false,
  providerBackgroundWork: false,
  queuedMessages: false,
};
/** A child whose provider activity the test flips between busy and settled. */
function childWithActivity() {
  const activity = { ...SETTLED };
  return {
    activity,
    childActivity: async () => ({ ...activity }),
  };
}
function reply(lastMessage: string, id = "child"): WaitForFinishResult {
  const result = outcome("idle");
  result.lastMessage = lastMessage;
  result.final!.id = id;
  return result;
}
// Recheck is off unless a test is about it: the observation double never ends a wait by itself.
const NO_RECHECK = 3_600_000;

test("a turn that ends with background work notifies once as not final, then the settled turn delivers the real reply", async () => {
  const child = childWithActivity();
  const state = await scenario(undefined, 0, 1, {
    childActivity: child.childActivity,
    recheckIntervalMs: NO_RECHECK,
  });
  await state.service.register(intent);
  await eventually(() => state.observation.waits.length === 1);
  child.activity.providerBackgroundWork = true;
  state.observation.waits[0]!.result.resolve(reply("Tests are running, I will report when done"));
  await eventually(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("ended its turn but still has background work");
  expect(state.delivery.prompts[0]).toContain("provider reports unfinished background tasks");
  expect(state.delivery.prompts[0]).toContain("This is not its final reply");
  expect(state.delivery.prompts[0]).toContain("Tests are running, I will report when done");
  state.delivery.acknowledgments[0]!.resolve("steered");
  // The subscription stays, and the record says it is following.
  await eventually(() => state.observation.waits.length === 2);
  const [record] = await state.store.list();
  expect(record?.followingSince).toEqual(expect.any(String));
  expect(state.delivery.prompts).toHaveLength(1);

  child.activity.providerBackgroundWork = false;
  state.observation.waits[1]!.result.resolve(reply("All 412 tests passed"));
  await eventually(() => state.delivery.prompts.length === 2);
  expect(state.delivery.prompts[1]).toContain("finished.");
  expect(state.delivery.prompts[1]).toContain("All 412 tests passed");
  expect(state.delivery.prompts[1]).toContain("This finish subscription has ended.");
  expect(state.delivery.prompts[1]).not.toContain("not its final reply");
  state.delivery.acknowledgments[1]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length, EVENTUALLY).toBe(0);
  expect(state.delivery.prompts).toHaveLength(2);
});

test("a child that stays idle after its background work ended gets a final notice from the recheck", async () => {
  const child = childWithActivity();
  const state = await scenario(undefined, 0, 1, {
    childActivity: child.childActivity,
    recheckIntervalMs: 5,
  });
  await state.service.register(intent);
  await eventually(() => state.observation.waits.length === 1);
  child.activity.providerBackgroundWork = true;
  state.observation.waits[0]!.result.resolve(reply("Waiting for the long job"));
  await eventually(() => state.delivery.prompts.length === 1);
  state.delivery.acknowledgments[0]!.resolve("steered");
  await eventually(() => state.observation.waits.length === 2);
  // The job ends without waking the child: no further turn ever comes.
  child.activity.providerBackgroundWork = false;
  await eventually(() => state.delivery.prompts.length === 2);
  expect(state.delivery.prompts[1]).toContain("background work has ended");
  expect(state.delivery.prompts[1]).toContain("did not start a new turn");
  expect(state.delivery.prompts[1]).toContain("Waiting for the long job");
  expect(state.delivery.prompts[1]).toContain("This finish subscription has ended.");
  state.delivery.acknowledgments[1]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length, EVENTUALLY).toBe(0);
  // The pending observation was never consumed or duplicated by rechecking.
  expect(state.observation.waits).toHaveLength(2);
});

test("a recheck stays quiet while the child still has queued messages or is mid-turn", async () => {
  const child = childWithActivity();
  const state = await scenario(undefined, 0, 1, {
    childActivity: child.childActivity,
    recheckIntervalMs: 5,
  });
  await state.service.register(intent);
  await eventually(() => state.observation.waits.length === 1);
  child.activity.queuedMessages = true;
  state.observation.waits[0]!.result.resolve(reply("Queued work ahead"));
  await eventually(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("has queued messages");
  state.delivery.acknowledgments[0]!.resolve("steered");
  await eventually(() => state.observation.waits.length === 2);
  child.activity.queuedMessages = false;
  child.activity.running = true;
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(state.delivery.prompts).toHaveLength(1);
  expect(await state.store.list()).toHaveLength(1);
});

test("turns that end while still working are silent after the first not-final notice", async () => {
  const child = childWithActivity();
  const state = await scenario(undefined, 0, 1, {
    childActivity: child.childActivity,
    recheckIntervalMs: NO_RECHECK,
  });
  await state.service.register(intent);
  await eventually(() => state.observation.waits.length === 1);
  child.activity.providerBackgroundWork = true;
  state.observation.waits[0]!.result.resolve(reply("Started"));
  await eventually(() => state.delivery.prompts.length === 1);
  state.delivery.acknowledgments[0]!.resolve("steered");
  for (let turn = 1; turn <= 3; turn++) {
    await eventually(() => state.observation.waits.length === turn + 1);
    state.observation.waits[turn]!.result.resolve(reply(`Still going, turn ${turn}`));
  }
  await eventually(() => state.observation.waits.length === 5);
  expect(state.delivery.prompts).toHaveLength(1);
  expect(await state.store.list()).toHaveLength(1);

  child.activity.providerBackgroundWork = false;
  state.observation.waits[4]!.result.resolve(reply("Done at last"));
  await eventually(() => state.delivery.prompts.length === 2);
  expect(state.delivery.prompts[1]).toContain("Done at last");
});

test("two agents that each wait on the other stop being followed at the limit instead of waking each other forever", async () => {
  const state = await scenario(undefined, 0, 1, {
    childActivity: async () => ({ ...SETTLED }),
    recheckIntervalMs: NO_RECHECK,
  });
  // a waits on b and b waits on a: each is unsettled only because of the other's subscription.
  await state.service.register({ callerAgentId: "a", childAgentId: "b" });
  await state.service.register({ callerAgentId: "b", childAgentId: "a" });
  await eventually(() => state.observation.waits.length === 2);
  const waitsOf = (child: string) => state.observation.waits.filter((wait) => wait.child === child);
  waitsOf("b")[0]!.result.resolve(reply("b is waiting on a", "b"));
  waitsOf("a")[0]!.result.resolve(reply("a is waiting on b", "a"));
  await eventually(() => state.delivery.prompts.length === 2);
  expect(state.delivery.prompts[0]).toContain("still has background work");
  expect(state.delivery.prompts[0]).toContain("waiting on 1 delegated agent");
  expect(state.delivery.recipients.slice().sort()).toEqual(["a", "b"]);
  state.delivery.acknowledgments[0]!.resolve("steered");
  state.delivery.acknowledgments[1]!.resolve("steered");

  // b keeps ending turns without settling; a's subscription on b gives up at the limit.
  for (let turn = 1; turn <= FOLLOW_LIMIT_TURNS; turn++) {
    await eventually(() => waitsOf("b").length === turn + 1);
    waitsOf("b")[turn]!.result.resolve(reply(`b turn ${turn}`, "b"));
  }
  await eventually(() => state.delivery.prompts.length === 3);
  expect(state.delivery.prompts[2]).toContain("stopped following");
  expect(state.delivery.prompts[2]).toContain("b turn " + FOLLOW_LIMIT_TURNS);
  expect(state.delivery.recipients[2]).toBe("a");
  state.delivery.acknowledgments[2]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length, EVENTUALLY).toBe(1);

  // With a's subscription gone, b no longer waits on anyone, and a's next turn settles for real.
  await eventually(() => waitsOf("a").length === 2);
  waitsOf("a")[1]!.result.resolve(reply("a is done", "a"));
  await eventually(() => state.delivery.prompts.length === 4);
  expect(state.delivery.recipients[3]).toBe("b");
  expect(state.delivery.prompts[3]).toContain("This finish subscription has ended.");
  state.delivery.acknowledgments[3]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length, EVENTUALLY).toBe(0);
  expect(state.delivery.prompts).toHaveLength(4);
});

test("a child still working after the time limit gets a stopped-following notice", async () => {
  const child = childWithActivity();
  let now = Date.parse("2026-10-29T00:00:00Z");
  const state = await scenario(undefined, 0, 1, {
    childActivity: child.childActivity,
    recheckIntervalMs: 5,
    now: () => now,
  });
  await state.service.register(intent);
  await eventually(() => state.observation.waits.length === 1);
  child.activity.providerBackgroundWork = true;
  state.observation.waits[0]!.result.resolve(reply("Long job started"));
  await eventually(() => state.delivery.prompts.length === 1);
  state.delivery.acknowledgments[0]!.resolve("steered");
  await eventually(() => state.observation.waits.length === 2);
  now += FOLLOW_LIMIT_MS + 1;
  await eventually(() => state.delivery.prompts.length === 2);
  expect(state.delivery.prompts[1]).toContain("stopped following");
  expect(state.delivery.prompts[1]).toContain("Long job started");
  state.delivery.acknowledgments[1]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length, EVENTUALLY).toBe(0);
});

test("restart keeps following without repeating the not-final notice, and the settled turn reports", async () => {
  const child = childWithActivity();
  const first = await scenario(undefined, 0, 1, {
    childActivity: child.childActivity,
    recheckIntervalMs: NO_RECHECK,
  });
  await first.service.register(intent);
  await eventually(() => first.observation.waits.length === 1);
  child.activity.providerBackgroundWork = true;
  first.observation.waits[0]!.result.resolve(reply("Started the job"));
  await eventually(() => first.delivery.prompts.length === 1);
  first.delivery.acknowledgments[0]!.resolve("steered");
  await expect
    .poll(async () => (await first.store.list())[0]?.followingSince, EVENTUALLY)
    .toEqual(expect.any(String));
  await first.service.close();

  const restarted = await scenario(first.home, 0, 1, {
    childActivity: child.childActivity,
    recheckIntervalMs: NO_RECHECK,
  });
  await eventually(() => restarted.observation.waits.length === 1);
  // The initial snapshot of an idle child that still has work: nothing new to say.
  restarted.observation.waits[0]!.result.resolve(reply("Started the job"));
  await eventually(() => restarted.observation.waits.length === 2);
  expect(restarted.delivery.prompts).toEqual([]);

  child.activity.providerBackgroundWork = false;
  restarted.observation.waits[1]!.result.resolve(reply("Job finished"));
  await eventually(() => restarted.delivery.prompts.length === 1);
  expect(restarted.delivery.prompts[0]).toContain("Job finished");
  expect(restarted.delivery.prompts[0]).toContain("This finish subscription has ended.");
});

test("restart reports a settled child straight away when it was being followed", async () => {
  const child = childWithActivity();
  const first = await scenario(undefined, 0, 1, {
    childActivity: child.childActivity,
    recheckIntervalMs: NO_RECHECK,
  });
  await first.service.register(intent);
  await eventually(() => first.observation.waits.length === 1);
  child.activity.providerBackgroundWork = true;
  first.observation.waits[0]!.result.resolve(reply("Started the job"));
  await eventually(() => first.delivery.prompts.length === 1);
  first.delivery.acknowledgments[0]!.resolve("steered");
  await expect
    .poll(async () => (await first.store.list())[0]?.followingSince, EVENTUALLY)
    .toEqual(expect.any(String));
  await first.service.close();

  child.activity.providerBackgroundWork = false;
  const restarted = await scenario(first.home, 0, 1, {
    childActivity: child.childActivity,
    recheckIntervalMs: NO_RECHECK,
  });
  await eventually(() => restarted.observation.waits.length === 1);
  restarted.observation.waits[0]!.result.resolve(reply("Job finished while the daemon was down"));
  await eventually(() => restarted.delivery.prompts.length === 1);
  expect(restarted.delivery.prompts[0]).toContain("Job finished while the daemon was down");
  expect(restarted.delivery.prompts[0]).not.toContain("not its final reply");
});

test("a new prompt to the child replaces a subscription that is already following it", async () => {
  const child = childWithActivity();
  const state = await scenario(undefined, 0, 1, {
    childActivity: child.childActivity,
    recheckIntervalMs: NO_RECHECK,
  });
  await state.service.register(intent);
  await eventually(() => state.observation.waits.length === 1);
  child.activity.providerBackgroundWork = true;
  state.observation.waits[0]!.result.resolve(reply("Started"));
  await eventually(() => state.delivery.prompts.length === 1);
  state.delivery.acknowledgments[0]!.resolve("steered");
  await eventually(() => state.observation.waits.length === 2);

  const next = await state.service.register(intent, true);
  next.accept();
  await eventually(() => state.observation.waits.length === 3);
  expect(state.observation.waits[1]!.signal.aborted).toBe(true);
  await expect.poll(async () => (await state.store.list()).length, EVENTUALLY).toBe(1);
  expect((await state.store.list())[0]?.followingSince).toBeUndefined();

  child.activity.providerBackgroundWork = false;
  state.observation.waits[2]!.result.resolve(reply("Second job done"));
  await eventually(() => state.delivery.prompts.length === 2);
  expect(state.delivery.prompts[1]).toContain("Second job done");
  expect(state.delivery.prompts[1]).toContain("This finish subscription has ended.");
});

test("without a way to tell, a finished turn is final exactly as before", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await eventually(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(reply("Done, or so I say"));
  await eventually(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("finished.");
  expect(state.delivery.prompts[0]).not.toContain("still has background work");
  expect(state.delivery.prompts[0]).not.toContain("This finish subscription has ended.");
  state.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length, EVENTUALLY).toBe(0);
});

test("a child on another host is never followed, whatever the local activity says", async () => {
  const child = childWithActivity();
  child.activity.providerBackgroundWork = true;
  const state = await scenario(undefined, 0, 1, {
    childActivity: child.childActivity,
    recheckIntervalMs: NO_RECHECK,
  });
  await state.service.register({ ...intent, serverId: "remote" });
  await eventually(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(reply("Remote result"));
  await eventually(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("finished.");
  expect(state.delivery.prompts[0]).not.toContain("still has background work");
  state.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length, EVENTUALLY).toBe(0);
});

test("errors end the subscription even while background work is reported", async () => {
  const child = childWithActivity();
  child.activity.providerBackgroundWork = true;
  const state = await scenario(undefined, 0, 1, {
    childActivity: child.childActivity,
    recheckIntervalMs: NO_RECHECK,
  });
  await state.service.register(intent);
  await eventually(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(outcome("error"));
  await eventually(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("errored");
  expect(state.delivery.prompts[0]).not.toContain("still has background work");
  state.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length, EVENTUALLY).toBe(0);
});

// --- What the review of the first round found ---

test("a terminal result that arrives while a recheck is probing supplies the final reply", async () => {
  const probe = deferred<ChildActivity>();
  let calls = 0;
  const state = await scenario(undefined, 0, 1, {
    childActivity: async () => {
      calls++;
      return calls === 1 ? { ...SETTLED, providerBackgroundWork: true } : probe.promise;
    },
    recheckIntervalMs: 5,
  });
  await state.service.register(intent);
  await eventually(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(reply("INTERMEDIATE: tests running"));
  await eventually(() => state.delivery.prompts.length === 1);
  state.delivery.acknowledgments[0]!.resolve("steered");
  await eventually(() => calls === 2);
  // The child ends its real turn while the recheck is still asking, and then the probe says settled.
  state.observation.waits[1]!.result.resolve(reply("FINAL: all tests passed"));
  probe.resolve({ ...SETTLED });
  await eventually(() => state.delivery.prompts.length === 2);
  expect(state.delivery.prompts[1]).toContain("finished.");
  expect(state.delivery.prompts[1]).toContain("FINAL: all tests passed");
  expect(state.delivery.prompts[1]).not.toContain("INTERMEDIATE");
  expect(state.delivery.prompts[1]).not.toContain("did not start a new turn");
});

test("a background probe that fails keeps the subscription alive instead of calling the child settled", async () => {
  const idleChild = {
    lifecycle: "idle",
    session: {
      canStopRuntime: async () => {
        throw new Error("background inventory temporarily unavailable");
      },
    },
  };
  const childActivity = createChildActivity({
    agentManager: { getAgent: () => idleChild as never },
    messages: () => ({ hasPending: () => false }) as unknown as AgentMessageDelivery,
    logger: createTestLogger(),
  });
  const state = await scenario(undefined, 0, 1, { childActivity, recheckIntervalMs: NO_RECHECK });
  await state.service.register(intent);
  await eventually(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(reply("INTERMEDIATE: background job pending"));
  await eventually(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("This is not its final reply");
  expect(state.delivery.prompts[0]).toContain("could not read background state");
  expect(state.delivery.prompts[0]).not.toContain("This finish subscription has ended.");
});

test("an activity check that throws outright is not read as a settled child", async () => {
  const state = await scenario(undefined, 0, 1, {
    childActivity: async () => {
      throw new Error("activity unavailable");
    },
    recheckIntervalMs: NO_RECHECK,
  });
  await state.service.register(intent);
  await eventually(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(reply("Partial"));
  await eventually(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("This is not its final reply");
  expect(state.delivery.prompts[0]).toContain("could not read background state");
});

test("a recovered follow enforces its time limit without waiting for another terminal event", async () => {
  const now = Date.parse("2026-10-29T00:00:00Z");
  const first = await scenario();
  await first.store.put({
    ...intent,
    id: "expired",
    followingSince: new Date(now - FOLLOW_LIMIT_MS - 1).toISOString(),
    followedTurns: 12,
  });
  await first.service.close();
  const restarted = await scenario(first.home, 0, 1, {
    childActivity: async () => ({ ...SETTLED, running: true }),
    recheckIntervalMs: 5,
    now: () => now,
  });
  // The child never reports anything: only the clock can end this.
  await eventually(() => restarted.observation.waits.length === 1);
  await eventually(() => restarted.delivery.prompts.length === 1);
  expect(restarted.delivery.prompts[0]).toContain("stopped following");
  expect(restarted.delivery.prompts[0]).toContain("No reply was recorded");
  expect(restarted.delivery.prompts[0]).toContain("get_agent_activity");
  expect(restarted.delivery.prompts[0]).not.toContain("<agent-response>");
  restarted.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await restarted.store.list()).length, EVENTUALLY).toBe(0);
});

test("a restart after the not-final notice went out neither repeats it nor restarts the time limit", async () => {
  const extra = {
    childActivity: async () => ({ ...SETTLED, providerBackgroundWork: true }),
    recheckIntervalMs: NO_RECHECK,
  };
  const first = await scenario(undefined, 0, 5000, extra);
  const put = first.store.put.bind(first.store);
  const marking = deferred<void>();
  let marks = 0;
  first.store.put = async (record) => {
    if (record.followingSince) {
      marks++;
      await marking.promise;
    }
    return put(record);
  };
  await first.service.register(intent);
  await eventually(() => first.observation.waits.length === 1);
  first.observation.waits[0]!.result.resolve(reply("INTERMEDIATE"));
  // The mark goes to disk before the caller is told anything.
  await eventually(() => marks === 1 || first.delivery.prompts.length > 0);
  expect(first.delivery.prompts).toHaveLength(0);
  marking.resolve();
  await eventually(() => first.delivery.prompts.length === 1);
  const [marked] = await first.store.list();
  expect(marked?.followingSince).toEqual(expect.any(String));
  // Shut down before the caller's acknowledgment arrives.
  await first.service.close();

  const restarted = await scenario(first.home, 0, 1, extra);
  await eventually(() => restarted.observation.waits.length === 1);
  restarted.observation.waits[0]!.result.resolve(reply("INTERMEDIATE"));
  await eventually(() => restarted.observation.waits.length === 2);
  expect(restarted.delivery.prompts).toEqual([]);
  await expect
    .poll(async () => (await restarted.store.list())[0]?.followedTurns, EVENTUALLY)
    .toBe(1);
  expect((await restarted.store.list())[0]?.followingSince).toBe(marked?.followingSince);
});

test('a recheck final does not call a reply "already received" when the caller never got it', async () => {
  const child = childWithActivity();
  const state = await scenario(undefined, 0, 1, {
    childActivity: child.childActivity,
    recheckIntervalMs: 5,
  });
  await state.service.register(intent);
  await eventually(() => state.observation.waits.length === 1);
  child.activity.providerBackgroundWork = true;
  state.observation.waits[0]!.result.resolve(reply("Reply A"));
  await eventually(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("Reply A");
  state.delivery.acknowledgments[0]!.resolve("steered");
  await eventually(() => state.observation.waits.length === 2);
  // Another turn ends while the job still runs: silent, so the caller never sees B.
  state.observation.waits[1]!.result.resolve(reply("Reply B"));
  await eventually(() => state.observation.waits.length === 3);
  expect(state.delivery.prompts).toHaveLength(1);
  child.activity.providerBackgroundWork = false;
  await eventually(() => state.delivery.prompts.length === 2);
  expect(state.delivery.prompts[1]).toContain("background work has ended");
  expect(state.delivery.prompts[1]).toContain("Reply B");
  expect(state.delivery.prompts[1]).not.toContain("you already received");
  expect(state.delivery.prompts[1]).toContain("This finish subscription has ended.");
});
