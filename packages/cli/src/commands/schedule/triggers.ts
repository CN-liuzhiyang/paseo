import type { Command } from "commander";
import type { ListResult, OutputSchema } from "../../output/index.js";
import type { ScheduleTriggerSource } from "@getpaseo/protocol/schedule/types";
import {
  connectScheduleClient,
  requireAutomationsSupport,
  type ScheduleCommandOptions,
} from "./shared.js";

const schema: OutputSchema<ScheduleTriggerSource> = {
  idField: "id",
  columns: [
    { header: "SOURCE", field: "id", width: 24 },
    { header: "PLUGIN", field: "pluginId", width: 24 },
    { header: "EVENTS", field: (source) => JSON.stringify(source.events), width: 70 },
  ],
};

export async function runTriggersCommand(
  options: ScheduleCommandOptions,
  _command: Command,
): Promise<ListResult<ScheduleTriggerSource>> {
  const { client } = await connectScheduleClient(options.daemonTarget);
  try {
    requireAutomationsSupport(client);
    if (!client.scheduleTriggers) throw new Error("Host does not provide trigger discovery");
    const payload = await client.scheduleTriggers();
    if (payload.error) throw new Error(payload.error);
    return { type: "list", data: payload.triggers, schema };
  } finally {
    await client.close();
  }
}
