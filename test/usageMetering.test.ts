import { afterEach, describe, expect, it, vi } from "vitest";
import { recordIntakeAiUsageV1, getClinicMonthlyUsageV1 } from "../src/usageMetering";
import type { RecordIntakeAiUsageInput, ClinicMonthlyUsageInput } from "../src/usageMetering";
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
  WHATSAPP_ACCOUNT_CREDENTIALS_JSON: JSON.stringify([
    { whatsapp_account_id: "33333333-3333-3333-3333-333333333333", phone_number_id: "918000001", access_token: "test-access-token" },
  ]),
  WHATSAPP_GRAPH_API_VERSION: "v25.0",
};

const conversationId = "11111111-1111-1111-1111-111111111111";
const claimToken = "22222222-2222-2222-2222-222222222222";
const clinicId = "44444444-4444-4444-4444-444444444444";

const recordInput: RecordIntakeAiUsageInput = {
  conversationId,
  providerMessageId: "wamid.HBgLNTU1MDAwMTIzNDUVAgARGBI5QTNDQjkwRTVBOEI5RUUzQwA=",
  claimToken,
  model: "gpt-5.6-luna",
  promptVersion: "2026-08-28.2",
  usage: { inputTokens: 456, outputTokens: 78, totalTokens: 534 },
};

