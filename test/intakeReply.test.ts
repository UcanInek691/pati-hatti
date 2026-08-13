import { describe, expect, it, vi } from "vitest";
import { planIntakeReply, planUnsupportedMediaReply } from "../src/intakeReply";
import type { IntakeReplyCategory } from "../src/intakeReply";
import type { IntakeStage } from "../src/conversationState";
import type { PetResolution } from "../src/intakeExtraction";
import type { PersistedIntakeData, PlanResult } from "../src/intakeTurn";
import type { SafetyDecision, SafetySignal } from "../src/safetyDecision";

const ALL_SIGNALS_FALSE = {
  breathing_difficulty: false,
  loss_of_consciousness: false,
  active_seizure: false,
  heavy_bleeding: false,
  major_trauma: false,
  possible_toxin_exposure: false,
  possible_foreign_object: false,
  unable_to_urinate: false,
} as const;

function intakeData(overrides: Partial<PersistedIntakeData> = {}): PersistedIntakeData {
  return {
    schema_version: 1,
    intent: "report_symptom",
    pet_name: "Tarçın",
    species: "dog",
    complaint: "topallıyor",
    symptoms: ["topallama"],
    reported_safety_signals: { ...ALL_SIGNALS_FALSE },
    missing_information: [],
    user_requested_human: false,
    ...overrides,
  };
}

function planned(
  overrides: {
    nextStage?: IntakeStage;
    petId?: string | null;
    data?: Partial<PersistedIntakeData>;
    petResolution?: PetResolution;
    safetyDecision?: SafetyDecision;
  } = {},
): PlanResult {
  return {
    kind: "planned",
    nextStage: overrides.nextStage ?? "ready_for_triage",
    petId: overrides.petId ?? "pet-1",
    intakeData: intakeData(overrides.data),
    petResolution: overrides.petResolution ?? { kind: "matched", petId: "pet-1" },
    safetyDecision: overrides.safetyDecision ?? { kind: "continue_intake" },
  };
}

const FAILED: PlanResult = { kind: "failed" };
const NEEDS_CLARIFICATION: PetResolution = { kind: "needs_clarification" };

const EMERGENCY_TEXT =
  "Bu durum acil olabilir. Bot üzerinden yanıt beklemeyin; en yakın açık veteriner kliniğini hemen arayın veya doğrudan kliniğe başvurun.";
const HUMAN_HANDOFF_TEXT =
  "Bu talebi bot üzerinden yanıtlayamam. Lütfen kliniğimizi telefonla arayın. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.";
const PET_IDENTITY_TEXT = "Hangi evcil hayvanınız için yazıyorsunuz? Lütfen adını belirtin.";
const COMPLAINT_TEXT = "Evcil hayvanınızla ilgili sizi endişelendiren durumu veya fark ettiğiniz belirtileri kısaca yazar mısınız?";
const INTAKE_RECEIVED_TEXT =
  "Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum kötüleşirse kliniğimizi telefonla arayın ya da en yakın açık veteriner kliniğine başvurun.";
const SAFETY_PREFIX =
  "Güvenlik için lütfen aşağıdaki soruları her biri için evet veya hayır diye yanıtlayın. Bu durumlardan biri varsa veya emin değilseniz bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun:";

const SIGNAL_QUESTIONS: Record<SafetySignal, string> = {
  breathing_difficulty: "Nefes almakta güçlük var mı?",
  loss_of_consciousness: "Bilinç kaybı var mı?",
  active_seizure: "Şu anda devam eden nöbet var mı?",
  heavy_bleeding: "Şiddetli veya durmayan kanama var mı?",
  major_trauma: "Araç çarpması, yüksekten düşme veya başka ciddi bir travma oldu mu?",
  possible_toxin_exposure: "Zehirli olabilecek bir maddeye maruz kalmış olabilir mi?",
  possible_foreign_object: "Yabancı bir cisim yutmuş olabilir mi?",
  unable_to_urinate: "İdrar yapamıyor mu?",
};

