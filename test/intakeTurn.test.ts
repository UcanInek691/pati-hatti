import { describe, expect, it } from "vitest";
import { planIntakeTurn, readCanonicalPersistedSnapshot } from "../src/intakeTurn";
import type { PersistedIntakeData } from "../src/intakeTurn";
import type { ConversationIntakeContext, IntakePet, IntakeStage } from "../src/conversationState";
import type { IntakeExtraction, MissingInformationItem, ReportedSafetySignals } from "../src/intakeExtraction";

function safetySignals(overrides: Partial<ReportedSafetySignals> = {}): ReportedSafetySignals {
  return {
    breathing_difficulty: false,
    loss_of_consciousness: false,
    active_seizure: false,
    heavy_bleeding: false,
    major_trauma: false,
    possible_toxin_exposure: false,
    possible_foreign_object: false,
    unable_to_urinate: false,
    ...overrides,
  };
}

function extraction(overrides: Partial<IntakeExtraction> = {}): IntakeExtraction {
  return {
    intent: "unknown",
    pet_name: null,
    species: null,
    complaint: null,
    symptoms: [],
    reported_safety_signals: safetySignals(),
    missing_information: [],
    user_requested_human: false,
    ...overrides,
  };
}

function pet(id: string, name: string): IntakePet {
  return { id, name, species: "dog" };
}

function context(overrides: Partial<ConversationIntakeContext> = {}): ConversationIntakeContext {
  return {
    conversationId: "11111111-1111-1111-1111-111111111111",
    clinicId: "22222222-2222-2222-2222-222222222222",
    ownerId: "33333333-3333-3333-3333-333333333333",
    petId: null,
    status: "active",
    intakeStage: "pet_identification",
    intakeData: {},
    stateVersion: 1,
    ownerName: "Owner",
    pets: [],
    recentMessages: [],
    ...overrides,
  };
}

function asIntakeData(data: PersistedIntakeData): Record<string, unknown> {
  return data as unknown as Record<string, unknown>;
}

function validSnapshot(overrides: Partial<PersistedIntakeData> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    intent: "unknown",
    pet_name: null,
    species: null,
    complaint: null,
    symptoms: [],
    reported_safety_signals: safetySignals(),
    missing_information: [],
    user_requested_human: false,
    ...overrides,
  };
}

const ALL_STAGES: IntakeStage[] = [
  "pet_identification",
  "complaint_collection",
  "safety_check",
  "ready_for_triage",
  "appointment_offer",
  "appointment_selection",
  "appointment_confirmation",
  "human_handoff",
  "completed",
];

describe("planIntakeTurn — persisted snapshot trust boundary", () => {
  it("accepts an exact empty object as a not-yet-planned conversation", () => {
    const result = planIntakeTurn(context({ intakeData: {} }), extraction());
    expect(result.kind).toBe("planned");
  });

  it("accepts an exact valid PersistedIntakeData snapshot", () => {
    const result = planIntakeTurn(context({ intakeData: validSnapshot({ complaint: "itchy ear" }) }), extraction());
    expect(result.kind).toBe("planned");
    if (result.kind !== "planned") return;
    expect(result.intakeData.complaint).toBe("itchy ear");
  });

  it.each([
    ["an array", []],
    ["an exotic prototype", new (class Snapshot {})()],
    ["a missing key", (() => { const s = validSnapshot(); delete (s as Record<string, unknown>).complaint; return s; })()],
    ["an extra key", validSnapshot({ extra_field: "nope" } as unknown as Partial<PersistedIntakeData>)],
    ["an unknown schema version", validSnapshot({ schema_version: 2 as unknown as 1 })],
    ["malformed nested extraction data", validSnapshot({ reported_safety_signals: [] as unknown as ReportedSafetySignals })],
  ])("rejects %s and fails closed", (_label, intakeData) => {
    const result = planIntakeTurn(context({ intakeData: intakeData as Record<string, unknown> }), extraction());
    expect(result).toEqual({ kind: "failed" });
  });

  it("rejects symbol-keyed extras", () => {
    const snapshot = validSnapshot() as Record<string, unknown>;
    (snapshot as Record<symbol, unknown>)[Symbol("extra")] = "nope";
    const result = planIntakeTurn(context({ intakeData: snapshot }), extraction());
    expect(result).toEqual({ kind: "failed" });
  });

  it("rejects non-enumerable string extras", () => {
    const snapshot = validSnapshot();
    Object.defineProperty(snapshot, "hidden_extra", { value: "nope", enumerable: false });
    const result = planIntakeTurn(context({ intakeData: snapshot }), extraction());
    expect(result).toEqual({ kind: "failed" });
  });

  it("fails closed when the persisted snapshot throws during inspection", () => {
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error("trap");
        },
      },
    );
    const result = planIntakeTurn(context({ intakeData: proxy }), extraction());
    expect(result).toEqual({ kind: "failed" });
  });
});

