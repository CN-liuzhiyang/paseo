import type {
  AutomationTrigger,
  AutomationSource,
  ScheduleCadence,
  ScheduleSummary,
  ScheduleTarget,
} from "@getpaseo/protocol/schedule/types";
import { i18n } from "@/i18n/i18next";

/** The run choice that starts an AI session; every other value is a plugin action ID. */
export const AGENT_RUN = "agent";

export function mergeSources(
  current: AutomationSource[] = [],
  updates: AutomationSource[],
): AutomationSource[] {
  return [...new Map([...current, ...updates].map((source) => [source.id, source])).values()];
}

export function canApproveSource(
  connection: string | undefined,
  status: string | undefined,
): boolean {
  return (
    status === "online" &&
    ["directTcp", "directSocket", "directPipe", "remoteSsh"].includes(connection ?? "")
  );
}

/** Upstream keeps cron as the one clock; interval presets are cron expressions. */
export type ClockKind = "cron" | "none";

export interface EventTriggerDraft {
  /** Stable row identity while drafts are added and removed. */
  key: number;
  /** `source:event`, empty until chosen. */
  id: string;
  original?: AutomationTrigger;
  /** JSON object; scalar values retain their types and whitespace. */
  match: string;
}

export interface AutomationFormState {
  run: string;
  params: Record<string, unknown>;
  /** Raw JSON fields, keyed by JSON-encoded path segments, parsed at submit. */
  jsonText: Record<string, string>;
  clock: ClockKind;
  triggers: EventTriggerDraft[];
  rateLimit: string;
}

export type AutomationFormAction =
  | { type: "run"; run: string }
  | { type: "param"; path: string[]; value: unknown }
  | { type: "json"; path: string[]; text: string }
  | { type: "clock"; clock: ClockKind }
  | { type: "addTrigger" }
  | { type: "trigger"; index: number; patch: Partial<EventTriggerDraft> }
  | { type: "removeTrigger"; index: number }
  | { type: "rateLimit"; text: string };

let nextDraftKey = 0;

export function initAutomationForm(schedule: ScheduleSummary | undefined): AutomationFormState {
  const target = schedule?.target;
  const cadence = schedule?.cadence;
  return {
    run: target?.type === "action" ? target.action : AGENT_RUN,
    params: target?.type === "action" ? { ...target.params } : {},
    jsonText: {},
    clock: cadence?.type === "none" ? "none" : "cron",
    triggers: (schedule?.triggers ?? []).map((trigger) => ({
      key: nextDraftKey++,
      original: trigger,
      id: `${String(trigger.source)}:${String(trigger.event)}`,
      match: JSON.stringify(trigger.match ?? {}),
    })),
    rateLimit: schedule?.eventRateLimit ? String(schedule.eventRateLimit) : "",
  };
}

function setPath(
  target: Record<string, unknown>,
  path: string[],
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined) return target;
  const child = target[head];
  const next =
    rest.length === 0
      ? value
      : setPath(
          typeof child === "object" && child ? (child as Record<string, unknown>) : {},
          rest,
          value,
        );
  const copy = { ...target };
  if (next === undefined) delete copy[head];
  else copy[head] = next;
  return copy;
}

export function reduceAutomationForm(
  state: AutomationFormState,
  action: AutomationFormAction,
): AutomationFormState {
  switch (action.type) {
    case "run":
      return { ...state, run: action.run, params: {}, jsonText: {} };
    case "param":
      return { ...state, params: setPath(state.params, action.path, action.value) };
    case "json":
      return {
        ...state,
        jsonText: { ...state.jsonText, [JSON.stringify(action.path)]: action.text },
      };
    case "clock":
      return { ...state, clock: action.clock };
    case "addTrigger":
      return {
        ...state,
        triggers: [...state.triggers, { key: nextDraftKey++, id: "", match: "" }],
      };
    case "trigger":
      return {
        ...state,
        triggers: state.triggers.map((trigger, index) =>
          index === action.index ? { ...trigger, ...action.patch } : trigger,
        ),
      };
    case "removeTrigger":
      return { ...state, triggers: state.triggers.filter((_, index) => index !== action.index) };
    case "rateLimit":
      return { ...state, rateLimit: action.text };
  }
}

export interface ParamField {
  kind: "string" | "number" | "boolean" | "enum" | "object" | "json";
  key: string;
  label: string;
  required: boolean;
  options?: { id: string; value: string; label: string }[];
  fields?: ParamField[];
}

type JsonSchema = Record<string, unknown>;

function fieldFor(key: string, schema: JsonSchema, required: boolean): ParamField {
  const label = typeof schema.title === "string" ? schema.title : key;
  const base = { key, label, required };
  if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "string"))
    return {
      ...base,
      kind: "enum",
      options: (schema.enum as string[]).map((value) => ({ id: value, value, label: value })),
    };
  if (schema.type === "string") return { ...base, kind: "string" };
  if (schema.type === "number" || schema.type === "integer") return { ...base, kind: "number" };
  if (schema.type === "boolean") return { ...base, kind: "boolean" };
  const fields = objectFields(schema);
  return fields ? { ...base, kind: "object", fields } : { ...base, kind: "json" };
}

function supportedSchema(schema: JsonSchema): boolean {
  const keys =
    "$schema,type,title,description,default,enum,properties,required,additionalProperties,items".split(
      ",",
    );
  if (Object.keys(schema).some((key) => !keys.includes(key))) return false;
  if (
    schema.enum &&
    (!Array.isArray(schema.enum) ||
      schema.type !== "string" ||
      schema.enum.some((v) => typeof v !== "string"))
  )
    return false;
  if (schema.type === "object")
    return (
      schema.additionalProperties !== true &&
      typeof schema.additionalProperties !== "object" &&
      Object.values((schema.properties ?? {}) as Record<string, JsonSchema>).every(supportedSchema)
    );
  if (schema.type === "array") return supportedSchema((schema.items ?? {}) as JsonSchema);
  return ["string", "number", "integer", "boolean"].includes(String(schema.type));
}

