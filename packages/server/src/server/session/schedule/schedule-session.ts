import type { SourceCaller } from "../../schedule/automation-sources.js";
import { projectAutomation, projectAutomationRuns } from "../../schedule/automation-projection.js";
import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { ScheduleService } from "../../schedule/service.js";

export interface ScheduleSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface ScheduleSessionOptions {
  supportsAutomations?: () => boolean;
  host: ScheduleSessionHost;
  scheduleService: ScheduleService;
  logger: pino.Logger;
}

export class ScheduleSession {
  private readonly supportsAutomations: () => boolean;
  private readonly host: ScheduleSessionHost;
  private readonly scheduleService: ScheduleService;
  private readonly logger: pino.Logger;

  constructor(options: ScheduleSessionOptions) {
    this.host = options.host;
    this.supportsAutomations = options.supportsAutomations ?? (() => false);
    this.scheduleService = options.scheduleService;
    this.logger = options.logger;
  }

  async handleSourceRequest(request: SessionInboundMessage, caller: SourceCaller): Promise<void> {
    type SourceRequest = Extract<
      SessionInboundMessage,
      { type: `schedule.sources.${string}.request` }
    >;
    type SourceResponse = Extract<
      SessionOutboundMessage,
      { type: `schedule.sources.${string}.response` }
    >;
    // Session dispatch has already selected the schema-validated source namespace.
    const input = request as SourceRequest;
    const type = input.type.replace(/\.request$/, ".response") as SourceResponse["type"];
    try {
      if (!this.scheduleService.sources) throw new Error("Automation sources unavailable");
      const sources = await this.scheduleService.sources.request(
        input.type.split(".")[2],
        input,
        caller,
      );
      this.host.emit({ type, payload: { requestId: input.requestId, sources, error: null } });
    } catch (error) {
      this.host.emit({
        type,
        payload: { requestId: input.requestId, sources: [], error: String(error) },
      });
    }
  }

  private project(schedule: Awaited<ReturnType<ScheduleService["inspect"]>>) {
    return projectAutomation(schedule, this.supportsAutomations());
  }

  private toScheduleSummary(
    schedule: Awaited<ReturnType<ScheduleService["inspect"]>>,
  ):
    | Extract<
        SessionOutboundMessage,
        { type: "schedule/list/response" }
      >["payload"]["schedules"][number]
    | null {
    const projected = this.project(schedule);
    if (!projected) return null;
    const { runs: _runs, ...summary } = projected;
    return summary;
  }

  private emitScheduleRpcError(
    request: Extract<
      SessionInboundMessage,
      {
        type:
          | "schedule/create"
          | "schedule/list"
          | "schedule/inspect"
          | "schedule/logs"
          | "schedule/pause"
          | "schedule/resume"
          | "schedule/delete"
          | "schedule/run-once"
          | "schedule/update"
          | "schedule/channels"
          | "schedule/actions"
          | "schedule/triggers";
      }
    >,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ err: error, requestType: request.type }, "Schedule request failed");
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code: "schedule_request_failed",
      },
    });
  }

  async handleScheduleCreateRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/create" }>,
  ): Promise<void> {
    try {
      const target =
        request.target.type === "self"
          ? { type: "agent" as const, agentId: request.target.agentId }
          : request.target;
      const schedule = await this.scheduleService.create({
        prompt: request.prompt,
        name: request.name,
        cadence: request.cadence,
        target,
        maxRuns: request.maxRuns,
        expiresAt: request.expiresAt,
        runOnCreate: request.runOnCreate,
        delivery: request.delivery,
        triggers: request.triggers,
      });
      this.host.emit({
        type: "schedule/create/response",
        payload: {
          requestId: request.requestId,
          schedule: this.toScheduleSummary(schedule),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleListRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/list" }>,
  ): Promise<void> {
    try {
      const schedules = await this.scheduleService.list();
      this.host.emit({
        type: "schedule/list/response",
        payload: {
          requestId: request.requestId,
          schedules: schedules.flatMap((schedule) => {
            const summary = this.toScheduleSummary(schedule);
            return summary ? [summary] : [];
          }),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleInspectRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/inspect" }>,
  ): Promise<void> {
    try {
      const schedule = await this.scheduleService.inspect(request.scheduleId);
      this.host.emit({
        type: "schedule/inspect/response",
        payload: {
          requestId: request.requestId,
          schedule: this.project(schedule),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleChannelsRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/channels" }>,
  ): Promise<void> {
    try {
      const channels = await this.scheduleService.listChannels();
      this.host.emit({
        type: "schedule/channels/response",
        payload: { requestId: request.requestId, channels, error: null },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleActionsRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/actions" }>,
  ): Promise<void> {
    this.host.emit({
      type: "schedule/actions/response",
      payload: {
        requestId: request.requestId,
        actions: this.scheduleService.listActions(),
        error: null,
      },
    });
  }

  async handleScheduleTriggersRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/triggers" }>,
  ): Promise<void> {
    this.host.emit({
      type: "schedule/triggers/response",
      payload: {
        requestId: request.requestId,
        triggers: this.scheduleService.listTriggerSources(),
        error: null,
      },
    });
  }

  async handleScheduleLogsRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/logs" }>,
  ): Promise<void> {
    try {
      const runs = await this.scheduleService.logs(request.scheduleId);
      this.host.emit({
        type: "schedule/logs/response",
        payload: {
          requestId: request.requestId,
          runs: projectAutomationRuns(runs, this.supportsAutomations()),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleSchedulePauseRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/pause" }>,
  ): Promise<void> {
    try {
      const schedule = await this.scheduleService.pause(request.scheduleId);
      this.host.emit({
        type: "schedule/pause/response",
        payload: {
          requestId: request.requestId,
          schedule: this.toScheduleSummary(schedule),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleResumeRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/resume" }>,
  ): Promise<void> {
    try {
      const schedule = await this.scheduleService.resume(request.scheduleId);
      this.host.emit({
        type: "schedule/resume/response",
        payload: {
          requestId: request.requestId,
          schedule: this.toScheduleSummary(schedule),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleDeleteRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/delete" }>,
  ): Promise<void> {
    try {
      await this.scheduleService.delete(request.scheduleId);
      this.host.emit({
        type: "schedule/delete/response",
        payload: {
          requestId: request.requestId,
          scheduleId: request.scheduleId,
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleRunOnceRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/run-once" }>,
  ): Promise<void> {
    try {
      const schedule = await this.scheduleService.runOnce(request.scheduleId, request.event);
      this.host.emit({
        type: "schedule/run-once/response",
        payload: {
          requestId: request.requestId,
          schedule: this.project(schedule),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleUpdateRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/update" }>,
  ): Promise<void> {
    try {
      const schedule = await this.scheduleService.update({
        id: request.scheduleId,
        triggers: request.triggers,
        actionConfig: request.actionConfig,
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
        ...(request.cadence !== undefined ? { cadence: request.cadence } : {}),
        ...(request.newAgentConfig !== undefined ? { newAgentConfig: request.newAgentConfig } : {}),
        ...(request.maxRuns !== undefined ? { maxRuns: request.maxRuns } : {}),
        ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
        ...(request.delivery !== undefined ? { delivery: request.delivery } : {}),
      });
      this.host.emit({
        type: "schedule/update/response",
        payload: {
          requestId: request.requestId,
          schedule: this.project(schedule),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }
}
