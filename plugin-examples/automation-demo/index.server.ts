import { defineRpc } from "@getpaseo/plugin";
import type { ChannelDelivery, PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

export default function contribute(server: PluginServerContext) {
  if (
    typeof server.registerAction !== "function" ||
    typeof server.registerTriggerSource !== "function" ||
    typeof server.emit !== "function"
  )
    return () => {};
  const emit = server.emit;
  const deliveries: ChannelDelivery[] = [];
  server.registerTriggerSource({
    id: "demo",
    label: "Demo events",
    events: [{ id: "ping", fields: ["sender", "text"] }],
  });
  server.registerAction({
    id: "demo.echo",
    label: "Echo",
    params: z.object({ text: z.string() }),
    run({ params }) {
      return { text: params.text };
    },
  });
  server.registerChannel?.({
    id: "demo-results",
    async deliver(delivery) {
      deliveries.push(delivery);
      await emit("demo", {
        event: "ping",
        id: `delivery:${delivery.idempotencyKey}`,
        causedBy: delivery.idempotencyKey,
        data: { text: delivery.text },
      });
    },
  });
  server.handle(
    defineRpc({
      name: "emit",
      input: z.object({
        id: z.string(),
        event: z.string().default("ping"),
        occurredAt: z.string().optional(),
        subject: z.string().optional(),
        causedBy: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
      }),
      output: z.object({
        status: z.string(),
        started: z.array(z.string()),
        deferred: z.number(),
        skipped: z.number(),
      }),
    }),
    (event) => emit("demo", event),
  );
  server.handle(
    defineRpc({ name: "deliveries", input: z.object({}), output: z.array(z.unknown()) }),
    () => deliveries,
  );
  return () => {};
}
