import { describe, expect, it, vi } from "vitest";
import { extractOutboundStatuses } from "../src/whatsappStatus";

const phoneNumberId = "123456123";
const providerMessageId = "wamid.PROVIDER1";
const recipientId = "16315551181";
const recipientE164 = "+16315551181";
const timestamp = "1603059201";

function statusItem(overrides: Record<string, unknown> = {}) {
  return {
    id: providerMessageId,
    status: "sent",
    timestamp,
    recipient_id: recipientId,
    ...overrides,
  };
}

function envelope(statuses: unknown, metadata: Record<string, unknown> = { phone_number_id: phoneNumberId }) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            value: { messaging_product: "whatsapp", metadata, statuses },
            field: "messages",
          },
        ],
      },
    ],
  };
}

describe("extractOutboundStatuses", () => {
  it.each(["sent", "delivered", "read", "failed"] as const)(
    "extracts an official-shaped %s status callback",
    async (status) => {
      const result = await extractOutboundStatuses(envelope([statusItem({ status })]));
      expect(result).toEqual({
        ok: true,
        items: [{ phoneNumberId, providerMessageId, recipientE164, status, providerTimestamp: "2020-10-18T22:13:21.000Z" }],
      });
    },
  );

  it("preserves first-seen order across multiple entries, changes, and statuses", async () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: phoneNumberId },
                statuses: [statusItem({ id: "wamid.A", status: "sent" }), statusItem({ id: "wamid.B", status: "delivered" })],
              },
            },
          ],
        },
        {
          id: "WABA_2",
          changes: [
            {
              field: "messages",
              value: { metadata: { phone_number_id: phoneNumberId }, statuses: [statusItem({ id: "wamid.C", status: "read" })] },
            },
          ],
        },
      ],
    };

    const result = await extractOutboundStatuses(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.providerMessageId)).toEqual(["wamid.A", "wamid.B", "wamid.C"]);
  });

  it("dedupes exact in-payload repetitions by the canonical tuple, keeping first-seen order", async () => {
    const result = await extractOutboundStatuses(
      envelope([statusItem({ id: "wamid.A" }), statusItem({ id: "wamid.B" }), statusItem({ id: "wamid.A" })]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.providerMessageId)).toEqual(["wamid.A", "wamid.B"]);
  });

  it("does not dedupe status items that differ only by status or timestamp", async () => {
    const result = await extractOutboundStatuses(
      envelope([statusItem({ status: "sent" }), statusItem({ status: "delivered" }), statusItem({ timestamp: "1603059999" })]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(3);
  });

  it("tolerates additive enumerable fields at every provider-owned level", async () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_ID",
          extra_entry_field: "x",
          changes: [
            {
              field: "messages",
              extra_change_field: "y",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: phoneNumberId, display_phone_number: "16505551234" },
                statuses: [statusItem({ conversation: { id: "conv-1" }, pricing: { billable: true } })],
              },
            },
          ],
        },
      ],
    };

    const result = await extractOutboundStatuses(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({
      phoneNumberId,
      providerMessageId,
      recipientE164,
      status: "sent",
      providerTimestamp: "2020-10-18T22:13:21.000Z",
    });
  });

  it("ignores status names outside the supported four-value set instead of rejecting the webhook", async () => {
    const result = await extractOutboundStatuses(envelope([statusItem({ id: "wamid.A", status: "warehouse_receipt" })]));
    expect(result).toEqual({ ok: true, items: [] });
  });

  it("skips changes unrelated to outbound statuses", async () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        { id: "WABA_ID", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: {} } }] },
        { id: "WABA_ID2", changes: [{ field: "account_alerts", value: { some: "thing" } }] },
      ],
    };
    expect(await extractOutboundStatuses(body)).toEqual({ ok: true, items: [] });
  });

  it("rejects the whole webhook when the statuses property is not an array", async () => {
    expect(await extractOutboundStatuses(envelope({ not: "an array" }))).toEqual({ ok: false });
  });

  it("skips a non-object status item instead of rejecting the webhook", async () => {
    expect(await extractOutboundStatuses(envelope(["not-an-object", statusItem({ id: "wamid.A" })]))).toEqual({
      ok: true,
      items: [{ phoneNumberId, providerMessageId: "wamid.A", recipientE164, status: "sent", providerTimestamp: "2020-10-18T22:13:21.000Z" }],
    });
  });

  it.each([
    ["a status item missing id", statusItem({ id: undefined })],
    ["a status item with a non-string id", statusItem({ id: 1 })],
    ["a status item with an empty id", statusItem({ id: "" })],
    ["a status item with an oversized id", statusItem({ id: "a".repeat(513) })],
    ["a status item missing recipient_id", statusItem({ recipient_id: undefined })],
    ["a status item with a non-numeric recipient_id", statusItem({ recipient_id: "abc" })],
    ["a status item with a recipient_id leading zero", statusItem({ recipient_id: "0123" })],
    ["a status item with a recipient_id with a leading +", statusItem({ recipient_id: "+16315551181" })],
    ["a status item missing timestamp", statusItem({ timestamp: undefined })],
    ["a status item with a non-numeric timestamp", statusItem({ timestamp: "not-a-number" })],
    ["a status item with a zero timestamp", statusItem({ timestamp: "0" })],
    ["a status item with a negative timestamp", statusItem({ timestamp: "-5" })],
    ["a status item with a fractional timestamp", statusItem({ timestamp: "1603059201.5" })],
    ["a status item with an unsafe-integer timestamp", statusItem({ timestamp: "9".repeat(320) })],
  ])("rejects the whole webhook for %s", async (_label, badStatus) => {
    const result = await extractOutboundStatuses(envelope([badStatus]));
    expect(result).toEqual({ ok: false });
  });

  it.each([
    ["a blank phone_number_id", { phone_number_id: "" }],
    ["a non-numeric phone_number_id", { phone_number_id: "abc123" }],
    ["a missing phone_number_id", {}],
  ])("rejects the whole webhook for %s", async (_label, metadata) => {
    expect(await extractOutboundStatuses(envelope([statusItem()], metadata))).toEqual({ ok: false });
  });

  it("rejects a non-plain status object", async () => {
    const nonPlain = Object.assign(Object.create(null), statusItem());
    expect(await extractOutboundStatuses(envelope([nonPlain]))).toEqual({ ok: false });
  });

  it("rejects a status object with a hidden (non-enumerable) extra field", async () => {
    const hiddenExtra = statusItem();
    Object.defineProperty(hiddenExtra, "secret", { value: "x", enumerable: false });
    expect(await extractOutboundStatuses(envelope([hiddenExtra]))).toEqual({ ok: false });
  });

  it("rejects a status object with a symbol-keyed extra field", async () => {
    const withSymbol = { ...statusItem(), [Symbol("extra")]: "x" };
    expect(await extractOutboundStatuses(envelope([withSymbol]))).toEqual({ ok: false });
  });

  it("fails closed instead of throwing when a status field getter throws", async () => {
    const throwing = statusItem();
    delete (throwing as Record<string, unknown>).id;
    Object.defineProperty(throwing, "id", {
      enumerable: true,
      get(): string {
        throw new Error("boom");
      },
    });
    await expect(extractOutboundStatuses(envelope([throwing]))).resolves.toEqual({ ok: false });
  });

  it("does not mutate the input body", async () => {
    const body = envelope([statusItem({ id: "wamid.A" }), statusItem({ id: "wamid.A" })]);
    const before = JSON.stringify(body);
    await extractOutboundStatuses(body);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("does not log anything", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await extractOutboundStatuses(envelope([statusItem()]));

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("never returns raw provider fields such as conversation or pricing metadata", async () => {
    const result = await extractOutboundStatuses(
      envelope([statusItem({ conversation: { id: "conv-1" }, pricing: { billable: true }, errors: [{ code: 131_000 }] })]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.items)).not.toContain("conv-1");
    expect(JSON.stringify(result.items)).not.toContain("billable");
    expect(JSON.stringify(result.items)).not.toContain("131000");
  });
});
