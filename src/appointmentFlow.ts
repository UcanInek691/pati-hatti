import type { Env } from "./env";
import type { ConversationIntakeContext, IntakeStage } from "./conversationState";
import type { PlanResult } from "./intakeTurn";

export type AppointmentDecision = "confirm" | "decline" | "repeat";
export type AppointmentCancelDecision = "cancel" | "keep" | "repeat";

export type AppointmentAction =
  | { kind: "none" }
  | { kind: "offer" }
  | { kind: "decision"; decision: AppointmentDecision }
  | { kind: "cancel_offer" }
  | { kind: "cancel_decision"; decision: AppointmentCancelDecision };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeForComparison(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("tr");
}

/**
 * Deterministic EVET/HAYIR grammar over raw inbound message text only. Never
 * reads model-extracted fields, ids, tokens, dates, or times; unrecognized
 * text always repeats rather than confirms or declines.
 */
export function parseAppointmentDecision(messageText: string): AppointmentDecision {
  const normalized = normalizeForComparison(messageText);
  if (normalized === "evet") return "confirm";
  if (normalized === "hayır" || normalized === "hayir") return "decline";
  return "repeat";
}

/** Same EVET/HAYIR grammar as `parseAppointmentDecision`, over the cancellation vocabulary. */
export function parseAppointmentCancelDecision(messageText: string): AppointmentCancelDecision {
  const normalized = normalizeForComparison(messageText);
  if (normalized === "evet") return "cancel";
  if (normalized === "hayır" || normalized === "hayir") return "keep";
  return "repeat";
}

/**
 * Pure routing decision over an already-planned intake turn. Never calls an
 * RPC client. Safety/handoff always takes the existing non-appointment path;
 * only a safe, matched-pet appointment request reaching or holding
 * ready_for_triage/appointment_offer offers a slot; appointment_selection and
 * appointment_cancel_confirmation each parse their own raw-text decision; and
 * a matched-pet administrative cancellation may proceed with unknown safety
 * signals while explicit emergency/human-handoff decisions still take priority.
 */
export function planAppointmentAction(context: ConversationIntakeContext, plan: PlanResult, messageText: string): AppointmentAction {
  if (plan.kind !== "planned") return { kind: "none" };
  const { nextStage, petResolution, intakeData, safetyDecision } = plan;

  if (safetyDecision.kind === "emergency_handoff" || safetyDecision.kind === "human_handoff" || nextStage === "human_handoff") {
    return { kind: "none" };
  }

  if (context.intakeStage === "appointment_cancel_confirmation") {
    return { kind: "cancel_decision", decision: parseAppointmentCancelDecision(messageText) };
  }

  if (petResolution.kind === "matched" && intakeData.intent === "appointment_cancel_request" && nextStage === "appointment_cancel_confirmation") {
    return { kind: "cancel_offer" };
  }

  if (safetyDecision.kind !== "continue_intake") return { kind: "none" };

  if (context.intakeStage === "appointment_selection") {
    return { kind: "decision", decision: parseAppointmentDecision(messageText) };
  }

  if (
    petResolution.kind === "matched" &&
    intakeData.intent === "appointment_request" &&
    (nextStage === "ready_for_triage" || nextStage === "appointment_offer")
  ) {
    return { kind: "offer" };
  }

  return { kind: "none" };
}

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

function isCodePointLengthInRange(value: string, min: number, max: number): boolean {
  const length = [...value].length;
  return length >= min && length <= max;
}

function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  try {
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype &&
      Reflect.ownKeys(value).length > 0 &&
      Reflect.ownKeys(value).every(
        (key) => typeof key === "string" && Object.prototype.propertyIsEnumerable.call(value, key),
      )
    );
  } catch {
    return false;
  }
}

export type FinalizeAppointmentOfferResult =
  | { kind: "offered"; intakeStage: IntakeStage; stateVersion: number }
  | { kind: "unavailable"; intakeStage: IntakeStage; stateVersion: number }
  | { kind: "existing_confirmed"; intakeStage: IntakeStage; stateVersion: number }
  | { kind: "in_progress"; intakeStage: IntakeStage; stateVersion: number }
  | { kind: "suppressed" }
  | { kind: "already_completed" }
  | { kind: "stale_claim" }
  | { kind: "stale_state" }
  | { kind: "failed" };

