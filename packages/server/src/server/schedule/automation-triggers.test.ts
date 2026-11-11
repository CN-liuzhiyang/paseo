import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { StoredSchedule, RunTrigger } from "@getpaseo/protocol/schedule/types";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AutomationTriggers } from "./automation-triggers.js";
import {
  ScheduleService,
  ScheduleStateConflictError,
  type ScheduleServiceOptions,
} from "./service.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";

const now = new Date("2026-01-01T01:00:00Z");
function schedule(id = "test"): StoredSchedule {
  return {
    id,
    name: null,
    prompt: "test",
    cadence: { type: "none" },
    target: { type: "action", action: "echo", params: {} },
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: now.toISOString(),
    nextRunAt: null,
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
    runs: [],
    triggers: [{ type: "event", source: "demo", event: "ping", match: { sender: "alice" } }],
  };
}

class Service {
  schedules = [schedule()];
  running = new Set<string>();
  triggered: RunTrigger[] = [];
  list() {
    return Promise.resolve(this.schedules);
  }
  async inspect(id: string) {
    const record = this.schedules.find((entry) => entry.id === id);
    if (!record) throw new Error("missing");
    return record;
  }
  isRunning(id: string) {
    return this.running.has(id);
  }
  async runForTrigger(_id: string, trigger: RunTrigger) {
    this.triggered.push(trigger);
  }
  async pause(id: string, reason?: string) {
    const record = await this.inspect(id);
    record.status = "paused";
    record.pauseReason = reason;
  }
}
let root: string;
let service: Service;
let router: AutomationTriggers;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "automation-triggers-"));
  service = new Service();
  router = makeRouter();
});
function makeRouter() {
  return new AutomationTriggers({
    paseoHome: root,
    service,
    logger: createTestLogger(),
    now: () => now,
  });
}
afterEach(async () => {
  router.close();
  await rm(root, { recursive: true, force: true });
});
function emit(id: string, extra = {}) {
  return router.emit("plugin", "demo", { id, event: "ping", data: { sender: "alice" }, ...extra });
}

function realService(runner?: ScheduleServiceOptions["runner"]) {
  const logger = createTestLogger();
  return new ScheduleService({
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
    now: () => now,
    runner: runner ?? (async () => ({ agentId: null, output: "ok" })),
  });
}

test("real service drains two events coalesced during a manual run", async () => {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const actual = realService(async (record, runId) => {
    if (record.runs.find((run) => run.id === runId)?.trigger?.type === "manual") await blocked;
    return { agentId: null, output: "ok" };
  });
  router.close();
  router = new AutomationTriggers({
    paseoHome: root,
    service: actual,
    logger: createTestLogger(),
    now: () => now,
  });
  const unsubscribe = actual.subscribeRunFinished((id) => {
    void router.drain(id);
  });
  const record = await actual.create({
    prompt: "echo",
    cadence: { type: "none" },
    target: { type: "action", action: "echo", params: {} },
    triggers: [{ type: "event", source: "demo", event: "ping" }],
  });
  const manual = actual.runOnce(record.id);
  await expect.poll(() => actual.isRunning(record.id)).toBe(true);
  try {
    await emit("first");
    await emit("last");
  } finally {
    release();
  }
  await manual;
  await expect
    .poll(async () => (await actual.inspect(record.id)).runs.map((run) => run.status))
    .toEqual(["succeeded", "succeeded"]);
  expect((await actual.inspect(record.id)).runs[1].trigger).toMatchObject({
    eventId: "last",
    coalesced: 1,
  });
  await expect.poll(() => actual.isRunning(record.id)).toBe(false);
  unsubscribe();
});

test("resume resets a real service's event quota even when timestamps are identical", async () => {
  const actual = realService();
  router.close();
  router = new AutomationTriggers({
    paseoHome: root,
    service: actual,
    logger: createTestLogger(),
    now: () => now,
  });
  const record = await actual.create({
    prompt: "echo",
    cadence: { type: "none" },
    target: { type: "action", action: "echo", params: {} },
    triggers: [{ type: "event", source: "demo", event: "ping" }],
  });
  for (let index = 0; index < 21; index++) {
    await emit(`quota-${index}`);
    await expect.poll(() => actual.isRunning(record.id)).toBe(false);
  }
  expect(await actual.inspect(record.id)).toMatchObject({
    status: "paused",
    pauseReason: "rate-limit",
  });
  await actual.resume(record.id);
  expect((await emit("resumed")).started).toEqual([record.id]);
  await expect.poll(() => actual.isRunning(record.id)).toBe(false);
  expect(await actual.inspect(record.id)).toMatchObject({
    status: "active",
    eventRateLimitRunOffset: 20,
  });
  expect((await actual.inspect(record.id)).runs).toHaveLength(21);
});

