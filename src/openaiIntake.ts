import { INTAKE_EXTRACTION_SYSTEM_PROMPT } from "../prompts/intake-extraction-prompt";
import { parseIntakeExtraction, type IntakeExtraction } from "./intakeExtraction";
import type { Env } from "./env";

export const OPENAI_INTAKE_MODEL = "gpt-5.6-luna";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_MESSAGE_CODE_POINTS = 65536;
const REQUEST_TIMEOUT_MS = 30_000;

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export type OpenAiIntakeResult = { ok: true; extraction: IntakeExtraction } | { ok: false };

export type OpenAiIntakeUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type OpenAiIntakeEvaluationResult =
  | { ok: true; extraction: IntakeExtraction; model: EvaluationModel; elapsedMs: number; usage: OpenAiIntakeUsage | null }
  | { ok: false; model: EvaluationModel; elapsedMs: number };

export type OpenAiIntakeCredentials = { OPENAI_API_KEY: string | undefined };

export const EVALUATION_MODELS = Object.freeze(["gpt-5.6-luna", "gpt-5.6-terra"] as const);
export type EvaluationModel = "gpt-5.6-luna" | "gpt-5.6-terra";

const SAFETY_SIGNAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "breathing_difficulty",
    "loss_of_consciousness",
    "active_seizure",
    "heavy_bleeding",
    "major_trauma",
    "possible_toxin_exposure",
    "possible_foreign_object",
    "unable_to_urinate",
  ],
  properties: {
    breathing_difficulty: { type: ["boolean", "null"] },
    loss_of_consciousness: { type: ["boolean", "null"] },
    active_seizure: { type: ["boolean", "null"] },
    heavy_bleeding: { type: ["boolean", "null"] },
    major_trauma: { type: ["boolean", "null"] },
    possible_toxin_exposure: { type: ["boolean", "null"] },
    possible_foreign_object: { type: ["boolean", "null"] },
    unable_to_urinate: { type: ["boolean", "null"] },
  },
};

const INTAKE_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "intent",
    "pet_name",
    "species",
    "complaint",
    "symptoms",
    "reported_safety_signals",
    "missing_information",
    "user_requested_human",
  ],
  properties: {
    intent: {
      type: "string",
      enum: [
        "report_symptom",
        "routine_request",
        "appointment_request",
        "human_handoff",
        "medical_advice_request",
        "unknown",
      ],
    },
    pet_name: { type: ["string", "null"] },
    species: { type: ["string", "null"] },
    complaint: { type: ["string", "null"] },
    symptoms: { type: "array", items: { type: "string" } },
    reported_safety_signals: SAFETY_SIGNAL_SCHEMA,
    missing_information: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "pet_identity",
          "species",
          "complaint",
          "duration",
          "water_intake",
          "breathing_status",
          "blood_presence",
          "consciousness",
          "toxin_or_foreign_object",
        ],
      },
    },
    user_requested_human: { type: "boolean" },
  },
};

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function extractUsage(payload: unknown): OpenAiIntakeUsage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const usage = (payload as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const record = usage as Record<string, unknown>;
  const inputTokens = record.input_tokens;
  const outputTokens = record.output_tokens;
  const totalTokens = record.total_tokens;
  if (
    !isNonnegativeSafeInteger(inputTokens) ||
    !isNonnegativeSafeInteger(outputTokens) ||
    !isNonnegativeSafeInteger(totalTokens)
  ) {
    return null;
  }
  return { inputTokens, outputTokens, totalTokens };
}

function extractOutputText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (record.status !== "completed") return null;

  const output = record.output;
  if (!Array.isArray(output)) return null;

  const messages = output.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "message",
  );
  if (messages.length !== 1) return null;

  const content = messages[0]!.content;
  if (!Array.isArray(content) || content.length !== 1) return null;

  const item = content[0];
  if (typeof item !== "object" || item === null) return null;
  const itemRecord = item as Record<string, unknown>;
  if (itemRecord.type !== "output_text" || typeof itemRecord.text !== "string") return null;

  return itemRecord.text;
}

