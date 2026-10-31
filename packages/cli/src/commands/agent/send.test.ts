import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectToDaemon } from "../../utils/client.js";
import { addSendOptions, runSendCommand, type AgentSendOptions } from "./send.js";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

const sendAgentMessage = vi.fn();
const waitForFinish = vi.fn();

vi.mock("../../utils/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/client.js")>()),
  connectToDaemon: vi.fn(async () => ({
    sendAgentMessage,
    waitForFinish,
    fetchAgentTimeline: vi.fn(async () => ({ entries: [] })),
    close: vi.fn(async () => undefined),
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
      lastMessage: text,
    });
  }
}

function send(options: Omit<AgentSendOptions, "daemonTarget"> = {}) {
  return runSendCommand("agent-1", "describe it", { ...options, daemonTarget }, {} as Command);
}

describe("send --output-schema", () => {
  const originalAgentId = process.env.PASEO_AGENT_ID;

  beforeEach(() => {
    delete process.env.PASEO_AGENT_ID;
    sendAgentMessage.mockReset().mockResolvedValue({});
    waitForFinish.mockReset();
    vi.mocked(connectToDaemon).mockClear();
  });

  afterEach(() => {
    if (originalAgentId === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = originalAgentId;
  });

  it("registers the options", () => {
    const flags = addSendOptions(new Command()).options.map((option) => option.long);

    expect(flags).toEqual(
      expect.arrayContaining(["--output-schema", "--max-retries", "--wait-timeout"]),
    );
  });

  it("asks the existing agent with the schema in the message and returns the validated object", async () => {
    agentAnswers('{"summary":"ok"}');

    const result = await send({ outputSchema: schema });

    expect(result.schema.serialize?.(result.data)).toEqual({ summary: "ok" });
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    const [agentId, text] = sendAgentMessage.mock.calls[0] as [string, string];
    expect(agentId).toBe("agent-1");
    expect(text).toContain("describe it");
    expect(text).toContain('"summary"');
  });

  it("fails on the first mismatch with --max-retries 0 and hands back the evidence", async () => {
    agentAnswers('{"summary":1}');

    await expect(send({ outputSchema: schema, maxRetries: "0" })).rejects.toMatchObject({
      code: "OUTPUT_SCHEMA_FAILED",
      details: {
        validationErrors: [expect.stringContaining("/summary")],
        lastResponse: '{"summary":1}',
      },
    });
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("retries twice by default, each time to the same agent, and returns what a retry fixed", async () => {
    agentAnswers('{"summary":1}', '{"summary":2}', '{"summary":3}');
    await expect(send({ outputSchema: schema })).rejects.toMatchObject({
      details: { lastResponse: '{"summary":3}' },
    });
    expect(sendAgentMessage.mock.calls.map((call) => call[0])).toEqual([
      "agent-1",
      "agent-1",
      "agent-1",
    ]);

    agentAnswers('{"summary":1}', '{"summary":"fixed"}');
    const result = await send({ outputSchema: schema, maxRetries: "1" });
    expect(result.schema.serialize?.(result.data)).toEqual({ summary: "fixed" });
  });

  it("sends as the calling agent on every message", async () => {
    process.env.PASEO_AGENT_ID = "caller-1";
    agentAnswers('{"summary":1}', '{"summary":"ok"}');

    await send({ outputSchema: schema });

    for (const call of sendAgentMessage.mock.calls) {
      expect(call[2]).toMatchObject({ sourceAgentId: "caller-1", activeTurnBehavior: "steer" });
    }
  });

  it("waits as long as --wait-timeout says, 10 minutes otherwise", async () => {
    agentAnswers('{"summary":"ok"}', '{"summary":"ok"}');

    await send({ outputSchema: schema, waitTimeout: "90s" });
    expect(waitForFinish).toHaveBeenLastCalledWith("agent-1", 90_000);
    await send({ outputSchema: schema });
    expect(waitForFinish).toHaveBeenLastCalledWith("agent-1", 600_000);
  });

  it.each([
    ["--output-schema with --no-wait", { outputSchema: schema, wait: false }],
    ["--max-retries without --output-schema", { maxRetries: "0" }],
    ["a schema that is not JSON", { outputSchema: "{not json" }],
  ])("rejects %s before connecting", async (_name, options) => {
    await expect(send(options)).rejects.toMatchObject({ code: expect.any(String) });
    expect(connectToDaemon).not.toHaveBeenCalled();
  });
});

describe("send without --output-schema", () => {
  it("sends the prompt as written and waits as before", async () => {
    sendAgentMessage.mockReset().mockResolvedValue({});
    waitForFinish.mockReset().mockResolvedValue({ status: "idle", final: { id: "agent-1" } });

    const result = await send({ waitTimeout: "5m" });

    expect(sendAgentMessage.mock.calls[0]?.[1]).toBe("describe it");
    expect(waitForFinish).toHaveBeenCalledWith("agent-1", 300_000);
    expect(result.data).toMatchObject({ agentId: "agent-1", status: "completed" });
    expect(result.schema.serialize).toBeUndefined();
  });
});
