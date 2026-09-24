import { describe, expect, test, vi } from "vitest";

import { selectDaemonTarget } from "../../utils/daemon-target.js";

import { createScheduleCommand } from "./index.js";
import { toScheduleChannelRows } from "./schema.js";
import {
  compileEveryPresetToCron,
  parseDeliverFlag,
  parseScheduleCreateInput,
  parseScheduleUpdateInput,
} from "./shared.js";

const baseOptions = {
  daemonTarget: selectDaemonTarget({ home: process.cwd() }, {}),
  prompt: "do the thing",
  every: "5m",
  provider: "claude",
};

const baseCron = {
  daemonTarget: selectDaemonTarget({ home: process.cwd() }, {}),
  prompt: "do the thing",
  cron: "0 9 * * *",
  provider: "claude",
};

describe("parseScheduleCreateInput cwd/host validation", () => {
  test("no host, no cwd → defaults to process.cwd()", () => {
    const input = parseScheduleCreateInput(baseOptions);
    expect(input.target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: process.cwd() },
    });
  });

  test("no host, with cwd → uses provided cwd", () => {
    const input = parseScheduleCreateInput({ ...baseOptions, cwd: "/some/other/path" });
    expect(input.target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: "/some/other/path" },
    });
  });

  test("host with cwd → uses provided cwd", () => {
    const input = parseScheduleCreateInput({
      ...baseOptions,
      daemonTarget: selectDaemonTarget({ host: "dev:12345" }, {}),
      cwd: "/remote/project",
    });
    expect(input.target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: "/remote/project" },
    });
  });

  test("host without cwd → throws MISSING_CWD", () => {
    expect(() =>
      parseScheduleCreateInput({
        ...baseOptions,
        daemonTarget: selectDaemonTarget({ host: "dev:12345" }, {}),
      }),
    ).toThrow(
      expect.objectContaining({
        code: "MISSING_CWD",
        message: expect.stringContaining("--cwd is required when --host is specified"),
      }),
    );
  });

  test("PASEO_HOST without cwd → throws MISSING_CWD", () => {
    const daemonTarget = selectDaemonTarget({}, { PASEO_HOST: "dev:12345" });

    expect(() => parseScheduleCreateInput({ ...baseOptions, daemonTarget })).toThrow(
      expect.objectContaining({
        code: "MISSING_CWD",
        message: expect.stringContaining("--cwd is required"),
      }),
    );
  });

  test("explicit home beats PASEO_HOST and defaults cwd locally", () => {
    const daemonTarget = selectDaemonTarget({ home: process.cwd() }, { PASEO_HOST: "dev:12345" });
    expect(parseScheduleCreateInput({ ...baseOptions, daemonTarget }).target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: process.cwd() },
    });
  });

  test("host with whitespace-only cwd → throws MISSING_CWD", () => {
    expect(() =>
      parseScheduleCreateInput({
        ...baseOptions,
        daemonTarget: selectDaemonTarget({ host: "dev:12345" }, {}),
        cwd: "   ",
      }),
    ).toThrow(expect.objectContaining({ code: "MISSING_CWD" }));
  });
});

describe("parseScheduleCreateInput first-run timing", () => {
  test("--every compiles to cron and waits for the next slot", () => {
    const input = parseScheduleCreateInput(baseOptions);
    expect(input.cadence).toEqual({ type: "cron", expression: "*/5 * * * *" });
    expect(input.runOnCreate).toBe(false);
  });

  test("--cron with no run-now flag waits for the next cron slot", () => {
    const input = parseScheduleCreateInput(baseCron);
    expect(input.runOnCreate).toBe(false);
  });

  test("--cron with --run-now fires immediately on creation", () => {
    const input = parseScheduleCreateInput({ ...baseCron, runNow: true });
    expect(input.runOnCreate).toBe(true);
  });

  test("--cron with --timezone stores a timezone-aware cadence", () => {
    const input = parseScheduleCreateInput({
      ...baseCron,
      timezone: "  America/New_York  ",
    });

    expect(input.cadence).toEqual({
      type: "cron",
      expression: "0 9 * * *",
      timezone: "America/New_York",
    });
  });

  test("--run-now is orthogonal to a compiled preset", () => {
    const input = parseScheduleCreateInput({ ...baseOptions, runNow: true });
    expect(input.runOnCreate).toBe(true);
  });

  test("--timezone without --cron is rejected", () => {
    expect(() => parseScheduleCreateInput({ ...baseOptions, timezone: "Europe/Zurich" })).toThrow(
      expect.objectContaining({
        code: "INVALID_TIME_ZONE",
        message: "--timezone can only be used with --cron",
      }),
    );
  });
});

