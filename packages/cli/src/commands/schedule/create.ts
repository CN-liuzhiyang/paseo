import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import { scheduleSchema } from "./schema.js";
import {
  connectScheduleClient,
  requireAutomationsSupport,
  usesAutomationFlags,
  type AutomationFlags,
  parseScheduleCreateInput,
  requireScheduleWorkspaceSupport,
  toScheduleCommandError,
  toScheduleRow,
  type ScheduleCommandOptions,
  type ScheduleRow,
} from "./shared.js";

export interface ScheduleCreateOptions extends ScheduleCommandOptions, AutomationFlags {
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string;
  target?: string;
  provider?: string;
  mode?: string;
  thinking?: string;
  cwd?: string;
  workspace?: string;
  maxRuns?: string;
  expiresIn?: string;
  runNow?: boolean;
  deliver?: string;
}

export async function runCreateCommand(
  prompt: string,
  options: ScheduleCreateOptions,
  command: Command,
): Promise<SingleResult<ScheduleRow>> {
  const runNowSource = command.getOptionValueSource("runNow");
  const runNow = runNowSource === "cli" ? Boolean(options.runNow) : undefined;
  const input = parseScheduleCreateInput({
    ...options,
    prompt,
    every: options.every,
    cron: options.cron,
    timezone: options.timezone,
    name: options.name,
    target: options.target,
    provider: options.provider,
    mode: options.mode,
    thinking: options.thinking,
    cwd: options.cwd,
    workspace: options.workspace,
    daemonTarget: options.daemonTarget,
    maxRuns: options.maxRuns,
    expiresIn: options.expiresIn,
    runNow,
    deliver: options.deliver,
  });
  const { client } = await connectScheduleClient(options.daemonTarget);
  try {
    if (usesAutomationFlags(options)) requireAutomationsSupport(client);
    if (options.workspace !== undefined) {
      requireScheduleWorkspaceSupport(client);
    }
    const payload = await client.scheduleCreate(input);
    if (payload.error || !payload.schedule) {
      throw new Error(payload.error ?? "Schedule creation failed");
    }
    return {
      type: "single",
      data: toScheduleRow(payload.schedule),
      schema: scheduleSchema,
    };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_CREATE_FAILED", "create schedule", error);
  } finally {
    await client.close().catch(() => {});
  }
}
