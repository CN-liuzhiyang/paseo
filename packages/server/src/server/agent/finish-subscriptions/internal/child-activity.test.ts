import { expect, test, vi } from "vitest";
import type { AgentManager } from "../../agent-manager.js";
import type { AgentMessageDelivery } from "../../agent-messages/index.js";
import { createChildActivity } from "./child-activity.js";

type LiveAgent = ReturnType<AgentManager["getAgent"]>;

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

test("a probe that fails is the same as no opinion, and is logged", async () => {
  const { childActivity, warn } = activityFor({
    agent: {
      lifecycle: "idle",
      canStopRuntime: async () => {
        throw new Error("provider went away");
      },
    },
  });
  expect((await childActivity("child")).providerBackgroundWork).toBe(false);
  expect(warn).toHaveBeenCalledTimes(1);
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
