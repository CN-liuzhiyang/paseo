import { expect, test } from "vitest";
import type { AutomationSource, ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import {
  buildAutomationSubmit,
  initAutomationForm,
  objectFields,
  parseActionIssues,
  reduceAutomationForm,
  defaultParams,
  mergeSources,
  canApproveSource,
  type AutomationFormAction,
} from "./automation-form";

const cron = { type: "cron" as const, expression: "0 9 * * *", timezone: "UTC" };
const actionSchedule = {
  cadence: { type: "none" },
  target: { type: "action", action: "demo.echo", params: { text: "hi" } },
  triggers: [{ type: "event", source: "demo", event: "ping", match: { sender: "alice" } }],
  eventRateLimit: 5,
} as unknown as ScheduleSummary;

function submit(
  actions: AutomationFormAction[],
  schedule?: ScheduleSummary,
  schema?: Record<string, unknown>,
) {
  const initial = initAutomationForm(schedule);
  const draft = actions.reduce(reduceAutomationForm, initial);
  const state = { ...draft, params: defaultParams(draft.params, schema) };
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
    {
      type: "trigger",
      index: 0,
      patch: { id: "demo:ping", match: '{"n":3,"ok":true,"who":"bob"}' },
    },
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
  const json: AutomationFormAction = { type: "json", path: ["input"], text: "{" };
  expect(() => submit([{ type: "run", run: "flow.run" }, json])).toThrow();
});

test("action params merge form values with parsed JSON fields", () => {
  const result = submit([
    { type: "run", run: "flow.run" },
    { type: "param", path: ["flow"], value: "sync" },
    { type: "param", path: ["opts", "dry"], value: true },
    { type: "json", path: ["input"], text: '{"mode":"fast"}' },
  ]);
  expect(result.target).toEqual({
    type: "action",
    action: "flow.run",
    params: { flow: "sync", opts: { dry: true }, input: { mode: "fast" } },
  });
});

test("JSON Schema maps the supported subset and falls back to JSON for the rest", () => {
  const fields = objectFields({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["flow"],
    properties: {
      flow: { type: "string" },
      count: { type: "integer" },
      dry: { type: "boolean" },
      mode: { type: "string", enum: ["a", "b"] },
      tags: { type: "array", items: { type: "string" } },
      nested: { type: "object", properties: { x: { type: "number" } } },
    },
  });
  expect(fields?.map((field) => [field.key, field.kind, field.required])).toEqual([
    ["flow", "string", true],
    ["count", "number", false],
    ["dry", "boolean", false],
    ["mode", "enum", false],
    ["tags", "json", false],
    ["nested", "object", false],
  ]);
  expect(objectFields({ type: "object", additionalProperties: {} })).toBeNull();
});

test.each([
  undefined,
  {},
  { code: "001", flag: "false", text: "a,b", space: "  x  ", equal: "a=b", n: 2, ok: false },
])("untouched triggers and params round-trip without loss: %j", (match) => {
  const triggers = [
    {
      type: "event",
      source: "demo",
      event: "ping",
      maxAgeMs: 5000,
      future: { keep: true },
      ...(match ? { match } : {}),
    },
  ];
  const target = {
    type: "action",
    action: "demo.echo",
    params: { "a.b": "original", tags: ["a,b", " c "] },
  };
  const original = { ...actionSchedule, triggers, target } as unknown as ScheduleSummary;
  expect(submit([], original).triggers).toEqual(triggers);
  expect(submit([], original).target).toEqual(target);
  expect(
    submit([{ type: "trigger", index: 0, patch: { id: "demo:pong" } }], original).triggers,
  ).toEqual([{ ...triggers[0], event: "pong" }]);
});

test("JSON match edits preserve scalar types, delimiters and surrounding spaces", () => {
  const match = { code: "001", flag: "false", comma: "a,b", space: "  x  ", equal: "a=b" };
  expect(
    submit([{ type: "trigger", index: 0, patch: { match: JSON.stringify(match) } }], actionSchedule)
      .triggers[0].match,
  ).toEqual(match);
});

test.each([["tags"], ["a.b"], ["nested.key", "a.b"]])(
  "JSON arrays and literal path segments survive editing: %j",
  (...path) => {
    const values = ["a,b", " c ", "a=b"];
    const target = submit([
      { type: "run", run: "demo.echo" },
      { type: "json", path, text: JSON.stringify(values) },
    ]).target;
    expect(target?.params).toEqual(
      path.length === 1 ? { [path[0]]: values } : { [path[0]]: { [path[1]]: values } },
    );
    expect(
      submit([{ type: "param", path: ["a.b"], value: "new" }], actionSchedule).target?.params,
    ).toEqual({ text: "hi", "a.b": "new" });
  },
);

test.each([
  [
    {
      type: "object",
      oneOf: [{ required: ["a"] }, { required: ["b"] }],
      properties: { a: { type: "string" } },
    },
    { a: "001" },
  ],
  [{ type: "object", properties: { n: { type: "number", enum: [1, 2] } } }, { n: 2 }],
  [
    {
      type: "object",
      properties: {
        nested: { type: "object", properties: { text: { type: "string", pattern: "x" } } },
      },
    },
    { nested: { text: "x" } },
  ],
])("unsupported schema falls back to JSON and submits typed values: %j", (schema, params) => {
  expect(objectFields(schema)).toBeNull();
  expect(
    submit(
      [
        { type: "run", run: "demo.echo" },
        { type: "json", path: [], text: JSON.stringify(params) },
      ],
      undefined,
      schema,
    ).target?.params,
  ).toEqual(params);
});

test("required booleans and schema defaults enter actual submitted params", () => {
  const schema = {
    type: "object",
    required: ["dry", "opts"],
    properties: {
      dry: { type: "boolean" },
      count: { type: "number", default: 7 },
      mode: { type: "string", default: "001" },
      opts: { type: "object", properties: { enabled: { type: "boolean", default: true } } },
    },
  };
  expect(submit([{ type: "run", run: "demo.echo" }], undefined, schema).target?.params).toEqual({
    dry: false,
    count: 7,
    mode: "001",
    opts: { enabled: true },
  });
});

test.each(["enabled", "disabled"])("source %s responses retain other sources", (state) => {
  const sources = [
    { id: "one", state: "pending" },
    { id: "two", state: "pending" },
  ] as AutomationSource[];
  const updated = { ...sources[0], state } as AutomationSource;
  expect(mergeSources(sources, [updated])).toEqual([updated, sources[1]]);
  expect(sources[0].state).toBe("pending");
});

test.each([
  "directTcp",
  "directSocket",
  "directPipe",
  "remoteSsh",
  "relay",
  "routed",
  undefined,
  "future",
])("only known online direct connections approve sources: %s", (type) => {
  expect(canApproveSource(type, "online")).toBe(
    ["directTcp", "directSocket", "directPipe", "remoteSsh"].includes(type ?? ""),
  );
  for (const status of [undefined, "idle", "connecting", "offline", "error"])
    expect(canApproveSource(type, status)).toBe(false);
});

test("plugin validation issues become field errors", () => {
  const message =
    'Invalid params: [{"path":["text"],"message":"Required"},{"path":[],"message":"Bad"}]';
  expect(parseActionIssues(message)).toEqual({ text: "Required", "": "Bad" });
  expect(parseActionIssues("No running plugin provides action")).toBeNull();
  expect(parseActionIssues("Invalid params: []")).toBeNull();
});
