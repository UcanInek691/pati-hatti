import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/liveAiDemo";

const ENV = { OPENAI_API_KEY: "test-openai-key" };
const NO_KEY_ENV = { OPENAI_API_KEY: undefined };

const VALID_EXTRACTION = {
  intent: "report_symptom",
  pet_name: null,
  species: null,
  complaint: "kusuyor",
  symptoms: ["kusma"],
  reported_safety_signals: {
    breathing_difficulty: false,
    loss_of_consciousness: false,
    active_seizure: false,
    heavy_bleeding: false,
    major_trauma: false,
    possible_toxin_exposure: false,
    possible_foreign_object: false,
    unable_to_urinate: false,
  },
  missing_information: [],
  user_requested_human: false,
};

function completedResponse(outputTextJson: string): unknown {
  return {
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: outputTextJson }] }],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SECURITY_HEADER_EXPECTATIONS: Array<[string, string]> = [
  ["Cache-Control", "no-store"],
  [
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  ],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
];

function expectSecurityHeaders(res: Response): void {
  for (const [name, value] of SECURITY_HEADER_EXPECTATIONS) {
    expect(res.headers.get(name)).toBe(value);
  }
}

function get(pathname: string): Promise<Response> {
  return worker.fetch(new Request(`https://live.local${pathname}`), ENV);
}

