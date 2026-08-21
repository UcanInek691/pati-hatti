import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import type { IntakeQueueMessage } from "../src/intakeQueue";
import { MAX_BODY_BYTES } from "../src/webhookSignature";
import { signHmacSha256 } from "./signHelper";
import * as intakeConsumer from "../src/intakeConsumer";
import * as intakeDeadLetter from "../src/intakeDeadLetter";
import * as outboundSender from "../src/outboundSender";

const APP_SECRET = "test-app-secret";
const CONVERSATION_ID = "5c1f2b9e-9d6a-4c3b-8f21-6f7a2c1d3e4b";

function stubQueue(send = vi.fn().mockResolvedValue(undefined)): Queue<IntakeQueueMessage> {
  return { send } as unknown as Queue<IntakeQueueMessage>;
}

const env: Env = {
  APP_TIMEZONE: "Europe/Istanbul",
  WHATSAPP_VERIFY_TOKEN: "secret-token",
  WHATSAPP_APP_SECRET: APP_SECRET,
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "unused",
  SUPABASE_ANON_KEY: "unused-anon-key",
  OPENAI_API_KEY: "unused",
  INTAKE_QUEUE: stubQueue(),
  WHATSAPP_ACCESS_TOKEN: "test-whatsapp-access-token",
  WHATSAPP_GRAPH_API_VERSION: "v25.0",
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

  it("GET /ready returns 200 with the exact ready body and security headers when config is valid", async () => {
    const res = await worker.fetch(new Request("https://vetai.test/ready"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("GET /ready returns 503 with the exact unavailable body and security headers when config is invalid", async () => {
    const brokenEnv: Env = { ...env, SUPABASE_URL: "" };
    const res = await worker.fetch(new Request("https://vetai.test/ready"), brokenEnv);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "unavailable" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("non-GET /ready returns 405 with Allow: GET and security headers", async () => {
    const res = await worker.fetch(new Request("https://vetai.test/ready", { method: "POST" }), env);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("/health is unaffected by /ready being added", async () => {
    const res = await worker.fetch(new Request("https://vetai.test/health"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).not.toBe("no-store");
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

describe("worker staff routes", () => {
  it.each(["https://vetai.test/staff", "https://vetai.test/staff/"])("GET %s returns the staff HTML shell", async (url) => {
    const res = await worker.fetch(new Request(url), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("GET /staff/app.js returns the staff browser script", async () => {
    const res = await worker.fetch(new Request("https://vetai.test/staff/app.js"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
  });

  it("GET /staff/config.json returns only the public Supabase config", async () => {
    const res = await worker.fetch(new Request("https://vetai.test/staff/config.json"), env);
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, string>>();
    expect(Object.keys(body).sort()).toEqual(["supabaseAnonKey", "supabaseUrl"]);
  });

  it("GET /staff returns 503 when Supabase configuration is missing", async () => {
    const noConfigEnv: Env = { ...env, SUPABASE_URL: "", SUPABASE_ANON_KEY: "" };
    const res = await worker.fetch(new Request("https://vetai.test/staff"), noConfigEnv);
    expect(res.status).toBe(503);
  });

  it.each(["/staff", "/staff/", "/staff/app.js", "/staff/config.json"])(
    "POST %s returns 405 with Allow: GET and staff security headers",
    async (path) => {
      const res = await worker.fetch(new Request(`https://vetai.test${path}`, { method: "POST" }), env);
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    },
  );

  it("GET /staff/unknown returns 404 with staff security headers", async () => {
    const res = await worker.fetch(new Request("https://vetai.test/staff/unknown"), env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});

function textMessageWebhookBody(): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "16505551111", phone_number_id: "123456123" },
              contacts: [{ profile: { name: "Kerry Fisher" }, wa_id: "16315551181" }],
              messages: [{ from: "16315551181", id: "wamid.ID1", timestamp: "1603059201", type: "text", text: { body: "Hello!" } }],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

function mediaMessageWebhookBody(type = "image", overrides: Record<string, unknown> = {}): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "16505551111", phone_number_id: "123456123" },
              contacts: [{ profile: { name: "Kerry Fisher" }, wa_id: "16315551181" }],
              messages: [
                {
                  from: "16315551181",
                  id: "wamid.ID1",
                  timestamp: "1603059201",
                  type,
                  [type]: { id: "MEDIA_ID", mime_type: "image/jpeg", sha256: "abc", caption: "kedi fotoğrafı" },
                  ...overrides,
                },
              ],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function statusOnlyWebhookBody(status: "sent" | "delivered" | "read" | "failed" = "delivered"): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "16505551111", phone_number_id: "123456123" },
              statuses: [{ id: "wamid.STATUS1", status, timestamp: "1603059201", recipient_id: "16315551181" }],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

function mixedWebhookBody(): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "16505551111", phone_number_id: "123456123" },
              contacts: [{ profile: { name: "Kerry Fisher" }, wa_id: "16315551181" }],
              messages: [{ from: "16315551181", id: "wamid.ID1", timestamp: "1603059201", type: "text", text: { body: "Hello!" } }],
              statuses: [{ id: "wamid.STATUS1", status: "delivered", timestamp: "1603059201", recipient_id: "16315551181" }],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

function routedFetch(byEndpoint: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const endpoints: Record<string, unknown> = { resolve_whatsapp_contact_automation: [{ result: "ai" }], ...byEndpoint };
  return vi.fn(async (url: URL) => {
    for (const [rpcName, body] of Object.entries(endpoints)) {
      if (url.toString().endsWith(`/rest/v1/rpc/${rpcName}`)) return jsonResponse(body);
    }
    return jsonResponse([]);
  });
}

describe("worker whatsapp persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 200 for a status-only webhook without requiring Supabase configuration", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const noConfigEnv: Env = { ...env, SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", INTAKE_QUEUE: stubQueue(queueSend) };
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "WABA_ID", changes: [{ value: { messaging_product: "whatsapp", metadata: { phone_number_id: "123456123" }, statuses: [] }, field: "messages" }] }],
    });

    const res = await worker.fetch(await signedPost(body), noConfigEnv);

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed status callback and performs no persistence or queue calls", async () => {
    const fetchMock = routedFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };
    const body = mixedWebhookBody() as {
      entry: Array<{ changes: Array<{ value: { statuses: Array<Record<string, unknown>> } }> }>;
    };
    const status = body.entry[0]?.changes[0]?.value.statuses[0];
    if (status) status.timestamp = "not-a-number";

    const res = await worker.fetch(await signedPost(JSON.stringify(body)), testEnv);

    expect(res.status).toBe(400);
    // Invalid status data is rejected before any route lookup or persistence.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("persists a valid status-only webhook via the status RPC, never touches inbound text or Queue, and returns 200", async () => {
    const fetchMock = routedFetch({ record_whatsapp_outbound_status: [{ result: "recorded" }] });
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(statusOnlyWebhookBody("delivered"))), testEnv);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/record_whatsapp_outbound_status");
    expect(queueSend).not.toHaveBeenCalled();
  });

  it.each(["not_found", "duplicate", "stale"] as const)(
    "returns 200 for a status-only webhook when the status RPC reports %s",
    async (result) => {
      vi.stubGlobal("fetch", routedFetch({ record_whatsapp_outbound_status: [{ result }] }));
      const res = await worker.fetch(await signedPost(JSON.stringify(statusOnlyWebhookBody())), env);
      expect(res.status).toBe(200);
    },
  );

  it("returns 503 for a status-only webhook when the status RPC call itself fails, without touching Queue", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(statusOnlyWebhookBody())), testEnv);

    expect(res.status).toBe(503);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("persists the status and retains inbound text/Queue processing for a valid mixed callback", async () => {
    const fetchMock = routedFetch({
      record_whatsapp_outbound_status: [{ result: "recorded" }],
      ingest_whatsapp_text_message: [{ result: "processed", conversation_id: CONVERSATION_ID }],
    });
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(mixedWebhookBody())), testEnv);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(queueSend).toHaveBeenCalledWith(
      { version: 1, conversationId: CONVERSATION_ID, providerMessageId: "wamid.ID1" },
      { contentType: "json" },
    );
  });

  it("returns 503 for a mixed callback when the status RPC fails even though the inbound text is processed and enqueued", async () => {
    const fetchMock = vi.fn(async (url: URL) => {
      if (url.toString().endsWith("/rest/v1/rpc/record_whatsapp_outbound_status")) throw new Error("network down");
      if (url.toString().endsWith("/rest/v1/rpc/resolve_whatsapp_contact_automation")) return jsonResponse([{ result: "ai" }]);
      return jsonResponse([{ result: "processed", conversation_id: CONVERSATION_ID }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(mixedWebhookBody())), testEnv);

    expect(res.status).toBe(503);
    expect(queueSend).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for a webhook with a malformed declared text message and performs no persistence or queue calls", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "WABA_ID", changes: [{ value: { messaging_product: "whatsapp", metadata: { phone_number_id: "123456123" }, messages: [{ from: "bad-sender", id: "wamid.ID1", timestamp: "1603059201", type: "text", text: { body: "Hello!" } }] }, field: "messages" }] }],
    });

    const res = await worker.fetch(await signedPost(body), testEnv);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("returns 200 for a processed text message and enqueues one intake job with only the contract fields", async () => {
    vi.stubGlobal("fetch", routedFetch({ ingest_whatsapp_text_message: [{ result: "processed", conversation_id: CONVERSATION_ID }] }));
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(textMessageWebhookBody())), testEnv);

    expect(res.status).toBe(200);
    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(queueSend).toHaveBeenCalledWith(
      { version: 1, conversationId: CONVERSATION_ID, providerMessageId: "wamid.ID1" },
      { contentType: "json" },
    );
  });

  it("acknowledges a signed group message without RPC, Queue, persistence, or reply work", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn();
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };
    const payload = textMessageWebhookBody() as {
      entry: Array<{ changes: Array<{ value: { messages: Array<Record<string, unknown>> } }> }>;
    };
    payload.entry[0]!.changes[0]!.value.messages[0]!.group_id = "GROUP_ID";

    const res = await worker.fetch(await signedPost(JSON.stringify(payload)), testEnv);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("returns 200 for a duplicate text message and enqueues one intake job", async () => {
    vi.stubGlobal("fetch", routedFetch({ ingest_whatsapp_text_message: [{ result: "duplicate", conversation_id: CONVERSATION_ID }] }));
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(textMessageWebhookBody())), testEnv);

    expect(res.status).toBe(200);
    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(queueSend).toHaveBeenCalledWith(
      { version: 1, conversationId: CONVERSATION_ID, providerMessageId: "wamid.ID1" },
      { contentType: "json" },
    );
  });

  it("calls the RPC once and enqueues once for an identical in-payload duplicate", async () => {
    const fetchMock = routedFetch({ ingest_whatsapp_text_message: [{ result: "processed", conversation_id: CONVERSATION_ID }] });
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };
    const payload = textMessageWebhookBody() as {
      entry: Array<{ changes: Array<{ value: { messages: unknown[] } }> }>;
    };
    const messages = payload.entry[0]?.changes[0]?.value.messages;
    messages?.push(structuredClone(messages[0]));

    const res = await worker.fetch(await signedPost(JSON.stringify(payload)), testEnv);

    expect(res.status).toBe(200);
    // The automation route is resolved once per raw candidate before dedup
    // (Task 033), so the duplicate message costs a second resolution call
    // even though it collapses into a single ingest RPC call.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(queueSend).toHaveBeenCalledTimes(1);
  });

  it("returns 200 for a signed media webhook using the existing ingest RPC and Queue job, carrying no media data", async () => {
    const fetchMock = routedFetch({ ingest_whatsapp_text_message: [{ result: "processed", conversation_id: CONVERSATION_ID }] });
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(mediaMessageWebhookBody("image"))), testEnv);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const ingestCall = fetchMock.mock.calls.find(([callUrl]) =>
      (callUrl as URL).toString().endsWith("/rest/v1/rpc/ingest_whatsapp_text_message"),
    );
    const [url, init] = ingestCall as [URL, RequestInit];
    expect(url.toString()).toContain("/rest/v1/rpc/ingest_whatsapp_text_message");
    const rpcBody = init.body as string;
    expect(JSON.parse(rpcBody).p_message_text).toBe("__vetai_unsupported_media__");
    for (const leak of ["MEDIA_ID", "image/jpeg", "abc", "kedi fotoğrafı"]) {
      expect(rpcBody).not.toContain(leak);
    }
    expect(queueSend).toHaveBeenCalledWith(
      { version: 1, conversationId: CONVERSATION_ID, providerMessageId: "wamid.ID1" },
      { contentType: "json" },
    );
  });

  it.each(["audio", "contacts", "document", "image", "location", "sticker", "video"])(
    "returns 200 and enqueues exactly one job for a signed %s webhook",
    async (type) => {
      vi.stubGlobal("fetch", routedFetch({ ingest_whatsapp_text_message: [{ result: "processed", conversation_id: CONVERSATION_ID }] }));
      const queueSend = vi.fn().mockResolvedValue(undefined);
      const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

      const res = await worker.fetch(await signedPost(JSON.stringify(mediaMessageWebhookBody(type))), testEnv);

      expect(res.status).toBe(200);
      expect(queueSend).toHaveBeenCalledTimes(1);
    },
  );

  it("returns 200 without persistence or Queue work for a still-unrecognized message type", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(mediaMessageWebhookBody("reaction"))), testEnv);

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("returns 400 for a media webhook with a malformed sender and performs no persistence or queue calls", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(mediaMessageWebhookBody("image", { from: "bad-sender" }))), testEnv);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("returns 503 for a media webhook when the ingest RPC reports an unknown account and never calls Queue", async () => {
    vi.stubGlobal("fetch", routedFetch({ ingest_whatsapp_text_message: [{ result: "unknown_account", conversation_id: null }] }));
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(mediaMessageWebhookBody("audio"))), testEnv);

    expect(res.status).toBe(503);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("returns 503 for a media webhook when the Queue send fails", async () => {
    vi.stubGlobal("fetch", routedFetch({ ingest_whatsapp_text_message: [{ result: "processed", conversation_id: CONVERSATION_ID }] }));
    const queueSend = vi.fn().mockRejectedValue(new Error("queue down"));
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(mediaMessageWebhookBody("video"))), testEnv);

    expect(res.status).toBe(503);
  });

  it("calls the ingest RPC once and enqueues once for an identical in-payload media duplicate", async () => {
    const fetchMock = routedFetch({ ingest_whatsapp_text_message: [{ result: "processed", conversation_id: CONVERSATION_ID }] });
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };
    const payload = mediaMessageWebhookBody("image") as {
      entry: Array<{ changes: Array<{ value: { messages: unknown[] } }> }>;
    };
    const messages = payload.entry[0]?.changes[0]?.value.messages;
    messages?.push(structuredClone(messages[0]));

    const res = await worker.fetch(await signedPost(JSON.stringify(payload)), testEnv);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(queueSend).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when Supabase configuration is missing and the automation route cannot be resolved", async () => {
    const noConfigEnv: Env = { ...env, SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(await signedPost(JSON.stringify(textMessageWebhookBody())), noConfigEnv);
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 503 when the RPC reports an unknown account and never calls Queue", async () => {
    vi.stubGlobal("fetch", routedFetch({ ingest_whatsapp_text_message: [{ result: "unknown_account", conversation_id: null }] }));
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(textMessageWebhookBody())), testEnv);

    expect(res.status).toBe(503);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("returns 503 when a processed result omits the conversation locator and never calls Queue", async () => {
    vi.stubGlobal("fetch", routedFetch({ ingest_whatsapp_text_message: [{ result: "processed" }] }));
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(textMessageWebhookBody())), testEnv);

    expect(res.status).toBe(503);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("returns 503 on a Supabase network failure while resolving the automation route, and never calls Queue", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(textMessageWebhookBody())), testEnv);

    expect(res.status).toBe(503);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("returns 503 when Queue rejects after a processed persistence outcome", async () => {
    vi.stubGlobal("fetch", routedFetch({ ingest_whatsapp_text_message: [{ result: "processed", conversation_id: CONVERSATION_ID }] }));
    const queueSend = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(textMessageWebhookBody())), testEnv);

    expect(res.status).toBe(503);
    expect(queueSend).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when Queue rejects after a duplicate persistence outcome", async () => {
    vi.stubGlobal("fetch", routedFetch({ ingest_whatsapp_text_message: [{ result: "duplicate", conversation_id: CONVERSATION_ID }] }));
    const queueSend = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(textMessageWebhookBody())), testEnv);

    expect(res.status).toBe(503);
    expect(queueSend).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["manual", CONVERSATION_ID],
    ["ignored", null],
  ] as const)(
    "returns 200 for a %s ingest outcome without enqueuing a Queue job or counting a failure",
    async (result, conversationId) => {
      vi.stubGlobal("fetch", routedFetch({ ingest_whatsapp_text_message: [{ result, conversation_id: conversationId }] }));
      const queueSend = vi.fn().mockResolvedValue(undefined);
      const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

      const res = await worker.fetch(await signedPost(JSON.stringify(textMessageWebhookBody())), testEnv);

      expect(res.status).toBe(200);
      expect(queueSend).not.toHaveBeenCalled();
    },
  );
});

