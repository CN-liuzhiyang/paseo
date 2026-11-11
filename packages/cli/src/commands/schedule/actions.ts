import type { Command } from "commander";
import type { ListResult, OutputSchema } from "../../output/index.js";
import type { ScheduleAction } from "@getpaseo/protocol/schedule/types";
import {
  connectScheduleClient,
  requireAutomationsSupport,
  type ScheduleCommandOptions,
} from "./shared.js";

const schema: OutputSchema<ScheduleAction> = {
  idField: "id",
  columns: [
    { header: "ACTION", field: "id", width: 24 },
    { header: "PLUGIN", field: "pluginId", width: 24 },
    { header: "LABEL", field: "label", width: 24 },
    { header: "PARAMETERS", field: (action) => JSON.stringify(action.params), width: 60 },
  ],
};

export async function runActionsCommand(
  options: ScheduleCommandOptions,
  _command: Command,
): Promise<ListResult<ScheduleAction>> {
  const { client } = await connectScheduleClient(options.daemonTarget);
  try {
    requireAutomationsSupport(client);
    if (!client.scheduleActions) throw new Error("Host does not provide action discovery");
    const payload = await client.scheduleActions();
    if (payload.error) throw new Error(payload.error);
    return { type: "list", data: payload.actions, schema };
  } finally {
    await client.close();
  }
}
