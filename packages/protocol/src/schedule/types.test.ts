import { describe, expect, test } from "vitest";

import {
  ScheduleCadenceSchema,
  ScheduleTargetSchema,
  AutomationTriggerSchema,
  StoredScheduleSchema,
} from "./types.js";

test("accepts action targets, no clock and unknown future trigger types", () => {
  expect(ScheduleCadenceSchema.parse({ type: "none" })).toEqual({ type: "none" });
  expect(
    ScheduleTargetSchema.parse({
      type: "action",
      action: "demo.echo",
      params: { text: "hi" },
      timeoutMs: 500,
    }),
  ).toMatchObject({ type: "action", timeoutMs: 500 });
  expect(AutomationTriggerSchema.parse({ type: "future", key: "value" })).toEqual({
    type: "future",
    key: "value",
  });
  expect(StoredScheduleSchema.shape.triggers.isOptional()).toBe(true);
  expect(StoredScheduleSchema.shape.source.isOptional()).toBe(true);
});

describe("ScheduleCadenceSchema", () => {
  test("accepts existing UTC cron cadence without a time zone", () => {
    expect(ScheduleCadenceSchema.parse({ type: "cron", expression: "0 9 * * *" })).toEqual({
      type: "cron",
      expression: "0 9 * * *",
    });
  });

  test("accepts timezone-aware cron cadence", () => {
    expect(
      ScheduleCadenceSchema.parse({
        type: "cron",
        expression: "0 9 * * *",
        timezone: "America/New_York",
      }),
    ).toEqual({
      type: "cron",
      expression: "0 9 * * *",
      timezone: "America/New_York",
    });
  });
});

describe("ScheduleTargetSchema", () => {
  test("keeps the workspace a new-agent schedule runs in", () => {
    const target = {
      type: "new-agent",
      config: { provider: "claude", cwd: "/tmp/project", workspaceId: "wks_weekly" },
    };

    expect(ScheduleTargetSchema.parse(target)).toEqual(target);
  });

  test("parses stored new-agent schedules that predate the workspace field", () => {
    const target = { type: "new-agent", config: { provider: "claude", cwd: "/tmp/project" } };

    expect(ScheduleTargetSchema.parse(target)).toEqual(target);
  });

  test("still requires a cwd on stored new-agent schedules", () => {
    expect(() =>
      ScheduleTargetSchema.parse({
        type: "new-agent",
        config: { provider: "claude", workspaceId: "wks_weekly" },
      }),
    ).toThrow();
  });
});
