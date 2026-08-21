import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeIntakeDeadLetter, processIntakeDeadLetterQueueMessage } from "../src/intakeDeadLetter";
import type { Env } from "../src/env";
import type { IntakeQueueMessage } from "../src/intakeQueue";

const CONVERSATION_ID = "11111111-1111-1111-1111-111111111111";
const PROVIDER_MESSAGE_ID = "wamid.DLQ1";

const env: Env = {
  APP_TIMEZONE: "Europe/Istanbul",
  WHATSAPP_VERIFY_TOKEN: "secret-token",
  WHATSAPP_APP_SECRET: "test-app-secret",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  SUPABASE_ANON_KEY: "test-anon-key",
  OPENAI_API_KEY: "test-openai-key",
  INTAKE_QUEUE: { send: async () => {} } as unknown as Queue<IntakeQueueMessage>,
  WHATSAPP_ACCESS_TOKEN: "test-whatsapp-access-token",
  WHATSAPP_GRAPH_API_VERSION: "v25.0",
};

const validBody = { version: 1, conversationId: CONVERSATION_ID, providerMessageId: PROVIDER_MESSAGE_ID };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function resultRow(result: string): Response {
  return jsonResponse([{ result }]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("finalizeIntakeDeadLetter: request shape", () => {
  it("sends the exact RPC path and body, and nothing else", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resultRow("handed_off"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await finalizeIntakeDeadLetter(CONVERSATION_ID, PROVIDER_MESSAGE_ID, env);

    expect(result).toEqual({ kind: "handed_off" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/finalize_intake_dead_letter");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({
      p_conversation_id: CONVERSATION_ID,
      p_provider_message_id: PROVIDER_MESSAGE_ID,
    });
  });

  it.each([
    { label: "missing SUPABASE_URL", envOverride: { SUPABASE_URL: "" } },
    { label: "blank SUPABASE_URL", envOverride: { SUPABASE_URL: "   " } },
    { label: "missing service role key", envOverride: { SUPABASE_SERVICE_ROLE_KEY: "" } },
    { label: "non-https, non-loopback URL", envOverride: { SUPABASE_URL: "http://example.supabase.co" } },
  ])("$label -> failed with zero network calls", async ({ envOverride }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await finalizeIntakeDeadLetter(CONVERSATION_ID, PROVIDER_MESSAGE_ID, { ...env, ...envOverride });

    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { conversationId: "not-a-uuid", providerMessageId: PROVIDER_MESSAGE_ID },
    { conversationId: CONVERSATION_ID, providerMessageId: "" },
    { conversationId: CONVERSATION_ID, providerMessageId: " padded " },
    { conversationId: CONVERSATION_ID, providerMessageId: "😀".repeat(513) },
  ])("rejects invalid identifiers before fetch", async ({ conversationId, providerMessageId }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await finalizeIntakeDeadLetter(conversationId, providerMessageId, env)).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a loopback http URL", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resultRow("not_found"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await finalizeIntakeDeadLetter(CONVERSATION_ID, PROVIDER_MESSAGE_ID, { ...env, SUPABASE_URL: "http://127.0.0.1:54321" });

    expect(result).toEqual({ kind: "not_found" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("finalizeIntakeDeadLetter: response handling", () => {
  it.each(["handed_off", "already_completed", "already_terminal", "not_found"] as const)(
    "accepts the closed result %s",
    async (value) => {
      const fetchMock = vi.fn().mockResolvedValueOnce(resultRow(value));
      vi.stubGlobal("fetch", fetchMock);

      const result = await finalizeIntakeDeadLetter(CONVERSATION_ID, PROVIDER_MESSAGE_ID, env);

      expect(result).toEqual({ kind: value });
    },
  );

  it.each([
    { label: "network error", setup: () => vi.fn().mockRejectedValueOnce(new Error("network down")) },
    { label: "non-2xx status", setup: () => vi.fn().mockResolvedValueOnce(new Response("", { status: 500 })) },
    { label: "invalid JSON body", setup: () => vi.fn().mockResolvedValueOnce(new Response("not json", { status: 200 })) },
    { label: "non-array payload", setup: () => vi.fn().mockResolvedValueOnce(jsonResponse({ result: "handed_off" })) },
    { label: "zero rows", setup: () => vi.fn().mockResolvedValueOnce(jsonResponse([])) },
    { label: "two rows", setup: () => vi.fn().mockResolvedValueOnce(jsonResponse([{ result: "handed_off" }, { result: "handed_off" }])) },
    { label: "row is an array, not a plain object", setup: () => vi.fn().mockResolvedValueOnce(jsonResponse([["handed_off"]])) },
    { label: "row missing result key", setup: () => vi.fn().mockResolvedValueOnce(jsonResponse([{}])) },
    { label: "row with an extra key", setup: () => vi.fn().mockResolvedValueOnce(jsonResponse([{ result: "handed_off", extra: true }])) },
    { label: "unknown result value", setup: () => vi.fn().mockResolvedValueOnce(resultRow("something_else")) },
    { label: "null result value", setup: () => vi.fn().mockResolvedValueOnce(jsonResponse([{ result: null }])) },
  ])("$label -> failed", async ({ setup }) => {
    vi.stubGlobal("fetch", setup());

    const result = await finalizeIntakeDeadLetter(CONVERSATION_ID, PROVIDER_MESSAGE_ID, env);

    expect(result).toEqual({ kind: "failed" });
  });

  it("never logs on any outcome, including failures", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("network down: https://leaked.example/secret")));

    await finalizeIntakeDeadLetter(CONVERSATION_ID, PROVIDER_MESSAGE_ID, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns a fresh failure object each time", async () => {
    const first = await finalizeIntakeDeadLetter("not-a-uuid", PROVIDER_MESSAGE_ID, env);
    const second = await finalizeIntakeDeadLetter("not-a-uuid", PROVIDER_MESSAGE_ID, env);

    expect(first).toEqual({ kind: "failed" });
    expect(first).not.toBe(second);
  });
});

describe("processIntakeDeadLetterQueueMessage: parse", () => {
  it.each([
    { label: "not an object", body: "nope" },
    { label: "null", body: null },
    { label: "array", body: [1, 2, 3] },
    { label: "missing providerMessageId", body: { version: 1, conversationId: CONVERSATION_ID } },
    { label: "extra key", body: { ...validBody, extra: "x" } },
    { label: "wrong version", body: { ...validBody, version: 2 } },
    { label: "malformed conversationId", body: { ...validBody, conversationId: "not-a-uuid" } },
    { label: "empty providerMessageId", body: { ...validBody, providerMessageId: "" } },
    { label: "unpadded providerMessageId", body: { ...validBody, providerMessageId: "  x  " } },
    { label: "overlength providerMessageId", body: { ...validBody, providerMessageId: "a".repeat(513) } },
  ])("$label -> retry with zero network calls (opposite of the primary consumer)", async ({ body }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeDeadLetterQueueMessage(body, env);

    expect(result).toBe("retry");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a Proxy whose property access throws -> retry", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const trapped = new Proxy(
      { version: 1, conversationId: CONVERSATION_ID, providerMessageId: PROVIDER_MESSAGE_ID },
      {
        get() {
          throw new Error("trap");
        },
      },
    );

    const result = await processIntakeDeadLetterQueueMessage(trapped, env);

    expect(result).toBe("retry");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not mutate a frozen valid body", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resultRow("handed_off"));
    vi.stubGlobal("fetch", fetchMock);
    const frozen = Object.freeze({ ...validBody });

    const result = await processIntakeDeadLetterQueueMessage(frozen, env);

    expect(result).toBe("ack");
    expect(frozen).toEqual(validBody);
  });
});

describe("processIntakeDeadLetterQueueMessage: disposition", () => {
  it.each(["handed_off", "already_completed", "already_terminal", "not_found"] as const)(
    "finalize %s -> ack",
    async (value) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(resultRow(value)));

      const result = await processIntakeDeadLetterQueueMessage(validBody, env);

      expect(result).toBe("ack");
    },
  );

  it.each([
    { label: "network error", setup: () => vi.fn().mockRejectedValueOnce(new Error("network down")) },
    { label: "non-2xx status", setup: () => vi.fn().mockResolvedValueOnce(new Response("", { status: 500 })) },
    { label: "invalid JSON body", setup: () => vi.fn().mockResolvedValueOnce(new Response("not json", { status: 200 })) },
    { label: "malformed shape", setup: () => vi.fn().mockResolvedValueOnce(jsonResponse([{}])) },
    { label: "unknown result", setup: () => vi.fn().mockResolvedValueOnce(resultRow("something_else")) },
  ])("finalize failure ($label) -> retry", async ({ setup }) => {
    vi.stubGlobal("fetch", setup());

    const result = await processIntakeDeadLetterQueueMessage(validBody, env);

    expect(result).toBe("retry");
  });

  it("batch siblings are handled independently", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resultRow("handed_off"))
      .mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const first = await processIntakeDeadLetterQueueMessage(validBody, env);
    const second = await processIntakeDeadLetterQueueMessage(
      { version: 1, conversationId: CONVERSATION_ID, providerMessageId: "wamid.DLQ2" },
      env,
    );

    expect(first).toBe("ack");
    expect(second).toBe("retry");
  });

  it("never logs, including on malformed input and network failure", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("network down: https://leaked.example/secret")));

    await processIntakeDeadLetterQueueMessage({ bogus: true, providerMessageId: PROVIDER_MESSAGE_ID }, env);
    await processIntakeDeadLetterQueueMessage(validBody, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
