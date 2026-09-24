import type { PaseoApi } from "@getpaseo/client";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { PluginRpcContract } from "../rpc.js";
import type { PluginCleanup } from "../contracts.js";
import type { ProviderRegistration } from "./provider.js";
import type { PluginLifecycleRegistration } from "./lifecycle.js";

export interface PluginHandlerContext {
  paseo: PaseoApi;
}

export type PluginSettingsState<Schema extends ZodType> =
  | {
      status: "ready";
      revision: string;
      values: ZodOutput<Schema>;
    }
  | {
      status: "invalid";
      revision: string;
      error: string;
    };

export interface PluginSettings<Schema extends ZodType> {
  read(): Promise<PluginSettingsState<Schema>>;
  subscribe(listener: (state: PluginSettingsState<Schema>) => void | Promise<void>): PluginCleanup;
}

/** A delivery produced by a scheduled run. */
export interface ChannelDeliveryScheduleSource {
  kind: "schedule";
  scheduleId: string;
  scheduleName: string | null;
  runId: string;
}

/** What produced a delivery. Switch on `kind`: more sources may be added. */
export type ChannelDeliverySource = ChannelDeliveryScheduleSource;

/** One outbound message the host hands to a channel. */
export interface ChannelDelivery {
  /** Address from the schedule's delivery target; only the channel interprets it. */
  to: string;
  /** Stable per run. Pass it to the vendor API so a repeated delivery does not post twice. */
  idempotencyKey: string;
  source: ChannelDeliverySource;
  status: "succeeded" | "failed";
  /** The final answer when the run succeeded, the error message when it failed. */
  text: string;
  agentId: string | null;
}

export interface ChannelRegistration {
  id: string;
  label?: string;
  /** Resolve once the message is accepted. Throwing or rejecting marks the delivery failed. */
  deliver(delivery: ChannelDelivery, context: PluginHandlerContext): Promise<void> | void;
}

export interface PluginServerContext extends PluginLifecycleRegistration {
  registerSettings<Schema extends ZodType>(
    definition: import("../settings.js").SettingsDefinition<Schema>,
  ): PluginSettings<Schema>;
  handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    handler: (
      input: ZodOutput<InputSchema>,
      context: PluginHandlerContext,
    ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
  ): void;
  registerProvider(provider: ProviderRegistration): void;
  /**
   * The same connection hooks and handlers receive as `context.paseo`, for work the plugin starts
   * on its own: an external event, a timer. Undefined on hosts that predate it. It stops working
   * once the plugin begins to stop, so do not call it from cleanup.
   */
  readonly paseo?: PaseoApi;
  /**
   * Contribute an outbound channel that schedules can name as their delivery target. Undefined on
   * hosts that predate it. Channel IDs use the same form as RPC names.
   */
  registerChannel?(channel: ChannelRegistration): void;
}

export type PluginServerContribution = (server: PluginServerContext) => PluginCleanup;
