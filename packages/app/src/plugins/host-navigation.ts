import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { useMemo } from "react";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

import { getIsElectron } from "@/constants/platform";
import { useToast } from "@/contexts/toast-api-context";
import { createWorkspaceBrowser } from "@/desktop/browser/store";
import { createPluginHostNavigation } from "./host-navigation-model";
import { createPluginNavigation } from "./navigation";
import { pluginRegistry } from "./registry";
import { resolvePluginSurfaceContribution } from "./surface-contribution";

export function usePluginHostNavigation(
  serverId: string,
): NonNullable<PluginSurfaceProps["navigation"]> {
  const toast = useToast();
  return useMemo(
    () =>
      createPluginHostNavigation(serverId, {
        browserAvailable: getIsElectron(),
        openAgent: navigateToAgent,
        openWorkspace: navigateToWorkspace,
        createBrowser: createWorkspaceBrowser,
        resolveWorkspace: ({ serverId: targetServerId, workspaceId }) =>
          resolveWorkspaceMapKeyByIdentity({
            workspaces: useSessionStore.getState().sessions[targetServerId]?.workspaces,
            workspaceId,
          }),
        hasPluginScreen: ({ serverId: hostId, pluginId, screenId }) => {
          const plugin = pluginRegistry
            .getSnapshot()
            .find((item) => item.serverId === hostId && item.id === pluginId);
          const identity = { kind: "surface" as const, id: screenId };
          return resolvePluginSurfaceContribution(plugin ?? null, identity).surface !== null;
        },
        openPluginScreen: ({ serverId: hostId, pluginId, screenId, params }) =>
          createPluginNavigation({ serverId: hostId, workspaceId: null }).openSurface(
            pluginId,
            screenId,
            params,
          ),
        showError: toast.error,
      }),
    [serverId, toast],
  );
}