export interface FinalizeAppointmentOfferInput {
  conversationId: string;
  providerMessageId: string;
  claimToken: string;
  expectedVersion: number;
  plannedNextStage: "ready_for_triage" | "appointment_offer";
  petId: string;
  intakeData: Record<string, unknown>;
}

function failedOffer(): FinalizeAppointmentOfferResult {
  return { kind: "failed" };
}

/** Calls the `finalize_appointment_offer_queue_job` Data API RPC over native fetch. Never logs the request/response body. */
export async function finalizeAppointmentOfferQueueJob(input: FinalizeAppointmentOfferInput, env: Env): Promise<FinalizeAppointmentOfferResult> {
  if (!isValidUuid(input.conversationId)) return failedOffer();
  if (typeof input.providerMessageId !== "string" || !isCodePointLengthInRange(input.providerMessageId, 1, 512)) return failedOffer();
  if (!isValidUuid(input.claimToken)) return failedOffer();
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) return failedOffer();
  if (input.plannedNextStage !== "ready_for_triage" && input.plannedNextStage !== "appointment_offer") return failedOffer();
  if (!isValidUuid(input.petId)) return failedOffer();
  if (!isPlainDataObject(input.intakeData)) return failedOffer();

  const endpoint = buildEndpoint(env, "finalize_appointment_offer_queue_job");
  if (!endpoint) return failedOffer();

  const rows = await callRpc(endpoint, env, {
    p_conversation_id: input.conversationId,
    p_provider_message_id: input.providerMessageId,
    p_claim_token: input.claimToken,
    p_expected_version: input.expectedVersion,
    p_planned_next_stage: input.plannedNextStage,
    p_pet_id: input.petId,
    p_intake_data: input.intakeData,
  });
  if (rows === null || rows.length !== 1) return failedOffer();

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 3) return failedOffer();
    const { result, intake_stage: intakeStage, state_version: stateVersion } = row;

    if (result === "already_completed" || result === "stale_claim" || result === "stale_state" || result === "suppressed") {
      return intakeStage === null && stateVersion === null ? { kind: result } : failedOffer();
    }
    if (result !== "offered" && result !== "unavailable" && result !== "existing_confirmed" && result !== "in_progress") return failedOffer();
    if (
      (result === "offered" && intakeStage !== "appointment_selection") ||
      (result === "unavailable" && intakeStage !== "human_handoff") ||
      (result === "existing_confirmed" && intakeStage !== "completed") ||
      (result === "in_progress" && intakeStage !== "human_handoff")
    ) {
      return failedOffer();
    }
    if (typeof stateVersion !== "number" || !Number.isInteger(stateVersion) || stateVersion < 1) return failedOffer();

    return { kind: result, intakeStage: intakeStage as IntakeStage, stateVersion };
  } catch {
    return failedOffer();
  }
}

export type FinalizeAppointmentDecisionResult =
  | { kind: "confirmed"; intakeStage: IntakeStage; stateVersion: number }
  | { kind: "declined"; intakeStage: IntakeStage; stateVersion: number }
  | { kind: "repeated"; intakeStage: IntakeStage; stateVersion: number }
  | { kind: "stale_hold"; intakeStage: IntakeStage; stateVersion: number }
  | { kind: "suppressed" }
  | { kind: "already_completed" }
  | { kind: "stale_claim" }
  | { kind: "stale_state" }
  | { kind: "failed" };

export interface FinalizeAppointmentDecisionInput {
  conversationId: string;
  providerMessageId: string;
  claimToken: string;
  expectedVersion: number;
  decision: AppointmentDecision;
  petId: string;
  intakeData: Record<string, unknown>;
}

function failedDecision(): FinalizeAppointmentDecisionResult {
  return { kind: "failed" };
}

