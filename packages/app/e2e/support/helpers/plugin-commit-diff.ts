import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { openCommandCenter } from "./command-center";
import { gotoWorkspace } from "./launcher";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { pluginRequirements } from "./plugin-fixture";
import { seedWorkspace } from "./seed-client";

const PLUGIN_ID = "open-commit-diff-e2e";
const OPEN_PANEL_COMMAND = "Open plugin commit panel";
const OPEN_COMMIT_BUTTON = "Open commit from plugin";
export const COMMIT_SUBJECT = "Add feature from plugin";

/** A workspace panel that forwards one row press to `navigation.openCommitDiff`. */
function pluginClientSource(sha: string): string {
  return `import React from "react";
import { Pressable, Text, View } from "react-native";

function CommitPanel({ workspaceId, navigation }) {
  const openCommitDiff = navigation?.openCommitDiff;
  return <View>
    <Text>{openCommitDiff ? "Plugin can open commit diffs" : "Plugin cannot open commit diffs"}</Text>
    {openCommitDiff ? <Pressable accessibilityRole="button" onPress={() => openCommitDiff({ workspaceId, sha: ${JSON.stringify(sha)} })}><Text>${OPEN_COMMIT_BUTTON}</Text></Pressable> : null}
  </View>;
}

export default function contribute(client) {
  client.addWorkspacePanel({ id: "commit", title: "Commit panel", icon: "History", context: "workspace", Component: CommitPanel });
  client.addCommandCenterItem({ id: "open-commit-panel", title: ${JSON.stringify(OPEN_PANEL_COMMAND)}, icon: "History", context: "workspace", onSelect({ openPanel }) { openPanel("commit"); } });
  return () => {};
}`;
}

/** Commits a two-line file on a new branch and returns its sha. */
function commitFeatureFile(repoPath: string): string {
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
  git(["checkout", "-b", "feature"]);
  execFileSync("node", ["-e", "require('fs').writeFileSync('feature.txt', 'before\\nafter\\n')"], {
    cwd: repoPath,
    stdio: "ignore",
  });
  git(["add", "feature.txt"]);
  git(["commit", "-m", COMMIT_SUBJECT]);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" }).trim();
}

export interface CommitDiffPluginWorkspace {
  workspaceId: string;
  /** The sha the contributed panel opens. */
  sha: string;
}

/**
 * Seeds a workspace with one commit, installs a plugin whose panel opens that
 * commit, and navigates to the workspace. Every teardown step runs even when an
 * earlier one rejects: browser specs share a daemon, so a half-restored
 * `pluginsEnabled` or a leaked project contaminates later tests.
 */
export async function withCommitDiffPlugin(
  page: Page,
  run: (workspace: CommitDiffPluginWorkspace) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-open-commit-diff-e2e-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  const workspace = await seedWorkspace({ repoPrefix: "plugin-open-commit-diff-" });
  const sha = commitFeatureFile(workspace.repoPath);
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
  );
  await writeFile(path.join(directory, "index.client.tsx"), pluginClientSource(sha));

  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await run({ workspaceId: workspace.workspaceId, sha });
  } finally {
    const restore: Array<() => Promise<unknown>> = [
      () => client.removePlugin(PLUGIN_ID),
      () =>
        client.patchDaemonConfig({
          pluginsEnabled: previousConfig.config.pluginsEnabled ?? false,
        }),
      () => client.close(),
      () => workspace.cleanup(),
      () => rm(directory, { recursive: true, force: true }),
    ];
    for (const step of restore) {
      await step().catch(() => undefined);
    }
  }
}

/** Opens the contributed panel and presses its commit row. */
export async function openCommitFromPluginPanel(page: Page): Promise<void> {
  const commandCenter = await openCommandCenter(page);
  await commandCenter.getByTestId("command-center-input").fill(OPEN_PANEL_COMMAND);
  await commandCenter.getByRole("button", { name: OPEN_PANEL_COMMAND, exact: true }).click();
  await expect(commandCenter).not.toBeVisible();
  await expect(page.getByText("Plugin can open commit diffs", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: OPEN_COMMIT_BUTTON, exact: true }).click();
}

/** Asserts the focused pane shows Paseo's commit diff tab for `sha`. */
export async function expectSelectedCommitDiff(
  page: Page,
  input: { sha: string; file: string },
): Promise<void> {
  const tab = page.getByTestId(`workspace-tab-commit_diff_${input.sha}`).filter({ visible: true });
  await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
  const panel = page.getByTestId("commit-diff-panel").filter({ visible: true });
  await expect(panel.getByTestId("commit-diff-toolbar")).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName(input.file);
}
