import type { Env } from "./env";

export type ReadinessResult = { status: "ready" } | { status: "unavailable" };

// Duplicated from whatsappSend.ts per this repo's per-file config-validation
// duplication convention rather than importing it.
const GRAPH_VERSION_PATTERN = /^v\d+\.0$/;

const PLACEHOLDER_PATTERN = /^(?:change[_-]?me|replace[_-]?me|your[_-].*|<[^>]*>|\[[^\]]*\]|placeholder|todo|x{3,}|unset|not[_-]?set)$/i;

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

/**
 * Pure configuration-shape check: never calls Supabase, Meta, OpenAI, or the
 * Queue. Confirms every runtime-used Env value is present, trimmed, not an
 * obvious placeholder, and syntactically valid where a closed format
 * already exists. Never returns or logs the missing key name, value, URL,
 * or secret; always returns a fresh object.
 */
export function checkReadiness(env: Env): ReadinessResult {
  try {
    if (env.APP_TIMEZONE !== "Europe/Istanbul") return { status: "unavailable" };
    if (!isNonPlaceholderString(env.WHATSAPP_VERIFY_TOKEN)) return { status: "unavailable" };
    if (!isNonPlaceholderString(env.WHATSAPP_APP_SECRET)) return { status: "unavailable" };
    if (!isNonPlaceholderString(env.SUPABASE_URL) || !isValidSupabaseUrl(env.SUPABASE_URL)) return { status: "unavailable" };
    if (!isNonPlaceholderString(env.SUPABASE_SERVICE_ROLE_KEY)) return { status: "unavailable" };
    if (!isNonPlaceholderString(env.SUPABASE_ANON_KEY)) return { status: "unavailable" };
    if (!isNonPlaceholderString(env.OPENAI_API_KEY)) return { status: "unavailable" };
    if (!isNonPlaceholderString(env.WHATSAPP_ACCESS_TOKEN)) return { status: "unavailable" };
    if (!isNonPlaceholderString(env.WHATSAPP_GRAPH_API_VERSION) || !GRAPH_VERSION_PATTERN.test(env.WHATSAPP_GRAPH_API_VERSION)) {
      return { status: "unavailable" };
    }
    if (!hasCallableSend(env.INTAKE_QUEUE)) return { status: "unavailable" };
    return { status: "ready" };
  } catch {
    return { status: "unavailable" };
  }
}
