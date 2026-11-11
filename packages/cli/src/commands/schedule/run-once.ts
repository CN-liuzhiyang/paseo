import type { Command } from "commander";
import { TriggerEventSchema } from "@getpaseo/protocol/schedule/types";
import type { SingleResult } from "../../output/index.js";
import { scheduleSchema } from "./schema.js";
import {
  connectScheduleClient,
  requireVisibleSchedule,
  requireAutomationsSupport,
  toScheduleCommandError,
  toScheduleRow,
  type ScheduleCommandOptions,
  type ScheduleRow,
} from "./shared.js";

export async function runRunOnceCommand(
  id: string,
  options: ScheduleCommandOptions & { eventJson?: string },
  _command: Command,
): Promise<SingleResult<ScheduleRow>> {
  const { client } = await connectScheduleClient(options.daemonTarget);
  try {
    if (options.eventJson !== undefined) requireAutomationsSupport(client);
    await requireVisibleSchedule(client, id);
    const event =
      options.eventJson === undefined
        ? undefined
        : TriggerEventSchema.parse(JSON.parse(options.eventJson));
    const payload = await client.scheduleRunOnce({ id, ...(event ? { event } : {}) });
    if (payload.error || !payload.schedule) {
      throw new Error(payload.error ?? `Failed to run schedule once: ${id}`);
    }
    return {
      type: "single",
      data: toScheduleRow(payload.schedule),
      schema: scheduleSchema,
    };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_RUN_ONCE_FAILED", "run schedule once", error);
  } finally {
    await client.close().catch(() => {});
  }
}
