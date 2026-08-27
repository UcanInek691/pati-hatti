import type { IntakePet } from "./conversationState";

export type IntakeIntent =
  | "report_symptom"
  | "routine_request"
  | "appointment_request"
  | "human_handoff"
  | "medical_advice_request"
  | "unknown";

export interface ReportedSafetySignals {
  breathing_difficulty: boolean | null;
  loss_of_consciousness: boolean | null;
  active_seizure: boolean | null;
  heavy_bleeding: boolean | null;
  major_trauma: boolean | null;
  possible_toxin_exposure: boolean | null;
  possible_foreign_object: boolean | null;
  unable_to_urinate: boolean | null;
}

export type MissingInformationItem =
  | "pet_identity"
  | "species"
  | "complaint"
  | "duration"
  | "water_intake"
  | "breathing_status"
  | "blood_presence"
  | "consciousness"
  | "toxin_or_foreign_object";

export interface IntakeExtraction {
  intent: IntakeIntent;
  pet_name: string | null;
  species: string | null;
  complaint: string | null;
  symptoms: string[];
  reported_safety_signals: ReportedSafetySignals;
  missing_information: MissingInformationItem[];
  user_requested_human: boolean;
}

export type ParseResult = { ok: true; value: IntakeExtraction } | { ok: false };

export type PetResolution =
  | { kind: "matched"; petId: string }
  | { kind: "needs_clarification" }
  | { kind: "new_candidate" };

const INTENTS = new Set<string>([
  "report_symptom",
  "routine_request",
  "appointment_request",
  "human_handoff",
  "medical_advice_request",
  "unknown",
]);

const MISSING_INFORMATION_VALUES = new Set<string>([
  "pet_identity",
  "species",
  "complaint",
  "duration",
  "water_intake",
  "breathing_status",
  "blood_presence",
  "consciousness",
  "toxin_or_foreign_object",
]);

const SAFETY_SIGNAL_KEYS = [
  "breathing_difficulty",
  "loss_of_consciousness",
  "active_seizure",
  "heavy_bleeding",
  "major_trauma",
  "possible_toxin_exposure",
  "possible_foreign_object",
  "unable_to_urinate",
] as const;

const REQUIRED_KEYS = [
  "intent",
  "pet_name",
  "species",
  "complaint",
  "symptoms",
  "reported_safety_signals",
  "missing_information",
  "user_requested_human",
] as const;

const MAX_NAME_LENGTH = 100;
const MAX_COMPLAINT_LENGTH = 2000;
const MAX_SYMPTOM_LENGTH = 100;
const MAX_SYMPTOMS = 20;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) {
    if (!(i in value)) return false;
  }
  return true;
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function parseNullableText(value: unknown, maxCodePoints: number): { ok: true; value: string | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  const length = codePointLength(trimmed);
  if (length < 1 || length > maxCodePoints) return { ok: false };
  return { ok: true, value: trimmed };
}

function parseSymptoms(value: unknown): { ok: true; value: string[] } | { ok: false } {
  if (!isDenseArray(value) || value.length > MAX_SYMPTOMS) return { ok: false };

  const symptoms: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return { ok: false };
    const trimmed = item.trim();
    const length = codePointLength(trimmed);
    if (length < 1 || length > MAX_SYMPTOM_LENGTH) return { ok: false };
    if (seen.has(trimmed)) return { ok: false };
    seen.add(trimmed);
    symptoms.push(trimmed);
  }
  return { ok: true, value: symptoms };
}

function parseMissingInformation(value: unknown): { ok: true; value: MissingInformationItem[] } | { ok: false } {
  if (!isDenseArray(value)) return { ok: false };

  const items: MissingInformationItem[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return { ok: false };
    const trimmed = item.trim();
    if (!MISSING_INFORMATION_VALUES.has(trimmed) || seen.has(trimmed)) return { ok: false };
    seen.add(trimmed);
    items.push(trimmed as MissingInformationItem);
  }
  return { ok: true, value: items };
}

function parseSafetySignals(value: unknown): { ok: true; value: ReportedSafetySignals } | { ok: false } {
  if (!isPlainObject(value)) return { ok: false };
  const keys = Object.keys(value);
  if (keys.length !== SAFETY_SIGNAL_KEYS.length || !SAFETY_SIGNAL_KEYS.every((key) => key in value)) return { ok: false };

  const signals = {} as ReportedSafetySignals;
  for (const key of SAFETY_SIGNAL_KEYS) {
    const signalValue = value[key];
    if (signalValue !== null && typeof signalValue !== "boolean") return { ok: false };
    signals[key] = signalValue as boolean | null;
  }
  return { ok: true, value: signals };
}

/**
 * Validates and normalizes untrusted (model-produced) JSON against the intake
 * extraction contract. Rejects wrong shapes rather than coercing them; never
 * mutates the input value.
 */
function parseIntakeExtractionValue(value: unknown): ParseResult {
  if (!isPlainObject(value)) return { ok: false };

  const keys = Object.keys(value);
  if (keys.length !== REQUIRED_KEYS.length || !REQUIRED_KEYS.every((key) => keys.includes(key))) return { ok: false };

  const intent = value.intent;
  if (typeof intent !== "string" || !INTENTS.has(intent)) return { ok: false };

  const petName = parseNullableText(value.pet_name, MAX_NAME_LENGTH);
  if (!petName.ok) return { ok: false };

  const species = parseNullableText(value.species, MAX_NAME_LENGTH);
  if (!species.ok) return { ok: false };

  const complaint = parseNullableText(value.complaint, MAX_COMPLAINT_LENGTH);
  if (!complaint.ok) return { ok: false };

  const symptoms = parseSymptoms(value.symptoms);
  if (!symptoms.ok) return { ok: false };

  const reportedSafetySignals = parseSafetySignals(value.reported_safety_signals);
  if (!reportedSafetySignals.ok) return { ok: false };

  const missingInformation = parseMissingInformation(value.missing_information);
  if (!missingInformation.ok) return { ok: false };

  const userRequestedHuman = value.user_requested_human;
  if (typeof userRequestedHuman !== "boolean") return { ok: false };

  return {
    ok: true,
    value: {
      intent: intent as IntakeIntent,
      pet_name: petName.value,
      species: species.value,
      complaint: complaint.value,
      symptoms: symptoms.value,
      reported_safety_signals: reportedSafetySignals.value,
      missing_information: missingInformation.value,
      user_requested_human: userRequestedHuman,
    },
  };
}

export function parseIntakeExtraction(value: unknown): ParseResult {
  try {
    return parseIntakeExtractionValue(value);
  } catch {
    return { ok: false };
  }
}

function normalizeForComparison(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("tr");
}

/**
 * Resolves a validated extraction's pet reference against the conversation's
 * already-loaded pets. Exact match only after Unicode/Turkish-case
 * normalization; never fuzzy-matches and never trusts a model-supplied id.
 */
export function resolvePet(extraction: IntakeExtraction, pets: readonly IntakePet[]): PetResolution {
  if (extraction.pet_name !== null) {
    const target = normalizeForComparison(extraction.pet_name);
    const matches = pets.filter((pet) => normalizeForComparison(pet.name) === target);
    if (matches.length === 1) return { kind: "matched", petId: matches[0]!.id };
    if (matches.length === 0) return { kind: "new_candidate" };
    return { kind: "needs_clarification" };
  }
  return pets.length === 1 ? { kind: "matched", petId: pets[0]!.id } : { kind: "needs_clarification" };
}
