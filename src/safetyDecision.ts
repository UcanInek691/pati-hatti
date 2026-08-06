import type { IntakeExtraction, ReportedSafetySignals } from "./intakeExtraction";

export type SafetyDecision =
  | { kind: "emergency_handoff"; positiveSignals: SafetySignal[] }
  | { kind: "human_handoff"; reason: "user_requested_human" | "medical_advice_request" }
  | { kind: "needs_safety_check"; unknownSignals: SafetySignal[] }
  | { kind: "continue_intake" };

const CANONICAL_SIGNAL_ORDER = [
  "breathing_difficulty",
  "loss_of_consciousness",
  "active_seizure",
  "heavy_bleeding",
  "major_trauma",
  "possible_toxin_exposure",
  "possible_foreign_object",
  "unable_to_urinate",
] as const satisfies readonly (keyof ReportedSafetySignals)[];

export type SafetySignal = (typeof CANONICAL_SIGNAL_ORDER)[number];
type AssertNever<T extends never> = T;
type AllSafetySignalsCovered = AssertNever<Exclude<keyof ReportedSafetySignals, SafetySignal>>;

/**
 * Deterministic, provider-neutral safety gate over an already-validated Task
 * 007 extraction. Priority order (emergency, then human/medical-advice
 * request, then unknown signals, then continue) is a safety contract, not an
 * implementation detail — do not reorder.
 */
export function evaluateSafetyDecision(extraction: IntakeExtraction): SafetyDecision {
  const signals = extraction.reported_safety_signals;

  const positiveSignals = CANONICAL_SIGNAL_ORDER.filter((key) => signals[key] === true);
  if (positiveSignals.length > 0) {
    return { kind: "emergency_handoff", positiveSignals };
  }

  if (extraction.user_requested_human === true || extraction.intent === "human_handoff") {
    return { kind: "human_handoff", reason: "user_requested_human" };
  }

  if (extraction.intent === "medical_advice_request") {
    return { kind: "human_handoff", reason: "medical_advice_request" };
  }

  const unknownSignals = CANONICAL_SIGNAL_ORDER.filter((key) => signals[key] === null);
  if (unknownSignals.length > 0) {
    return { kind: "needs_safety_check", unknownSignals };
  }

  return { kind: "continue_intake" };
}
