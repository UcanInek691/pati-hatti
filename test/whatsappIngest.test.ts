import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractInboundMessages, UNSUPPORTED_MEDIA_MARKER } from "../src/whatsappIngest";
import { resolveWhatsAppContactAutomation } from "../src/contactAutomation";
import type { Env } from "../src/env";
import type { IntakeQueueMessage } from "../src/intakeQueue";

vi.mock("../src/contactAutomation", () => ({
  resolveWhatsAppContactAutomation: vi.fn(),
}));

const resolveMock = vi.mocked(resolveWhatsAppContactAutomation);

const env: Env = {
  APP_TIMEZONE: "Europe/Istanbul",
  WHATSAPP_VERIFY_TOKEN: "secret-token",
  WHATSAPP_APP_SECRET: "test-app-secret",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  SUPABASE_ANON_KEY: "test-anon-key",
  OPENAI_API_KEY: "unused",
  INTAKE_QUEUE: { send: async () => {} } as unknown as Queue<IntakeQueueMessage>,
  WHATSAPP_ACCOUNT_CREDENTIALS_JSON: JSON.stringify([{ whatsapp_account_id: "33333333-3333-3333-3333-333333333333", phone_number_id: "918000001", access_token: "test-access-token" }]),
  WHATSAPP_GRAPH_API_VERSION: "v25.0",
};

