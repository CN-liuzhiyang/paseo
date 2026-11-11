import type { ScheduleDaemonClient, UpdateScheduleInput } from "./types.js";
import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  createScheduleInspectRows,
  createScheduleInspectSchema,
  type ScheduleInspectRow,
} from "./schema.js";
import {
  connectScheduleClient,
  requireAutomationsSupport,
  usesAutomationFlags,
  parseActionTarget,
  type AutomationFlags,
  parseScheduleUpdateInput,
  requireNewAgentSchedule,
  requireScheduleWorkspaceSupport,
  toScheduleCommandError,
  type ScheduleCommandOptions,
} from "./shared.js";

export interface ScheduleUpdateOptions extends ScheduleCommandOptions, AutomationFlags {
  clearOn?: boolean;
  clock?: boolean;
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  mode?: string;
  cwd?: string;
  workspace?: string | false;
  maxRuns?: string | false;
  expiresIn?: string | false;
  /** Commander sets this to false for --no-deliver. */
  deliver?: string | false;
}

export async function runUpdateCommand(
  id: string,
  options: ScheduleUpdateOptions,
  _command: Command,
): Promise<ListResult<ScheduleInspectRow>> {
  const input = parseScheduleUpdateInput({
    ...options,
    id,
    every: options.every,
    cron: options.cron,
    timezone: options.timezone,
    name: options.name,
    prompt: options.prompt,
    provider: options.provider,
    model: options.model,
    mode: options.mode,
    cwd: options.cwd,
    workspace: options.workspace === false ? undefined : options.workspace,
    clearWorkspace: options.workspace === false,
    maxRuns: options.maxRuns === false ? undefined : options.maxRuns,
    expiresIn: options.expiresIn === false ? undefined : options.expiresIn,
    clearMaxRuns: options.maxRuns === false,
    clearExpires: options.expiresIn === false,
    deliver: options.deliver,
  });
  const { client } = await connectScheduleClient(options.daemonTarget);
  try {
    if (usesAutomationFlags(options) || options.clearOn || options.clock === false)
      requireAutomationsSupport(client);
    if (options.workspace !== undefined) {
      requireScheduleWorkspaceSupport(client);
    }
    if (input.newAgentConfig) await requireNewAgentSchedule(client, id);
    await applyActionParams(client, id, options, input);
    const payload = await client.scheduleUpdate(input);
    if (payload.error || !payload.schedule) {
      throw new Error(payload.error ?? `Failed to update schedule: ${id}`);
    }
    return {
      type: "list",
      data: createScheduleInspectRows(payload.schedule),
      schema: createScheduleInspectSchema(payload.schedule),
    };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_UPDATE_FAILED", "update schedule", error);
  } finally {
    await client.close().catch(() => {});
  }
}

async function applyActionParams(
  client: ScheduleDaemonClient,
  id: string,
  options: ScheduleUpdateOptions,
  input: UpdateScheduleInput,
): Promise<void> {
  if (
    options.param !== undefined ||
    options.paramsJson !== undefined ||
    options.timeout !== undefined
  ) {
    const current = await client.scheduleInspect({ id });
    if (!current.schedule || current.schedule.target.type !== "action")
      throw new Error("Action parameters require an action target");
    const previous = current.schedule.target;
    input.actionTarget = {
      ...previous,
      ...parseActionTarget({ ...options, action: options.action ?? previous.action }),
      ...(options.param === undefined && options.paramsJson === undefined
        ? { params: previous.params }
        : {}),
    };
  }
}
