import { z } from "zod";
import {
  AutomationSourceSchema,
  AutomationSourceOverridesSchema,
  ScheduleCadenceSchema,
  ScheduleChannelSchema,
  ScheduleDeliverySchema,
  ScheduleRunSchema,
  ScheduleSummarySchema,
  StoredScheduleSchema,
  ScheduleTargetSchema,
  ActionTargetSchema,
  ActionConfigSchema,
  AutomationTriggerSchema,
  TriggerEventSchema,
  ScheduleActionSchema,
  ScheduleTriggerSourceSchema,
} from "./types.js";

// cwd may be omitted when workspaceId is given; the daemon takes the workspace's directory.
const ScheduleCreateNewAgentConfigSchema = ScheduleTargetSchema.options[1].shape.config.extend({
  cwd: z.string().trim().min(1).optional(),
});

const ScheduleCreateTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("self"),
    agentId: z.guid(),
  }),
  z.object({
    type: z.literal("agent"),
    agentId: z.guid(),
  }),
  z.object({
    type: z.literal("new-agent"),
    config: ScheduleCreateNewAgentConfigSchema,
  }),
  ActionTargetSchema,
]);

export const ScheduleCreateRequestSchema = z.object({
  type: z.literal("schedule/create"),
  requestId: z.string(),
  prompt: z.string().min(1),
  name: z.string().optional(),
  cadence: ScheduleCadenceSchema,
  target: ScheduleCreateTargetSchema,
  maxRuns: z.number().int().positive().optional(),
  expiresAt: z.string().optional(),
  runOnCreate: z.boolean().optional(),
  delivery: ScheduleDeliverySchema.optional(),
  triggers: z.array(AutomationTriggerSchema).optional(),
});

export const ScheduleListRequestSchema = z.object({
  type: z.literal("schedule/list"),
  requestId: z.string(),
});

export const ScheduleInspectRequestSchema = z.object({
  type: z.literal("schedule/inspect"),
  requestId: z.string(),
  scheduleId: z.string(),
});

export const ScheduleLogsRequestSchema = z.object({
  type: z.literal("schedule/logs"),
  requestId: z.string(),
  scheduleId: z.string(),
});

export const ScheduleChannelsRequestSchema = z.object({
  type: z.literal("schedule/channels"),
  requestId: z.string(),
});

export const SchedulePauseRequestSchema = z.object({
  type: z.literal("schedule/pause"),
  requestId: z.string(),
  scheduleId: z.string(),
});

export const ScheduleResumeRequestSchema = z.object({
  type: z.literal("schedule/resume"),
  requestId: z.string(),
  scheduleId: z.string(),
});

export const ScheduleDeleteRequestSchema = z.object({
  type: z.literal("schedule/delete"),
  requestId: z.string(),
  scheduleId: z.string(),
});

export const ScheduleRunOnceRequestSchema = z.object({
  type: z.literal("schedule/run-once"),
  requestId: z.string(),
  scheduleId: z.string(),
  event: TriggerEventSchema.optional(),
});

const ScheduleUpdateNewAgentConfigSchema = z.object({
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).nullable().optional(),
  modeId: z.string().trim().min(1).nullable().optional(),
  thinkingOptionId: z.string().trim().min(1).nullable().optional(),
  archiveOnFinish: z.boolean().optional(),
  isolation: z.enum(["local", "worktree"]).optional(),
  cwd: z.string().trim().min(1).optional(),
  workspaceId: z.string().trim().min(1).nullable().optional(),
});

export const ScheduleUpdateRequestSchema = z.object({
  type: z.literal("schedule/update"),
  requestId: z.string(),
  scheduleId: z.string(),
  name: z.string().nullable().optional(),
  prompt: z.string().min(1).optional(),
  cadence: ScheduleCadenceSchema.optional(),
  triggers: z.array(AutomationTriggerSchema).optional(),
  actionConfig: ActionConfigSchema.optional(),
  newAgentConfig: ScheduleUpdateNewAgentConfigSchema.optional(),
  maxRuns: z.number().int().positive().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  delivery: ScheduleDeliverySchema.nullable().optional(),
});

export const ScheduleActionsRequestSchema = z.object({
  type: z.literal("schedule/actions"),
  requestId: z.string(),
});
export const ScheduleTriggersRequestSchema = z.object({
  type: z.literal("schedule/triggers"),
  requestId: z.string(),
});
export const ScheduleActionsResponseSchema = z.object({
  type: z.literal("schedule/actions/response"),
  payload: z.object({
    requestId: z.string(),
    actions: z.array(ScheduleActionSchema),
    error: z.string().nullable(),
  }),
});
export const ScheduleTriggersResponseSchema = z.object({
  type: z.literal("schedule/triggers/response"),
  payload: z.object({
    requestId: z.string(),
    triggers: z.array(ScheduleTriggerSourceSchema),
    error: z.string().nullable(),
  }),
});

