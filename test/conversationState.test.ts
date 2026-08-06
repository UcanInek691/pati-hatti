import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceConversationIntake, getConversationIntakeContext } from "../src/conversationState";
import type { AdvanceConversationIntakeInput } from "../src/conversationState";
import type { Env } from "../src/env";

const env: Env = {
  APP_TIMEZONE: "Europe/Istanbul",
  WHATSAPP_VERIFY_TOKEN: "secret-token",
  WHATSAPP_APP_SECRET: "test-app-secret",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  OPENAI_API_KEY: "unused",
};

const conversationId = "11111111-1111-1111-1111-111111111111";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function contextRow(overrides: Record<string, unknown> = {}) {
  return {
    conversation_id: conversationId,
    clinic_id: "22222222-2222-2222-2222-222222222222",
    owner_id: "33333333-3333-3333-3333-333333333333",
    pet_id: null,
    status: "active",
    intake_stage: "pet_identification",
    intake_data: {},
    state_version: 1,
    owner_name: "Kerry Fisher",
    pets: [],
    recent_messages: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getConversationIntakeContext", () => {
  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([contextRow()]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getConversationIntakeContext(conversationId, env);

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/get_conversation_intake_context");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ p_conversation_id: conversationId });
  });

  it("parses a row with no assigned pet", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([contextRow()])));
    const result = await getConversationIntakeContext(conversationId, env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.petId).toBeNull();
    expect(result.context.pets).toEqual([]);
  });

  it("parses a row with an assigned pet and a pet list", async () => {
    const row = contextRow({
      pet_id: "44444444-4444-4444-4444-444444444444",
      pets: [
        { id: "44444444-4444-4444-4444-444444444444", name: "Waffles", species: "dog" },
        { id: "55555555-5555-5555-5555-555555555555", name: "Mochi", species: null },
      ],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([row])));

    const result = await getConversationIntakeContext(conversationId, env);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.petId).toBe("44444444-4444-4444-4444-444444444444");
    expect(result.context.pets).toEqual([
      { id: "44444444-4444-4444-4444-444444444444", name: "Waffles", species: "dog" },
      { id: "55555555-5555-5555-5555-555555555555", name: "Mochi", species: null },
    ]);
  });

  it("parses chronological recent messages", async () => {
    const row = contextRow({
      recent_messages: [
        { direction: "inbound", content: "My dog is limping", created_at: "2026-08-06T10:00:00.000Z" },
        { direction: "outbound", content: "Since when?", created_at: "2026-08-06T10:01:00.000Z" },
      ],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([row])));

    const result = await getConversationIntakeContext(conversationId, env);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.recentMessages).toEqual([
      { direction: "inbound", content: "My dog is limping", createdAt: "2026-08-06T10:00:00.000Z" },
      { direction: "outbound", content: "Since when?", createdAt: "2026-08-06T10:01:00.000Z" },
    ]);
  });

  it("treats a zero-row response as not_found", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));
    const result = await getConversationIntakeContext(conversationId, env);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await getConversationIntakeContext(conversationId, { ...env, SUPABASE_URL: "" });
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase configuration contains only whitespace", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await getConversationIntakeContext(conversationId, { ...env, SUPABASE_SERVICE_ROLE_KEY: "   " });
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await getConversationIntakeContext(conversationId, { ...env, SUPABASE_URL: "http://example.supabase.co" });
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows plain HTTP for loopback localhost testing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([contextRow()]));
    vi.stubGlobal("fetch", fetchMock);
    const result = await getConversationIntakeContext(conversationId, { ...env, SUPABASE_URL: "http://localhost:54321" });
    expect(result.ok).toBe(true);
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const result = await getConversationIntakeContext(conversationId, env);
    expect(result).toEqual({ ok: false, reason: "failed" });
  });

  it("treats a non-2xx response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    const result = await getConversationIntakeContext(conversationId, env);
    expect(result).toEqual({ ok: false, reason: "failed" });
  });

  it.each([
    ["a non-array body", { conversation_id: conversationId }],
    ["more than one row", [contextRow(), contextRow()]],
    ["a row missing required fields", [{ conversation_id: conversationId }]],
    ["a row with a malformed pet", [contextRow({ pets: [{ id: "x" }] })]],
    ["a row with a malformed message", [contextRow({ recent_messages: [{ direction: "inbound" }] })]],
    ["a row with an invalid stage", [contextRow({ intake_stage: "invented" })]],
    ["a row with an invalid status", [contextRow({ status: "invented" })]],
    ["a row with a nonpositive version", [contextRow({ state_version: 0 })]],
  ])("treats %s as a malformed response and fails", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    const result = await getConversationIntakeContext(conversationId, env);
    expect(result).toEqual({ ok: false, reason: "failed" });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([contextRow({ owner_name: "Sensitive Owner Name" })])));

    await getConversationIntakeContext(conversationId, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("advanceConversationIntake", () => {
  const advanceInput: AdvanceConversationIntakeInput = {
    conversationId,
    expectedVersion: 1,
    nextStage: "complaint_collection",
    petId: null,
    intakeData: { complaint: "limping" },
  };

  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ intake_stage: "complaint_collection", state_version: 2 }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await advanceConversationIntake(advanceInput, env);

    expect(result).toEqual({ ok: true, intakeStage: "complaint_collection", stateVersion: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/advance_conversation_intake");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(JSON.parse(init.body as string)).toEqual({
      p_conversation_id: advanceInput.conversationId,
      p_expected_version: advanceInput.expectedVersion,
      p_next_stage: advanceInput.nextStage,
      p_pet_id: advanceInput.petId,
      p_intake_data: advanceInput.intakeData,
    });
  });

  it("treats a zero-row response as stale", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));
    const result = await advanceConversationIntake(advanceInput, env);
    expect(result).toEqual({ ok: false, reason: "stale" });
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await advanceConversationIntake(advanceInput, { ...env, SUPABASE_URL: "" });
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await advanceConversationIntake(advanceInput, { ...env, SUPABASE_URL: "http://example.supabase.co" });
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const result = await advanceConversationIntake(advanceInput, env);
    expect(result).toEqual({ ok: false, reason: "failed" });
  });

  it("treats a non-2xx response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    const result = await advanceConversationIntake(advanceInput, env);
    expect(result).toEqual({ ok: false, reason: "failed" });
  });

  it.each([
    ["a non-array body", { intake_stage: "complaint_collection", state_version: 2 }],
    ["more than one row", [{ intake_stage: "a", state_version: 1 }, { intake_stage: "b", state_version: 2 }]],
    ["a row missing state_version", [{ intake_stage: "complaint_collection" }]],
    ["a row with a non-numeric state_version", [{ intake_stage: "complaint_collection", state_version: "2" }]],
    ["a row with an invalid stage", [{ intake_stage: "invented", state_version: 2 }]],
    ["a row with a nonpositive version", [{ intake_stage: "complaint_collection", state_version: 0 }]],
  ])("treats %s as a malformed response and fails", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    const result = await advanceConversationIntake(advanceInput, env);
    expect(result).toEqual({ ok: false, reason: "failed" });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ intake_stage: "complaint_collection", state_version: 2 }])));

    await advanceConversationIntake(advanceInput, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
