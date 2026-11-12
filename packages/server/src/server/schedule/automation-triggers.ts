import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import {
  EventTriggerSchema,
  TriggerEventSchema,
  type TriggerEvent,
  type RunTrigger,
  type StoredSchedule,
  type EmitResult,
  type AutomationTrigger,
} from "@getpaseo/protocol/schedule/types";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { ScheduleStateConflictError } from "./service.js";

interface TriggerService {
  list(): Promise<StoredSchedule[]>;
  inspect(id: string): Promise<StoredSchedule>;
  isRunning(id: string): boolean;
  runForTrigger(id: string, trigger: RunTrigger): Promise<unknown>;
  pause(id: string, reason?: string): Promise<unknown>;
}
const SeenEventsSchema = z.array(z.object({ id: z.string(), at: z.number() }));
type SeenEvents = z.infer<typeof SeenEventsSchema>;
type EventRunTrigger = Extract<RunTrigger, { type: "event" }>;

export function validateAutomationTriggers(triggers: AutomationTrigger[]): void {
  for (const trigger of triggers) EventTriggerSchema.parse(trigger);
}

function matchingTriggers(schedule: StoredSchedule, sourceId: string, event: TriggerEvent) {
  return (schedule.triggers ?? [])
    .map((trigger) => EventTriggerSchema.safeParse(trigger))
    .filter((trigger) => trigger.success)
    .map((trigger) => trigger.data)
    .filter(
      (trigger) =>
        trigger.source === sourceId &&
        trigger.event === event.event &&
        Object.entries(trigger.match ?? {}).every(([key, value]) => event.data?.[key] === value),
    );
}

function causalContext(schedules: StoredSchedule[], event: TriggerEvent) {
  const cause = event.causedBy
    ? schedules.find((schedule) => schedule.runs.some((run) => run.id === event.causedBy))
    : undefined;
  const trigger = cause?.runs.find((run) => run.id === event.causedBy)?.trigger;
  return { cause, depth: (trigger?.type === "event" ? trigger.depth : 0) + 1 };
}

