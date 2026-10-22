import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonConfigStore } from "../daemon-config-store.js";
import { PluginService } from "./index.js";
import {
  PluginProcessMessageSchema,
  PluginProcessRequestSchema,
  type PluginChannelMetadata,
} from "./plugin-process-protocol.js";
import { PluginRuntime } from "./runtime.js";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createPluginDirectory(id: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-channel-runtime-"));
  directories.push(directory);
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id }), "utf8");
  await writeFile(
    path.join(directory, "index.server.ts"),
    "export default function contribute() { return () => undefined; }",
    "utf8",
  );
  return directory;
}

type DestinationsAnswer =
  | { kind: "result"; output: unknown }
  | { kind: "error"; error: string }
  | { kind: "hang" };

/**
 * A stand-in plugin subprocess that advertises channels and answers `channel.destinations`, and
 * `channel.deliver` from `deliverAnswers` (a delivery with no entry succeeds).
 */
function createChannelChild(
  channels: PluginChannelMetadata[],
  answers: Record<string, DestinationsAnswer>,
  deliverAnswers: Record<string, DestinationsAnswer> = {},
) {
  const listeners = new Map<string, Array<(message: never) => void>>();
  const emit = (event: string, message: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(message as never);
  };
  const requests: Array<{ type: string; channelId?: string }> = [];
  const sent: Array<Record<string, unknown>> = [];
  return {
    requests,
    sent,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    connected: true,
    killed: false,
    send(
      message: { type: string; requestId?: string; channelId?: string },
      callback?: (error: Error | null) => void,
    ) {
      callback?.(null);
      requests.push({ type: message.type, channelId: message.channelId });
      sent.push(message);
      if (message.type === "initialize") {
        queueMicrotask(() =>
          emit("message", { type: "ready", methods: [], providers: [], channels }),
        );
      }
      if (message.type === "channel.deliver") {
        const answer = deliverAnswers[message.channelId ?? ""] ?? { kind: "result", output: null };
        if (answer.kind === "result") {
          queueMicrotask(() =>
            emit("message", {
              type: "result",
              requestId: message.requestId,
              output: answer.output,
            }),
          );
        } else if (answer.kind === "error") {
          queueMicrotask(() =>
            emit("message", { type: "error", requestId: message.requestId, error: answer.error }),
          );
        }
      }
      if (message.type === "channel.destinations") {
        const answer = answers[message.channelId ?? ""] ?? { kind: "result", output: [] };
        if (answer.kind === "result") {
          queueMicrotask(() =>
            emit("message", {
              type: "result",
              requestId: message.requestId,
              output: answer.output,
            }),
          );
        } else if (answer.kind === "error") {
          queueMicrotask(() =>
            emit("message", { type: "error", requestId: message.requestId, error: answer.error }),
          );
        }
      }
      if (message.type === "shutdown") {
        this.connected = false;
        queueMicrotask(() => emit("close", null));
      }
      return true;
    },
    kill() {
      this.killed = true;
      this.connected = false;
      queueMicrotask(() => emit("close", null));
      return true;
    },
    disconnect() {
      this.connected = false;
    },
    on(event: string, listener: (message: never) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return this;
    },
    emitMessage(message: unknown) {
      emit("message", message);
    },
  };
}

function createRuntime(children: Array<ReturnType<typeof createChannelChild>>): PluginRuntime {
  const queue = [...children];
  return new PluginRuntime(pino({ level: "silent" }), "0.4.0", {
    spawnChild: () => {
      const child = queue.shift();
      if (!child) throw new Error("No test child left");
      return child;
    },
    sessionHost: {
      async attachPluginSocket(_pluginId, socket) {
        return { closed: new Promise<void>((resolve) => socket.once("close", resolve)) };
      },
    },
  });
}

