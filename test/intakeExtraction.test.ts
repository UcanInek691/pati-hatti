import { describe, expect, it } from "vitest";
import { parseIntakeExtraction, resolvePet } from "../src/intakeExtraction";
import type { IntakeExtraction } from "../src/intakeExtraction";
import type { IntakePet } from "../src/conversationState";

function validSafetySignals(overrides: Record<string, unknown> = {}) {
  return {
    breathing_difficulty: false,
    loss_of_consciousness: false,
    active_seizure: null,
    heavy_bleeding: false,
    major_trauma: null,
    possible_toxin_exposure: null,
    possible_foreign_object: null,
    unable_to_urinate: null,
    ...overrides,
  };
}

function validExtraction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: "report_symptom",
    pet_name: "Waffles",
    species: "dog",
    complaint: "limping on the front leg",
    symptoms: ["limping", "whining"],
    reported_safety_signals: validSafetySignals(),
    missing_information: ["duration"],
    user_requested_human: false,
    ...overrides,
  };
}

describe("parseIntakeExtraction", () => {
  it("accepts a fully populated valid extraction", () => {
    const result = parseIntakeExtraction(validExtraction());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      intent: "report_symptom",
      pet_name: "Waffles",
      species: "dog",
      complaint: "limping on the front leg",
      symptoms: ["limping", "whining"],
      reported_safety_signals: validSafetySignals(),
      missing_information: ["duration"],
      user_requested_human: false,
    });
  });

  it("accepts nullable and empty-list boundaries", () => {
    const result = parseIntakeExtraction(
      validExtraction({
        pet_name: null,
        species: null,
        complaint: null,
        symptoms: [],
        missing_information: [],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pet_name).toBeNull();
    expect(result.value.species).toBeNull();
    expect(result.value.complaint).toBeNull();
    expect(result.value.symptoms).toEqual([]);
    expect(result.value.missing_information).toEqual([]);
  });

  it.each(["intent", "pet_name", "species", "complaint", "symptoms", "reported_safety_signals", "missing_information", "user_requested_human"])(
    "rejects a missing %s field",
    (key) => {
      const input = validExtraction();
      delete input[key];
      expect(parseIntakeExtraction(input).ok).toBe(false);
    },
  );

  it("rejects an extra field", () => {
    expect(parseIntakeExtraction(validExtraction({ extra_field: "nope" })).ok).toBe(false);
  });

  it.each([
    ["a non-plain-object value", "not an object"],
    ["an array", ["not", "an", "object"]],
    ["null", null],
    ["a Date instance", new Date()],
    ["a class instance", new (class ModelOutput {})()],
  ])("rejects %s at the top level", (_label, value) => {
    expect(parseIntakeExtraction(value).ok).toBe(false);
  });

  it("fails closed when an untrusted object throws during inspection", () => {
    const input = new Proxy({}, { getPrototypeOf: () => { throw new Error("trap"); } });
    expect(parseIntakeExtraction(input)).toEqual({ ok: false });
  });

  it.each([
    ["intent as a number", validExtraction({ intent: 1 })],
    ["intent as an invalid enum value", validExtraction({ intent: "not_a_real_intent" })],
    ["pet_name as a number", validExtraction({ pet_name: 5 })],
    ["symptoms as a non-array", validExtraction({ symptoms: "limping" })],
    ["reported_safety_signals as an array", validExtraction({ reported_safety_signals: [] })],
    ["missing_information as a string", validExtraction({ missing_information: "duration" })],
    ["user_requested_human as a string", validExtraction({ user_requested_human: "true" })],
  ])("rejects %s", (_label, input) => {
    expect(parseIntakeExtraction(input).ok).toBe(false);
  });

  it("trims a nullable text field and preserves internal characters", () => {
    const result = parseIntakeExtraction(validExtraction({ pet_name: "  Waffles  " }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pet_name).toBe("Waffles");
  });

  it("accepts a nullable text field at exactly the 100 code point limit, counted by code point", () => {
    const name = "😀".repeat(100);
    const result = parseIntakeExtraction(validExtraction({ pet_name: name }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pet_name).toBe(name);
  });

  it("rejects a nullable text field one code point over the 100 limit", () => {
    expect(parseIntakeExtraction(validExtraction({ pet_name: "😀".repeat(101) })).ok).toBe(false);
  });

  it("rejects a nullable text field that trims to empty", () => {
    expect(parseIntakeExtraction(validExtraction({ pet_name: "   " })).ok).toBe(false);
  });

  it("accepts a complaint at exactly the 2000 code point limit", () => {
    const complaint = "a".repeat(2000);
    const result = parseIntakeExtraction(validExtraction({ complaint }));
    expect(result.ok).toBe(true);
  });

  it("rejects a complaint one code point over the 2000 limit", () => {
    expect(parseIntakeExtraction(validExtraction({ complaint: "a".repeat(2001) })).ok).toBe(false);
  });

  it("rejects a sparse symptoms array", () => {
    const sparse: unknown[] = new Array(2);
    sparse[1] = "limping";
    expect(parseIntakeExtraction(validExtraction({ symptoms: sparse })).ok).toBe(false);
  });

  it("rejects more than 20 symptoms", () => {
    const symptoms = Array.from({ length: 21 }, (_, i) => `symptom-${i}`);
    expect(parseIntakeExtraction(validExtraction({ symptoms })).ok).toBe(false);
  });

  it("accepts a symptom at exactly the 100 code point limit", () => {
    const result = parseIntakeExtraction(validExtraction({ symptoms: ["😀".repeat(100)] }));
    expect(result.ok).toBe(true);
  });

  it("rejects a symptom one code point over the 100 limit", () => {
    expect(parseIntakeExtraction(validExtraction({ symptoms: ["😀".repeat(101)] })).ok).toBe(false);
  });

  it("rejects duplicate symptoms", () => {
    expect(parseIntakeExtraction(validExtraction({ symptoms: ["cough", "cough"] })).ok).toBe(false);
  });

  it("rejects symptoms that are duplicates only after trimming", () => {
    expect(parseIntakeExtraction(validExtraction({ symptoms: ["cough", " cough "] })).ok).toBe(false);
  });

  it("rejects duplicate missing_information values", () => {
    expect(parseIntakeExtraction(validExtraction({ missing_information: ["duration", "duration"] })).ok).toBe(false);
  });

  it("trims missing_information values", () => {
    const result = parseIntakeExtraction(validExtraction({ missing_information: [" duration "] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.missing_information).toEqual(["duration"]);
  });

  it("rejects duplicate missing_information values after trimming", () => {
    expect(parseIntakeExtraction(validExtraction({ missing_information: ["duration", " duration "] })).ok).toBe(false);
  });

  it("rejects an invalid missing_information enum value", () => {
    expect(parseIntakeExtraction(validExtraction({ missing_information: ["not_a_real_field"] })).ok).toBe(false);
  });

  it("rejects reported_safety_signals with a missing key", () => {
    const signals = validSafetySignals();
    delete (signals as Record<string, unknown>).active_seizure;
    expect(parseIntakeExtraction(validExtraction({ reported_safety_signals: signals })).ok).toBe(false);
  });

  it("rejects reported_safety_signals with an extra key", () => {
    expect(parseIntakeExtraction(validExtraction({ reported_safety_signals: validSafetySignals({ extra: true }) })).ok).toBe(false);
  });

  it("rejects reported_safety_signals with a non-boolean, non-null value", () => {
    expect(parseIntakeExtraction(validExtraction({ reported_safety_signals: validSafetySignals({ heavy_bleeding: "yes" }) })).ok).toBe(false);
  });

  it("does not mutate the caller's input value", () => {
    const input = validExtraction();
    const snapshot = JSON.parse(JSON.stringify(input));
    const result = parseIntakeExtraction(input);
    expect(input).toEqual(snapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.symptoms).not.toBe(input.symptoms);
    expect(result.value.reported_safety_signals).not.toBe(input.reported_safety_signals);
    expect(result.value.missing_information).not.toBe(input.missing_information);
  });
});

describe("resolvePet", () => {
  function extraction(petName: string | null): IntakeExtraction {
    return {
      intent: "report_symptom",
      pet_name: petName,
      species: null,
      complaint: null,
      symptoms: [],
      reported_safety_signals: validSafetySignals() as IntakeExtraction["reported_safety_signals"],
      missing_information: [],
      user_requested_human: false,
    };
  }

  const waffles: IntakePet = { id: "pet-1", name: "Waffles", species: "dog" };
  const mochi: IntakePet = { id: "pet-2", name: "Mochi", species: "cat" };

  it("matches an exact pet name", () => {
    expect(resolvePet(extraction("Waffles"), [waffles, mochi])).toEqual({ kind: "matched", petId: "pet-1" });
  });

  it("matches case-insensitively using Turkish locale rules", () => {
    const ipek: IntakePet = { id: "pet-3", name: "ipek", species: "cat" };
    expect(resolvePet(extraction("İpek"), [ipek])).toEqual({ kind: "matched", petId: "pet-3" });
  });

  it("matches after Unicode normalization and whitespace collapsing", () => {
    const mrsWhiskers: IntakePet = { id: "pet-4", name: "Mrs Whiskers", species: "cat" };
    expect(resolvePet(extraction("  mrs   whiskers  "), [mrsWhiskers])).toEqual({ kind: "matched", petId: "pet-4" });
  });

  it("falls back to the single known pet when no name is given", () => {
    expect(resolvePet(extraction(null), [waffles])).toEqual({ kind: "matched", petId: "pet-1" });
  });

  it("requires clarification when no name is given and there are zero pets", () => {
    expect(resolvePet(extraction(null), [])).toEqual({ kind: "needs_clarification" });
  });

  it("requires clarification when no name is given and there are multiple pets", () => {
    expect(resolvePet(extraction(null), [waffles, mochi])).toEqual({ kind: "needs_clarification" });
  });

  it("requires clarification when an explicit name matches zero pets", () => {
    expect(resolvePet(extraction("Ghost"), [waffles, mochi])).toEqual({ kind: "needs_clarification" });
  });

  it("requires clarification when an explicit name matches duplicate normalized names", () => {
    const duplicate: IntakePet = { id: "pet-5", name: "waffles", species: "dog" };
    expect(resolvePet(extraction("Waffles"), [waffles, duplicate])).toEqual({ kind: "needs_clarification" });
  });

  it("never fuzzy-matches a near-miss name", () => {
    expect(resolvePet(extraction("Waffle"), [waffles])).toEqual({ kind: "needs_clarification" });
  });
});
