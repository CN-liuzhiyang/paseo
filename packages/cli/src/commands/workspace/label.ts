import type { Command } from "commander";
import {
  WORKSPACE_LABEL_COLORS,
  normalizeWorkspaceLabelName,
  workspaceLabelKey,
  type WorkspaceLabelColor,
  type WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import {
  toCommandError,
  type CommandError,
  type OutputSchema,
  type SingleResult,
} from "../../output/index.js";
import type { DaemonTarget } from "../../utils/daemon-target.js";

interface LabelResult {
  workspaceId: string;
  labels: string[];
}
const schema: OutputSchema<LabelResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "LABELS", field: (row) => row.labels.join(", "), width: 30 },
  ],
};

export function resolveLabel(
  nameInput: string,
  colorInput?: string,
): { name: string; color?: WorkspaceLabelColor } {
  const name = normalizeWorkspaceLabelName(nameInput);
  if (!name)
    throw {
      code: "LABEL_NAME_EMPTY",
      message: "Label name cannot be empty",
    } satisfies CommandError;
  if (colorInput !== undefined && !WORKSPACE_LABEL_COLORS.some((color) => color === colorInput)) {
    throw {
      code: "INVALID_COLOR",
      message: `Invalid label color: ${colorInput}. Choose: ${WORKSPACE_LABEL_COLORS.join(", ")}`,
    } satisfies CommandError;
  }
  return { name, color: colorInput as WorkspaceLabelColor | undefined };
}

export async function assignWorkspaceLabel(
  client: {
    listWorkspaceLabels(): Promise<{ labels: WorkspaceLabelDefinition[] }>;
    setWorkspaceLabel(input: {
      workspaceId: string;
      label: WorkspaceLabelDefinition;
      assigned: boolean;
    }): Promise<{ workspaceLabels: string[] }>;
  },
  workspaceId: string,
  label: { name: string; color?: WorkspaceLabelColor },
  remove: boolean,
): Promise<LabelResult> {
  const color =
    label.color ??
    (await client.listWorkspaceLabels()).labels.find(
      (item) => workspaceLabelKey(item.name) === workspaceLabelKey(label.name),
    )?.color ??
    "violet";
  const result = await client.setWorkspaceLabel({
    workspaceId,
    label: { name: label.name, color },
    assigned: !remove,
  });
  return { workspaceId, labels: result.workspaceLabels };
}

export async function runLabelCommand(
  workspaceId: string,
  name: string,
  options: { color?: string; remove?: boolean; daemonTarget: DaemonTarget },
  command: Command,
): Promise<SingleResult<LabelResult>> {
  const label = resolveLabel(name, command.opts().color as string | undefined);
  const host = getDaemonHost({ target: options.daemonTarget });
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies CommandError;
  });
  try {
    const data = await assignWorkspaceLabel(client, workspaceId, label, options.remove === true);
    return { type: "single", data, schema };
  } catch (error) {
    const message = toCommandError(error).message;
    throw {
      code: "WORKSPACE_LABEL_FAILED",
      message: message.replace(/\s*[\r\n]+\s*/g, " "),
    } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
