import type { Env } from "./env";

export interface AppointmentSlot {
  slotId: string;
  startsAt: string;
  endsAt: string;
}

export interface ListAvailableAppointmentSlotsInput {
  conversationId: string;
  from: string;
  to: string;
  limit?: number;
}

export type ListAvailableAppointmentSlotsResult = { kind: "listed"; slots: AppointmentSlot[] } | { kind: "failed" };

export type HoldAppointmentSlotResult =
  | { kind: "held"; bookingToken: string; startsAt: string; endsAt: string }
  | { kind: "not_found" }
  | { kind: "not_ready" }
  | { kind: "unavailable" }
  | { kind: "conflict" }
  | { kind: "failed" };

export type ConfirmAppointmentSlotResult =
  | { kind: "confirmed"; startsAt: string; endsAt: string }
  | { kind: "already_confirmed"; startsAt: string; endsAt: string }
  | { kind: "not_found" }
  | { kind: "not_ready" }
  | { kind: "stale" }
  | { kind: "failed" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

function failedList(): ListAvailableAppointmentSlotsResult {
  return { kind: "failed" };
}

function failedHold(): HoldAppointmentSlotResult {
  return { kind: "failed" };
}

function failedConfirm(): ConfirmAppointmentSlotResult {
  return { kind: "failed" };
}

function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

function buildEndpoint(env: Env, rpcName: string): URL | null {
  if (
    typeof env?.SUPABASE_URL !== "string" ||
    typeof env?.SUPABASE_SERVICE_ROLE_KEY !== "string" ||
    !env.SUPABASE_URL.trim() ||
    !env.SUPABASE_SERVICE_ROLE_KEY.trim()
  ) {
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

function isValidTimestampString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !Number.isNaN(Date.parse(value));
}

/** Calls the `list_available_appointment_slots` Data API RPC over native fetch. Never logs the request/response body. */
export async function listAvailableAppointmentSlots(
  input: ListAvailableAppointmentSlotsInput,
  env: Env,
): Promise<ListAvailableAppointmentSlotsResult> {
  const { conversationId, from, to } = input;
  const limit = input.limit === undefined ? 5 : input.limit;

  if (typeof conversationId !== "string" || !UUID_PATTERN.test(conversationId)) return failedList();
  if (!isValidTimestampString(from) || !isValidTimestampString(to)) return failedList();

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (toMs <= fromMs || toMs - fromMs > MAX_WINDOW_MS) return failedList();
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) return failedList();

  const endpoint = buildEndpoint(env, "list_available_appointment_slots");
  if (!endpoint) return failedList();

  const rows = await callRpc(endpoint, env, { p_conversation_id: conversationId, p_from: from, p_to: to, p_limit: limit });
  if (rows === null) return failedList();

  const slots: AppointmentSlot[] = [];
  try {
    for (const rawRow of rows) {
      const row = asPlainRecord(rawRow);
      if (!row || Reflect.ownKeys(row).length !== 3) return failedList();

      const { slot_id: slotId, starts_at: startsAt, ends_at: endsAt } = row;
      if (typeof slotId !== "string" || !UUID_PATTERN.test(slotId)) return failedList();
      if (!isValidTimestampString(startsAt) || !isValidTimestampString(endsAt)) return failedList();

      slots.push({ slotId, startsAt, endsAt });
    }
  } catch {
    return failedList();
  }

  return { kind: "listed", slots };
}

/** Calls the `hold_appointment_slot` Data API RPC over native fetch. Never logs the request/response body. */
export async function holdAppointmentSlot(conversationId: string, slotId: string, env: Env): Promise<HoldAppointmentSlotResult> {
  if (typeof conversationId !== "string" || !UUID_PATTERN.test(conversationId)) return failedHold();
  if (typeof slotId !== "string" || !UUID_PATTERN.test(slotId)) return failedHold();

  const endpoint = buildEndpoint(env, "hold_appointment_slot");
  if (!endpoint) return failedHold();

  const rows = await callRpc(endpoint, env, { p_conversation_id: conversationId, p_slot_id: slotId });
  if (rows === null || rows.length !== 1) return failedHold();

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 4) return failedHold();

    const { result, booking_token: bookingToken, starts_at: startsAt, ends_at: endsAt } = row;

    if (result === "not_found" || result === "not_ready" || result === "unavailable" || result === "conflict") {
      return bookingToken === null && startsAt === null && endsAt === null ? { kind: result } : failedHold();
    }

    if (result !== "held") return failedHold();
    if (typeof bookingToken !== "string" || !UUID_PATTERN.test(bookingToken)) return failedHold();
    if (!isValidTimestampString(startsAt) || !isValidTimestampString(endsAt)) return failedHold();

    return { kind: "held", bookingToken, startsAt, endsAt };
  } catch {
    return failedHold();
  }
}

/** Calls the `confirm_appointment_slot` Data API RPC over native fetch. Never logs the request/response body. */
export async function confirmAppointmentSlot(
  conversationId: string,
  slotId: string,
  bookingToken: string,
  env: Env,
): Promise<ConfirmAppointmentSlotResult> {
  if (typeof conversationId !== "string" || !UUID_PATTERN.test(conversationId)) return failedConfirm();
  if (typeof slotId !== "string" || !UUID_PATTERN.test(slotId)) return failedConfirm();
  if (typeof bookingToken !== "string" || !UUID_PATTERN.test(bookingToken)) return failedConfirm();

  const endpoint = buildEndpoint(env, "confirm_appointment_slot");
  if (!endpoint) return failedConfirm();

  const rows = await callRpc(endpoint, env, {
    p_conversation_id: conversationId,
    p_slot_id: slotId,
    p_booking_token: bookingToken,
  });
  if (rows === null || rows.length !== 1) return failedConfirm();

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 3) return failedConfirm();

    const { result, starts_at: startsAt, ends_at: endsAt } = row;

    if (result === "not_found" || result === "not_ready" || result === "stale") {
      return startsAt === null && endsAt === null ? { kind: result } : failedConfirm();
    }

    if (result !== "confirmed" && result !== "already_confirmed") return failedConfirm();
    if (!isValidTimestampString(startsAt) || !isValidTimestampString(endsAt)) return failedConfirm();

    return { kind: result, startsAt, endsAt };
  } catch {
    return failedConfirm();
  }
}
