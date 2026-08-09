import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptOutboundMessage, claimOutboundMessage, releaseOutboundMessage } from "../src/outboundDelivery";
import type { Env } from "../src/env";
import type { IntakeQueueMessage } from "../src/intakeQueue";

const env: Env = {
  APP_TIMEZONE: "Europe/Istanbul",
  WHATSAPP_VERIFY_TOKEN: "secret-token",
  WHATSAPP_APP_SECRET: "test-app-secret",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  OPENAI_API_KEY: "unused",
  INTAKE_QUEUE: { send: async () => {} } as unknown as Queue<IntakeQueueMessage>,
  WHATSAPP_ACCESS_TOKEN: "test-whatsapp-access-token",
  WHATSAPP_GRAPH_API_VERSION: "v25.0",
};

const outboxId = "11111111-1111-1111-1111-111111111111";
const claimToken = "22222222-2222-2222-2222-222222222222";
const providerMessageId = "wamid.PROVIDER1";

const claimedRow = {
  result: "claimed",
  outbox_id: outboxId,
  claim_token: claimToken,
  phone_number_id: "918000001",
  recipient_e164: "+15550011111",
  content: "Hello",
  attempt_count: 1,
};

const claimedParsed = {
  kind: "claimed",
  outboxId,
  claimToken,
  phoneNumberId: "918000001",
  recipientE164: "+15550011111",
  content: "Hello",
  attemptCount: 1,
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

describe("claimOutboundMessage", () => {
  it("calls the RPC with the documented URL, method, headers, and an empty body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([claimedRow]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await claimOutboundMessage(env);

    expect(result).toEqual(claimedParsed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/claim_outbound_message");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it.each(["exhausted", "empty"] as const)("parses a %s result with all other fields null", async (result) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          { result, outbox_id: null, claim_token: null, phone_number_id: null, recipient_e164: null, content: null, attempt_count: null },
        ]),
      ),
    );
    expect(await claimOutboundMessage(env)).toEqual({ kind: result });
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await claimOutboundMessage({ ...env, SUPABASE_URL: "" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await claimOutboundMessage({ ...env, SUPABASE_URL: "http://example.supabase.co" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows plain HTTP for loopback localhost testing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([claimedRow])));
    const result = await claimOutboundMessage({ ...env, SUPABASE_URL: "http://localhost:54321" });
    expect(result).toEqual(claimedParsed);
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await claimOutboundMessage(env)).toEqual({ kind: "failed" });
  });

  it("treats a non-2xx response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await claimOutboundMessage(env)).toEqual({ kind: "failed" });
  });

  it.each([
    ["a non-array body", claimedRow],
    ["zero rows", []],
    ["more than one row", [claimedRow, claimedRow]],
    ["a row with an extra column", [{ ...claimedRow, extra: "x" }]],
    ["a row with an unknown result", [{ ...claimedRow, result: "invented" }]],
    ["a claimed row with a non-string outbox_id", [{ ...claimedRow, outbox_id: 1 }]],
    ["a claimed row with a malformed outbox_id", [{ ...claimedRow, outbox_id: "not-a-uuid" }]],
    ["a claimed row with a non-string claim_token", [{ ...claimedRow, claim_token: 1 }]],
    ["a claimed row with a malformed claim_token", [{ ...claimedRow, claim_token: "not-a-uuid" }]],
    ["a claimed row with an empty phone_number_id", [{ ...claimedRow, phone_number_id: "" }]],
    ["a claimed row with a non-numeric phone_number_id", [{ ...claimedRow, phone_number_id: "abc123" }]],
    ["a claimed row with an empty recipient_e164", [{ ...claimedRow, recipient_e164: "" }]],
    ["a claimed row with a recipient_e164 missing the leading +", [{ ...claimedRow, recipient_e164: "15550011111" }]],
    ["a claimed row with a recipient_e164 leading zero", [{ ...claimedRow, recipient_e164: "+05550011111" }]],
    ["a claimed row with empty content", [{ ...claimedRow, content: "" }]],
    ["a claimed row with oversized content", [{ ...claimedRow, content: "a".repeat(4097) }]],
    ["a claimed row with a zero attempt_count", [{ ...claimedRow, attempt_count: 0 }]],
    ["a claimed row with an attempt_count above three", [{ ...claimedRow, attempt_count: 4 }]],
    ["a claimed row with a non-integer attempt_count", [{ ...claimedRow, attempt_count: 1.5 }]],
    ["an exhausted row with a non-null outbox_id", [{ result: "exhausted", outbox_id: outboxId, claim_token: null, phone_number_id: null, recipient_e164: null, content: null, attempt_count: null }]],
    ["an empty row with a non-null content", [{ result: "empty", outbox_id: null, claim_token: null, phone_number_id: null, recipient_e164: null, content: "leaked", attempt_count: null }]],
  ])("treats %s as a malformed response and fails", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await claimOutboundMessage(env)).toEqual({ kind: "failed" });
  });

  it("rejects a non-plain row and hidden extra columns", async () => {
    const nonPlain = Object.assign(Object.create(null), claimedRow);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([nonPlain])));
    expect(await claimOutboundMessage(env)).toEqual({ kind: "failed" });

    const hiddenExtra = { ...claimedRow };
    Object.defineProperty(hiddenExtra, "extra", { value: "x" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([hiddenExtra])));
    expect(await claimOutboundMessage(env)).toEqual({ kind: "failed" });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([claimedRow])));

    await claimOutboundMessage(env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("releaseOutboundMessage", () => {
  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "retry_scheduled" }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await releaseOutboundMessage(outboxId, claimToken, env);

    expect(result).toEqual({ kind: "retry_scheduled" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/release_outbound_message");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(JSON.parse(init.body as string)).toEqual({ p_outbox_id: outboxId, p_claim_token: claimToken });
  });

  it.each(["retry_scheduled", "failed", "stale"] as const)("parses a %s result", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result }])));
    expect(await releaseOutboundMessage(outboxId, claimToken, env)).toEqual({ kind: result });
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await releaseOutboundMessage(outboxId, claimToken, { ...env, SUPABASE_URL: "" });
    expect(result).toEqual({ kind: "call_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await releaseOutboundMessage(outboxId, claimToken, { ...env, SUPABASE_URL: "http://example.supabase.co" });
    expect(result).toEqual({ kind: "call_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a network failure as call_failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await releaseOutboundMessage(outboxId, claimToken, env)).toEqual({ kind: "call_failed" });
  });

  it("treats a non-2xx response as call_failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await releaseOutboundMessage(outboxId, claimToken, env)).toEqual({ kind: "call_failed" });
  });

  it.each([
    ["a non-array body", { result: "stale" }],
    ["zero rows", []],
    ["more than one row", [{ result: "stale" }, { result: "stale" }]],
    ["a row with an extra column", [{ result: "stale", extra: "x" }]],
    ["a row with an unknown result", [{ result: "invented" }]],
  ])("treats %s as a malformed response and reports call_failed", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await releaseOutboundMessage(outboxId, claimToken, env)).toEqual({ kind: "call_failed" });
  });

  it("rejects a non-plain row and symbol extra columns", async () => {
    const nonPlain = Object.assign(Object.create(null), { result: "stale" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([nonPlain])));
    expect(await releaseOutboundMessage(outboxId, claimToken, env)).toEqual({ kind: "call_failed" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([{ result: "stale", [Symbol("extra")]: "x" }])));
    expect(await releaseOutboundMessage(outboxId, claimToken, env)).toEqual({ kind: "call_failed" });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "retry_scheduled" }])));

    await releaseOutboundMessage(outboxId, claimToken, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("acceptOutboundMessage", () => {
  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "accepted" }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await acceptOutboundMessage(outboxId, claimToken, providerMessageId, env);

    expect(result).toEqual({ kind: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/accept_outbound_message");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(JSON.parse(init.body as string)).toEqual({
      p_outbox_id: outboxId,
      p_claim_token: claimToken,
      p_provider_message_id: providerMessageId,
    });
  });

  it.each(["accepted", "already_accepted", "stale"] as const)("parses a %s result", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result }])));
    expect(await acceptOutboundMessage(outboxId, claimToken, providerMessageId, env)).toEqual({ kind: result });
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await acceptOutboundMessage(outboxId, claimToken, providerMessageId, { ...env, SUPABASE_URL: "" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await acceptOutboundMessage(outboxId, claimToken, providerMessageId, { ...env, SUPABASE_URL: "http://example.supabase.co" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows plain HTTP for loopback localhost testing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "accepted" }])));
    const result = await acceptOutboundMessage(outboxId, claimToken, providerMessageId, { ...env, SUPABASE_URL: "http://localhost:54321" });
    expect(result).toEqual({ kind: "accepted" });
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await acceptOutboundMessage(outboxId, claimToken, providerMessageId, env)).toEqual({ kind: "failed" });
  });

  it("treats a non-2xx response as failed (including a raised different-provider-id or history-collision exception)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await acceptOutboundMessage(outboxId, claimToken, providerMessageId, env)).toEqual({ kind: "failed" });
  });

  it.each([
    ["a non-array body", { result: "accepted" }],
    ["zero rows", []],
    ["more than one row", [{ result: "accepted" }, { result: "accepted" }]],
    ["a row with an extra column", [{ result: "accepted", extra: "x" }]],
    ["a row with an unknown result", [{ result: "invented" }]],
  ])("treats %s as a malformed response and fails", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await acceptOutboundMessage(outboxId, claimToken, providerMessageId, env)).toEqual({ kind: "failed" });
  });

  it("rejects a non-plain row and symbol extra columns", async () => {
    const nonPlain = Object.assign(Object.create(null), { result: "accepted" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([nonPlain])));
    expect(await acceptOutboundMessage(outboxId, claimToken, providerMessageId, env)).toEqual({ kind: "failed" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([{ result: "accepted", [Symbol("extra")]: "x" }])));
    expect(await acceptOutboundMessage(outboxId, claimToken, providerMessageId, env)).toEqual({ kind: "failed" });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "accepted" }])));

    await acceptOutboundMessage(outboxId, claimToken, providerMessageId, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
