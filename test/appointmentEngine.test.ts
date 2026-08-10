import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmAppointmentSlot, holdAppointmentSlot, listAvailableAppointmentSlots } from "../src/appointmentEngine";
import type { ListAvailableAppointmentSlotsInput } from "../src/appointmentEngine";
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
  WHATSAPP_ACCESS_TOKEN: "test-whatsapp-access-token",
  WHATSAPP_GRAPH_API_VERSION: "v25.0",
};

const conversationId = "11111111-1111-1111-1111-111111111111";
const slotId = "44444444-4444-4444-4444-444444444444";
const otherSlotId = "44444444-4444-4444-4444-444444444445";
const bookingToken = "55555555-5555-5555-5555-555555555555";
const from = "2026-08-11T09:00:00.000Z";
const to = "2026-08-11T10:00:00.000Z";
const startsAt = "2026-08-11T09:00:00.000Z";
const endsAt = "2026-08-11T09:30:00.000Z";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function rawJsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listAvailableAppointmentSlots", () => {
  const baseInput: ListAvailableAppointmentSlotsInput = { conversationId, from, to };

  it("calls the RPC with the documented URL, method, headers, and a default limit of 5", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ slot_id: slotId, starts_at: startsAt, ends_at: endsAt }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listAvailableAppointmentSlots(baseInput, env);

    expect(result).toEqual({ kind: "listed", slots: [{ slotId, startsAt, endsAt }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/list_available_appointment_slots");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ p_conversation_id: conversationId, p_from: from, p_to: to, p_limit: 5 });
  });

  it("passes an explicit limit through unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await listAvailableAppointmentSlots({ ...baseInput, limit: 3 }, env);
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ p_limit: 3 });
  });

  it("returns an empty listed result for zero rows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));
    expect(await listAvailableAppointmentSlots(baseInput, env)).toEqual({ kind: "listed", slots: [] });
  });

  it("preserves row ordering across multiple slots", async () => {
    const rows = [
      { slot_id: slotId, starts_at: startsAt, ends_at: endsAt },
      { slot_id: otherSlotId, starts_at: "2026-08-11T09:30:00.000Z", ends_at: "2026-08-11T10:00:00.000Z" },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(rows)));
    const result = await listAvailableAppointmentSlots(baseInput, env);
    expect(result).toEqual({
      kind: "listed",
      slots: [
        { slotId, startsAt, endsAt },
        { slotId: otherSlotId, startsAt: "2026-08-11T09:30:00.000Z", endsAt: "2026-08-11T10:00:00.000Z" },
      ],
    });
  });

  it.each([
    ["an invalid conversationId", { ...baseInput, conversationId: "not-a-uuid" }],
    ["a malformed from timestamp", { ...baseInput, from: "not-a-timestamp" }],
    ["a malformed to timestamp", { ...baseInput, to: "not-a-timestamp" }],
    ["a to equal to from", { ...baseInput, to: from }],
    ["a to before from", { ...baseInput, to: "2026-08-11T08:00:00.000Z" }],
    ["a window longer than 31 days", { ...baseInput, to: "2026-09-15T09:00:00.000Z" }],
    ["a zero limit", { ...baseInput, limit: 0 }],
    ["a limit above 10", { ...baseInput, limit: 11 }],
    ["a non-integer limit", { ...baseInput, limit: 1.5 }],
  ])("rejects %s locally without calling fetch", async (_label, input) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await listAvailableAppointmentSlots(input, env)).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await listAvailableAppointmentSlots(baseInput, { ...env, SUPABASE_URL: "" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when a runtime binding is undefined", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const missingUrl = { ...env, SUPABASE_URL: undefined as unknown as string };

    await expect(listAvailableAppointmentSlots(baseInput, missingUrl)).resolves.toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await listAvailableAppointmentSlots(baseInput, { ...env, SUPABASE_URL: "http://example.supabase.co" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows plain HTTP for loopback localhost testing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));
    const result = await listAvailableAppointmentSlots(baseInput, { ...env, SUPABASE_URL: "http://localhost:54321" });
    expect(result).toEqual({ kind: "listed", slots: [] });
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await listAvailableAppointmentSlots(baseInput, env)).toEqual({ kind: "failed" });
  });

  it("treats a non-2xx response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await listAvailableAppointmentSlots(baseInput, env)).toEqual({ kind: "failed" });
  });

  it("treats malformed JSON as failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError("bad json");
        },
      } as unknown as Response),
    );
    expect(await listAvailableAppointmentSlots(baseInput, env)).toEqual({ kind: "failed" });
  });

  it.each([
    ["a non-array body", { slot_id: slotId, starts_at: startsAt, ends_at: endsAt }],
    ["a row with an extra column", [{ slot_id: slotId, starts_at: startsAt, ends_at: endsAt, extra: "x" }]],
    ["a row with a missing column", [{ slot_id: slotId, starts_at: startsAt }]],
    ["a row with a non-string slot_id", [{ slot_id: 1, starts_at: startsAt, ends_at: endsAt }]],
    ["a row with a malformed slot_id", [{ slot_id: "not-a-uuid", starts_at: startsAt, ends_at: endsAt }]],
    ["a row with a malformed starts_at", [{ slot_id: slotId, starts_at: "not-a-timestamp", ends_at: endsAt }]],
    ["a row with a malformed ends_at", [{ slot_id: slotId, starts_at: startsAt, ends_at: "not-a-timestamp" }]],
    ["a row with a null starts_at", [{ slot_id: slotId, starts_at: null, ends_at: endsAt }]],
  ])("treats %s as a malformed response and fails", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await listAvailableAppointmentSlots(baseInput, env)).toEqual({ kind: "failed" });
  });

  it("rejects a non-plain row and hidden extra columns", async () => {
    const nonPlain = Object.assign(Object.create(null), { slot_id: slotId, starts_at: startsAt, ends_at: endsAt });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([nonPlain])));
    expect(await listAvailableAppointmentSlots(baseInput, env)).toEqual({ kind: "failed" });

    const hiddenExtra = { slot_id: slotId, starts_at: startsAt, ends_at: endsAt };
    Object.defineProperty(hiddenExtra, "extra", { value: "x" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([hiddenExtra])));
    expect(await listAvailableAppointmentSlots(baseInput, env)).toEqual({ kind: "failed" });
  });

  it("does not mutate the caller's input", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));
    const input = Object.freeze({ ...baseInput });
    await expect(listAvailableAppointmentSlots(input, env)).resolves.toEqual({ kind: "listed", slots: [] });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ slot_id: slotId, starts_at: startsAt, ends_at: endsAt }])));

    await listAvailableAppointmentSlots(baseInput, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("appointment client result ownership", () => {
  it("returns a fresh failed object from every call", async () => {
    const firstList = await listAvailableAppointmentSlots({ conversationId: "invalid", from, to }, env);
    const secondList = await listAvailableAppointmentSlots({ conversationId: "invalid", from, to }, env);
    const firstHold = await holdAppointmentSlot("invalid", slotId, env);
    const secondHold = await holdAppointmentSlot("invalid", slotId, env);
    const firstConfirm = await confirmAppointmentSlot("invalid", slotId, bookingToken, env);
    const secondConfirm = await confirmAppointmentSlot("invalid", slotId, bookingToken, env);

    expect(firstList).not.toBe(secondList);
    expect(firstHold).not.toBe(secondHold);
    expect(firstConfirm).not.toBe(secondConfirm);
  });
});

describe("holdAppointmentSlot", () => {
  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "held", booking_token: bookingToken, starts_at: startsAt, ends_at: endsAt }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await holdAppointmentSlot(conversationId, slotId, env);

    expect(result).toEqual({ kind: "held", bookingToken, startsAt, endsAt });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/hold_appointment_slot");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(JSON.parse(init.body as string)).toEqual({ p_conversation_id: conversationId, p_slot_id: slotId });
  });

  it.each(["not_found", "not_ready", "unavailable", "conflict"] as const)("parses a %s result with a null token and times", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result, booking_token: null, starts_at: null, ends_at: null }])));
    expect(await holdAppointmentSlot(conversationId, slotId, env)).toEqual({ kind: result });
  });

  it.each([
    ["an invalid conversationId", "not-a-uuid", slotId],
    ["an invalid slotId", conversationId, "not-a-uuid"],
  ])("rejects %s locally without calling fetch", async (_label, convId, sId) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await holdAppointmentSlot(convId, sId, env)).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await holdAppointmentSlot(conversationId, slotId, { ...env, SUPABASE_URL: "" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await holdAppointmentSlot(conversationId, slotId, { ...env, SUPABASE_URL: "http://example.supabase.co" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows plain HTTP for loopback localhost testing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse([{ result: "held", booking_token: bookingToken, starts_at: startsAt, ends_at: endsAt }])),
    );
    const result = await holdAppointmentSlot(conversationId, slotId, { ...env, SUPABASE_URL: "http://127.0.0.1:54321" });
    expect(result).toEqual({ kind: "held", bookingToken, startsAt, endsAt });
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await holdAppointmentSlot(conversationId, slotId, env)).toEqual({ kind: "failed" });
  });

  it("treats a non-2xx response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await holdAppointmentSlot(conversationId, slotId, env)).toEqual({ kind: "failed" });
  });

  it.each([
    ["a non-array body", { result: "not_found", booking_token: null, starts_at: null, ends_at: null }],
    ["zero rows", []],
    [
      "more than one row",
      [
        { result: "not_found", booking_token: null, starts_at: null, ends_at: null },
        { result: "not_found", booking_token: null, starts_at: null, ends_at: null },
      ],
    ],
    ["a row with an extra column", [{ result: "not_found", booking_token: null, starts_at: null, ends_at: null, extra: "x" }]],
    ["a row with an unknown result", [{ result: "invented", booking_token: null, starts_at: null, ends_at: null }]],
    ["a held row with a non-string token", [{ result: "held", booking_token: 1, starts_at: startsAt, ends_at: endsAt }]],
    ["a held row with a malformed token", [{ result: "held", booking_token: "not-a-uuid", starts_at: startsAt, ends_at: endsAt }]],
    ["a held row with a malformed starts_at", [{ result: "held", booking_token: bookingToken, starts_at: "not-a-timestamp", ends_at: endsAt }]],
    ["a held row with a null ends_at", [{ result: "held", booking_token: bookingToken, starts_at: startsAt, ends_at: null }]],
    ["a not_found row with a non-null token", [{ result: "not_found", booking_token: bookingToken, starts_at: null, ends_at: null }]],
    ["a conflict row with non-null times", [{ result: "conflict", booking_token: null, starts_at: startsAt, ends_at: endsAt }]],
  ])("treats %s as a malformed response and fails", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await holdAppointmentSlot(conversationId, slotId, env)).toEqual({ kind: "failed" });
  });

  it("rejects a non-plain row and hidden extra columns", async () => {
    const nonPlain = Object.assign(Object.create(null), { result: "not_found", booking_token: null, starts_at: null, ends_at: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([nonPlain])));
    expect(await holdAppointmentSlot(conversationId, slotId, env)).toEqual({ kind: "failed" });

    const hiddenExtra = { result: "not_found", booking_token: null, starts_at: null, ends_at: null };
    Object.defineProperty(hiddenExtra, "extra", { value: "x" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([hiddenExtra])));
    expect(await holdAppointmentSlot(conversationId, slotId, env)).toEqual({ kind: "failed" });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse([{ result: "held", booking_token: bookingToken, starts_at: startsAt, ends_at: endsAt }])),
    );

    await holdAppointmentSlot(conversationId, slotId, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("confirmAppointmentSlot", () => {
  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "confirmed", starts_at: startsAt, ends_at: endsAt }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await confirmAppointmentSlot(conversationId, slotId, bookingToken, env);

    expect(result).toEqual({ kind: "confirmed", startsAt, endsAt });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/confirm_appointment_slot");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(JSON.parse(init.body as string)).toEqual({ p_conversation_id: conversationId, p_slot_id: slotId, p_booking_token: bookingToken });
  });

  it("parses an already_confirmed result with times", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "already_confirmed", starts_at: startsAt, ends_at: endsAt }])));
    expect(await confirmAppointmentSlot(conversationId, slotId, bookingToken, env)).toEqual({ kind: "already_confirmed", startsAt, endsAt });
  });

  it.each(["not_found", "not_ready", "stale"] as const)("parses a %s result with null times", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result, starts_at: null, ends_at: null }])));
    expect(await confirmAppointmentSlot(conversationId, slotId, bookingToken, env)).toEqual({ kind: result });
  });

  it.each([
    ["an invalid conversationId", "not-a-uuid", slotId, bookingToken],
    ["an invalid slotId", conversationId, "not-a-uuid", bookingToken],
    ["an invalid bookingToken", conversationId, slotId, "not-a-uuid"],
  ])("rejects %s locally without calling fetch", async (_label, convId, sId, token) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await confirmAppointmentSlot(convId, sId, token, env)).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await confirmAppointmentSlot(conversationId, slotId, bookingToken, { ...env, SUPABASE_URL: "" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await confirmAppointmentSlot(conversationId, slotId, bookingToken, { ...env, SUPABASE_URL: "http://example.supabase.co" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows plain HTTP for loopback localhost testing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "confirmed", starts_at: startsAt, ends_at: endsAt }])));
    const result = await confirmAppointmentSlot(conversationId, slotId, bookingToken, { ...env, SUPABASE_URL: "http://[::1]:54321" });
    expect(result).toEqual({ kind: "confirmed", startsAt, endsAt });
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await confirmAppointmentSlot(conversationId, slotId, bookingToken, env)).toEqual({ kind: "failed" });
  });

  it("treats a non-2xx response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await confirmAppointmentSlot(conversationId, slotId, bookingToken, env)).toEqual({ kind: "failed" });
  });

  it.each([
    ["a non-array body", { result: "not_found", starts_at: null, ends_at: null }],
    ["zero rows", []],
    [
      "more than one row",
      [
        { result: "not_found", starts_at: null, ends_at: null },
        { result: "not_found", starts_at: null, ends_at: null },
      ],
    ],
    ["a row with an extra column", [{ result: "not_found", starts_at: null, ends_at: null, extra: "x" }]],
    ["a row with an unknown result", [{ result: "invented", starts_at: null, ends_at: null }]],
    ["a confirmed row with a malformed starts_at", [{ result: "confirmed", starts_at: "not-a-timestamp", ends_at: endsAt }]],
    ["a confirmed row with a null ends_at", [{ result: "confirmed", starts_at: startsAt, ends_at: null }]],
    ["a stale row with non-null times", [{ result: "stale", starts_at: startsAt, ends_at: endsAt }]],
  ])("treats %s as a malformed response and fails", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await confirmAppointmentSlot(conversationId, slotId, bookingToken, env)).toEqual({ kind: "failed" });
  });

  it("rejects a non-plain row and hidden extra columns", async () => {
    const nonPlain = Object.assign(Object.create(null), { result: "not_found", starts_at: null, ends_at: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([nonPlain])));
    expect(await confirmAppointmentSlot(conversationId, slotId, bookingToken, env)).toEqual({ kind: "failed" });

    const hiddenExtra = { result: "not_found", starts_at: null, ends_at: null };
    Object.defineProperty(hiddenExtra, "extra", { value: "x" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([hiddenExtra])));
    expect(await confirmAppointmentSlot(conversationId, slotId, bookingToken, env)).toEqual({ kind: "failed" });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "confirmed", starts_at: startsAt, ends_at: endsAt }])));

    await confirmAppointmentSlot(conversationId, slotId, bookingToken, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
