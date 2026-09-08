import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { FOCUSED_PANE_PLACEMENT } from "@/stores/workspace-layout-actions";
import { navigateToAgent } from "@/utils/navigate-to-agent";

export function usePluginHostNavigation(
  serverId: string,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return useMemo(
    () => ({
      openAgent: ({ agentId }) => navigateToAgent({ serverId, agentId }),
      openWorkspace: ({ workspaceId }) => navigateToWorkspace({ serverId, workspaceId }),
      // Same placement as the core Commits list: the user is working in the
      // focused pane, so the diff lands there rather than beside the plugin panel.
      openCommitDiff: ({ workspaceId, sha }) =>
        navigateToWorkspace({
          serverId,
          workspaceId,
          target: { kind: "commit_diff", sha },
          placement: FOCUSED_PANE_PLACEMENT,
        }),
    }),
    [serverId],
  );
}