export class AutomationTriggers {
  private readonly pending = new Map<string, EventRunTrigger>();
  private readonly busy = new Set<string>();
  private readonly pluginRates = new Map<string, number[]>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly options: {
      paseoHome: string;
      service: TriggerService;
      logger: Logger;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  emit(pluginId: string, sourceId: string, event: TriggerEvent): Promise<EmitResult> {
    if (this.closed) return Promise.reject(new Error("Automation event router is stopping"));
    if (!/^[a-z][a-z0-9._-]*$/.test(sourceId))
      return Promise.reject(new Error("Invalid event source"));
    const checked = TriggerEventSchema.parse(event);
    if (Buffer.byteLength(JSON.stringify(checked.data ?? {})) > 16_384)
      return Promise.reject(new Error("Event data exceeds 16KB"));
    const now = this.now().getTime();
    const recent = (this.pluginRates.get(pluginId) ?? []).filter((at) => at > now - 60_000);
    if (recent.length >= 120)
      return Promise.reject(new Error("Plugin event limit exceeded (120/minute)"));
    this.pluginRates.set(pluginId, [...recent, now]);
    const result = this.queue.then(() => this.route(sourceId, checked));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async remember(sourceId: string, id: string, now: number): Promise<boolean> {
    const dir = join(this.options.paseoHome, "automation-events");
    const path = join(dir, `${sourceId}.json`);
    let seen: SeenEvents;
    try {
      seen = SeenEventsSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        const backup = `${path}.corrupt-${now}`;
        await rename(path, backup);
        this.options.logger.warn(
          { err: error, path, backup },
          "Rebuilding unreadable event deduplication file",
        );
      }
      seen = [];
    }
    seen = seen.filter((entry) => entry.at > now - 7 * 86_400_000).slice(-1000);
    if (seen.some((entry) => entry.id === id)) return false;
    await mkdir(dir, { recursive: true });
    await writeJsonFileAtomic(path, [...seen.slice(-999), { id, at: now }]);
    return true;
  }

  private async route(sourceId: string, event: TriggerEvent): Promise<EmitResult> {
    const now = this.now().getTime();
    const result: EmitResult = { status: "accepted", started: [], deferred: 0, skipped: 0 };
    if (!(await this.remember(sourceId, event.id, now))) return { ...result, status: "duplicate" };
    const schedules = await this.options.service.list();
    const { cause, depth } = causalContext(schedules, event);
    if (depth > 3) {
      this.options.logger.warn(
        { sourceId, eventId: event.id, depth },
        "Event depth limit exceeded",
      );
      return { ...result, skipped: 1 };
    }
    let stale = 0;
    for (const schedule of schedules) {
      if (schedule.status !== "active") continue;
      const matches = matchingTriggers(schedule, sourceId, event);
      if (matches.length === 0) continue;
      const occurredAt = event.occurredAt ? Date.parse(event.occurredAt) : now;
      if (
        occurredAt < Date.parse(schedule.createdAt) ||
        matches.every((trigger) => occurredAt < now - (trigger.maxAgeMs ?? 3_600_000))
      ) {
        stale++;
        result.skipped++;
        continue;
      }
      if (cause?.id === schedule.id) {
        result.skipped++;
        continue;
      }
      const trigger: EventRunTrigger = {
        type: "event",
        source: sourceId,
        event: event.event,
        eventId: event.id,
        depth,
        subject: event.subject,
        data: event.data,
      };
      if (this.busy.has(schedule.id) || this.options.service.isRunning(schedule.id)) {
        const previous = this.pending.get(schedule.id);
        this.pending.set(schedule.id, {
          ...trigger,
          coalesced: (previous?.coalesced ?? 0) + (previous ? 1 : 0),
        });
        result.deferred++;
      } else if (await this.launch(schedule, trigger)) result.started.push(schedule.id);
      else result.skipped++;
    }
    if (onlyStaleEvents(result, stale)) result.status = "stale";
    return result;
  }

  private async launch(schedule: StoredSchedule, trigger: EventRunTrigger): Promise<boolean> {
    if (this.closed || schedule.status !== "active") return false;
    const hourAgo = this.now().getTime() - 3_600_000;
    const count = schedule.runs
      .slice(schedule.eventRateLimitRunOffset ?? 0)
      .filter((run) => run.trigger?.type === "event" && Date.parse(run.startedAt) > hourAgo).length;
    if (count >= (schedule.eventRateLimit ?? 20)) {
      try {
        await this.options.service.pause(schedule.id, "rate-limit");
      } catch (error) {
        if (!(error instanceof ScheduleStateConflictError)) throw error;
      }
      this.pending.delete(schedule.id);
      return false;
    }
    this.busy.add(schedule.id);
    void this.options.service
      .runForTrigger(schedule.id, trigger)
      .catch((error) => {
        this.options.logger.error({ err: error, scheduleId: schedule.id }, "Event run failed");
      })
      .finally(() => {
        this.busy.delete(schedule.id);
        void this.drain(schedule.id);
      });
    return true;
  }

  async drain(id: string): Promise<void> {
    if (this.closed || this.busy.has(id) || this.options.service.isRunning(id)) return;
    const trigger = this.pending.get(id);
    if (!trigger) return;
    this.pending.delete(id);
    this.busy.add(id);
    try {
      if (!(await this.launch(await this.options.service.inspect(id), trigger)))
        this.busy.delete(id);
    } catch (error) {
      this.busy.delete(id);
      this.options.logger.warn({ err: error, scheduleId: id }, "Deferred event run discarded");
    }
  }

  close(): void {
    this.closed = true;
    this.pending.clear();
  }
}

function onlyStaleEvents(result: EmitResult, stale: number): boolean {
  return (
    stale > 0 && result.started.length === 0 && result.deferred === 0 && stale === result.skipped
  );
}
