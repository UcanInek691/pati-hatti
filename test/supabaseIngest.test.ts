import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestWhatsAppTextMessage } from "../src/supabaseIngest";
import type { Env } from "../src/env";
import type { WhatsAppIngestItem } from "../src/whatsappIngest";
import type { IntakeQueueMessage } from "../src/intakeQueue";

const CONVERSATION_ID = "5c1f2b9e-9d6a-4c3b-8f21-6f7a2c1d3e4b";

const item: WhatsAppIngestItem = {
  phoneNumberId: "123456123",
  providerMessageId: "wamid.ID1",
  senderE164: "+16315551181",
  ownerName: "Kerry Fisher",
  messageText: "Hello!",
  providerTimestamp: "2020-10-19T00:33:21.000Z",
  payloadHash: "a".repeat(64),
};

const env: Env = {
  APP_TIMEZONE: "Europe/Istanbul",
  WHATSAPP_VERIFY_TOKEN: "secret-token",
  WHATSAPP_APP_SECRET: "test-app-secret",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  SUPABASE_ANON_KEY: "test-anon-key",
  OPENAI_API_KEY: "unused",
  INTAKE_QUEUE: { send: async () => {} } as unknown as Queue<IntakeQueueMessage>,
  WHATSAPP_ACCESS_TOKEN: "test-whatsapp-access-token",
  WHATSAPP_GRAPH_API_VERSION: "v25.0",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ingestWhatsAppTextMessage", () => {
  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "processed", conversation_id: CONVERSATION_ID }]));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await ingestWhatsAppTextMessage(item, env);

    expect(outcome).toEqual({ kind: "processed", conversationId: CONVERSATION_ID });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/ingest_whatsapp_text_message");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      p_phone_number_id: item.phoneNumberId,
      p_provider_message_id: item.providerMessageId,
      p_payload_hash: item.payloadHash,
      p_sender_e164: item.senderE164,
      p_owner_name: item.ownerName,
      p_message_text: item.messageText,
      p_provider_timestamp: item.providerTimestamp,
    });
  });

  it.each(["processed", "duplicate"] as const)("returns the conversation locator for %s", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result, conversation_id: CONVERSATION_ID.toUpperCase() }])));
    expect(await ingestWhatsAppTextMessage(item, env)).toEqual({
      kind: result,
      conversationId: CONVERSATION_ID.toUpperCase(),
    });
  });

  it("returns unknown_account without a locator", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "unknown_account", conversation_id: null }])));
    expect(await ingestWhatsAppTextMessage(item, env)).toEqual({ kind: "unknown_account" });
  });

  it.each([
    ["a missing conversation_id", { result: "processed" }],
    ["a null conversation_id", { result: "processed", conversation_id: null }],
    ["a non-string conversation_id", { result: "duplicate", conversation_id: 42 }],
    ["an object conversation_id", { result: "duplicate", conversation_id: { id: CONVERSATION_ID } }],
    ["a malformed conversation_id", { result: "processed", conversation_id: "not-a-uuid" }],
    ["a truncated conversation_id", { result: "processed", conversation_id: CONVERSATION_ID.slice(0, -1) }],
    ["a conversation_id with trailing content", { result: "duplicate", conversation_id: `${CONVERSATION_ID} ` }],
  ])("fails closed when a persisted result has %s", async (_label, row) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([row])));
    expect(await ingestWhatsAppTextMessage(item, env)).toEqual({ kind: "failed" });
  });

  it.each([
    ["a UUID", { result: "unknown_account", conversation_id: CONVERSATION_ID }],
    ["a missing field", { result: "unknown_account" }],
    ["an empty string", { result: "unknown_account", conversation_id: "" }],
  ])("fails closed when unknown_account carries %s instead of null", async (_label, row) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([row])));
    expect(await ingestWhatsAppTextMessage(item, env)).toEqual({ kind: "failed" });
  });

  it.each([
    ["a non-array body", { result: "processed", conversation_id: CONVERSATION_ID }],
    ["an empty array", []],
    ["two rows", [
      { result: "processed", conversation_id: CONVERSATION_ID },
      { result: "duplicate", conversation_id: CONVERSATION_ID },
    ]],
    ["an unknown result", [{ result: "unexpected", conversation_id: CONVERSATION_ID }]],
    ["a row missing the result field", [{ conversation_id: CONVERSATION_ID }]],
    ["a non-string result", [{ result: 1, conversation_id: CONVERSATION_ID }]],
    ["a null row", [null]],
    ["a string row", ["processed"]],
    ["an array row", [["processed", CONVERSATION_ID]]],
  ])("treats %s as a malformed response and fails", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await ingestWhatsAppTextMessage(item, env)).toEqual({ kind: "failed" });
  });

  it("treats a body that is not JSON as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>oops</html>", { status: 200 })));
    expect(await ingestWhatsAppTextMessage(item, env)).toEqual({ kind: "failed" });
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await ingestWhatsAppTextMessage(item, { ...env, SUPABASE_URL: "" });

    expect(outcome).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase configuration contains only whitespace", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await ingestWhatsAppTextMessage(item, { ...env, SUPABASE_SERVICE_ROLE_KEY: "   " })).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for an unparseable Supabase URL, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await ingestWhatsAppTextMessage(item, { ...env, SUPABASE_URL: "not a url" })).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    expect(await ingestWhatsAppTextMessage(item, env)).toEqual({ kind: "failed" });
  });

  it("treats a non-2xx response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await ingestWhatsAppTextMessage(item, env)).toEqual({ kind: "failed" });
  });

  it("allows plain HTTP for loopback localhost testing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "processed", conversation_id: CONVERSATION_ID }]));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await ingestWhatsAppTextMessage(item, { ...env, SUPABASE_URL: "http://localhost:54321" });

    expect(outcome).toEqual({ kind: "processed", conversationId: CONVERSATION_ID });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await ingestWhatsAppTextMessage(item, { ...env, SUPABASE_URL: "http://example.supabase.co" });

    expect(outcome).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
