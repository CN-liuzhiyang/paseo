import type { PaseoApi } from "@getpaseo/client";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { ScheduleChannel } from "@getpaseo/protocol/schedule/types";
import type { PluginRpcContract } from "../rpc.js";
import type { PluginCleanup } from "../contracts.js";
import type { ProviderRegistration } from "./provider.js";
import type { UsageSourceRegistration } from "./usage.js";
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

/** A delivery another plugin sent through `server.deliver`. */
export interface ChannelDeliveryPluginSource {
  kind: "plugin";
  /** The sending plugin. The host fills it in; a sender cannot name another plugin. */
  pluginId: string;
  /** What the sender called the message. Channels use it as the heading instead of a run title. */
  title: string;
}

/** What produced a delivery. Switch on `kind`: more sources may be added. */
export type ChannelDeliverySource = ChannelDeliveryScheduleSource | ChannelDeliveryPluginSource;

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

/** A place a channel can post to, offered to people so they pick by name instead of address. */
export interface ChannelDestination {
  /** The address passed back as `ChannelDelivery.to`. */
  to: string;
  /** What people see when they choose a destination. */
  label: string;
}

/** What a plugin hands to `server.deliver`. The host turns it into a `ChannelDelivery`. */
export interface ChannelMessage {
  to: string;
  /** Stable per message, passed on to the channel. */
  idempotencyKey: string;
  title: string;
  text: string;
  status: "succeeded" | "failed";
}

export interface ChannelRegistration {
  id: string;
  label?: string;
  /** Resolve once the message is accepted. Throwing or rejecting marks the delivery failed. */
  deliver(delivery: ChannelDelivery, context: PluginHandlerContext): Promise<void> | void;
  /**
   * The destinations people can choose from, asked for whenever a client lists channels. Omit it
   * when the channel has no fixed set; the host then offers none.
   */
  destinations?(
    context: PluginHandlerContext,
  ): Promise<ChannelDestination[]> | ChannelDestination[];
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
  /**
   * Send a message through a channel any running plugin registered, this one included. Rejects with
   * the channel's own error, or `No running plugin provides channel "<id>"`. Undefined on hosts that
   * predate it: check `typeof server.deliver === "function"` once, in the entry.
   */
  deliver?(channelId: string, message: ChannelMessage): Promise<void>;
  /** The channels `deliver` can reach, as `paseo schedule channels` lists them. Undefined like `deliver`. */
  listChannels?(): Promise<ScheduleChannel[]>;
  registerUsageSource(source: UsageSourceRegistration): void;
}

export type PluginServerContribution = (server: PluginServerContext) => PluginCleanup;
