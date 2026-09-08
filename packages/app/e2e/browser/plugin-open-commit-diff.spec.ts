import { test } from "../support/fixtures";
import {
  expectSelectedCommitDiff,
  openCommitFromPluginPanel,
  withCommitDiffPlugin,
} from "../support/helpers/plugin-commit-diff";

test.describe.configure({ timeout: 180_000 });

test("a plugin panel opens Paseo's commit diff for a sha", async ({ page }) => {
  await withCommitDiffPlugin(page, async ({ sha }) => {
    await openCommitFromPluginPanel(page);
    await expectSelectedCommitDiff(page, { sha, file: "feature.txt, +2, -0" });
  });
});
