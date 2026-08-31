import type { Env } from "./env";
import type { OpenAiIntakeUsage } from "./openaiIntake";

export type RecordIntakeAiUsageInput = {
  conversationId: string;
  providerMessageId: string;
  claimToken: string;
  model: string;
  promptVersion: string;
  usage: OpenAiIntakeUsage | null;
};

export type RecordIntakeAiUsageResult =
  | { kind: "recorded" }
  | { kind: "duplicate" }
  | { kind: "stale_claim" }
  | { kind: "not_found" }
  | { kind: "failed" };

export type ClinicMonthlyUsageInput = {
  clinicId: string;
  monthStart: string;
};

export type ClinicMonthlyUsageResult =
  | {
      kind: "reported" | "clinic_not_found";
      clinicId: string;
      periodStart: string;
      periodEnd: string;
      aiTurnCount: number;
      aiTouchedConversationCount: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      missingTokenUsageCount: number;
    }
  | { kind: "failed" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const MONTH_START_PATTERN = /^\d{4}-\d{2}-01$/;

function failedRecord(): RecordIntakeAiUsageResult {
  return { kind: "failed" };
}

function failedMonthlyUsage(): ClinicMonthlyUsageResult {
  return { kind: "failed" };
}

function isValidText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    [...value].length >= 1 &&
    [...value].length <= maximumLength &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidUsage(value: unknown): value is OpenAiIntakeUsage | null {
  if (value === null) return true;
  try {
    const usage = asPlainRecord(value);
    if (!usage || Reflect.ownKeys(usage).length !== 3) return false;
    const { inputTokens, outputTokens, totalTokens } = usage;
    return (
      typeof inputTokens === "number" &&
      Number.isSafeInteger(inputTokens) &&
      inputTokens >= 0 &&
      typeof outputTokens === "number" &&
      Number.isSafeInteger(outputTokens) &&
      outputTokens >= 0 &&
      typeof totalTokens === "number" &&
      Number.isSafeInteger(totalTokens) &&
      totalTokens >= 0
    );
  } catch {
    return false;
  }
}

function isValidRecordInput(value: unknown): value is RecordIntakeAiUsageInput {
  try {
    const input = asPlainRecord(value);
    if (!input || Reflect.ownKeys(input).length !== 6) return false;
    return (
      typeof input.conversationId === "string" &&
      UUID_PATTERN.test(input.conversationId) &&
      isValidText(input.providerMessageId, 512) &&
      typeof input.claimToken === "string" &&
      UUID_PATTERN.test(input.claimToken) &&
      isValidText(input.model, 120) &&
      isValidText(input.promptVersion, 120) &&
      isValidUsage(input.usage)
    );
  } catch {
    return false;
  }
}

function isValidMonthlyUsageInput(value: unknown): value is ClinicMonthlyUsageInput {
  try {
    const input = asPlainRecord(value);
    if (!input || Reflect.ownKeys(input).length !== 2) return false;
    return (
      typeof input.clinicId === "string" &&
      UUID_PATTERN.test(input.clinicId) &&
      typeof input.monthStart === "string" &&
      MONTH_START_PATTERN.test(input.monthStart) &&
      input.monthStart.slice(0, 4) !== "0000" &&
      !Number.isNaN(Date.parse(`${input.monthStart}T00:00:00.000Z`))
    );
  } catch {
    return false;
  }
}

function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

function buildEndpoint(env: Env, rpcName: string): URL | null {
  if (
    typeof env.SUPABASE_URL !== "string" ||
    typeof env.SUPABASE_SERVICE_ROLE_KEY !== "string" ||
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
 * Calls the `record_intake_ai_usage_v1` Data API RPC over native fetch. Never
 * logs the request/response body. clinic_id and both hashes are derived
 * inside the RPC from the claimed conversation/provider-message identity --
 * this client never computes or sends them.
 */
export async function recordIntakeAiUsageV1(input: RecordIntakeAiUsageInput, env: Env): Promise<RecordIntakeAiUsageResult> {
  let snapshot: RecordIntakeAiUsageInput;
  try {
    const inputRecord = asPlainRecord(input);
    if (!inputRecord || Reflect.ownKeys(inputRecord).length !== 6) return failedRecord();
    const usage = input.usage;
    if (usage !== null) {
      const usageRecord = asPlainRecord(usage);
      if (!usageRecord || Reflect.ownKeys(usageRecord).length !== 3) return failedRecord();
    }
    snapshot = {
      conversationId: input.conversationId,
      providerMessageId: input.providerMessageId,
      claimToken: input.claimToken,
      model: input.model,
      promptVersion: input.promptVersion,
      usage: usage === null ? null : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens },
    };
  } catch {
    return failedRecord();
  }
  if (!isValidRecordInput(snapshot)) return failedRecord();
  const endpoint = buildEndpoint(env, "record_intake_ai_usage_v1");
  if (!endpoint) return failedRecord();

  const rows = await callRpc(endpoint, env, {
    p_conversation_id: snapshot.conversationId,
    p_provider_message_id: snapshot.providerMessageId,
    p_claim_token: snapshot.claimToken,
    p_model: snapshot.model,
    p_prompt_version: snapshot.promptVersion,
    p_input_tokens: snapshot.usage === null ? null : snapshot.usage.inputTokens,
    p_output_tokens: snapshot.usage === null ? null : snapshot.usage.outputTokens,
    p_total_tokens: snapshot.usage === null ? null : snapshot.usage.totalTokens,
  });
  if (rows === null || rows.length !== 1) return failedRecord();

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 1) return failedRecord();
    const { result } = row;
    return result === "recorded" || result === "duplicate" || result === "stale_claim" || result === "not_found"
      ? { kind: result }
      : failedRecord();
  } catch {
    return failedRecord();
  }
}