function fakeMessage(body: unknown): Message<unknown> {
  return {
    id: "msg-1",
    timestamp: new Date(),
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<unknown>;
}

function fakeBatch(messages: Message<unknown>[], queue = "vetai-intake"): MessageBatch<unknown> {
  return { queue, messages, ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<unknown>;
}

describe("worker queue handler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("acks an invalid message body with zero network calls", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const message = fakeMessage({ bogus: true });

    await worker.queue!(fakeBatch([message]), env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a message whose processor call rejects, without blocking other messages' own disposition", async () => {
    vi.spyOn(intakeConsumer, "processIntakeQueueMessage").mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ack");
    const failing = fakeMessage({ irrelevant: true });
    const succeeding = fakeMessage({ irrelevant: true });

    await worker.queue!(fakeBatch([failing, succeeding]), env);

    expect(failing.retry).toHaveBeenCalledTimes(1);
    expect(failing.ack).not.toHaveBeenCalled();
    expect(succeeding.ack).toHaveBeenCalledTimes(1);
    expect(succeeding.retry).not.toHaveBeenCalled();
  });

  it("routes vetai-intake batches only through the primary processor", async () => {
    const primarySpy = vi.spyOn(intakeConsumer, "processIntakeQueueMessage").mockResolvedValueOnce("ack");
    const dlqSpy = vi.spyOn(intakeDeadLetter, "processIntakeDeadLetterQueueMessage");
    const message = fakeMessage({ irrelevant: true });

    await worker.queue!(fakeBatch([message], "vetai-intake"), env);

    expect(primarySpy).toHaveBeenCalledTimes(1);
    expect(dlqSpy).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("routes vetai-intake-dlq batches only through the dead-letter processor", async () => {
    const primarySpy = vi.spyOn(intakeConsumer, "processIntakeQueueMessage");
    const dlqSpy = vi.spyOn(intakeDeadLetter, "processIntakeDeadLetterQueueMessage").mockResolvedValueOnce("ack");
    const message = fakeMessage({ irrelevant: true });

    await worker.queue!(fakeBatch([message], "vetai-intake-dlq"), env);

    expect(dlqSpy).toHaveBeenCalledTimes(1);
    expect(primarySpy).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("retries a rejected dead-letter processor call without blocking other messages' own disposition", async () => {
    vi.spyOn(intakeDeadLetter, "processIntakeDeadLetterQueueMessage").mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ack");
    const failing = fakeMessage({ irrelevant: true });
    const succeeding = fakeMessage({ irrelevant: true });

    await worker.queue!(fakeBatch([failing, succeeding], "vetai-intake-dlq"), env);

    expect(failing.retry).toHaveBeenCalledTimes(1);
    expect(failing.ack).not.toHaveBeenCalled();
    expect(succeeding.ack).toHaveBeenCalledTimes(1);
    expect(succeeding.retry).not.toHaveBeenCalled();
  });

  it("fails closed and retries every message for an unknown queue name, calling no processor", async () => {
    const primarySpy = vi.spyOn(intakeConsumer, "processIntakeQueueMessage");
    const dlqSpy = vi.spyOn(intakeDeadLetter, "processIntakeDeadLetterQueueMessage");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const first = fakeMessage({ irrelevant: true });
    const second = fakeMessage({ irrelevant: true });

    await worker.queue!(fakeBatch([first, second], "vetai-intake-terminal-dlq"), env);

    expect(first.retry).toHaveBeenCalledTimes(1);
    expect(first.ack).not.toHaveBeenCalled();
    expect(second.retry).toHaveBeenCalledTimes(1);
    expect(second.ack).not.toHaveBeenCalled();
    expect(primarySpy).not.toHaveBeenCalled();
    expect(dlqSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function fakeExecutionContext(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

describe("worker scheduled handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the outbound drain with waitUntil", async () => {
    const drainSpy = vi.spyOn(outboundSender, "drainOutboundMessages").mockResolvedValue(undefined);
    const ctx = fakeExecutionContext();

    await worker.scheduled!({} as ScheduledController, env, ctx);

    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(drainSpy).toHaveBeenCalledWith(env);
  });

  it("contains an unexpected throw from the drain instead of letting it escape", async () => {
    vi.spyOn(outboundSender, "drainOutboundMessages").mockRejectedValue(new Error("boom"));
    const ctx = fakeExecutionContext();

    await worker.scheduled!({} as ScheduledController, env, ctx);

    const [waited] = (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0] as [Promise<unknown>];
    await expect(waited).resolves.toBeUndefined();
  });
});
