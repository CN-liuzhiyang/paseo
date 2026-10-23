import { describe, expect, it } from "vitest";
import { createPluginHostNavigation } from "./host-navigation-model";

describe("plugin host navigation", () => {
  function setup(electron = true) {
    const destinations: unknown[] = [];
    const browsers: string[] = [];
    const workspaces = new Set(["selected:one", "remote:two"]);
    const screens = new Set(["selected:other/detail"]);
    const errors: string[] = [];
    const navigation = createPluginHostNavigation("selected", {
      browserAvailable: electron,
      resolveWorkspace: ({ serverId, workspaceId }) =>
        workspaces.has(`${serverId}:${workspaceId}`) ? workspaceId : null,
      openAgent: (input) => destinations.push(input),
      openWorkspace: (input) => destinations.push(input),
      showError: (message) => errors.push(message),
      hasPluginScreen: ({ serverId, pluginId, screenId }) =>
        screens.has(`${serverId}:${pluginId}/${screenId}`),
      openPluginScreen: (input) => destinations.push(input),
      createBrowser: ({ initialUrl }) => {
        browsers.push(initialUrl);
        return { browserId: `browser-${browsers.length}` };
      },
    });
    return { navigation, destinations, browsers, workspaces, errors };
  }

  it("creates and focuses a local browser in the selected or explicit host workspace", () => {
    const { navigation, destinations, browsers } = setup();
    navigation.openBrowser!({ url: "https://example.com/one", workspaceId: "one" });
    navigation.openBrowser!({
      url: "https://example.com/two",
      workspaceId: "two",
      serverId: "remote",
    });
    expect(browsers).toEqual(["https://example.com/one", "https://example.com/two"]);
    expect(destinations).toEqual([
      {
        serverId: "selected",
        workspaceId: "one",
        target: { kind: "browser", browserId: "browser-1" },
      },
      {
        serverId: "remote",
        workspaceId: "two",
        target: { kind: "browser", browserId: "browser-2" },
      },
    ]);
  });

  it("refuses unknown or removed workspaces before creating browser records", () => {
    const { navigation, destinations, browsers, workspaces } = setup();
    expect(() =>
      navigation.openBrowser!({ url: "https://example.com", workspaceId: "missing" }),
    ).toThrow("Workspace is unavailable");
    expect(() =>
      navigation.openBrowser!({
        url: "https://example.com",
        workspaceId: "one",
        serverId: "unknown",
      }),
    ).toThrow("Workspace is unavailable");
    workspaces.delete("selected:one");
    expect(() =>
      navigation.openBrowser!({ url: "https://example.com", workspaceId: "one" }),
    ).toThrow("Workspace is unavailable");
    expect(destinations).toEqual([]);
    expect(browsers).toEqual([]);
  });

  it("exposes no browser capability outside Electron and creates no tabs", () => {
    const { navigation, destinations, browsers } = setup(false);
    expect(navigation.openBrowser).toBeUndefined();
    expect(destinations).toEqual([]);
    expect(browsers).toEqual([]);
  });

  it.each(["javascript:alert(1)", "file:///tmp/file", "/relative", "invalid"])(
    "rejects %s before creating a browser",
    (url) => {
      const { navigation, browsers, destinations } = setup();
      expect(() => navigation.openBrowser!({ url, workspaceId: "one" })).toThrow("HTTP(S)");
      expect(browsers).toEqual([]);
      expect(destinations).toEqual([]);
    },
  );

  it("rejects an empty workspace before creating a browser", () => {
    const { navigation, browsers } = setup();
    expect(() => navigation.openBrowser!({ url: "https://example.com", workspaceId: "" })).toThrow(
      "workspaceId",
    );
    expect(browsers).toEqual([]);
  });

  it("opens another plugin's screen on the rendering host with its params", () => {
    const { navigation, destinations, errors } = setup();
    navigation.openPluginScreen!("other", "detail", { run: "a&b=c" });
    navigation.openPluginScreen!("other", "detail");
    expect(destinations).toEqual([
      { serverId: "selected", pluginId: "other", screenId: "detail", params: { run: "a&b=c" } },
      { serverId: "selected", pluginId: "other", screenId: "detail", params: {} },
    ]);
    expect(errors).toEqual([]);
  });

  it.each([
    ["a plugin that is not installed", "missing", "detail"],
    ["a screen the plugin does not have", "other", "missing"],
  ])("throws and shows an error for %s", (_name, pluginId, screenId) => {
    const { navigation, destinations, errors } = setup();
    expect(() => navigation.openPluginScreen!(pluginId, screenId)).toThrow("unavailable");
    expect(errors).toEqual([`Plugin screen is unavailable: ${pluginId}/${screenId}`]);
    expect(destinations).toEqual([]);
  });

  it.each([
    ["an array", ["x"]],
    ["a non-string value", { run: 1 }],
  ])("rejects params that are %s before navigating", (_name, params) => {
    const { navigation, destinations, errors } = setup();
    expect(() => navigation.openPluginScreen!("other", "detail", params as never)).toThrow(/param/);
    expect(errors).toHaveLength(1);
    expect(destinations).toEqual([]);
  });
});
