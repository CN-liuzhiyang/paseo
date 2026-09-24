import type { OutputSchema } from "../../output/index.js";
import { formatCadence, formatDelivery, formatTarget, type ScheduleRow } from "./shared.js";
import type {
  ScheduleChannelRecord,
  ScheduleRecord,
  ScheduleRunDelivery,
  ScheduleRunRecord,
} from "./types.js";

export const scheduleSchema: OutputSchema<ScheduleRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 10 },
    { header: "NAME", field: "name", width: 20 },
    { header: "CADENCE", field: "cadence", width: 20 },
    { header: "TARGET", field: "target", width: 20 },
    { header: "STATUS", field: "status", width: 12 },
    { header: "NEXT RUN", field: "nextRunAt", width: 24 },
  ],
};

export interface ScheduleInspectRow {
  key: string;
  value: string;
}

export function createScheduleInspectSchema(
  record: ScheduleRecord,
): OutputSchema<ScheduleInspectRow> {
  return {
    idField: "key",
    columns: [
      { header: "KEY", field: "key", width: 18 },
      { header: "VALUE", field: "value", width: 80 },
    ],
    serialize: () => record,
  };
}

export interface ScheduleLogRow {
  id: string;
  status: string;
  startedAt: string;
  agentId: string | null;
  output: string | null;
  error: string | null;
  delivery: string | null;
}

export const scheduleLogSchema: OutputSchema<ScheduleLogRow> = {
  idField: "id",
  columns: [
    { header: "RUN ID", field: "id", width: 14 },
    { header: "STATUS", field: "status", width: 12 },
    { header: "STARTED", field: "startedAt", width: 24 },
    { header: "AGENT", field: "agentId", width: 12 },
    { header: "OUTPUT", field: "output", width: 40 },
    { header: "ERROR", field: "error", width: 40 },
    { header: "DELIVERY", field: "delivery", width: 30 },
  ],
};

function formatRunDelivery(delivery: ScheduleRunDelivery | undefined): string | null {
  if (!delivery) return null;
  return delivery.status === "failed" && delivery.error
    ? `failed: ${delivery.error}`
    : delivery.status;
}

export function toScheduleLogRow(run: ScheduleRunRecord): ScheduleLogRow {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    agentId: run.agentId ? run.agentId.slice(0, 7) : null,
    output: run.output,
    error: run.error,
    delivery: formatRunDelivery(run.delivery),
  };
}

export interface ScheduleChannelRow {
  key: string;
  channel: string;
  label: string | null;
  destination: string | null;
  to: string | null;
}

export const scheduleChannelSchema: OutputSchema<ScheduleChannelRow> = {
  idField: "key",
  columns: [
    { header: "CHANNEL", field: "channel", width: 16 },
    { header: "LABEL", field: "label", width: 20 },
    { header: "DESTINATION", field: "destination", width: 28 },
    { header: "TO", field: "to", width: 40 },
  ],
};

/** One row per destination; a channel without any gets one row saying why. */
export function toScheduleChannelRows(channel: ScheduleChannelRecord): ScheduleChannelRow[] {
  const base = { channel: channel.id, label: channel.label };
  if (channel.destinations === null) {
    const reason = channel.error ?? "unknown error";
    return [{ ...base, key: channel.id, destination: `(unavailable: ${reason})`, to: null }];
  }
  if (channel.destinations.length === 0) {
    return [{ ...base, key: channel.id, destination: "(none listed)", to: null }];
  }
  return channel.destinations.map((destination) => ({
    ...base,
    key: `${channel.id}:${destination.to}`,
    destination: destination.label,
    to: destination.to,
  }));
}

export function createScheduleInspectRows(schedule: ScheduleRecord): ScheduleInspectRow[] {
  return [
    { key: "Id", value: schedule.id },
    { key: "Name", value: schedule.name ?? "null" },
    { key: "Prompt", value: schedule.prompt },
    {
      key: "Cadence",
      value:
        schedule.cadence.type === "cron"
          ? formatCadence(schedule.cadence)
          : `every:${schedule.cadence.everyMs}ms`,
    },
    { key: "Target", value: formatTarget(schedule.target) },
    { key: "Status", value: schedule.status },
    { key: "CreatedAt", value: schedule.createdAt },
    { key: "UpdatedAt", value: schedule.updatedAt },
    { key: "NextRunAt", value: schedule.nextRunAt ?? "null" },
    { key: "LastRunAt", value: schedule.lastRunAt ?? "null" },
    { key: "PausedAt", value: schedule.pausedAt ?? "null" },
    { key: "ExpiresAt", value: schedule.expiresAt ?? "null" },
    { key: "MaxRuns", value: schedule.maxRuns == null ? "null" : `${schedule.maxRuns}` },
    { key: "Delivery", value: formatDelivery(schedule.delivery) ?? "null" },
    { key: "RunCount", value: `${schedule.runs.length}` },
  ];
}
