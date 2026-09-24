import type { ScheduleChannel } from "@getpaseo/protocol/schedule/types";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import { toErrorMessage } from "@/utils/error-messages";

export function scheduleChannelsQueryKey(serverId: string) {
  return ["schedule-channels", serverId] as const;
}

/**
 * True when the host can store a schedule delivery target and list channels. Older daemons lack
 * both, so callers hide the delivery UI instead of sending a field the daemon would reject.
 */
export function useScheduleDeliverySupported(serverId: string | null | undefined): boolean {
  // COMPAT(scheduleDelivery): fork-only until upstream lands its own shape.
  return useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.serverInfo?.features?.scheduleDelivery === true : false,
  );
}

export interface UseScheduleChannelsResult {
  channels: ScheduleChannel[] | undefined;
  isLoading: boolean;
  error: string | null;
}

export function useScheduleChannels(input: {
  serverId: string | null | undefined;
  enabled: boolean;
}): UseScheduleChannelsResult {
  const serverId = input.serverId ?? "";
  const query = useFetchQuery({
    queryKey: scheduleChannelsQueryKey(serverId),
    queryFn: async () => {
      const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
      if (!client) {
        throw new Error("Host is not connected");
      }
      const payload = await client.scheduleChannels();
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.channels;
    },
    enabled: input.enabled && serverId.length > 0,
    dataShape: "list",
    staleTimeMs: 30_000,
  });
  return {
    channels: query.data,
    isLoading: query.isLoading,
    error: query.error ? toErrorMessage(query.error) : null,
  };
}
