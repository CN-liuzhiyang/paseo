import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { copyPluginExample } from "../support/helpers/plugin-fixture";
import { buildSchedulesRoute } from "../../src/utils/host-routes";

test("creates, edits and pauses an event automation that runs a plugin action", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const plugin = await copyPluginExample("automation-demo");
  const entry = path.join(plugin.directory, "index.server.ts");
  await writeFile(
    entry,
    (await readFile(entry, "utf8"))
      .replace(
        "const emit = server.emit;",
        'const emit = server.emit; server.registerAction({ id: "demo.other", params: z.object({text:z.string()}), run: () => ({}) }); for (const id of ["demo.json-one", "demo.json-two"]) server.registerAction({id, params:z.record(z.string(),z.unknown()), run:()=>({})});',
      )
      .replace(
        "params: z.object({ text: z.string() }),",
        'params: z.object({ text: z.string(), tags: z.array(z.string()).optional(), "a.b": z.string().optional(), dry: z.boolean(), count: z.number().default(7) }).superRefine((p,c) => { if(p.text === "unmapped") for(const path of [["unknown"],["nested"],["tags",0]]) c.addIssue({code:"custom",path,message:JSON.stringify(path)}); }),',
      ),
  );
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
    await page.goto(buildSchedulesRoute());
    await page.getByRole("button", { name: "New automation" }).first().click();
    await page.getByLabel("Automation name").fill(name);
    await page.getByLabel("Prompt").fill("Echo the event.");
    await page.getByTestId("automation-run-trigger").click();
    await page.getByTestId("automation-run-demo.echo").click();
    await page.getByTestId("automation-param-text").fill("stale");
    await page.screenshot({ path: testInfo.outputPath("01-action-before-switch.png") });
    await page.getByTestId("automation-run-trigger").click();
    await page.getByTestId("automation-run-demo.other").click();
    await expect(page.getByTestId("automation-param-text")).toHaveValue("");
    await page.screenshot({ path: testInfo.outputPath("02-action-after-switch.png") });
    await page.getByTestId("automation-run-trigger").click();
    await page.getByTestId("automation-run-demo.json-one").click();
    await page.getByTestId("automation-json-params").fill('{"text":"stale"}');
    await page.getByTestId("automation-run-trigger").click();
    await page.getByTestId("automation-run-demo.json-two").click();
    await expect(page.getByTestId("automation-json-params")).toHaveValue("{}");
    await page.getByTestId("automation-run-trigger").click();
    await page.getByTestId("automation-run-demo.echo").click();
    await page.getByTestId("automation-clock").click();
    await page.getByTestId("automation-trigger-add").click();
    await page.getByTestId("automation-trigger-event-0").click();
    await page.getByTestId("automation-event-demo-ping").click();
    await page.getByTestId("automation-trigger-match-0").fill('{"sender":"alice"}');
    await page.getByTestId("automation-rate-limit").fill("5");

    // The plugin's own params schema rejects the empty form and the error lands on the field.
    await page.getByRole("button", { name: "Create automation" }).click();
    await expect(page.getByText(/expected string/i)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("automation-param-text").fill("unmapped");
    await page.getByRole("button", { name: "Create automation" }).click();
    for (const issue of ['unknown: ["unknown"]', 'nested: ["nested"]', 'tags.0: ["tags",0]'])
      await expect(page.getByText(issue, { exact: true })).toBeVisible();
    await page.getByTestId("automation-param-text").fill("hi");
    await page.getByRole("button", { name: "Create automation" }).click();
    await expect(page.getByTestId("schedule-form-sheet")).toHaveCount(0, { timeout: 15_000 });

    const created = await find();
    expect(created?.target).toEqual({
      type: "action",
      action: "demo.echo",
      params: { text: "hi", dry: false, count: 7 },
    });
    expect(created).toMatchObject({
      cadence: { type: "none" },
      target: { type: "action", action: "demo.echo", params: { text: "hi" } },
      triggers: [{ type: "event", source: "demo", event: "ping", match: { sender: "alice" } }],
      eventRateLimit: 5,
    });
    const row = page.getByTestId(`schedule-row-${created!.id}`);
    await expect(row).toContainText(name);
    await expect(row).toContainText("demo:ping");

    const retainedTriggers = [
      {
        type: "event" as const,
        source: "demo",
        event: "ping",
        maxAgeMs: 5000,
        match: { code: "001", flag: "false", comma: "a,b", space: "  x  ", equal: "a=b" },
      },
    ];
    await client.scheduleUpdate({
      id: created!.id,
      triggers: retainedTriggers,
      actionConfig: {
        action: "demo.echo",
        params: { text: "hi", dry: false, count: 7, tags: ["a,b", " c "], "a.b": "original" },
      },
    });
    await page.reload();
    await page.getByTestId(`schedule-row-${created!.id}`).click();
    await expect(page.getByTestId("automation-param-a.b")).toHaveValue("original");
    await expect(page.getByRole("textbox", { name: "tags", exact: true })).toHaveValue(
      JSON.stringify(["a,b", " c "], null, 2),
    );
    await page.getByTestId("automation-trigger-match-0").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("automation-trigger-match-0")).toHaveValue(
      JSON.stringify(retainedTriggers[0].match),
    );
    await page.screenshot({ path: testInfo.outputPath("03-existing-trigger-before-save.png") });
    await page.getByTestId("automation-param-a.b").fill("new");
    await page.getByRole("textbox", { name: "tags", exact: true }).fill('["a,b"," c ","new"]');
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("schedule-form-sheet")).toHaveCount(0);
    const stored = JSON.parse(
      await readFile(
        path.join(process.env.E2E_PASEO_HOME!, "schedules", `${created!.id}.json`),
        "utf8",
      ),
    );
    expect(stored.triggers).toEqual(retainedTriggers);
    expect(stored.target.params).toEqual({
      text: "hi",
      dry: false,
      count: 7,
      tags: ["a,b", " c ", "new"],
      "a.b": "new",
    });
    await page.screenshot({ path: testInfo.outputPath("04-existing-trigger-saved.png") });
    await row.click();
    await page.getByTestId("automation-trigger-match-0").fill('{"sender":"bob"}');
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("schedule-form-sheet")).toHaveCount(0, { timeout: 15_000 });
    await expect
      .poll(async () => (await find())?.triggers)
      .toEqual([
        { type: "event", source: "demo", event: "ping", match: { sender: "bob" }, maxAgeMs: 5000 },
      ]);

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