const monthlyUsageInput: ClinicMonthlyUsageInput = {
  clinicId,
  monthStart: "2026-08-01",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function rawJsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

function monthlyUsageRow(overrides: Record<string, unknown> = {}) {
  return {
    result: "reported",
    clinic_id: clinicId,
    period_start: "2026-08-01",
    period_end: "2026-09-01",
    ai_turn_count: 42,
    ai_touched_conversation_count: 10,
    input_tokens: 1000,
    output_tokens: 500,
    total_tokens: 1500,
    missing_token_usage_count: 2,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recordIntakeAiUsageV1", () => {
  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "recorded" }]));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", fetchMock);

    const result = await recordIntakeAiUsageV1(recordInput, env);

    expect(result).toEqual({ kind: "recorded" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/record_intake_ai_usage_v1");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      p_conversation_id: recordInput.conversationId,
      p_provider_message_id: recordInput.providerMessageId,
      p_claim_token: recordInput.claimToken,
      p_model: recordInput.model,
      p_prompt_version: recordInput.promptVersion,
      p_input_tokens: 456,
      p_output_tokens: 78,
      p_total_tokens: 534,
    });
    timeoutSpy.mockRestore();
  });

  it("sends a null token triplet when usage is null", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "recorded" }]));
    vi.stubGlobal("fetch", fetchMock);

    await recordIntakeAiUsageV1({ ...recordInput, usage: null }, env);

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.p_input_tokens).toBeNull();
    expect(body.p_output_tokens).toBeNull();
    expect(body.p_total_tokens).toBeNull();
  });

  it.each(["recorded", "duplicate", "stale_claim", "not_found"] as const)("parses a %s result", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result }])));
    expect(await recordIntakeAiUsageV1(recordInput, env)).toEqual({ kind: result });
  });

  it.each([
    ["conversationId", "not-a-uuid"],
    ["conversationId", "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"],
    ["providerMessageId", ""],
    ["providerMessageId", " wamid.leading-space"],
    ["providerMessageId", "x".repeat(513)],
    ["providerMessageId", "wamid.withcontrol"],
    ["claimToken", "not-a-uuid"],
    ["model", ""],
    ["model", " gpt-5.6-luna"],
    ["model", "x".repeat(121)],
    ["model", "gptluna"],
    ["promptVersion", ""],
    ["promptVersion", " 2026-08-28.2"],
    ["promptVersion", "x".repeat(121)],
    ["promptVersion", "202608-28.2"],
  ])("rejects an invalid %s before fetch", async (key, value) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const input = { ...recordInput, [key]: value } as RecordIntakeAiUsageInput;
    expect(await recordIntakeAiUsageV1(input, env)).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-object usage", "not-an-object"],
    ["an array usage", [1, 2, 3]],
    ["usage missing a field", { inputTokens: 1, outputTokens: 2 }],
    ["usage with a negative token count", { inputTokens: -1, outputTokens: 2, totalTokens: 3 }],
    ["usage with a non-integer token count", { inputTokens: 1.5, outputTokens: 2, totalTokens: 3 }],
    ["usage with an unsafe integer token count", { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 2, totalTokens: 3 }],
    ["usage with a string token count", { inputTokens: "1", outputTokens: 2, totalTokens: 3 }],
  ])("rejects %s before fetch", async (_label, usage) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const input = { ...recordInput, usage } as unknown as RecordIntakeAiUsageInput;
    expect(await recordIntakeAiUsageV1(input, env)).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects extra top-level and nested-usage input keys before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const extraTopLevel = {
      ...recordInput,
      extra: "unexpected",
    } as RecordIntakeAiUsageInput;
    const extraUsageKey = {
      ...recordInput,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, extra: 4 },
    } as RecordIntakeAiUsageInput;
    expect(await recordIntakeAiUsageV1(extraTopLevel, env)).toEqual({ kind: "failed" });
    expect(await recordIntakeAiUsageV1(extraUsageKey, env)).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a hostile input object with a throwing field getter, before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const throwingGetter = { ...recordInput };
    Object.defineProperty(throwingGetter, "model", {
      enumerable: true,
      get() {
        throw new Error("do not read me");
      },
    });
    expect(await recordIntakeAiUsageV1(throwingGetter, env)).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects null and non-object inputs without throwing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await recordIntakeAiUsageV1(null as unknown as RecordIntakeAiUsageInput, env)).toEqual({ kind: "failed" });
    expect(await recordIntakeAiUsageV1("nope" as unknown as RecordIntakeAiUsageInput, env)).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("snapshots getter-backed fields exactly once before validating and sending", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "recorded" }]));
    vi.stubGlobal("fetch", fetchMock);
    let reads = 0;
    const getterInput = { ...recordInput };
    Object.defineProperty(getterInput, "model", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "gpt-5.6-luna" : "gpt-changed";
      },
    });

    expect(await recordIntakeAiUsageV1(getterInput, env)).toEqual({ kind: "recorded" });
    expect(reads).toBe(1);
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string).p_model).toBe("gpt-5.6-luna");
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await recordIntakeAiUsageV1(recordInput, { ...env, SUPABASE_URL: "" })).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase configuration contains only whitespace", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await recordIntakeAiUsageV1(recordInput, { ...env, SUPABASE_SERVICE_ROLE_KEY: "   " })).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when a Supabase binding has the wrong runtime type", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const invalidEnv = { ...env, SUPABASE_URL: null } as unknown as Env;
    expect(await recordIntakeAiUsageV1(recordInput, invalidEnv)).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await recordIntakeAiUsageV1(recordInput, { ...env, SUPABASE_URL: "http://example.supabase.co" })).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows plain HTTP for loopback localhost testing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "recorded" }])));
    const result = await recordIntakeAiUsageV1(recordInput, { ...env, SUPABASE_URL: "http://localhost:54321" });
    expect(result).toEqual({ kind: "recorded" });
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await recordIntakeAiUsageV1(recordInput, env)).toEqual({ kind: "failed" });
  });

  it("treats a non-2xx response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await recordIntakeAiUsageV1(recordInput, env)).toEqual({ kind: "failed" });
  });

  it.each([
    ["a non-array body", { result: "recorded" }],
    ["zero rows", []],
    ["more than one row", [{ result: "recorded" }, { result: "recorded" }]],
    ["a row with an extra column", [{ result: "recorded", extra: "x" }]],
    ["a row with an unrecognized result", [{ result: "invented" }]],
  ])("treats %s as a malformed response and reports failed", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await recordIntakeAiUsageV1(recordInput, env)).toEqual({ kind: "failed" });
  });

  it("rejects a non-plain row, a row with a symbol key, and a row with a throwing field getter", async () => {
    const nonPlain = Object.assign(Object.create(null) as Record<string, unknown>, { result: "recorded" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([nonPlain])));
    expect(await recordIntakeAiUsageV1(recordInput, env)).toEqual({ kind: "failed" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([{ result: "recorded", [Symbol("extra")]: "x" }])));
    expect(await recordIntakeAiUsageV1(recordInput, env)).toEqual({ kind: "failed" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        rawJsonResponse([
          Object.defineProperty({}, "result", {
            enumerable: true,
            get() {
              throw new Error("do not read me");
            },
          }),
        ]),
      ),
    );
    expect(await recordIntakeAiUsageV1(recordInput, env)).toEqual({ kind: "failed" });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "recorded" }])));

    await recordIntakeAiUsageV1(recordInput, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("getClinicMonthlyUsageV1", () => {
  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([monthlyUsageRow()]));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", fetchMock);

    const result = await getClinicMonthlyUsageV1(monthlyUsageInput, env);

    expect(result).toEqual({
      kind: "reported",
      clinicId,
      periodStart: "2026-08-01",
      periodEnd: "2026-09-01",
      aiTurnCount: 42,
      aiTouchedConversationCount: 10,
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      missingTokenUsageCount: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/get_clinic_monthly_usage_v1");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ p_clinic_id: clinicId, p_month_start: "2026-08-01" });
    timeoutSpy.mockRestore();
  });

  it("maps a clinic_not_found result the same way as a reported one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([monthlyUsageRow({ result: "clinic_not_found", ai_turn_count: 0, ai_touched_conversation_count: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, missing_token_usage_count: 0 })])));
    const result = await getClinicMonthlyUsageV1(monthlyUsageInput, env);
    expect(result).toEqual({
      kind: "clinic_not_found",
      clinicId,
      periodStart: "2026-08-01",
      periodEnd: "2026-09-01",
      aiTurnCount: 0,
      aiTouchedConversationCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      missingTokenUsageCount: 0,
    });
  });

  it.each([
    ["clinicId", "not-a-uuid"],
    ["clinicId", "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"],
    ["monthStart", "2026-08-02"],
    ["monthStart", "2026-8-01"],
    ["monthStart", "08-2026-01"],
    ["monthStart", "2026-13-01"],
    ["monthStart", "0000-01-01"],
    ["monthStart", "not-a-date"],
  ])("rejects an invalid %s before fetch", async (key, value) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const input = { ...monthlyUsageInput, [key]: value } as ClinicMonthlyUsageInput;
    expect(await getClinicMonthlyUsageV1(input, env)).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects extra input keys and hostile input objects before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await getClinicMonthlyUsageV1({ ...monthlyUsageInput, extra: true } as ClinicMonthlyUsageInput, env)).toEqual({
      kind: "failed",
    });

    const hostile = new Proxy(monthlyUsageInput, {
      ownKeys() {
        throw new Error("do not inspect me");
      },
    });
    expect(await getClinicMonthlyUsageV1(hostile, env)).toEqual({ kind: "failed" });

    const throwingGetter = { ...monthlyUsageInput };
    Object.defineProperty(throwingGetter, "clinicId", {
      enumerable: true,
      get() {
        throw new Error("do not read me");
      },
    });
    expect(await getClinicMonthlyUsageV1(throwingGetter, env)).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-plain input object (e.g. Object.create(null))", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const nonPlain = Object.assign(Object.create(null) as Record<string, unknown>, monthlyUsageInput);
    expect(await getClinicMonthlyUsageV1(nonPlain as ClinicMonthlyUsageInput, env)).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects null and non-object inputs without throwing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await getClinicMonthlyUsageV1(null as unknown as ClinicMonthlyUsageInput, env)).toEqual({ kind: "failed" });
    expect(await getClinicMonthlyUsageV1(42 as unknown as ClinicMonthlyUsageInput, env)).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("snapshots getter-backed monthly fields exactly once", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([monthlyUsageRow()]));
    vi.stubGlobal("fetch", fetchMock);
    let reads = 0;
    const getterInput = { ...monthlyUsageInput };
    Object.defineProperty(getterInput, "monthStart", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "2026-08-01" : "2026-09-01";
      },
    });

    expect((await getClinicMonthlyUsageV1(getterInput, env)).kind).toBe("reported");
    expect(reads).toBe(1);
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string).p_month_start).toBe("2026-08-01");
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await getClinicMonthlyUsageV1(monthlyUsageInput, { ...env, SUPABASE_URL: "" })).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await getClinicMonthlyUsageV1(monthlyUsageInput, { ...env, SUPABASE_URL: "http://example.supabase.co" })).toEqual({
      kind: "failed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows plain HTTP for loopback localhost testing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([monthlyUsageRow()])));
    const result = await getClinicMonthlyUsageV1(monthlyUsageInput, { ...env, SUPABASE_URL: "http://localhost:54321" });
    expect(result.kind).toBe("reported");
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await getClinicMonthlyUsageV1(monthlyUsageInput, env)).toEqual({ kind: "failed" });
  });

  it("treats a non-2xx response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await getClinicMonthlyUsageV1(monthlyUsageInput, env)).toEqual({ kind: "failed" });
  });

  it.each([
    ["a non-array body", monthlyUsageRow()],
    ["zero rows", []],
    ["more than one row", [monthlyUsageRow(), monthlyUsageRow()]],
    ["a row with an extra column", [{ ...monthlyUsageRow(), extra: "x" }]],
    ["a row missing a column", (() => { const r = monthlyUsageRow() as Record<string, unknown>; delete r.missing_token_usage_count; return r; })()],
    ["a row with an unrecognized result", [monthlyUsageRow({ result: "invented" })]],
    ["a row with a non-uuid clinic_id", [monthlyUsageRow({ clinic_id: "not-a-uuid" })]],
    ["a row with a non-string period_start", [monthlyUsageRow({ period_start: 1 })]],
    ["a row with a non-number ai_turn_count", [monthlyUsageRow({ ai_turn_count: "42" })]],
    ["a row with a non-number missing_token_usage_count", [monthlyUsageRow({ missing_token_usage_count: null })]],
    ["a row for a different clinic", [monthlyUsageRow({ clinic_id: "55555555-5555-5555-5555-555555555555" })]],
    ["a row for a different period", [monthlyUsageRow({ period_start: "2026-07-01" })]],
    ["a row with a negative count", [monthlyUsageRow({ ai_turn_count: -1 })]],
    ["a row with a fractional count", [monthlyUsageRow({ ai_turn_count: 1.5 })]],
    ["a row with more conversations than turns", [monthlyUsageRow({ ai_turn_count: 1, ai_touched_conversation_count: 2 })]],
    ["a clinic_not_found row with nonzero aggregates", [monthlyUsageRow({ result: "clinic_not_found" })]],
  ])("treats %s as a malformed response and reports failed", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await getClinicMonthlyUsageV1(monthlyUsageInput, env)).toEqual({ kind: "failed" });
  });

  it("rejects a non-plain row and a row with a symbol key", async () => {
    const nonPlain = Object.assign(Object.create(null), monthlyUsageRow());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([nonPlain])));
    expect(await getClinicMonthlyUsageV1(monthlyUsageInput, env)).toEqual({ kind: "failed" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([{ ...monthlyUsageRow(), [Symbol("extra")]: "x" }])));
    expect(await getClinicMonthlyUsageV1(monthlyUsageInput, env)).toEqual({ kind: "failed" });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([monthlyUsageRow()])));

    await getClinicMonthlyUsageV1(monthlyUsageInput, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
