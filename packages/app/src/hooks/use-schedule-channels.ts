import type { ScheduleChannel } from "@getpaseo/protocol/schedule/types";
import { useFetchQuery } from "@/data/query";
import { i18n } from "@/i18n/i18next";
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
        throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
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

/** True when the host stores triggers and plugin actions. */
export function useAutomationsSupported(serverId: string | null | undefined): boolean {
  // COMPAT(automations): fork-only until upstream lands its own shape.
  return useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.serverInfo?.features?.automations === true : false,
  );
}

/** Plugin actions and event sources the host offers, for the automation form. */
export function useAutomationCatalog(serverId: string | null | undefined, enabled: boolean) {
  const id = serverId ?? "";
  const query = useFetchQuery({
    queryKey: ["automation-catalog", id] as const,
    queryFn: async () => {
      const client = useSessionStore.getState().sessions[id]?.client ?? null;
      if (!client) throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
      const [actions, triggers] = await Promise.all([
        client.scheduleActions(),
        client.scheduleTriggers(),
      ]);
      if (actions.error || triggers.error) throw new Error(actions.error ?? triggers.error ?? "");
      return { actions: actions.actions, sources: triggers.triggers };
    },
    enabled: enabled && id.length > 0,
    dataShape: "value",
    staleTimeMs: 30_000,
  });
  return { catalog: query.data, error: query.error ? toErrorMessage(query.error) : null };
}
