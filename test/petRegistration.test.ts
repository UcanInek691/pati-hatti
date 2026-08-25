import { describe, expect, it } from "vitest";
import {
  MAX_PET_IDENTIFICATION_ATTEMPTS,
  buildPetConfirmationText,
  planPetRegistrationAction,
  planPetRegistrationReply,
  planPostCreationReply,
} from "../src/petRegistration";
import { PET_IDENTITY_TEXT } from "../src/intakeReply";
import type { ConversationIntakeContext, IntakeMessage, IntakeStage } from "../src/conversationState";
import type { PersistedIntakeData, PlanResult } from "../src/intakeTurn";
import type { PetResolution } from "../src/intakeExtraction";
import type { SafetyDecision } from "../src/safetyDecision";

const conversationId = "11111111-1111-1111-1111-111111111111";
const petId = "66666666-6666-6666-6666-666666666666";

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
    pet_name: "Pamuk",
    species: null,
    complaint: null,
    symptoms: [],
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
    nextStage: overrides.nextStage ?? "pet_identification",
    petId: overrides.petId ?? null,
    intakeData: intakeData(overrides.data),
    petResolution: overrides.petResolution ?? { kind: "needs_clarification" },
    safetyDecision: overrides.safetyDecision ?? { kind: "continue_intake" },
  };
}

const FAILED: PlanResult = { kind: "failed" };

function outbound(content: string): IntakeMessage {
  return { direction: "outbound", content, createdAt: "2026-08-25T00:00:00.000Z" };
}

function inbound(content: string): IntakeMessage {
  return { direction: "inbound", content, createdAt: "2026-08-25T00:00:01.000Z" };
}

function baseContext(overrides: Partial<ConversationIntakeContext> = {}): ConversationIntakeContext {
  return {
    conversationId,
    clinicId: "55555555-5555-5555-5555-555555555555",
    ownerId: "33333333-3333-3333-3333-333333333333",
    petId: null,
    status: "active",
    intakeStage: "pet_identification",
    intakeData: {},
    stateVersion: 1,
    ownerName: "Ada Lovelace",
    pets: [],
    recentMessages: [],
    ...overrides,
  };
}

describe("buildPetConfirmationText", () => {
  it("asks for name-only confirmation when species is null", () => {
    expect(buildPetConfirmationText("Pamuk", null)).toBe(
      '"Pamuk" adında yeni bir kayıt oluşturuyorum, doğru mu? Onaylamak için EVET, değilse HAYIR yazın.',
    );
  });

  it("asks for name-only confirmation when species is an empty or whitespace-only string", () => {
    expect(buildPetConfirmationText("Pamuk", "")).toBe(
      '"Pamuk" adında yeni bir kayıt oluşturuyorum, doğru mu? Onaylamak için EVET, değilse HAYIR yazın.',
    );
    expect(buildPetConfirmationText("Pamuk", "   ")).toBe(
      '"Pamuk" adında yeni bir kayıt oluşturuyorum, doğru mu? Onaylamak için EVET, değilse HAYIR yazın.',
    );
  });

  it("combines name and species in one confirmation when species is known", () => {
    expect(buildPetConfirmationText("Pamuk", "kedi")).toBe(
      '"Pamuk" adında, kedi türünde yeni bir kayıt oluşturuyorum, doğru mu? Onaylamak için EVET, değilse HAYIR yazın.',
    );
  });

  it("trims surrounding whitespace from species before interpolating", () => {
    expect(buildPetConfirmationText("Pamuk", "  kedi  ")).toBe(
      '"Pamuk" adında, kedi türünde yeni bir kayıt oluşturuyorum, doğru mu? Onaylamak için EVET, değilse HAYIR yazın.',
    );
  });

  it("truncates a name longer than 200 code points", () => {
    const longName = "a".repeat(250);
    const result = buildPetConfirmationText(longName, null);
    expect(result).toContain(`"${"a".repeat(200)}"`);
    expect(result).not.toContain("a".repeat(201));
  });

  it("truncates a species longer than 100 code points", () => {
    const longSpecies = "b".repeat(150);
    const result = buildPetConfirmationText("Pamuk", longSpecies);
    expect(result).toContain(`${"b".repeat(100)} türünde`);
    expect(result).not.toContain("b".repeat(101));
  });

  it("is a pure function returning the same result for the same input", () => {
    expect(buildPetConfirmationText("Pamuk", "kedi")).toBe(buildPetConfirmationText("Pamuk", "kedi"));
  });
});

