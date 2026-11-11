import { z } from "zod";
import { AgentProviderSchema } from "../provider-manifest.js";

export const ScheduleStatusSchema = z.enum(["active", "paused", "completed"]);
export type ScheduleStatus = z.infer<typeof ScheduleStatusSchema>;

export const ScheduleCadenceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("every"),
    everyMs: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("cron"),
    expression: z.string().trim().min(1),
    timezone: z.string().trim().min(1).optional(),
  }),
  z.object({ type: z.literal("none") }),
]);
export type ScheduleCadence = z.infer<typeof ScheduleCadenceSchema>;

export const ScheduleTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent"),
    agentId: z.guid(),
  }),
  z.object({
    type: z.literal("new-agent"),
    config: z.object({
      provider: AgentProviderSchema,
      cwd: z.string().trim().min(1),
      // Runs go into this existing workspace instead of creating one per run. cwd is then the
      // workspace's directory and isolation is not stored.
      workspaceId: z.string().trim().min(1).optional(),
      modeId: z.string().trim().min(1).optional(),
      model: z.string().trim().min(1).optional(),
      thinkingOptionId: z.string().trim().min(1).optional(),
      archiveOnFinish: z.boolean().optional(),
      isolation: z.enum(["local", "worktree"]).optional(),
      title: z.string().trim().min(1).nullable().optional(),
      providerOptions: z.record(z.string(), z.unknown()).optional(),
      featureValues: z.record(z.string(), z.unknown()).optional(),
      systemPrompt: z.string().optional(),
      mcpServers: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  z.object({
    type: z.literal("action"),
    action: z.string().trim().min(1),
    params: z.record(z.string(), z.unknown()),
    timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  }),
]);
export type ScheduleTarget = z.infer<typeof ScheduleTargetSchema>;

export const EventTriggerSchema = z.object({
  type: z.literal("event"),
  source: z.string().regex(/^[a-z][a-z0-9._-]*$/),
  event: z.string().regex(/^[a-z][a-z0-9._-]*$/),
  match: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  maxAgeMs: z.number().int().positive().optional(),
});
export const AutomationTriggerSchema = z.union([
  EventTriggerSchema,
  z.object({ type: z.string() }).passthrough(),
]);
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;
export const TriggerEventSchema = z.object({
  event: z.string().regex(/^[a-z][a-z0-9._-]*$/),
  id: z.string().min(1).max(1024),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  subject: z.string().max(4096).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  causedBy: z.string().optional(),
});
export type TriggerEvent = z.infer<typeof TriggerEventSchema>;
export const RunTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("clock") }),
  z.object({ type: z.literal("manual"), event: TriggerEventSchema.optional() }),
  z.object({
    type: z.literal("event"),
    source: z.string(),
    event: z.string(),
    eventId: z.string(),
    subject: z.string().optional(),
    depth: z.number().int().nonnegative(),
    coalesced: z.number().int().nonnegative().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
]);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;
export const TriggerSourceRegistrationSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9._-]*$/),
  label: z.string().optional(),
  events: z.array(
    z.object({
      id: z.string().regex(/^[a-z][a-z0-9._-]*$/),
      label: z.string().optional(),
      description: z.string().optional(),
      fields: z.array(z.string()).optional(),
    }),
  ),
});
export type TriggerSourceRegistration = z.infer<typeof TriggerSourceRegistrationSchema>;
export const ScheduleTriggerSourceSchema = TriggerSourceRegistrationSchema.extend({
  pluginId: z.string(),
});
export const ScheduleActionSchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  params: z.record(z.string(), z.unknown()),
  defaultTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
});
export type ScheduleAction = z.infer<typeof ScheduleActionSchema>;
export type ScheduleTriggerSource = z.infer<typeof ScheduleTriggerSourceSchema>;
export const EmitResultSchema = z.object({
  status: z.enum(["accepted", "duplicate", "stale"]),
  started: z.array(z.string()),
  deferred: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type EmitResult = z.infer<typeof EmitResultSchema>;
export const ProjectSourceRefSchema = z.object({
  kind: z.literal("project"),
  projectKey: z.string(),
  automationId: z.string(),
  fingerprint: z.string(),
});

// Where a schedule sends each run's result. `channel` is an outbound channel id registered by a
// plugin; `to` is an address only that channel interprets.
export const ScheduleDeliverySchema = z.object({
  channel: z.string().trim().min(1),
  to: z.string().trim().min(1),
});
export type ScheduleDelivery = z.infer<typeof ScheduleDeliverySchema>;

export const ScheduleRunDeliverySchema = z.object({
  status: z.enum(["delivered", "failed"]),
  at: z.string(),
  error: z.string().optional(),
});
export type ScheduleRunDelivery = z.infer<typeof ScheduleRunDeliverySchema>;

// A place a plugin channel can post to, chosen by label instead of by raw address.
export const ChannelDestinationSchema = z.object({
  to: z.string(),
  label: z.string(),
});
export type ChannelDestination = z.infer<typeof ChannelDestinationSchema>;

// An outbound channel as clients see it. `destinations` is null when the plugin could not list
// them, with the reason in `error`.
export const ScheduleChannelSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  pluginId: z.string(),
  destinations: z.array(ChannelDestinationSchema).nullable(),
  error: z.string().optional(),
});
export type ScheduleChannel = z.infer<typeof ScheduleChannelSchema>;

