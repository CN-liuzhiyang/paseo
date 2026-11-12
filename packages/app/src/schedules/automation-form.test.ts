import { expect, test } from "vitest";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import {
  buildAutomationSubmit,
  initAutomationForm,
  objectFields,
  parseActionIssues,
  reduceAutomationForm,
  type AutomationFormAction,
} from "./automation-form";

const cron = { type: "cron" as const, expression: "0 9 * * *", timezone: "UTC" };
const actionSchedule = {
  cadence: { type: "none" },
  target: { type: "action", action: "demo.echo", params: { text: "hi" } },
  triggers: [{ type: "event", source: "demo", event: "ping", match: { sender: "alice" } }],
  eventRateLimit: 5,
} as unknown as ScheduleSummary;

function submit(actions: AutomationFormAction[], schedule?: ScheduleSummary) {
  const initial = initAutomationForm(schedule);
  const state = actions.reduce(reduceAutomationForm, initial);
  return buildAutomationSubmit({ state, initial, cronCadence: undefined, currentCron: cron });
}

test("an edited action automation round-trips its clock, triggers, params and limit", () => {
  expect(submit([], actionSchedule)).toEqual({
    cadence: { type: "none" },
    triggers: [{ type: "event", source: "demo", event: "ping", match: { sender: "alice" } }],
    target: { type: "action", action: "demo.echo", params: { text: "hi" } },
    eventRateLimit: 5,
  });
});

test("trigger edits parse match values and keep untouched cron cadences out of the update", () => {
  const result = submit([
    { type: "addTrigger" },
    { type: "trigger", index: 0, patch: { id: "demo:ping", match: "n=3, ok=true, who=bob" } },
    { type: "addTrigger" },
    { type: "removeTrigger", index: 1 },
  ]);
  expect(result.cadence).toBeUndefined();
  expect(result.triggers).toEqual([
    { type: "event", source: "demo", event: "ping", match: { n: 3, ok: true, who: "bob" } },
  ]);
  expect(result.target).toBeNull();
  expect(result.eventRateLimit).toBeNull();
});

test("switching the clock sends the chosen cadence", () => {
  expect(submit([{ type: "clock", clock: "none" }]).cadence).toEqual({ type: "none" });
  expect(submit([{ type: "clock", clock: "cron" }], actionSchedule).cadence).toEqual(cron);
});

test("invalid input is reported instead of submitted", () => {
  expect(() => submit([{ type: "addTrigger" }])).toThrow();
  const pair = { type: "trigger", index: 0, patch: { id: "demo:ping", match: "nope" } } as const;
  expect(() => submit([{ type: "addTrigger" }, pair])).toThrow();
  expect(() => submit([{ type: "rateLimit", text: "0" }])).toThrow();
  const json = { type: "json", path: "input", text: "{" } as const;
  expect(() => submit([{ type: "run", run: "flow.run" }, json])).toThrow();
});

test("action params merge form values with parsed JSON fields", () => {
  const result = submit([
    { type: "run", run: "flow.run" },
    { type: "param", path: ["flow"], value: "sync" },
    { type: "param", path: ["opts", "dry"], value: true },
    { type: "json", path: "input", text: '{"mode":"fast"}' },
  ]);
  expect(result.target).toEqual({
    type: "action",
    action: "flow.run",
    params: { flow: "sync", opts: { dry: true }, input: { mode: "fast" } },
  });
});

test("JSON Schema maps the supported subset and falls back to JSON for the rest", () => {
  const fields = objectFields({
    type: "object",
    required: ["flow"],
    properties: {
      flow: { type: "string" },
      count: { type: "integer" },
      dry: { type: "boolean" },
      mode: { type: "string", enum: ["a", "b"] },
      tags: { type: "array", items: { type: "string" } },
      nested: { type: "object", properties: { x: { type: "number" } } },
      input: { type: "object", additionalProperties: {} },
    },
  });
  expect(fields?.map((field) => [field.key, field.kind, field.required])).toEqual([
    ["flow", "string", true],
    ["count", "number", false],
    ["dry", "boolean", false],
    ["mode", "enum", false],
    ["tags", "strings", false],
    ["nested", "object", false],
    ["input", "json", false],
  ]);
  expect(objectFields({ type: "object", additionalProperties: {} })).toBeNull();
});

test("plugin validation issues become field errors", () => {
  const message =
    'Invalid params: [{"path":["text"],"message":"Required"},{"path":[],"message":"Bad"}]';
  expect(parseActionIssues(message)).toEqual({ text: "Required", "": "Bad" });
  expect(parseActionIssues("No running plugin provides action")).toBeNull();
});
