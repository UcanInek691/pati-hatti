import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWhatsAppTextMessage } from "../src/whatsappSend";
import type { Env } from "../src/env";
import type { IntakeQueueMessage } from "../src/intakeQueue";

const accessToken = "test-access-token";

const env: Env = {
  APP_TIMEZONE: "Europe/Istanbul",
  WHATSAPP_VERIFY_TOKEN: "secret-token",
  WHATSAPP_APP_SECRET: "test-app-secret",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  SUPABASE_ANON_KEY: "test-anon-key",
  OPENAI_API_KEY: "unused",
  INTAKE_QUEUE: { send: async () => {} } as unknown as Queue<IntakeQueueMessage>,
  WHATSAPP_ACCOUNT_CREDENTIALS_JSON: JSON.stringify([
    { whatsapp_account_id: "11111111-1111-1111-1111-111111111111", phone_number_id: "918000001", access_token: accessToken },
  ]),
  WHATSAPP_GRAPH_API_VERSION: "v25.0",
};

const phoneNumberId = "918000001";
const recipientE164 = "+15550011111";
const content = "Bilgileri aldik, tesekkurler.";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function rawJsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sendWhatsAppTextMessage", () => {
  it("calls the documented URL, method, headers, and exact request body", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [{ id: "wamid.PROVIDER1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendWhatsAppTextMessage(phoneNumberId, recipientE164, content, accessToken, env);

    expect(result).toEqual({ kind: "accepted", providerMessageId: "wamid.PROVIDER1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`);
    expect(init.method).toBe("POST");
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${accessToken}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientE164,
      type: "text",
      text: { preview_url: false, body: content },
    });
  });

  it("uses each resolved account token only with that account's endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [{ id: "wamid.PROVIDER1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await sendWhatsAppTextMessage("918000001", recipientE164, content, "token-account-a", env);
    await sendWhatsAppTextMessage("918000002", recipientE164, content, "token-account-b", env);

    const [firstUrl, firstInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const [secondUrl, secondInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(firstUrl.toString()).toBe("https://graph.facebook.com/v25.0/918000001/messages");
    expect((firstInit.headers as Record<string, string>).authorization).toBe("Bearer token-account-a");
    expect(secondUrl.toString()).toBe("https://graph.facebook.com/v25.0/918000002/messages");
    expect((secondInit.headers as Record<string, string>).authorization).toBe("Bearer token-account-b");
  });

  it.each([
    "emergency_handoff",
    "human_handoff",
    "safety_questions",
    "pet_identity",
    "complaint",
    "intake_received",
  ])("sends the exact fixed content for the %s reply category unchanged, category-neutral", async (category) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [{ id: "wamid.PROVIDER1" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const fixedText = `fixed copy for ${category}`;

    await sendWhatsAppTextMessage(phoneNumberId, recipientE164, fixedText, accessToken, env);

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string).text).toEqual({ preview_url: false, body: fixedText });
  });

  it("tolerates unrelated top-level Meta response fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ messaging_product: "whatsapp", contacts: [{ input: recipientE164 }], messages: [{ id: "wamid.PROVIDER1" }] }),
      ),
    );
    expect(await sendWhatsAppTextMessage(phoneNumberId, recipientE164, content, accessToken, env)).toEqual({
      kind: "accepted",
      providerMessageId: "wamid.PROVIDER1",
    });
  });

  it("tolerates additive enumerable fields in Meta's message result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ messages: [{ id: "wamid.PROVIDER1", message_status: "accepted", group_id: "group-1" }] }),
      ),
    );

    expect(await sendWhatsAppTextMessage(phoneNumberId, recipientE164, content, accessToken, env)).toEqual({
      kind: "accepted",
      providerMessageId: "wamid.PROVIDER1",
    });
  });

  it.each([
    ["a blank token", "   ", env],
    ["a malformed graph version", accessToken, { ...env, WHATSAPP_GRAPH_API_VERSION: "25.0" }],
    ["a graph version with a non-zero minor", accessToken, { ...env, WHATSAPP_GRAPH_API_VERSION: "v25.1" }],
  ])("fails closed without calling fetch for %s", async (_label, badToken, badEnv) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendWhatsAppTextMessage(phoneNumberId, recipientE164, content, badToken, badEnv)).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty phone number id", "", recipientE164, content],
    ["a non-numeric phone number id", "abc123", recipientE164, content],
    ["a recipient missing the leading +", phoneNumberId, "15550011111", content],
    ["a recipient with a leading zero", phoneNumberId, "+05550011111", content],
    ["empty content", phoneNumberId, recipientE164, ""],
    ["oversized content", phoneNumberId, recipientE164, "a".repeat(4097)],
  ])("fails closed without calling fetch for %s", async (_label, badPhoneNumberId, badRecipient, badContent) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendWhatsAppTextMessage(badPhoneNumberId, badRecipient, badContent, accessToken, env)).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await sendWhatsAppTextMessage(phoneNumberId, recipientE164, content, accessToken, env)).toEqual({ kind: "failed" });
  });

  it("treats a non-2xx response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: { message: "invalid token" } }, 401)));
    expect(await sendWhatsAppTextMessage(phoneNumberId, recipientE164, content, accessToken, env)).toEqual({ kind: "failed" });
  });

  it("treats a body that is not valid JSON as failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError("bad json"); } } as unknown as Response),
    );
    expect(await sendWhatsAppTextMessage(phoneNumberId, recipientE164, content, accessToken, env)).toEqual({ kind: "failed" });
  });

  it.each([
    ["a non-object body", [{ id: "wamid.PROVIDER1" }]],
    ["a body missing messages", {}],
    ["a body with a non-array messages", { messages: { id: "wamid.PROVIDER1" } }],
    ["a body with zero messages", { messages: [] }],
    ["a body with more than one message", { messages: [{ id: "wamid.PROVIDER1" }, { id: "wamid.PROVIDER2" }] }],
    ["a message with a non-string id", { messages: [{ id: 1 }] }],
    ["a message with an empty id", { messages: [{ id: "" }] }],
    ["a message with an oversized id", { messages: [{ id: "a".repeat(513) }] }],
  ])("treats %s as a malformed response and fails", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await sendWhatsAppTextMessage(phoneNumberId, recipientE164, content, accessToken, env)).toEqual({ kind: "failed" });
  });

  it("rejects a non-plain message object and hidden extra columns", async () => {
    const nonPlain = Object.assign(Object.create(null), { id: "wamid.PROVIDER1" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse({ messages: [nonPlain] })));
    expect(await sendWhatsAppTextMessage(phoneNumberId, recipientE164, content, accessToken, env)).toEqual({ kind: "failed" });

    const hiddenExtra = { id: "wamid.PROVIDER1" };
    Object.defineProperty(hiddenExtra, "extra", { value: "x" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse({ messages: [hiddenExtra] })));
    expect(await sendWhatsAppTextMessage(phoneNumberId, recipientE164, content, accessToken, env)).toEqual({ kind: "failed" });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ messages: [{ id: "wamid.PROVIDER1" }] })));

    await sendWhatsAppTextMessage(phoneNumberId, recipientE164, content, accessToken, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("never returns or embeds the response body on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: { message: "sensitive detail" } }, 500)));
    const result = await sendWhatsAppTextMessage(phoneNumberId, recipientE164, content, accessToken, env);
    expect(JSON.stringify(result)).not.toContain("sensitive detail");
  });
});
