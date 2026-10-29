import { expect, test, vi } from "vitest";
import type { AgentManager } from "../../agent-manager.js";
import type { AgentMessageDelivery } from "../../agent-messages/index.js";
import { createChildActivity } from "./child-activity.js";

type LiveAgent = ReturnType<AgentManager["getAgent"]>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function activityFor(options: {
  agent: { lifecycle: string; canStopRuntime?: () => Promise<boolean> } | null;
  queued?: boolean;
}) {
  const warn = vi.fn();
  const { agent } = options;
  const live = agent
    ? ({
        lifecycle: agent.lifecycle,
        session: { canStopRuntime: agent.canStopRuntime },
      } as unknown as LiveAgent)
    : null;
  const childActivity = createChildActivity({
    agentManager: { getAgent: () => live },
    messages: () =>
      ({ hasPending: () => options.queued ?? false }) as unknown as AgentMessageDelivery,
    logger: { warn },
  });
  return { childActivity, warn };
}

test("a provider that says its runtime cannot be stopped reports background work", async () => {
  const { childActivity } = activityFor({
    agent: { lifecycle: "idle", canStopRuntime: async () => false },
  });
  expect(await childActivity("child")).toEqual({
    running: false,
    providerBackgroundWork: true,
    queuedMessages: false,
  });
});

test("a provider that says its runtime can be stopped reports nothing pending", async () => {
  const { childActivity } = activityFor({
    agent: { lifecycle: "idle", canStopRuntime: async () => true },
  });
  expect(await childActivity("child")).toEqual({
    running: false,
    providerBackgroundWork: false,
    queuedMessages: false,
  });
});

test("a provider without a probe reports nothing pending", async () => {
  const { childActivity } = activityFor({ agent: { lifecycle: "idle" } });
  expect((await childActivity("child")).providerBackgroundWork).toBe(false);
});

test("a probe that fails leaves the state unknown, which is not settled, and is logged", async () => {
  const { childActivity, warn } = activityFor({
    agent: {
      lifecycle: "idle",
      canStopRuntime: async () => {
        throw new Error("provider went away");
      },
    },
  });
  expect(await childActivity("child")).toMatchObject({
    providerBackgroundWork: false,
    uncertain: "could not read background state",
  });
  expect(warn).toHaveBeenCalledTimes(1);
});

test("a probe that never answers is unknown too", async () => {
  vi.useFakeTimers();
  try {
    const { childActivity } = activityFor({
      agent: { lifecycle: "idle", canStopRuntime: () => new Promise<boolean>(() => {}) },
    });
    const pending = childActivity("child");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ uncertain: "could not read background state" });
  } finally {
    vi.useRealTimers();
  }
});

test("a child with no live runtime reports nothing pending apart from queued messages", async () => {
  const { childActivity } = activityFor({ agent: null, queued: true });
  expect(await childActivity("child")).toEqual({
    running: false,
    providerBackgroundWork: false,
    queuedMessages: true,
  });
});

test("a child that is mid-turn or still starting is running; an errored one is not", async () => {
  for (const [lifecycle, running] of [
    ["running", true],
    ["initializing", true],
    ["idle", false],
    ["error", false],
  ] as const) {
    const { childActivity } = activityFor({ agent: { lifecycle } });
    expect((await childActivity("child")).running).toBe(running);
  }
});

function changingAgent() {
  const probe = deferred<boolean>();
  const agent = { lifecycle: "idle", session: { canStopRuntime: () => probe.promise } };
  const queue = { pending: false };
  let current: unknown = agent;
  const childActivity = createChildActivity({
    agentManager: { getAgent: () => current as LiveAgent },
    messages: () => ({ hasPending: () => queue.pending }) as unknown as AgentMessageDelivery,
    logger: { warn: vi.fn() },
  });
  return {
    agent,
    queue,
    probe,
    childActivity,
    replaceSession() {
      current = { lifecycle: "idle", session: { canStopRuntime: async () => true } };
    },
  };
}

test("lifecycle and the message queue are read again after an asynchronous provider probe", async () => {
  const child = changingAgent();
  const pending = child.childActivity("child");
  // While the provider is being asked: the child starts a turn and a message is queued for it.
  child.agent.lifecycle = "running";
  child.queue.pending = true;
  child.probe.resolve(true);
  expect(await pending).toMatchObject({ running: true, queuedMessages: true });
});

test("a probe answered by a runtime that was replaced meanwhile proves nothing about the new one", async () => {
  const child = changingAgent();
  const pending = child.childActivity("child");
  child.replaceSession();
  child.probe.resolve(true);
  expect(await pending).toMatchObject({ uncertain: "runtime changed" });
});