describe("readCanonicalPersistedSnapshot — Task 029 no-model reader", () => {
  it("accepts an exact empty object as the canonical empty snapshot", () => {
    const result = readCanonicalPersistedSnapshot({});
    expect(result).toEqual({
      ok: true,
      value: validSnapshot({
        reported_safety_signals: {
          breathing_difficulty: null,
          loss_of_consciousness: null,
          active_seizure: null,
          heavy_bleeding: null,
          major_trauma: null,
          possible_toxin_exposure: null,
          possible_foreign_object: null,
          unable_to_urinate: null,
        },
      }),
    });
  });

  it("accepts an exact valid snapshot and returns a fresh equal copy", () => {
    const input = validSnapshot({ complaint: "itchy ear" });
    const result = readCanonicalPersistedSnapshot(input);
    expect(result).toEqual({ ok: true, value: input });
    if (result.ok) {
      expect(result.value).not.toBe(input);
      expect(result.value.symptoms).not.toBe(input.symptoms);
      expect(result.value.missing_information).not.toBe(input.missing_information);
      expect(result.value.reported_safety_signals).not.toBe(input.reported_safety_signals);
    }
  });

  it.each([
    ["an array", []],
    ["an exotic prototype", new (class Snapshot {})()],
    ["a missing key", (() => { const s = validSnapshot(); delete (s as Record<string, unknown>).complaint; return s; })()],
    ["an extra key", validSnapshot({ extra_field: "nope" } as unknown as Partial<PersistedIntakeData>)],
    ["an unknown schema version", validSnapshot({ schema_version: 2 as unknown as 1 })],
    ["malformed nested extraction data", validSnapshot({ reported_safety_signals: [] as unknown as ReportedSafetySignals })],
  ])("fails closed on %s", (_label, intakeData) => {
    const result = readCanonicalPersistedSnapshot(intakeData);
    expect(result).toEqual({ ok: false });
  });

  it("fails closed when the persisted snapshot throws during inspection", () => {
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error("trap");
        },
      },
    );
    expect(readCanonicalPersistedSnapshot(proxy)).toEqual({ ok: false });
  });
});

