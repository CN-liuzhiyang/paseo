import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { openCommandCenter } from "../support/helpers/command-center";
import { gotoWorkspace } from "../support/helpers/launcher";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { seedWorkspace } from "../support/helpers/seed-client";

const PLUGIN_ID = "open-commit-diff-e2e";
const COMMIT_SUBJECT = "Add feature from plugin";

function pluginClientSource(sha: string): string {
  return `import React from "react";
import { Pressable, Text, View } from "react-native";

function CommitPanel({ workspaceId, navigation }) {
  const openCommitDiff = navigation?.openCommitDiff;
  return <View>
    <Text>{openCommitDiff ? "Plugin can open commit diffs" : "Plugin cannot open commit diffs"}</Text>
    {openCommitDiff ? <Pressable accessibilityRole="button" onPress={() => openCommitDiff({ workspaceId, sha: ${JSON.stringify(sha)} })}><Text>Open commit from plugin</Text></Pressable> : null}
  </View>;
}

export default function contribute(client) {
  client.addWorkspacePanel({ id: "commit", title: "Commit panel", icon: "History", context: "workspace", Component: CommitPanel });
  client.addCommandCenterItem({ id: "open-commit-panel", title: "Open plugin commit panel", icon: "History", context: "workspace", onSelect({ openPanel }) { openPanel("commit"); } });
  return () => {};
}`;
}

function commitFeatureFile(repoPath: string): string {
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("node", ["-e", "require('fs').writeFileSync('feature.txt', 'before\\nafter\\n')"], {
    cwd: repoPath,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "feature.txt"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", COMMIT_SUBJECT], { cwd: repoPath, stdio: "ignore" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" }).trim();
}

async function runCommand(page: Page, title: string): Promise<void> {
  const panel = await openCommandCenter(page);
  await panel.getByTestId("command-center-input").fill(title);
  await panel.getByRole("button", { name: title, exact: true }).click();
  await expect(panel).not.toBeVisible();
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot });
  await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}

test.describe("plugin navigation.openCommitDiff", () => {
  test.describe.configure({ timeout: 180_000 });

  test("opens the commit diff tab for a sha in the focused pane", async ({ page }, testInfo) => {
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

      await runCommand(page, "Open plugin commit panel");
      await expect(page.getByText("Plugin can open commit diffs", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Open commit from plugin", exact: true }).click();

      const tab = page.getByTestId(`workspace-tab-commit_diff_${sha}`).filter({ visible: true });
      await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
      const panel = page.getByTestId("commit-diff-panel").filter({ visible: true });
      await expect(panel.getByTestId("commit-diff-toolbar")).toBeVisible({ timeout: 30_000 });
      await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("feature.txt, +2, -0");
      await capture(page, testInfo, "plugin-open-commit-diff");
    } finally {
      await client.removePlugin(PLUGIN_ID);
      await client.patchDaemonConfig({
        pluginsEnabled: previousConfig.config.pluginsEnabled ?? false,
      });
      await client.close();
      await workspace.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