// The most recent delivery outcome, kept on the schedule so lists can show it without runs.
export const ScheduleLastDeliverySchema = ScheduleRunDeliverySchema.extend({
  runId: z.string(),
});
export type ScheduleLastDelivery = z.infer<typeof ScheduleLastDeliverySchema>;

export const ScheduleRunSchema = z.object({
  id: z.string(),
  scheduledFor: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: z.enum(["running", "succeeded", "failed"]),
  agentId: z.guid().nullable(),
  // The workspace this run created and owns. Null when the run used the schedule's own
  // workspaceId: the daemon never archives that one.
  workspaceId: z.string().nullable().optional(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  delivery: ScheduleRunDeliverySchema.optional(),
  trigger: RunTriggerSchema.optional(),
});
export type ScheduleRun = z.infer<typeof ScheduleRunSchema>;

export const StoredScheduleSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  prompt: z.string().min(1),
  cadence: ScheduleCadenceSchema,
  target: ScheduleTargetSchema,
  status: ScheduleStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  pausedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  maxRuns: z.number().int().positive().nullable(),
  delivery: ScheduleDeliverySchema.optional(),
  lastDelivery: ScheduleLastDeliverySchema.optional(),
  triggers: z.array(AutomationTriggerSchema).optional(),
  pauseReason: z.string().optional(),
  source: ProjectSourceRefSchema.optional(),
  runs: z.array(ScheduleRunSchema),
});
export type StoredSchedule = z.infer<typeof StoredScheduleSchema>;

export const ScheduleSummarySchema = StoredScheduleSchema.omit({
  runs: true,
});
export type ScheduleSummary = z.infer<typeof ScheduleSummarySchema>;

export type ScheduleNewAgentConfig = Extract<ScheduleTarget, { type: "new-agent" }>["config"];

// A new-agent create request may omit cwd when it names a workspace.
export type CreateScheduleTarget =
  | Extract<ScheduleTarget, { type: "agent" }>
  | Extract<ScheduleTarget, { type: "action" }>
  | {
      type: "new-agent";
      config: Omit<ScheduleNewAgentConfig, "cwd"> & { cwd?: string };
    };

export interface CreateScheduleInput {
  name?: string | null;
  prompt: string;
  cadence: ScheduleCadence;
  target: CreateScheduleTarget;
  maxRuns?: number | null;
  expiresAt?: string | null;
  runOnCreate?: boolean | null;
  delivery?: ScheduleDelivery | null;
  triggers?: AutomationTrigger[];
}

export interface UpdateScheduleNewAgentConfig {
  provider?: string;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  archiveOnFinish?: boolean;
  isolation?: "local" | "worktree";
  cwd?: string;
  // A string binds or rebinds; null runs in a new workspace again.
  workspaceId?: string | null;
}

export interface UpdateScheduleInput {
  id: string;
  name?: string | null;
  prompt?: string;
  cadence?: ScheduleCadence;
  triggers?: AutomationTrigger[];
  actionTarget?: Extract<ScheduleTarget, { type: "action" }>;
  newAgentConfig?: UpdateScheduleNewAgentConfig;
  maxRuns?: number | null;
  expiresAt?: string | null;
  /** `null` clears the delivery target. */
  delivery?: ScheduleDelivery | null;
}

export interface ScheduleExecutionResult {
  agentId: string | null;
  output: string | null;
}
