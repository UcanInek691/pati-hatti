import type { Env } from "./env";
import type { IntakeStage } from "./conversationState";
import type { IntakeReplyPlan } from "./intakeReply";

export type ClaimIntakeQueueJobResult =
  | { kind: "claimed"; claimToken: string; messageText: string; automationMode: "ai" }
  | { kind: "claimed"; claimToken: string; messageText: null; automationMode: "manual" | "personal" }
  | { kind: "completed" }
  | { kind: "busy" }
  | { kind: "not_found" }
  | { kind: "failed" };

export type CompleteIntakeQueueJobResult = { kind: "completed" } | { kind: "stale" } | { kind: "failed" };

export type FinalizeIntakeQueueJobResult =
  | { kind: "applied"; intakeStage: IntakeStage; stateVersion: number }
  | { kind: "suppressed" }
  | { kind: "already_completed" }
  | { kind: "stale_claim" }
  | { kind: "stale_state" }
  | { kind: "failed" };

export interface FinalizeIntakeQueueJobInput {
  conversationId: string;
  providerMessageId: string;
  claimToken: string;
  expectedVersion: number;
  nextStage: IntakeStage;
  petId: string | null;
  intakeData: Record<string, unknown>;
  reply: IntakeReplyPlan;
}

const FAILED_CLAIM: ClaimIntakeQueueJobResult = { kind: "failed" };
const FAILED_COMPLETE: CompleteIntakeQueueJobResult = { kind: "failed" };
const FAILED_FINALIZE: FinalizeIntakeQueueJobResult = { kind: "failed" };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ponytail: duplicates conversationState.ts's private stage set rather than
// exporting it, matching Task 013's file-scoped allowed-changes boundary.
const INTAKE_STAGES = new Set<IntakeStage>([
  "pet_identification",
  "complaint_collection",
  "safety_check",
  "ready_for_triage",
  "appointment_offer",
  "appointment_selection",
  "appointment_confirmation",
  "human_handoff",
  "completed",
]);

function isIntakeStage(value: unknown): value is IntakeStage {
  return typeof value === "string" && INTAKE_STAGES.has(value as IntakeStage);
}

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
    if (!row || Reflect.ownKeys(row).length !== 4) return FAILED_CLAIM;

    const { result, claim_token: claimToken, message_text: messageText, automation_mode: automationMode } = row;

    if (result === "completed" || result === "busy" || result === "not_found") {
      return claimToken === null && messageText === null && automationMode === null ? { kind: result } : FAILED_CLAIM;
    }

    if (result !== "claimed") return FAILED_CLAIM;
    if (typeof claimToken !== "string" || !UUID_PATTERN.test(claimToken)) return FAILED_CLAIM;

    if (automationMode === "ai") {
      if (typeof messageText !== "string" || !isCodePointLengthInRange(messageText, 1, 65536)) return FAILED_CLAIM;
      return { kind: "claimed", claimToken, messageText, automationMode: "ai" };
    }
    if (automationMode === "manual" || automationMode === "personal") {
      return messageText === null ? { kind: "claimed", claimToken, messageText: null, automationMode } : FAILED_CLAIM;
    }
    return FAILED_CLAIM;
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

/** Calls the `finalize_intake_queue_job` Data API RPC over native fetch. Never logs the request/response body. */
export async function finalizeIntakeQueueJob(input: FinalizeIntakeQueueJobInput, env: Env): Promise<FinalizeIntakeQueueJobResult> {
  const endpoint = buildEndpoint(env, "finalize_intake_queue_job");
  if (!endpoint) return FAILED_FINALIZE;

  const rows = await callRpc(endpoint, env, {
    p_conversation_id: input.conversationId,
    p_provider_message_id: input.providerMessageId,
    p_claim_token: input.claimToken,
    p_expected_version: input.expectedVersion,
    p_next_stage: input.nextStage,
    p_pet_id: input.petId,
    p_intake_data: input.intakeData,
    p_reply_category: input.reply.kind === "send" ? input.reply.category : null,
    p_reply_text: input.reply.kind === "send" ? input.reply.text : null,
  });
  if (rows === null || rows.length !== 1) return FAILED_FINALIZE;

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 3) return FAILED_FINALIZE;

    const { result, intake_stage: intakeStage, state_version: stateVersion } = row;

    if (result === "already_completed" || result === "stale_claim" || result === "stale_state" || result === "suppressed") {
      return intakeStage === null && stateVersion === null ? { kind: result } : FAILED_FINALIZE;
    }

    if (result !== "applied") return FAILED_FINALIZE;
    if (!isIntakeStage(intakeStage)) return FAILED_FINALIZE;
    if (typeof stateVersion !== "number" || !Number.isInteger(stateVersion) || stateVersion < 1) return FAILED_FINALIZE;

    return { kind: "applied", intakeStage, stateVersion };
  } catch {
    return FAILED_FINALIZE;
  }
}
