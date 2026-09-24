import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { getFullAccessConfig } from "../daemon-e2e/agent-configs.js";
import { resolveDaemonVersion } from "../daemon-version.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const roots: string[] = [];

afterEach(async () => {
  // Windows can hold the workspace directory briefly after the daemon closes.
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })),
  );
});

test("a schedule hands each run's result to the channel a plugin registered", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-channel-plugin-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-channel-workspace-"));
  roots.push(pluginDirectory, cwd);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({
      id: "channels",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.server.ts"),
    `import { defineRpc } from "@getpaseo/plugin";
import { type ChannelDelivery, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

const received = defineRpc({
  name: "received",
  input: z.object({}),
  output: z.array(z.object({ channel: z.string(), delivery: z.unknown(), hasPaseo: z.boolean() })),
});

export default function contribute(server: PluginServerContext) {
  const deliveries: Array<{ channel: string; delivery: ChannelDelivery; hasPaseo: boolean }> = [];
  server.registerChannel!({
    id: "chat",
    label: "Chat",
    deliver(delivery, context) {
      deliveries.push({ channel: "chat", delivery, hasPaseo: typeof context.paseo === "object" });
    },
    async destinations(context) {
      if (typeof context.paseo !== "object") throw new Error("no Paseo API in context");
      return [
        { to: "general", label: "General" },
        { to: "room:42", label: "Team room" },
      ];
    },
  });
  server.registerChannel!({
    id: "broken",
    async deliver() {
      throw new Error("vendor rejected the message");
    },
    destinations() {
      throw new Error("vendor directory is down");
    },
  });
  // Registered after the entry returned, as a plugin does once its settings load.
  setTimeout(() => {
    server.registerChannel!({
      id: "late",
      deliver(delivery) {
        deliveries.push({ channel: "late", delivery, hasPaseo: true });
      },
    });
  }, 0);
  server.handle(received, () => deliveries);
  return () => undefined;
}`,
  );

  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });

  const createSchedule = async (name: string, channel: string, prompt: string) => {
    const response = await client.scheduleCreate({
      name,
      prompt,
      cadence: { type: "cron", expression: "0 0 1 1 *" },
      target: { type: "new-agent", config: { ...getFullAccessConfig("codex"), cwd } },
      runOnCreate: false,
      delivery: { channel, to: "general" },
    });
    if (response.error || !response.schedule) throw new Error(response.error ?? "no schedule");
    expect(response.schedule.delivery).toEqual({ channel, to: "general" });
    return response.schedule.id;
  };
  const runOnce = async (scheduleId: string) => {
    const response = await client.scheduleRunOnce({ id: scheduleId });
    if (response.error || !response.schedule) throw new Error(response.error ?? "no schedule");
    const run = response.schedule.runs[0];
    if (!run) throw new Error("run-once recorded no run");
    return run;
  };

  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await expect(client.installDirectoryPlugin(pluginDirectory)).resolves.toMatchObject({
      id: "channels",
      status: "running",
    });

    // "late" registers on a timer after the entry returns.
    await expect
      .poll(async () => (await client.scheduleChannels()).channels.map((channel) => channel.id))
      .toEqual(["broken", "chat", "late"]);
    const listed = await client.scheduleChannels();
    expect(listed.error).toBeNull();
    expect(listed.channels).toEqual([
      {
        id: "broken",
        label: null,
        pluginId: "channels",
        destinations: null,
        error: "vendor directory is down",
      },
      {
        id: "chat",
        label: "Chat",
        pluginId: "channels",
        destinations: [
          { to: "general", label: "General" },
          { to: "room:42", label: "Team room" },
        ],
      },
      { id: "late", label: null, pluginId: "channels", destinations: [] },
    ]);

    const chatSchedule = await createSchedule("Digest", "chat", "Respond with exactly: DIGEST-OK");
    const chatRun = await runOnce(chatSchedule);
    expect(chatRun).toMatchObject({
      status: "succeeded",
      output: "DIGEST-OK",
      delivery: { status: "delivered" },
    });
    const summaries = await client.scheduleList();
    expect(summaries.schedules.find((schedule) => schedule.id === chatSchedule)).toMatchObject({
      delivery: { channel: "chat", to: "general" },
      lastDelivery: { runId: chatRun.id, status: "delivered" },
    });

    const lateSchedule = await createSchedule("Late", "late", "Respond with exactly: LATE-OK");
    const lateRun = await runOnce(lateSchedule);
    expect(lateRun.delivery).toMatchObject({ status: "delivered" });

    expect(await client.invokePluginRpc("channels", "received", {})).toEqual([
      {
        channel: "chat",
        hasPaseo: true,
        delivery: {
          to: "general",
          idempotencyKey: chatRun.id,
          source: {
            kind: "schedule",
            scheduleId: chatSchedule,
            scheduleName: "Digest",
            runId: chatRun.id,
          },
          status: "succeeded",
          text: "DIGEST-OK",
          agentId: chatRun.agentId,
        },
      },
      {
        channel: "late",
        hasPaseo: true,
        delivery: expect.objectContaining({ idempotencyKey: lateRun.id, text: "LATE-OK" }),
      },
    ]);

    const brokenRun = await runOnce(
      await createSchedule("Broken", "broken", "Respond with exactly: BROKEN-OK"),
    );
    expect(brokenRun).toMatchObject({
      status: "succeeded",
      delivery: { status: "failed", error: "vendor rejected the message" },
    });

    const missingRun = await runOnce(
      await createSchedule("Missing", "missing", "Respond with exactly: MISSING-OK"),
    );
    expect(missingRun).toMatchObject({
      status: "succeeded",
      output: "MISSING-OK",
      delivery: { status: "failed", error: 'No running plugin provides channel "missing"' },
    });
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 120_000);
