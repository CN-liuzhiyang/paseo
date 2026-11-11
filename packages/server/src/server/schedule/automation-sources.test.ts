import { requiredPermissionForInbound } from "../authorization/operation-permissions.js";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AutomationSources } from "./automation-sources.js";
import { ScheduleService } from "./service.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { createStub } from "../test-utils/class-mocks.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { runGitCommand } from "../../utils/run-git-command.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "../workspace-registry.js";

test("project sources approve exact definitions, preserve history, ignore feature branches and become orphaned", async () => {
  expect(requiredPermissionForInbound("schedule.sources.enable.request")).toBe("daemon.manage");
  const home = await mkdtemp(join(tmpdir(), "automation-source-"));
  const repo = join(home, "repo");
  await mkdir(repo);
  const git = (args: string[]) => runGitCommand(args, { cwd: repo });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Example"]);
  await git(["config", "user.email", "example@example.com"]);
  const definition = {
    prompt: "test",
    triggers: [{ type: "every", everyMs: 60000 }],
    target: { type: "action", action: "echo", params: { a: 1, b: 2 } },
  };
  const commit = async (automations: unknown, extra = {}) => {
    await writeFile(join(repo, "paseo.json"), JSON.stringify({ automations, ...extra }));
    await git(["add", "paseo.json"]);
    await git(["commit", "-m", "example"]);
  };
  await commit({ sync: definition });
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
    kind: "git",
    displayName: "example",
    createdAt: "now",
    updatedAt: "now",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "w",
    projectId: "p",
    cwd: repo,
    kind: "local_checkout",
    displayName: "example",
    createdAt: "now",
    updatedAt: "now",
  });
  let projects = [project];
  let workspaces = [workspace];
  const options = {
    paseoHome: home,
    service,
    projects: createStub<ProjectRegistry>({ list: async () => projects }),
    workspaces: createStub<WorkspaceRegistry>({ list: async () => workspaces }),
    onError: (error: unknown) => {
      throw error;
    },
  };
  let sources = new AutomationSources(options);
  try {
    await sources.start();
    const [source] = sources.list();
    expect(source.state).toBe("pending");
    expect(source.id).toHaveLength(8);
    const enable = (
      fingerprint = source.seenFingerprint,
      caller = { transport: "direct", plugin: false },
    ) => sources.request("enable", { id: source.id, fingerprint }, caller);
    await expect(enable("bad")).rejects.toThrow("fingerprint");
    await expect(
      enable(source.seenFingerprint, { transport: "relay", plugin: false }),
    ).rejects.toThrow("direct human");
    await expect(
      enable(source.seenFingerprint, { transport: "direct", plugin: true }),
    ).rejects.toThrow("direct human");
    await sources.request(
      "set",
      {
        id: source.id,
        overrides: { params: { b: 3 }, delivery: { channel: "chat", to: "local" } },
      },
      {},
    );
    const [enabled] = await enable();
    const id = enabled.scheduleId!;
    expect((await service.inspect(id)).target).toMatchObject({ params: { a: 1, b: 3 } });
    expect(sources.cwd(await service.inspect(id))).toBe(await realpath(repo));
    await service.runOnce(id);
    expect((await service.logs(id))[0].output).toBe("ok");
    await expect(service.update({ id, prompt: "bypass" })).rejects.toThrow("paseo.json");
    await expect(service.resume(id)).rejects.toThrow("source enable");
    await sources.stop();
    sources = new AutomationSources(options);
    await sources.start();
    expect(sources.list()[0].state).toBe("enabled");
    await commit({ sync: definition }, { scripts: { test: "example" } });
    await sources.scan();
    expect(sources.list()[0].seenFingerprint).toBe(source.seenFingerprint);
    await git(["checkout", "-b", "feature"]);
    await commit({ sync: { ...definition, prompt: "feature" } });
    await sources.scan();
    expect(sources.list()[0].seenFingerprint).toBe(source.seenFingerprint);
    await git(["checkout", "main"]);
    await commit({ sync: { ...definition, prompt: "changed" } });
    await sources.scan();
    const changed = sources.list()[0];
    expect(changed).toMatchObject({ state: "pending", approvedDefinition: definition });
    expect(changed.definition.prompt).toBe("changed");
    expect(await service.inspect(id)).toMatchObject({
      status: "paused",
      pauseReason: "source-changed",
    });
    await expect(service.runOnce(id)).rejects.toThrow("source enable");
    await expect(enable()).rejects.toThrow("fingerprint");
    await enable(changed.seenFingerprint);
    expect(await service.logs(id)).toHaveLength(1);
    await commit({
      sync: { ...definition, target: { type: "action", action: "missing", params: {} } },
    });
    await sources.scan();
    expect(sources.list()[0].error).toBe("缺少插件：missing");
    await expect(enable(sources.list()[0].seenFingerprint)).rejects.toThrow("缺少插件");
    await commit({});
    await sources.scan();
    expect(sources.list()[0].state).toBe("orphaned");
    expect(await service.logs(id)).toHaveLength(1);
    await sources.request("forget", { id: source.id }, {});
    expect(sources.list()).toEqual([]);
    expect(await service.list()).toEqual([]);
    await commit({ sync: definition });
    workspaces = [
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
    await sources.scan();
    expect(sources.list()).toEqual([]);
    workspaces = [workspace];
    await sources.scan();
    expect(sources.list()).toHaveLength(1);
    const sibling = join(home, "sibling");
    await git(["worktree", "add", "--detach", sibling, "main"]);
    projects = [project, { ...project, projectId: "p2", rootPath: sibling }];
    workspaces = [
      workspace,
      { ...workspace, projectId: "p2", workspaceId: "w2", cwd: sibling, mainRepoRoot: repo },
    ];
    await sources.scan();
    expect(sources.list()).toHaveLength(1);
    projects = [];
    await sources.scan();
    expect(sources.list()[0].state).toBe("orphaned");
    await sources.request("forget", { id: sources.list()[0].id }, {});
    const directory = join(home, "directory");
    await mkdir(directory);
    projects = [{ ...project, rootPath: directory, kind: "non_git" }];
    workspaces = [];
    const config = join(directory, "paseo.json");
    const write = async (nextDefinition: unknown) => {
      await writeFile(config, JSON.stringify({ automations: { sync: nextDefinition } }));
      await sources.scan();
    };
    await write({ ...definition, delivery: { channel: "chat", to: "not-allowed" } });
    expect(sources.list()[0].error).toContain("Unrecognized key");
    await expect(
      sources.request(
        "enable",
        { id: sources.list()[0].id, fingerprint: sources.list()[0].seenFingerprint },
        { transport: "direct" },
      ),
    ).rejects.toThrow("Unrecognized key");
    await write({ ...definition, triggers: [{ type: "event", source: "missing", event: "ping" }] });
    expect(sources.list()[0].error).toBe("缺少插件：missing:ping");
    await write(definition);
    const local = sources.list()[0];
    await sources.request("disable", { id: local.id }, {});
    expect(sources.list()[0].state).toBe("disabled");
    await rm(config);
    await sources.scan();
    expect(sources.list()[0].state).toBe("orphaned");
  } finally {
    await sources.stop();
    await service.stop();
    await rm(home, { recursive: true, force: true });
  }
}, 60000);
