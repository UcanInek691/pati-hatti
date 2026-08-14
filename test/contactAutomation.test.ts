import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWhatsAppContactAutomation } from "../src/contactAutomation";
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

const phoneNumberId = "123456789012345";
const contactE164 = "+905551112233";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function rawJsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveWhatsAppContactAutomation", () => {
  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "ai" }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveWhatsAppContactAutomation(phoneNumberId, contactE164, env);

    expect(result).toEqual({ kind: "ai" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/resolve_whatsapp_contact_automation");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      p_phone_number_id: phoneNumberId,
      p_contact_e164: contactE164,
    });
  });

  it.each(["ai", "manual", "personal", "unknown_account"] as const)("parses a %s result", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result }])));
    expect(await resolveWhatsAppContactAutomation(phoneNumberId, contactE164, env)).toEqual({ kind: result });
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await resolveWhatsAppContactAutomation(phoneNumberId, contactE164, { ...env, SUPABASE_URL: "" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await resolveWhatsAppContactAutomation(phoneNumberId, contactE164, {
      ...env,
      SUPABASE_URL: "http://example.supabase.co",
    });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows plain HTTP for loopback localhost testing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "manual" }])));
    const result = await resolveWhatsAppContactAutomation(phoneNumberId, contactE164, {
      ...env,
      SUPABASE_URL: "http://127.0.0.1:54321",
    });
    expect(result).toEqual({ kind: "manual" });
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await resolveWhatsAppContactAutomation(phoneNumberId, contactE164, env)).toEqual({ kind: "failed" });
  });

  it("treats a non-2xx response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await resolveWhatsAppContactAutomation(phoneNumberId, contactE164, env)).toEqual({ kind: "failed" });
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
    expect(await resolveWhatsAppContactAutomation(phoneNumberId, contactE164, env)).toEqual({ kind: "failed" });
  });

  it.each([
    ["a non-array body", { result: "ai" }],
    ["zero rows", []],
    ["more than one row", [{ result: "ai" }, { result: "ai" }]],
    ["a row with an extra column", [{ result: "ai", extra: "x" }]],
    ["a row with an unknown result", [{ result: "invented" }]],
    ["a row with a non-string result", [{ result: 1 }]],
    ["a row with a null result", [{ result: null }]],
  ])("treats %s as a malformed response and fails", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await resolveWhatsAppContactAutomation(phoneNumberId, contactE164, env)).toEqual({ kind: "failed" });
  });

  it("rejects a non-plain row and hidden extra columns", async () => {
    const nonPlain = Object.assign(Object.create(null), { result: "ai" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([nonPlain])));
    expect(await resolveWhatsAppContactAutomation(phoneNumberId, contactE164, env)).toEqual({ kind: "failed" });

    const hiddenExtra = { result: "ai" };
    Object.defineProperty(hiddenExtra, "extra", { value: "x" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([hiddenExtra])));
    expect(await resolveWhatsAppContactAutomation(phoneNumberId, contactE164, env)).toEqual({ kind: "failed" });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "ai" }])));

    await resolveWhatsAppContactAutomation(phoneNumberId, contactE164, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