// `context.recentMessages`'s last element is always the current inbound
// message being processed (mirrors production shape — see
// `intakeConsumer.ts`'s `selectPreviousClinicQuestion`), so every fixture
// below that expects `wasAskedThisExactConfirmation` to see a prior
// outbound must end with an inbound matching the `messageText` argument.
// A 2026-08-25 preliminary review caught the original fixtures using a
// production-impossible shape (trailing outbound, no current inbound) that
// hid a real bug where the confirmation flow could never match in
// production; these fixtures intentionally include the trailing inbound.

describe("planPetRegistrationAction", () => {
  it("a failed plan never triggers pet registration", () => {
    expect(planPetRegistrationAction(baseContext(), FAILED, "evet")).toEqual({ kind: "none" });
  });

  it.each<IntakeStage>(["complaint_collection", "safety_check", "ready_for_triage", "appointment_offer", "human_handoff", "completed"])(
    "does nothing while the current stage is %s, even with a pending pet_name and zero pets",
    (intakeStage) => {
      const context = baseContext({ intakeStage });
      const plan = planned({ nextStage: intakeStage === "human_handoff" ? "human_handoff" : "complaint_collection" });
      expect(planPetRegistrationAction(context, plan, "evet")).toEqual({ kind: "none" });
    },
  );

  it("does nothing when the plan's next stage is human_handoff", () => {
    const context = baseContext();
    const plan = planned({ nextStage: "human_handoff", safetyDecision: { kind: "human_handoff", reason: "user_requested_human" } });
    expect(planPetRegistrationAction(context, plan, "evet")).toEqual({ kind: "none" });
  });

  it.each<SafetyDecision>([
    { kind: "emergency_handoff", positiveSignals: ["heavy_bleeding"] },
    { kind: "human_handoff", reason: "user_requested_human" },
    { kind: "needs_safety_check", unknownSignals: ["heavy_bleeding"] },
  ])(
    "does nothing when the safety decision is not continue_intake, even mid pet-registration flow (safety precedence, matches appointmentFlow.ts)",
    (safetyDecision) => {
      const confirmationText = buildPetConfirmationText("Pamuk", null);
      const context = baseContext({ recentMessages: [outbound(confirmationText), inbound("evet")] });
      const plan = planned({ data: { pet_name: "Pamuk", species: null }, safetyDecision });
      expect(planPetRegistrationAction(context, plan, "evet")).toEqual({ kind: "none" });
    },
  );

  it("does nothing when the pet is already matched", () => {
    const context = baseContext();
    const plan = planned({ petResolution: { kind: "matched", petId } });
    expect(planPetRegistrationAction(context, plan, "evet")).toEqual({ kind: "none" });
  });

  it("does nothing when the owner already has at least one registered pet", () => {
    const context = baseContext({ pets: [{ id: petId, name: "Tarçın", species: "dog" }] });
    const plan = planned();
    expect(planPetRegistrationAction(context, plan, "evet")).toEqual({ kind: "none" });
  });

  it("does nothing when no pet_name has been extracted yet", () => {
    const context = baseContext();
    const plan = planned({ data: { pet_name: null } });
    expect(planPetRegistrationAction(context, plan, "evet")).toEqual({ kind: "none" });
  });

  it("does nothing when pet_name is only whitespace", () => {
    const context = baseContext();
    const plan = planned({ data: { pet_name: "   " } });
    expect(planPetRegistrationAction(context, plan, "evet")).toEqual({ kind: "none" });
  });

  it("asks for confirmation on a fresh extraction with no prior confirmation prompt", () => {
    const context = baseContext({ recentMessages: [outbound(PET_IDENTITY_TEXT), inbound("Pamuk")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "Pamuk")).toEqual({ kind: "ask_confirmation", name: "Pamuk", species: null });
  });

  it("includes species in the ask_confirmation action when already extracted", () => {
    const context = baseContext({ recentMessages: [outbound(PET_IDENTITY_TEXT), inbound("Pamuk, kedi")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: "kedi" } });
    expect(planPetRegistrationAction(context, plan, "Pamuk, kedi")).toEqual({ kind: "ask_confirmation", name: "Pamuk", species: "kedi" });
  });

  it("confirms and creates when the owner replies evet to the exact confirmation just asked", () => {
    const confirmationText = buildPetConfirmationText("Pamuk", "kedi");
    const context = baseContext({ recentMessages: [outbound(confirmationText), inbound("evet")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: "kedi" } });
    expect(planPetRegistrationAction(context, plan, "evet")).toEqual({ kind: "create", name: "Pamuk", species: "kedi" });
  });

  it("accepts case/whitespace-insensitive evet per the shared normalization", () => {
    const confirmationText = buildPetConfirmationText("Pamuk", null);
    const context = baseContext({ recentMessages: [outbound(confirmationText), inbound("  EVET  ")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "  EVET  ")).toEqual({ kind: "create", name: "Pamuk", species: null });
  });

  it("declines when the owner replies hayır to the exact confirmation just asked", () => {
    const confirmationText = buildPetConfirmationText("Pamuk", null);
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(
      planPetRegistrationAction(baseContext({ recentMessages: [outbound(confirmationText), inbound("hayır")] }), plan, "hayır"),
    ).toEqual({ kind: "declined" });
    expect(
      planPetRegistrationAction(baseContext({ recentMessages: [outbound(confirmationText), inbound("hayir")] }), plan, "hayir"),
    ).toEqual({ kind: "declined" });
  });

  it("re-asks confirmation (repeat_confirmation) on an unrecognized reply to the exact confirmation just asked", () => {
    const confirmationText = buildPetConfirmationText("Pamuk", null);
    const context = baseContext({ recentMessages: [outbound(confirmationText), inbound("tamam")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "tamam")).toEqual({ kind: "repeat_confirmation", name: "Pamuk", species: null });
  });

  it("asks fresh confirmation (not repeat) when the last outbound message was some other prompt", () => {
    const context = baseContext({ recentMessages: [outbound(PET_IDENTITY_TEXT), inbound("Pamuk")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "Pamuk")).toEqual({ kind: "ask_confirmation", name: "Pamuk", species: null });
  });

  it("treats a confirmation text for a different name/species as not-yet-asked (ask_confirmation, not repeat)", () => {
    const otherConfirmation = buildPetConfirmationText("Tarçın", null);
    const context = baseContext({ recentMessages: [outbound(otherConfirmation), inbound("Pamuk")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "Pamuk")).toEqual({ kind: "ask_confirmation", name: "Pamuk", species: null });
  });

  it("fails closed to ask_confirmation (never matches a stale confirmation) when the window's last message does not equal messageText", () => {
    // Defensive: if recentMessages were ever loaded stale/out of sync with
    // the claimed message, this must not accidentally treat an unrelated
    // trailing inbound as confirming an earlier ask.
    const confirmationText = buildPetConfirmationText("Pamuk", null);
    const context = baseContext({ recentMessages: [outbound(confirmationText), inbound("some other older message")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "evet")).toEqual({ kind: "ask_confirmation", name: "Pamuk", species: null });
  });

  it("does NOT apply the attempt bound to an explicit evet confirmation — a valid confirm always creates", () => {
    const confirmationText = buildPetConfirmationText("Pamuk", null);
    // MAX_PET_IDENTIFICATION_ATTEMPTS worth of prior asks, plus the final
    // ask/reply pair being confirmed now.
    const priorAsks: IntakeMessage[] = Array.from({ length: MAX_PET_IDENTIFICATION_ATTEMPTS }, () => outbound(confirmationText));
    const context = baseContext({ recentMessages: [...priorAsks, inbound("evet")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "evet")).toEqual({ kind: "create", name: "Pamuk", species: null });
  });

  it("forces bounded_handoff instead of a fresh ask once the attempt bound is reached", () => {
    const recentMessages: IntakeMessage[] = [
      ...Array.from({ length: MAX_PET_IDENTIFICATION_ATTEMPTS }, () => outbound(PET_IDENTITY_TEXT)),
      inbound("Pamuk"),
    ];
    const context = baseContext({ recentMessages });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "Pamuk")).toEqual({ kind: "bounded_handoff" });
  });

  it("forces bounded_handoff instead of repeat_confirmation once the attempt bound is reached on an unrecognized reply", () => {
    const confirmationText = buildPetConfirmationText("Pamuk", null);
    const recentMessages: IntakeMessage[] = [
      ...Array.from({ length: MAX_PET_IDENTIFICATION_ATTEMPTS }, () => outbound(confirmationText)),
      inbound("tamam"),
    ];
    const context = baseContext({ recentMessages });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "tamam")).toEqual({ kind: "bounded_handoff" });
  });

  it("does not force bounded_handoff on decline, even at the attempt bound", () => {
    const confirmationText = buildPetConfirmationText("Pamuk", null);
    const recentMessages: IntakeMessage[] = [
      ...Array.from({ length: MAX_PET_IDENTIFICATION_ATTEMPTS }, () => outbound(confirmationText)),
      inbound("hayır"),
    ];
    const context = baseContext({ recentMessages });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "hayır")).toEqual({ kind: "declined" });
  });

  it("does not count an unrelated outbound (e.g. a safety-questions or unsupported-media prompt) against the attempt bound", () => {
    // pet_identification can also emit safety_questions/intake_received
    // copy (see intakeReply.ts); those must not exhaust this flow's own
    // 3-attempt bound before a single pet-identity prompt has been sent.
    const unrelatedOutbound: IntakeMessage[] = Array.from({ length: MAX_PET_IDENTIFICATION_ATTEMPTS }, () =>
      outbound("Bu bot şu anda görsel, ses, video, belge, konum veya kişi kartı içeriğini değerlendiremiyor. Lütfen durumu yazılı mesajla açıklayın."),
    );
    const context = baseContext({ recentMessages: [...unrelatedOutbound, inbound("Pamuk")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "Pamuk")).toEqual({ kind: "ask_confirmation", name: "Pamuk", species: null });
  });

  it("is a pure function that never mutates its inputs", () => {
    const context = baseContext({ recentMessages: [outbound(PET_IDENTITY_TEXT), inbound("Pamuk")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    Object.freeze(context.recentMessages);
    Object.freeze(context);
    Object.freeze(plan);
    expect(() => planPetRegistrationAction(context, plan, "Pamuk")).not.toThrow();
  });
});

describe("planPetRegistrationReply", () => {
  it("sends the confirmation text under the pet_identity category for ask_confirmation", () => {
    expect(planPetRegistrationReply({ kind: "ask_confirmation", name: "Pamuk", species: "kedi" })).toEqual({
      kind: "send",
      category: "pet_identity",
      text: buildPetConfirmationText("Pamuk", "kedi"),
    });
  });

  it("sends the same confirmation text under pet_identity for repeat_confirmation", () => {
    expect(planPetRegistrationReply({ kind: "repeat_confirmation", name: "Pamuk", species: null })).toEqual({
      kind: "send",
      category: "pet_identity",
      text: buildPetConfirmationText("Pamuk", null),
    });
  });

  it("sends the base pet-identity question again on declined", () => {
    expect(planPetRegistrationReply({ kind: "declined" })).toEqual({
      kind: "send",
      category: "pet_identity",
      text: PET_IDENTITY_TEXT,
    });
  });

  it("sends nothing for none", () => {
    expect(planPetRegistrationReply({ kind: "none" })).toEqual({ kind: "none" });
  });

  it("sends nothing for create (the caller plans that turn's reply separately)", () => {
    expect(planPetRegistrationReply({ kind: "create", name: "Pamuk", species: null })).toEqual({ kind: "none" });
  });

  it("sends nothing for bounded_handoff (the caller builds a handoff plan separately)", () => {
    expect(planPetRegistrationReply({ kind: "bounded_handoff" })).toEqual({ kind: "none" });
  });
});

describe("planPostCreationReply", () => {
  it("delegates to the ordinary complaint-collection reply for a freshly created pet with no complaint yet", () => {
    const context = baseContext();
    const plan = planned({ data: { pet_name: "Pamuk", species: null, complaint: null, symptoms: [] } }) as Extract<PlanResult, { kind: "planned" }>;
    expect(planPostCreationReply(context, plan)).toEqual({
      kind: "send",
      category: "complaint",
      text: "Evcil hayvanınızla ilgili sizi endişelendiren durumu veya fark ettiğiniz belirtileri kısaca yazar mısınız?",
    });
  });

  it("delegates to the intake_received reply when a complaint was already collected in the same turn", () => {
    const context = baseContext();
    const plan = planned({ data: { pet_name: "Pamuk", species: null, complaint: "kontrol" } }) as Extract<PlanResult, { kind: "planned" }>;
    expect(planPostCreationReply(context, plan)).toEqual({
      kind: "send",
      category: "intake_received",
      text: "Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum kötüleşirse kliniğimizi telefonla arayın ya da en yakın açık veteriner kliniğine başvurun.",
    });
  });

  it("never routes to human_handoff or emergency copy from a plain post-creation turn", () => {
    const context = baseContext();
    const plan = planned({ data: { pet_name: "Pamuk", species: null } }) as Extract<PlanResult, { kind: "planned" }>;
    const reply = planPostCreationReply(context, plan);
    expect(reply.kind).toBe("send");
    if (reply.kind === "send") {
      expect(reply.category).not.toBe("human_handoff");
      expect(reply.category).not.toBe("emergency_handoff");
    }
  });
});
