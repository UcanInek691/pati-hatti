import type { Env } from "./env";
import type { WhatsAppIngestItem } from "./whatsappIngest";

export type IngestOutcome =
  | { kind: "processed"; conversationId: string }
  | { kind: "duplicate"; conversationId: string }
  | { kind: "manual"; conversationId: string }
  | { kind: "ignored" }
  | { kind: "unknown_account" }
  | { kind: "failed" };

const FAILED: IngestOutcome = { kind: "failed" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

/** Calls the `ingest_whatsapp_text_message` Data API RPC over native fetch. Never logs the request/response body. */
export async function ingestWhatsAppTextMessage(item: WhatsAppIngestItem, env: Env): Promise<IngestOutcome> {
  if (!env.SUPABASE_URL.trim() || !env.SUPABASE_SERVICE_ROLE_KEY.trim()) {
    return FAILED;
  }

  let endpoint: URL;
  try {
    endpoint = new URL("/rest/v1/rpc/ingest_whatsapp_text_message", env.SUPABASE_URL);
  } catch {
    return FAILED;
  }

  if (endpoint.protocol !== "https:" && !isLoopbackHttpUrl(endpoint)) {
    return FAILED;
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        p_phone_number_id: item.phoneNumberId,
        p_provider_message_id: item.providerMessageId,
        p_payload_hash: item.payloadHash,
        p_sender_e164: item.senderE164,
        p_owner_name: item.ownerName,
        p_message_text: item.messageText,
        p_provider_timestamp: item.providerTimestamp,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return FAILED;
  }

  if (!response.ok) {
    return FAILED;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return FAILED;
  }

  if (!Array.isArray(payload) || payload.length !== 1) {
    return FAILED;
  }

  const row: unknown = payload[0];
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return FAILED;
  }

  const { result, conversation_id: conversationId } = row as Record<string, unknown>;

  if (result === "unknown_account" || result === "ignored") {
    return conversationId === null ? { kind: result } : FAILED;
  }

  if (result !== "processed" && result !== "duplicate" && result !== "manual") {
    return FAILED;
  }

  if (typeof conversationId !== "string" || !UUID_PATTERN.test(conversationId)) {
    return FAILED;
  }

  return { kind: result, conversationId };
}
