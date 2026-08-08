import type { Env } from "./env";

export type ClaimIntakeQueueJobResult =
  | { kind: "claimed"; claimToken: string; messageText: string }
  | { kind: "completed" }
  | { kind: "busy" }
  | { kind: "not_found" }
  | { kind: "failed" };

export type CompleteIntakeQueueJobResult = { kind: "completed" } | { kind: "stale" } | { kind: "failed" };

const FAILED_CLAIM: ClaimIntakeQueueJobResult = { kind: "failed" };
const FAILED_COMPLETE: CompleteIntakeQueueJobResult = { kind: "failed" };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

function buildEndpoint(env: Env, rpcName: string): URL | null {
  if (!env.SUPABASE_URL.trim() || !env.SUPABASE_SERVICE_ROLE_KEY.trim()) {
    return null;
  }
  let endpoint: URL;
  try {
    endpoint = new URL(`/rest/v1/rpc/${rpcName}`, env.SUPABASE_URL);
  } catch {
    return null;
  }
  if (endpoint.protocol !== "https:" && !isLoopbackHttpUrl(endpoint)) {
    return null;
  }
  return endpoint;
}

async function callRpc(endpoint: URL, env: Env, body: Record<string, unknown>): Promise<unknown[] | null> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  return Array.isArray(payload) ? payload : null;
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

function isCodePointLengthInRange(value: string, min: number, max: number): boolean {
  const length = [...value].length;
  return length >= min && length <= max;
}

/** Calls the `claim_intake_queue_job` Data API RPC over native fetch. Never logs the request/response body. */
export async function claimIntakeQueueJob(conversationId: string, providerMessageId: string, env: Env): Promise<ClaimIntakeQueueJobResult> {
  const endpoint = buildEndpoint(env, "claim_intake_queue_job");
  if (!endpoint) return FAILED_CLAIM;

  const rows = await callRpc(endpoint, env, { p_conversation_id: conversationId, p_provider_message_id: providerMessageId });
  if (rows === null || rows.length !== 1) return FAILED_CLAIM;

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 3) return FAILED_CLAIM;

    const { result, claim_token: claimToken, message_text: messageText } = row;

    if (result === "completed" || result === "busy" || result === "not_found") {
      return claimToken === null && messageText === null ? { kind: result } : FAILED_CLAIM;
    }

    if (result !== "claimed") return FAILED_CLAIM;
    if (typeof claimToken !== "string" || !UUID_PATTERN.test(claimToken)) return FAILED_CLAIM;
    if (typeof messageText !== "string" || !isCodePointLengthInRange(messageText, 1, 65536)) return FAILED_CLAIM;

    return { kind: "claimed", claimToken, messageText };
  } catch {
    return FAILED_CLAIM;
  }
}

/** Calls the `complete_intake_queue_job` Data API RPC over native fetch. Never logs the request/response body. */
export async function completeIntakeQueueJob(
  conversationId: string,
  providerMessageId: string,
  claimToken: string,
  env: Env,
): Promise<CompleteIntakeQueueJobResult> {
  const endpoint = buildEndpoint(env, "complete_intake_queue_job");
  if (!endpoint) return FAILED_COMPLETE;

  const rows = await callRpc(endpoint, env, {
    p_conversation_id: conversationId,
    p_provider_message_id: providerMessageId,
    p_claim_token: claimToken,
  });
  if (rows === null || rows.length !== 1) return FAILED_COMPLETE;

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 1) return FAILED_COMPLETE;

    const { result } = row;
    return result === "completed" || result === "stale" ? { kind: result } : FAILED_COMPLETE;
  } catch {
    return FAILED_COMPLETE;
  }
}
