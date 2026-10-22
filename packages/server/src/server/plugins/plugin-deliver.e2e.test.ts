import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { resolveDaemonVersion } from "../daemon-version.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })),
  );
});

async function writePlugin(input: { id: string; source: string }): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `paseo-deliver-${input.id}-`));
  roots.push(directory);
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: input.id,
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(path.join(directory, "index.server.ts"), input.source);
  return directory;
}

const RECEIVED = `defineRpc({
  name: "received",
  input: z.object({}),
  output: z.array(z.unknown()),
})`;

// A registers channels and records what they receive.
const CHANNEL_PLUGIN = `import { defineRpc } from "@getpaseo/plugin";
import { type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

const received = ${RECEIVED};

export default function contribute(server: PluginServerContext) {
  const deliveries: unknown[] = [];
  server.registerChannel!({
    id: "inbox",
    label: "Inbox",
    deliver(delivery) {
      deliveries.push(delivery);
    },
    destinations() {
      return [{ to: "u1", label: "User one" }];
    },
  });
  server.registerChannel!({
    id: "refusing",
    async deliver() {
      throw new Error("vendor rejected the message");
    },
  });
  server.handle(received, () => deliveries);
  return () => undefined;
}`;

// B sends through A's channels. It also registers one channel of its own, to deliver to itself.
const SENDER_PLUGIN = `import { defineRpc } from "@getpaseo/plugin";
import { type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

const received = ${RECEIVED};
const send = defineRpc({
  name: "send",
  input: z.object({ channel: z.string(), extra: z.record(z.string(), z.unknown()).optional() }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});
const probe = defineRpc({
  name: "probe",
  input: z.object({}),
  output: z.object({ supported: z.boolean(), channels: z.array(z.unknown()) }),
});

export default function contribute(server: PluginServerContext) {
  const own: unknown[] = [];
  server.registerChannel!({
    id: "own",
    deliver(delivery) {
      own.push(delivery);
    },
  });
  server.handle(received, () => own);
  server.handle(probe, async () => {
    // The check a plugin makes once, in its entry: both members arrive together.
    const supported =
      typeof server.deliver === "function" && typeof server.listChannels === "function";
    return { supported, channels: supported ? await server.listChannels!() : [] };
  });
  server.handle(send, async ({ channel, extra }) => {
    try {
      await server.deliver!(channel, {
        to: "u1",
        idempotencyKey: "key-1",
        title: "Heads up",
        text: "Release is out",
        status: "succeeded",
        ...extra,
      } as never);
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  return () => undefined;
}`;

test("a plugin lists and delivers through another plugin's channels", async () => {
  const channelDirectory = await writePlugin({ id: "channel-owner", source: CHANNEL_PLUGIN });
  const senderDirectory = await writePlugin({ id: "sender", source: SENDER_PLUGIN });
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });

  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(channelDirectory);
    await client.installDirectoryPlugin(senderDirectory);

    const probe = (await client.invokePluginRpc("sender", "probe", {})) as {
      supported: boolean;
      channels: unknown[];
    };
    expect(probe.supported).toBe(true);
    expect(probe.channels).toEqual((await client.scheduleChannels()).channels);
    expect(probe.channels).toEqual([
      {
        id: "inbox",
        label: "Inbox",
        pluginId: "channel-owner",
        destinations: [{ to: "u1", label: "User one" }],
      },
      { id: "own", label: null, pluginId: "sender", destinations: [] },
      { id: "refusing", label: null, pluginId: "channel-owner", destinations: [] },
    ]);

    await expect(client.invokePluginRpc("sender", "send", { channel: "inbox" })).resolves.toEqual({
      ok: true,
      error: null,
    });
    expect(await client.invokePluginRpc("channel-owner", "received", {})).toEqual([
      {
        to: "u1",
        idempotencyKey: "key-1",
        status: "succeeded",
        text: "Release is out",
        agentId: null,
        source: { kind: "plugin", pluginId: "sender", title: "Heads up" },
      },
    ]);

    // A plugin can reach its own channel.
    await client.invokePluginRpc("sender", "send", { channel: "own" });
    expect(await client.invokePluginRpc("sender", "received", {})).toEqual([
      expect.objectContaining({
        source: { kind: "plugin", pluginId: "sender", title: "Heads up" },
      }),
    ]);

    await expect(
      client.invokePluginRpc("sender", "send", { channel: "refusing" }),
    ).resolves.toEqual({ ok: false, error: "vendor rejected the message" });
    await expect(client.invokePluginRpc("sender", "send", { channel: "missing" })).resolves.toEqual(
      {
        ok: false,
        error: 'No running plugin provides channel "missing"',
      },
    );

    // A sender cannot name another plugin, and the rejected call does not take the plugin down.
    const forged = (await client.invokePluginRpc("sender", "send", {
      channel: "inbox",
      extra: { pluginId: "channel-owner" },
    })) as { ok: boolean; error: string | null };
    expect(forged.ok).toBe(false);
    expect(await client.invokePluginRpc("channel-owner", "received", {})).toHaveLength(1);
    await expect(client.invokePluginRpc("sender", "send", { channel: "inbox" })).resolves.toEqual({
      ok: true,
      error: null,
    });
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 120_000);
