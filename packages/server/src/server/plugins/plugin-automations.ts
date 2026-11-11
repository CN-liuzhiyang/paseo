import { z, type ZodType } from "zod";
import type { PaseoApi } from "@getpaseo/client";
import type { ActionRegistration, ActionInput, ActionResult } from "@getpaseo/plugin/server";
import {
  TriggerSourceRegistrationSchema,
  type TriggerSourceRegistration,
} from "@getpaseo/protocol/schedule/types";
import type { PluginActionMetadata } from "./plugin-process-protocol.js";

export class PluginAutomations {
  private readonly actions = new Map<string, ActionRegistration>();
  private readonly sources = new Map<string, TriggerSourceRegistration>();
  private readonly running = new Map<string, AbortController>();
  private readonly changed: () => void;

  constructor(changed: () => void) {
    this.changed = changed;
  }

  registerAction<P extends ZodType>(action: ActionRegistration<P>): void {
    if (!/^[a-z][a-z0-9._-]*$/.test(action.id)) throw new Error(`Invalid action ID: ${action.id}`);
    if (this.actions.has(action.id)) throw new Error(`Duplicate action ID: ${action.id}`);
    if (typeof action.run !== "function") throw new Error(`Action ${action.id} requires run()`);
    z.number().int().positive().max(3_600_000).optional().parse(action.defaultTimeoutMs);
    z.toJSONSchema(action.params, { io: "input" });
    this.actions.set(action.id, action);
    this.changed();
  }

  registerSource(source: TriggerSourceRegistration): void {
    const checked = TriggerSourceRegistrationSchema.parse(source);
    if (this.sources.has(checked.id)) throw new Error(`Duplicate trigger source ID: ${checked.id}`);
    if (new Set(checked.events.map((event) => event.id)).size !== checked.events.length)
      throw new Error("Duplicate trigger event ID");
    this.sources.set(checked.id, checked);
    this.changed();
  }

  actionMetadata(): PluginActionMetadata[] {
    return [...this.actions.values()].map(
      ({ id, label, description, params, defaultTimeoutMs }) => ({
        id,
        label,
        description,
        params: z.toJSONSchema(params, { io: "input" }),
        defaultTimeoutMs,
      }),
    );
  }

  sourceMetadata(): TriggerSourceRegistration[] {
    return [...this.sources.values()];
  }

  async validate(id: string, params: unknown): Promise<unknown> {
    const action = this.actions.get(id);
    if (!action) throw new Error(`Unknown action: ${id}`);
    return action.params.parseAsync(params);
  }

  async run(
    requestId: string,
    id: string,
    input: ActionInput,
    paseo: PaseoApi,
  ): Promise<ActionResult> {
    const action = this.actions.get(id);
    if (!action) throw new Error(`Unknown action: ${id}`);
    const controller = new AbortController();
    this.running.set(requestId, controller);
    try {
      const params = await this.validate(id, input.params);
      controller.signal.throwIfAborted();
      const result = await action.run({ ...input, params }, { paseo, signal: controller.signal });
      controller.signal.throwIfAborted();
      return z.object({ text: z.string(), agentId: z.guid().nullable().optional() }).parse(result);
    } finally {
      this.running.delete(requestId);
    }
  }

  cancel(requestId: string): void {
    this.running.get(requestId)?.abort();
  }
  close(): void {
    for (const controller of this.running.values()) controller.abort();
  }
}