describe("parseScheduleCreateInput thinking", () => {
  test("sets the thinking option for each scheduled new-agent run", () => {
    const input = parseScheduleCreateInput({
      ...baseOptions,
      cwd: "/project",
      thinking: "  high  ",
    });

    expect(input.target).toEqual({
      type: "new-agent",
      config: {
        provider: "claude",
        cwd: "/project",
        thinkingOptionId: "high",
      },
    });
  });
});

describe("parseScheduleUpdateInput", () => {
  test("rejects calls with no fields to update", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc" })).toThrow(
      expect.objectContaining({ code: "NO_UPDATES" }),
    );
  });

  test("parses prompt and name updates", () => {
    expect(parseScheduleUpdateInput({ id: "abc", prompt: "  hello  ", name: "  named  " })).toEqual(
      {
        id: "abc",
        name: "named",
        prompt: "hello",
      },
    );
  });

  test("name set to empty string clears the name", () => {
    expect(parseScheduleUpdateInput({ id: "abc", name: "" })).toEqual({
      id: "abc",
      name: null,
    });
  });

  test("rejects empty prompt", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", prompt: "   " })).toThrow(
      expect.objectContaining({ code: "INVALID_PROMPT" }),
    );
  });

  test("compiles --every cadence to cron", () => {
    expect(parseScheduleUpdateInput({ id: "abc", every: "5m" })).toEqual({
      id: "abc",
      cadence: { type: "cron", expression: "*/5 * * * *" },
    });
  });

  test("parses --cron cadence", () => {
    expect(parseScheduleUpdateInput({ id: "abc", cron: "30 9 * * *" })).toEqual({
      id: "abc",
      cadence: { type: "cron", expression: "30 9 * * *" },
    });
  });

  test("parses --cron cadence with --timezone", () => {
    expect(
      parseScheduleUpdateInput({
        id: "abc",
        cron: "30 9 * * *",
        timezone: "Europe/Zurich",
      }),
    ).toEqual({
      id: "abc",
      cadence: { type: "cron", expression: "30 9 * * *", timezone: "Europe/Zurich" },
    });
  });

  test("rejects passing both --every and --cron", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", every: "5m", cron: "0 9 * * *" })).toThrow(
      expect.objectContaining({ code: "INVALID_CADENCE" }),
    );
  });

  test("rejects --timezone without --cron", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", timezone: "Europe/Zurich" })).toThrow(
      expect.objectContaining({ code: "INVALID_TIME_ZONE" }),
    );
  });

  test("parses provider/model shorthand and explicit mode", () => {
    expect(
      parseScheduleUpdateInput({
        id: "abc",
        provider: "codex/gpt-5",
        mode: "full-access",
        cwd: "/tmp/proj",
      }),
    ).toEqual({
      id: "abc",
      newAgentConfig: {
        provider: "codex",
        model: "gpt-5",
        modeId: "full-access",
        cwd: "/tmp/proj",
      },
    });
  });

  test("--mode with empty value clears the modeId", () => {
    expect(parseScheduleUpdateInput({ id: "abc", mode: "" })).toEqual({
      id: "abc",
      newAgentConfig: { modeId: null },
    });
  });

  test("rejects empty --cwd", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", cwd: "   " })).toThrow(
      expect.objectContaining({ code: "INVALID_CWD" }),
    );
  });

  test("--max-runs sets a positive integer; --no-max-runs clears", () => {
    expect(parseScheduleUpdateInput({ id: "abc", maxRuns: "3" })).toEqual({
      id: "abc",
      maxRuns: 3,
    });
    expect(parseScheduleUpdateInput({ id: "abc", clearMaxRuns: true })).toEqual({
      id: "abc",
      maxRuns: null,
    });
  });

  test("rejects passing both --max-runs and --no-max-runs", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", maxRuns: "3", clearMaxRuns: true })).toThrow(
      expect.objectContaining({ code: "CONFLICTING_MAX_RUNS" }),
    );
  });

  test("--expires-in computes an absolute timestamp; --no-expires-in clears", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      expect(parseScheduleUpdateInput({ id: "abc", expiresIn: "1h" })).toEqual({
        id: "abc",
        expiresAt: "2026-01-01T01:00:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }

    expect(parseScheduleUpdateInput({ id: "abc", clearExpires: true })).toEqual({
      id: "abc",
      expiresAt: null,
    });
  });

  test("rejects passing both --expires-in and --no-expires-in", () => {
    expect(() =>
      parseScheduleUpdateInput({ id: "abc", expiresIn: "1h", clearExpires: true }),
    ).toThrow(expect.objectContaining({ code: "CONFLICTING_EXPIRES" }));
  });
});

