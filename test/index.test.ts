import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import type { IntakeQueueMessage } from "../src/intakeQueue";
import { MAX_BODY_BYTES } from "../src/webhookSignature";
import { signHmacSha256 } from "./signHelper";
import * as intakeConsumer from "../src/intakeConsumer";

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
  OPENAI_API_KEY: "unused",
  INTAKE_QUEUE: stubQueue(),
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "processed", conversation_id: CONVERSATION_ID }])));
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

  it("returns 200 for a duplicate text message and enqueues one intake job", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "duplicate", conversation_id: CONVERSATION_ID }])));
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
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "processed", conversation_id: CONVERSATION_ID }]));
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queueSend).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when Supabase configuration is missing", async () => {
    const noConfigEnv: Env = { ...env, SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" };
    vi.stubGlobal("fetch", vi.fn());
    const res = await worker.fetch(await signedPost(JSON.stringify(textMessageWebhookBody())), noConfigEnv);
    expect(res.status).toBe(503);
  });

  it("returns 503 when the RPC reports an unknown account and never calls Queue", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "unknown_account", conversation_id: null }])));
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(textMessageWebhookBody())), testEnv);

    expect(res.status).toBe(503);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("returns 503 when a processed result omits the conversation locator and never calls Queue", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "processed" }])));
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(textMessageWebhookBody())), testEnv);

    expect(res.status).toBe(503);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("returns 503 on a Supabase network failure and never calls Queue", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(textMessageWebhookBody())), testEnv);

    expect(res.status).toBe(503);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("returns 503 when Queue rejects after a processed persistence outcome", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "processed", conversation_id: CONVERSATION_ID }])));
    const queueSend = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(textMessageWebhookBody())), testEnv);

    expect(res.status).toBe(503);
    expect(queueSend).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when Queue rejects after a duplicate persistence outcome", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "duplicate", conversation_id: CONVERSATION_ID }])));
    const queueSend = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    const testEnv: Env = { ...env, INTAKE_QUEUE: stubQueue(queueSend) };

    const res = await worker.fetch(await signedPost(JSON.stringify(textMessageWebhookBody())), testEnv);

    expect(res.status).toBe(503);
    expect(queueSend).toHaveBeenCalledTimes(1);
  });
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

function fakeBatch(messages: Message<unknown>[]): MessageBatch<unknown> {
  return { queue: "vetai-intake", messages, ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<unknown>;
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
});