/** Calls the `finalize_appointment_decision_queue_job` Data API RPC over native fetch. Never logs the request/response body. */
export async function finalizeAppointmentDecisionQueueJob(
  input: FinalizeAppointmentDecisionInput,
  env: Env,
): Promise<FinalizeAppointmentDecisionResult> {
  if (!isValidUuid(input.conversationId)) return failedDecision();
  if (typeof input.providerMessageId !== "string" || !isCodePointLengthInRange(input.providerMessageId, 1, 512)) return failedDecision();
  if (!isValidUuid(input.claimToken)) return failedDecision();
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) return failedDecision();
  if (input.decision !== "confirm" && input.decision !== "decline" && input.decision !== "repeat") return failedDecision();
  if (!isValidUuid(input.petId)) return failedDecision();
  if (!isPlainDataObject(input.intakeData)) return failedDecision();

  const endpoint = buildEndpoint(env, "finalize_appointment_decision_queue_job");
  if (!endpoint) return failedDecision();

  const rows = await callRpc(endpoint, env, {
    p_conversation_id: input.conversationId,
    p_provider_message_id: input.providerMessageId,
    p_claim_token: input.claimToken,
    p_expected_version: input.expectedVersion,
    p_decision: input.decision,
    p_pet_id: input.petId,
    p_intake_data: input.intakeData,
  });
  if (rows === null || rows.length !== 1) return failedDecision();

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 3) return failedDecision();
    const { result, intake_stage: intakeStage, state_version: stateVersion } = row;

    if (result === "already_completed" || result === "stale_claim" || result === "stale_state" || result === "suppressed") {
      return intakeStage === null && stateVersion === null ? { kind: result } : failedDecision();
    }
    if (result !== "confirmed" && result !== "declined" && result !== "repeated" && result !== "stale_hold") return failedDecision();
    if (
      ((result === "confirmed" || result === "declined") && intakeStage !== "completed") ||
      (result === "repeated" && intakeStage !== "appointment_selection") ||
      (result === "stale_hold" && intakeStage !== "human_handoff")
    ) {
      return failedDecision();
    }
    if (typeof stateVersion !== "number" || !Number.isInteger(stateVersion) || stateVersion < 1) return failedDecision();

    return { kind: result, intakeStage: intakeStage as IntakeStage, stateVersion };
  } catch {
    return failedDecision();
  }
}

export type FinalizeAppointmentCancelOfferResult =
  | { kind: "offered"; intakeStage: IntakeStage; stateVersion: number }
  | { kind: "no_appointment"; intakeStage: IntakeStage; stateVersion: number }
  | { kind: "suppressed" }
  | { kind: "already_completed" }
  | { kind: "stale_claim" }
  | { kind: "stale_state" }
  | { kind: "failed" };

export interface FinalizeAppointmentCancelOfferInput {
  conversationId: string;
  providerMessageId: string;
  claimToken: string;
  expectedVersion: number;
  petId: string;
  intakeData: Record<string, unknown>;
}

function failedCancelOffer(): FinalizeAppointmentCancelOfferResult {
  return { kind: "failed" };
}

/** Calls the `finalize_appointment_cancel_offer_queue_job` Data API RPC over native fetch. Never logs the request/response body. */
export async function finalizeAppointmentCancelOfferQueueJob(
  input: FinalizeAppointmentCancelOfferInput,
  env: Env,
): Promise<FinalizeAppointmentCancelOfferResult> {
  if (!isValidUuid(input.conversationId)) return failedCancelOffer();
  if (typeof input.providerMessageId !== "string" || !isCodePointLengthInRange(input.providerMessageId, 1, 512)) return failedCancelOffer();
  if (!isValidUuid(input.claimToken)) return failedCancelOffer();
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) return failedCancelOffer();
  if (!isValidUuid(input.petId)) return failedCancelOffer();
  if (!isPlainDataObject(input.intakeData)) return failedCancelOffer();

  const endpoint = buildEndpoint(env, "finalize_appointment_cancel_offer_queue_job");
  if (!endpoint) return failedCancelOffer();

  const rows = await callRpc(endpoint, env, {
    p_conversation_id: input.conversationId,
    p_provider_message_id: input.providerMessageId,
    p_claim_token: input.claimToken,
    p_expected_version: input.expectedVersion,
    p_pet_id: input.petId,
    p_intake_data: input.intakeData,
  });
  if (rows === null || rows.length !== 1) return failedCancelOffer();

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 3) return failedCancelOffer();
    const { result, intake_stage: intakeStage, state_version: stateVersion } = row;

    if (result === "already_completed" || result === "stale_claim" || result === "stale_state" || result === "suppressed") {
      return intakeStage === null && stateVersion === null ? { kind: result } : failedCancelOffer();
    }
    if (result !== "offered" && result !== "no_appointment") return failedCancelOffer();
    if (
      (result === "offered" && intakeStage !== "appointment_cancel_confirmation") ||
      (result === "no_appointment" && intakeStage !== "completed")
    ) {
      return failedCancelOffer();
    }
    if (typeof stateVersion !== "number" || !Number.isInteger(stateVersion) || stateVersion < 1) return failedCancelOffer();

    return { kind: result, intakeStage: intakeStage as IntakeStage, stateVersion };
  } catch {
    return failedCancelOffer();
  }
}