describe("PluginRuntime channels", () => {
  it("lists every channel with its label and destinations, and keeps a failing one", async () => {
    const child = createChannelChild(
      [{ id: "chat", label: "Chat" }, { id: "mail" }, { id: "pager", label: "Pager" }],
      {
        chat: { kind: "result", output: [{ to: "room-1", label: "Team room" }] },
        mail: { kind: "result", output: [] },
        pager: { kind: "error", error: "pager token expired" },
      },
    );
    const runtime = createRuntime([child]);
    await runtime.startPlugin("notify", await createPluginDirectory("notify"));

    await expect(runtime.listChannels()).resolves.toEqual([
      {
        id: "chat",
        label: "Chat",
        pluginId: "notify",
        destinations: [{ to: "room-1", label: "Team room" }],
      },
      { id: "mail", label: null, pluginId: "notify", destinations: [] },
      {
        id: "pager",
        label: "Pager",
        pluginId: "notify",
        destinations: null,
        error: "pager token expired",
      },
    ]);
    await runtime.stopAll();
  });

  it("returns a channel that does not answer in time with an error instead of failing the list", async () => {
    const child = createChannelChild([{ id: "chat" }, { id: "slow" }], {
      chat: { kind: "result", output: [{ to: "room-1", label: "Team room" }] },
      slow: { kind: "hang" },
    });
    const runtime = createRuntime([child]);
    await runtime.startPlugin("notify", await createPluginDirectory("notify"));

    vi.useFakeTimers();
    const listing = runtime.listChannels();
    await vi.advanceTimersByTimeAsync(10_000);
    const channels = await listing;
    vi.useRealTimers();

    expect(channels).toEqual([
      {
        id: "chat",
        label: null,
        pluginId: "notify",
        destinations: [{ to: "room-1", label: "Team room" }],
      },
      {
        id: "slow",
        label: null,
        pluginId: "notify",
        destinations: null,
        error: 'Channel "slow" (plugin notify) did not list its destinations within 10s',
      },
    ]);
    await runtime.stopAll();
  });

  it("rejects destinations that are not { to, label } objects", async () => {
    const child = createChannelChild([{ id: "chat" }], {
      chat: { kind: "result", output: [{ label: "No address" }] },
    });
    const runtime = createRuntime([child]);
    await runtime.startPlugin("notify", await createPluginDirectory("notify"));

    const [channel] = await runtime.listChannels();
    expect(channel).toMatchObject({ id: "chat", destinations: null });
    expect(channel?.error).toContain("to");
    await runtime.stopAll();
  });

  it("lists a channel two plugins register once, owned by the alphabetically first plugin", async () => {
    const zulu = createChannelChild([{ id: "chat", label: "Zulu chat" }], {
      chat: { kind: "result", output: [{ to: "z", label: "Zulu room" }] },
    });
    const alpha = createChannelChild([{ id: "chat", label: "Alpha chat" }], {
      chat: { kind: "result", output: [{ to: "a", label: "Alpha room" }] },
    });
    const runtime = createRuntime([zulu, alpha]);
    await runtime.startPlugin("zulu", await createPluginDirectory("zulu"));
    await runtime.startPlugin("alpha", await createPluginDirectory("alpha"));

    await expect(runtime.listChannels()).resolves.toEqual([
      {
        id: "chat",
        label: "Alpha chat",
        pluginId: "alpha",
        destinations: [{ to: "a", label: "Alpha room" }],
      },
    ]);
    expect(zulu.requests.some((request) => request.type === "channel.destinations")).toBe(false);
    expect(runtime.getLogs("zulu").map((entry) => entry.message)).toContain(
      '[paseo] Channel "chat" is also registered by plugin alpha; deliveries go to alpha',
    );
    await runtime.stopAll();
  });

  it("follows channels.changed, including a label registered after ready", async () => {
    const child = createChannelChild([], {
      late: { kind: "result", output: [{ to: "x", label: "Somewhere" }] },
    });
    const runtime = createRuntime([child]);
    await runtime.startPlugin("notify", await createPluginDirectory("notify"));
    await expect(runtime.listChannels()).resolves.toEqual([]);

    child.emitMessage({ type: "channels.changed", channels: [{ id: "late", label: "Late" }] });

    await expect(runtime.listChannels()).resolves.toEqual([
      {
        id: "late",
        label: "Late",
        pluginId: "notify",
        destinations: [{ to: "x", label: "Somewhere" }],
      },
    ]);
    await runtime.stopAll();
  });
});

const MESSAGE = {
  to: "room-1",
  idempotencyKey: "reminder-7",
  title: "Reminder",
  text: "Ship the build",
  status: "succeeded",
} as const;

function deliverRequest(requestId: string, channelId: string, message: object = MESSAGE) {
  return { type: "channel.deliver.request", requestId, channelId, message };
}

/** The host's answers to one plugin's `channel.*.request` messages, in order. */
function responses(child: ReturnType<typeof createChannelChild>) {
  return child.sent.filter((message) => message.type === "channel.response");
}