/**
 * Sends one untrusted message to the OpenAI Responses API for structured
 * intake extraction and returns only a Task 007 runtime-validated
 * `IntakeExtraction`, plus evaluation-only timing/usage metadata. Never logs
 * the message, the API key, or any provider response content. Shared by the
 * production Luna wrapper and the closed evaluation-only entry point.
 */
async function callOpenAiForIntake(
  message: string,
  safetyIdentifier: string,
  model: EvaluationModel,
  credentials: OpenAiIntakeCredentials,
): Promise<OpenAiIntakeEvaluationResult> {
  const apiKey = credentials.OPENAI_API_KEY;
  const startedAt = Date.now();
  if (apiKey === undefined || apiKey.trim() === "") return { ok: false, model, elapsedMs: Date.now() - startedAt };
  if (message === "" || codePointLength(message) > MAX_MESSAGE_CODE_POINTS) {
    return { ok: false, model, elapsedMs: Date.now() - startedAt };
  }
  if (safetyIdentifier.trim() === "") return { ok: false, model, elapsedMs: Date.now() - startedAt };

  let response: Response;
  try {
    response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: INTAKE_EXTRACTION_SYSTEM_PROMPT },
          { role: "user", content: message },
        ],
        safety_identifier: safetyIdentifier,
        store: false,
        reasoning: { effort: "none", context: "current_turn" },
        max_output_tokens: 1200,
        text: {
          format: {
            type: "json_schema",
            name: "vetai_intake_extraction",
            strict: true,
            schema: INTAKE_EXTRACTION_JSON_SCHEMA,
          },
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, model, elapsedMs: Date.now() - startedAt };
  }

  if (!response.ok) return { ok: false, model, elapsedMs: Date.now() - startedAt };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, model, elapsedMs: Date.now() - startedAt };
  }

  const text = extractOutputText(payload);
  if (text === null) return { ok: false, model, elapsedMs: Date.now() - startedAt };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    return { ok: false, model, elapsedMs: Date.now() - startedAt };
  }

  const result = parseIntakeExtraction(parsedJson);
  if (!result.ok) return { ok: false, model, elapsedMs: Date.now() - startedAt };

  return {
    ok: true,
    extraction: result.value,
    model,
    elapsedMs: Date.now() - startedAt,
    usage: extractUsage(payload),
  };
}

/**
 * Sends one untrusted WhatsApp message to the OpenAI Responses API for
 * structured intake extraction and returns only a Task 007
 * runtime-validated `IntakeExtraction`. Never logs the message, the API key,
 * or any provider response content. Always uses the production Luna model.
 */
export async function extractIntakeViaOpenAi(
  message: string,
  safetyIdentifier: string,
  env: Env,
): Promise<OpenAiIntakeResult> {
  const result = await callOpenAiForIntake(message, safetyIdentifier, OPENAI_INTAKE_MODEL, {
    OPENAI_API_KEY: env.OPENAI_API_KEY,
  });
  if (!result.ok) return { ok: false };
  return { ok: true, extraction: result.extraction };
}

/**
 * Closed, evaluation-only entry point for the local live-eval harness and
 * isolated live demo. Rejects any model outside the reviewed Luna/Terra set
 * without ever calling OpenAI. Never used by production intake handling.
 */
export async function extractIntakeViaOpenAiForEvaluation(
  message: string,
  safetyIdentifier: string,
  model: EvaluationModel,
  credentials: OpenAiIntakeCredentials,
): Promise<OpenAiIntakeEvaluationResult> {
  if (!EVALUATION_MODELS.includes(model)) return { ok: false, model, elapsedMs: 0 };
  return callOpenAiForIntake(message, safetyIdentifier, model, credentials);
}
