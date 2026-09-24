import type {
  ScheduleChannel,
  ScheduleDelivery,
  ScheduleLastDelivery,
} from "@getpaseo/protocol/schedule/types";
import { formatTimeAgo } from "@/utils/time";

/** Option value for "deliver nowhere". Every other value is produced by `deliveryOptionValue`. */
export const NO_DELIVERY_VALUE = "none";
const UNAVAILABLE_PREFIX = "unavailable:";
const LAST_DELIVERY_ERROR_MAX_LENGTH = 80;

export interface ScheduleDeliveryOption {
  id: string;
  value: string;
  label: string;
  description?: string;
  testID: string;
  /** What choosing the option sets; undefined for entries that cannot be chosen. */
  delivery: ScheduleDelivery | null | undefined;
  unavailable: boolean;
}

export type ScheduleDeliveryFieldModel =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "ready"; options: ScheduleDeliveryOption[] };

export function deliveryOptionValue(delivery: ScheduleDelivery | null): string {
  return delivery ? JSON.stringify([delivery.channel, delivery.to]) : NO_DELIVERY_VALUE;
}

function channelLabel(channel: Pick<ScheduleChannel, "id" | "label">): string {
  return channel.label?.trim() || channel.id;
}

export function formatRawDelivery(delivery: ScheduleDelivery): string {
  return `${delivery.channel}:${delivery.to}`;
}

/**
 * The options of the "Deliver results" select: None, every destination the host's channels offer,
 * the schedule's current target when no channel offers it any more, and one disabled entry per
 * channel that could not list its destinations.
 */
export function buildScheduleDeliveryOptions(
  channels: readonly ScheduleChannel[],
  current: ScheduleDelivery | null,
): ScheduleDeliveryOption[] {
  const options: ScheduleDeliveryOption[] = [
    {
      id: NO_DELIVERY_VALUE,
      value: NO_DELIVERY_VALUE,
      label: "None",
      testID: "schedule-delivery-option-none",
      delivery: null,
      unavailable: false,
    },
  ];
  let currentOffered = current === null;
  for (const channel of channels) {
    if (channel.destinations === null) {
      options.push({
        id: `${UNAVAILABLE_PREFIX}${channel.id}`,
        value: `${UNAVAILABLE_PREFIX}${channel.id}`,
        label: `${channelLabel(channel)} (unavailable)`,
        description: channel.error ?? "The plugin could not list its destinations.",
        testID: `schedule-delivery-option-unavailable-${channel.id}`,
        delivery: undefined,
        unavailable: true,
      });
      continue;
    }
    for (const destination of channel.destinations) {
      const delivery = { channel: channel.id, to: destination.to };
      const value = deliveryOptionValue(delivery);
      if (current && current.channel === channel.id && current.to === destination.to) {
        currentOffered = true;
      }
      options.push({
        id: value,
        value,
        label: `${channelLabel(channel)} · ${destination.label}`,
        testID: `schedule-delivery-option-${channel.id}-${destination.to}`,
        delivery,
        unavailable: false,
      });
    }
  }
  if (current && !currentOffered) {
    const value = deliveryOptionValue(current);
    options.splice(1, 0, {
      id: value,
      value,
      label: formatRawDelivery(current),
      description: "Not currently offered by any plugin",
      testID: "schedule-delivery-option-current",
      delivery: current,
      unavailable: false,
    });
  }
  return options;
}

export function buildScheduleDeliveryFieldModel(input: {
  channels: readonly ScheduleChannel[] | undefined;
  isLoading: boolean;
  error: string | null;
  current: ScheduleDelivery | null;
}): ScheduleDeliveryFieldModel {
  if (input.error) {
    return { kind: "error", message: input.error };
  }
  if (!input.channels) {
    return input.isLoading ? { kind: "loading" } : { kind: "empty" };
  }
  if (input.channels.length === 0 && input.current === null) {
    return { kind: "empty" };
  }
  return { kind: "ready", options: buildScheduleDeliveryOptions(input.channels, input.current) };
}

/** "Chat · Team room" when a channel offers the target, otherwise the raw `channel:to`. */
export function formatDeliveryTarget(
  delivery: ScheduleDelivery,
  channels: readonly ScheduleChannel[] | undefined,
): string {
  const channel = channels?.find((candidate) => candidate.id === delivery.channel);
  const destination = channel?.destinations?.find((candidate) => candidate.to === delivery.to);
  if (!channel || !destination) {
    return formatRawDelivery(delivery);
  }
  return `${channelLabel(channel)} · ${destination.label}`;
}

export interface LastDeliverySummary {
  text: string;
  failed: boolean;
}

export function truncateDeliveryError(error: string): string {
  const singleLine = error.replace(/\s+/g, " ").trim();
  if (singleLine.length <= LAST_DELIVERY_ERROR_MAX_LENGTH) {
    return singleLine;
  }
  return `${singleLine.slice(0, LAST_DELIVERY_ERROR_MAX_LENGTH - 1).trimEnd()}…`;
}

export function summarizeLastDelivery(
  lastDelivery: ScheduleLastDelivery | undefined,
  now: Date = new Date(),
): LastDeliverySummary | null {
  if (!lastDelivery) {
    return null;
  }
  if (lastDelivery.status === "delivered") {
    return { text: `Delivered ${formatTimeAgo(new Date(lastDelivery.at), now)}`, failed: false };
  }
  const reason = lastDelivery.error ? `: ${truncateDeliveryError(lastDelivery.error)}` : "";
  return { text: `Delivery failed${reason}`, failed: true };
}
