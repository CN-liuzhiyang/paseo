import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AutomationSources } from "./automation-sources.js";
import { ScheduleService } from "./service.js";
import { ScheduleStore } from "./store.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { createStub } from "../test-utils/class-mocks.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { runGitCommand } from "../../utils/run-git-command.js";
import { requiredPermissionForInbound } from "../authorization/operation-permissions.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
  type PersistedWorkspaceRecord,
} from "../workspace-registry.js";
const human = { transport: "direct", plugin: false };
const definition = {
  prompt: "test",
  triggers: [{ type: "every", everyMs: 60000 }],
  target: { type: "action", action: "echo", params: { a: 1, b: 2 } },
  delivery: { channel: "chat" },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture(gitRepo = false) {
  const home = await mkdtemp(join(tmpdir(), "automation-source-"));
  const repo = join(home, "repo");
  await mkdir(repo);
  const git = (args: string[]) => runGitCommand(args, { cwd: repo });
  if (gitRepo) {
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Example"]);
    await git(["config", "user.email", "example@example.com"]);
  }
  const logger = createTestLogger();
  const service = new ScheduleService({
    paseoHome: home,
    logger,
    agentManager: new AgentManager({ logger }),
    agentStorage: new AgentStorage(home, logger),
    createAgent: async () => {
      throw new Error("unused");
    },
    createDirectoryWorkspace: async () => {
      throw new Error("unused");
    },
    createPaseoWorktreeWorkspace: async () => {
      throw new Error("unused");
    },
    archiveWorkspace: async () => {},
    archiveAgent: async () => {},
    getWorkspace: async () => null,
    listChannels: async () => [],
    deliverToChannel: async () => {},
    validateAction: async () => {},
    listActions: () => [{ id: "echo", pluginId: "example", params: {} }],
    listTriggerSources: () => [],
    runner: async () => ({ agentId: null, output: "ok" }),
  });
  const project = createPersistedProjectRecord({
    projectId: "p",
    rootPath: repo,
    kind: gitRepo ? "git" : "non_git",
    displayName: "example",
    createdAt: "now",
    updatedAt: "now",
  });
  const data = { projects: [project], workspaces: [] as PersistedWorkspaceRecord[] };
  const errors: unknown[] = [];
  const options = {
    paseoHome: home,
    service,
    projects: createStub<ProjectRegistry>({ list: async () => data.projects }),
    workspaces: createStub<WorkspaceRegistry>({ list: async () => data.workspaces }),
    onError: (error: unknown) => {
      errors.push(error);
    },
  };
  const sources = new AutomationSources(options);
  const file = join(repo, "paseo.json");
  const write = async (automations: unknown, extra = {}) => {
    await writeFile(file, JSON.stringify({ automations, ...extra }));
    if (gitRepo) {
      await git(["add", "paseo.json"]);
      await git(["commit", "-m", "example"]);
    }
  };
  await write({ sync: definition });
  cleanups.push(async () => {
    await sources.stop();
    await service.stop();
    await rm(home, { recursive: true, force: true });
  });
  const request = (
    op: string,
    requestOptions: {
      fingerprint?: string;
      overrides?: Parameters<AutomationSources["request"]>[1]["overrides"];
    } = {},
    caller = human,
  ) => sources.request(op, { id: sources.list()[0]?.id, ...requestOptions }, caller);
  const enable = async () => {
    await request("set", { overrides: { delivery: { channel: "chat", to: "local" } } });
    return (await request("enable", { fingerprint: sources.list()[0].seenFingerprint }))[0]
      .scheduleId!;
  };
  return {
    home,
    repo,
    file,
    git,
    write,
    options,
    sources,
    service,
    data,
    errors,
    request,
    enable,
    store: new ScheduleStore(join(home, "schedules"), logger),
  };
}
test.each([
  "{not json",
  JSON.stringify({ project: { checkout: "example", entries: { sync: { state: "future" } } } }),
])("backs up unreadable state and starts: %s", async (raw) => {
  const f = await fixture();
  await writeFile(join(f.home, "automation-sources.json"), raw);
  await f.sources.start();
  const backups = (await readdir(f.home)).filter((name) => name.includes(".corrupt-"));
  expect(backups).toHaveLength(1);
  expect(await readFile(join(f.home, backups[0]), "utf8")).toBe(raw);
  expect(f.errors).toHaveLength(1);
  expect(f.sources.list()[0].state).toBe("pending");
});
test("repairs dangling records, rejects ordinary deletion, and forgets explicitly", async () => {
  const f = await fixture();
  await f.sources.start();
  const id = await f.enable();
  await expect(f.service.delete(id)).rejects.toThrow("source forget");
  await f.store.delete(id);
  await f.sources.stop();
  await f.write({});
  const restarted = new AutomationSources(f.options);
  try {
    await restarted.start();
    expect(restarted.list()[0].state).toBe("pending");
    expect(restarted.list()[0].scheduleId).toBeUndefined();
  } finally {
    await restarted.stop();
  }
  await f.sources.scan();
  expect(f.sources.list()[0].scheduleId).toBeUndefined();
  await f.request("forget");
  expect(f.sources.list()).toEqual([]);
});
test("read failures retain approval; bad entries are isolated; identical orphaned definitions recover", async () => {
  const f = await fixture();
  await f.sources.start();
  const id = await f.enable();
  const approved = f.sources.list()[0].approvedFingerprint;
  await writeFile(f.file, "{broken");
  await f.sources.scan();
  expect(f.sources.list()[0]).toMatchObject({ state: "enabled", approvedFingerprint: approved });
  expect(f.sources.list()[0].error).toBeTruthy();
  expect(f.sources.list()[0].error).not.toMatch(/\n/);
  expect((await f.service.inspect(id)).status).toBe("active");
  await f.write({
    sync: definition,
    __bad: 42,
    broken: { ...definition, delivery: { channel: "chat", to: "repository" } },
  });
  await f.sources.scan();
  expect(f.sources.list().find((s) => s.automationId === "sync")).toMatchObject({
    state: "enabled",
    error: undefined,
  });
  expect(f.sources.list().find((s) => s.automationId === "__bad")?.error).toBe(
    "Invalid automation ID",
  );
  expect(f.sources.list().find((s) => s.automationId === "broken")?.error).toContain(
    "Unrecognized key",
  );
  await f.write({});
  await f.sources.scan();
  expect((await f.service.inspect(id)).pauseReason).toBe("source-orphaned");
  await f.write({ sync: definition });
  await f.sources.scan();
  expect(f.sources.list()[0].state).toBe("enabled");
  expect((await f.service.inspect(id)).status).toBe("active");
  expect((await f.service.inspect(id)).pauseReason).toBeUndefined();
});
test("set requires human approval and preserves pause state; enable clears reasons and resets rate limits", async () => {
  const f = await fixture();
  await f.sources.start();
  const id = await f.enable();
  await f.service.runOnce(id);
  expect(requiredPermissionForInbound("schedule.sources.set.request")).toBe("daemon.manage");
  for (const caller of [
    { transport: "relay", plugin: false },
    { transport: "direct", plugin: true },
  ])
    await expect(f.request("set", { overrides: { params: { b: 99 } } }, caller)).rejects.toThrow(
      "direct human",
    );
  await f.service.pause(id, "rate-limit");
  const paused = await f.service.inspect(id);
  await f.request("set", { overrides: { params: { b: 3 } } });
  expect(await f.service.inspect(id)).toMatchObject({
    status: "paused",
    pausedAt: paused.pausedAt,
    pauseReason: "rate-limit",
    target: { params: { a: 1, b: 3 } },
  });
  await f.request("enable", { fingerprint: f.sources.list()[0].seenFingerprint });
  expect(await f.service.inspect(id)).toMatchObject({
    status: "active",
    eventRateLimitRunOffset: 1,
  });
  await f.service.pause(id);
  const manual = await f.service.inspect(id);
  await f.service.pause(id, "rate-limit");
  expect(await f.service.inspect(id)).toEqual(manual);
  await f.request("disable");
  await f.sources.scan();
  expect((await f.service.inspect(id)).pauseReason).toBeUndefined();
  await expect(
    f.request("set", { overrides: { delivery: { channel: "other", to: "local" } } }),
  ).rejects.toThrow("channel");
  await expect(f.request("set", { overrides: { provider: "claude" } })).rejects.toThrow(
    "do not apply",
  );
});
test.each([
  "agent",
  "mcpServers",
  "providerOptions",
  "featureValues",
  "systemPrompt",
  "modeId",
  "provider",
  "model",
])("rejects repository target authority: %s", async (field) => {
  const f = await fixture();
  const target =
    field === "agent"
      ? { type: "agent", agentId: "00000000-0000-0000-0000-000000000001" }
      : { type: "new-agent", config: { [field]: "unsafe" } };
  await f.write({ sync: { ...definition, target } });
  await f.sources.start();
  const source = f.sources.list()[0];
  expect(source.error).toBeTruthy();
  expect(source.error).not.toMatch(/\n/);
  expect(source.error!.length).toBeLessThanOrEqual(240);
  await expect(f.request("enable", { fingerprint: source.seenFingerprint })).rejects.toThrow();
});
test("local provider/model apply only to new agents; params only to actions", async () => {
  const f = await fixture();
  await f.write({
    sync: { ...definition, target: { type: "new-agent", config: { title: "Example" } } },
  });
  await f.sources.start();
  await expect(f.request("set", { overrides: { params: { a: 1 } } })).rejects.toThrow(
    "do not apply",
  );
  await f.request("set", {
    overrides: { provider: "claude", model: "example", delivery: { channel: "chat", to: "local" } },
  });
  const [source] = await f.request("enable", { fingerprint: f.sources.list()[0].seenFingerprint });
  expect((await f.service.inspect(source.scheduleId!)).target).toMatchObject({
    config: { provider: "claude", model: "example", title: "Example" },
  });
});
test("committed default branch, fingerprints, history and checkout trust remain stable", async () => {
  const f = await fixture(true);
  await f.sources.start();
  const initial = f.sources.list()[0];
  const id = await f.enable();
  await f.service.runOnce(id);
  await expect(f.request("enable", { fingerprint: "bad" })).rejects.toThrow("fingerprint");
  for (const caller of [
    { transport: "relay", plugin: false },
    { transport: "direct", plugin: true },
  ])
    await expect(
      f.request("enable", { fingerprint: initial.seenFingerprint }, caller),
    ).rejects.toThrow("direct human");
  await f.write({ sync: definition }, { scripts: { test: "example" } });
  await f.sources.scan();
  expect(f.sources.list()[0].seenFingerprint).toBe(initial.seenFingerprint);
  await f.git(["checkout", "-b", "feature"]);
  await f.write({ sync: { ...definition, prompt: "feature" } });
  await f.sources.scan();
  expect(f.sources.list()[0].seenFingerprint).toBe(initial.seenFingerprint);
  await f.git(["checkout", "main"]);
  await f.write({ sync: { ...definition, prompt: "changed" } });
  await f.sources.scan();
  expect(f.sources.list()[0].state).toBe("pending");
  expect((await f.service.inspect(id)).pauseReason).toBe("source-changed");
  await expect(f.service.update({ id, prompt: "bypass" })).rejects.toThrow("paseo.json");
  await expect(f.service.resume(id)).rejects.toThrow("source enable");
  await expect(f.service.runOnce(id)).rejects.toThrow("source enable");
  await f.request("enable", { fingerprint: f.sources.list()[0].seenFingerprint });
  expect(await f.service.logs(id)).toHaveLength(1);
  expect((await f.service.inspect(id)).pauseReason).toBeUndefined();
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "w",
    projectId: "p",
    cwd: f.repo,
    kind: "local_checkout",
    displayName: "example",
    createdAt: "now",
    updatedAt: "now",
  });
  const sibling = join(f.home, "sibling");
  await f.git(["worktree", "add", "--detach", sibling, "main"]);
  f.data.projects.push({ ...f.data.projects[0], projectId: "p2", rootPath: sibling });
  f.data.workspaces = [
    workspace,
    { ...workspace, projectId: "p2", workspaceId: "w2", cwd: sibling, mainRepoRoot: f.repo },
  ];
  await f.sources.scan();
  expect(f.sources.list()).toHaveLength(1);
  expect(f.sources.cwd(await f.service.inspect(id))).toBe(await realpath(f.repo));
  f.data.projects.splice(1);
  f.data.workspaces = [
    {
      ...workspace,
      untrustedSource: {
        kind: "change_request",
        forge: "github",
        number: 1,
        headRepository: "example/fork",
      },
    },
  ];
  await f.sources.scan();
  expect(f.sources.list()[0].state).toBe("orphaned");
  f.data.workspaces = [];
  await f.write({
    sync: { ...definition, target: { type: "action", action: "missing", params: {} } },
  });
  await f.sources.scan();
  expect(f.sources.list()[0].error).toBe("缺少插件：missing");
  await expect(
    f.request("enable", { fingerprint: f.sources.list()[0].seenFingerprint }),
  ).rejects.toThrow("缺少插件");
  await f.write({
    sync: { ...definition, triggers: [{ type: "event", source: "missing", event: "ping" }] },
  });
  await f.sources.scan();
  expect(f.sources.list()[0].error).toBe("缺少插件：missing:ping");
  await f.git(["rm", "paseo.json"]);
  await f.git(["commit", "-m", "remove"]);
  await f.sources.scan();
  expect(f.sources.list()[0].state).toBe("orphaned");
}, 60000);
