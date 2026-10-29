import type { Logger } from "pino";
import { withTimeout } from "../../../../utils/promise-timeout.js";
import type { AgentManager } from "../../agent-manager.js";
import type { AgentMessageDelivery } from "../../agent-messages/index.js";
import type { ChildActivity } from "../index.js";

// The same bound idle-runtime cleanup puts on this probe.
const PROBE_TIMEOUT_MS = 10_000;

/**
 * What an idle local child may still do on its own, from what the daemon already knows. A child
 * with no live runtime (reclaimed when idle, or not yet resumed after a restart) reports nothing
 * pending, and so does a provider that does not implement `canStopRuntime`: both settle at once.
 */
export function createChildActivity(input: {
  agentManager: Pick<AgentManager, "getAgent">;
  messages(): AgentMessageDelivery;
  logger: Pick<Logger, "warn">;
}): (childAgentId: string) => Promise<ChildActivity> {
  return async (childAgentId) => {
    const queuedMessages = input.messages().hasPending(childAgentId);
    const agent = input.agentManager.getAgent(childAgentId);
    const session = agent?.session;
    if (!agent || !session) {
      return { running: false, providerBackgroundWork: false, queuedMessages };
    }
    const running = agent.lifecycle === "running" || agent.lifecycle === "initializing";
    let providerBackgroundWork = false;
    if (session.canStopRuntime) {
      try {
        // false is the provider saying "releasing this runtime would lose something", which
        // includes it not being sure. A rejected or slow probe says nothing at all.
        const canStop = await withTimeout(
          session.canStopRuntime(),
          PROBE_TIMEOUT_MS,
          `Runtime safety probe timed out for ${childAgentId}`,
        );
        providerBackgroundWork = canStop !== true;
      } catch (error) {
        input.logger.warn({ err: error, childAgentId }, "Runtime safety probe failed");
      }
    }
    return { running, providerBackgroundWork, queuedMessages };
  };
}
