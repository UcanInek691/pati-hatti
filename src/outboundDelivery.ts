import type { Env } from "./env";

export type ClaimOutboundMessageResult =
  | {
      kind: "claimed";
      outboxId: string;
      claimToken: string;
      phoneNumberId: string;
      recipientE164: string;
      content: string;
      attemptCount: number;
    }
  | { kind: "exhausted" }
  | { kind: "empty" }
  | { kind: "failed" };

// `release_outbound_message` already returns a literal `"failed"` as one of
// its three legitimate DB outcomes (terminal attempt exhaustion), so the
// generic "the call itself didn't succeed" sentinel is named `call_failed`
// here instead of reusing `failed`, unlike the other two functions in this
// file where `failed` never collides with a real RPC result.
export type ReleaseOutboundMessageResult = { kind: "retry_scheduled" } | { kind: "failed" } | { kind: "stale" } | { kind: "call_failed" };

export type AcceptOutboundMessageResult = { kind: "accepted" } | { kind: "already_accepted" } | { kind: "stale" } | { kind: "failed" };

const FAILED_CLAIM: ClaimOutboundMessageResult = { kind: "failed" };
const CALL_FAILED_RELEASE: ReleaseOutboundMessageResult = { kind: "call_failed" };
const FAILED_ACCEPT: AcceptOutboundMessageResult = { kind: "failed" };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE_NUMBER_ID_PATTERN = /^[0-9]{1,64}$/;
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

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

/** Calls the `claim_outbound_message` Data API RPC over native fetch. Never logs the request/response body. */
export async function claimOutboundMessage(env: Env): Promise<ClaimOutboundMessageResult> {
  const endpoint = buildEndpoint(env, "claim_outbound_message");
  if (!endpoint) return FAILED_CLAIM;

  const rows = await callRpc(endpoint, env, {});
  if (rows === null || rows.length !== 1) return FAILED_CLAIM;

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 7) return FAILED_CLAIM;

    const {
      result,
      outbox_id: outboxId,
      claim_token: claimToken,
      phone_number_id: phoneNumberId,
      recipient_e164: recipientE164,
      content,
      attempt_count: attemptCount,
    } = row;

    if (result === "exhausted" || result === "empty") {
      return outboxId === null &&
        claimToken === null &&
        phoneNumberId === null &&
        recipientE164 === null &&
        content === null &&
        attemptCount === null
        ? { kind: result }
        : FAILED_CLAIM;
    }

    if (result !== "claimed") return FAILED_CLAIM;
    if (typeof outboxId !== "string" || !UUID_PATTERN.test(outboxId)) return FAILED_CLAIM;
    if (typeof claimToken !== "string" || !UUID_PATTERN.test(claimToken)) return FAILED_CLAIM;
    if (typeof phoneNumberId !== "string" || !PHONE_NUMBER_ID_PATTERN.test(phoneNumberId)) return FAILED_CLAIM;
    if (typeof recipientE164 !== "string" || !E164_PATTERN.test(recipientE164)) return FAILED_CLAIM;
    if (typeof content !== "string" || !isCodePointLengthInRange(content, 1, 4096)) return FAILED_CLAIM;
    if (typeof attemptCount !== "number" || !Number.isInteger(attemptCount) || attemptCount < 1 || attemptCount > 3) return FAILED_CLAIM;

    return { kind: "claimed", outboxId, claimToken, phoneNumberId, recipientE164, content, attemptCount };
  } catch {
    return FAILED_CLAIM;
  }
}

/** Calls the `release_outbound_message` Data API RPC over native fetch. Never logs the request/response body. */
export async function releaseOutboundMessage(outboxId: string, claimToken: string, env: Env): Promise<ReleaseOutboundMessageResult> {
  const endpoint = buildEndpoint(env, "release_outbound_message");
  if (!endpoint) return CALL_FAILED_RELEASE;

  const rows = await callRpc(endpoint, env, { p_outbox_id: outboxId, p_claim_token: claimToken });
  if (rows === null || rows.length !== 1) return CALL_FAILED_RELEASE;

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 1) return CALL_FAILED_RELEASE;

    const { result } = row;
    return result === "retry_scheduled" || result === "failed" || result === "stale" ? { kind: result } : CALL_FAILED_RELEASE;
  } catch {
    return CALL_FAILED_RELEASE;
  }
}

/** Calls the `accept_outbound_message` Data API RPC over native fetch. Never logs the request/response body. */
export async function acceptOutboundMessage(
  outboxId: string,
  claimToken: string,
  providerMessageId: string,
  env: Env,
): Promise<AcceptOutboundMessageResult> {
  const endpoint = buildEndpoint(env, "accept_outbound_message");
  if (!endpoint) return FAILED_ACCEPT;

  const rows = await callRpc(endpoint, env, {
    p_outbox_id: outboxId,
    p_claim_token: claimToken,
    p_provider_message_id: providerMessageId,
  });
  if (rows === null || rows.length !== 1) return FAILED_ACCEPT;

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 1) return FAILED_ACCEPT;

    const { result } = row;
    return result === "accepted" || result === "already_accepted" || result === "stale" ? { kind: result } : FAILED_ACCEPT;
  } catch {
    return FAILED_ACCEPT;
  }
}