function postMessage(body: unknown, extraHeaders: Record<string, string> = {}, env: unknown = ENV): Promise<Response> {
  return worker.fetch(
    new Request("https://live.local/api/message", {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    }),
    env as any,
  );
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("routing and headers", () => {
  it("GET / returns 200 HTML with security headers and CSP", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expectSecurityHeaders(res);
  });

  it("non-GET / returns 405 with Allow: GET", async () => {
    const res = await worker.fetch(new Request("https://live.local/", { method: "POST" }), ENV);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    expectSecurityHeaders(res);
  });

  it("GET /app.js returns 200 JS with security headers", async () => {
    const res = await get("/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expectSecurityHeaders(res);
  });

  it("non-POST /api/message returns 405 with Allow: POST", async () => {
    const res = await get("/api/message");
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("unknown paths return 404 with security headers", async () => {
    const res = await get("/does-not-exist");
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
  });
});

describe("required Turkish disclosures", () => {
  let html = "";

  beforeEach(async () => {
    html = await (await get("/")).text();
  });

  it("states that entered text really goes to OpenAI", () => {
    expect(html).toMatch(/gerçekten OpenAI/);
  });

  it("warns against entering real person/clinic/phone/pet/patient data", () => {
    expect(html).toMatch(/[Gg]erçek bir kişi, klinik, telefon numarası.*hayvan bilgisi girmeyin/);
  });

  it("states it never sends WhatsApp, notifies staff, mutates a database, or books an appointment", () => {
    expect(html).toMatch(/WhatsApp mesajı göndermez/);
    expect(html).toMatch(/personeli bilgilendirmez/);
    expect(html).toMatch(/veritabanını değiştirmez/);
    expect(html).toMatch(/randevu oluşturmaz/);
  });

  it("states that refresh/reset clears the local session", () => {
    expect(html).toMatch(/sıfırlamak.*yerel oturumu tamamen temizler/);
  });

  it("labels the current-turn-only model limitation", () => {
    expect(html).toMatch(/yalnızca o anki mesajı görür/);
  });

  it("documents the browser call cap without presenting it as a billing limit", () => {
    expect(html).toMatch(/20 canlı çağrı/);
    expect(html).toMatch(/bir faturalandırma limiti değildir/);
    expect(html).toMatch(/OpenAI panelinden izleyin/);
  });

  it("offers only the reviewed Luna/Terra models in a fixed select", () => {
    expect(html).toContain('<option value="gpt-5.6-luna">');
    expect(html).toContain('<option value="gpt-5.6-terra">');
  });

  it("matches the browser message limit to the server's 2000-code-point ceiling", () => {
    expect(html).toContain('<textarea id="message-input" maxlength="2000">');
  });
});

describe("app.js safety properties", () => {
  let js = "";

  beforeEach(async () => {
    js = await (await get("/app.js")).text();
  });

  it("never uses a dynamic HTML sink, eval, or the Function constructor", () => {
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(js).not.toMatch(/\beval\s*\(/);
    expect(js).not.toMatch(/new\s+Function\s*\(/);
  });

  it("never calls console", () => {
    expect(js).not.toMatch(/console\./);
  });

  it("renders remote/dynamic result data only through textContent", () => {
    expect(js).toContain("label.textContent =");
    expect(js).toContain("value.textContent = valueText;");
    expect(js).toContain("userText.textContent = userMessage;");
  });

  it("disables sending once the call cap is reached", () => {
    expect(js).toContain("sendButton.disabled = true");
    expect(js).toContain("MAX_CALLS");
  });
});

describe("POST /api/message request validation fails closed with no provider call", () => {
  it("rejects a non-JSON content type", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const res = await postMessage({ message: "merhaba", model: "gpt-5.6-luna", state: null }, { "content-type": "text/plain" });
    expect(res.status).toBe(400);
    expectSecurityHeaders(res);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unparsable JSON", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const res = await worker.fetch(
      new Request("https://live.local/api/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      ENV,
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-object body", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const res = await postMessage(["merhaba"]);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects extra or missing top-level fields", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const missingState = await worker.fetch(
      new Request("https://live.local/api/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "merhaba", model: "gpt-5.6-luna" }),
      }),
      ENV,
    );
    expect(missingState.status).toBe(400);

    const res = await postMessage({ message: "merhaba", model: "gpt-5.6-luna", state: null, extra: true });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty message", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const res = await postMessage({ message: "", model: "gpt-5.6-luna", state: null });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a message over 2000 Unicode code points", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const oversized = "a".repeat(2001);
    const res = await postMessage({ message: oversized, model: "gpt-5.6-luna", state: null });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a body over the byte limit before parsing", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const res = await worker.fetch(
      new Request("https://live.local/api/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "a".repeat(20 * 1024),
      }),
      ENV,
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid UTF-8 byte sequences", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const res = await worker.fetch(
      new Request("https://live.local/api/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new Uint8Array([0xc0, 0xc1, 0xff]),
      }),
      ENV,
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a model outside the closed Luna/Terra set", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const res = await postMessage({ message: "merhaba", model: "gpt-4o", state: null });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed state object", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const res = await postMessage({
      message: "merhaba",
      model: "gpt-5.6-luna",
      state: { intakeStage: "not_a_real_stage", intakeData: {}, petId: null, callCount: 0 },
    });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "malformed persisted intake data",
      state: { intakeStage: "pet_identification", intakeData: { schema_version: 1 }, petId: null, callCount: 0 },
    },
    {
      label: "a pet identifier outside the fixed synthetic context",
      state: { intakeStage: "pet_identification", intakeData: {}, petId: "foreign-pet", callCount: 0 },
    },
  ])("rejects $label before spending an API call", async ({ state }) => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const res = await postMessage({ message: "merhaba", model: "gpt-5.6-luna", state });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a state already at the 20-call cap", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const res = await postMessage({
      message: "merhaba",
      model: "gpt-5.6-luna",
      state: { intakeStage: "pet_identification", intakeData: {}, petId: null, callCount: 20 },
    });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/message success path uses the real adapter with mocked fetch and reused planners", () => {
  it("first turn: calls the OpenAI adapter with the selected model and returns a planned reply with callCount 1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completedResponse(JSON.stringify(VALID_EXTRACTION))));
    globalThis.fetch = fetchMock;

    const res = await postMessage({ message: "kedim kusuyor", model: "gpt-5.6-terra", state: null });
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.model).toBe("gpt-5.6-terra");
    expect(sentBody.input[1]).toEqual({ role: "user", content: "kedim kusuyor" });

    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.model).toBe("gpt-5.6-terra");
    expect(data.extraction).toEqual(VALID_EXTRACTION);
    expect(data.plan.kind).toBe("planned");
    expect(data.plan.petResolution.kind).toBe("matched");
    expect(data.plan.nextStage).toBe("complaint_collection");
    expect(data.appointmentAction).toEqual({ kind: "none" });
    expect(data.reply).toEqual({ kind: "send", category: "intake_received", text: expect.any(String) });
    expect(data.state.callCount).toBe(1);
    expect(data.state.intakeStage).toBe("complaint_collection");
    expect(typeof data.elapsedMs).toBe("number");
  });

  it("second turn: carries the returned state forward and increments callCount to 2", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(completedResponse(JSON.stringify(VALID_EXTRACTION))));
    globalThis.fetch = fetchMock;

    const first = await (await postMessage({ message: "kedim kusuyor", model: "gpt-5.6-luna", state: null })).json();
    const second = await postMessage({ message: "iki gündür böyle", model: "gpt-5.6-luna", state: (first as any).state });
    expect(second.status).toBe(200);
    const data = (await second.json()) as any;
    expect(data.state.callCount).toBe(2);
    // Task 036 inserted intake_confirmation between complaint_collection and
    // safety_check, so the second turn now lands there.
    expect(data.plan.nextStage).toBe("intake_confirmation");
  });

  it("parses usage totals when the provider reports them", async () => {
    const payload = completedResponse(JSON.stringify(VALID_EXTRACTION)) as Record<string, unknown>;
    payload.usage = { input_tokens: 50, output_tokens: 20, total_tokens: 70 };
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(payload));

    const res = await postMessage({ message: "kedim kusuyor", model: "gpt-5.6-luna", state: null });
    const data = (await res.json()) as any;
    expect(data.usage).toEqual({ inputTokens: 50, outputTokens: 20, totalTokens: 70 });
  });
});

