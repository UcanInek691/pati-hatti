import type { Env } from "./env";
import { getHealth } from "./health";
import { verifyWhatsAppChallenge } from "./webhookVerify";
import { MAX_BODY_BYTES, readRawBodyWithLimit, verifyHmacSignature } from "./webhookSignature";
import { extractInboundMessages } from "./whatsappIngest";
import { ingestWhatsAppTextMessage } from "./supabaseIngest";
import { extractOutboundStatuses } from "./whatsappStatus";
import { recordWhatsAppOutboundStatus } from "./supabaseOutboundStatus";
import { enqueueIntakeJob } from "./intakeQueue";
import { processIntakeQueueMessage } from "./intakeConsumer";
import { processIntakeDeadLetterQueueMessage } from "./intakeDeadLetter";
import { drainOutboundMessages } from "./outboundSender";
import { STAFF_SECURITY_HEADERS, handleStaffConfig, handleStaffScript, handleStaffShell } from "./staffPage";
import { checkReadiness } from "./readiness";
import type { QueueDisposition } from "./intakeConsumer";
import { handlePrivacyPage } from "./privacyPage";

/**
 * Queue resource names routed to the primary intake consumer. `batch.queue`
 * carries the real Cloudflare resource name, and the same `src/index.ts` is
 * deployed to both the production Worker (`wrangler.toml`) and the isolated
 * staging Worker (`wrangler.staging.toml`), so both name sets are listed
 * explicitly. Terminal dead-letter queues are deliberately absent from both
 * sets: they have no declared consumer and must stay unhandled.
 */
const INTAKE_QUEUE_NAMES: ReadonlySet<string> = new Set(["vetai-intake", "vetai-intake-staging"]);

/** Queue resource names routed to the dead-letter handoff processor. */
const INTAKE_DEAD_LETTER_QUEUE_NAMES: ReadonlySet<string> = new Set(["vetai-intake-dlq", "vetai-intake-dlq-staging"]);

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
  if (!statusExtraction.ok) {
    return new Response("Bad Request", { status: 400 });
  }
  const textExtraction = await extractInboundMessages(body, env);
  if (!textExtraction.ok) {
    return textExtraction.reason === "route_failed"
      ? new Response("Service Unavailable", { status: 503 })
      : new Response("Bad Request", { status: 400 });
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
  let manual = 0;
  let ignored = 0;
  let unknownAccount = 0;
  let failed = 0;
  for (const item of textExtraction.items) {
    const outcome = await ingestWhatsAppTextMessage(item, env);

    // Manual and ignored routes never enqueue paid intake work; they are a
    // successful, terminal outcome for this item (Task 033).
    if (outcome.kind === "manual") {
      manual++;
      continue;
    }
    if (outcome.kind === "ignored") {
      ignored++;
      continue;
    }
    // An unrecognized phone number ID is permanent, not transient: no retry can
    // ever resolve it. Counting it as a failure returned 503 to Meta, which
    // both invites webhook throttling for the whole account and hides the real
    // cause. Acknowledge it instead, and keep it visible as its own counter
    // rather than folded into `ignored`.
    if (outcome.kind === "unknown_account") {
      unknownAccount++;
      continue;
    }

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
  console.log("whatsapp webhook event persisted", { processed, duplicate, manual, ignored, unknown_account: unknownAccount, failed });

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

    if (url.pathname === "/privacy" || url.pathname === "/privacy/") {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
      }
      return handlePrivacyPage();
    }

    if (url.pathname === "/ready") {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { ...STAFF_SECURITY_HEADERS, Allow: "GET" },
        });
      }
      const readiness = checkReadiness(env);
      return Response.json(readiness, {
        status: readiness.status === "ready" ? 200 : 503,
        headers: STAFF_SECURITY_HEADERS,
      });
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

  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    let processor: ((body: unknown, env: Env) => Promise<QueueDisposition>) | null;
    if (INTAKE_QUEUE_NAMES.has(batch.queue)) {
      processor = processIntakeQueueMessage;
    } else if (INTAKE_DEAD_LETTER_QUEUE_NAMES.has(batch.queue)) {
      processor = processIntakeDeadLetterQueueMessage;
    } else {
      processor = null;
    }

    for (const message of batch.messages) {
      let disposition: QueueDisposition;
      if (processor === null) {
        disposition = "retry";
      } else {
        try {
          disposition = await processor(message.body, env);
        } catch {
          disposition = "retry";
        }
      }

      if (disposition === "ack") {
        message.ack();
      } else {
        message.retry();
      }
    }

    // Task 036: the reply an intake turn just wrote to
    // `outbound_message_outbox` used to sit there until the next `* * * * *`
    // cron tick — 0-60s of dead air per turn, ~30s on average, and cron's
    // finest granularity on Cloudflare is already one minute, so the schedule
    // cannot be tightened. Draining here sends it as soon as it exists.
    //
    // Safe to call from two places at once: `drainOutboundMessages` claims
    // each row under a lease before sending and never throws, so the cron run
    // below is now a safety net for rows this call misses (a crashed
    // invocation, a row written by another path) rather than the only sender.
    //
    // Skipped for an unrecognized queue: nothing ran, so nothing can have been
    // written to send.
    if (processor !== null) ctx.waitUntil(drainOutboundMessages(env).catch(() => {}));
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(drainOutboundMessages(env).catch(() => {}));
  },
};