async function settled(): Promise<void> {
  await vi.waitFor(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
}

describe("PluginRuntime: a plugin delivering through another plugin's channel", () => {
  it("hands the owner a plugin-sourced delivery whose pluginId is the sender's", async () => {
    const owner = createChannelChild([{ id: "chat" }], {});
    const sender = createChannelChild([], {});
    const runtime = createRuntime([owner, sender]);
    await runtime.startPlugin("chat-plugin", await createPluginDirectory("chat-plugin"));
    await runtime.startPlugin("controller", await createPluginDirectory("controller"));

    sender.emitMessage(deliverRequest("r1", "chat"));
    await vi.waitFor(() => expect(responses(sender)).toHaveLength(1));

    expect(owner.sent.find((message) => message.type === "channel.deliver")).toMatchObject({
      channelId: "chat",
      delivery: {
        to: "room-1",
        idempotencyKey: "reminder-7",
        status: "succeeded",
        text: "Ship the build",
        agentId: null,
        source: { kind: "plugin", pluginId: "controller", title: "Reminder" },
      },
    });
    expect(responses(sender)).toEqual([
      { type: "channel.response", requestId: "r1", output: null },
    ]);
    await runtime.stopAll();
  });

  it("does not let the sender name itself: a message carrying pluginId is a protocol violation", () => {
    const message = { ...MESSAGE, pluginId: "someone-else" };
    expect(
      PluginProcessMessageSchema.safeParse(deliverRequest("r1", "chat", message)).success,
    ).toBe(false);
    expect(PluginProcessMessageSchema.safeParse(deliverRequest("r1", "chat")).success).toBe(true);
  });

  it("requires status", () => {
    const { status: _status, ...withoutStatus } = MESSAGE;
    expect(
      PluginProcessMessageSchema.safeParse(deliverRequest("r1", "chat", withoutStatus)).success,
    ).toBe(false);
  });

  it("answers a channel nobody provides with the same error a schedule gets", async () => {
    const sender = createChannelChild([], {});
    const runtime = createRuntime([sender]);
    await runtime.startPlugin("controller", await createPluginDirectory("controller"));

    sender.emitMessage(deliverRequest("r1", "missing"));
    await vi.waitFor(() => expect(responses(sender)).toHaveLength(1));

    expect(responses(sender)).toEqual([
      {
        type: "channel.response",
        requestId: "r1",
        error: 'No running plugin provides channel "missing"',
      },
    ]);
    await runtime.stopAll();
  });

  it("passes the channel's own error back untouched", async () => {
    const owner = createChannelChild(
      [{ id: "chat" }],
      {},
      { chat: { kind: "error", error: "vendor rejected the message" } },
    );
    const sender = createChannelChild([], {});
    const runtime = createRuntime([owner, sender]);
    await runtime.startPlugin("chat-plugin", await createPluginDirectory("chat-plugin"));
    await runtime.startPlugin("controller", await createPluginDirectory("controller"));

    sender.emitMessage(deliverRequest("r1", "chat"));
    await vi.waitFor(() => expect(responses(sender)).toHaveLength(1));

    expect(responses(sender)).toEqual([
      { type: "channel.response", requestId: "r1", error: "vendor rejected the message" },
    ]);
    await runtime.stopAll();
  });

  it("gives up on a channel that never answers after the 60s a schedule delivery gets", async () => {
    const owner = createChannelChild([{ id: "chat" }], {}, { chat: { kind: "hang" } });
    const sender = createChannelChild([], {});
    const runtime = createRuntime([owner, sender]);
    await runtime.startPlugin("chat-plugin", await createPluginDirectory("chat-plugin"));
    await runtime.startPlugin("controller", await createPluginDirectory("controller"));

    vi.useFakeTimers();
    sender.emitMessage(deliverRequest("r1", "chat"));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(responses(sender)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await settled();

    expect(responses(sender)).toEqual([
      {
        type: "channel.response",
        requestId: "r1",
        error: 'Channel "chat" (plugin chat-plugin) did not finish delivering within 60s',
      },
    ]);
    await runtime.stopAll();
  });

  it("lets a plugin deliver to a channel it registered itself", async () => {
    const both = createChannelChild([{ id: "loopback" }], {});
    const runtime = createRuntime([both]);
    await runtime.startPlugin("controller", await createPluginDirectory("controller"));

    both.emitMessage(deliverRequest("r1", "loopback"));
    await vi.waitFor(() => expect(responses(both)).toHaveLength(1));

    expect(both.sent.find((message) => message.type === "channel.deliver")).toMatchObject({
      delivery: { source: { kind: "plugin", pluginId: "controller", title: "Reminder" } },
    });
    expect(responses(both)).toEqual([{ type: "channel.response", requestId: "r1", output: null }]);
    await runtime.stopAll();
  });

  it("lists channels in the shape `paseo schedule channels` returns", async () => {
    const owner = createChannelChild([{ id: "chat", label: "Chat" }], {
      chat: { kind: "result", output: [{ to: "room-1", label: "Team room" }] },
    });
    const sender = createChannelChild([], {});
    const runtime = createRuntime([owner, sender]);
    await runtime.startPlugin("chat-plugin", await createPluginDirectory("chat-plugin"));
    await runtime.startPlugin("controller", await createPluginDirectory("controller"));

    sender.emitMessage({ type: "channel.list.request", requestId: "r1" });
    await vi.waitFor(() => expect(responses(sender)).toHaveLength(1));

    const listed = await runtime.listChannels();
    expect(responses(sender)).toEqual([
      { type: "channel.response", requestId: "r1", output: listed },
    ]);
    expect(listed).toEqual([
      {
        id: "chat",
        label: "Chat",
        pluginId: "chat-plugin",
        destinations: [{ to: "room-1", label: "Team room" }],
      },
    ]);
    await runtime.stopAll();
  });

  it("answers a request that arrives before the sender reports ready", async () => {
    const owner = createChannelChild([{ id: "chat" }], {});
    const early = createChannelChild([], {});
    // Mirrors an entry that calls server.deliver before its first `ready`.
    const original = early.send.bind(early);
    early.send = (message, callback) => {
      if (message.type === "initialize") early.emitMessage(deliverRequest("early", "chat"));
      return original(message, callback);
    };
    const runtime = createRuntime([owner, early]);
    await runtime.startPlugin("chat-plugin", await createPluginDirectory("chat-plugin"));
    await runtime.startPlugin("controller", await createPluginDirectory("controller"));

    await vi.waitFor(() => expect(responses(early)).toHaveLength(1));
    expect(responses(early)).toEqual([
      { type: "channel.response", requestId: "early", output: null },
    ]);
    expect(owner.sent.find((message) => message.type === "channel.deliver")).toMatchObject({
      delivery: { source: { kind: "plugin", pluginId: "controller" } },
    });
    await runtime.stopAll();
  });
});

describe("PluginService.listChannels", () => {
  it("is empty while plugins are globally disabled and asks the runtime otherwise", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-channel-service-"));
    directories.push(home);
    const store = new DaemonConfigStore(home, {
      mcp: { injectIntoAgents: true },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
      pluginsEnabled: true,
      plugins: {},
    });
    const listChannels = vi.fn(async () => [
      { id: "chat", label: null, pluginId: "notify", destinations: [] },
    ]);
    const service = new PluginService(pino({ level: "silent" }), store, "0.4.0", {
      runtime: {
        catalog: () => [],
        invoke: async () => undefined,
        getLogs: () => [],
        clearLogs: () => undefined,
        connectProvider: async () => {
          throw new Error("unused");
        },
        startPlugin: async () => undefined,
        stopPluginById: async () => false,
        stopAll: async () => undefined,
        subscribe: () => () => undefined,
        bindPaseoSessionHost: () => undefined,
        listChannels,
      },
    });

    await expect(service.listChannels()).resolves.toEqual([
      { id: "chat", label: null, pluginId: "notify", destinations: [] },
    ]);
    store.patch({ pluginsEnabled: false });
    await expect(service.listChannels()).resolves.toEqual([]);
    expect(listChannels).toHaveBeenCalledTimes(1);
  });
});

describe("plugin process protocol: channels", () => {
  it("carries channel ids with optional labels in ready and channels.changed", () => {
    expect(
      PluginProcessMessageSchema.safeParse({
        type: "ready",
        methods: [],
        providers: [],
        channels: [{ id: "chat", label: "Chat" }, { id: "mail" }],
      }).success,
    ).toBe(true);
    expect(
      PluginProcessMessageSchema.safeParse({
        type: "channels.changed",
        channels: [{ id: "chat" }],
      }).success,
    ).toBe(true);
    expect(
      PluginProcessMessageSchema.safeParse({ type: "channels.changed", channels: ["chat"] })
        .success,
    ).toBe(false);
    expect(
      PluginProcessMessageSchema.safeParse({
        type: "channels.changed",
        channels: [{ id: "chat", extra: true }],
      }).success,
    ).toBe(false);
  });

  it("accepts channel.destinations requests and nothing looser", () => {
    expect(
      PluginProcessRequestSchema.safeParse({
        type: "channel.destinations",
        requestId: "r1",
        channelId: "chat",
      }).success,
    ).toBe(true);
    expect(
      PluginProcessRequestSchema.safeParse({
        type: "channel.destinations",
        requestId: "r1",
        channelId: "",
      }).success,
    ).toBe(false);
    expect(
      PluginProcessRequestSchema.safeParse({
        type: "channel.destinations",
        requestId: "r1",
        channelId: "chat",
        to: "room",
      }).success,
    ).toBe(false);
  });
});
