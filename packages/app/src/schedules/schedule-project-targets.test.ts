import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "@/utils/projects";
import {
  buildProjectNameByCwd,
  buildScheduleProjectTargets,
  buildScheduleWorkspaceIndex,
  canJudgeWorkspaceMissing,
  describeScheduleCwd,
} from "./schedule-project-targets";

function makeProject(overrides: Partial<ProjectSummary>): ProjectSummary {
  return {
    viewKey: "proj",
    projectName: "Project",
    hosts: [],
    totalWorkspaceCount: 0,
    hostCount: 0,
    onlineHostCount: 0,
    ...overrides,
  };
}

function makeHost(overrides: Partial<ProjectSummary["hosts"][number]>) {
  return {
    serverId: "host-1",
    projectId: "project-1",
    projectName: "Project",
    projectCustomName: null,
    serverName: "Host 1",
    isOnline: true,
    repoRoot: "/tmp/project",
    workspaceCount: 0,
    workspaces: [],
    ...overrides,
  };
}

describe("buildScheduleProjectTargets", () => {
  it("emits one target per online host with a repo root", () => {
    const targets = buildScheduleProjectTargets([
      makeProject({
        projectName: "Alpha",
        hosts: [
          makeHost({ projectName: "Alpha on Host 1", repoRoot: "/tmp/alpha" }),
          makeHost({ serverId: "host-2", projectName: "Alpha on Host 2" }),
        ],
      }),
    ]);
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      serverId: "host-1",
      cwd: "/tmp/alpha",
      projectName: "Alpha on Host 1",
    });
  });

  it("skips offline hosts and blank repo roots", () => {
    const targets = buildScheduleProjectTargets([
      makeProject({
        hosts: [makeHost({ isOnline: false }), makeHost({ serverId: "host-3", repoRoot: "   " })],
      }),
    ]);
    expect(targets).toHaveLength(0);
  });
});

function makeWorkspace(
  overrides: Partial<ProjectSummary["hosts"][number]["workspaces"][number]>,
): ProjectSummary["hosts"][number]["workspaces"][number] {
  return {
    id: "wks_main",
    name: "main",
    workspaceKind: "local_checkout",
    status: "done",
    currentBranch: "main",
    changeRequestNumber: null,
    ...overrides,
  };
}

describe("schedule project workspaces", () => {
  const projects = [
    makeProject({
      hosts: [
        makeHost({
          projectId: "project-1",
          projectName: "Alpha",
          repoRoot: "/tmp/alpha",
          workspaces: [
            makeWorkspace({ id: "wks_main", name: "main" }),
            makeWorkspace({ id: "wks_report", name: "Weekly report", workspaceKind: "directory" }),
            makeWorkspace({ id: "wks_bg", name: "Hidden", background: true }),
            makeWorkspace({ id: "wks_closing", name: "Closing", archivingAt: "2026-07-01" }),
          ],
        }),
      ],
    }),
  ];

  it("lists each target's workspaces that are not being archived, flagging background ones", () => {
    const [target] = buildScheduleProjectTargets(projects);
    expect(target?.workspaces).toEqual([
      { id: "wks_main", name: "main", workspaceKind: "local_checkout", background: false },
      { id: "wks_report", name: "Weekly report", workspaceKind: "directory", background: false },
      { id: "wks_bg", name: "Hidden", workspaceKind: "local_checkout", background: true },
    ]);
  });

  it("names a bound workspace by host and id, leaving out one being archived", () => {
    const index = buildScheduleWorkspaceIndex(buildScheduleProjectTargets(projects));
    expect(index.get("host-1:wks_report")).toEqual({
      name: "Weekly report",
      projectName: "Alpha",
    });
    expect(index.has("host-1:wks_bg")).toBe(true);
    expect(index.has("host-1:wks_closing")).toBe(false);
  });

  it("only calls a workspace missing once the host's workspaces loaded and its projects show", () => {
    const targets = buildScheduleProjectTargets(projects);
    const judge = (serverId: string, workspacesLoaded: boolean) =>
      canJudgeWorkspaceMissing({ targets, serverId, workspacesLoaded });

    expect(judge("host-1", true)).toBe(true);
    expect(judge("host-1", false)).toBe(false);
    // An offline host has no targets: its workspaces are unknown, not gone.
    expect(judge("host-offline", true)).toBe(false);
  });
});

describe("describeScheduleCwd", () => {
  it("prefers a matched project name and shortens unmatched paths", () => {
    const byCwd = buildProjectNameByCwd(
      buildScheduleProjectTargets([
        makeProject({
          projectName: "Grouped Alpha",
          hosts: [makeHost({ projectName: "Alpha on Host 1", repoRoot: "/tmp/alpha" })],
        }),
      ]),
    );
    expect(
      describeScheduleCwd({ serverId: "host-1", cwd: "/tmp/alpha", projectNameByCwd: byCwd }),
    ).toBe("Alpha on Host 1");
    expect(
      describeScheduleCwd({ serverId: "host-1", cwd: "/Users/sam/api", projectNameByCwd: byCwd }),
    ).toBe("~/api");
  });
});
