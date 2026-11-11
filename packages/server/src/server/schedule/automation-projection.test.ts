import { z } from "zod";
import { expect, test } from "vitest";
import {
  StoredScheduleSchema,
  ScheduleTargetSchema,
  ScheduleCadenceSchema,
  ScheduleRunSchema,
} from "@getpaseo/protocol/schedule/types";
import { projectAutomation } from "./automation-projection.js";

// Snapshot the pre-extension union members and fields, rather than validating against the widened union.
const OldScheduleSchema = StoredScheduleSchema.omit({
  triggers: true,
  pauseReason: true,
  source: true,
})
  .extend({
    cadence: z.discriminatedUnion("type", [
      ScheduleCadenceSchema.options[0],
      ScheduleCadenceSchema.options[1],
    ]),
    target: z.discriminatedUnion("type", [
      ScheduleTargetSchema.options[0],
      ScheduleTargetSchema.options[1],
    ]),
    runs: z.array(ScheduleRunSchema.omit({ trigger: true }).strict()),
  })
  .strict();
const record = StoredScheduleSchema.parse({
  id: "old",
  name: null,
  prompt: "test",
  cadence: { type: "cron", expression: "0 9 * * *" },
  target: { type: "new-agent", config: { provider: "claude", cwd: "/example-repo" } },
  status: "active",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  nextRunAt: null,
  lastRunAt: null,
  pausedAt: null,
  expiresAt: null,
  maxRuns: null,
  runs: [],
});

test("old persisted records parse without adding extension fields", () => {
  expect(StoredScheduleSchema.parse(record)).toEqual(record);
});

test("projects both schedule and run fields into the old strict schemas", () => {
  const extended = {
    ...record,
    triggers: [{ type: "event", source: "demo", event: "ping" }],
    pauseReason: "rate-limit",
    source: {
      kind: "project" as const,
      projectKey: "project",
      automationId: "test",
      fingerprint: "fp",
    },
    runs: [
      {
        id: "run",
        scheduledFor: "now",
        startedAt: "now",
        endedAt: null,
        status: "running" as const,
        agentId: null,
        output: null,
        error: null,
        trigger: { type: "manual" as const },
      },
    ],
  };
  const projected = projectAutomation(extended, false);
  expect(OldScheduleSchema.safeParse(projected).success).toBe(true);
  expect(
    OldScheduleSchema.omit({ runs: true }).safeParse(
      projected && (({ runs: _runs, ...summary }) => summary)(projected),
    ).success,
  ).toBe(true);
  expect(projected).not.toHaveProperty("triggers");
  expect(projected?.runs[0]).not.toHaveProperty("trigger");
  expect(projectAutomation(extended, true)).toBe(extended);
});

test("hides records an old client cannot parse", () => {
  expect(projectAutomation({ ...record, cadence: { type: "none" } }, false)).toBeNull();
  expect(
    projectAutomation({ ...record, target: { type: "action", action: "echo", params: {} } }, false),
  ).toBeNull();
});
