import { afterEach, describe, expect, it, vi } from "vitest";
import { checkReadiness } from "../src/readiness";
import type { Env } from "../src/env";
import type { IntakeQueueMessage } from "../src/intakeQueue";

function validEnv(): Env {
  return {
    APP_TIMEZONE: "Europe/Istanbul",
    WHATSAPP_VERIFY_TOKEN: "verify-token-abc123",
    WHATSAPP_APP_SECRET: "app-secret-abc123",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-abc123",
    SUPABASE_ANON_KEY: "anon-key-abc123",
    OPENAI_API_KEY: "sk-abc123",
    INTAKE_QUEUE: { send: async () => {} } as unknown as Queue<IntakeQueueMessage>,
    WHATSAPP_ACCOUNT_CREDENTIALS_JSON: JSON.stringify([
      { whatsapp_account_id: "11111111-1111-1111-1111-111111111111", phone_number_id: "918000001", access_token: "access-token-abc123" },
    ]),
    WHATSAPP_GRAPH_API_VERSION: "v25.0",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkReadiness: happy path", () => {
  it("a fully valid env is ready", () => {
    expect(checkReadiness(validEnv())).toEqual({ status: "ready" });
  });

  it("a loopback http Supabase URL is accepted for local validation", () => {
    expect(checkReadiness({ ...validEnv(), SUPABASE_URL: "http://127.0.0.1:54321" })).toEqual({ status: "ready" });
    expect(checkReadiness({ ...validEnv(), SUPABASE_URL: "http://localhost:54321" })).toEqual({ status: "ready" });
  });

  it("rejects a valid IANA zone that violates the product timezone boundary", () => {
    expect(checkReadiness({ ...validEnv(), APP_TIMEZONE: "UTC" })).toEqual({ status: "unavailable" });
  });
});

describe("checkReadiness: closed-format fields", () => {
  it.each([
    { label: "unknown IANA zone", value: "Not/AZone" },
    { label: "not a zone at all", value: "banana" },
    { label: "empty", value: "" },
  ])("APP_TIMEZONE $label -> unavailable", ({ value }) => {
    expect(checkReadiness({ ...validEnv(), APP_TIMEZONE: value })).toEqual({ status: "unavailable" });
  });

  it.each([
    { label: "missing v prefix", value: "25.0" },
    { label: "missing .0 suffix", value: "v25" },
    { label: "non-.0 minor", value: "v25.1" },
    { label: "trailing garbage", value: "v25.0beta" },
    { label: "empty", value: "" },
  ])("WHATSAPP_GRAPH_API_VERSION $label -> unavailable", ({ value }) => {
    expect(checkReadiness({ ...validEnv(), WHATSAPP_GRAPH_API_VERSION: value })).toEqual({ status: "unavailable" });
  });

  it.each([
    { label: "http, not https, not loopback", value: "http://example.supabase.co" },
    { label: "not a URL", value: "not-a-url" },
    { label: "embedded credentials", value: "https://user:pass@example.supabase.co" },
    { label: "non-root path", value: "https://example.supabase.co/rest/v1" },
    { label: "query string", value: "https://example.supabase.co?x=1" },
    { label: "fragment", value: "https://example.supabase.co#frag" },
    { label: "empty", value: "" },
  ])("SUPABASE_URL $label -> unavailable", ({ value }) => {
    expect(checkReadiness({ ...validEnv(), SUPABASE_URL: value })).toEqual({ status: "unavailable" });
  });
});

describe("checkReadiness: presence/placeholder/whitespace", () => {
  const plainStringFields = [
    "WHATSAPP_VERIFY_TOKEN",
    "WHATSAPP_APP_SECRET",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_ANON_KEY",
    "OPENAI_API_KEY",
  ] as const;

  it.each(plainStringFields)("%s missing (empty) -> unavailable", (field) => {
    expect(checkReadiness({ ...validEnv(), [field]: "" })).toEqual({ status: "unavailable" });
  });

  it.each(plainStringFields)("%s padded with whitespace -> unavailable", (field) => {
    expect(checkReadiness({ ...validEnv(), [field]: "  padded-value  " })).toEqual({ status: "unavailable" });
  });

  it.each([
    "CHANGE_ME",
    "changeme",
    "replace_me",
    "your_key_here",
    "<insert-secret>",
    "placeholder",
    "TODO",
    "xxxxxxxx",
    "not_set",
    "unset",
    "[openai-api-key]",
  ])("a placeholder-looking value (%s) -> unavailable", (placeholder) => {
    expect(checkReadiness({ ...validEnv(), OPENAI_API_KEY: placeholder })).toEqual({ status: "unavailable" });
  });
});

describe("checkReadiness: WHATSAPP_ACCOUNT_CREDENTIALS_JSON", () => {
  // Full registry validation is exhaustively covered by whatsappCredentials.test.ts;
  // this only proves checkReadiness delegates to it and fails closed.
  it.each([
    { label: "empty", value: "" },
    { label: "whitespace", value: "   " },
    { label: "not JSON", value: "not-json" },
    { label: "empty array", value: "[]" },
  ])("$label -> unavailable", ({ value }) => {
    expect(checkReadiness({ ...validEnv(), WHATSAPP_ACCOUNT_CREDENTIALS_JSON: value })).toEqual({ status: "unavailable" });
  });
});

describe("checkReadiness: INTAKE_QUEUE binding", () => {
  it.each([
    { label: "undefined", queue: undefined },
    { label: "null", queue: null },
    { label: "not an object", queue: "not-a-queue" },
    { label: "missing send", queue: {} },
    { label: "send is not callable", queue: { send: "not-a-function" } },
  ])("$label -> unavailable", ({ queue }) => {
    expect(checkReadiness({ ...validEnv(), INTAKE_QUEUE: queue as unknown as Queue<IntakeQueueMessage> })).toEqual({ status: "unavailable" });
  });

  it("a Proxy that throws on property access -> unavailable, never throws", () => {
    const trapped = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
      },
    );
    expect(() => checkReadiness({ ...validEnv(), INTAKE_QUEUE: trapped as unknown as Queue<IntakeQueueMessage> })).not.toThrow();
    expect(checkReadiness({ ...validEnv(), INTAKE_QUEUE: trapped as unknown as Queue<IntakeQueueMessage> })).toEqual({ status: "unavailable" });
  });
});

describe("checkReadiness: no leakage, fresh objects, no external calls", () => {
  it("never logs, whether ready or unavailable", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    checkReadiness(validEnv());
    checkReadiness({ ...validEnv(), SUPABASE_URL: "" });

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("never calls fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    checkReadiness(validEnv());

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("returns a fresh object each call, so mutating one result cannot affect another", () => {
    const first = checkReadiness(validEnv());
    const second = checkReadiness(validEnv());

    expect(first).not.toBe(second);
    (first as { status: string }).status = "tampered";
    expect(checkReadiness(validEnv())).toEqual({ status: "ready" });
  });

  it("only ever returns the two closed shapes", () => {
    const ready = checkReadiness(validEnv());
    const unavailable = checkReadiness({ ...validEnv(), OPENAI_API_KEY: "" });

    expect(Object.keys(ready)).toEqual(["status"]);
    expect(Object.keys(unavailable)).toEqual(["status"]);
    expect(ready.status).toBe("ready");
    expect(unavailable.status).toBe("unavailable");
  });
});
