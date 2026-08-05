import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { MAX_BODY_BYTES } from "../src/webhookSignature";
import { signHmacSha256 } from "./signHelper";

const APP_SECRET = "test-app-secret";

const env: Env = {
  APP_TIMEZONE: "Europe/Istanbul",
  WHATSAPP_VERIFY_TOKEN: "secret-token",
  WHATSAPP_APP_SECRET: APP_SECRET,
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "unused",
};

async function signedPost(body: string, extraHeaders: Record<string, string> = {}): Promise<Request> {
  const signature = await signHmacSha256(APP_SECRET, body);
  return new Request("https://vetai.test/webhooks/whatsapp", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      ...extraHeaders,
    },
  });
}

describe("worker fetch routing", () => {
  it("GET /health returns 200 with status ok", async () => {
    const res = await worker.fetch(new Request("https://vetai.test/health"), env);
    expect(res.status).toBe(200);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe("ok");
  });

  it("GET /webhooks/whatsapp with valid token returns the challenge as plain text", async () => {
    const url = "https://vetai.test/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=secret-token&hub.challenge=abc123";
    const res = await worker.fetch(new Request(url), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123");
  });

  it("GET /webhooks/whatsapp with invalid token does not return the challenge", async () => {
    const url = "https://vetai.test/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123";
    const res = await worker.fetch(new Request(url), env);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toBe("abc123");
  });

  it("POST /webhooks/whatsapp accepts a validly signed JSON body", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const res = await worker.fetch(await signedPost(body), env);
    expect(res.status).toBe(200);
  });

  it("POST /webhooks/whatsapp rejects a validly signed but malformed JSON body with 400", async () => {
    const res = await worker.fetch(await signedPost("{not-json"), env);
    expect(res.status).toBe(400);
  });

  it.each([
    ["a JSON array", []],
    ["an unsupported object", { object: "not_whatsapp", entry: [] }],
  ])("POST /webhooks/whatsapp rejects %s with 400 once signed", async (_label, payload) => {
    const body = JSON.stringify(payload);
    const res = await worker.fetch(await signedPost(body), env);
    expect(res.status).toBe(400);
  });

  it("POST /webhooks/whatsapp rejects a missing signature with 401 and never parses the body", async () => {
    const req = new Request("https://vetai.test/webhooks/whatsapp", {
      method: "POST",
      body: JSON.stringify({ object: "whatsapp_business_account", entry: [] }),
      headers: { "content-type": "application/json" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("POST /webhooks/whatsapp rejects a wrong signature with 401", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const wrongSignature = await signHmacSha256("wrong-secret", body);
    const req = new Request("https://vetai.test/webhooks/whatsapp", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "x-hub-signature-256": wrongSignature },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it.each([
    ["malformed hex", `sha256=${"zz".repeat(32)}`],
    ["wrong-length digest", `sha256=${"ab".repeat(31)}`],
    ["missing sha256= prefix", "ab".repeat(32)],
  ])("POST /webhooks/whatsapp rejects a %s signature header with 401", async (_label, signatureHeader) => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const req = new Request("https://vetai.test/webhooks/whatsapp", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "x-hub-signature-256": signatureHeader },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("POST /webhooks/whatsapp rejects a non-JSON Content-Type with 415", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const res = await worker.fetch(await signedPost(body, { "content-type": "text/plain" }), env);
    expect(res.status).toBe(415);
  });

  it("POST /webhooks/whatsapp rejects a JSON-prefixed invalid Content-Type with 415", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const res = await worker.fetch(await signedPost(body, { "content-type": "application/json-evil" }), env);
    expect(res.status).toBe(415);
  });

  it("POST /webhooks/whatsapp rejects a body over 256 KiB with 413", async () => {
    const oversized = JSON.stringify({ object: "whatsapp_business_account", entry: [], pad: "a".repeat(MAX_BODY_BYTES) });
    const req = new Request("https://vetai.test/webhooks/whatsapp", {
      method: "POST",
      body: oversized,
      headers: { "content-type": "application/json" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(413);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await worker.fetch(new Request("https://vetai.test/nope"), env);
    expect(res.status).toBe(404);
  });
});
