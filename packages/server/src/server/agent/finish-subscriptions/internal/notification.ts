import type { AgentPermissionRequest } from "../../agent-sdk-types.js";
export type FinishNotificationReason =
  | "host unreachable"
  | "host removed"
  | "finished"
  | "errored"
  | "needs permission"
  | "is unavailable"
  | "was closed"
  | "was canceled"
  | "is still working"
  | "stopped following";

export const finishNotificationEvents = {
  "host unreachable": "errored",
  "host removed": "errored",
  finished: "finished",
  errored: "errored",
  "needs permission": "permission-required",
  "was closed": "closed",
  "is unavailable": "closed",
  // Use the existing failure event so older clients still parse agent-message metadata.
  "was canceled": "errored",
  // Neither says the child finished. "message" is already in the wire event enum (clients show
  // "Message received"), so no client needs to learn a new value.
  "is still working": "message",
  "stopped following": "message",
} as const;

const FINISH_NOTIFICATION_MESSAGE_LIMIT = 4000;

interface FinishNotificationBodyInput {
  childAgentId: string;
  serverId?: string;
  title: string;
  reason: FinishNotificationReason;
  lastAssistantMessage: string | null;
  permissionRequest?: AgentPermissionRequest;
  /** Why an idle child is not settled, for `is still working`. */
  unsettled?: readonly string[];
  /** What ended the subscription, for `stopped following`. */
  limit?: string;
  /** The child never started another turn: this repeats the reply the caller already received. */
  repeatsEarlierReply?: boolean;
  /** Settled final of a child that the subscription was prepared to keep following. */
  subscriptionEnds?: boolean;
}

const SUBSCRIPTION_ENDED = "This finish subscription has ended.";

function statusLineFor(params: FinishNotificationBodyInput): string {
  const subject = `Agent ${params.childAgentId} (${params.title})`;
  if (params.reason === "is still working") {
    const why = params.unsettled?.length ? ` (${params.unsettled.join("; ")})` : "";
    return `${subject} ended its turn but still has background work${why}. This is not its final reply. You stay subscribed and will be notified when it settles.`;
  }
  if (params.reason === "stopped following") {
    return `${subject} still reports background work after ${params.limit}, so this subscription stopped following it. ${SUBSCRIPTION_ENDED} Use get_agent_activity to check on it. Its last reply is below.`;
  }
  const statusLine = `${subject} ${params.reason}.`;
  if (!params.repeatsEarlierReply) return statusLine;
  return `${statusLine} Its background work has ended and it did not start a new turn, so the reply you already received (marked "not its final reply") is its last reply. It is repeated below.`;
}

export function formatFinishNotificationBody(params: FinishNotificationBodyInput): string {
  if (params.reason === "host unreachable" || params.reason === "host removed") {
    const host =
      params.reason === "host removed"
        ? `Host ${params.serverId} was removed or is unavailable.`
        : `Could not observe child agent ${params.childAgentId} on host ${params.serverId} after three failed attempts.`;
    return `${host}\n\nStatus of child agent ${params.childAgentId} (${params.title}) is unknown.\n\nServer: ${params.serverId}\n\n${SUBSCRIPTION_ENDED} Reassess the delegated work; reconnecting will not resume notifications.`;
  }
  const sections = [statusLineFor(params)];
  if (params.serverId) sections.push(`Server: ${params.serverId}`);
  if (params.reason === "needs permission" && params.permissionRequest) {
    sections.push(
      "Respond with `respond_to_permission` using the `agentId` and `requestId` below.",
      `<permission-request>\n${JSON.stringify(
        {
          agentId: params.childAgentId,
          ...(params.serverId ? { serverId: params.serverId } : {}),
          requestId: params.permissionRequest.id,
          request: params.permissionRequest,
        },
        null,
        2,
      )}\n</permission-request>`,
    );
  }
  let lastAssistantMessage = params.lastAssistantMessage?.trim();
  if (lastAssistantMessage) {
    if (lastAssistantMessage.length > FINISH_NOTIFICATION_MESSAGE_LIMIT) {
      const omitted = lastAssistantMessage.length - FINISH_NOTIFICATION_MESSAGE_LIMIT;
      lastAssistantMessage = `${lastAssistantMessage.slice(0, FINISH_NOTIFICATION_MESSAGE_LIMIT)}\n[truncated ${omitted} chars; use get_agent_activity for the full response]`;
    }
    sections.push(`<agent-response>\n${lastAssistantMessage}\n</agent-response>`);
  }
  if (params.subscriptionEnds) sections.push(SUBSCRIPTION_ENDED);
  return sections.join("\n\n");
}
