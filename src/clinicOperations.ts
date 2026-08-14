import type { Env } from "./env";

export type ClinicOperationalContextResult =
  | { result: "configured"; clinicName: string; phone: string; address: string | null; isOpen: boolean }
  | { result: "unconfigured" }
  | { result: "not_found" }
  | { result: "failed" };

const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
const EXPECTED_KEYS = ["result", "clinic_name", "contact_phone_e164", "public_address", "is_open"] as const;
const REQUEST_TIMEOUT_MS = 5_000;

function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

function buildEndpoint(env: Env): URL | null {
  if (
    typeof env.SUPABASE_URL !== "string" ||
    !env.SUPABASE_URL.trim() ||
    typeof env.SUPABASE_SERVICE_ROLE_KEY !== "string" ||
    !env.SUPABASE_SERVICE_ROLE_KEY.trim()
  ) {
    return null;
  }
  let endpoint: URL;
  try {
    endpoint = new URL("/rest/v1/rpc/get_conversation_clinic_operational_context", env.SUPABASE_URL);
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

function hasExactKeys(row: Record<string, unknown>): boolean {
  const keys = Reflect.ownKeys(row);
  if (keys.length !== EXPECTED_KEYS.length) return false;
  return keys.every((key) => typeof key === "string" && Object.prototype.propertyIsEnumerable.call(row, key)) &&
    EXPECTED_KEYS.every((key) => Object.prototype.hasOwnProperty.call(row, key));
}

/** True if `text` contains a C0 control code point (0-31) or DEL (127). */
function hasControlChar(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function isCleanText(text: string, minLength: number, maxLength: number): boolean {
  if (text !== text.trim()) return false;
  if (hasControlChar(text)) return false;
  const length = codePointLength(text);
  return length >= minLength && length <= maxLength;
}

/** Strictly parses one Data API row into a fresh closed-union result; any unexpected shape fails closed to null. */
function parseRow(value: unknown): ClinicOperationalContextResult | null {
  const row = asPlainRecord(value);
  if (!row || !hasExactKeys(row)) return null;

  const result = row.result;
  const clinicName = row.clinic_name;
  const phone = row.contact_phone_e164;
  const address = row.public_address;
  const isOpen = row.is_open;

  if (result === "not_found" || result === "unconfigured") {
    if (clinicName !== null || phone !== null || address !== null || isOpen !== null) return null;
    return { result };
  }

  if (result !== "configured") return null;
  if (typeof clinicName !== "string" || !isCleanText(clinicName, 1, 120)) return null;
  if (typeof phone !== "string" || !E164_PATTERN.test(phone)) return null;
  if (address !== null && (typeof address !== "string" || !isCleanText(address, 1, 500))) return null;
  if (typeof isOpen !== "boolean") return null;

  return { result: "configured", clinicName, phone, address, isOpen };
}

/**
 * Calls the `get_conversation_clinic_operational_context` Data API RPC over
 * native fetch, using the RPC's own server-side clock default. Never logs
 * the request/response body and never exposes a raw provider body; every
 * transport, config, or shape failure returns a fresh `{ result: "failed" }`.
 */
export async function getConversationClinicOperationalContext(conversationId: string, env: Env): Promise<ClinicOperationalContextResult> {
  const endpoint = buildEndpoint(env);
  if (!endpoint) return { result: "failed" };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ p_conversation_id: conversationId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { result: "failed" };
  }

  if (!response.ok) return { result: "failed" };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { result: "failed" };
  }

  if (!Array.isArray(payload) || payload.length !== 1) return { result: "failed" };

  try {
    const parsed = parseRow(payload[0]);
    return parsed ?? { result: "failed" };
  } catch {
    return { result: "failed" };
  }
}
