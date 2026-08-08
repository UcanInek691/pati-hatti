import { afterEach, describe, expect, it, vi } from "vitest";
import { claimIntakeQueueJob, completeIntakeQueueJob } from "../src/intakeJobLease";
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
};

const conversationId = "11111111-1111-1111-1111-111111111111";
const providerMessageId = "wamid.ID1";
const claimToken = "22222222-2222-2222-2222-222222222222";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function rawJsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("claimIntakeQueueJob", () => {
  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "claimed", claim_token: claimToken, message_text: "Hello" }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await claimIntakeQueueJob(conversationId, providerMessageId, env);

    expect(result).toEqual({ kind: "claimed", claimToken, messageText: "Hello" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/claim_intake_queue_job");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ p_conversation_id: conversationId, p_provider_message_id: providerMessageId });
  });

  it.each(["completed", "busy", "not_found"] as const)("parses a %s result with a null token and text", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result, claim_token: null, message_text: null }])));
    expect(await claimIntakeQueueJob(conversationId, providerMessageId, env)).toEqual({ kind: result });
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await claimIntakeQueueJob(conversationId, providerMessageId, { ...env, SUPABASE_URL: "" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase configuration contains only whitespace", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await claimIntakeQueueJob(conversationId, providerMessageId, { ...env, SUPABASE_SERVICE_ROLE_KEY: "   " });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await claimIntakeQueueJob(conversationId, providerMessageId, { ...env, SUPABASE_URL: "http://example.supabase.co" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows plain HTTP for loopback localhost testing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "claimed", claim_token: claimToken, message_text: "Hello" }])));
    const result = await claimIntakeQueueJob(conversationId, providerMessageId, { ...env, SUPABASE_URL: "http://localhost:54321" });
    expect(result).toEqual({ kind: "claimed", claimToken, messageText: "Hello" });
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await claimIntakeQueueJob(conversationId, providerMessageId, env)).toEqual({ kind: "failed" });
  });

  it("treats a non-2xx response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await claimIntakeQueueJob(conversationId, providerMessageId, env)).toEqual({ kind: "failed" });
  });

  it.each([
    ["a non-array body", { result: "claimed", claim_token: claimToken, message_text: "Hello" }],
    ["zero rows", []],
    ["more than one row", [{ result: "not_found", claim_token: null, message_text: null }, { result: "not_found", claim_token: null, message_text: null }]],
    ["a row with an extra column", [{ result: "not_found", claim_token: null, message_text: null, extra: "x" }]],
    ["a row with an unknown result", [{ result: "invented", claim_token: null, message_text: null }]],
    ["a claimed row with a non-string token", [{ result: "claimed", claim_token: 1, message_text: "Hello" }]],
    ["a claimed row with a malformed token", [{ result: "claimed", claim_token: "not-a-uuid", message_text: "Hello" }]],
    ["a claimed row with a non-string text", [{ result: "claimed", claim_token: claimToken, message_text: 1 }]],
    ["a claimed row with empty text", [{ result: "claimed", claim_token: claimToken, message_text: "" }]],
    ["a claimed row with oversized text", [{ result: "claimed", claim_token: claimToken, message_text: "a".repeat(65537) }]],
    ["a busy row with a non-null token", [{ result: "busy", claim_token: claimToken, message_text: null }]],
    ["a not_found row with non-null text", [{ result: "not_found", claim_token: null, message_text: "leaked" }]],
  ])("treats %s as a malformed response and fails", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await claimIntakeQueueJob(conversationId, providerMessageId, env)).toEqual({ kind: "failed" });
  });

  it("rejects a non-plain row and hidden extra columns", async () => {
    const nonPlain = Object.assign(Object.create(null), { result: "not_found", claim_token: null, message_text: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([nonPlain])));
    expect(await claimIntakeQueueJob(conversationId, providerMessageId, env)).toEqual({ kind: "failed" });

    const hiddenExtra = { result: "not_found", claim_token: null, message_text: null };
    Object.defineProperty(hiddenExtra, "extra", { value: "x" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([hiddenExtra])));
    expect(await claimIntakeQueueJob(conversationId, providerMessageId, env)).toEqual({ kind: "failed" });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "claimed", claim_token: claimToken, message_text: "Sensitive text" }])));

    await claimIntakeQueueJob(conversationId, providerMessageId, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("completeIntakeQueueJob", () => {
  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "completed" }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await completeIntakeQueueJob(conversationId, providerMessageId, claimToken, env);

    expect(result).toEqual({ kind: "completed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/complete_intake_queue_job");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(JSON.parse(init.body as string)).toEqual({
      p_conversation_id: conversationId,
      p_provider_message_id: providerMessageId,
      p_claim_token: claimToken,
    });
  });

  it("parses a stale result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "stale" }])));
    expect(await completeIntakeQueueJob(conversationId, providerMessageId, claimToken, env)).toEqual({ kind: "stale" });
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await completeIntakeQueueJob(conversationId, providerMessageId, claimToken, { ...env, SUPABASE_URL: "" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await completeIntakeQueueJob(conversationId, providerMessageId, claimToken, { ...env, SUPABASE_URL: "http://example.supabase.co" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await completeIntakeQueueJob(conversationId, providerMessageId, claimToken, env)).toEqual({ kind: "failed" });
  });

  it("treats a non-2xx response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await completeIntakeQueueJob(conversationId, providerMessageId, claimToken, env)).toEqual({ kind: "failed" });
  });

  it.each([
    ["a non-array body", { result: "completed" }],
    ["zero rows", []],
    ["more than one row", [{ result: "completed" }, { result: "completed" }]],
    ["a row with an extra column", [{ result: "completed", extra: "x" }]],
    ["a row with an unknown result", [{ result: "invented" }]],
  ])("treats %s as a malformed response and fails", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await completeIntakeQueueJob(conversationId, providerMessageId, claimToken, env)).toEqual({ kind: "failed" });
  });

  it("rejects a non-plain row and symbol extra columns", async () => {
    const nonPlain = Object.assign(Object.create(null), { result: "completed" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([nonPlain])));
    expect(await completeIntakeQueueJob(conversationId, providerMessageId, claimToken, env)).toEqual({ kind: "failed" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([{ result: "completed", [Symbol("extra")]: "x" }])));
    expect(await completeIntakeQueueJob(conversationId, providerMessageId, claimToken, env)).toEqual({ kind: "failed" });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "completed" }])));

    await completeIntakeQueueJob(conversationId, providerMessageId, claimToken, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
