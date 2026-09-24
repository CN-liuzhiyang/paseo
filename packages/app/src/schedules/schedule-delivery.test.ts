import type { ScheduleChannel } from "@getpaseo/protocol/schedule/types";
import { describe, expect, it } from "vitest";
import {
  NO_DELIVERY_VALUE,
  buildScheduleDeliveryFieldModel,
  buildScheduleDeliveryOptions,
  deliveryOptionValue,
  formatDeliveryTarget,
  summarizeLastDelivery,
  truncateDeliveryError,
} from "./schedule-delivery";

const CHANNELS: ScheduleChannel[] = [
  {
    id: "chat",
    label: "Chat",
    pluginId: "notify",
    destinations: [
      { to: "room-1", label: "Team room" },
      { to: "room-2", label: "Releases" },
    ],
  },
  { id: "pager", label: null, pluginId: "notify", destinations: null, error: "token expired" },
];

function labels(options: ReturnType<typeof buildScheduleDeliveryOptions>) {
  return options.map((option) => ({
    label: option.label,
    description: option.description,
    unavailable: option.unavailable,
  }));
}

describe("schedule delivery options", () => {
  it("offers None, every destination by label, and a disabled entry for a failing channel", () => {
    const options = buildScheduleDeliveryOptions(CHANNELS, null);
    expect(labels(options)).toEqual([
      { label: "None", description: undefined, unavailable: false },
      { label: "Chat · Team room", description: undefined, unavailable: false },
      { label: "Chat · Releases", description: undefined, unavailable: false },
      { label: "pager (unavailable)", description: "token expired", unavailable: true },
    ]);
    expect(options[0]?.value).toBe(NO_DELIVERY_VALUE);
    expect(options[1]?.delivery).toEqual({ channel: "chat", to: "room-1" });
    expect(options[3]?.delivery).toBeUndefined();
  });

  it("keeps a stored target no plugin offers, labelled by its raw address", () => {
    const current = { channel: "chat", to: "old-room" };
    const options = buildScheduleDeliveryOptions(CHANNELS, current);
    expect(options[1]).toMatchObject({
      label: "chat:old-room",
      description: "Not currently offered by any plugin",
      value: deliveryOptionValue(current),
      delivery: current,
    });
    expect(
      buildScheduleDeliveryOptions(CHANNELS, { channel: "chat", to: "room-2" }).some(
        (option) => option.label === "chat:room-2",
      ),
    ).toBe(false);
  });

  it("is empty only when no channel exists and nothing is stored", () => {
    expect(
      buildScheduleDeliveryFieldModel({
        channels: [],
        isLoading: false,
        error: null,
        current: null,
      }),
    ).toEqual({ kind: "empty" });
    expect(
      buildScheduleDeliveryFieldModel({
        channels: [],
        isLoading: false,
        error: null,
        current: { channel: "chat", to: "x" },
      }).kind,
    ).toBe("ready");
    expect(
      buildScheduleDeliveryFieldModel({
        channels: undefined,
        isLoading: true,
        error: null,
        current: null,
      }),
    ).toEqual({ kind: "loading" });
    expect(
      buildScheduleDeliveryFieldModel({
        channels: undefined,
        isLoading: false,
        error: "Host is not connected",
        current: null,
      }),
    ).toEqual({ kind: "error", message: "Host is not connected" });
  });
});

describe("schedule delivery display", () => {
  it("names the target by label and falls back to the raw address", () => {
    expect(formatDeliveryTarget({ channel: "chat", to: "room-1" }, CHANNELS)).toBe(
      "Chat · Team room",
    );
    expect(formatDeliveryTarget({ channel: "chat", to: "gone" }, CHANNELS)).toBe("chat:gone");
    expect(formatDeliveryTarget({ channel: "chat", to: "room-1" }, undefined)).toBe("chat:room-1");
  });

  it("summarizes the last delivery with its time or its shortened error", () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    expect(
      summarizeLastDelivery(
        { runId: "r1", status: "delivered", at: "2026-01-01T00:05:00.000Z" },
        now,
      ),
    ).toEqual({ text: expect.stringMatching(/^Delivered /), failed: false });
    expect(
      summarizeLastDelivery(
        { runId: "r1", status: "failed", at: "2026-01-01T00:05:00.000Z", error: "room\narchived" },
        now,
      ),
    ).toEqual({ text: "Delivery failed: room archived", failed: true });
    expect(summarizeLastDelivery(undefined, now)).toBeNull();
    const long = truncateDeliveryError("x".repeat(200));
    expect(long).toHaveLength(80);
    expect(long.endsWith("…")).toBe(true);
  });
});