describe("POST /api/message provider failure fails closed without leaking cause", () => {
  it("returns ok:false with an incremented callCount on a network error, never a 5xx echo", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const res = await postMessage({ message: "merhaba", model: "gpt-5.6-luna", state: null });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(false);
    expect(data.model).toBe("gpt-5.6-luna");
    expect(data.state.callCount).toBe(1);
  });

  it("fails closed without calling fetch when no API key is configured", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const res = await postMessage({ message: "merhaba", model: "gpt-5.6-luna", state: null }, {}, NO_KEY_ENV);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("local isolation from production runtime", () => {
  const repoRoot = path.resolve(__dirname, "..");
  const liveAiDemoSource = readFileSync(path.join(repoRoot, "src", "liveAiDemo.ts"), "utf8");
  const indexSource = readFileSync(path.join(repoRoot, "src", "index.ts"), "utf8");

  it("src/index.ts never imports the live AI demo entry", () => {
    expect(indexSource).not.toMatch(/liveAiDemo/);
  });

  it("src/liveAiDemo.ts imports only the OpenAI adapter and pure planners, never env, the production entry, or Supabase/WhatsApp/staff/outbox modules", () => {
    expect(liveAiDemoSource).toMatch(/from ["']\.\/openaiIntake["']/);
    expect(liveAiDemoSource).not.toMatch(/from ["']\.\/index["']/);
    expect(liveAiDemoSource).not.toMatch(/from ["']\.\/env["']/);
    expect(liveAiDemoSource).not.toMatch(
      /from ["']\.\/(supabaseIngest|whatsappSend|whatsappStatus|outboundSender|appointmentEngine|staffPage|intakeConsumer|intakeQueue|intakeJobLease)["']/,
    );
    expect(liveAiDemoSource).not.toMatch(/getConversationIntakeContext|advanceConversationIntake/);
    expect(liveAiDemoSource).not.toMatch(
      /finalizeAppointmentOfferQueueJob|finalizeAppointmentDecisionQueueJob/,
    );
  });

  it("src/liveAiDemo.ts never calls console and never fetches a hardcoded non-OpenAI URL", () => {
    expect(liveAiDemoSource).not.toMatch(/console\./);
    expect(liveAiDemoSource).not.toMatch(/fetch\(\s*["']https?:\/\/(?!api\.openai\.com)/);
  });

  it("wrangler.live-ai.toml declares no production binding, queue, cron, or database/WhatsApp secret", () => {
    const toml = readFileSync(path.join(repoRoot, "wrangler.live-ai.toml"), "utf8");
    expect(toml).toContain('main = "src/liveAiDemo.ts"');
    expect(toml).not.toMatch(/\[\[queues/);
    expect(toml).not.toMatch(/\[triggers\]/);
    expect(toml).not.toMatch(/SUPABASE|WHATSAPP|binding/);
  });
});
