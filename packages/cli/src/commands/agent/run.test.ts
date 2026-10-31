import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { resolveCallerAgentId as resolveRunCallerAgentId } from "../../utils/caller-agent.js";
import {
  awaitStructuredTurn,
  fetchStructuredOutput,
  parseMaxRetriesOption,
  resolveExistingRunWorkspace,
  runRunCommand,
  waitsForFinish,
  type AgentRunOptions,
  type StructuredTurnClient,
} from "./run";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

// Answers fetchAgent the way a daemon does: an unknown id is an error.
function daemonWithAgents(...agentIds: string[]) {
  return {
    async fetchAgent({ agentId }: { agentId: string }) {
      if (!agentIds.includes(agentId)) {
        throw new Error(`Agent not found: ${agentId}`);
      }
      return { agent: { id: agentId } };
    },
  };
}

describe("run wait policy", () => {
  it("waits by default and stops waiting on --no-wait or a legacy alias", () => {
    expect(waitsForFinish({})).toBe(true);
    expect(waitsForFinish({ wait: false })).toBe(false);
    expect(waitsForFinish({ background: true })).toBe(false);
    expect(waitsForFinish({ detach: true })).toBe(false);
  });
});

describe("managed agent caller context", () => {
  it("uses a trimmed PASEO_AGENT_ID when the target daemon runs that agent", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents("parent-agent"), {
        PASEO_AGENT_ID: "  parent-agent  ",
      }),
    ).resolves.toBe("parent-agent");
  });

  it("runs without a caller when PASEO_AGENT_ID belongs to another daemon", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents("other-agent"), {
        PASEO_AGENT_ID: "parent-agent",
      }),
    ).resolves.toBeUndefined();
  });

  it.each(["DAEMON_CONNECTION_LOST", "DAEMON_REQUEST_TIMEOUT"] as const)(
    "preserves %s instead of dropping the caller",
    async (code) => {
      const disconnectedDaemon = {
        async fetchAgent(): Promise<never> {
          throw new DaemonConnectionError("Caller lookup transport failed", code);
        },
      };

      await expect(
        resolveRunCallerAgentId(disconnectedDaemon, { PASEO_AGENT_ID: "parent-agent" }),
      ).rejects.toBeInstanceOf(DaemonConnectionError);
    },
  );

  it("omits blank caller ids", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents(), { PASEO_AGENT_ID: "   " }),
    ).resolves.toBeUndefined();
  });
});

describe("existing run workspace resolution", () => {
  it("queries the daemon for an exact workspace id and uses its directory", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [{ id: "workspace-2", workspaceDirectory: "/workspace/two" }],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "workspace-2")).resolves.toEqual({
      id: "workspace-2",
      cwd: "/workspace/two",
    });
    expect(fetchWorkspaces).toHaveBeenCalledWith({
      filter: { query: "workspace-2" },
      page: { limit: 200 },
    });
  });

  it("rejects a workspace id absent from daemon state", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "missing")).rejects.toMatchObject(
      {
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace not found: missing",
      },
    );
  });
});

// validateRunOptions runs before the CLI ever connects to a daemon, so these
// invalid combinations reject without one running.
describe("runRunCommand option validation", () => {
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;

  beforeEach(() => {
    delete process.env.PASEO_WORKSPACE_ID;
  });

  afterEach(() => {
    if (originalWorkspaceId === undefined) {
      delete process.env.PASEO_WORKSPACE_ID;
    } else {
      process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
    }
  });

  async function expectInvalidOptions(
    options: Omit<AgentRunOptions, "daemonTarget">,
    messageMatch: RegExp,
  ) {
    await expect(
      runRunCommand("do something", { ...options, daemonTarget }, {} as never),
    ).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: expect.stringMatching(messageMatch),
    });
  }

  it("rejects --new-workspace combined with --workspace", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", workspace: "ws-1" },
      /--new-workspace and --workspace cannot be combined/,
    );
  });

  it("allows explicit worktree workspace creation through validation", async () => {
    // Explicit workspace creation with no --workspace
    // must clear validation. It still fails later (provider resolution), which
    // is enough to prove the new guard did not reject it.
    await expect(
      runRunCommand(
        "do something",
        { newWorkspace: "worktree", provider: undefined, daemonTarget },
        {} as never,
      ),
    ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("rejects unknown new workspace kinds", async () => {
    await expectInvalidOptions({ newWorkspace: "container" }, /Unsupported new workspace kind/);
  });

  it("rejects two workspace creation flags", async () => {
    await expectInvalidOptions(
      { newWorkspace: "local", worktree: "legacy-slug" },
      /--new-workspace and --worktree cannot be combined/,
    );
  });

  it("rejects an unknown worktree creation mode before connecting", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", worktreeMode: "container" },
      /Unsupported worktree mode/,
    );
  });

  it("rejects --output-schema combined with --no-wait", async () => {
    await expectInvalidOptions(
      { outputSchema: '{"type":"object"}', wait: false },
      /--output-schema cannot be used with --no-wait/,
    );
  });

  it("rejects --max-retries without --output-schema", async () => {
    await expectInvalidOptions({ maxRetries: "0" }, /--max-retries requires --output-schema/);
  });

  it("rejects a --max-retries that is not a non-negative integer", async () => {
    await expect(
      runRunCommand(
        "do something",
        { outputSchema: '{"type":"object"}', maxRetries: "-1", daemonTarget },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "INVALID_MAX_RETRIES" });
  });
});

