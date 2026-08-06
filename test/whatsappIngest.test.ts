import { describe, expect, it } from "vitest";
import { extractTextMessages } from "../src/whatsappIngest";

function envelope(messages: unknown[], contacts: unknown[] = [{ profile: { name: "Kerry Fisher" }, wa_id: "16315551181" }]) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "16505551111", phone_number_id: "123456123" },
              contacts,
              messages,
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

function textMessage(overrides: Record<string, unknown> = {}) {
  return {
    from: "16315551181",
    id: "wamid.ID1",
    timestamp: "1603059201",
    type: "text",
    text: { body: "Hello!" },
    ...overrides,
  };
}

describe("extractTextMessages", () => {
  it("extracts a single inbound text message with the matching contact name", async () => {
    const result = await extractTextMessages(envelope([textMessage()]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toEqual([
      {
        phoneNumberId: "123456123",
        providerMessageId: "wamid.ID1",
        senderE164: "+16315551181",
        ownerName: "Kerry Fisher",
        messageText: "Hello!",
        providerTimestamp: new Date(1603059201 * 1000).toISOString(),
        payloadHash: result.items[0]?.payloadHash,
      },
    ]);
    expect(result.items[0]?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("extracts multiple inbound text messages across entries and changes", async () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        envelope([textMessage({ id: "wamid.A", from: "16315551181" })]).entry[0],
        envelope([textMessage({ id: "wamid.B", from: "16315551182" })], [{ profile: { name: "Other" }, wa_id: "16315551182" }]).entry[0],
      ],
    };
    const result = await extractTextMessages(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.providerMessageId)).toEqual(["wamid.A", "wamid.B"]);
  });

  it("uses the fallback owner name when no contact matches", async () => {
    const result = await extractTextMessages(envelope([textMessage()], []));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.ownerName).toBe("WhatsApp user");
  });

  it("uses the fallback owner name when the matching profile name is blank", async () => {
    const result = await extractTextMessages(envelope([textMessage()], [{ profile: { name: "   " }, wa_id: "16315551181" }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.ownerName).toBe("WhatsApp user");
  });

  it("caps an oversized contact name to 200 characters", async () => {
    const longName = "a".repeat(250);
    const result = await extractTextMessages(envelope([textMessage()], [{ profile: { name: longName }, wa_id: "16315551181" }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.ownerName).toBe("a".repeat(200));
  });

  it("ignores status-only events with no messages field", async () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_ID",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "123456123" },
                statuses: [{ id: "wamid.ID1", status: "delivered" }],
              },
              field: "messages",
            },
          ],
        },
      ],
    };
    const result = await extractTextMessages(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toEqual([]);
  });

  it("ignores unsupported non-text message types", async () => {
    const result = await extractTextMessages(envelope([{ from: "16315551181", id: "wamid.ID1", timestamp: "1603059201", type: "image" }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toEqual([]);
  });

  it("rejects a declared text message with missing text body", async () => {
    const result = await extractTextMessages(envelope([textMessage({ text: undefined })]));
    expect(result.ok).toBe(false);
  });

  it("rejects a declared text message with oversized text", async () => {
    const result = await extractTextMessages(envelope([textMessage({ text: { body: "a".repeat(65537) } })]));
    expect(result.ok).toBe(false);
  });

  it("counts Unicode text by code point", async () => {
    const result = await extractTextMessages(envelope([textMessage({ text: { body: "😀".repeat(40000) } })]));
    expect(result.ok).toBe(true);
  });

  it.each([
    ["non-numeric", "not-a-number"],
    ["leading zero", "0123456"],
    ["too short", "1"],
    ["too long", "1234567890123456"],
  ])("rejects a malformed sender (%s)", async (_label, from) => {
    const result = await extractTextMessages(envelope([textMessage({ from })]));
    expect(result.ok).toBe(false);
  });

  it.each([
    ["non-numeric", "not-a-number"],
    ["zero", "0"],
    ["leading zero", "0123"],
    ["outside the JavaScript date range", "999999999999999999999999"],
  ])("rejects a malformed timestamp (%s)", async (_label, timestamp) => {
    const result = await extractTextMessages(envelope([textMessage({ timestamp })]));
    expect(result.ok).toBe(false);
  });

  it("computes a stable hash independent of surrounding batch packaging", async () => {
    const alone = await extractTextMessages(envelope([textMessage()]));
    const batched = await extractTextMessages(envelope([textMessage({ id: "wamid.OTHER", from: "16315551182" }), textMessage()]));
    expect(alone.ok).toBe(true);
    expect(batched.ok).toBe(true);
    if (!alone.ok || !batched.ok) return;
    const aloneHash = alone.items[0]?.payloadHash;
    const batchedHash = batched.items.find((item) => item.providerMessageId === "wamid.ID1")?.payloadHash;
    expect(aloneHash).toBe(batchedHash);
  });

  it("deduplicates repeated (phone_number_id, message.id) items within one webhook", async () => {
    const result = await extractTextMessages(envelope([textMessage(), textMessage()]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
  });

  it("rejects a repeated message id whose normalized content conflicts", async () => {
    const result = await extractTextMessages(envelope([textMessage(), textMessage({ text: { body: "Altered" } })]));
    expect(result.ok).toBe(false);
  });

  it.each([
    ["phone-number id", envelope([textMessage()])],
    ["provider message id", envelope([textMessage({ id: "a".repeat(513) })])],
  ])("rejects an oversized %s", async (field, body) => {
    if (field === "phone-number id") {
      (body.entry[0]!.changes[0]!.value.metadata as { phone_number_id: string }).phone_number_id = "a".repeat(513);
    }
    expect((await extractTextMessages(body)).ok).toBe(false);
  });
});
