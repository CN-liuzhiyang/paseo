import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { copyPluginExample } from "../support/helpers/plugin-fixture";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { buildSchedulesRoute } from "../../src/utils/host-routes";

test("creates, edits and pauses an event automation that runs a plugin action", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const plugin = await copyPluginExample("automation-demo");
  const client = (await connectNewWorkspaceDaemonClient({
    ownProjects: false,
  })) as unknown as DaemonClient;
  const previous = await client.getDaemonConfig();
  const name = `Event echo ${Date.now()}`;
  const find = async () => (await client.scheduleList()).schedules.find((s) => s.name === name);
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(plugin.directory);
    await expect
      .poll(async () => (await client.scheduleActions()).actions.map((action) => action.id))
      .toContain("demo.echo");

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await page.goto(buildSchedulesRoute());
    await page.getByRole("button", { name: "New automation" }).first().click();
    await page.getByLabel("Automation name").fill(name);
    await page.getByLabel("Prompt").fill("Echo the event.");
    await page.getByTestId("automation-run-trigger").click();
    await page.getByTestId("automation-run-demo.echo").click();
    await page.getByTestId("automation-clock-none").click();
    await page.getByTestId("automation-trigger-add").click();
    await page.getByTestId("automation-trigger-event-0").click();
    await page.getByTestId("automation-event-demo-ping").click();
    await page.getByTestId("automation-trigger-match-0").fill("sender=alice");
    await page.getByTestId("automation-rate-limit").fill("5");

    // The plugin's own params schema rejects the empty form and the error lands on the field.
    await page.getByRole("button", { name: "Create automation" }).click();
    await expect(page.getByText(/expected string/i)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("automation-param-text").fill("hi");
    await page.getByRole("button", { name: "Create automation" }).click();
    await expect(page.getByTestId("schedule-form-sheet")).toHaveCount(0, { timeout: 15_000 });

    const created = await find();
    expect(created).toMatchObject({
      cadence: { type: "none" },
      target: { type: "action", action: "demo.echo", params: { text: "hi" } },
      triggers: [{ type: "event", source: "demo", event: "ping", match: { sender: "alice" } }],
      eventRateLimit: 5,
    });
    const row = page.getByTestId(`schedule-row-${created!.id}`);
    await expect(row).toContainText(name);
    await expect(row).toContainText("demo:ping");

    await row.click();
    await page.getByTestId("automation-trigger-match-0").fill("sender=bob");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("schedule-form-sheet")).toHaveCount(0, { timeout: 15_000 });
    await expect
      .poll(async () => (await find())?.triggers)
      .toEqual([{ type: "event", source: "demo", event: "ping", match: { sender: "bob" } }]);

    await page.getByTestId(`schedule-kebab-${created!.id}`).click();
    await page.getByTestId(`schedule-menu-pause-${created!.id}`).click();
    await expect.poll(async () => (await find())?.status).toBe("paused");
  } finally {
    const created = await find().catch(() => undefined);
    if (created) await client.scheduleDelete({ id: created.id }).catch(() => undefined);
    await client.removePlugin("automation-demo").catch(() => undefined);
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close();
    await plugin.cleanup();
  }
});
