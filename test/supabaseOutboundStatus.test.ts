import { afterEach, describe, expect, it, vi } from "vitest";
import { recordWhatsAppOutboundStatus } from "../src/supabaseOutboundStatus";
import type { WhatsAppStatusItem } from "../src/whatsappStatus";
import type { Env } from "../src/env";
import type { IntakeQueueMessage } from "../src/intakeQueue";

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

const item: WhatsAppStatusItem = {
  phoneNumberId: "918000001",
  providerMessageId: "wamid.PROVIDER1",
  recipientE164: "+15550011111",
  status: "delivered",
  providerTimestamp: "2020-10-18T22:13:21.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function rawJsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recordWhatsAppOutboundStatus", () => {
  it("calls the RPC with the documented URL, method, headers, and exact argument names/values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "recorded" }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await recordWhatsAppOutboundStatus(item, env);

    expect(result).toEqual({ kind: "recorded" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/record_whatsapp_outbound_status");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      p_phone_number_id: item.phoneNumberId,
      p_provider_message_id: item.providerMessageId,
      p_recipient_e164: item.recipientE164,
      p_provider_status: item.status,
      p_provider_timestamp: item.providerTimestamp,
    });
  });

  it.each(["recorded", "duplicate", "stale", "not_found"] as const)("parses a %s result", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result }])));
    expect(await recordWhatsAppOutboundStatus(item, env)).toEqual({ kind: result });
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await recordWhatsAppOutboundStatus(item, { ...env, SUPABASE_URL: "" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the service role key is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await recordWhatsAppOutboundStatus(item, { ...env, SUPABASE_SERVICE_ROLE_KEY: "   " });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await recordWhatsAppOutboundStatus(item, { ...env, SUPABASE_URL: "http://example.supabase.co" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for a malformed Supabase URL, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await recordWhatsAppOutboundStatus(item, { ...env, SUPABASE_URL: "not a url" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows plain HTTP for loopback localhost testing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "recorded" }])));
    const result = await recordWhatsAppOutboundStatus(item, { ...env, SUPABASE_URL: "http://localhost:54321" });
    expect(result).toEqual({ kind: "recorded" });
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await recordWhatsAppOutboundStatus(item, env)).toEqual({ kind: "failed" });
  });

  it("treats a non-2xx response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await recordWhatsAppOutboundStatus(item, env)).toEqual({ kind: "failed" });
  });

  it("treats a body that is not valid JSON as failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError("bad json"); } } as unknown as Response),
    );
    expect(await recordWhatsAppOutboundStatus(item, env)).toEqual({ kind: "failed" });
  });

  it.each([
    ["a non-array body", { result: "recorded" }],
    ["zero rows", []],
    ["more than one row", [{ result: "recorded" }, { result: "recorded" }]],
    ["a row with an extra column", [{ result: "recorded", extra: "x" }]],
    ["a row with an unknown result", [{ result: "invented" }]],
    ["a row with a null result", [{ result: null }]],
  ])("treats %s as a malformed response and fails", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await recordWhatsAppOutboundStatus(item, env)).toEqual({ kind: "failed" });
  });

  it("rejects a non-plain row and hidden extra columns", async () => {
    const nonPlain = Object.assign(Object.create(null), { result: "recorded" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([nonPlain])));
    expect(await recordWhatsAppOutboundStatus(item, env)).toEqual({ kind: "failed" });

    const hiddenExtra = { result: "recorded" };
    Object.defineProperty(hiddenExtra, "extra", { value: "x" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([hiddenExtra])));
    expect(await recordWhatsAppOutboundStatus(item, env)).toEqual({ kind: "failed" });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "recorded" }])));

    await recordWhatsAppOutboundStatus(item, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("never returns or embeds the response body on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "sensitive detail" }, 500)));
    const result = await recordWhatsAppOutboundStatus(item, env);
    expect(JSON.stringify(result)).not.toContain("sensitive detail");
  });
});
