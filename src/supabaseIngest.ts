import type { Env } from "./env";
import type { WhatsAppIngestItem } from "./whatsappIngest";

export type IngestOutcome = "processed" | "duplicate" | "unknown_account" | "failed";

const VALID_RESULTS = new Set(["processed", "duplicate", "unknown_account"]);

function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

/** Calls the `ingest_whatsapp_text_message` Data API RPC over native fetch. Never logs the request/response body. */
export async function ingestWhatsAppTextMessage(item: WhatsAppIngestItem, env: Env): Promise<IngestOutcome> {
  if (!env.SUPABASE_URL.trim() || !env.SUPABASE_SERVICE_ROLE_KEY.trim()) {
    return "failed";
  }

  let endpoint: URL;
  try {
    endpoint = new URL("/rest/v1/rpc/ingest_whatsapp_text_message", env.SUPABASE_URL);
  } catch {
    return "failed";
  }

  if (endpoint.protocol !== "https:" && !isLoopbackHttpUrl(endpoint)) {
    return "failed";
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
    });
  } catch {
    return "failed";
  }

  if (!response.ok) {
    return "failed";
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return "failed";
  }

  if (!Array.isArray(payload) || payload.length !== 1) {
    return "failed";
  }

  const row = payload[0];
  const result = typeof row === "object" && row !== null ? (row as Record<string, unknown>).result : undefined;
  if (typeof result !== "string" || !VALID_RESULTS.has(result)) {
    return "failed";
  }

  return result as IngestOutcome;
}