/** Existing params receive only declared defaults; new forms also seed required fields. */
export function defaultParams(
  params: Record<string, unknown>,
  schema: JsonSchema = {},
  create = true,
): Record<string, unknown> {
  if (!params || ![Object.prototype, null].includes(Object.getPrototypeOf(params))) return params;
  const result = { ...params };
  for (const [key, child] of Object.entries(
    (schema.properties ?? {}) as Record<string, JsonSchema>,
  )) {
    const required = create && (schema.required as string[] | undefined)?.includes(key);
    if (result[key] === undefined) {
      if (child.default !== undefined) result[key] = child.default;
      else if (required && child.type === "boolean") result[key] = false;
      else if (required && child.type === "object") result[key] = {};
    }
    if (child.type === "object" && result[key] !== undefined)
      result[key] = defaultParams(result[key] as Record<string, unknown>, child, create);
    if (result[key] === undefined) delete result[key];
  }
  return result;
}

/** Fields for an object schema with named properties; null when the shape is not supported. */
export function objectFields(schema: JsonSchema): ParamField[] | null {
  const entries = Object.entries((schema.properties ?? {}) as Record<string, JsonSchema>);
  if (!supportedSchema(schema) || schema.type !== "object" || entries.length === 0) return null;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return entries.map(([key, child]) => fieldFor(key, child, required.has(key)));
}

/** Params with JSON fields parsed in place. Throws with the field path on invalid JSON. */
export function resolveParams(state: AutomationFormState): Record<string, unknown> {
  let params = state.params;
  for (const [encoded, text] of Object.entries(state.jsonText)) {
    const path = JSON.parse(encoded) as string[];
    let value: unknown;
    try {
      value = text.trim() ? JSON.parse(text) : undefined;
    } catch {
      throw new Error(i18n.t("automation.jsonError", { field: path.join(".") || "params" }));
    }
    if (path.length) params = setPath(params, path, value);
    else if (value === undefined || value?.constructor === Object)
      params = (value ?? {}) as Record<string, unknown>;
    else throw new Error(i18n.t("automation.jsonError", { field: "params" }));
  }
  return params;
}

/** Field errors from a plugin's `action.validate` Zod issues, keyed by dotted path. */
export function parseActionIssues(message: string): Record<string, string> | null {
  const start = message.indexOf("[");
  if (start < 0) return null;
  try {
    const issues = JSON.parse(message.slice(start, message.lastIndexOf("]") + 1)) as {
      path?: unknown[];
      message?: string;
    }[];
    if (!Array.isArray(issues) || issues.length === 0) return null;
    const result: Record<string, string> = {};
    for (const issue of issues) result[(issue.path ?? []).join(".")] = issue.message ?? "";
    return result;
  } catch {
    return null;
  }
}

function parseMatch(text: string): Record<string, string | number | boolean> {
  try {
    const match = text.trim() ? JSON.parse(text) : {};
    if (
      match?.constructor === Object &&
      Object.values(match).every((v) => ["string", "number", "boolean"].includes(typeof v))
    )
      return match;
  } catch {
    // Report malformed JSON and unsupported values through the same field error.
  }
  throw new Error(i18n.t("automation.jsonError", { field: i18n.t("automation.match") }));
}

export function buildTriggers(drafts: EventTriggerDraft[]): AutomationTrigger[] {
  return drafts.map((draft) => {
    const [source, event] = draft.id.split(":");
    if (!source || !event) throw new Error(i18n.t("automation.eventRequired"));
    const original = draft.original;
    const trigger: AutomationTrigger = { ...original, type: "event", source, event };
    if (!original || draft.match !== JSON.stringify(original.match ?? {})) {
      const match = parseMatch(draft.match);
      if (Object.keys(match).length) trigger.match = match;
      else delete trigger.match;
    }
    return trigger;
  });
}

export interface AutomationSubmit {
  /** Undefined leaves an edited automation's clock alone. */
  cadence: ScheduleCadence | undefined;
  triggers: AutomationTrigger[];
  target: Extract<ScheduleTarget, { type: "action" }> | null;
  eventRateLimit: number | null;
}

/** `cronCadence` is the cron editor's value when the person changed it, else undefined. */
export function buildAutomationSubmit(input: {
  state: AutomationFormState;
  initial: AutomationFormState;
  cronCadence: ScheduleCadence | undefined;
  currentCron: ScheduleCadence;
}): AutomationSubmit {
  const { state } = input;
  let cadence: ScheduleCadence | undefined;
  if (state.clock === "none") cadence = { type: "none" };
  else
    cadence = input.cronCadence ?? (input.initial.clock === "cron" ? undefined : input.currentCron);
  const rate = state.rateLimit.trim();
  const eventRateLimit = rate ? Number(rate) : null;
  if (eventRateLimit !== null && (!Number.isInteger(eventRateLimit) || eventRateLimit < 1))
    throw new Error(i18n.t("automation.positiveError", { field: i18n.t("automation.rateLimit") }));
  return {
    cadence,
    triggers: buildTriggers(state.triggers),
    target:
      state.run === AGENT_RUN
        ? null
        : { type: "action", action: state.run, params: resolveParams(state) },
    eventRateLimit,
  };
}
