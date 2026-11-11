import { Command } from "commander";
import { withOutput, type ListResult, type OutputSchema } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { resolveProviderAndModel } from "../../utils/provider-model.js";
import {
  connectScheduleClient,
  parseDeliverFlag,
  parseParams,
  type ScheduleCommandOptions,
} from "./shared.js";
import type { ScheduleDaemonClient } from "./types.js";
import type { AutomationSource } from "@getpaseo/protocol/schedule/types";

const schema: OutputSchema<AutomationSource> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 8 },
    { header: "AUTOMATION", field: "automationId", width: 24 },
    { header: "STATE", field: "state", width: 10 },
    { header: "FINGERPRINT", field: "seenFingerprint", width: 64 },
    { header: "ERROR", field: "error", width: 40 },
  ],
};
export function requireSourcesSupport(
  client: Pick<ScheduleDaemonClient, "getLastServerInfoMessage" | "scheduleSources">,
) {
  if (
    client.getLastServerInfoMessage()?.features?.automationSources !== true ||
    !client.scheduleSources
  )
    throw new Error("This host does not support automation sources. Update the host.");
  return client.scheduleSources.bind(client);
}
export function createSourceCommand(): Command {
  const source = new Command("source").description("Review and approve project automation sources");
  for (const op of ["ls", "scan", "show", "enable", "disable", "set", "forget"] as const) {
    const command = source.command(op);
    if (op !== "ls" && op !== "scan") command.argument("<id>");
    if (op === "enable") command.requiredOption("--fingerprint <sha256>");
    if (op === "set")
      command
        .option("--deliver <channel:to>")
        .option("--provider <provider/model>")
        .option(
          "--param <k=v>",
          "Local action parameter",
          (value: string, previous: string[] = []) => [...previous, value],
        );
    addJsonAndDaemonHostOptions(command).action(
      withOutput(async (...args: unknown[]): Promise<ListResult<AutomationSource>> => {
        const hasId = op !== "ls" && op !== "scan";
        const id = hasId ? (args[0] as string) : undefined;
        const options = args[hasId ? 1 : 0] as ScheduleCommandOptions & {
          fingerprint?: string;
          deliver?: string;
          provider?: string;
          param?: string[];
        };
        const { client } = await connectScheduleClient(options.daemonTarget);
        try {
          const request = requireSourcesSupport(client);
          const overrides =
            op === "set"
              ? {
                  ...(options.deliver ? { delivery: parseDeliverFlag(options.deliver) } : {}),
                  ...(options.provider
                    ? resolveProviderAndModel({ provider: options.provider })
                    : {}),
                  ...(options.param ? { params: parseParams(options) } : {}),
                }
              : undefined;
          const result = await request(op === "ls" ? "list" : op, {
            id,
            fingerprint: options.fingerprint,
            overrides,
          });
          if (result.error) throw new Error(result.error);
          const columns =
            op === "show"
              ? [
                  ...schema.columns,
                  {
                    header: "CHANGED FIELDS",
                    field: (item: AutomationSource) =>
                      Object.keys({ ...item.approvedDefinition, ...item.definition })
                        .filter(
                          (key) =>
                            JSON.stringify(item.approvedDefinition?.[key]) !==
                            JSON.stringify(item.definition[key]),
                        )
                        .join(", "),
                    width: 40,
                  },
                  { header: "APPROVED", field: "approvedFingerprint" as const, width: 64 },
                  {
                    header: "CURRENT DEFINITION",
                    field: (s: AutomationSource) => JSON.stringify(s.definition),
                    width: 100,
                  },
                  {
                    header: "APPROVED DEFINITION",
                    field: (s: AutomationSource) => JSON.stringify(s.approvedDefinition),
                    width: 100,
                  },
                  {
                    header: "OVERRIDES",
                    field: (s: AutomationSource) => JSON.stringify(s.overrides),
                    width: 80,
                  },
                ]
              : schema.columns;
          return { type: "list", data: result.sources, schema: { ...schema, columns } };
        } finally {
          await client.close();
        }
      }),
    );
  }
  return source;
}
