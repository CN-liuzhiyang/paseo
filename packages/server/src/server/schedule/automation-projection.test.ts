import { z } from "zod";
import { expect, test } from "vitest";
import {
  StoredScheduleSchema,
  ScheduleTargetSchema,
  ScheduleCadenceSchema,
  ScheduleRunSchema,
} from "@getpaseo/protocol/schedule/types";
import { projectAutomation } from "./automation-projection.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleSession } from "../session/schedule/schedule-session.js";
import type { SessionOutboundMessage } from "../messages.js";
import { ScheduleService } from "./service.js";
import { ScheduleStore } from "./store.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

// Snapshot the pre-extension union members and fields, rather than validating against the widened union.
const OldScheduleSchema = StoredScheduleSchema.omit({
  triggers: true,
  pauseReason: true,
  eventRateLimitRunOffset: true,
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

test("ScheduleSession projects every response for a session without automations capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "automation-projection-"));
  const logger = createTestLogger();
  const service = new ScheduleService({
    paseoHome: root,
    logger,
    agentManager: new AgentManager({ logger }),
    agentStorage: new AgentStorage(root, logger),
    createAgent: async () => {
      throw new Error("unused");
    },
    createDirectoryWorkspace: async () => {
      throw new Error("unused");
    },
    createPaseoWorktreeWorkspace: async () => {
      throw new Error("unused");
    },
    archiveWorkspace: async () => {},
    archiveAgent: async () => {},
    getWorkspace: async () => null,
    listChannels: async () => [],
    deliverToChannel: async () => {},
    validateAction: async () => {},
    runner: async () => ({ agentId: null, output: "ok" }),
  });
  const messages: SessionOutboundMessage[] = [];
  const session = new ScheduleSession({
    supportsAutomations: () => false,
    scheduleService: service,
    logger,
    host: {
      emit: (message) => {
        messages.push(message);
      },
    },
  });
  try {
    await session.handleScheduleCreateRequest({
      type: "schedule/create",
      requestId: "create",
      prompt: "legacy clock",
      cadence: { type: "cron", expression: "0 9 * * *" },
      target: { type: "new-agent", config: { provider: "claude", cwd: root } },
      triggers: [{ type: "event", source: "demo", event: "ping" }],
    });
    const [created] = await service.list();
    const id = created.id;
    const store = new ScheduleStore(join(root, "schedules"), logger);
    await store.update(id, (current) => ({
      ...current,
      pauseReason: "rate-limit",
      eventRateLimitRunOffset: 0,
      source: { kind: "project", projectKey: "project", automationId: "test", fingerprint: "fp" },
      runs: [
        {
          id: "prior",
          scheduledFor: "now",
          startedAt: "now",
          endedAt: "now",
          status: "succeeded",
          agentId: null,
          error: null,
          output: "ok",
          trigger: { type: "manual" },
        },
      ],
    }));
    const hidden = await service.create({
      prompt: "hidden",
      cadence: { type: "none" },
      target: { type: "action", action: "echo", params: {} },
    });
    await session.handleScheduleListRequest({ type: "schedule/list", requestId: "list" });
    await session.handleScheduleInspectRequest({
      type: "schedule/inspect",
      requestId: "inspect",
      scheduleId: id,
    });
    await session.handleScheduleUpdateRequest({
      type: "schedule/update",
      requestId: "update",
      scheduleId: id,
      name: "updated",
    });
    await session.handleSchedulePauseRequest({
      type: "schedule/pause",
      requestId: "pause",
      scheduleId: id,
    });
    await session.handleScheduleResumeRequest({
      type: "schedule/resume",
      requestId: "resume",
      scheduleId: id,
    });
    await session.handleScheduleRunOnceRequest({
      type: "schedule/run-once",
      requestId: "run",
      scheduleId: id,
    });
    await session.handleScheduleLogsRequest({
      type: "schedule/logs",
      requestId: "logs",
      scheduleId: id,
    });
    expect(messages).toHaveLength(8);
    expect(
      messages.filter((m) => m.type === "rpc_error").map((m) => m.payload.requestType),
    ).toEqual(["schedule/update", "schedule/resume", "schedule/run-once"]);
    for (const message of messages) {
      if (message.type === "rpc_error") continue;
      if (!("payload" in message)) throw new Error("missing payload");
      const payload = message.payload;
      if ("schedule" in payload && payload.schedule) {
        const schema =
          "runs" in payload.schedule ? OldScheduleSchema : OldScheduleSchema.omit({ runs: true });
        expect(schema.safeParse(payload.schedule).success).toBe(true);
      }
      if (message.type === "schedule/list/response") {
        expect(message.payload.schedules.map((entry) => entry.id)).toEqual([id]);
        for (const entry of message.payload.schedules)
          expect(OldScheduleSchema.omit({ runs: true }).safeParse(entry).success).toBe(true);
      }
      if (message.type === "schedule/logs/response")
        for (const run of message.payload.runs)
          expect(ScheduleRunSchema.omit({ trigger: true }).strict().safeParse(run).success).toBe(
            true,
          );
    }
    expect(JSON.stringify(messages)).not.toMatch(
      /"(?:triggers|source|pauseReason|eventRateLimitRunOffset|trigger)":/,
    );
    await session.handleScheduleInspectRequest({
      type: "schedule/inspect",
      requestId: "hidden",
      scheduleId: hidden.id,
    });
    expect(messages.at(-1)).toMatchObject({ payload: { schedule: null } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
