import { afterEach, describe, expect, it, vi } from "vitest";
import {
  finalizeClinicOffboarding,
  prepareClinicOffboarding,
  provisionClinic,
  resumeClinic,
  suspendClinic,
} from "../src/clinicLifecycle";
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

const clinicId = "44444444-4444-4444-4444-444444444444";
const offboardingToken = "55555555-5555-5555-5555-555555555555";

const provisionInput = {
  clinicId,
  clinicName: "Pilot Clinic",
  contactPhoneE164: "+15550001234",
  publicAddress: "123 Test Street",
  ownerUserId: "66666666-6666-6666-6666-666666666666",
  staffRole: "admin",
  whatsappAccountId: "77777777-7777-7777-7777-777777777777",
  phoneNumberId: "918000002",
  displayName: "Pilot WhatsApp",
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

it("returns fresh failure objects", async () => {
  const first = await suspendClinic("not-a-uuid", env);
  const second = await suspendClinic("not-a-uuid", env);
  expect(first).toEqual({ kind: "call_failed" });
  expect(second).toEqual({ kind: "call_failed" });
  expect(first).not.toBe(second);
});

describe("provisionClinic", () => {
  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "provisioned" }]));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", fetchMock);

    const result = await provisionClinic(provisionInput, env);

    expect(result).toEqual({ kind: "provisioned" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/provision_clinic_v1");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      p_clinic_id: provisionInput.clinicId,
      p_clinic_name: provisionInput.clinicName,
      p_contact_phone_e164: provisionInput.contactPhoneE164,
      p_public_address: provisionInput.publicAddress,
      p_owner_user_id: provisionInput.ownerUserId,
      p_staff_role: provisionInput.staffRole,
      p_whatsapp_account_id: provisionInput.whatsappAccountId,
      p_phone_number_id: provisionInput.phoneNumberId,
      p_display_name: provisionInput.displayName,
    });
    timeoutSpy.mockRestore();
  });

  it.each(["provisioned", "already_provisioned"] as const)("parses a %s result", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result }])));
    expect(await provisionClinic(provisionInput, env)).toEqual({ kind: result });
  });

  it("passes null contact/address/display-name fields through unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "provisioned" }]));
    vi.stubGlobal("fetch", fetchMock);

    await provisionClinic({ ...provisionInput, contactPhoneE164: null, publicAddress: null, displayName: null }, env);

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.p_contact_phone_e164).toBeNull();
    expect(body.p_public_address).toBeNull();
    expect(body.p_display_name).toBeNull();
  });

  it.each([
    ["clinicId", "44444444-4444-4444-4444-44444444444Z"],
    ["clinicId", "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"],
    ["clinicName", " Pilot Clinic"],
    ["clinicName", "Pilot\nClinic"],
    ["clinicName", "x".repeat(201)],
    ["contactPhoneE164", "5550001234"],
    ["publicAddress", "123 Test\nStreet"],
    ["ownerUserId", "not-a-uuid"],
    ["staffRole", "owner"],
    ["whatsappAccountId", "not-a-uuid"],
    ["phoneNumberId", "918-000-002"],
    ["displayName", "Pilot\u007fWhatsApp"],
  ])("rejects an invalid %s before fetch", async (key, value) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const input = { ...provisionInput, [key]: value } as Parameters<typeof provisionClinic>[0];
    expect(await provisionClinic(input, env)).toEqual({ kind: "call_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects extra input keys and hostile input objects before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await provisionClinic({ ...provisionInput, extra: true } as Parameters<typeof provisionClinic>[0], env)).toEqual({
      kind: "call_failed",
    });
    const hostile = new Proxy(provisionInput, {
      ownKeys() {
        throw new Error("do not inspect me");
      },
    });
    expect(await provisionClinic(hostile, env)).toEqual({ kind: "call_failed" });

    const throwingGetter = { ...provisionInput };
    Object.defineProperty(throwingGetter, "clinicName", {
      enumerable: true,
      get() {
        throw new Error("do not read me");
      },
    });
    expect(await provisionClinic(throwingGetter, env)).toEqual({ kind: "call_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("snapshots getter-backed input exactly once before validation and sending", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "provisioned" }]));
    vi.stubGlobal("fetch", fetchMock);
    let reads = 0;
    const getterInput = { ...provisionInput };
    Object.defineProperty(getterInput, "clinicName", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "Pilot Clinic" : "Changed Clinic";
      },
    });

    expect(await provisionClinic(getterInput, env)).toEqual({ kind: "provisioned" });
    expect(reads).toBe(1);
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string).p_clinic_name).toBe("Pilot Clinic");
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await provisionClinic(provisionInput, { ...env, SUPABASE_URL: "" });
    expect(result).toEqual({ kind: "call_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await provisionClinic(provisionInput, { ...env, SUPABASE_URL: "http://example.supabase.co" });
    expect(result).toEqual({ kind: "call_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows plain HTTP for loopback localhost testing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "provisioned" }])));
    const result = await provisionClinic(provisionInput, { ...env, SUPABASE_URL: "http://localhost:54321" });
    expect(result).toEqual({ kind: "provisioned" });
  });

  it("treats a network failure as call_failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await provisionClinic(provisionInput, env)).toEqual({ kind: "call_failed" });
  });

  it("treats a non-2xx response as call_failed (including a raised conflicting-replay or missing-Auth-user exception)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await provisionClinic(provisionInput, env)).toEqual({ kind: "call_failed" });
  });

  it.each([
    ["a non-array body", { result: "provisioned" }],
    ["zero rows", []],
    ["more than one row", [{ result: "provisioned" }, { result: "provisioned" }]],
    ["a row with an extra column", [{ result: "provisioned", extra: "x" }]],
    ["a row with an unknown result", [{ result: "invented" }]],
  ])("treats %s as a malformed response and reports call_failed", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await provisionClinic(provisionInput, env)).toEqual({ kind: "call_failed" });
  });

  it("rejects a non-plain row and symbol extra columns", async () => {
    const nonPlain = Object.assign(Object.create(null), { result: "provisioned" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([nonPlain])));
    expect(await provisionClinic(provisionInput, env)).toEqual({ kind: "call_failed" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([{ result: "provisioned", [Symbol("extra")]: "x" }])));
    expect(await provisionClinic(provisionInput, env)).toEqual({ kind: "call_failed" });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "provisioned" }])));

    await provisionClinic(provisionInput, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("suspendClinic", () => {
  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "suspended" }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await suspendClinic(clinicId, env);

    expect(result).toEqual({ kind: "suspended" });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/suspend_clinic_v1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ p_clinic_id: clinicId });
  });

  it("rejects a non-canonical clinic ID before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await suspendClinic("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", env)).toEqual({ kind: "call_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["suspended", "already_suspended", "not_found"] as const)("parses a %s result", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result }])));
    expect(await suspendClinic(clinicId, env)).toEqual({ kind: result });
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await suspendClinic(clinicId, { ...env, SUPABASE_URL: "" })).toEqual({ kind: "call_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a network failure as call_failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await suspendClinic(clinicId, env)).toEqual({ kind: "call_failed" });
  });

  it("treats a non-2xx response as call_failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await suspendClinic(clinicId, env)).toEqual({ kind: "call_failed" });
  });

  it.each([
    ["a non-array body", { result: "suspended" }],
    ["zero rows", []],
    ["more than one row", [{ result: "suspended" }, { result: "suspended" }]],
    ["a row with an extra column", [{ result: "suspended", extra: "x" }]],
    ["a row with an unknown result", [{ result: "invented" }]],
  ])("treats %s as a malformed response and reports call_failed", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await suspendClinic(clinicId, env)).toEqual({ kind: "call_failed" });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "suspended" }])));

    await suspendClinic(clinicId, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("resumeClinic", () => {
  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "resumed" }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resumeClinic(clinicId, env);

    expect(result).toEqual({ kind: "resumed" });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/resume_clinic_v1");
    expect(JSON.parse(init.body as string)).toEqual({ p_clinic_id: clinicId });
  });

  it("rejects an invalid clinic ID before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await resumeClinic("not-a-uuid", env)).toEqual({ kind: "call_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["resumed", "already_active", "refused_offboarding", "not_found"] as const)("parses a %s result", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result }])));
    expect(await resumeClinic(clinicId, env)).toEqual({ kind: result });
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await resumeClinic(clinicId, { ...env, SUPABASE_URL: "" })).toEqual({ kind: "call_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a network failure as call_failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await resumeClinic(clinicId, env)).toEqual({ kind: "call_failed" });
  });

  it("treats a non-2xx response as call_failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await resumeClinic(clinicId, env)).toEqual({ kind: "call_failed" });
  });

  it.each([
    ["a non-array body", { result: "resumed" }],
    ["zero rows", []],
    ["more than one row", [{ result: "resumed" }, { result: "resumed" }]],
    ["a row with an extra column", [{ result: "resumed", extra: "x" }]],
    ["a row with an unknown result", [{ result: "invented" }]],
  ])("treats %s as a malformed response and reports call_failed", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await resumeClinic(clinicId, env)).toEqual({ kind: "call_failed" });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "resumed" }])));

    await resumeClinic(clinicId, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("prepareClinicOffboarding", () => {
  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "prepared", offboarding_token: offboardingToken }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await prepareClinicOffboarding(clinicId, env);

    expect(result).toEqual({ kind: "prepared", offboardingToken });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/prepare_clinic_offboarding_v1");
    expect(JSON.parse(init.body as string)).toEqual({ p_clinic_id: clinicId });
  });

  it("rejects an invalid clinic ID before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await prepareClinicOffboarding("not-a-uuid", env)).toEqual({ kind: "call_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["prepared", "already_offboarding"] as const)("parses a %s result with its token", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result, offboarding_token: offboardingToken }])));
    expect(await prepareClinicOffboarding(clinicId, env)).toEqual({ kind: result, offboardingToken });
  });

  it("parses a not_found result with a null token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "not_found", offboarding_token: null }])));
    expect(await prepareClinicOffboarding(clinicId, env)).toEqual({ kind: "not_found" });
  });

  it("treats a not_found result carrying a non-null token as malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "not_found", offboarding_token: offboardingToken }])));
    expect(await prepareClinicOffboarding(clinicId, env)).toEqual({ kind: "call_failed" });
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await prepareClinicOffboarding(clinicId, { ...env, SUPABASE_URL: "" })).toEqual({ kind: "call_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a network failure as call_failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await prepareClinicOffboarding(clinicId, env)).toEqual({ kind: "call_failed" });
  });

  it("treats a non-2xx response as call_failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await prepareClinicOffboarding(clinicId, env)).toEqual({ kind: "call_failed" });
  });

  it.each([
    ["a non-array body", { result: "prepared", offboarding_token: offboardingToken }],
    ["zero rows", []],
    [
      "more than one row",
      [
        { result: "prepared", offboarding_token: offboardingToken },
        { result: "prepared", offboarding_token: offboardingToken },
      ],
    ],
    ["a row with an extra column", [{ result: "prepared", offboarding_token: offboardingToken, extra: "x" }]],
    ["a row with an unknown result", [{ result: "invented", offboarding_token: offboardingToken }]],
    ["a row with a non-string token", [{ result: "prepared", offboarding_token: 1 }]],
    ["a row with a malformed token", [{ result: "prepared", offboarding_token: "not-a-uuid" }]],
    ["a row with a null token", [{ result: "prepared", offboarding_token: null }]],
  ])("treats %s as a malformed response and reports call_failed", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await prepareClinicOffboarding(clinicId, env)).toEqual({ kind: "call_failed" });
  });

  it("does not log the request or response, including the returned token", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "prepared", offboarding_token: offboardingToken }])));

    await prepareClinicOffboarding(clinicId, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("finalizeClinicOffboarding", () => {
  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "finalized" }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await finalizeClinicOffboarding(clinicId, offboardingToken, env);

    expect(result).toEqual({ kind: "finalized" });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/finalize_clinic_offboarding_v1");
    expect(JSON.parse(init.body as string)).toEqual({ p_clinic_id: clinicId, p_offboarding_token: offboardingToken });
  });

  it.each([
    ["not-a-uuid", offboardingToken],
    [clinicId, "not-a-uuid"],
    ["AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", offboardingToken],
  ])("rejects invalid identifiers before fetch", async (invalidClinicId, invalidToken) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await finalizeClinicOffboarding(invalidClinicId, invalidToken, env)).toEqual({ kind: "call_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["finalized", "already_offboarded", "not_found"] as const)("parses a %s result", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result }])));
    expect(await finalizeClinicOffboarding(clinicId, offboardingToken, env)).toEqual({ kind: result });
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await finalizeClinicOffboarding(clinicId, offboardingToken, { ...env, SUPABASE_URL: "" })).toEqual({ kind: "call_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a network failure as call_failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await finalizeClinicOffboarding(clinicId, offboardingToken, env)).toEqual({ kind: "call_failed" });
  });

  it("treats a non-2xx response as call_failed (including a raised stale/wrong-token exception)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await finalizeClinicOffboarding(clinicId, offboardingToken, env)).toEqual({ kind: "call_failed" });
  });

  it.each([
    ["a non-array body", { result: "finalized" }],
    ["zero rows", []],
    ["more than one row", [{ result: "finalized" }, { result: "finalized" }]],
    ["a row with an extra column", [{ result: "finalized", extra: "x" }]],
    ["a row with an unknown result", [{ result: "invented" }]],
  ])("treats %s as a malformed response and reports call_failed", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await finalizeClinicOffboarding(clinicId, offboardingToken, env)).toEqual({ kind: "call_failed" });
  });

  it("does not log the request or response, including the offboarding token it was called with", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "finalized" }])));

    await finalizeClinicOffboarding(clinicId, offboardingToken, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
