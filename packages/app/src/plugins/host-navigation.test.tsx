/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { router } from "expo-router";
import { usePluginHostNavigation } from "./host-navigation";
import { pluginRegistry } from "./registry";

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: vi.fn(),
}));
const { toastError, toastApi } = vi.hoisted(() => {
  const error = vi.fn();
  return { toastError: error, toastApi: { show: vi.fn(), error } };
});
vi.mock("@/contexts/toast-api-context", () => ({
  useToast: () => toastApi,
}));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: vi.fn(),
}));

const navigateToAgentMock = vi.mocked(navigateToAgent);
const navigateToWorkspaceMock = vi.mocked(navigateToWorkspace);

describe("usePluginHostNavigation", () => {
  beforeEach(() => {
    navigateToAgentMock.mockReset();
    navigateToWorkspaceMock.mockReset();
    toastError.mockReset();
    vi.mocked(router.push).mockReset();
  });

  it("opens an installed plugin's screen by route, and toasts when it is missing", () => {
    vi.spyOn(pluginRegistry, "getSnapshot").mockReturnValue([
      { serverId: "host-1", id: "other", surfaces: [{ id: "detail" }] } as never,
    ]);
    const { result } = renderHook(() => usePluginHostNavigation("host-1"));

    act(() => result.current.openPluginScreen!("other", "detail", { run: "a b" }));
    expect(router.push).toHaveBeenCalledWith(
      "/h/host-1/plugin/other/surface/detail?param.run=a%20b",
    );

    expect(() => result.current.openPluginScreen!("other", "gone")).toThrow("unavailable");
    expect(toastError).toHaveBeenCalledWith("Plugin screen is unavailable: other/gone");
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("opens agents and workspaces on the rendering host", () => {
    const { result } = renderHook(() => usePluginHostNavigation("host-1"));

    act(() => result.current.openAgent({ agentId: "agent-1" }));
    act(() => result.current.openWorkspace({ workspaceId: "workspace-1" }));

    expect(navigateToAgentMock).toHaveBeenCalledWith({ serverId: "host-1", agentId: "agent-1" });
    expect(navigateToWorkspaceMock).toHaveBeenCalledWith({
      serverId: "host-1",
      workspaceId: "workspace-1",
    });
  });

  it("keeps the capability stable until the rendering host changes", () => {
    const { result, rerender } = renderHook(({ serverId }) => usePluginHostNavigation(serverId), {
      initialProps: { serverId: "host-1" },
    });
    const initialNavigation = result.current;

    rerender({ serverId: "host-1" });
    expect(result.current).toBe(initialNavigation);

    rerender({ serverId: "host-2" });
    expect(result.current).not.toBe(initialNavigation);

    act(() => result.current.openAgent({ agentId: "agent-2" }));
    act(() => result.current.openWorkspace({ workspaceId: "workspace-2" }));
    expect(navigateToAgentMock).toHaveBeenCalledWith({ serverId: "host-2", agentId: "agent-2" });
    expect(navigateToWorkspaceMock).toHaveBeenCalledWith({
      serverId: "host-2",
      workspaceId: "workspace-2",
    });
  });
});
