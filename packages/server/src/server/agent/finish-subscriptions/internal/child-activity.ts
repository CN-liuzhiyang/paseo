import type { Logger } from "pino";
import { withTimeout } from "../../../../utils/promise-timeout.js";
import type { AgentManager } from "../../agent-manager.js";
import type { AgentMessageDelivery } from "../../agent-messages/index.js";
import type { ChildActivity } from "../index.js";
import { createFailureLog } from "./failure-log.js";

// The same bound idle-runtime cleanup puts on this probe.
const PROBE_TIMEOUT_MS = 10_000;

/**
 * What an idle local child may still do on its own, from what the daemon already knows. A child
 * with no live runtime (reclaimed when idle, or not yet resumed after a restart) reports nothing
 * pending, and so does a provider that does not implement `canStopRuntime`: both settle at once.
 * A provider that has the probe but fails to answer it is a different case: that is not knowing,
 * and not knowing is not settled.
 */
export function createChildActivity(input: {
  agentManager: Pick<AgentManager, "getAgent">;
  messages(): AgentMessageDelivery;
  logger: Pick<Logger, "warn" | "info">;
}): (childAgentId: string) => Promise<ChildActivity> {
  const probeLog = createFailureLog(input.logger);
  return async (childAgentId) => {
    const asked = input.agentManager.getAgent(childAgentId)?.session;
    let providerBackgroundWork = false;
    let uncertain: ChildActivity["uncertain"];
    if (asked?.canStopRuntime) {
      try {
        // false is the provider saying "releasing this runtime would lose something", which
        // includes it not being sure.
        const canStop = await withTimeout(
          asked.canStopRuntime(),
          PROBE_TIMEOUT_MS,
          `Runtime safety probe timed out for ${childAgentId}`,
        );
        providerBackgroundWork = canStop !== true;
        probeLog.recovered(childAgentId, { childAgentId }, "Runtime safety probe answers again");
      } catch (error) {
        probeLog.failed(childAgentId, { err: error, childAgentId }, "Runtime safety probe failed");
        uncertain = "its background state could not be read";
      }
    }
    // The probe can take seconds. What it says is about the runtime that was asked, and the rest is
    // read only now, so a turn or a message that arrived meanwhile is not missed.
    const agent = input.agentManager.getAgent(childAgentId);
    if (agent?.session !== asked) uncertain = "its runtime was replaced while being checked";
    return {
      running: agent?.session
        ? agent.lifecycle === "running" || agent.lifecycle === "initializing"
        : false,
      providerBackgroundWork,
      queuedMessages: input.messages().hasPending(childAgentId),
      ...(uncertain ? { uncertain } : {}),
    };
  };
}