describe("--max-retries parsing", () => {
  it("leaves the default to the caller when the flag is absent", () => {
    expect(parseMaxRetriesOption(undefined)).toBeUndefined();
  });

  it.each([
    ["0", 0],
    ["2", 2],
    [" 5 ", 5],
  ])("reads %j as %i", (value, expected) => {
    expect(parseMaxRetriesOption(value)).toBe(expected);
  });

  it.each(["-1", "1.5", "two", ""])("rejects %j", (value) => {
    expect(() => parseMaxRetriesOption(value)).toThrow(
      expect.objectContaining({ code: "INVALID_MAX_RETRIES" }),
    );
  });
});

describe("structured output retries", () => {
  const schema = {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  };

  it("returns the parsed object when the first answer matches", async () => {
    const caller = vi.fn().mockResolvedValue('Here you go: {"summary":"ok"}');

    await expect(fetchStructuredOutput(caller, "describe it", schema)).resolves.toEqual({
      summary: "ok",
    });
    expect(caller).toHaveBeenCalledTimes(1);
    expect(caller.mock.calls[0]?.[0]).toContain("describe it");
  });

  it("retries twice by default and then fails", async () => {
    const caller = vi.fn().mockResolvedValue('{"summary":1}');

    await expect(fetchStructuredOutput(caller, "describe it", schema)).rejects.toMatchObject({
      code: "OUTPUT_SCHEMA_FAILED",
    });
    expect(caller).toHaveBeenCalledTimes(3);
  });

  it("fails on the first mismatch with --max-retries 0 and hands back the evidence", async () => {
    const caller = vi.fn().mockResolvedValue('{"summary":1}');

    await expect(fetchStructuredOutput(caller, "describe it", schema, 0)).rejects.toMatchObject({
      code: "OUTPUT_SCHEMA_FAILED",
      details: {
        validationErrors: [expect.stringContaining("/summary")],
        lastResponse: '{"summary":1}',
      },
    });
    expect(caller).toHaveBeenCalledTimes(1);
  });

  it("reports text that is not JSON as a validation error carrying the text", async () => {
    const caller = vi.fn().mockResolvedValue("no json here");

    await expect(fetchStructuredOutput(caller, "describe it", schema, 0)).rejects.toMatchObject({
      details: { validationErrors: [expect.any(String)], lastResponse: "no json here" },
    });
  });

  it("succeeds on a retry and sends the errors back with the schema", async () => {
    const caller = vi
      .fn()
      .mockResolvedValueOnce('{"summary":1}')
      .mockResolvedValueOnce('{"summary":"fixed"}');

    await expect(fetchStructuredOutput(caller, "describe it", schema, 1)).resolves.toEqual({
      summary: "fixed",
    });
    expect(caller).toHaveBeenCalledTimes(2);
    expect(caller.mock.calls[1]?.[0]).toContain("/summary");
  });
});

describe("awaitStructuredTurn", () => {
  function clientFinishing(state: Record<string, unknown>, timelineText?: string) {
    return {
      waitForFinish: vi.fn().mockResolvedValue(state),
      fetchAgentTimeline: vi.fn().mockResolvedValue({
        entries: timelineText ? [{ item: { type: "assistant_message", text: timelineText } }] : [],
      }),
    } as unknown as StructuredTurnClient;
  }

  it("returns the last assistant message of the finished turn", async () => {
    const client = clientFinishing({ status: "idle", lastMessage: ' {"a":1} ' });

    await expect(awaitStructuredTurn(client, "agent-1", 1000)).resolves.toBe('{"a":1}');
    expect(client.waitForFinish).toHaveBeenCalledWith("agent-1", 1000);
  });

  it("reads the timeline under the resolved id when the daemon sent no last message", async () => {
    const client = clientFinishing(
      { status: "idle", lastMessage: null, final: { id: "agent-full-id" } },
      '{"a":2}',
    );

    await expect(awaitStructuredTurn(client, "agent", 1000)).resolves.toBe('{"a":2}');
    expect(client.fetchAgentTimeline).toHaveBeenCalledWith("agent-full-id", expect.anything());
  });

  it.each(["timeout", "permission", "error"])(
    "turns a %s finish into OUTPUT_SCHEMA_FAILED",
    async (status) => {
      const client = clientFinishing({ status, error: "boom" });

      await expect(
        fetchStructuredOutput(() => awaitStructuredTurn(client, "agent-1", 1000), "p", {}, 0),
      ).rejects.toMatchObject({ code: "OUTPUT_SCHEMA_FAILED" });
    },
  );

  it("fails when the agent finished without any assistant message", async () => {
    const client = clientFinishing({ status: "idle", lastMessage: null });

    await expect(
      fetchStructuredOutput(() => awaitStructuredTurn(client, "agent-1", 1000), "p", {}, 0),
    ).rejects.toMatchObject({ code: "OUTPUT_SCHEMA_FAILED" });
  });
});
