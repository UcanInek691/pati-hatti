import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { IntakeQueueMessage } from "../src/intakeQueue";
import type { ReadinessResult } from "../src/readiness";

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

function rpcResponse(result: string, status = 200): Response {
  return new Response(JSON.stringify([{ result }]), { status, headers: { "content-type": "application/json" } });
}

// Each test loads its own module instance so the cache/in-flight state added
// by Task 050 never leaks between tests.
async function loadCheckReadiness(): Promise<(env: Env) => Promise<ReadinessResult>> {
  vi.resetModules();
  const mod = await import("../src/readiness");
  return mod.checkReadiness;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("checkReadiness: configuration shape (never reaches the dependency probe)", () => {
  it("never calls fetch when APP_TIMEZONE is wrong", async () => {
    const checkReadiness = await loadCheckReadiness();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkReadiness({ ...validEnv(), APP_TIMEZONE: "UTC" })).resolves.toEqual({ status: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "unknown IANA zone", value: "Not/AZone" },
    { label: "not a zone at all", value: "banana" },
    { label: "empty", value: "" },
  ])("APP_TIMEZONE $label -> unavailable", async ({ value }) => {
    const checkReadiness = await loadCheckReadiness();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkReadiness({ ...validEnv(), APP_TIMEZONE: value })).resolves.toEqual({ status: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing v prefix", value: "25.0" },
    { label: "missing .0 suffix", value: "v25" },
    { label: "non-.0 minor", value: "v25.1" },
    { label: "trailing garbage", value: "v25.0beta" },
    { label: "empty", value: "" },
  ])("WHATSAPP_GRAPH_API_VERSION $label -> unavailable", async ({ value }) => {
    const checkReadiness = await loadCheckReadiness();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkReadiness({ ...validEnv(), WHATSAPP_GRAPH_API_VERSION: value })).resolves.toEqual({ status: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "http, not https, not loopback", value: "http://example.supabase.co" },
    { label: "not a URL", value: "not-a-url" },
    { label: "embedded credentials", value: "https://user:pass@example.supabase.co" },
    { label: "non-root path", value: "https://example.supabase.co/rest/v1" },
    { label: "query string", value: "https://example.supabase.co?x=1" },
    { label: "fragment", value: "https://example.supabase.co#frag" },
    { label: "empty", value: "" },
  ])("SUPABASE_URL $label -> unavailable", async ({ value }) => {
    const checkReadiness = await loadCheckReadiness();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkReadiness({ ...validEnv(), SUPABASE_URL: value })).resolves.toEqual({ status: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const plainStringFields = [
    "WHATSAPP_VERIFY_TOKEN",
    "WHATSAPP_APP_SECRET",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_ANON_KEY",
    "OPENAI_API_KEY",
  ] as const;

  it.each(plainStringFields)("%s missing (empty) -> unavailable", async (field) => {
    const checkReadiness = await loadCheckReadiness();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkReadiness({ ...validEnv(), [field]: "" })).resolves.toEqual({ status: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(plainStringFields)("%s padded with whitespace -> unavailable", async (field) => {
    const checkReadiness = await loadCheckReadiness();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkReadiness({ ...validEnv(), [field]: "  padded-value  " })).resolves.toEqual({ status: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
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
  ])("a placeholder-looking value (%s) -> unavailable", async (placeholder) => {
    const checkReadiness = await loadCheckReadiness();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkReadiness({ ...validEnv(), OPENAI_API_KEY: placeholder })).resolves.toEqual({ status: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "empty", value: "" },
    { label: "whitespace", value: "   " },
    { label: "not JSON", value: "not-json" },
    { label: "empty array", value: "[]" },
  ])("WHATSAPP_ACCOUNT_CREDENTIALS_JSON $label -> unavailable, no fetch", async ({ value }) => {
    // Full registry validation is exhaustively covered by whatsappCredentials.test.ts;
    // this only proves checkReadiness delegates to it and fails closed before probing.
    const checkReadiness = await loadCheckReadiness();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkReadiness({ ...validEnv(), WHATSAPP_ACCOUNT_CREDENTIALS_JSON: value })).resolves.toEqual({ status: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "undefined", queue: undefined },
    { label: "null", queue: null },
    { label: "not an object", queue: "not-a-queue" },
    { label: "missing send", queue: {} },
    { label: "send is not callable", queue: { send: "not-a-function" } },
  ])("INTAKE_QUEUE $label -> unavailable", async ({ queue }) => {
    const checkReadiness = await loadCheckReadiness();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      checkReadiness({ ...validEnv(), INTAKE_QUEUE: queue as unknown as Queue<IntakeQueueMessage> }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a Proxy that throws on property access -> unavailable, never throws", async () => {
    const checkReadiness = await loadCheckReadiness();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const trapped = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
      },
    );
    await expect(
      checkReadiness({ ...validEnv(), INTAKE_QUEUE: trapped as unknown as Queue<IntakeQueueMessage> }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("checkReadiness: dependency probe (route resolver)", () => {
  it.each(["http://127.0.0.1:54321", "http://localhost:54321"])("accepts the loopback Supabase URL %s", async (url) => {
    const checkReadiness = await loadCheckReadiness();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rpcResponse("ai")));
    await expect(checkReadiness({ ...validEnv(), SUPABASE_URL: url })).resolves.toEqual({ status: "ready" });
  });

  it.each(["ai", "manual", "personal"] as const)("maps a %s route resolver result to ready", async (result) => {
    const checkReadiness = await loadCheckReadiness();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rpcResponse(result)));
    await expect(checkReadiness(validEnv())).resolves.toEqual({ status: "ready" });
  });

  it("maps unknown_account to unavailable", async () => {
    const checkReadiness = await loadCheckReadiness();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rpcResponse("unknown_account")));
    await expect(checkReadiness(validEnv())).resolves.toEqual({ status: "unavailable" });
  });

  it("maps a non-2xx resolver response (the Task 049 405 failure mode) to unavailable", async () => {
    const checkReadiness = await loadCheckReadiness();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rpcResponse("ai", 405)));
    await expect(checkReadiness(validEnv())).resolves.toEqual({ status: "unavailable" });
  });

  it("maps a network failure to unavailable, never throws", async () => {
    const checkReadiness = await loadCheckReadiness();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(checkReadiness(validEnv())).resolves.toEqual({ status: "unavailable" });
  });

  it("maps an aborted dependency request to unavailable and keeps the existing 10-second bound", async () => {
    const checkReadiness = await loadCheckReadiness();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));

    await expect(checkReadiness(validEnv())).resolves.toEqual({ status: "unavailable" });
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it("maps a malformed resolver response to unavailable", async () => {
    const checkReadiness = await loadCheckReadiness();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ not: "an array" }), { status: 200, headers: { "content-type": "application/json" } })),
    );
    await expect(checkReadiness(validEnv())).resolves.toEqual({ status: "unavailable" });
  });

  it.each([
    ["zero rows", []],
    ["more than one row", [{ result: "ai" }, { result: "ai" }]],
    ["an extra response key", [{ result: "ai", extra: "x" }]],
    ["a missing result key", [{}]],
    ["an unknown result", [{ result: "invented" }]],
  ])("maps %s to unavailable", async (_label, body) => {
    const checkReadiness = await loadCheckReadiness();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })),
    );
    await expect(checkReadiness(validEnv())).resolves.toEqual({ status: "unavailable" });
  });

  it("probes with the synthetic sentinel contact and the registry's phone_number_id, never a real customer contact", async () => {
    const checkReadiness = await loadCheckReadiness();
    const fetchMock = vi.fn().mockResolvedValue(rpcResponse("ai"));
    vi.stubGlobal("fetch", fetchMock);

    await checkReadiness(validEnv());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.p_phone_number_id).toBe("918000001");
    expect(body.p_contact_e164).toBe("+10000000000");
  });

  it("calls only the route-resolver RPC over fetch; never touches the Queue", async () => {
    const checkReadiness = await loadCheckReadiness();
    const fetchMock = vi.fn().mockResolvedValue(rpcResponse("ai"));
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn();

    await checkReadiness({ ...validEnv(), INTAKE_QUEUE: { send: queueSend } as unknown as Queue<IntakeQueueMessage> });

    expect(queueSend).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toContain("/rest/v1/rpc/resolve_whatsapp_contact_automation");
  });

  it("never logs, whether ready or unavailable", async () => {
    const checkReadiness = await loadCheckReadiness();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rpcResponse("ai")));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await checkReadiness(validEnv());

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("checkReadiness: 30-second cache and in-flight coalescing", () => {
  it("caches a ready result for 30 seconds without calling fetch again", async () => {
    vi.useFakeTimers();
    const checkReadiness = await loadCheckReadiness();
    const fetchMock = vi.fn().mockResolvedValue(rpcResponse("ai"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkReadiness(validEnv())).resolves.toEqual({ status: "ready" });
    await vi.advanceTimersByTimeAsync(29_000);
    await expect(checkReadiness(validEnv())).resolves.toEqual({ status: "ready" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-probes once the 30-second cache expires", async () => {
    vi.useFakeTimers();
    const checkReadiness = await loadCheckReadiness();
    // A fresh Response per call: a Response body can only be read once, and
    // this test (unlike the others) expects fetch to be called for real twice.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(rpcResponse("ai")));
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkReadiness(validEnv())).resolves.toEqual({ status: "ready" });
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(checkReadiness(validEnv())).resolves.toEqual({ status: "ready" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("also caches an unavailable dependency result for 30 seconds", async () => {
    vi.useFakeTimers();
    const checkReadiness = await loadCheckReadiness();
    const fetchMock = vi.fn().mockResolvedValue(rpcResponse("unknown_account"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkReadiness(validEnv())).resolves.toEqual({ status: "unavailable" });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(checkReadiness(validEnv())).resolves.toEqual({ status: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an invalid current configuration is never masked by a cached ready result", async () => {
    const checkReadiness = await loadCheckReadiness();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rpcResponse("ai")));

    await expect(checkReadiness(validEnv())).resolves.toEqual({ status: "ready" });
    await expect(checkReadiness({ ...validEnv(), APP_TIMEZONE: "UTC" })).resolves.toEqual({ status: "unavailable" });
  });

  it("concurrent calls during a cache miss share exactly one in-flight probe", async () => {
    const checkReadiness = await loadCheckReadiness();
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = checkReadiness(validEnv());
    const second = checkReadiness(validEnv());
    resolveFetch(rpcResponse("ai"));

    await expect(Promise.all([first, second])).resolves.toEqual([{ status: "ready" }, { status: "ready" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a fresh object each call, so mutating one result cannot affect another", async () => {
    const checkReadiness = await loadCheckReadiness();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rpcResponse("ai")));

    const first = await checkReadiness(validEnv());
    const second = await checkReadiness(validEnv());
    expect(first).not.toBe(second);
    (first as { status: string }).status = "tampered";
    await expect(checkReadiness(validEnv())).resolves.toEqual({ status: "ready" });
  });
});
