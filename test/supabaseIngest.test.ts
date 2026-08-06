import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestWhatsAppTextMessage } from "../src/supabaseIngest";
import type { Env } from "../src/env";
import type { WhatsAppIngestItem } from "../src/whatsappIngest";

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
  OPENAI_API_KEY: "unused",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ingestWhatsAppTextMessage", () => {
  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "processed" }]));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await ingestWhatsAppTextMessage(item, env);

    expect(outcome).toBe("processed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/ingest_whatsapp_text_message");
    expect(init.method).toBe("POST");
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

  it.each(["processed", "duplicate", "unknown_account"] as const)("accepts the documented result %s", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result }])));
    expect(await ingestWhatsAppTextMessage(item, env)).toBe(result);
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await ingestWhatsAppTextMessage(item, { ...env, SUPABASE_URL: "" });

    expect(outcome).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase configuration contains only whitespace", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await ingestWhatsAppTextMessage(item, { ...env, SUPABASE_SERVICE_ROLE_KEY: "   " })).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    expect(await ingestWhatsAppTextMessage(item, env)).toBe("failed");
  });

  it("treats a non-2xx response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await ingestWhatsAppTextMessage(item, env)).toBe("failed");
  });

  it.each([
    ["a non-array body", { result: "processed" }],
    ["an empty array", []],
    ["a row without a valid result", [{ result: "unexpected" }]],
    ["a row missing the result field", [{}]],
  ])("treats %s as a malformed response and fails", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await ingestWhatsAppTextMessage(item, env)).toBe("failed");
  });

  it("allows plain HTTP for loopback localhost testing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "processed" }]));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await ingestWhatsAppTextMessage(item, { ...env, SUPABASE_URL: "http://localhost:54321" });

    expect(outcome).toBe("processed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await ingestWhatsAppTextMessage(item, { ...env, SUPABASE_URL: "http://example.supabase.co" });

    expect(outcome).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
