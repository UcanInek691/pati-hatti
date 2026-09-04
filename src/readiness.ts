import type { Env } from "./env";
import { getReadinessProbePhoneNumberId } from "./whatsappCredentials";
import { resolveWhatsAppContactAutomation } from "./contactAutomation";

export type ReadinessResult = { status: "ready" } | { status: "unavailable" };

// Duplicated from whatsappSend.ts per this repo's per-file config-validation
// duplication convention rather than importing it.
const GRAPH_VERSION_PATTERN = /^v\d+\.0$/;

const PLACEHOLDER_PATTERN = /^(?:change[_-]?me|replace[_-]?me|your[_-].*|<[^>]*>|\[[^\]]*\]|placeholder|todo|x{3,}|unset|not[_-]?set)$/i;

// Synthetic, never-real contact used only to probe the route resolver's live
// call path (Task 050). Not customer input; never persisted or logged.
const READINESS_PROBE_CONTACT_E164 = "+10000000000";

const DEPENDENCY_CACHE_TTL_MS = 30_000;

let cachedResult: ReadinessResult | null = null;
let cachedAt = 0;
let inFlight: Promise<ReadinessResult> | null = null;

function isNonPlaceholderString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.trim() !== value) return false;
  return !PLACEHOLDER_PATTERN.test(value);
}

function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

function isValidSupabaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && !isLoopbackHttpUrl(url)) return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.pathname !== "" && url.pathname !== "/") return false;
  if (url.search !== "" || url.hash !== "") return false;
  return true;
}

function hasCallableSend(queue: unknown): boolean {
  return typeof queue === "object" && queue !== null && typeof (queue as { send?: unknown }).send === "function";
}

type ConfigurationShape = { ok: true; probePhoneNumberId: string } | { ok: false };

/**
 * Pure configuration-shape check: never calls Supabase, Meta, OpenAI, or the
 * Queue. Confirms every runtime-used Env value is present, trimmed, not an
 * obvious placeholder, and syntactically valid where a closed format already
 * exists, plus one usable dependency-probe `phone_number_id`. Never returns or
 * logs the missing key name, value, URL, or secret; always returns a fresh
 * object.
 */
function checkConfigurationShape(env: Env): ConfigurationShape {
  try {
    if (env.APP_TIMEZONE !== "Europe/Istanbul") return { ok: false };
    if (!isNonPlaceholderString(env.WHATSAPP_VERIFY_TOKEN)) return { ok: false };
    if (!isNonPlaceholderString(env.WHATSAPP_APP_SECRET)) return { ok: false };
    if (!isNonPlaceholderString(env.SUPABASE_URL) || !isValidSupabaseUrl(env.SUPABASE_URL)) return { ok: false };
    if (!isNonPlaceholderString(env.SUPABASE_SERVICE_ROLE_KEY)) return { ok: false };
    if (!isNonPlaceholderString(env.SUPABASE_ANON_KEY)) return { ok: false };
    if (!isNonPlaceholderString(env.OPENAI_API_KEY)) return { ok: false };
    if (!isNonPlaceholderString(env.WHATSAPP_GRAPH_API_VERSION) || !GRAPH_VERSION_PATTERN.test(env.WHATSAPP_GRAPH_API_VERSION)) {
      return { ok: false };
    }
    if (!hasCallableSend(env.INTAKE_QUEUE)) return { ok: false };

    // This helper parses and validates the complete registry before returning
    // one phone-number ID, so a second full parse is unnecessary.
    const probePhoneNumberId = getReadinessProbePhoneNumberId(env.WHATSAPP_ACCOUNT_CREDENTIALS_JSON);
    if (!probePhoneNumberId) return { ok: false };

    return { ok: true, probePhoneNumberId };
  } catch {
    return { ok: false };
  }
}

/**
 * Probes the real route-resolver call path with the fixed synthetic contact.
 * Never calls Meta, OpenAI, or the Queue; never sends a message; never writes
 * to the database. `ai`/`manual`/`personal` are the resolver's only non-error
 * outcomes and each means the read path is live; every other outcome
 * (`unknown_account`, non-2xx, timeout/abort, malformed response, thrown
 * error) fails closed to `unavailable`.
 */
async function probeRouteResolver(phoneNumberId: string, env: Env): Promise<ReadinessResult> {
  try {
    const result = await resolveWhatsAppContactAutomation(phoneNumberId, READINESS_PROBE_CONTACT_E164, env);
    return result.kind === "ai" || result.kind === "manual" || result.kind === "personal"
      ? { status: "ready" }
      : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * Configuration shape is re-checked on every call and never cached, so a
 * config regression is visible immediately and can never be masked by a
 * previously ready dependency result. The dependency probe result is cached
 * for 30 seconds per Worker isolate; concurrent calls during a cache miss
 * share one in-flight probe. Every caller receives a fresh result object.
 */
export async function checkReadiness(env: Env): Promise<ReadinessResult> {
  const shape = checkConfigurationShape(env);
  if (!shape.ok) return { status: "unavailable" };

  if (cachedResult && Date.now() - cachedAt < DEPENDENCY_CACHE_TTL_MS) {
    return { ...cachedResult };
  }

  if (!inFlight) {
    inFlight = probeRouteResolver(shape.probePhoneNumberId, env)
      .then((result) => {
        cachedResult = result;
        cachedAt = Date.now();
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  const result = await inFlight;
  return { ...result };
}
