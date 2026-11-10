import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { assignWorkspaceLabel, resolveLabel } from "./label.js";
import { createWorkspaceCommand } from "./index.js";
import { toWorkspaceRow } from "./shared.js";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";

function catchError(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

describe("workspace labels", () => {
  it("validates and normalizes inputs", () => {
    expect(resolveLabel("  A   B ", "sky")).toEqual({ name: "A B", color: "sky" });
    expect(catchError(() => resolveLabel("   "))).toMatchObject({ code: "LABEL_NAME_EMPTY" });
    expect(catchError(() => resolveLabel("x", "purple"))).toMatchObject({ code: "INVALID_COLOR" });
  });

  it("uses the catalog color for a matching name and violet for a new one", async () => {
    const requests: unknown[] = [];
    const client = {
      listWorkspaceLabels: async () => ({ labels: [{ name: "My Label", color: "sky" as const }] }),
      setWorkspaceLabel: async (input: {
        workspaceId: string;
        label: { name: string; color: string };
        assigned: boolean;
      }) => {
        requests.push(input);
        return { workspaceLabels: ["My Label"] };
      },
    };
    expect(await assignWorkspaceLabel(client, "ws", resolveLabel(" my  label "), false)).toEqual({
      workspaceId: "ws",
      labels: ["My Label"],
    });
    await assignWorkspaceLabel(client, "ws", resolveLabel("new"), true);
    await assignWorkspaceLabel(client, "ws", resolveLabel("new", "red"), false);
    expect(requests).toEqual([
      { workspaceId: "ws", label: { name: "my label", color: "sky" }, assigned: true },
      { workspaceId: "ws", label: { name: "new", color: "violet" }, assigned: false },
      { workspaceId: "ws", label: { name: "new", color: "red" }, assigned: true },
    ]);
  });

  it("includes labels in workspace rows, including an empty array", () => {
    const workspace = {
      id: "ws",
      projectDisplayName: "p",
      name: "n",
      workspaceKind: "directory",
      workspaceDirectory: "/tmp",
    } as WorkspaceDescriptorPayload;
    expect(toWorkspaceRow(workspace).labels).toEqual([]);
    expect(toWorkspaceRow({ ...workspace, labels: ["one"] }).labels).toEqual(["one"]);
  });

  it("rejects extra positional arguments", () => {
    const workspace = createWorkspaceCommand()
      .exitOverride()
      .configureOutput({ writeErr: () => undefined });
    workspace.commands.find((command) => command.name() === "label")?.exitOverride();
    expect(
      catchError(() => workspace.parse(["label", "ws", "one", "two"], { from: "user" })),
    ).toMatchObject({ code: "commander.excessArguments" });
  });

  it("keeps the global terminal color default separate from the label color", async () => {
    const program = new Command().option("--no-color");
    const workspace = createWorkspaceCommand();
    program.addCommand(workspace);
    const label = workspace.commands.find((command) => command.name() === "label")!;
    const colors: unknown[] = [];
    label.action((_id, _name, _options, command: Command) => colors.push(command.opts().color));
    await program.parseAsync(["workspace", "label", "ws", "name"], { from: "user" });
    expect(colors).toEqual([undefined]);
    await program.parseAsync(["workspace", "label", "ws", "name", "--color", "sky"], {
      from: "user",
    });
    expect(colors).toEqual([undefined, "sky"]);
  });
});