describe("planIntakeReply", () => {
  it.each<[string, PlanResult]>([
    ["planned", planned()],
    ["planned emergency", planned({ safetyDecision: { kind: "emergency_handoff", positiveSignals: ["breathing_difficulty"] } })],
    ["failed", FAILED],
  ])("completed stage always returns none (%s)", (_label, result) => {
    expect(planIntakeReply("completed", result)).toEqual({ kind: "none" });
  });

  it("failed result routes to fixed human handoff", () => {
    expect(planIntakeReply("pet_identification", FAILED)).toEqual({
      kind: "send",
      category: "human_handoff",
      text: HUMAN_HANDOFF_TEXT,
    });
  });

  it("emergency beats human request signal, unknown signals, pet clarification, and missing complaint", () => {
    const result = planned({
      safetyDecision: { kind: "emergency_handoff", positiveSignals: ["heavy_bleeding"] },
      petResolution: NEEDS_CLARIFICATION,
      data: { complaint: null, symptoms: [], user_requested_human: true },
    });
    expect(planIntakeReply("safety_check", result)).toEqual({
      kind: "send",
      category: "emergency_handoff",
      text: EMERGENCY_TEXT,
    });
  });

  it("human handoff beats safety clarification, pet clarification, and complaint", () => {
    const result = planned({
      safetyDecision: { kind: "human_handoff", reason: "user_requested_human" },
      petResolution: NEEDS_CLARIFICATION,
      data: { complaint: null, symptoms: [] },
    });
    expect(planIntakeReply("safety_check", result)).toEqual({
      kind: "send",
      category: "human_handoff",
      text: HUMAN_HANDOFF_TEXT,
    });
  });

  it("human handoff does not claim staff notification or instruct the user to wait", () => {
    const plan = planIntakeReply("human_handoff", planned({ safetyDecision: { kind: "human_handoff", reason: "user_requested_human" } }));
    expect(plan).toEqual({ kind: "send", category: "human_handoff", text: HUMAN_HANDOFF_TEXT });
    if (plan.kind === "send") {
      expect(plan.text).not.toContain("yönlendirdim");
      expect(plan.text).not.toContain("ekip yanıtını bekleyin");
      expect(plan.text).toContain("Lütfen kliniğimizi telefonla arayın.");
    }
  });

  it("a human-handoff next stage routes to human handoff even with a continue safety decision", () => {
    const result = planned({ nextStage: "human_handoff", safetyDecision: { kind: "continue_intake" } });
    expect(planIntakeReply("human_handoff", result)).toEqual({
      kind: "send",
      category: "human_handoff",
      text: HUMAN_HANDOFF_TEXT,
    });
  });

  it("safety clarification beats pet and complaint questions, listing only unknown signals in supplied order", () => {
    const result = planned({
      safetyDecision: { kind: "needs_safety_check", unknownSignals: ["heavy_bleeding", "unable_to_urinate"] },
      petResolution: NEEDS_CLARIFICATION,
      data: { complaint: null, symptoms: [] },
    });
    expect(planIntakeReply("safety_check", result)).toEqual({
      kind: "send",
      category: "safety_questions",
      text: `${SAFETY_PREFIX}\n- ${SIGNAL_QUESTIONS.heavy_bleeding}\n- ${SIGNAL_QUESTIONS.unable_to_urinate}`,
    });
  });

  it("safety clarification includes the immediate off-bot escape instruction", () => {
    const result = planned({ safetyDecision: { kind: "needs_safety_check", unknownSignals: ["breathing_difficulty"] } });
    const plan = planIntakeReply("safety_check", result);
    expect(plan.kind).toBe("send");
    if (plan.kind === "send") {
      expect(plan.text).toContain("emin değilseniz bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun");
    }
  });

  it.each(Object.entries(SIGNAL_QUESTIONS) as [SafetySignal, string][])("maps %s to its exact required question", (signal, question) => {
    const result = planned({ safetyDecision: { kind: "needs_safety_check", unknownSignals: [signal] } });
    expect(planIntakeReply("safety_check", result)).toEqual({
      kind: "send",
      category: "safety_questions",
      text: `${SAFETY_PREFIX}\n- ${question}`,
    });
  });

  it("fails closed to human handoff on an empty unknown-signal list without throwing", () => {
    const result = planned({ safetyDecision: { kind: "needs_safety_check", unknownSignals: [] } });
    expect(() => planIntakeReply("safety_check", result)).not.toThrow();
    expect(planIntakeReply("safety_check", result)).toEqual({
      kind: "send",
      category: "human_handoff",
      text: HUMAN_HANDOFF_TEXT,
    });
  });

  it("fails closed to human handoff on an unrecognized signal value without throwing", () => {
    const bogusSignals = ["not_a_real_signal"] as unknown as SafetySignal[];
    const result = planned({ safetyDecision: { kind: "needs_safety_check", unknownSignals: bogusSignals } });
    expect(() => planIntakeReply("safety_check", result)).not.toThrow();
    expect(planIntakeReply("safety_check", result)).toEqual({
      kind: "send",
      category: "human_handoff",
      text: HUMAN_HANDOFF_TEXT,
    });
  });

  it("pet clarification beats a missing complaint", () => {
    const result = planned({ petResolution: NEEDS_CLARIFICATION, data: { complaint: null, symptoms: [] } });
    expect(planIntakeReply("pet_identification", result)).toEqual({
      kind: "send",
      category: "pet_identity",
      text: PET_IDENTITY_TEXT,
    });
  });

  it("missing complaint and zero symptoms asks for the complaint", () => {
    const result = planned({ data: { complaint: null, symptoms: [] } });
    expect(planIntakeReply("complaint_collection", result)).toEqual({
      kind: "send",
      category: "complaint",
      text: COMPLAINT_TEXT,
    });
  });

  it.each<[string, Partial<PersistedIntakeData>]>([
    ["a symptom with null complaint", { complaint: null, symptoms: ["öksürük"] }],
    ["a complaint with zero symptoms", { complaint: "öksürüyor", symptoms: [] }],
  ])("%s reaches intake_received when earlier rules do not apply", (_label, data) => {
    const result = planned({ data });
    expect(planIntakeReply("complaint_collection", result)).toEqual({
      kind: "send",
      category: "intake_received",
      text: INTAKE_RECEIVED_TEXT,
    });
  });

  it.each<IntakeStage>(["ready_for_triage", "appointment_offer", "appointment_selection", "appointment_confirmation"])(
    "%s stage returns only the generic receipt confirmation, never a claimed action",
    (nextStage) => {
      const result = planned({ nextStage });
      const plan = planIntakeReply(nextStage, result);
      expect(plan).toEqual({ kind: "send", category: "intake_received", text: INTAKE_RECEIVED_TEXT });
    },
  );

  it("is deterministic and returns a fresh object on every call", () => {
    const result = planned();
    const first = planIntakeReply("ready_for_triage", result);
    const second = planIntakeReply("ready_for_triage", result);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it("never logs", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      planIntakeReply("ready_for_triage", planned());
      planIntakeReply("completed", FAILED);
      planIntakeReply("safety_check", planned({ safetyDecision: { kind: "needs_safety_check", unknownSignals: ["heavy_bleeding"] } }));
    } finally {
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });

  it("never embeds dynamic pet name, complaint, or owner data in reply text", () => {
    const result = planned({ data: { pet_name: "Tarçın", complaint: "topallıyor", symptoms: ["topallama"] } });
    const plan = planIntakeReply("ready_for_triage", result);
    expect(plan.kind).toBe("send");
    if (plan.kind === "send") {
      expect(plan.text).not.toContain("Tarçın");
      expect(plan.text).not.toContain("topallıyor");
      expect(plan.text).not.toContain("topallama");
    }
  });

  it("the widened appointment categories type-check as IntakeReplyCategory but are never produced by planIntakeReply itself", () => {
    const appointmentCategories: IntakeReplyCategory[] = [
      "appointment_offer",
      "appointment_confirmed",
      "appointment_declined",
      "appointment_unavailable",
    ];
    const stages: IntakeStage[] = [
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
    for (const stage of stages) {
      for (const result of [planned({ nextStage: stage }), FAILED]) {
        const plan = planIntakeReply(stage, result);
        if (plan.kind === "send") {
          expect(appointmentCategories).not.toContain(plan.category);
        }
      }
    }
  });
});

describe("planUnsupportedMediaReply (Task 030)", () => {
  it("returns the exact fixed Turkish copy under the existing intake_received category", () => {
    expect(planUnsupportedMediaReply()).toEqual({
      kind: "send",
      category: "intake_received",
      text: "Bu bot şu anda görsel, ses, video, belge, konum veya kişi kartı içeriğini değerlendiremiyor. Lütfen durumu yazılı mesajla açıklayın veya kliniğimizi telefonla arayın. Durum acilse bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.",
    });
  });

  it("is pure: repeated calls return an equal plan", () => {
    expect(planUnsupportedMediaReply()).toEqual(planUnsupportedMediaReply());
  });

  it("claims no analysis, upload, notification, or staff action and keeps an off-bot emergency path", () => {
    const plan = planUnsupportedMediaReply();
    expect(plan.kind).toBe("send");
    if (plan.kind !== "send") return;
    for (const forbidden of ["inceledim", "aldım", "yükle", "ilet", "bildir", "personel", "en kısa sürede", "dakika"]) {
      expect(plan.text.toLowerCase()).not.toContain(forbidden);
    }
    expect(plan.text).toContain("en yakın açık veteriner kliniğine başvurun");
  });

  it("is distinct from the generic intake_received copy so the two cannot be confused", () => {
    const generic = planIntakeReply("ready_for_triage", planned({ data: { complaint: "kusma" } }));
    expect(generic.kind).toBe("send");
    if (generic.kind !== "send") return;
    expect(generic.category).toBe("intake_received");
    expect(planUnsupportedMediaReply()).not.toEqual(generic);
  });
});
