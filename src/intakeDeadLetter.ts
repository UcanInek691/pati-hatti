import type { Env } from "./env";
import { parseIntakeQueueMessage } from "./intakeQueue";

export type FinalizeIntakeDeadLetterResult =
  | { kind: "handed_off" }
  | { kind: "already_completed" }
  | { kind: "already_terminal" }
  | { kind: "not_found" }
  | { kind: "failed" };

export type QueueDisposition = "ack" | "retry";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failed(): FinalizeIntakeDeadLetterResult {
  return { kind: "failed" };
}

function hasValidIdentifiers(conversationId: unknown, providerMessageId: unknown): conversationId is string {
  return typeof conversationId === "string" &&
    UUID_PATTERN.test(conversationId) &&
    typeof providerMessageId === "string" &&
    providerMessageId.length > 0 &&
    providerMessageId.trim() === providerMessageId &&
    [...providerMessageId].length <= 512;
}

// ponytail: duplicates intakeJobLease.ts's isLoopbackHttpUrl/buildEndpoint/
// callRpc/asPlainRecord rather than importing them, matching this repo's
// established per-file RPC-client duplication convention.
function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

function buildEndpoint(env: Env, rpcName: string): URL | null {
  if (!env.SUPABASE_URL?.trim() || !env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
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

/** Calls the `finalize_intake_dead_letter` Data API RPC over native fetch. Never logs the request/response body. */
export async function finalizeIntakeDeadLetter(conversationId: string, providerMessageId: string, env: Env): Promise<FinalizeIntakeDeadLetterResult> {
  if (!hasValidIdentifiers(conversationId, providerMessageId)) return failed();
  const endpoint = buildEndpoint(env, "finalize_intake_dead_letter");
  if (!endpoint) return failed();

  const rows = await callRpc(endpoint, env, { p_conversation_id: conversationId, p_provider_message_id: providerMessageId });
  if (rows === null || rows.length !== 1) return failed();

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 1) return failed();

    const { result } = row;
    if (result === "handed_off" || result === "already_completed" || result === "already_terminal" || result === "not_found") {
      return { kind: result };
    }
    return failed();
  } catch {
    return failed();
  }
}

/**
 * Orchestrates one untrusted vetai-intake-dlq Queue body through parse ->
 * atomic dead-letter finalize, returning an explicit ack/retry disposition.
 * Unlike processIntakeQueueMessage, a malformed body retries rather than
 * acks, so it eventually reaches the terminal parking queue instead of
 * disappearing silently. Never throws message content, identifiers,
 * payloads, or secrets; catches unexpected exceptions and retries.
 */
export async function processIntakeDeadLetterQueueMessage(body: unknown, env: Env): Promise<QueueDisposition> {
  try {
    const parsed = parseIntakeQueueMessage(body);
    if (!parsed.ok) return "retry";
    const { conversationId, providerMessageId } = parsed.message;

    const result = await finalizeIntakeDeadLetter(conversationId, providerMessageId, env);
    if (
      result.kind === "handed_off" ||
      result.kind === "already_completed" ||
      result.kind === "already_terminal" ||
      result.kind === "not_found"
    ) {
      return "ack";
    }
    return "retry";
  } catch {
    return "retry";
  }
}
