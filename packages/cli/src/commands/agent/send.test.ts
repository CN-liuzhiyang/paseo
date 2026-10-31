import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectToDaemon } from "../../utils/client.js";
import { addSendOptions, runSendCommand, type AgentSendOptions } from "./send.js";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

const sendAgentMessage = vi.fn();
const waitForFinish = vi.fn();
const fetchAgentTimeline = vi.fn();
const close = vi.fn();

vi.mock("../../utils/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/client.js")>()),
  connectToDaemon: vi.fn(async () => ({
    sendAgentMessage,
    waitForFinish,
    fetchAgentTimeline,
    close,
  })),
}));

const schema = JSON.stringify({
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
});

// Each finished turn answers with the next text.
function agentAnswers(...texts: string[]) {
  for (const text of texts) {
    waitForFinish.mockResolvedValueOnce({
      status: "idle",
      final: { id: "agent-1" },
      error: null,
      lastMessage: text,
    });
  }
}

function send(prompt: string, options: Omit<AgentSendOptions, "daemonTarget"> = {}) {
  return runSendCommand("agent-1", prompt, { ...options, daemonTarget }, {} as Command);
}

describe("send --output-schema", () => {
  const originalAgentId = process.env.PASEO_AGENT_ID;

  beforeEach(() => {
    delete process.env.PASEO_AGENT_ID;
    sendAgentMessage.mockReset().mockResolvedValue({});
    waitForFinish.mockReset();
    fetchAgentTimeline.mockReset().mockResolvedValue({ entries: [] });
    close.mockReset().mockResolvedValue(undefined);
    vi.mocked(connectToDaemon).mockClear();
  });

  afterEach(() => {
    if (originalAgentId === undefined) {
      delete process.env.PASEO_AGENT_ID;
    } else {
      process.env.PASEO_AGENT_ID = originalAgentId;
    }
  });

  it("registers the structured-output and timeout options", () => {
    const flags = addSendOptions(new Command()).options.map((option) => option.long);

    expect(flags).toEqual(
      expect.arrayContaining(["--output-schema", "--max-retries", "--wait-timeout", "--no-wait"]),
    );
  });

  it("asks the existing agent for the schema and returns the validated object", async () => {
    agentAnswers('{"summary":"ok"}');

    const result = await send("describe it", { outputSchema: schema });

    expect(result.schema.serialize?.(result.data)).toEqual({ summary: "ok" });
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    const [agentId, text] = sendAgentMessage.mock.calls[0] as [string, string];
    expect(agentId).toBe("agent-1");
    expect(text).toContain("describe it");
    expect(text).toContain('"summary"');
    expect(close).toHaveBeenCalled();
  });

  it("fails on the first mismatch with --max-retries 0 and hands back the evidence", async () => {
    agentAnswers('{"summary":1}');

    await expect(
      send("describe it", { outputSchema: schema, maxRetries: "0" }),
    ).rejects.toMatchObject({
      code: "OUTPUT_SCHEMA_FAILED",
      details: {
        validationErrors: [expect.stringContaining("/summary")],
        lastResponse: '{"summary":1}',
      },
    });
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalled();
  });

  it("retries twice by default, each time to the same agent", async () => {
    agentAnswers('{"summary":1}', '{"summary":2}', '{"summary":3}');

    await expect(send("describe it", { outputSchema: schema })).rejects.toMatchObject({
      code: "OUTPUT_SCHEMA_FAILED",
      details: { lastResponse: '{"summary":3}' },
    });
    expect(sendAgentMessage).toHaveBeenCalledTimes(3);
    expect(sendAgentMessage.mock.calls.map((call) => call[0])).toEqual([
      "agent-1",
      "agent-1",
      "agent-1",
    ]);
  });

  it("returns what a retry fixed", async () => {
    agentAnswers('{"summary":1}', '{"summary":"fixed"}');

    const result = await send("describe it", { outputSchema: schema, maxRetries: "1" });

    expect(result.schema.serialize?.(result.data)).toEqual({ summary: "fixed" });
    expect(sendAgentMessage).toHaveBeenCalledTimes(2);
  });

  it("passes the caller's agent id and steer behavior on every message", async () => {
    process.env.PASEO_AGENT_ID = "caller-1";
    agentAnswers('{"summary":1}', '{"summary":"ok"}');

    await send("describe it", { outputSchema: schema });

    for (const call of sendAgentMessage.mock.calls) {
      expect(call[2]).toMatchObject({ sourceAgentId: "caller-1", activeTurnBehavior: "steer" });
    }
  });

  it("waits as long as --wait-timeout says, 10 minutes otherwise", async () => {
    agentAnswers('{"summary":"ok"}', '{"summary":"ok"}');

    await send("describe it", { outputSchema: schema, waitTimeout: "90s" });
    expect(waitForFinish).toHaveBeenLastCalledWith("agent-1", 90_000);

    await send("describe it", { outputSchema: schema });
    expect(waitForFinish).toHaveBeenLastCalledWith("agent-1", 600_000);

    waitForFinish.mockResolvedValueOnce({ status: "idle", final: { id: "agent-1" } });
    await send("describe it", { waitTimeout: "5m" });
    expect(waitForFinish).toHaveBeenLastCalledWith("agent-1", 300_000);
  });

  it.each([
    ["--output-schema with --no-wait", { outputSchema: schema, wait: false }],
    ["--max-retries without --output-schema", { maxRetries: "0" }],
  ])("rejects %s before connecting", async (_name, options) => {
    await expect(send("describe it", options)).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    expect(connectToDaemon).not.toHaveBeenCalled();
  });

  it("rejects a schema that is not valid JSON before connecting", async () => {
    await expect(send("describe it", { outputSchema: "{not json" })).rejects.toMatchObject({
      code: "INVALID_OUTPUT_SCHEMA",
    });
    expect(connectToDaemon).not.toHaveBeenCalled();
  });
});

describe("send without --output-schema", () => {
  beforeEach(() => {
    delete process.env.PASEO_AGENT_ID;
    sendAgentMessage.mockReset().mockResolvedValue({});
    waitForFinish.mockReset().mockResolvedValue({ status: "idle", final: { id: "agent-1" } });
    close.mockReset().mockResolvedValue(undefined);
  });

  it("sends the prompt as written and reports completion", async () => {
    const result = await send("plain prompt");

    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(sendAgentMessage.mock.calls[0]?.[1]).toBe("plain prompt");
    expect(result.data).toMatchObject({ agentId: "agent-1", status: "completed" });
    expect(result.schema.serialize).toBeUndefined();
  });

  it("still returns right away on --no-wait", async () => {
    const result = await send("plain prompt", { wait: false });

    expect(waitForFinish).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ agentId: "agent-1" });
  });
});
