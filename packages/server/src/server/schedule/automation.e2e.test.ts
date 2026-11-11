import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("plugin events execute actions, deliver results, stop causal loops and cancel timed-out work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "automation-e2e-"));
  await writeFile(
    path.join(root, "paseo-plugin.json"),
    JSON.stringify({ id: "automation-test", requirements: { paseo: ">=0.15.3" } }),
  );
  await writeFile(
    path.join(root, "index.server.ts"),
    `
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export default function contribute(server) {
  let cancelled = false; let resolved = false;
  const deliveries = [];
  server.registerTriggerSource({ id: "demo", events: [{ id: "ping", fields: ["sender"] }] });
  server.registerAction({ id: "echo", params: z.object({ text: z.string() }), run: ({ params }) => ({ text: params.text }) });
  server.registerAction({ id: "throws", params: z.object({}), run() { throw new Error("boom"); } });
  server.registerAction({ id: "crash", params: z.object({}), run() { process.exit(17); } });
  server.registerAction({ id: "slow", params: z.object({}), async run(_input, context) {
    await new Promise((resolve) => context.signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
    resolved = true; return { text: "late" };
  } });
  server.registerChannel({ id: "results", async deliver(delivery) {
    deliveries.push(delivery);
    await server.emit("demo", { event: "ping", id: "sent:" + delivery.idempotencyKey, causedBy: delivery.idempotencyKey });
  } });
  server.handle(defineRpc({ name: "emit", input: z.object({ id: z.string(), source: z.string().default("demo"), event: z.string().default("ping") }), output: z.unknown() }), ({ id, source, event }) => server.emit(source, { id, event }));
  server.handle(defineRpc({ name: "state", input: z.object({}), output: z.unknown() }), () => ({ cancelled, resolved, deliveries }));
  return () => {};
}`,
  );
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    try {
      await client.installDirectoryPlugin(root);
    } catch (error) {
      throw new Error(
        `${String(error)}\n${JSON.stringify(await client.getPluginLogs("automation-test"))}`,
        { cause: error },
      );
    }
    expect((await client.scheduleActions()).actions.map((action) => action.id)).toEqual([
      "crash",
      "echo",
      "slow",
      "throws",
    ]);
    expect((await client.scheduleTriggers()).triggers).toEqual([
      expect.objectContaining({ id: "demo", pluginId: "automation-test" }),
    ]);
    const conflictRoot = path.join(root, "conflict");
    await mkdir(conflictRoot);
    await writeFile(
      path.join(conflictRoot, "paseo-plugin.json"),
      JSON.stringify({ id: "z-conflict", requirements: { paseo: ">=0.15.3" } }),
    );
    await writeFile(
      path.join(conflictRoot, "index.server.ts"),
      `
import { defineRpc } from "@getpaseo/plugin"; import { z } from "zod";
export default function contribute(server) {
  server.registerTriggerSource({ id: "demo", events: [{ id: "ping" }] });
  server.handle(defineRpc({ name: "emit", input: z.object({}), output: z.unknown() }), () => server.emit("demo", { event: "ping", id: "one" }));
  return () => {};
}`,
    );
    await client.installDirectoryPlugin(conflictRoot);
    expect((await client.scheduleTriggers()).triggers).toEqual([
      expect.objectContaining({ id: "demo", pluginId: "automation-test" }),
    ]);
    await expect(client.invokePluginRpc("z-conflict", "emit", {})).rejects.toThrow(
      "owned by plugin automation-test",
    );
    expect(
      (await client.getPluginLogs("z-conflict")).some((entry) =>
        entry.message.includes("emit rejected"),
      ),
    ).toBe(true);
    await expect(
      client.scheduleCreate({
        prompt: "test",
        cadence: { type: "none" },
        target: { type: "action", action: "echo", params: { text: 42 } },
      }),
    ).rejects.toThrow();
    const created = await client.scheduleCreate({
      prompt: "test",
      cadence: { type: "none" },
      target: { type: "action", action: "echo", params: { text: "hi" } },
      triggers: [{ type: "event", source: "demo", event: "ping" }],
      delivery: { channel: "results", to: "test" },
    });
    if (!created.schedule) throw new Error("no schedule");
    const id = created.schedule.id;
    expect(await client.invokePluginRpc("automation-test", "emit", { id: "one" })).toMatchObject({
      status: "accepted",
      started: [id],
    });
    expect(await client.invokePluginRpc("automation-test", "emit", { id: "one" })).toMatchObject({
      status: "duplicate",
    });
    await expect
      .poll(async () => (await client.scheduleLogs({ id })).runs[0]?.delivery?.status)
      .toBe("delivered");
    expect((await client.scheduleLogs({ id })).runs).toEqual([
      expect.objectContaining({
        status: "succeeded",
        output: "hi",
        trigger: expect.objectContaining({ eventId: "one", depth: 1 }),
      }),
    ]);
    await client.scheduleUpdate({
      id,
      actionConfig: { params: { text: "changed" }, timeoutMs: 1000 },
    });
    expect(
      (await client.scheduleUpdate({ id, actionConfig: { timeoutMs: null } })).schedule?.target,
    ).toEqual({ type: "action", action: "echo", params: { text: "changed" } });
    const slow = await client.scheduleCreate({
      prompt: "slow",
      cadence: { type: "none" },
      target: { type: "action", action: "slow", params: {}, timeoutMs: 100 },
    });
    if (!slow.schedule) throw new Error("no slow schedule");
    const timedOut = await client.scheduleRunOnce({ id: slow.schedule.id });
    expect(timedOut.schedule).toMatchObject({
      status: "active",
      runs: [
        expect.objectContaining({ status: "failed", error: 'Action "slow" timed out after 0.1s' }),
      ],
    });
    await expect
      .poll(async () => client.invokePluginRpc("automation-test", "state", {}))
      .toMatchObject({ cancelled: true, resolved: true });
    expect((await client.scheduleLogs({ id: slow.schedule.id })).runs).toEqual([
      expect.objectContaining({
        status: "failed",
        output: null,
        error: 'Action "slow" timed out after 0.1s',
      }),
    ]);
    const broken = await client.scheduleCreate({
      prompt: "throw",
      cadence: { type: "none" },
      target: { type: "action", action: "throws", params: {} },
    });
    if (!broken.schedule) throw new Error("no broken schedule");
    expect((await client.scheduleRunOnce({ id: broken.schedule.id })).schedule).toMatchObject({
      status: "active",
      runs: [expect.objectContaining({ status: "failed", error: "boom" })],
    });
    const crash = await client.scheduleCreate({
      prompt: "crash",
      cadence: { type: "none" },
      target: { type: "action", action: "crash", params: {} },
    });
    if (!crash.schedule) throw new Error("no crash schedule");
    expect((await client.scheduleRunOnce({ id: crash.schedule.id })).schedule).toMatchObject({
      status: "active",
      runs: [expect.objectContaining({ status: "failed" })],
    });
    expect(
      (await client.scheduleUpdate({ id: crash.schedule.id, name: "after crash" })).schedule?.name,
    ).toBe("after crash");
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}, 60_000);