/** Calls the `get_clinic_monthly_usage_v1` Data API RPC over native fetch. Never logs the request/response body. */
export async function getClinicMonthlyUsageV1(input: ClinicMonthlyUsageInput, env: Env): Promise<ClinicMonthlyUsageResult> {
  let snapshot: ClinicMonthlyUsageInput;
  try {
    const inputRecord = asPlainRecord(input);
    if (!inputRecord || Reflect.ownKeys(inputRecord).length !== 2) return failedMonthlyUsage();
    snapshot = { clinicId: input.clinicId, monthStart: input.monthStart };
  } catch {
    return failedMonthlyUsage();
  }
  if (!isValidMonthlyUsageInput(snapshot)) return failedMonthlyUsage();
  const endpoint = buildEndpoint(env, "get_clinic_monthly_usage_v1");
  if (!endpoint) return failedMonthlyUsage();

  const rows = await callRpc(endpoint, env, { p_clinic_id: snapshot.clinicId, p_month_start: snapshot.monthStart });
  if (rows === null || rows.length !== 1) return failedMonthlyUsage();

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 10) return failedMonthlyUsage();
    const {
      result,
      clinic_id: clinicId,
      period_start: periodStart,
      period_end: periodEnd,
      ai_turn_count: aiTurnCount,
      ai_touched_conversation_count: aiTouchedConversationCount,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      missing_token_usage_count: missingTokenUsageCount,
    } = row;

    if (result !== "reported" && result !== "clinic_not_found") return failedMonthlyUsage();
    const expectedPeriodEnd = new Date(`${snapshot.monthStart}T00:00:00.000Z`);
    expectedPeriodEnd.setUTCMonth(expectedPeriodEnd.getUTCMonth() + 1);
    const expectedPeriodEndText = expectedPeriodEnd.toISOString().slice(0, 10);
    if (clinicId !== snapshot.clinicId || periodStart !== snapshot.monthStart || periodEnd !== expectedPeriodEndText) {
      return failedMonthlyUsage();
    }
    if (
      !isNonnegativeSafeInteger(aiTurnCount) ||
      !isNonnegativeSafeInteger(aiTouchedConversationCount) ||
      !isNonnegativeSafeInteger(inputTokens) ||
      !isNonnegativeSafeInteger(outputTokens) ||
      !isNonnegativeSafeInteger(totalTokens) ||
      !isNonnegativeSafeInteger(missingTokenUsageCount)
    ) {
      return failedMonthlyUsage();
    }
    if (aiTouchedConversationCount > aiTurnCount || missingTokenUsageCount > aiTurnCount) return failedMonthlyUsage();
    if (
      result === "clinic_not_found" &&
      [aiTurnCount, aiTouchedConversationCount, inputTokens, outputTokens, totalTokens, missingTokenUsageCount]
        .some((count) => count !== 0)
    ) return failedMonthlyUsage();

    return {
      kind: result,
      clinicId,
      periodStart,
      periodEnd,
      aiTurnCount,
      aiTouchedConversationCount,
      inputTokens,
      outputTokens,
      totalTokens,
      missingTokenUsageCount,
    };
  } catch {
    return failedMonthlyUsage();
  }
}