export const ScheduleCreateResponseSchema = z.object({
  type: z.literal("schedule/create/response"),
  payload: z.object({
    requestId: z.string(),
    schedule: ScheduleSummarySchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ScheduleListResponseSchema = z.object({
  type: z.literal("schedule/list/response"),
  payload: z.object({
    requestId: z.string(),
    schedules: z.array(ScheduleSummarySchema),
    error: z.string().nullable(),
  }),
});

export const ScheduleInspectResponseSchema = z.object({
  type: z.literal("schedule/inspect/response"),
  payload: z.object({
    requestId: z.string(),
    schedule: StoredScheduleSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ScheduleLogsResponseSchema = z.object({
  type: z.literal("schedule/logs/response"),
  payload: z.object({
    requestId: z.string(),
    runs: z.array(ScheduleRunSchema),
    error: z.string().nullable(),
  }),
});

export const ScheduleChannelsResponseSchema = z.object({
  type: z.literal("schedule/channels/response"),
  payload: z.object({
    requestId: z.string(),
    channels: z.array(ScheduleChannelSchema),
    error: z.string().nullable(),
  }),
});

export const SchedulePauseResponseSchema = z.object({
  type: z.literal("schedule/pause/response"),
  payload: z.object({
    requestId: z.string(),
    schedule: ScheduleSummarySchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ScheduleResumeResponseSchema = z.object({
  type: z.literal("schedule/resume/response"),
  payload: z.object({
    requestId: z.string(),
    schedule: ScheduleSummarySchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ScheduleDeleteResponseSchema = z.object({
  type: z.literal("schedule/delete/response"),
  payload: z.object({
    requestId: z.string(),
    scheduleId: z.string(),
    error: z.string().nullable(),
  }),
});

export const ScheduleRunOnceResponseSchema = z.object({
  type: z.literal("schedule/run-once/response"),
  payload: z.object({
    requestId: z.string(),
    schedule: StoredScheduleSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ScheduleUpdateResponseSchema = z.object({
  type: z.literal("schedule/update/response"),
  payload: z.object({
    requestId: z.string(),
    schedule: StoredScheduleSchema.nullable(),
    error: z.string().nullable(),
  }),
});

const sourceRequest = {
  requestId: z.string(),
  id: z.string().optional(),
  fingerprint: z.string().optional(),
  overrides: AutomationSourceOverridesSchema.optional(),
};
const sourceResponse = z.object({
  requestId: z.string(),
  sources: z.array(AutomationSourceSchema),
  error: z.string().nullable(),
});
export const SourceListRequestSchema = z.object({
  type: z.literal("schedule.sources.list.request"),
  ...sourceRequest,
});
export const SourceListResponseSchema = z.object({
  type: z.literal("schedule.sources.list.response"),
  payload: sourceResponse,
});
export const SourceScanRequestSchema = z.object({
  type: z.literal("schedule.sources.scan.request"),
  ...sourceRequest,
});
export const SourceScanResponseSchema = z.object({
  type: z.literal("schedule.sources.scan.response"),
  payload: sourceResponse,
});
export const SourceShowRequestSchema = z.object({
  type: z.literal("schedule.sources.show.request"),
  ...sourceRequest,
});
export const SourceShowResponseSchema = z.object({
  type: z.literal("schedule.sources.show.response"),
  payload: sourceResponse,
});
export const SourceEnableRequestSchema = z.object({
  type: z.literal("schedule.sources.enable.request"),
  ...sourceRequest,
});
export const SourceEnableResponseSchema = z.object({
  type: z.literal("schedule.sources.enable.response"),
  payload: sourceResponse,
});
export const SourceDisableRequestSchema = z.object({
  type: z.literal("schedule.sources.disable.request"),
  ...sourceRequest,
});
export const SourceDisableResponseSchema = z.object({
  type: z.literal("schedule.sources.disable.response"),
  payload: sourceResponse,
});
export const SourceSetRequestSchema = z.object({
  type: z.literal("schedule.sources.set.request"),
  ...sourceRequest,
});
export const SourceSetResponseSchema = z.object({
  type: z.literal("schedule.sources.set.response"),
  payload: sourceResponse,
});
export const SourceForgetRequestSchema = z.object({
  type: z.literal("schedule.sources.forget.request"),
  ...sourceRequest,
});
export const SourceForgetResponseSchema = z.object({
  type: z.literal("schedule.sources.forget.response"),
  payload: sourceResponse,
});
