import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  AutomationSourceSchema,
  AutomationSourceOverridesSchema,
  ScheduleTargetSchema,
  ScheduleCadenceSchema,
  EventTriggerSchema,
  type AutomationSource,
  type AutomationSourceOverrides,
  type CreateScheduleInput,
  type StoredSchedule,
} from "@getpaseo/protocol/schedule/types";
import {
  getCheckoutSnapshotFacts,
  resolveRepositoryDefaultBranch,
} from "../../utils/checkout-git.js";
import { getRealpathAwareRelativePath } from "../../utils/path.js";
import { runGitCommand } from "../../utils/run-git-command.js";
import { READ_ONLY_GIT_ENV } from "../checkout-git-utils.js";
import { deriveProjectKey } from "../project-key.js";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type {
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "../workspace-registry.js";
import type { ScheduleService } from "./service.js";

const DefinitionSchema = z
  .object({
    name: z.string().optional(),
    prompt: z.string().min(1),
    target: ScheduleTargetSchema,
    triggers: z
      .array(
        z.discriminatedUnion("type", [
          ScheduleCadenceSchema.options[0],
          ScheduleCadenceSchema.options[1],
          EventTriggerSchema,
        ]),
      )
      .min(1),
    delivery: z
      .object({ channel: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
const EntrySchema = AutomationSourceSchema.omit({
  id: true,
  projectKey: true,
  automationId: true,
  checkout: true,
  error: true,
});
const StateSchema = z.record(
  z.string(),
  z.object({ checkout: z.string(), entries: z.record(z.string(), EntrySchema) }),
);
type State = z.infer<typeof StateSchema>;
export interface SourceCaller {
  transport?: string;
  plugin?: boolean;
}
export function assertSourceApproval(caller: SourceCaller): void {
  if (caller.transport !== "direct" || caller.plugin)
    throw new Error("Source approval requires a direct human connection");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => {
          if (a < b) return -1;
          return a > b ? 1 : 0;
        })
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export class AutomationSources {
  private state: State = {};
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private readonly path: string;
  constructor(
    private readonly options: {
      paseoHome: string;
      service: ScheduleService;
      projects: ProjectRegistry;
      workspaces: WorkspaceRegistry;
      onError: (error: unknown) => void;
    },
  ) {
    this.path = join(options.paseoHome, "automation-sources.json");
  }
  async start(): Promise<void> {
    try {
      this.state = StateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.scan();
    this.timer = setInterval(() => {
      void this.scan().catch(this.options.onError);
    }, 600_000);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.queue;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private save(): Promise<void> {
    return writeJsonFileAtomic(this.path, this.state);
  }
  list(): AutomationSource[] {
    return Object.entries(this.state).flatMap(([projectKey, project]) =>
      Object.entries(project.entries).map(([automationId, entry]) => {
        const result = Object.assign({}, entry, {
          id: hash(`${projectKey}#${automationId}`).slice(0, 8),
          projectKey,
          automationId,
          checkout: project.checkout,
        });
        return Object.assign(result, { error: this.availability(result) });
      }),
    );
  }
  cwd(schedule: StoredSchedule): string | null {
    return schedule.source ? (this.state[schedule.source.projectKey]?.checkout ?? null) : null;
  }
  private availability(source: AutomationSource): string | undefined {
    try {
      const def = DefinitionSchema.parse(source.definition);
      const target = def.target;
      if (
        target.type === "action" &&
        !this.options.service.listActions().some((a) => a.id === target.action)
      )
        return `缺少插件：${target.action}`;
      for (const trigger of def.triggers)
        if (
          trigger.type === "event" &&
          !this.options.service
            .listTriggerSources()
            .some((s) => s.id === trigger.source && s.events.some((e) => e.id === trigger.event))
        )
          return `缺少插件：${trigger.source}:${trigger.event}`;
      return undefined;
    } catch (error) {
      return String(error);
    }
  }
  scan(): Promise<AutomationSource[]> {
    return this.serial(async () => {
      await this.readProjects();
      return this.list();
    });
  }
  private async readProjects(): Promise<void> {
    const found = new Set<string>();
    const projects = await this.options.projects.list();
    const workspaces = await this.options.workspaces.list();
    const visited = new Set<string>();
    for (const project of projects.filter((p) => !p.archivedAt)) {
      try {
        await this.readProject(project, workspaces, visited, found);
      } catch (error) {
        this.options.onError(error);
      }
    }
    for (const [key, project] of Object.entries(this.state))
      for (const [id, entry] of Object.entries(project.entries)) {
        if (!found.has(`${key}#${id}`)) {
          if (entry.scheduleId && entry.state !== "orphaned")
            await this.options.service.pause(entry.scheduleId, "source-orphaned");
          entry.state = "orphaned";
        }
      }
    // Recover a crash between writing a generated schedule and saving its local approval.
    for (const schedule of await this.options.service.list()) {
      if (!schedule.source) continue;
      const entry = this.state[schedule.source.projectKey]?.entries[schedule.source.automationId];
      if (entry) entry.scheduleId = schedule.id;
      if (
        !entry ||
        entry.state !== "enabled" ||
        entry.approvedFingerprint !== schedule.source.fingerprint
      )
        await this.options.service.pause(schedule.id, "source-changed");
    }
    await this.save();
  }
  private async readSourceFile(
    root: string,
    checkout: string,
    facts: Awaited<ReturnType<typeof getCheckoutSnapshotFacts>>,
  ): Promise<string | null> {
    try {
      if (facts.isGit) {
        const branch = await resolveRepositoryDefaultBranch(checkout);
        if (!branch) throw new Error("Cannot resolve default branch");
        const path = [
          (getRealpathAwareRelativePath(facts.worktreeRoot, root) ?? "").replaceAll("\\", "/"),
          "paseo.json",
        ]
          .filter(Boolean)
          .join("/");
        return (
          await runGitCommand(["show", `${branch}:${path}`], {
            cwd: checkout,
            envOverlay: READ_ONLY_GIT_ENV,
          })
        ).stdout;
      } else return await readFile(join(checkout, "paseo.json"), "utf8");
    } catch (error) {
      // A missing file is a removed source. Other read errors must not approve stale content.
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !String(error).includes("does not exist") &&
        !String(error).includes("exists on disk, but not in")
      )
        throw error;
      return null;
    }
  }
  private async readProject(
    project: PersistedProjectRecord,
    workspaces: PersistedWorkspaceRecord[],
    visited: Set<string>,
    found: Set<string>,
  ): Promise<void> {
    const siblings = workspaces.filter((w) => w.projectId === project.projectId);
    const trusted = siblings.filter((w) => !w.untrustedSource);
    if (siblings.length && !trusted.length) return;
    const root = trusted[0]?.mainRepoRoot ?? trusted[0]?.cwd ?? project.rootPath;
    const facts = await getCheckoutSnapshotFacts(root);
    const projectKey = deriveProjectKey({
      rootPath: root,
      remoteUrl: facts.isGit ? facts.remoteUrl : null,
      worktreeRoot: facts.isGit ? facts.worktreeRoot : null,
      mainRepoRoot: facts.isGit ? facts.mainRepoRoot : null,
    });
    if (visited.has(projectKey)) return;
    visited.add(projectKey);
    const checkout = facts.isGit ? (facts.mainRepoRoot ?? root) : root;
    const text = await this.readSourceFile(root, checkout, facts);
    if (text === null) return;
    await this.remember(projectKey, checkout, text, found);
  }
  private async remember(
    projectKey: string,
    checkout: string,
    text: string,
    found: Set<string>,
  ): Promise<void> {
    const definitions = z
      .record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.record(z.string(), z.unknown()))
      .parse(JSON.parse(text).automations ?? {});
    const local = (this.state[projectKey] ??= { checkout, entries: {} });
    local.checkout = checkout;
    for (const [id, definition] of Object.entries(definitions)) {
      found.add(`${projectKey}#${id}`);
      const fingerprint = hash(definition);
      const previous = Object.hasOwn(local.entries, id) ? local.entries[id] : undefined;
      if (!previous)
        local.entries[id] = { state: "pending", seenFingerprint: fingerprint, definition };
      else if (previous.seenFingerprint !== fingerprint || previous.state === "orphaned") {
        if (previous.scheduleId)
          await this.options.service.pause(previous.scheduleId, "source-changed");
        Object.assign(previous, { state: "pending", seenFingerprint: fingerprint, definition });
      }
    }
  }
  private resolve(id: string): AutomationSource {
    const matches = this.list().filter(
      (s) => s.id === id || `${s.projectKey}#${s.automationId}` === id,
    );
    if (matches.length !== 1) throw new Error("Source ID missing or ambiguous");
    return matches[0];
  }
  private input(source: AutomationSource): CreateScheduleInput {
    const def = DefinitionSchema.parse(source.definition);
    const clocks = def.triggers.filter((t) => t.type !== "event");
    if (clocks.length > 1) throw new Error("Only one clock trigger is allowed");
    const overrides = source.overrides ?? {};
    let target = def.target;
    if (target.type === "action")
      target = { ...target, params: { ...target.params, ...overrides.params } };
    if (target.type === "new-agent")
      target = {
        ...target,
        config: {
          ...target.config,
          cwd: source.checkout,
          ...(overrides.provider ? { provider: overrides.provider } : {}),
          ...(overrides.model ? { model: overrides.model } : {}),
          workspaceId: undefined,
          isolation: "local",
        },
      };
    if (def.delivery && !overrides.delivery)
      throw new Error("Set a local delivery recipient with source set --deliver");
    return {
      ...def,
      target,
      cadence: clocks[0] ?? { type: "none" },
      triggers: def.triggers.filter((t) => t.type === "event"),
      delivery: overrides.delivery,
      runOnCreate: false,
    };
  }
  async request(
    operation: string,
    options: { id?: string; fingerprint?: string; overrides?: AutomationSourceOverrides },
    caller: SourceCaller,
  ): Promise<AutomationSource[]> {
    return this.serial(async () => {
      if (operation === "enable") assertSourceApproval(caller);
      if (operation === "scan" || operation === "enable") await this.readProjects();
      if (operation === "list" || operation === "scan") return this.list();
      const source = this.resolve(options.id ?? "");
      const entry = this.state[source.projectKey].entries[source.automationId];
      if (operation === "enable") {
        if (source.state === "orphaned" || options.fingerprint !== source.seenFingerprint)
          throw new Error("Source fingerprint changed; scan and review before enabling");
        if (source.error) throw new Error(source.error);
        const schedule = await this.options.service.applySource(
          source.scheduleId,
          this.input(source),
          {
            kind: "project",
            projectKey: source.projectKey,
            automationId: source.automationId,
            fingerprint: source.seenFingerprint,
          },
        );
        Object.assign(entry, {
          scheduleId: schedule.id,
          state: "enabled",
          approvedFingerprint: source.seenFingerprint,
          approvedDefinition: source.definition,
        });
      } else if (operation === "disable") {
        if (entry.scheduleId) await this.options.service.pause(entry.scheduleId);
        if (entry.state !== "orphaned") entry.state = "disabled";
      } else if (operation === "set") {
        const patch = AutomationSourceOverridesSchema.parse(options.overrides);
        const overrides = {
          ...entry.overrides,
          ...patch,
          params: { ...entry.overrides?.params, ...patch.params },
        };
        if (entry.state === "enabled")
          await this.options.service.applySource(
            entry.scheduleId,
            this.input({ ...source, overrides }),
            {
              kind: "project",
              projectKey: source.projectKey,
              automationId: source.automationId,
              fingerprint: source.seenFingerprint,
            },
          );
        entry.overrides = overrides;
      } else if (operation === "forget") {
        if (entry.scheduleId) await this.options.service.delete(entry.scheduleId);
        delete this.state[source.projectKey].entries[source.automationId];
      }
      await this.save();
      return operation === "forget" ? [] : [this.resolve(source.id)];
    });
  }
}
