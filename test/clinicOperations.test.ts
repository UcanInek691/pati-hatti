import { afterEach, describe, expect, it, vi } from "vitest";
import { getConversationClinicOperationalContext } from "../src/clinicOperations";
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function rawJsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

function configuredRow(overrides: Record<string, unknown> = {}) {
  return {
    result: "configured",
    clinic_name: "Vet Clinic",
    contact_phone_e164: "+905551112233",
    public_address: "Bagdat Cad. No 1",
    is_open: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getConversationClinicOperationalContext", () => {
  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([configuredRow()]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getConversationClinicOperationalContext(conversationId, env);

    expect(result).toEqual({
      result: "configured",
      clinicName: "Vet Clinic",
      phone: "+905551112233",
      address: "Bagdat Cad. No 1",
      isOpen: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/get_conversation_clinic_operational_context");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ p_conversation_id: conversationId });
  });

  it("accepts a configured row with a null address", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([configuredRow({ public_address: null })])));
    const result = await getConversationClinicOperationalContext(conversationId, env);
    expect(result).toEqual({
      result: "configured",
      clinicName: "Vet Clinic",
      phone: "+905551112233",
      address: null,
      isOpen: true,
    });
  });

  it("accepts a closed configured row", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([configuredRow({ is_open: false })])));
    const result = await getConversationClinicOperationalContext(conversationId, env);
    expect(result).toEqual({
      result: "configured",
      clinicName: "Vet Clinic",
      phone: "+905551112233",
      address: "Bagdat Cad. No 1",
      isOpen: false,
    });
  });

  it.each([
    [
      "not_found",
      { result: "not_found", clinic_name: null, contact_phone_e164: null, public_address: null, is_open: null },
      { result: "not_found" },
    ],
    [
      "unconfigured",
      { result: "unconfigured", clinic_name: null, contact_phone_e164: null, public_address: null, is_open: null },
      { result: "unconfigured" },
    ],
  ])("accepts an all-null %s row", async (_label, row, expected) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([row])));
    const result = await getConversationClinicOperationalContext(conversationId, env);
    expect(result).toEqual(expected);
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await getConversationClinicOperationalContext(conversationId, { ...env, SUPABASE_URL: "" });
    expect(result).toEqual({ result: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when a required runtime binding is absent, without throwing or calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await getConversationClinicOperationalContext(conversationId, {
      ...env,
      SUPABASE_URL: undefined,
    } as unknown as Env);
    expect(result).toEqual({ result: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase configuration contains only whitespace", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await getConversationClinicOperationalContext(conversationId, { ...env, SUPABASE_SERVICE_ROLE_KEY: "   " });
    expect(result).toEqual({ result: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await getConversationClinicOperationalContext(conversationId, { ...env, SUPABASE_URL: "http://example.supabase.co" });
    expect(result).toEqual({ result: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows plain HTTP for loopback localhost testing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([configuredRow()])));
    const result = await getConversationClinicOperationalContext(conversationId, { ...env, SUPABASE_URL: "http://localhost:54321" });
    expect(result.result).toBe("configured");
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const result = await getConversationClinicOperationalContext(conversationId, env);
    expect(result).toEqual({ result: "failed" });
  });

  it("treats a non-2xx response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    const result = await getConversationClinicOperationalContext(conversationId, env);
    expect(result).toEqual({ result: "failed" });
  });

  it.each([
    ["a non-array body", configuredRow()],
    ["an empty array", []],
    ["more than one row", [configuredRow(), configuredRow()]],
    ["an unrecognized result value", [configuredRow({ result: "invented" })]],
    ["a row with an extra unexpected key", [{ ...configuredRow(), extra: "x" }]],
    ["a non-plain row", [Object.assign(Object.create(null) as Record<string, unknown>, configuredRow())]],
    [
      "a row with a non-enumerable key",
      [Object.defineProperty(configuredRow(), "hidden", { value: "x", enumerable: false })],
    ],
    ["a row with a symbol key", [Object.assign(configuredRow(), { [Symbol("extra")]: "x" })]],
    [
      "a row with a throwing field getter",
      [Object.defineProperty(configuredRow(), "clinic_name", { get: () => { throw new Error("getter failed"); }, enumerable: true })],
    ],
    ["a not_found row with a non-null field", [{ result: "not_found", clinic_name: "x", contact_phone_e164: null, public_address: null, is_open: null }]],
    ["an unconfigured row with a non-null field", [{ result: "unconfigured", clinic_name: null, contact_phone_e164: null, public_address: null, is_open: true }]],
    ["a configured row with an empty clinic name", [configuredRow({ clinic_name: "" })]],
    ["a configured row with an untrimmed clinic name", [configuredRow({ clinic_name: " Vet Clinic " })]],
    ["a configured row with a clinic name over 120 code points", [configuredRow({ clinic_name: "a".repeat(121) })]],
    ["a configured row with a control character in the clinic name", [configuredRow({ clinic_name: `Vet${String.fromCharCode(7)}Clinic` })]],
    ["a configured row with a non-E.164 phone", [configuredRow({ contact_phone_e164: "05551112233" })]],
    ["a configured row with a phone missing the leading digit", [configuredRow({ contact_phone_e164: "+0551112233" })]],
    ["a configured row with an empty address", [configuredRow({ public_address: "" })]],
    ["a configured row with an untrimmed address", [configuredRow({ public_address: " Bagdat Cad. " })]],
    ["a configured row with an address over 500 code points", [configuredRow({ public_address: "a".repeat(501) })]],
    ["a configured row with a control character in the address", [configuredRow({ public_address: `Bagdat${String.fromCharCode(1)}Cad.` })]],
    ["a configured row with a non-boolean is_open", [configuredRow({ is_open: "true" })]],
    ["a configured row missing contact_phone_e164", [(() => { const r = configuredRow() as Record<string, unknown>; delete r.contact_phone_e164; return r; })()]],
  ])("treats %s as a malformed response and fails", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse(body)));
    const result = await getConversationClinicOperationalContext(conversationId, env);
    expect(result).toEqual({ result: "failed" });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([configuredRow({ clinic_name: "Sensitive Clinic Name" })])));

    await getConversationClinicOperationalContext(conversationId, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