test("backs up corrupt deduplication state and resumes persistent deduplication", async () => {
  const directory = join(root, "automation-events");
  await mkdir(directory);
  await writeFile(join(directory, "demo.json"), "{not json");
  expect((await emit("recovered")).status).toBe("accepted");
  const backup = (await readdir(directory)).find((file) => file.startsWith("demo.json.corrupt-"));
  expect(backup).toBeDefined();
  expect(await readFile(join(directory, backup!), "utf8")).toBe("{not json");
  expect((await emit("recovered")).status).toBe("duplicate");
});

test("a concurrent completion during rate-limit pause skips only that automation", async () => {
  service.schedules[0].runs = Array.from({ length: 20 }, (_, index) => ({
    id: String(index),
    scheduledFor: now.toISOString(),
    startedAt: now.toISOString(),
    endedAt: now.toISOString(),
    status: "succeeded",
    output: "ok",
    error: null,
    agentId: null,
    trigger: { type: "event", source: "demo", event: "ping", eventId: String(index), depth: 1 },
  }));
  service.schedules.push(schedule("second"));
  service.pause = async () => {
    throw new ScheduleStateConflictError("completed meanwhile");
  };
  expect(await emit("conflict")).toMatchObject({ started: ["second"], skipped: 1 });
});

test("deduplicates concurrent sends and retains stable IDs across restart", async () => {
  const results = await Promise.all([emit("one"), emit("one")]);
  expect(results.map((entry) => entry.status)).toEqual(["accepted", "duplicate"]);
  router.close();
  router = makeRouter();
  expect((await emit("one")).status).toBe("duplicate");
  expect(service.triggered).toHaveLength(1);
});

test("matches all top-level fields and runs each automation only once", async () => {
  service.schedules[0].triggers?.push({ type: "event", source: "demo", event: "ping" });
  service.schedules.push(schedule("second"));
  expect((await emit("one")).started).toEqual(["test", "second"]);
  expect((await emit("two", { event: "other" })).started).toEqual([]);
  service.schedules[0].triggers = [
    { type: "event", source: "demo", event: "ping", match: { sender: "bob" } },
  ];
  service.schedules[1].status = "paused";
  expect((await emit("three")).started).toEqual([]);
});

test("rejects stale events using per-trigger age and creation time", async () => {
  service.schedules[0].triggers = [
    { type: "event", source: "demo", event: "ping", maxAgeMs: 1000 },
  ];
  expect((await emit("old", { occurredAt: "2026-01-01T00:59:58Z" })).status).toBe("stale");
  service.schedules[0].triggers = [
    { type: "event", source: "demo", event: "ping", maxAgeMs: 86_400_000 },
  ];
  expect((await emit("before-creation", { occurredAt: "2025-12-31T23:59:59Z" })).status).toBe(
    "stale",
  );
  expect(service.triggered).toEqual([]);
});

test("coalesces busy events into the latest pending event and drains it once", async () => {
  service.running.add("test");
  expect((await emit("one")).deferred).toBe(1);
  await emit("two");
  await emit("three");
  service.running.clear();
  await router.drain("test");
  expect(service.triggered).toEqual([expect.objectContaining({ eventId: "three", coalesced: 2 })]);
  await router.drain("test");
  expect(service.triggered).toHaveLength(1);
});

test("automatically pauses after twenty event runs in an hour", async () => {
  const record = service.schedules[0];
  record.runs = Array.from({ length: 20 }, (_, index) => ({
    id: String(index),
    scheduledFor: now.toISOString(),
    startedAt: now.toISOString(),
    endedAt: now.toISOString(),
    status: "succeeded",
    output: "ok",
    error: null,
    agentId: null,
    trigger: { type: "event", source: "demo", event: "ping", eventId: String(index), depth: 1 },
  }));
  expect((await emit("limit")).started).toEqual([]);
  expect(record).toMatchObject({ status: "paused", pauseReason: "rate-limit" });
});

test("cannot trigger its own run and limits cross-automation causal depth", async () => {
  const record = service.schedules[0];
  record.runs.push({
    id: "cause",
    scheduledFor: now.toISOString(),
    startedAt: now.toISOString(),
    endedAt: null,
    status: "running",
    output: null,
    error: null,
    agentId: null,
    trigger: { type: "event", source: "demo", event: "ping", eventId: "origin", depth: 3 },
  });
  expect((await emit("deep", { causedBy: "cause" })).skipped).toBe(1);
  record.runs[0].trigger = { type: "manual" };
  expect((await emit("self", { causedBy: "cause" })).started).toEqual([]);
  service.schedules.push(schedule("other"));
  expect((await emit("other", { causedBy: "cause" })).started).toEqual(["other"]);
});

test("bounds plugin ingress and untrusted event payloads", async () => {
  await expect(emit("large", { data: { text: "x".repeat(16_384) } })).rejects.toThrow("16KB");
  for (let index = 0; index < 120; index++) await emit(`rate-${index}`, { event: "other" });
  await expect(emit("overflow")).rejects.toThrow("120/minute");
});
