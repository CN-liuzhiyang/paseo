import type {
  AutomationTrigger,
  ScheduleCadence,
  ScheduleSummary,
  ScheduleTarget,
} from "@getpaseo/protocol/schedule/types";
import { i18n } from "@/i18n/i18next";

/** The run choice that starts an AI session; every other value is a plugin action ID. */
export const AGENT_RUN = "agent";

export type ClockKind = "cron" | "every" | "none";

export interface EventTriggerDraft {
  /** Stable row identity while drafts are added and removed. */
  key: number;
  /** `source:event`, empty until chosen. */
  id: string;
  /** `key=value` pairs separated by commas; every pair must equal the event data. */
  match: string;
}

export interface AutomationFormState {
  run: string;
  params: Record<string, unknown>;
  /** Raw text of JSON fields, keyed by dotted path, parsed at submit. */
  jsonText: Record<string, string>;
  clock: ClockKind;
  everyMinutes: string;
  triggers: EventTriggerDraft[];
  rateLimit: string;
}

export type AutomationFormAction =
  | { type: "run"; run: string }
  | { type: "param"; path: string[]; value: unknown }
  | { type: "json"; path: string; text: string }
  | { type: "clock"; clock: ClockKind }
  | { type: "every"; text: string }
  | { type: "addTrigger" }
  | { type: "trigger"; index: number; patch: Partial<EventTriggerDraft> }
  | { type: "removeTrigger"; index: number }
  | { type: "rateLimit"; text: string };

let nextDraftKey = 0;

function formatMatch(trigger: AutomationTrigger): string {
  const match = (trigger.match ?? {}) as Record<string, unknown>;
  return Object.entries(match)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
}

export function initAutomationForm(schedule: ScheduleSummary | undefined): AutomationFormState {
  const target = schedule?.target;
  const cadence = schedule?.cadence;
  return {
    run: target?.type === "action" ? target.action : AGENT_RUN,
    params: target?.type === "action" ? { ...target.params } : {},
    jsonText: {},
    clock: cadence?.type === "every" || cadence?.type === "none" ? cadence.type : "cron",
    everyMinutes: cadence?.type === "every" ? String(Math.round(cadence.everyMs / 60_000)) : "60",
    triggers: (schedule?.triggers ?? []).map((trigger) => ({
      key: nextDraftKey++,
      id: `${String(trigger.source)}:${String(trigger.event)}`,
      match: formatMatch(trigger),
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
      return { ...state, jsonText: { ...state.jsonText, [action.path]: action.text } };
    case "clock":
      return { ...state, clock: action.clock };
    case "every":
      return { ...state, everyMinutes: action.text };
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
  kind: "string" | "number" | "boolean" | "strings" | "enum" | "object" | "json";
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
  if (schema.type === "array" && (schema.items as JsonSchema | undefined)?.type === "string")
    return { ...base, kind: "strings" };
  const fields = objectFields(schema);
  return fields ? { ...base, kind: "object", fields } : { ...base, kind: "json" };
}

/** Fields for an object schema with named properties; null when the shape is not supported. */
export function objectFields(schema: JsonSchema): ParamField[] | null {
  const properties = schema.properties as Record<string, JsonSchema> | undefined;
  if (schema.type !== "object" || !properties || Object.keys(properties).length === 0) return null;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(properties).map(([key, child]) => fieldFor(key, child, required.has(key)));
}

/** Params with JSON fields parsed in place. Throws with the field path on invalid JSON. */
export function resolveParams(state: AutomationFormState): Record<string, unknown> {
  let params = state.params;
  for (const [path, text] of Object.entries(state.jsonText)) {
    let value: unknown;
    try {
      value = text.trim() ? JSON.parse(text) : undefined;
    } catch {
      throw new Error(i18n.t("automation.jsonError", { field: path || "params" }));
    }
    if (path) params = setPath(params, path.split("."), value);
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
    const issues = JSON.parse(message.slice(start)) as { path?: unknown[]; message?: string }[];
    if (!Array.isArray(issues)) return null;
    const result: Record<string, string> = {};
    for (const issue of issues) result[(issue.path ?? []).join(".")] = issue.message ?? "";
    return result;
  } catch {
    return null;
  }
}

function parseMatch(text: string): Record<string, string | number | boolean> | undefined {
  const match: Record<string, string | number | boolean> = {};
  for (const pair of text.split(",")) {
    if (!pair.trim()) continue;
    const separator = pair.indexOf("=");
    if (separator < 1) throw new Error(i18n.t("automation.matchError", { pair: pair.trim() }));
    const raw = pair.slice(separator + 1).trim();
    let value: string | number | boolean = raw;
    if (raw === "true" || raw === "false") value = raw === "true";
    else if (raw !== "" && Number.isFinite(Number(raw))) value = Number(raw);
    match[pair.slice(0, separator).trim()] = value;
  }
  return Object.keys(match).length > 0 ? match : undefined;
}

export function buildTriggers(drafts: EventTriggerDraft[]): AutomationTrigger[] {
  return drafts.map((draft) => {
    const [source, event] = draft.id.split(":");
    if (!source || !event) throw new Error(i18n.t("automation.eventRequired"));
    const match = parseMatch(draft.match);
    return { type: "event" as const, source, event, ...(match ? { match } : {}) };
  });
}

function positiveError(field: "automation.everyMinutes" | "automation.rateLimit"): Error {
  return new Error(i18n.t("automation.positiveError", { field: i18n.t(field) }));
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
  else if (state.clock === "every") {
    const minutes = Number(state.everyMinutes);
    if (!Number.isInteger(minutes) || minutes < 1) throw positiveError("automation.everyMinutes");
    cadence = { type: "every", everyMs: minutes * 60_000 };
  } else
    cadence = input.cronCadence ?? (input.initial.clock === "cron" ? undefined : input.currentCron);
  const rate = state.rateLimit.trim();
  const eventRateLimit = rate ? Number(rate) : null;
  if (eventRateLimit !== null && (!Number.isInteger(eventRateLimit) || eventRateLimit < 1))
    throw positiveError("automation.rateLimit");
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
