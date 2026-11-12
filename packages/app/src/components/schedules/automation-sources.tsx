import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AutomationSource } from "@getpaseo/protocol/schedule/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { i18n } from "@/i18n/i18next";
import { useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { schedulesQueryBaseKey } from "@/schedules/aggregated-schedules";
import { canApproveSource, mergeSources } from "@/schedules/automation-form";
import { useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";

type SourceOperation = "list" | "scan" | "enable" | "disable";

async function callSources(
  serverId: string,
  operation: SourceOperation,
  source?: AutomationSource,
): Promise<AutomationSource[]> {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
  const payload = await client.scheduleSources(
    operation,
    source ? { id: source.id, fingerprint: source.seenFingerprint } : {},
  );
  if (payload.error) throw new Error(payload.error);
  return payload.sources;
}

/** Repository-defined automations found in project paseo.json files, one section per host. */
export function AutomationSourcesSheet({
  visible,
  onClose,
  hosts,
}: {
  visible: boolean;
  onClose: () => void;
  hosts: { serverId: string; label: string }[];
}): ReactElement {
  const { t } = useTranslation();
  const header = useMemo(() => ({ title: t("automation.sourcesTitle") }), [t]);
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="automation-sources-sheet"
    >
      {hosts.map((host) => (
        <HostSources key={host.serverId} serverId={host.serverId} label={host.label} />
      ))}
    </AdaptiveModalSheet>
  );
}

function HostSources({ serverId, label }: { serverId: string; label: string }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const runtime = useHostRuntimeSnapshot(serverId);
  const relayed = !canApproveSource(runtime?.activeConnection?.type, runtime?.connectionStatus);
  const queryKey = ["automation-sources", serverId] as const;
  const query = useFetchQuery({
    queryKey,
    queryFn: () => callSources(serverId, "list"),
    dataShape: "list",
    staleTimeMs: 10_000,
  });
  const run = useCallback(
    async (operation: SourceOperation, source?: AutomationSource) => {
      if (operation === "enable" && source) {
        const confirmed = await confirmDialog({
          title: t("automation.enable"),
          message: t("automation.confirmEnable", {
            name: String(source.definition.name ?? source.automationId),
            fingerprint: source.seenFingerprint.slice(0, 12),
          }),
          confirmLabel: t("automation.enable"),
        });
        if (!confirmed) return;
      }
      setBusy(true);
      setError(null);
      try {
        const updates = await callSources(serverId, operation, source);
        queryClient.setQueryData<AutomationSource[]>(["automation-sources", serverId], (current) =>
          operation === "enable" || operation === "disable"
            ? mergeSources(current, updates)
            : updates,
        );
        await queryClient.invalidateQueries({ queryKey: schedulesQueryBaseKey });
      } catch (caught) {
        setError(toErrorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [queryClient, serverId, t],
  );
  const handleScan = useCallback(() => void run("scan"), [run]);
  const sources = query.data ?? [];
  const message = error ?? (query.error ? toErrorMessage(query.error) : null);
  return (
    <View style={styles.section} testID={`automation-sources-${serverId}`}>
      <View style={styles.header}>
        <Text style={styles.host}>{label}</Text>
        <Button
          variant="outline"
          size="sm"
          onPress={handleScan}
          loading={busy}
          testID="automation-sources-scan"
        >
          {t("automation.scan")}
        </Button>
      </View>
      {message ? <Text style={styles.error}>{message}</Text> : null}
      {query.isSuccess && sources.length === 0 ? (
        <Text style={styles.muted}>{t("automation.sourcesEmpty")}</Text>
      ) : null}
      {sources.map((source) => (
        <SourceRow key={source.id} source={source} relayed={relayed} busy={busy} onRun={run} />
      ))}
    </View>
  );
}

function SourceRow({
  source,
  relayed,
  busy,
  onRun,
}: {
  source: AutomationSource;
  relayed: boolean;
  busy: boolean;
  onRun: (operation: SourceOperation, source: AutomationSource) => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  const handleEnable = useCallback(() => void onRun("enable", source), [onRun, source]);
  const handleDisable = useCallback(() => void onRun("disable", source), [onRun, source]);
  const canEnable = source.state === "pending" || source.state === "disabled";
  return (
    <View style={styles.row} testID={`automation-source-${source.id}`}>
      <Text style={styles.title}>{String(source.definition.name ?? source.automationId)}</Text>
      <Text style={styles.muted}>
        {`${t(`automation.${source.state}`)} · ${source.projectKey} · ${source.seenFingerprint.slice(0, 12)}`}
      </Text>
      {source.error ? <Text style={styles.error}>{source.error}</Text> : null}
      <Text style={styles.code} selectable>
        {JSON.stringify(source.definition, null, 2)}
      </Text>
      {canEnable ? (
        <View style={styles.actions}>
          <Button
            size="sm"
            onPress={handleEnable}
            disabled={relayed || busy || source.error !== undefined}
            testID={`automation-source-enable-${source.id}`}
          >
            {t("automation.enable")}
          </Button>
          {relayed ? <Text style={styles.muted}>{t("automation.relayBlocked")}</Text> : null}
        </View>
      ) : null}
      {source.state === "enabled" ? (
        <Button
          size="sm"
          variant="outline"
          onPress={handleDisable}
          disabled={busy}
          testID={`automation-source-disable-${source.id}`}
        >
          {t("automation.disable")}
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing[3], paddingBottom: theme.spacing[4] },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  host: { color: theme.colors.foreground, fontWeight: theme.fontWeight.medium },
  row: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
  code: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  actions: { gap: theme.spacing[2], alignItems: "flex-start" },
}));
