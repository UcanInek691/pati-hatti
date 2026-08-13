import { describe, expect, it } from "vitest";
import { extractInboundMessages, UNSUPPORTED_MEDIA_MARKER } from "../src/whatsappIngest";

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

describe("extractInboundMessages", () => {
  it("extracts a single inbound text message with the matching contact name", async () => {
    const result = await extractInboundMessages(envelope([textMessage()]));
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
    const result = await extractInboundMessages(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.providerMessageId)).toEqual(["wamid.A", "wamid.B"]);
  });

  it("uses the fallback owner name when no contact matches", async () => {
    const result = await extractInboundMessages(envelope([textMessage()], []));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.ownerName).toBe("WhatsApp user");
  });

  it("uses the fallback owner name when the matching profile name is blank", async () => {
    const result = await extractInboundMessages(envelope([textMessage()], [{ profile: { name: "   " }, wa_id: "16315551181" }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.ownerName).toBe("WhatsApp user");
  });

  it("caps an oversized contact name to 200 characters", async () => {
    const longName = "a".repeat(250);
    const result = await extractInboundMessages(envelope([textMessage()], [{ profile: { name: longName }, wa_id: "16315551181" }]));
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
    const result = await extractInboundMessages(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toEqual([]);
  });

  it.each(["reaction", "system", "unknown", "button"])("ignores the unrecognized message type %s", async (type) => {
    const result = await extractInboundMessages(envelope([{ from: "16315551181", id: "wamid.ID1", timestamp: "1603059201", type }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toEqual([]);
  });

  it("rejects a declared text message with missing text body", async () => {
    const result = await extractInboundMessages(envelope([textMessage({ text: undefined })]));
    expect(result.ok).toBe(false);
  });

  it("rejects a declared text message with oversized text", async () => {
    const result = await extractInboundMessages(envelope([textMessage({ text: { body: "a".repeat(65537) } })]));
    expect(result.ok).toBe(false);
  });

  it("counts Unicode text by code point", async () => {
    const result = await extractInboundMessages(envelope([textMessage({ text: { body: "😀".repeat(40000) } })]));
    expect(result.ok).toBe(true);
  });

  it.each([
    ["non-numeric", "not-a-number"],
    ["leading zero", "0123456"],
    ["too short", "1"],
    ["too long", "1234567890123456"],
  ])("rejects a malformed sender (%s)", async (_label, from) => {
    const result = await extractInboundMessages(envelope([textMessage({ from })]));
    expect(result.ok).toBe(false);
  });

  it.each([
    ["non-numeric", "not-a-number"],
    ["zero", "0"],
    ["leading zero", "0123"],
    ["outside the JavaScript date range", "999999999999999999999999"],
  ])("rejects a malformed timestamp (%s)", async (_label, timestamp) => {
    const result = await extractInboundMessages(envelope([textMessage({ timestamp })]));
    expect(result.ok).toBe(false);
  });

  it("computes a stable hash independent of surrounding batch packaging", async () => {
    const alone = await extractInboundMessages(envelope([textMessage()]));
    const batched = await extractInboundMessages(envelope([textMessage({ id: "wamid.OTHER", from: "16315551182" }), textMessage()]));
    expect(alone.ok).toBe(true);
    expect(batched.ok).toBe(true);
    if (!alone.ok || !batched.ok) return;
    const aloneHash = alone.items[0]?.payloadHash;
    const batchedHash = batched.items.find((item) => item.providerMessageId === "wamid.ID1")?.payloadHash;
    expect(aloneHash).toBe(batchedHash);
  });

  it("deduplicates repeated (phone_number_id, message.id) items within one webhook", async () => {
    const result = await extractInboundMessages(envelope([textMessage(), textMessage()]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
  });

  it("rejects a repeated message id whose normalized content conflicts", async () => {
    const result = await extractInboundMessages(envelope([textMessage(), textMessage({ text: { body: "Altered" } })]));
    expect(result.ok).toBe(false);
  });

  it.each([
    ["phone-number id", envelope([textMessage()])],
    ["provider message id", envelope([textMessage({ id: "a".repeat(513) })])],
  ])("rejects an oversized %s", async (field, body) => {
    if (field === "phone-number id") {
      (body.entry[0]!.changes[0]!.value.metadata as { phone_number_id: string }).phone_number_id = "a".repeat(513);
    }
    expect((await extractInboundMessages(body)).ok).toBe(false);
  });
});

describe("extractInboundMessages: unsupported media (Task 030)", () => {
  const MEDIA_TYPES = ["audio", "contacts", "document", "image", "location", "sticker", "video"] as const;

  function mediaMessage(type: string, overrides: Record<string, unknown> = {}) {
    return {
      from: "16315551181",
      id: "wamid.ID1",
      timestamp: "1603059201",
      type,
      ...overrides,
    };
  }

  it("has a fixed ASCII marker that carries no user or provider data", () => {
    expect(UNSUPPORTED_MEDIA_MARKER).toBe("__vetai_unsupported_media__");
    expect(UNSUPPORTED_MEDIA_MARKER).toMatch(/^[\x21-\x7e]+$/);
    expect(Array.from(UNSUPPORTED_MEDIA_MARKER).length).toBeLessThan(65536);
  });

  it.each(MEDIA_TYPES)("emits exactly one marker item for a %s message", async (type) => {
    const result = await extractInboundMessages(envelope([mediaMessage(type)]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toEqual([
      {
        phoneNumberId: "123456123",
        providerMessageId: "wamid.ID1",
        senderE164: "+16315551181",
        ownerName: "Kerry Fisher",
        messageText: UNSUPPORTED_MEDIA_MARKER,
        providerTimestamp: new Date(1603059201 * 1000).toISOString(),
        payloadHash: result.items[0]?.payloadHash,
      },
    ]);
    expect(result.items[0]?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("applies the same contact-name fallback and cap as text messages", async () => {
    const fallback = await extractInboundMessages(envelope([mediaMessage("image")], []));
    const capped = await extractInboundMessages(envelope([mediaMessage("image")], [{ profile: { name: "a".repeat(250) }, wa_id: "16315551181" }]));
    expect(fallback.ok && capped.ok).toBe(true);
    if (!fallback.ok || !capped.ok) return;
    expect(fallback.items[0]?.ownerName).toBe("WhatsApp user");
    expect(capped.items[0]?.ownerName).toBe("a".repeat(200));
  });

  it.each([
    ["sender", { from: "bad-sender" }],
    ["message id", { id: "" }],
    ["oversized message id", { id: "a".repeat(513) }],
    ["timestamp", { timestamp: "0" }],
  ])("rejects the whole webhook for a media message with a malformed %s", async (_label, overrides) => {
    const result = await extractInboundMessages(envelope([mediaMessage("image", overrides)]));
    expect(result.ok).toBe(false);
  });

  it("rejects a media message when the phone-number id is malformed", async () => {
    const body = envelope([mediaMessage("image")]);
    (body.entry[0]!.changes[0]!.value.metadata as { phone_number_id: string }).phone_number_id = "a".repeat(513);
    expect((await extractInboundMessages(body)).ok).toBe(false);
  });

  it("neither requires nor reads the nested media payload when hashing", async () => {
    const bare = await extractInboundMessages(envelope([mediaMessage("image")]));
    const rich = await extractInboundMessages(
      envelope([
        mediaMessage("image", {
          image: { id: "MEDIA_ID", mime_type: "image/jpeg", sha256: "abc", caption: "Pamuk'un patisi" },
        }),
      ]),
    );
    expect(bare.ok && rich.ok).toBe(true);
    if (!bare.ok || !rich.ok) return;
    expect(rich.items).toHaveLength(1);
    expect(rich.items[0]?.payloadHash).toBe(bare.items[0]?.payloadHash);
    expect(rich.items[0]?.messageText).toBe(UNSUPPORTED_MEDIA_MARKER);
  });

  it("collapses identical in-payload media duplicates", async () => {
    const result = await extractInboundMessages(envelope([mediaMessage("image"), mediaMessage("image", { image: { id: "OTHER" } })]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
  });

  it.each([
    ["a different declared media type", [mediaMessage("image"), mediaMessage("video")]],
    ["a text message with the same key", [mediaMessage("image"), textMessage()]],
  ])("rejects the same (phone_number_id, id) key declaring %s", async (_label, messages) => {
    expect((await extractInboundMessages(envelope(messages))).ok).toBe(false);
  });

  it("hashes a media item differently from a text message whose body equals the marker", async () => {
    const media = await extractInboundMessages(envelope([mediaMessage("image")]));
    const text = await extractInboundMessages(envelope([textMessage({ text: { body: UNSUPPORTED_MEDIA_MARKER } })]));
    expect(media.ok && text.ok).toBe(true);
    if (!media.ok || !text.ok) return;
    expect(media.items[0]?.payloadHash).not.toBe(text.items[0]?.payloadHash);
    expect(text.items[0]?.messageText).toBe(UNSUPPORTED_MEDIA_MARKER);
  });

  it("keeps text and media items side by side in one webhook", async () => {
    const result = await extractInboundMessages(envelope([textMessage(), mediaMessage("audio", { id: "wamid.ID2" })]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.messageText)).toEqual(["Hello!", UNSUPPORTED_MEDIA_MARKER]);
  });
});
