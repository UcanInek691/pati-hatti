import { INTAKE_EXTRACTION_SYSTEM_PROMPT } from "../prompts/intake-extraction-prompt";
import { parseIntakeExtraction, type IntakeExtraction } from "./intakeExtraction";
import type { Env } from "./env";

export const OPENAI_INTAKE_MODEL = "gpt-5.6-luna";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_MESSAGE_CODE_POINTS = 65536;

export type OpenAiIntakeResult = { ok: true; extraction: IntakeExtraction } | { ok: false };

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
 * Sends one untrusted WhatsApp message to the OpenAI Responses API for
 * structured intake extraction and returns only a Task 007
 * runtime-validated `IntakeExtraction`. Never logs the message, the API key,
 * or any provider response content.
 */
export async function extractIntakeViaOpenAi(
  message: string,
  safetyIdentifier: string,
  env: Env,
): Promise<OpenAiIntakeResult> {
  const apiKey = env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") return { ok: false };
  if (message === "" || codePointLength(message) > MAX_MESSAGE_CODE_POINTS) return { ok: false };
  if (safetyIdentifier.trim() === "") return { ok: false };

  let response: Response;
  try {
    response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_INTAKE_MODEL,
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
    });
  } catch {
    return { ok: false };
  }

  if (!response.ok) return { ok: false };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false };
  }

  const text = extractOutputText(payload);
  if (text === null) return { ok: false };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    return { ok: false };
  }

  const result = parseIntakeExtraction(parsedJson);
  if (!result.ok) return { ok: false };

  return { ok: true, extraction: result.value };
}
