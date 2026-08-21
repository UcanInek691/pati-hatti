import type { Env } from "./env";

export type ResolveContactAutomationResult =
  | { kind: "ai" }
  | { kind: "manual" }
  | { kind: "personal" }
  | { kind: "unknown_account" }
  | { kind: "failed" };

const FAILED_RESOLVE: ResolveContactAutomationResult = { kind: "failed" };

function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

function buildEndpoint(env: Env, rpcName: string): URL | null {
  try {
    if (!env.SUPABASE_URL.trim() || !env.SUPABASE_SERVICE_ROLE_KEY.trim()) {
      return null;
    }
    const endpoint = new URL(`/rest/v1/rpc/${rpcName}`, env.SUPABASE_URL);
    if (endpoint.protocol !== "https:" && !isLoopbackHttpUrl(endpoint)) {
      return null;
    }
    return endpoint;
  } catch {
    return null;
  }
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
      signal: AbortSignal.timeout(10_000),
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

/**
 * Calls the `resolve_whatsapp_contact_automation` Data API RPC over native
 * fetch. Never logs the request/response body, phone number, or account
 * identifiers. Must be called before any nested message content is read for
 * a candidate (Task 033 envelope-first routing).
 */
export async function resolveWhatsAppContactAutomation(
  phoneNumberId: string,
  contactE164: string,
  env: Env,
): Promise<ResolveContactAutomationResult> {
  const endpoint = buildEndpoint(env, "resolve_whatsapp_contact_automation");
  if (!endpoint) return FAILED_RESOLVE;

  const rows = await callRpc(endpoint, env, { p_phone_number_id: phoneNumberId, p_contact_e164: contactE164 });
  if (rows === null || rows.length !== 1) return FAILED_RESOLVE;

  const row = asPlainRecord(rows[0]);
  if (!row || Reflect.ownKeys(row).length !== 1) return FAILED_RESOLVE;

  const { result } = row;
  if (result === "ai" || result === "manual" || result === "personal" || result === "unknown_account") {
    return { kind: result };
  }
  return FAILED_RESOLVE;
}
