const ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHONE_NUMBER_ID_PATTERN = /^[0-9]{1,64}$/;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const MAX_REGISTRY_BYTES = 5_000;
const MAX_ENTRIES = 10;
const MAX_TOKEN_CODE_POINTS = 1_024;
const ENTRY_KEYS = ["whatsapp_account_id", "phone_number_id", "access_token"] as const;

interface WhatsAppAccountCredential {
  whatsappAccountId: string;
  phoneNumberId: string;
  accessToken: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.length !== keys.length) return false;
  return ownKeys.every((key) => typeof key === "string" && keys.includes(key) && Object.prototype.propertyIsEnumerable.call(record, key));
}

function isCodePointLengthInRange(value: string, min: number, max: number): boolean {
  const length = [...value].length;
  return length >= min && length <= max;
}

/**
 * Parses and fully validates the `WHATSAPP_ACCOUNT_CREDENTIALS_JSON` registry.
 * Any structural or value defect invalidates the whole registry; there is no
 * partial acceptance and no fallback. Pure, deterministic, bounded, no logging.
 */
function parseRegistry(raw: string): WhatsAppAccountCredential[] | null {
  try {
    if (typeof raw !== "string") return null;
    if (new TextEncoder().encode(raw).length > MAX_REGISTRY_BYTES) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_ENTRIES) return null;

    const credentials: WhatsAppAccountCredential[] = [];
    const seenAccountIds = new Set<string>();
    const seenPhoneNumberIds = new Set<string>();

    for (const entry of parsed) {
      if (!isPlainRecord(entry) || !hasExactKeys(entry, ENTRY_KEYS)) return null;

      const { whatsapp_account_id: accountId, phone_number_id: phoneNumberId, access_token: accessToken } = entry;

      if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) return null;
      if (typeof phoneNumberId !== "string" || !PHONE_NUMBER_ID_PATTERN.test(phoneNumberId)) return null;
      if (
        typeof accessToken !== "string" ||
        !isCodePointLengthInRange(accessToken, 1, MAX_TOKEN_CODE_POINTS) ||
        accessToken.trim() !== accessToken ||
        CONTROL_CHARACTER_PATTERN.test(accessToken)
      ) {
        return null;
      }
      if (seenAccountIds.has(accountId) || seenPhoneNumberIds.has(phoneNumberId)) return null;

      seenAccountIds.add(accountId);
      seenPhoneNumberIds.add(phoneNumberId);
      credentials.push({ whatsappAccountId: accountId, phoneNumberId, accessToken });
    }

    return credentials;
  } catch {
    return null;
  }
}

/** True only when the full registry is well-formed. Never exposes its entries. */
export function isWhatsAppCredentialRegistryValid(raw: string): boolean {
  return parseRegistry(raw) !== null;
}

/**
 * Returns one validated `phone_number_id` from the registry for use as a
 * readiness probe target. Never returns an access token or account UUID.
 */
export function getReadinessProbePhoneNumberId(raw: string): string | null {
  const credentials = parseRegistry(raw);
  return credentials?.[0]?.phoneNumberId ?? null;
}

export type ResolveWhatsAppAccessTokenResult = { kind: "resolved"; accessToken: string } | { kind: "not_found" };

/**
 * Resolves the exact access token for one (whatsappAccountId, phoneNumberId)
 * pair. A malformed registry and a missing/mismatched pair both fail closed
 * as `not_found`; the full registry is never returned to the caller.
 */
export function resolveWhatsAppAccessToken(
  raw: string,
  whatsappAccountId: string,
  phoneNumberId: string,
): ResolveWhatsAppAccessTokenResult {
  const credentials = parseRegistry(raw);
  if (!credentials) return { kind: "not_found" };

  const match = credentials.find(
    (credential) => credential.whatsappAccountId === whatsappAccountId && credential.phoneNumberId === phoneNumberId,
  );
  return match ? { kind: "resolved", accessToken: match.accessToken } : { kind: "not_found" };
}
