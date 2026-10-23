import type { PluginScreenParams, PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";
import { FOCUSED_PANE_PLACEMENT } from "@/stores/workspace-layout-actions";
import { isHttpUrl } from "@/utils/http-url";
import { parsePluginScreenParams } from "./routes";

interface HostNavigationOwner {
  browserAvailable: boolean;
  openAgent(input: { serverId: string; agentId: string }): void;
  openWorkspace(input: NavigateToWorkspaceInput): void;
  resolveWorkspace(input: { serverId: string; workspaceId: string }): string | null;
  createBrowser(input: { initialUrl: string }): { browserId: string };
  showError(message: string): void;
  hasPluginScreen(input: { serverId: string; pluginId: string; screenId: string }): boolean;
  openPluginScreen(input: {
    serverId: string;
    pluginId: string;
    screenId: string;
    params: PluginScreenParams;
  }): void;
}

export function createPluginHostNavigation(
  serverId: string,
  owner: HostNavigationOwner,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return {
    openAgent: ({ agentId, serverId: targetServerId }) =>
      owner.openAgent({ serverId: targetServerId ?? serverId, agentId }),
    openWorkspace: ({ workspaceId, serverId: targetServerId }) =>
      owner.openWorkspace({ serverId: targetServerId ?? serverId, workspaceId }),
    // Same placement as the core Commits list: the user is working in the
    // focused pane, so the diff lands there rather than beside the plugin panel.
    openCommitDiff: ({ workspaceId, sha, serverId: targetServerId }) =>
      owner.openWorkspace({
        serverId: targetServerId ?? serverId,
        workspaceId,
        target: { kind: "commit_diff", sha },
        placement: FOCUSED_PANE_PLACEMENT,
      }),
    // Navigation only: the target plugin gets string route params, as from a deep link, and nothing
    // else. A failure is thrown to the caller and also toasted, for a plugin that does not catch it.
    openPluginScreen: (pluginId, screenId, params) => {
      try {
        if (typeof pluginId !== "string" || typeof screenId !== "string") {
          throw new Error("openPluginScreen takes (pluginId, screenId, params?)");
        }
        const target = { serverId, pluginId, screenId };
        const parsed = parsePluginScreenParams(params);
        if (!owner.hasPluginScreen(target)) {
          throw new Error(`Plugin screen is unavailable: ${pluginId}/${screenId}`);
        }
        owner.openPluginScreen({ ...target, params: parsed });
      } catch (error) {
        owner.showError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    openBrowser: owner.browserAvailable
      ? ({ url, workspaceId, serverId: targetServerId }) => {
          if (!isHttpUrl(url)) throw new Error("Only absolute HTTP(S) URLs are supported.");
          if (!workspaceId.trim()) throw new Error("workspaceId is required.");
          const destinationServerId = targetServerId ?? serverId;
          const destinationWorkspaceId = owner.resolveWorkspace({
            serverId: destinationServerId,
            workspaceId,
          });
          if (!destinationWorkspaceId)
            throw new Error("Workspace is unavailable on the requested host.");
          const { browserId } = owner.createBrowser({ initialUrl: url });
          owner.openWorkspace({
            serverId: destinationServerId,
            workspaceId: destinationWorkspaceId,
            target: { kind: "browser", browserId },
          });
        }
      : undefined,
  };
}