export type FinalizeAppointmentCancelDecisionResult =
  | { kind: "cancelled"; intakeStage: IntakeStage; stateVersion: number }
  | { kind: "kept"; intakeStage: IntakeStage; stateVersion: number }
  | { kind: "repeated"; intakeStage: IntakeStage; stateVersion: number }
  | { kind: "stale_appointment"; intakeStage: IntakeStage; stateVersion: number }
  | { kind: "suppressed" }
  | { kind: "already_completed" }
  | { kind: "stale_claim" }
  | { kind: "stale_state" }
  | { kind: "failed" };

export interface FinalizeAppointmentCancelDecisionInput {
  conversationId: string;
  providerMessageId: string;
  claimToken: string;
  expectedVersion: number;
  decision: AppointmentCancelDecision;
  petId: string;
  intakeData: Record<string, unknown>;
}

function failedCancelDecision(): FinalizeAppointmentCancelDecisionResult {
  return { kind: "failed" };
}

/** Calls the `finalize_appointment_cancel_decision_queue_job` Data API RPC over native fetch. Never logs the request/response body. */
export async function finalizeAppointmentCancelDecisionQueueJob(
  input: FinalizeAppointmentCancelDecisionInput,
  env: Env,
): Promise<FinalizeAppointmentCancelDecisionResult> {
  if (!isValidUuid(input.conversationId)) return failedCancelDecision();
  if (typeof input.providerMessageId !== "string" || !isCodePointLengthInRange(input.providerMessageId, 1, 512)) return failedCancelDecision();
  if (!isValidUuid(input.claimToken)) return failedCancelDecision();
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) return failedCancelDecision();
  if (input.decision !== "cancel" && input.decision !== "keep" && input.decision !== "repeat") return failedCancelDecision();
  if (!isValidUuid(input.petId)) return failedCancelDecision();
  if (!isPlainDataObject(input.intakeData)) return failedCancelDecision();

  const endpoint = buildEndpoint(env, "finalize_appointment_cancel_decision_queue_job");
  if (!endpoint) return failedCancelDecision();

  const rows = await callRpc(endpoint, env, {
    p_conversation_id: input.conversationId,
    p_provider_message_id: input.providerMessageId,
    p_claim_token: input.claimToken,
    p_expected_version: input.expectedVersion,
    p_decision: input.decision,
    p_pet_id: input.petId,
    p_intake_data: input.intakeData,
  });
  if (rows === null || rows.length !== 1) return failedCancelDecision();

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 3) return failedCancelDecision();
    const { result, intake_stage: intakeStage, state_version: stateVersion } = row;

    if (result === "already_completed" || result === "stale_claim" || result === "stale_state" || result === "suppressed") {
      return intakeStage === null && stateVersion === null ? { kind: result } : failedCancelDecision();
    }
    if (result !== "cancelled" && result !== "kept" && result !== "repeated" && result !== "stale_appointment") return failedCancelDecision();
    if (
      ((result === "cancelled" || result === "kept" || result === "stale_appointment") && intakeStage !== "completed") ||
      (result === "repeated" && intakeStage !== "appointment_cancel_confirmation")
    ) {
      return failedCancelDecision();
    }
    if (typeof stateVersion !== "number" || !Number.isInteger(stateVersion) || stateVersion < 1) return failedCancelDecision();

    return { kind: result, intakeStage: intakeStage as IntakeStage, stateVersion };
  } catch {
    return failedCancelDecision();
  }
}