describe("planIntakeTurn — deterministic merge", () => {
  it("replaces stored intent with a non-unknown current intent, and unknown current preserves stored", () => {
    const first = planIntakeTurn(context(), extraction({ intent: "report_symptom" }));
    expect(first.kind).toBe("planned");
    if (first.kind !== "planned") return;
    expect(first.intakeData.intent).toBe("report_symptom");

    const second = planIntakeTurn(context({ intakeData: asIntakeData(first.intakeData) }), extraction({ intent: "unknown" }));
    expect(second.kind).toBe("planned");
    if (second.kind !== "planned") return;
    expect(second.intakeData.intent).toBe("report_symptom");
  });

  it("replaces stored pet_name/species/complaint with non-null current values, and null never erases them", () => {
    const first = planIntakeTurn(context(), extraction({ pet_name: "Waffles", species: "dog", complaint: "limping" }));
    if (first.kind !== "planned") throw new Error("expected planned");

    const second = planIntakeTurn(context({ intakeData: asIntakeData(first.intakeData) }), extraction({ pet_name: null, species: null, complaint: null }));
    if (second.kind !== "planned") throw new Error("expected planned");
    expect(second.intakeData.pet_name).toBe("Waffles");
    expect(second.intakeData.species).toBe("dog");
    expect(second.intakeData.complaint).toBe("limping");
  });

  it("unions symptoms, retaining order and appending only new unique values", () => {
    const first = planIntakeTurn(context(), extraction({ symptoms: ["limping", "whining"] }));
    if (first.kind !== "planned") throw new Error("expected planned");

    const second = planIntakeTurn(context({ intakeData: asIntakeData(first.intakeData) }), extraction({ symptoms: ["whining", "vomiting"] }));
    if (second.kind !== "planned") throw new Error("expected planned");
    expect(second.intakeData.symptoms).toEqual(["limping", "whining", "vomiting"]);
  });

  it("keeps only the newest 20 unique symptoms once the bound is exceeded", () => {
    const stored = validSnapshot({ symptoms: Array.from({ length: 20 }, (_, i) => `old-${i}`) });
    const result = planIntakeTurn(context({ intakeData: stored }), extraction({ symptoms: ["new-1", "new-2"] }));
    if (result.kind !== "planned") throw new Error("expected planned");
    expect(result.intakeData.symptoms).toHaveLength(20);
    expect(result.intakeData.symptoms[0]).toBe("old-2");
    expect(result.intakeData.symptoms.at(-1)).toBe("new-2");
  });

  it("keeps a sticky true safety signal even when the current turn reports null or false", () => {
    const stored = validSnapshot({ reported_safety_signals: safetySignals({ heavy_bleeding: true }) });
    const nullResult = planIntakeTurn(
      context({ intakeData: stored }),
      extraction({ reported_safety_signals: safetySignals({ heavy_bleeding: null }) }),
    );
    const falseResult = planIntakeTurn(
      context({ intakeData: stored }),
      extraction({ reported_safety_signals: safetySignals({ heavy_bleeding: false }) }),
    );
    if (nullResult.kind !== "planned" || falseResult.kind !== "planned") throw new Error("expected planned");
    expect(nullResult.intakeData.reported_safety_signals.heavy_bleeding).toBe(true);
    expect(falseResult.intakeData.reported_safety_signals.heavy_bleeding).toBe(true);
  });

  it("replaces a stored false/null safety signal with a current boolean, and current null preserves stored", () => {
    const stored = validSnapshot({ reported_safety_signals: safetySignals({ active_seizure: null }) });
    const replaced = planIntakeTurn(
      context({ intakeData: stored }),
      extraction({ reported_safety_signals: safetySignals({ active_seizure: false }) }),
    );
    const preserved = planIntakeTurn(
      context({ intakeData: validSnapshot({ reported_safety_signals: safetySignals({ active_seizure: false }) }) }),
      extraction({ reported_safety_signals: safetySignals({ active_seizure: null }) }),
    );
    if (replaced.kind !== "planned" || preserved.kind !== "planned") throw new Error("expected planned");
    expect(replaced.intakeData.reported_safety_signals.active_seizure).toBe(false);
    expect(preserved.intakeData.reported_safety_signals.active_seizure).toBe(false);
  });

  it("replaces missing_information with a fresh copy of only the current turn's list", () => {
    const stored = validSnapshot({ missing_information: ["duration"] });
    const result = planIntakeTurn(context({ intakeData: stored }), extraction({ missing_information: ["species"] }));
    if (result.kind !== "planned") throw new Error("expected planned");
    expect(result.intakeData.missing_information).toEqual(["species"]);
  });

  it("keeps user_requested_human sticky with logical OR", () => {
    const stored = validSnapshot({ user_requested_human: true });
    const result = planIntakeTurn(context({ intakeData: stored }), extraction({ user_requested_human: false }));
    if (result.kind !== "planned") throw new Error("expected planned");
    expect(result.intakeData.user_requested_human).toBe(true);
  });

  it("returns a fresh snapshot and nested arrays/objects, never a stored or extraction reference", () => {
    const storedSymptoms = ["limping"];
    const storedSignals = safetySignals();
    const storedMissing: MissingInformationItem[] = ["duration"];
    const stored = validSnapshot({ symptoms: storedSymptoms, reported_safety_signals: storedSignals, missing_information: storedMissing });
    const currentExtraction = extraction({ symptoms: ["whining"], missing_information: ["species"] });

    const result = planIntakeTurn(context({ intakeData: stored }), currentExtraction);
    if (result.kind !== "planned") throw new Error("expected planned");

    expect(result.intakeData.symptoms).not.toBe(storedSymptoms);
    expect(result.intakeData.reported_safety_signals).not.toBe(storedSignals);
    expect(result.intakeData.missing_information).not.toBe(storedMissing);
    expect(result.intakeData.missing_information).not.toBe(currentExtraction.missing_information);
  });

  it("does not mutate frozen context, extraction, or pet inputs, and is deterministic across repeat calls", () => {
    const pets = Object.freeze([Object.freeze(pet("p1", "Waffles"))]);
    const frozenExtraction = Object.freeze({
      ...extraction({ pet_name: "Waffles", complaint: "limping" }),
      reported_safety_signals: Object.freeze(safetySignals()),
      symptoms: Object.freeze(["limping"]),
      missing_information: Object.freeze([]),
    });
    const frozenContext = Object.freeze(context({ pets: pets as unknown as IntakePet[], intakeData: Object.freeze({}) }));

    const first = planIntakeTurn(frozenContext as unknown as ConversationIntakeContext, frozenExtraction as unknown as IntakeExtraction);
    const second = planIntakeTurn(frozenContext as unknown as ConversationIntakeContext, frozenExtraction as unknown as IntakeExtraction);
    expect(first).toEqual(second);
    expect(first.kind).toBe("planned");
  });
});

