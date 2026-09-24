import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import { scheduleChannelSchema, toScheduleChannelRows, type ScheduleChannelRow } from "./schema.js";
import {
  connectScheduleClient,
  toScheduleCommandError,
  type ScheduleCommandOptions,
} from "./shared.js";

export async function runChannelsCommand(
  options: ScheduleCommandOptions,
  _command: Command,
): Promise<ListResult<ScheduleChannelRow>> {
  const { client } = await connectScheduleClient(options.daemonTarget);
  try {
    const payload = await client.scheduleChannels();
    if (payload.error) {
      throw new Error(payload.error);
    }
    return {
      type: "list",
      data: payload.channels.flatMap(toScheduleChannelRows),
      schema: scheduleChannelSchema,
    };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_CHANNELS_FAILED", "list delivery channels", error);
  } finally {
    await client.close().catch(() => {});
  }
}
