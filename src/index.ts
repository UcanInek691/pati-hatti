import type { Env } from "./env";
import { getHealth } from "./health";
import { verifyWhatsAppChallenge } from "./webhookVerify";
import { MAX_BODY_BYTES, readRawBodyWithLimit, verifyHmacSignature } from "./webhookSignature";
import { extractTextMessages } from "./whatsappIngest";
import { ingestWhatsAppTextMessage } from "./supabaseIngest";
import { extractOutboundStatuses } from "./whatsappStatus";
import { recordWhatsAppOutboundStatus } from "./supabaseOutboundStatus";
import { enqueueIntakeJob } from "./intakeQueue";
import { processIntakeQueueMessage } from "./intakeConsumer";
import { drainOutboundMessages } from "./outboundSender";
import { STAFF_SECURITY_HEADERS, handleStaffConfig, handleStaffScript, handleStaffShell } from "./staffPage";

function isWhatsAppWebhook(body: unknown): body is { object: string; entry: unknown[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return false;
  }

  const event = body as Record<string, unknown>;
  return event.object === "whatsapp_business_account" && Array.isArray(event.entry);
}

async function handleWebhookPost(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return new Response("Unsupported Media Type", { status: 415 });
  }

  const rawBody = await readRawBodyWithLimit(request, MAX_BODY_BYTES);
  if (rawBody === null) {
    return new Response("Payload Too Large", { status: 413 });
  }

  const signatureHeader = request.headers.get("x-hub-signature-256");
  const signatureValid = await verifyHmacSignature(rawBody, signatureHeader, env.WHATSAPP_APP_SECRET);
  if (!signatureValid) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(rawBody));
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  if (!isWhatsAppWebhook(body)) {
    return new Response("Bad Request", { status: 400 });
  }

  console.log("whatsapp webhook event received");

  const statusExtraction = await extractOutboundStatuses(body);
  const textExtraction = await extractTextMessages(body);
  if (!statusExtraction.ok || !textExtraction.ok) {
    return new Response("Bad Request", { status: 400 });
  }

  let statusFailed = 0;
  for (const item of statusExtraction.items) {
    const outcome = await recordWhatsAppOutboundStatus(item, env);
    if (outcome.kind === "failed") {
      statusFailed++;
    }
  }
  if (statusExtraction.items.length > 0) {
    console.log("whatsapp webhook status callbacks persisted", { total: statusExtraction.items.length, failed: statusFailed });
  }

  if (textExtraction.items.length === 0) {
    return statusFailed > 0 ? new Response("Service Unavailable", { status: 503 }) : Response.json({ received: true });
  }

  let processed = 0;
  let duplicate = 0;
  let failed = 0;
  for (const item of textExtraction.items) {
    const outcome = await ingestWhatsAppTextMessage(item, env);
    if (outcome.kind !== "processed" && outcome.kind !== "duplicate") {
      failed++;
      continue;
    }

    const enqueued = await enqueueIntakeJob(env.INTAKE_QUEUE, outcome.conversationId, item.providerMessageId);
    if (!enqueued) {
      failed++;
      continue;
    }

    if (outcome.kind === "processed") processed++;
    else duplicate++;
  }
  console.log("whatsapp webhook event persisted", { processed, duplicate, failed });

  if (failed > 0 || statusFailed > 0) {
    return new Response("Service Unavailable", { status: 503 });
  }
  return Response.json({ received: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json(getHealth());
    }

    if (url.pathname === "/webhooks/whatsapp") {
      if (request.method === "GET") {
        const result = verifyWhatsAppChallenge(url.searchParams, env.WHATSAPP_VERIFY_TOKEN);
        return new Response(result.body, { status: result.status });
      }

      if (request.method === "POST") {
        return handleWebhookPost(request, env);
      }
    }

    if (url.pathname === "/staff" || url.pathname === "/staff/" || url.pathname.startsWith("/staff/")) {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { ...STAFF_SECURITY_HEADERS, Allow: "GET" },
        });
      }
      if (url.pathname === "/staff" || url.pathname === "/staff/") {
        return handleStaffShell(env);
      }
      if (url.pathname === "/staff/app.js") {
        return handleStaffScript();
      }
      if (url.pathname === "/staff/config.json") {
        return handleStaffConfig(env);
      }
      return new Response("Not Found", { status: 404, headers: STAFF_SECURITY_HEADERS });
    }

    return new Response("Not Found", { status: 404 });
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      let disposition: "ack" | "retry";
      try {
        disposition = await processIntakeQueueMessage(message.body, env);
      } catch {
        disposition = "retry";
      }

      if (disposition === "ack") {
        message.ack();
      } else {
        message.retry();
      }
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(drainOutboundMessages(env).catch(() => {}));
  },
};