describe("planIntakeTurn — pet selection", () => {
  it("reports needs_clarification with no petId when no pet is selected and none exist", () => {
    const result = planIntakeTurn(context({ pets: [] }), extraction());
    if (result.kind !== "planned") throw new Error("expected planned");
    expect(result.petResolution).toEqual({ kind: "needs_clarification" });
    expect(result.petId).toBeNull();
  });

  it("falls back to the single existing pet when none is selected and the turn names none", () => {
    const result = planIntakeTurn(context({ pets: [pet("p1", "Waffles")] }), extraction({ pet_name: null }));
    if (result.kind !== "planned") throw new Error("expected planned");
    expect(result.petResolution).toEqual({ kind: "matched", petId: "p1" });
    expect(result.petId).toBe("p1");
  });

  it("matches an exact name among multiple pets", () => {
    const result = planIntakeTurn(
      context({ pets: [pet("p1", "Waffles"), pet("p2", "Mochi")] }),
      extraction({ pet_name: "Mochi" }),
    );
    if (result.kind !== "planned") throw new Error("expected planned");
    expect(result.petResolution).toEqual({ kind: "matched", petId: "p2" });
  });

  it("needs clarification on ambiguous duplicate names", () => {
    const ambiguous = planIntakeTurn(
      context({ pets: [pet("p1", "Waffles"), pet("p2", "waffles")] }),
      extraction({ pet_name: "Waffles" }),
    );
    if (ambiguous.kind !== "planned") throw new Error("expected planned");
    expect(ambiguous.petResolution).toEqual({ kind: "needs_clarification" });
  });

  it("is a new candidate when no selected pet and an explicit name matches none of the owner's pets", () => {
    const result = planIntakeTurn(context({ pets: [pet("p1", "Waffles")] }), extraction({ pet_name: "Mochi" }));
    if (result.kind !== "planned") throw new Error("expected planned");
    expect(result.petResolution).toEqual({ kind: "new_candidate" });
    expect(result.petId).toBeNull();
  });

  it("is a new candidate for an explicit name when the owner has no pets at all, and identity is known", () => {
    const result = planIntakeTurn(context(), extraction({ pet_name: "Minnoş" }));
    if (result.kind !== "planned") throw new Error("expected planned");
    expect(result.petResolution).toEqual({ kind: "new_candidate" });
    expect(result.petId).toBeNull();
    expect(result.nextStage).toBe("complaint_collection");
  });

  it("retains an already-selected pet when the turn names no pet", () => {
    const result = planIntakeTurn(
      context({ petId: "p1", pets: [pet("p1", "Waffles"), pet("p2", "Mochi")] }),
      extraction({ pet_name: null }),
    );
    if (result.kind !== "planned") throw new Error("expected planned");
    expect(result.petResolution).toEqual({ kind: "matched", petId: "p1" });
    expect(result.petId).toBe("p1");
  });

  it("fails closed when the retained petId is missing from the tenant-scoped pet list", () => {
    const result = planIntakeTurn(context({ petId: "missing", pets: [pet("p1", "Waffles")] }), extraction());
    expect(result).toEqual({ kind: "failed" });
  });

  it("cannot let an explicit conflicting pet name switch the already-selected pet", () => {
    const result = planIntakeTurn(
      context({ petId: "p1", pets: [pet("p1", "Waffles"), pet("p2", "Mochi")] }),
      extraction({ pet_name: "Mochi" }),
    );
    if (result.kind !== "planned") throw new Error("expected planned");
    expect(result.petResolution).toEqual({ kind: "needs_clarification" });
    expect(result.petId).toBe("p1");
  });

  it("routes a conflicting pet name to human_handoff without merging the other animal's identity or clinical facts", () => {
    const stored = validSnapshot({
      pet_name: "Waffles",
      species: "dog",
      complaint: "vomiting",
      symptoms: ["vomiting"],
    });
    const result = planIntakeTurn(
      context({
        petId: "p1",
        pets: [pet("p1", "Waffles"), pet("p2", "Mochi")],
        intakeStage: "safety_check",
        intakeData: stored,
      }),
      extraction({ pet_name: "Mochi", species: "cat", complaint: "itching", symptoms: ["itching"] }),
    );
    if (result.kind !== "planned") throw new Error("expected planned");
    expect(result.petResolution).toEqual({ kind: "needs_clarification" });
    expect(result.petId).toBe("p1");
    expect(result.nextStage).toBe("human_handoff");
    expect(result.intakeData.pet_name).toBe("Waffles");
    expect(result.intakeData.species).toBe("dog");
    expect(result.intakeData.complaint).toBe("vomiting");
    expect(result.intakeData.symptoms).toEqual(["vomiting"]);
  });

  it("routes a brand-new unmatched pet name to human_handoff the same way while a pet is selected", () => {
    const result = planIntakeTurn(
      context({ petId: "p1", pets: [pet("p1", "Waffles")], intakeStage: "safety_check" }),
      extraction({ pet_name: "Ghost" }),
    );
    if (result.kind !== "planned") throw new Error("expected planned");
    expect(result.petResolution).toEqual({ kind: "needs_clarification" });
    expect(result.petId).toBe("p1");
    expect(result.nextStage).toBe("human_handoff");
  });

  it("still evaluates a true safety signal fail-closed on a selected-pet conflict turn", () => {
    const stored = validSnapshot({ pet_name: "Waffles" });
    const result = planIntakeTurn(
      context({ petId: "p1", pets: [pet("p1", "Waffles"), pet("p2", "Mochi")], intakeStage: "safety_check", intakeData: stored }),
      extraction({ pet_name: "Mochi", reported_safety_signals: safetySignals({ heavy_bleeding: true }) }),
    );
    if (result.kind !== "planned") throw new Error("expected planned");
    expect(result.nextStage).toBe("human_handoff");
    expect(result.intakeData.reported_safety_signals.heavy_bleeding).toBe(true);
    expect(result.safetyDecision.kind).not.toBe("continue_intake");
  });

  it("does not reuse the selected pet's false signals when the conflicting animal's signals are unknown", () => {
    const unknownSignals = Object.fromEntries(Object.keys(safetySignals()).map((key) => [key, null])) as unknown as ReportedSafetySignals;
    const result = planIntakeTurn(
      context({
        petId: "p1",
        pets: [pet("p1", "Waffles")],
        intakeStage: "safety_check",
        intakeData: validSnapshot({ pet_name: "Waffles", reported_safety_signals: safetySignals() }),
      }),
      extraction({ pet_name: "Ghost", reported_safety_signals: unknownSignals }),
    );
    if (result.kind !== "planned") throw new Error("expected planned");
    expect(Object.values(result.intakeData.reported_safety_signals)).toEqual(Array(8).fill(null));
    expect(result.safetyDecision.kind).toBe("needs_safety_check");
    expect(result.nextStage).toBe("human_handoff");
  });
});

