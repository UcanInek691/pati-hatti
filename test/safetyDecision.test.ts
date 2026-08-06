import { describe, expect, it } from "vitest";
import type { IntakeExtraction, ReportedSafetySignals } from "../src/intakeExtraction";
import { evaluateSafetyDecision, type SafetySignal } from "../src/safetyDecision";

const CANONICAL_ORDER: SafetySignal[] = [
  "breathing_difficulty",
  "loss_of_consciousness",
  "active_seizure",
  "heavy_bleeding",
  "major_trauma",
  "possible_toxin_exposure",
  "possible_foreign_object",
  "unable_to_urinate",
];

function allFalseSignals(): ReportedSafetySignals {
  return {
    breathing_difficulty: false,
    loss_of_consciousness: false,
    active_seizure: false,
    heavy_bleeding: false,
    major_trauma: false,
    possible_toxin_exposure: false,
    possible_foreign_object: false,
    unable_to_urinate: false,
  };
}

function allNullSignals(): ReportedSafetySignals {
  return {
    breathing_difficulty: null,
    loss_of_consciousness: null,
    active_seizure: null,
    heavy_bleeding: null,
    major_trauma: null,
    possible_toxin_exposure: null,
    possible_foreign_object: null,
    unable_to_urinate: null,
  };
}

function baseExtraction(overrides: Partial<IntakeExtraction> = {}): IntakeExtraction {
  return {
    intent: "report_symptom",
    pet_name: "Boncuk",
    species: "dog",
    complaint: "vomiting since this morning",
    symptoms: ["vomiting"],
    reported_safety_signals: allFalseSignals(),
    missing_information: [],
    user_requested_human: false,
    ...overrides,
  };
}

describe("evaluateSafetyDecision — emergency signals", () => {
  for (const signal of CANONICAL_ORDER) {
    it(`returns emergency_handoff when only ${signal} is true`, () => {
      const signals = { ...allFalseSignals(), [signal]: true };
      const decision = evaluateSafetyDecision(baseExtraction({ reported_safety_signals: signals }));
      expect(decision).toEqual({ kind: "emergency_handoff", positiveSignals: [signal] });
    });
  }

  it("preserves canonical order for multiple true signals and returns a fresh array", () => {
    const signals = {
      ...allFalseSignals(),
      unable_to_urinate: true,
      breathing_difficulty: true,
      active_seizure: true,
    };
    const extraction = baseExtraction({ reported_safety_signals: signals });

    const first = evaluateSafetyDecision(extraction);
    const second = evaluateSafetyDecision(extraction);

    expect(first).toEqual({
      kind: "emergency_handoff",
      positiveSignals: ["breathing_difficulty", "active_seizure", "unable_to_urinate"],
    });
    expect(second).toEqual(first);
    expect(first).not.toBe(second);
    if (first.kind === "emergency_handoff" && second.kind === "emergency_handoff") {
      expect(first.positiveSignals).not.toBe(second.positiveSignals);
    }
  });

  it("overrides human request, medical-advice intent, and unknown signals", () => {
    const signals = { ...allNullSignals(), major_trauma: true };
    const extraction = baseExtraction({
      intent: "medical_advice_request",
      user_requested_human: true,
      reported_safety_signals: signals,
    });
    expect(evaluateSafetyDecision(extraction)).toEqual({
      kind: "emergency_handoff",
      positiveSignals: ["major_trauma"],
    });
  });
});

describe("evaluateSafetyDecision — human handoff", () => {
  it("routes on user_requested_human over unknown signals", () => {
    const extraction = baseExtraction({ user_requested_human: true, reported_safety_signals: allNullSignals() });
    expect(evaluateSafetyDecision(extraction)).toEqual({ kind: "human_handoff", reason: "user_requested_human" });
  });

  it("routes on intent human_handoff over unknown signals", () => {
    const extraction = baseExtraction({ intent: "human_handoff", reported_safety_signals: allNullSignals() });
    expect(evaluateSafetyDecision(extraction)).toEqual({ kind: "human_handoff", reason: "user_requested_human" });
  });

  it("routes medical_advice_request over unknown signals", () => {
    const extraction = baseExtraction({
      intent: "medical_advice_request",
      reported_safety_signals: allNullSignals(),
    });
    expect(evaluateSafetyDecision(extraction)).toEqual({ kind: "human_handoff", reason: "medical_advice_request" });
  });
});

describe("evaluateSafetyDecision — unknown signals", () => {
  it("returns every null key in canonical order when all signals are null", () => {
    const extraction = baseExtraction({ reported_safety_signals: allNullSignals() });
    expect(evaluateSafetyDecision(extraction)).toEqual({
      kind: "needs_safety_check",
      unknownSignals: [...CANONICAL_ORDER],
    });
  });

  it("returns every null key in canonical order for a mixed false/null input", () => {
    const signals = {
      ...allFalseSignals(),
      major_trauma: null,
      breathing_difficulty: null,
    };
    const extraction = baseExtraction({ reported_safety_signals: signals });
    expect(evaluateSafetyDecision(extraction)).toEqual({
      kind: "needs_safety_check",
      unknownSignals: ["breathing_difficulty", "major_trauma"],
    });
  });
});

describe("evaluateSafetyDecision — continue and isolation", () => {
  it("returns continue_intake only when every signal is explicitly false", () => {
    const extraction = baseExtraction();
    expect(evaluateSafetyDecision(extraction)).toEqual({ kind: "continue_intake" });
  });

  it("is unaffected by complaint, symptoms, species, pet_name, and missing_information", () => {
    const extraction = baseExtraction({
      complaint: null,
      symptoms: [],
      species: null,
      pet_name: null,
      missing_information: ["pet_identity", "species", "complaint"],
    });
    expect(evaluateSafetyDecision(extraction)).toEqual({ kind: "continue_intake" });
  });

  it("does not mutate the extraction it is given", () => {
    const extraction = baseExtraction({ reported_safety_signals: allNullSignals() });
    Object.freeze(extraction.reported_safety_signals);
    Object.freeze(extraction);
    expect(() => evaluateSafetyDecision(extraction)).not.toThrow();
    expect(extraction.reported_safety_signals).toEqual(allNullSignals());
  });
});