beforeEach(() => {
  resolveMock.mockReset();
  resolveMock.mockResolvedValue({ kind: "ai" });
});

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
    const result = await extractInboundMessages(envelope([textMessage()]), env);
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
    const result = await extractInboundMessages(body, env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.providerMessageId)).toEqual(["wamid.A", "wamid.B"]);
  });

  it("uses the fallback owner name when no contact matches", async () => {
    const result = await extractInboundMessages(envelope([textMessage()], []), env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.ownerName).toBe("WhatsApp user");
  });

  it("uses the fallback owner name when the matching profile name is blank", async () => {
    const result = await extractInboundMessages(envelope([textMessage()], [{ profile: { name: "   " }, wa_id: "16315551181" }]), env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.ownerName).toBe("WhatsApp user");
  });

  it("caps an oversized contact name to 200 characters", async () => {
    const longName = "a".repeat(250);
    const result = await extractInboundMessages(envelope([textMessage()], [{ profile: { name: longName }, wa_id: "16315551181" }]), env);
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
    const result = await extractInboundMessages(body, env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toEqual([]);
  });

  it.each(["reaction", "system", "unknown", "button"])("ignores the unrecognized message type %s", async (type) => {
    const result = await extractInboundMessages(envelope([{ from: "16315551181", id: "wamid.ID1", timestamp: "1603059201", type }]), env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toEqual([]);
  });

  it("rejects a declared text message with missing text body", async () => {
    const result = await extractInboundMessages(envelope([textMessage({ text: undefined })]), env);
    expect(result.ok).toBe(false);
  });

  it("rejects a declared text message with oversized text", async () => {
    const result = await extractInboundMessages(envelope([textMessage({ text: { body: "a".repeat(65537) } })]), env);
    expect(result.ok).toBe(false);
  });

  it("counts Unicode text by code point", async () => {
    const result = await extractInboundMessages(envelope([textMessage({ text: { body: "😀".repeat(40000) } })]), env);
    expect(result.ok).toBe(true);
  });

  it.each([
    ["non-numeric", "not-a-number"],
    ["leading zero", "0123456"],
    ["too short", "1"],
    ["too long", "1234567890123456"],
  ])("rejects a malformed sender (%s)", async (_label, from) => {
    const result = await extractInboundMessages(envelope([textMessage({ from })]), env);
    expect(result.ok).toBe(false);
  });

  it.each([
    ["non-numeric", "not-a-number"],
    ["zero", "0"],
    ["leading zero", "0123"],
    ["outside the JavaScript date range", "999999999999999999999999"],
  ])("rejects a malformed timestamp (%s)", async (_label, timestamp) => {
    const result = await extractInboundMessages(envelope([textMessage({ timestamp })]), env);
    expect(result.ok).toBe(false);
  });

  it("computes a stable hash independent of surrounding batch packaging", async () => {
    const alone = await extractInboundMessages(envelope([textMessage()]), env);
    const batched = await extractInboundMessages(envelope([textMessage({ id: "wamid.OTHER", from: "16315551182" }), textMessage()]), env);
    expect(alone.ok).toBe(true);
    expect(batched.ok).toBe(true);
    if (!alone.ok || !batched.ok) return;
    const aloneHash = alone.items[0]?.payloadHash;
    const batchedHash = batched.items.find((item) => item.providerMessageId === "wamid.ID1")?.payloadHash;
    expect(aloneHash).toBe(batchedHash);
  });

  it("deduplicates repeated (phone_number_id, message.id) items within one webhook", async () => {
    const result = await extractInboundMessages(envelope([textMessage(), textMessage()]), env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
  });

  it("rejects a repeated message id whose normalized content conflicts", async () => {
    const result = await extractInboundMessages(envelope([textMessage(), textMessage({ text: { body: "Altered" } })]), env);
    expect(result.ok).toBe(false);
  });

  it.each([
    ["phone-number id", envelope([textMessage()])],
    ["provider message id", envelope([textMessage({ id: "a".repeat(513) })])],
  ])("rejects an oversized %s", async (field, body) => {
    if (field === "phone-number id") {
      (body.entry[0]!.changes[0]!.value.metadata as { phone_number_id: string }).phone_number_id = "a".repeat(513);
    }
    expect((await extractInboundMessages(body, env)).ok).toBe(false);
  });
});

describe("extractInboundMessages: envelope-first automation routing (Task 033)", () => {
  it("resolves the route from the phone-number id and E.164 sender before reading any nested content", async () => {
    await extractInboundMessages(envelope([textMessage()]), env);
    expect(resolveMock).toHaveBeenCalledWith("123456123", "+16315551181", env);
  });

  it("skips a candidate whose contact route is personal without reading its nested content", async () => {
    resolveMock.mockResolvedValue({ kind: "personal" });
    const body = envelope([textMessage({ text: undefined })]);
    const value = body.entry[0]!.changes[0]!.value;
    Object.defineProperty(value, "contacts", {
      get() {
        throw new Error("personal contact/profile fields must not be read");
      },
    });
    const result = await extractInboundMessages(body, env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toEqual([]);
  });

  it("fails the whole webhook closed when route resolution fails", async () => {
    resolveMock.mockResolvedValue({ kind: "failed" });
    const result = await extractInboundMessages(envelope([textMessage()]), env);
    expect(result).toEqual({ ok: false, reason: "route_failed" });
  });

  it.each(["manual", "unknown_account"] as const)("still extracts content for a %s route", async (kind) => {
    resolveMock.mockResolvedValue({ kind });
    const result = await extractInboundMessages(envelope([textMessage()]), env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
  });

  it("resolves the route independently per candidate sender", async () => {
    resolveMock.mockImplementation(async (_phoneNumberId, contactE164) =>
      contactE164 === "+16315551182" ? { kind: "personal" } : { kind: "ai" },
    );
    const body = {
      object: "whatsapp_business_account",
      entry: [
        envelope([textMessage({ id: "wamid.A", from: "16315551181" })]).entry[0],
        envelope([textMessage({ id: "wamid.B", from: "16315551182" })], [{ profile: { name: "Other" }, wa_id: "16315551182" }]).entry[0],
      ],
    };
    const result = await extractInboundMessages(body, env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.providerMessageId)).toEqual(["wamid.A"]);
  });
});

describe("extractInboundMessages: group exclusion (Task 034 Phase C)", () => {
  it.each([
    ["message group_id", { group_id: "GROUP_ID" }],
    ["recipient_type", { recipient_type: "group" }],
    ["context group_id", { context: { group_id: "GROUP_ID" } }],
  ])("ignores a group message identified by %s before routing or content access", async (_label, discriminator) => {
    const message = textMessage(discriminator);
    Object.defineProperty(message, "text", {
      get() {
        throw new Error("group content must not be read");
      },
    });
    const body = envelope([message]);
    const value = body.entry[0]!.changes[0]!.value;
    Object.defineProperty(value, "contacts", {
      get() {
        throw new Error("group contact/profile data must not be read");
      },
    });

    const result = await extractInboundMessages(body, env);

    expect(result).toEqual({ ok: true, items: [] });
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it.each([
    ["value group_id", { group_id: "GROUP_ID" }],
    ["value recipient_type", { recipient_type: "group" }],
  ])("ignores a group change identified by %s before reading its messages", async (_label, discriminator) => {
    const body = envelope([]) as unknown as {
      entry: Array<{ changes: Array<{ value: Record<string, unknown> }> }>;
    };
    const value = body.entry[0]!.changes[0]!.value;
    Object.assign(value, discriminator);
    Object.defineProperty(value, "messages", {
      get() {
        throw new Error("group messages must not be read");
      },
    });

    const result = await extractInboundMessages(body, env);

    expect(result).toEqual({ ok: true, items: [] });
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("skips only the group candidate in a mixed batch and keeps the direct message", async () => {
    const result = await extractInboundMessages(
      envelope([
        textMessage({ id: "wamid.GROUP", group_id: "GROUP_ID", text: { body: "private group text" } }),
        textMessage({ id: "wamid.DIRECT", text: { body: "direct text" } }),
      ]),
      env,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => ({ id: item.providerMessageId, text: item.messageText }))).toEqual([
      { id: "wamid.DIRECT", text: "direct text" },
    ]);
    expect(resolveMock).toHaveBeenCalledTimes(1);
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
    const result = await extractInboundMessages(envelope([mediaMessage(type)]), env);
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
    const fallback = await extractInboundMessages(envelope([mediaMessage("image")], []), env);
    const capped = await extractInboundMessages(
      envelope([mediaMessage("image")], [{ profile: { name: "a".repeat(250) }, wa_id: "16315551181" }]),
      env,
    );
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
    const result = await extractInboundMessages(envelope([mediaMessage("image", overrides)]), env);
    expect(result.ok).toBe(false);
  });

  it("rejects a media message when the phone-number id is malformed", async () => {
    const body = envelope([mediaMessage("image")]);
    (body.entry[0]!.changes[0]!.value.metadata as { phone_number_id: string }).phone_number_id = "a".repeat(513);
    expect((await extractInboundMessages(body, env)).ok).toBe(false);
  });

  it("neither requires nor reads the nested media payload when hashing", async () => {
    const bare = await extractInboundMessages(envelope([mediaMessage("image")]), env);
    const rich = await extractInboundMessages(
      envelope([
        mediaMessage("image", {
          image: { id: "MEDIA_ID", mime_type: "image/jpeg", sha256: "abc", caption: "Pamuk'un patisi" },
        }),
      ]),
      env,
    );
    expect(bare.ok && rich.ok).toBe(true);
    if (!bare.ok || !rich.ok) return;
    expect(rich.items).toHaveLength(1);
    expect(rich.items[0]?.payloadHash).toBe(bare.items[0]?.payloadHash);
    expect(rich.items[0]?.messageText).toBe(UNSUPPORTED_MEDIA_MARKER);
  });

  it("collapses identical in-payload media duplicates", async () => {
    const result = await extractInboundMessages(envelope([mediaMessage("image"), mediaMessage("image", { image: { id: "OTHER" } })]), env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
  });

  it.each([
    ["a different declared media type", [mediaMessage("image"), mediaMessage("video")]],
    ["a text message with the same key", [mediaMessage("image"), textMessage()]],
  ])("rejects the same (phone_number_id, id) key declaring %s", async (_label, messages) => {
    expect((await extractInboundMessages(envelope(messages), env)).ok).toBe(false);
  });

  it("hashes a media item differently from a text message whose body equals the marker", async () => {
    const media = await extractInboundMessages(envelope([mediaMessage("image")]), env);
    const text = await extractInboundMessages(envelope([textMessage({ text: { body: UNSUPPORTED_MEDIA_MARKER } })]), env);
    expect(media.ok && text.ok).toBe(true);
    if (!media.ok || !text.ok) return;
    expect(media.items[0]?.payloadHash).not.toBe(text.items[0]?.payloadHash);
    expect(text.items[0]?.messageText).toBe(UNSUPPORTED_MEDIA_MARKER);
  });

  it("keeps text and media items side by side in one webhook", async () => {
    const result = await extractInboundMessages(envelope([textMessage(), mediaMessage("audio", { id: "wamid.ID2" })]), env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.messageText)).toEqual(["Hello!", UNSUPPORTED_MEDIA_MARKER]);
  });
});