describe("planIntakeTurn — safety precedence and stage progression", () => {
  it.each(ALL_STAGES.filter((stage) => stage !== "completed" && stage !== "human_handoff"))(
    "routes to human_handoff on an emergency signal from %s",
    (stage) => {
      const result = planIntakeTurn(
        context({ intakeStage: stage, petId: "p1", pets: [pet("p1", "Waffles")] }),
        extraction({ reported_safety_signals: safetySignals({ heavy_bleeding: true }) }),
      );
      if (result.kind !== "planned") throw new Error("expected planned");
      expect(result.safetyDecision.kind).toBe("emergency_handoff");
      expect(result.nextStage).toBe("human_handoff");
    },
  );

  it.each(ALL_STAGES.filter((stage) => stage !== "completed" && stage !== "human_handoff"))(
    "routes to human_handoff on an explicit human request from %s",
    (stage) => {
      const result = planIntakeTurn(
        context({ intakeStage: stage, petId: "p1", pets: [pet("p1", "Waffles")] }),
        extraction({ user_requested_human: true }),
      );
      if (result.kind !== "planned") throw new Error("expected planned");
      expect(result.nextStage).toBe("human_handoff");
    },
  );

  it("keeps a completed conversation completed even with an emergency signal", () => {
    const result = planIntakeTurn(
      context({ intakeStage: "completed" }),
      extraction({ reported_safety_signals: safetySignals({ heavy_bleeding: true }) }),
    );
    if (result.kind !== "planned") throw new Error("expected planned");
    expect(result.nextStage).toBe("completed");
  });

  it("keeps a human_handoff conversation in human_handoff once safety clears", () => {
    const result = planIntakeTurn(context({ intakeStage: "human_handoff" }), extraction());
    if (result.kind !== "planned") throw new Error("expected planned");
    expect(result.nextStage).toBe("human_handoff");
  });

  it("advances pet_identification only when the pet resolves, otherwise holds", () => {
    const advances = planIntakeTurn(context({ intakeStage: "pet_identification", pets: [pet("p1", "Waffles")] }), extraction({ pet_name: null }));
    const holds = planIntakeTurn(context({ intakeStage: "pet_identification", pets: [] }), extraction());
    if (advances.kind !== "planned" || holds.kind !== "planned") throw new Error("expected planned");
    expect(advances.nextStage).toBe("complaint_collection");
    expect(holds.nextStage).toBe("pet_identification");
  });

  it("advances complaint_collection to intake_confirmation only once complaint or symptoms are present", () => {
    const advances = planIntakeTurn(context({ intakeStage: "complaint_collection" }), extraction({ complaint: "limping" }));
    const holds = planIntakeTurn(context({ intakeStage: "complaint_collection" }), extraction());
    if (advances.kind !== "planned" || holds.kind !== "planned") throw new Error("expected planned");
    expect(advances.nextStage).toBe("intake_confirmation");
    expect(holds.nextStage).toBe("complaint_collection");
  });

  it("advances safety_check to ready_for_triage only on continue_intake, and unknown signals never reach it", () => {
    const advances = planIntakeTurn(context({ intakeStage: "safety_check" }), extraction());
    const holds = planIntakeTurn(
      context({ intakeStage: "safety_check" }),
      extraction({ reported_safety_signals: safetySignals({ active_seizure: null }) }),
    );
    if (advances.kind !== "planned" || holds.kind !== "planned") throw new Error("expected planned");
    expect(advances.safetyDecision.kind).toBe("continue_intake");
    expect(advances.nextStage).toBe("ready_for_triage");
    expect(holds.safetyDecision.kind).toBe("needs_safety_check");
    expect(holds.nextStage).toBe("safety_check");
  });

  it.each(["ready_for_triage", "appointment_offer", "appointment_selection", "appointment_confirmation"] as const)(
    "holds %s regardless of a continue_intake safety decision",
    (stage) => {
      const result = planIntakeTurn(context({ intakeStage: stage }), extraction());
      if (result.kind !== "planned") throw new Error("expected planned");
      expect(result.safetyDecision.kind).toBe("continue_intake");
      expect(result.nextStage).toBe(stage);
    },
  );

  it("keeps a stored true safety signal an emergency when the current turn reports null or false", () => {
    const stored = validSnapshot({ reported_safety_signals: safetySignals({ heavy_bleeding: true }) });
    const result = planIntakeTurn(
      context({ intakeStage: "ready_for_triage", intakeData: stored }),
      extraction({ reported_safety_signals: safetySignals({ heavy_bleeding: null }) }),
    );
    if (result.kind !== "planned") throw new Error("expected planned");
    expect(result.safetyDecision.kind).toBe("emergency_handoff");
    expect(result.nextStage).toBe("human_handoff");
  });
});

describe("planIntakeTurn — closed output", () => {
  it("returns only the documented fields with no diagnosis, medication, or response text", () => {
    const result = planIntakeTurn(context({ pets: [pet("p1", "Waffles")] }), extraction({ complaint: "limping" }));
    expect(result.kind).toBe("planned");
    if (result.kind !== "planned") return;
    expect(Object.keys(result).sort()).toEqual(["intakeData", "kind", "nextStage", "petId", "petResolution", "safetyDecision"].sort());
    expect(Object.keys(result.intakeData).sort()).toEqual(
      [
        "schema_version",
        "intent",
        "pet_name",
        "species",
        "complaint",
        "symptoms",
        "reported_safety_signals",
        "missing_information",
        "user_requested_human",
      ].sort(),
    );
  });
});
