import { expect, test } from "vitest";
import { z } from "zod";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ActionInput } from "@getpaseo/plugin/server";
import { PluginAutomations } from "./plugin-automations.js";

const api = createPaseoApi(
  new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "clid_automation_test" }),
);
const input: ActionInput = {
  params: { text: "hi" },
  prompt: "test",
  run: { automationId: "test", automationName: null, runId: "run" },
  trigger: { type: "manual" },
  cwd: null,
};

test("validates on create and again at execution with the plugin's current schema", async () => {
  const registry = new PluginAutomations(() => {});
  registry.registerAction({
    id: "echo",
    params: z.object({ text: z.string().transform((text) => text.toUpperCase()) }),
    run: ({ params }) => ({ text: params.text }),
  });
  await expect(registry.validate("echo", { text: 42 })).rejects.toThrow();
  await expect(
    registry.run("bad", "echo", { ...input, params: { text: 42 } }, api),
  ).rejects.toThrow();
  await expect(registry.run("run", "echo", input, api)).resolves.toEqual({ text: "HI" });
});

test("aborts cancellation and discards a late result", async () => {
  const registry = new PluginAutomations(() => {});
  let release = () => {};
  let started = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal: AbortSignal | undefined;
  registry.registerAction({
    id: "slow",
    params: z.object({}),
    async run(_input, context) {
      signal = context.signal;
      started();
      await blocked;
      return { text: "late" };
    },
  });
  const running = registry.run("run", "slow", input, api);
  await ready;
  registry.cancel("run");
  expect(signal?.aborted).toBe(true);
  release();
  await expect(running).rejects.toThrow();
});

test("reports throws and rejects duplicate or invalid registrations", async () => {
  const registry = new PluginAutomations(() => {});
  const action = {
    id: "broken",
    params: z.object({}),
    run() {
      throw new Error("boom");
    },
  };
  registry.registerAction(action);
  await expect(registry.run("run", "broken", input, api)).rejects.toThrow("boom");
  expect(() => registry.registerAction(action)).toThrow("Duplicate");
  expect(() => registry.registerAction({ ...action, id: "Bad" })).toThrow("Invalid");
  registry.registerSource({ id: "demo", events: [{ id: "ping" }] });
  expect(() => registry.registerSource({ id: "demo", events: [] })).toThrow("Duplicate");
});
