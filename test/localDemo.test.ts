import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/localDemo";

const BANNER_TEXT = "Yerel simülasyon — gerçek WhatsApp, yapay zekâ ve veritabanı kullanılmaz.";

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

function get(path: string): Promise<Response> {
  return worker.fetch(new Request(`https://demo.local${path}`));
}

async function postScenario(scenarioId: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(
    new Request("https://demo.local/api/scenario", {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify({ scenarioId }),
    }),
  );
}

describe("routing and headers", () => {
  let html = "";
  let js = "";

  beforeAll(async () => {
    html = await (await get("/")).text();
    js = await (await get("/app.js")).text();
  });

  it("GET / returns 200 HTML with security headers and CSP", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expectSecurityHeaders(res);
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
  });

  it("GET / includes the exact Turkish disclaimer banner", () => {
    expect(html).toContain(BANNER_TEXT);
  });

  it("HTML has no inline script and no inline event handlers", () => {
    const scriptTags = html.match(/<script[^>]*>/g) ?? [];
    expect(scriptTags).toEqual(['<script src="/app.js">']);
    expect(html).not.toMatch(/\son\w+\s*=/i);
  });

  it("non-GET / returns 405 with Allow: GET", async () => {
    const res = await worker.fetch(new Request("https://demo.local/", { method: "POST" }));
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

  it("app.js never uses a dynamic HTML sink, eval, or the Function constructor", () => {
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(js).not.toMatch(/\beval\s*\(/);
    expect(js).not.toMatch(/new\s+Function\s*\(/);
  });

  it("app.js never calls console", () => {
    expect(js).not.toMatch(/console\./);
  });

  it("app.js renders all remote/dynamic result data only through textContent", () => {
    expect(js).toContain("label.textContent =");
    expect(js).toContain("value.textContent = valueText;");
    expect(js).toContain("title.textContent = data.scenarioLabel;");
  });

  it("GET /api/scenarios returns exactly the ten required scenario ids and Turkish labels", async () => {
    const res = await get("/api/scenarios");
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    const items = (await res.json()) as Array<{ id: string; label: string }>;
    expect(items).toHaveLength(10);
    expect(items.map((item) => item.id)).toEqual([
      "bilinen-hayvan-sikayet",
      "hayvan-kimlik-belirsiz",
      "guvenlik-bilinmiyor",
      "acil-sinyal",
      "insan-talebi",
      "tibbi-tavsiye-talebi",
      "randevu-teklifi",
      "randevu-evet",
      "randevu-hayir",
      "randevu-tanimsiz",
    ]);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(["id", "label"]);
    }
  });

  it("non-GET /api/scenarios returns 405 with Allow: GET", async () => {
    const res = await worker.fetch(new Request("https://demo.local/api/scenarios", { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });

  it("non-POST /api/scenario returns 405 with Allow: POST", async () => {
    const res = await get("/api/scenario");
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("unknown paths return 404 with security headers", async () => {
    const res = await get("/does-not-exist");
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
  });
});

describe("malformed and unknown scenario requests fail closed with no echo", () => {
  it("rejects a non-JSON content type", async () => {
    const res = await postScenario("bilinen-hayvan-sikayet", { "content-type": "text/plain" });
    expect(res.status).toBe(400);
    expectSecurityHeaders(res);
  });

  it("rejects unparsable JSON", async () => {
    const res = await worker.fetch(
      new Request("https://demo.local/api/scenario", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-object body", async () => {
    const res = await worker.fetch(
      new Request("https://demo.local/api/scenario", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(["bilinen-hayvan-sikayet"]),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects extra request fields instead of silently ignoring them", async () => {
    const res = await worker.fetch(
      new Request("https://demo.local/api/scenario", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenarioId: "bilinen-hayvan-sikayet", extra: true }),
      }),
    );
    expect(res.status).toBe(400);
    expectSecurityHeaders(res);
  });

  it("rejects a non-string scenarioId and never echoes it", async () => {
    const res = await postScenario(12345);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain("12345");
  });

  it("returns 404 for an unknown scenario id and never echoes it", async () => {
    const secretLookingId = "<script>alert(1)</script>";
    const res = await postScenario(secretLookingId);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain(secretLookingId);
  });
});

describe("all required scenario outcomes are computed by the reviewed pure planners", () => {
  it("1) known pet + ordinary complaint resolves the pet and reaches an intake_received reply", async () => {
    const res = await postScenario("bilinen-hayvan-sikayet");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.plan.kind).toBe("planned");
    expect(data.plan.petResolution.kind).toBe("matched");
    expect(data.plan.safetyDecision.kind).toBe("continue_intake");
    expect(data.plan.nextStage).toBe("complaint_collection");
    expect(data.appointmentAction).toEqual({ kind: "none" });
    expect(data.reply).toEqual({ kind: "send", category: "intake_received", text: expect.any(String) });
  });

  it("2) pet identity clarification is requested with two candidate pets", async () => {
    const res = await postScenario("hayvan-kimlik-belirsiz");
    const data = (await res.json()) as any;
    expect(data.plan.kind).toBe("planned");
    expect(data.plan.petResolution.kind).toBe("needs_clarification");
    expect(data.plan.nextStage).toBe("pet_identification");
    expect(data.reply).toEqual({ kind: "send", category: "pet_identity", text: expect.any(String) });
  });

  it("3) unknown safety facts trigger all eight safety questions", async () => {
    const res = await postScenario("guvenlik-bilinmiyor");
    const data = (await res.json()) as any;
    expect(data.plan.kind).toBe("planned");
    expect(data.plan.safetyDecision.kind).toBe("needs_safety_check");
    expect(data.plan.safetyDecision.unknownSignals).toHaveLength(8);
    expect(data.reply.category).toBe("safety_questions");
  });

  it("4) an explicit emergency signal produces emergency_handoff and terminal human_handoff stage", async () => {
    const res = await postScenario("acil-sinyal");
    const data = (await res.json()) as any;
    expect(data.plan.safetyDecision).toEqual({ kind: "emergency_handoff", positiveSignals: ["breathing_difficulty"] });
    expect(data.plan.nextStage).toBe("human_handoff");
    expect(data.reply).toEqual({ kind: "send", category: "emergency_handoff", text: expect.any(String) });
  });

  it("5) an explicit human request produces human_handoff with reason user_requested_human", async () => {
    const res = await postScenario("insan-talebi");
    const data = (await res.json()) as any;
    expect(data.plan.safetyDecision).toEqual({ kind: "human_handoff", reason: "user_requested_human" });
    expect(data.plan.nextStage).toBe("human_handoff");
    expect(data.reply.category).toBe("human_handoff");
  });

  it("6) a medical-advice request produces human_handoff with reason medical_advice_request", async () => {
    const res = await postScenario("tibbi-tavsiye-talebi");
    const data = (await res.json()) as any;
    expect(data.plan.safetyDecision).toEqual({ kind: "human_handoff", reason: "medical_advice_request" });
    expect(data.reply.category).toBe("human_handoff");
  });

  it("7) an appointment request reaching ready_for_triage offers a slot and plans no reply text", async () => {
    const res = await postScenario("randevu-teklifi");
    const data = (await res.json()) as any;
    expect(data.plan.safetyDecision.kind).toBe("continue_intake");
    expect(data.plan.nextStage).toBe("ready_for_triage");
    expect(data.appointmentAction).toEqual({ kind: "offer" });
    expect(data.reply).toBeNull();
  });

  it("8) exact EVET confirms the appointment decision and plans no reply text", async () => {
    const res = await postScenario("randevu-evet");
    const data = (await res.json()) as any;
    expect(data.appointmentAction).toEqual({ kind: "decision", decision: "confirm" });
    expect(data.reply).toBeNull();
  });

  it("9) exact HAYIR declines the appointment decision and plans no reply text", async () => {
    const res = await postScenario("randevu-hayir");
    const data = (await res.json()) as any;
    expect(data.appointmentAction).toEqual({ kind: "decision", decision: "decline" });
    expect(data.reply).toBeNull();
  });

  it("10) an unrecognized reply repeats the appointment decision and plans no reply text", async () => {
    const res = await postScenario("randevu-tanimsiz");
    const data = (await res.json()) as any;
    expect(data.appointmentAction).toEqual({ kind: "decision", decision: "repeat" });
    expect(data.reply).toBeNull();
  });

  it("every scenario's synthetic identifiers are obviously fake, not real WhatsApp/clinic data", async () => {
    const res = await get("/api/scenarios");
    const items = (await res.json()) as Array<{ id: string }>;
    for (const item of items) {
      const scenarioRes = await postScenario(item.id);
      const data = (await scenarioRes.json()) as any;
      expect(data.messageText).not.toMatch(/\+?\d{10,}/);
    }
  });
});

describe("deterministic reruns", () => {
  it("rerunning the same scenario id twice returns byte-identical JSON", async () => {
    for (const id of ["acil-sinyal", "randevu-teklifi", "randevu-evet"]) {
      const first = await (await postScenario(id)).text();
      const second = await (await postScenario(id)).text();
      expect(second).toBe(first);
    }
  });
});

describe("local isolation from production runtime", () => {
  const repoRoot = path.resolve(__dirname, "..");
  const localDemoSource = readFileSync(path.join(repoRoot, "src", "localDemo.ts"), "utf8");
  const indexSource = readFileSync(path.join(repoRoot, "src", "index.ts"), "utf8");

  it("src/index.ts never imports the local demo entry", () => {
    expect(indexSource).not.toMatch(/localDemo/);
  });

  it("src/localDemo.ts never imports the production entry, env, or Supabase/OpenAI/Meta/Queue clients", () => {
    expect(localDemoSource).not.toMatch(/from ["']\.\/index["']/);
    expect(localDemoSource).not.toMatch(/from ["']\.\/env["']/);
    expect(localDemoSource).not.toMatch(/from ["']\.\/(supabaseIngest|openaiIntake|whatsappSend|outboundSender|appointmentEngine)["']/);
  });

  it("src/localDemo.ts performs no outbound fetch and no console logging outside the embedded same-origin client script", () => {
    const serverOnlySource = localDemoSource.replace(/`[\s\S]*?`/g, "").replace("async fetch(", "");
    expect(serverOnlySource).not.toMatch(/\bfetch\s*\(/);
    expect(localDemoSource).not.toMatch(/console\./);
    expect(localDemoSource).not.toMatch(/fetch\(\s*["']https?:/);
  });

  it("wrangler.demo.toml declares no bindings, queues, crons, or vars", () => {
    const demoToml = readFileSync(path.join(repoRoot, "wrangler.demo.toml"), "utf8");
    expect(demoToml).toContain('main = "src/localDemo.ts"');
    expect(demoToml).not.toMatch(/\[vars\]/);
    expect(demoToml).not.toMatch(/\[\[queues/);
    expect(demoToml).not.toMatch(/\[triggers\]/);
    expect(demoToml).not.toMatch(/binding/);
  });

});
