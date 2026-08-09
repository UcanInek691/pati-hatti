import type { Env } from "./env";
import type { WhatsAppStatusItem } from "./whatsappStatus";

export type RecordOutboundStatusResult =
  | { kind: "recorded" }
  | { kind: "duplicate" }
  | { kind: "stale" }
  | { kind: "not_found" }
  | { kind: "failed" };

const FAILED: RecordOutboundStatusResult = { kind: "failed" };

function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

function buildEndpoint(env: Env): URL | null {
  if (!env.SUPABASE_URL.trim() || !env.SUPABASE_SERVICE_ROLE_KEY.trim()) {
    return null;
  }
  let endpoint: URL;
  try {
    endpoint = new URL("/rest/v1/rpc/record_whatsapp_outbound_status", env.SUPABASE_URL);
  } catch {
    return null;
  }
  if (endpoint.protocol !== "https:" && !isLoopbackHttpUrl(endpoint)) {
    return null;
  }
  return endpoint;
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  try {
    return typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Calls the `record_whatsapp_outbound_status` Data API RPC over native fetch. Never logs the request/response body. */
export async function recordWhatsAppOutboundStatus(item: WhatsAppStatusItem, env: Env): Promise<RecordOutboundStatusResult> {
  const endpoint = buildEndpoint(env);
  if (!endpoint) return FAILED;

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
        p_recipient_e164: item.recipientE164,
        p_provider_status: item.status,
        p_provider_timestamp: item.providerTimestamp,
      }),
    });
  } catch {
    return FAILED;
  }

  if (!response.ok) return FAILED;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return FAILED;
  }

  if (!Array.isArray(payload) || payload.length !== 1) return FAILED;

  const row = asPlainRecord(payload[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 1) return FAILED;

    const { result } = row;
    return result === "recorded" || result === "duplicate" || result === "stale" || result === "not_found" ? { kind: result } : FAILED;
  } catch {
    return FAILED;
  }
}