describe("--deliver", () => {
  test("splits channel and address on the first colon", () => {
    expect(parseDeliverFlag("chat:general")).toEqual({ channel: "chat", to: "general" });
    expect(parseDeliverFlag(" chat : room:42 ")).toEqual({ channel: "chat", to: "room:42" });
  });

  test.each(["chat", ":general", "chat:", " : ", ""])("rejects %j", (value) => {
    expect(() => parseDeliverFlag(value)).toThrow(
      expect.objectContaining({ code: "INVALID_DELIVERY" }),
    );
  });

  test("create sends the delivery target", () => {
    expect(parseScheduleCreateInput({ ...baseCron, deliver: "chat:general" }).delivery).toEqual({
      channel: "chat",
      to: "general",
    });
    expect(parseScheduleCreateInput(baseCron)).not.toHaveProperty("delivery");
  });

  test("update sets the target, and false (from --no-deliver) clears it", () => {
    expect(parseScheduleUpdateInput({ id: "abc", deliver: "chat:general" })).toEqual({
      id: "abc",
      delivery: { channel: "chat", to: "general" },
    });
    expect(parseScheduleUpdateInput({ id: "abc", deliver: false })).toEqual({
      id: "abc",
      delivery: null,
    });
  });

  test("commander maps --deliver and --no-deliver onto the deliver option", async () => {
    const parseUpdate = async (args: string[]) => {
      const schedule = createScheduleCommand();
      const update = schedule.commands.find((command) => command.name() === "update");
      let captured: unknown;
      update?.action((_id: string, options: unknown) => {
        captured = options;
      });
      await schedule.parseAsync(["update", "abc", ...args], { from: "user" });
      return captured;
    };
    expect(await parseUpdate(["--deliver", "chat:general"])).toMatchObject({
      deliver: "chat:general",
    });
    expect(await parseUpdate(["--no-deliver"])).toMatchObject({ deliver: false });
  });
});

describe("schedule channels rows", () => {
  test("one row per destination, and one explaining a channel without any", () => {
    expect(
      toScheduleChannelRows({
        id: "chat",
        label: "Chat",
        pluginId: "notify",
        destinations: [
          { to: "room-1", label: "Team room" },
          { to: "room-2", label: "Releases" },
        ],
      }),
    ).toEqual([
      {
        key: "chat:room-1",
        channel: "chat",
        label: "Chat",
        destination: "Team room",
        to: "room-1",
      },
      {
        key: "chat:room-2",
        channel: "chat",
        label: "Chat",
        destination: "Releases",
        to: "room-2",
      },
    ]);
    expect(
      toScheduleChannelRows({ id: "mail", label: null, pluginId: "notify", destinations: [] }),
    ).toEqual([
      { key: "mail", channel: "mail", label: null, destination: "(none listed)", to: null },
    ]);
    expect(
      toScheduleChannelRows({
        id: "pager",
        label: null,
        pluginId: "notify",
        destinations: null,
        error: "token expired",
      }),
    ).toEqual([
      {
        key: "pager",
        channel: "pager",
        label: null,
        destination: "(unavailable: token expired)",
        to: null,
      },
    ]);
  });
});

describe("compileEveryPresetToCron", () => {
  test.each([
    ["1m", "*/1 * * * *"],
    ["15m", "*/15 * * * *"],
    ["1h", "0 * * * *"],
    ["6h", "0 */6 * * *"],
    ["1d", "0 0 * * *"],
  ])("compiles %s", (value, expected) => {
    expect(compileEveryPresetToCron(value)).toBe(expected);
  });

  test.each(["30s", "7m", "5h", "2d"])("rejects rolling interval %s", (value) => {
    expect(() => compileEveryPresetToCron(value)).toThrow(
      expect.objectContaining({ code: "UNREPRESENTABLE_CADENCE" }),
    );
  });

  test.each(["15minutes", "junk15m", "1h-nope"])("rejects malformed preset %s", (value) => {
    expect(() => compileEveryPresetToCron(value)).toThrow("Invalid duration format");
  });
});
