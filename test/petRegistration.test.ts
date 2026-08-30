import { describe, expect, it } from "vitest";
import {
  INTAKE_CORRECTION_PROMPT_TEXT,
  MAX_PET_IDENTIFICATION_ATTEMPTS,
  buildIntakeConfirmationText,
  planPetRegistrationAction,
  planPetRegistrationReply,
  planPostConfirmationReply,
  POST_CONFIRMATION_APPOINTMENT_INVITATION_TEXT,
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
    pending_cancel_slot_id: null,
    ...overrides,
  };
}

/**
 * Task 036: the flow now lives in `intake_confirmation`, and
 * `planPetRegistrationAction` keys off the *planned* next stage, so that is
 * this helper's default.
 */
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
    nextStage: overrides.nextStage ?? "intake_confirmation",
    petId: overrides.petId ?? null,
    intakeData: intakeData(overrides.data),
    petResolution: overrides.petResolution ?? { kind: "new_candidate" },
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
    intakeStage: "intake_confirmation",
    intakeData: {},
    stateVersion: 1,
    ownerName: "Ada Lovelace",
    pets: [],
    recentMessages: [],
    ...overrides,
  };
}

describe("buildIntakeConfirmationText", () => {
  it("summarizes the name alone when nothing else is known", () => {
    expect(buildIntakeConfirmationText("Pamuk", null, null)).toBe(
      'Anladığım kadarıyla — Ad: "Pamuk". Doğru mu? Onaylamak için EVET, düzeltmek için HAYIR yazın.',
    );
  });

  it("treats an empty or whitespace-only species as unknown", () => {
    const nameOnly = buildIntakeConfirmationText("Pamuk", null, null);
    expect(buildIntakeConfirmationText("Pamuk", "", null)).toBe(nameOnly);
    expect(buildIntakeConfirmationText("Pamuk", "   ", null)).toBe(nameOnly);
  });

  it("combines name, species and complaint in one ask", () => {
    expect(buildIntakeConfirmationText("Pamuk", "kedi", "sarhoş gibi yürüyor")).toBe(
      'Anladığım kadarıyla — Ad: "Pamuk", Tür: kedi, Şikayet: sarhoş gibi yürüyor. Doğru mu? Onaylamak için EVET, düzeltmek için HAYIR yazın.',
    );
  });

  it("omits only the parts that are missing", () => {
    expect(buildIntakeConfirmationText("Pamuk", null, "topallıyor")).toBe(
      'Anladığım kadarıyla — Ad: "Pamuk", Şikayet: topallıyor. Doğru mu? Onaylamak için EVET, düzeltmek için HAYIR yazın.',
    );
  });

  it("trims surrounding whitespace from species and complaint before interpolating", () => {
    expect(buildIntakeConfirmationText("Pamuk", "  kedi  ", "  topallıyor  ")).toBe(
      buildIntakeConfirmationText("Pamuk", "kedi", "topallıyor"),
    );
  });

  it("truncates a name longer than 200 code points", () => {
    const result = buildIntakeConfirmationText("a".repeat(250), null, null);
    expect(result).toContain(`"${"a".repeat(200)}"`);
    expect(result).not.toContain("a".repeat(201));
  });

  it("truncates a species longer than 100 code points", () => {
    const result = buildIntakeConfirmationText("Pamuk", "b".repeat(150), null);
    expect(result).toContain(`Tür: ${"b".repeat(100)}`);
    expect(result).not.toContain("b".repeat(101));
  });

  it("truncates a complaint longer than 300 code points", () => {
    const result = buildIntakeConfirmationText("Pamuk", null, "c".repeat(400));
    expect(result).toContain(`Şikayet: ${"c".repeat(300)}`);
    expect(result).not.toContain("c".repeat(301));
  });

  it("is a pure function returning the same result for the same input", () => {
    expect(buildIntakeConfirmationText("Pamuk", "kedi", "topallıyor")).toBe(buildIntakeConfirmationText("Pamuk", "kedi", "topallıyor"));
  });
});

// `context.recentMessages`'s last element is always the current inbound
// message being processed (mirrors production shape — see
// `intakeConsumer.ts`'s `selectPreviousClinicQuestion`), so every fixture
// below that expects a prior confirmation ask to be recognized must end with
// an inbound matching the `messageText` argument. A 2026-08-25 preliminary
// review caught the original fixtures using a production-impossible shape
// (trailing outbound, no current inbound) that hid a real bug where the
// confirmation flow could never match in production; these fixtures
// intentionally include the trailing inbound.

describe("planPetRegistrationAction", () => {
  it("a failed plan never triggers pet registration", () => {
    expect(planPetRegistrationAction(baseContext(), FAILED, "evet")).toEqual({ kind: "none" });
  });

  it.each<IntakeStage>(["pet_identification", "complaint_collection", "safety_check", "ready_for_triage", "appointment_offer", "completed"])(
    "does nothing while the plan's next stage is %s, even with a pending pet_name and zero pets",
    (nextStage) => {
      const context = baseContext({ intakeStage: nextStage });
      expect(planPetRegistrationAction(context, planned({ nextStage }), "evet")).toEqual({ kind: "none" });
    },
  );

  it("does nothing when the plan's next stage is human_handoff", () => {
    const plan = planned({ nextStage: "human_handoff", safetyDecision: { kind: "human_handoff", reason: "user_requested_human" } });
    expect(planPetRegistrationAction(baseContext(), plan, "evet")).toEqual({ kind: "none" });
  });

  it.each<SafetyDecision>([
    { kind: "emergency_handoff", positiveSignals: ["heavy_bleeding"] },
    { kind: "human_handoff", reason: "user_requested_human" },
    { kind: "needs_safety_check", unknownSignals: ["heavy_bleeding"] },
  ])(
    "does nothing when the safety decision is not continue_intake, even mid-confirmation (safety precedence, matches appointmentFlow.ts)",
    (safetyDecision) => {
      const confirmationText = buildIntakeConfirmationText("Pamuk", null, null);
      const context = baseContext({ recentMessages: [outbound(confirmationText), inbound("evet")] });
      const plan = planned({ data: { pet_name: "Pamuk", species: null }, safetyDecision });
      expect(planPetRegistrationAction(context, plan, "evet")).toEqual({ kind: "none" });
    },
  );

  it("does nothing when no pet_name has been extracted and no pet matched", () => {
    expect(planPetRegistrationAction(baseContext(), planned({ data: { pet_name: null } }), "evet")).toEqual({ kind: "none" });
  });

  it("does nothing when pet_name is only whitespace", () => {
    expect(planPetRegistrationAction(baseContext(), planned({ data: { pet_name: "   " } }), "evet")).toEqual({ kind: "none" });
  });

  it("asks for confirmation on entering the stage, with everything collected so far in one message", () => {
    const context = baseContext({ intakeStage: "complaint_collection", recentMessages: [outbound(PET_IDENTITY_TEXT), inbound("topallıyor")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: "kedi", complaint: "topallıyor" } });
    expect(planPetRegistrationAction(context, plan, "topallıyor")).toEqual({
      kind: "ask_confirmation",
      name: "Pamuk",
      species: "kedi",
      complaint: "topallıyor",
    });
  });

  it("creates when the owner replies evet to the exact summary just asked", () => {
    const confirmationText = buildIntakeConfirmationText("Pamuk", "kedi", "topallıyor");
    const context = baseContext({ recentMessages: [outbound(confirmationText), inbound("evet")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: "kedi", complaint: "topallıyor" } });
    expect(planPetRegistrationAction(context, plan, "evet")).toEqual({ kind: "create", name: "Pamuk", species: "kedi" });
  });

  it("accepts case/whitespace-insensitive evet per the shared normalization", () => {
    const confirmationText = buildIntakeConfirmationText("Pamuk", null, null);
    const context = baseContext({ recentMessages: [outbound(confirmationText), inbound("  EVET  ")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "  EVET  ")).toEqual({ kind: "create", name: "Pamuk", species: null });
  });

  // Task 037 decision 4: `needs_clarification` must never be treated as a new
  // pet, even on an exact EVET with a captured name. This state should not be
  // reachable through `planIntakeTurn` today (it never advances to
  // `intake_confirmation` while ambiguous), but the guard here is explicit
  // rather than relying on that being permanently true.
  it("never creates on an exact evet when the pet resolution is still needs_clarification", () => {
    const confirmationText = buildIntakeConfirmationText("Pamuk", "kedi", "topallıyor");
    const context = baseContext({ recentMessages: [outbound(confirmationText), inbound("evet")] });
    const plan = planned({
      data: { pet_name: "Pamuk", species: "kedi", complaint: "topallıyor" },
      petResolution: { kind: "needs_clarification" },
    });
    expect(planPetRegistrationAction(context, plan, "evet")).toEqual({ kind: "none" });
  });

  // Task 036: a returning owner goes through the same stage and the same
  // question, but there is nothing to insert.
  it("confirms without creating when the pet is already on file", () => {
    const confirmationText = buildIntakeConfirmationText("Tarçın", "köpek", "topallıyor");
    const context = baseContext({
      pets: [{ id: petId, name: "Tarçın", species: "köpek" }],
      recentMessages: [outbound(confirmationText), inbound("evet")],
    });
    const plan = planned({
      petResolution: { kind: "matched", petId },
      data: { pet_name: "Tarçın", species: "köpek", complaint: "topallıyor" },
    });
    expect(planPetRegistrationAction(context, plan, "evet")).toEqual({ kind: "confirmed" });
  });

  it("summarizes a matched pet from its stored row, not from extraction alone", () => {
    const context = baseContext({
      intakeStage: "complaint_collection",
      pets: [{ id: petId, name: "Tarçın", species: "köpek" }],
      recentMessages: [outbound(PET_IDENTITY_TEXT), inbound("topallıyor")],
    });
    const plan = planned({ petResolution: { kind: "matched", petId }, data: { pet_name: null, species: null, complaint: "topallıyor" } });
    expect(planPetRegistrationAction(context, plan, "topallıyor")).toEqual({
      kind: "ask_confirmation",
      name: "Tarçın",
      species: "köpek",
      complaint: "topallıyor",
    });
  });

  it("declines, without erasing anything, when the owner replies hayır to the exact summary", () => {
    const confirmationText = buildIntakeConfirmationText("Pamuk", null, null);
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(
      planPetRegistrationAction(baseContext({ recentMessages: [outbound(confirmationText), inbound("hayır")] }), plan, "hayır"),
    ).toEqual({ kind: "declined" });
    expect(
      planPetRegistrationAction(baseContext({ recentMessages: [outbound(confirmationText), inbound("hayir")] }), plan, "hayir"),
    ).toEqual({ kind: "declined" });
  });

  // Task 036's correction flow. Before it, "hayır, adı Karabaş" either reset
  // the owner to the generic identity question or was re-asked verbatim while
  // burning an attempt, even though the extractor had already read the name.
  it("treats a reply that changes the summary as a correction, keeping the fields the owner did not contradict", () => {
    const askedText = buildIntakeConfirmationText("Pamuk", "kedi", "topallıyor");
    const context = baseContext({ recentMessages: [outbound(askedText), inbound("hayır, adı Karabaş")] });
    const plan = planned({ data: { pet_name: "Karabaş", species: "kedi", complaint: "topallıyor" } });
    expect(planPetRegistrationAction(context, plan, "hayır, adı Karabaş")).toEqual({
      kind: "correction",
      name: "Karabaş",
      species: "kedi",
      complaint: "topallıyor",
    });
  });

  it("treats an evet that also changes a value as a correction, never creating under an unseen name", () => {
    const askedText = buildIntakeConfirmationText("Pamuk", null, null);
    const context = baseContext({ recentMessages: [outbound(askedText), inbound("evet, kedi")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: "kedi" } });
    expect(planPetRegistrationAction(context, plan, "evet, kedi")).toEqual({
      kind: "correction",
      name: "Pamuk",
      species: "kedi",
      complaint: null,
    });
  });

  it("a correction is never bounded, however many identical asks came before it", () => {
    const askedText = buildIntakeConfirmationText("Pamuk", null, null);
    const priorAsks: IntakeMessage[] = Array.from({ length: MAX_PET_IDENTIFICATION_ATTEMPTS }, () => outbound(askedText));
    const context = baseContext({ recentMessages: [...priorAsks, inbound("adı Karabaş")] });
    const plan = planned({ data: { pet_name: "Karabaş", species: null } });
    expect(planPetRegistrationAction(context, plan, "adı Karabaş")).toEqual({
      kind: "correction",
      name: "Karabaş",
      species: null,
      complaint: null,
    });
  });

  it("re-asks (repeat_confirmation) on an unrecognized reply that changes nothing", () => {
    const confirmationText = buildIntakeConfirmationText("Pamuk", null, null);
    const context = baseContext({ recentMessages: [outbound(confirmationText), inbound("tamam")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "tamam")).toEqual({
      kind: "repeat_confirmation",
      name: "Pamuk",
      species: null,
      complaint: null,
    });
  });

  it("asks fresh confirmation (not repeat) when the last outbound message was some other prompt", () => {
    const context = baseContext({ recentMessages: [outbound(INTAKE_CORRECTION_PROMPT_TEXT), inbound("Pamuk")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "Pamuk")).toEqual({
      kind: "ask_confirmation",
      name: "Pamuk",
      species: null,
      complaint: null,
    });
  });

  it("fails closed to ask_confirmation (never matches a stale confirmation) when the window's last message does not equal messageText", () => {
    // Defensive: if recentMessages were ever loaded stale/out of sync with
    // the claimed message, this must not accidentally treat an unrelated
    // trailing inbound as confirming an earlier ask.
    const confirmationText = buildIntakeConfirmationText("Pamuk", null, null);
    const context = baseContext({ recentMessages: [outbound(confirmationText), inbound("some other older message")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "evet")).toEqual({
      kind: "ask_confirmation",
      name: "Pamuk",
      species: null,
      complaint: null,
    });
  });

  it("does NOT apply the attempt bound to an explicit evet confirmation — a valid confirm always creates", () => {
    const confirmationText = buildIntakeConfirmationText("Pamuk", null, null);
    const priorAsks: IntakeMessage[] = Array.from({ length: MAX_PET_IDENTIFICATION_ATTEMPTS }, () => outbound(confirmationText));
    const context = baseContext({ recentMessages: [...priorAsks, inbound("evet")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "evet")).toEqual({ kind: "create", name: "Pamuk", species: null });
  });

  it("forces bounded_handoff instead of repeat_confirmation once the identical ask has been sent to the bound", () => {
    const confirmationText = buildIntakeConfirmationText("Pamuk", null, null);
    const recentMessages: IntakeMessage[] = [
      ...Array.from({ length: MAX_PET_IDENTIFICATION_ATTEMPTS }, () => outbound(confirmationText)),
      inbound("tamam"),
    ];
    const context = baseContext({ recentMessages });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "tamam")).toEqual({ kind: "bounded_handoff" });
  });

  it("does not force bounded_handoff on decline, even at the attempt bound", () => {
    const confirmationText = buildIntakeConfirmationText("Pamuk", null, null);
    const recentMessages: IntakeMessage[] = [
      ...Array.from({ length: MAX_PET_IDENTIFICATION_ATTEMPTS }, () => outbound(confirmationText)),
      inbound("hayır"),
    ];
    const context = baseContext({ recentMessages });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "hayır")).toEqual({ kind: "declined" });
  });

  it("does not count an unrelated outbound (e.g. a safety-questions or unsupported-media prompt) against the attempt bound", () => {
    // intake_confirmation can also emit safety_questions/intake_received copy
    // (see intakeReply.ts); those must not exhaust this flow's own 3-attempt
    // bound before a single confirmation has been sent.
    const unrelatedOutbound: IntakeMessage[] = Array.from({ length: MAX_PET_IDENTIFICATION_ATTEMPTS }, () =>
      outbound("Bu bot şu anda görsel, ses, video, belge, konum veya kişi kartı içeriğini değerlendiremiyor. Lütfen durumu yazılı mesajla açıklayın."),
    );
    const context = baseContext({ recentMessages: [...unrelatedOutbound, inbound("Pamuk")] });
    const plan = planned({ data: { pet_name: "Pamuk", species: null } });
    expect(planPetRegistrationAction(context, plan, "Pamuk")).toEqual({
      kind: "ask_confirmation",
      name: "Pamuk",
      species: null,
      complaint: null,
    });
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
  it("sends the summary under the intake_confirmation category for ask_confirmation", () => {
    expect(planPetRegistrationReply({ kind: "ask_confirmation", name: "Pamuk", species: "kedi", complaint: "topallıyor" })).toEqual({
      kind: "send",
      category: "intake_confirmation",
      text: buildIntakeConfirmationText("Pamuk", "kedi", "topallıyor"),
    });
  });

  it("sends the same summary for repeat_confirmation", () => {
    expect(planPetRegistrationReply({ kind: "repeat_confirmation", name: "Pamuk", species: null, complaint: null })).toEqual({
      kind: "send",
      category: "intake_confirmation",
      text: buildIntakeConfirmationText("Pamuk", null, null),
    });
  });

  it("sends the corrected summary back for confirmation on correction", () => {
    expect(planPetRegistrationReply({ kind: "correction", name: "Karabaş", species: "kedi", complaint: "topallıyor" })).toEqual({
      kind: "send",
      category: "intake_confirmation",
      text: buildIntakeConfirmationText("Karabaş", "kedi", "topallıyor"),
    });
  });

  it("asks what to correct on declined, instead of restarting from the generic identity question", () => {
    expect(planPetRegistrationReply({ kind: "declined" })).toEqual({
      kind: "send",
      category: "intake_confirmation",
      text: INTAKE_CORRECTION_PROMPT_TEXT,
    });
    expect(INTAKE_CORRECTION_PROMPT_TEXT).not.toBe(PET_IDENTITY_TEXT);
  });

  it("sends nothing for none", () => {
    expect(planPetRegistrationReply({ kind: "none" })).toEqual({ kind: "none" });
  });

  it("sends nothing for create or confirmed (the caller plans that turn's reply separately)", () => {
    expect(planPetRegistrationReply({ kind: "create", name: "Pamuk", species: null })).toEqual({ kind: "none" });
    expect(planPetRegistrationReply({ kind: "confirmed" })).toEqual({ kind: "none" });
  });

  it("sends nothing for bounded_handoff (the caller builds a handoff plan separately)", () => {
    expect(planPetRegistrationReply({ kind: "bounded_handoff" })).toEqual({ kind: "none" });
  });
});

describe("planPostConfirmationReply", () => {
  it("keeps the immediate worsening-case contact path in the appointment invitation", () => {
    expect(POST_CONFIRMATION_APPOINTMENT_INVITATION_TEXT).toContain("durum kötüleşirse");
    expect(POST_CONFIRMATION_APPOINTMENT_INVITATION_TEXT).toContain("en yakın açık veteriner kliniğine başvurun");
    expect(POST_CONFIRMATION_APPOINTMENT_INVITATION_TEXT).toMatch(/Randevu oluşturmak ister misiniz\?$/u);
  });

  it("invites a safely confirmed intake into appointment booking even when no complaint was collected", () => {
    const context = baseContext();
    const plan = planned({ data: { pet_name: "Pamuk", species: null, complaint: null, symptoms: [] } }) as Extract<PlanResult, { kind: "planned" }>;
    expect(planPostConfirmationReply(context, plan)).toEqual({
      kind: "send",
      category: "intake_received",
      text: POST_CONFIRMATION_APPOINTMENT_INVITATION_TEXT,
    });
  });

  it("uses the same fixed invitation when a complaint was collected", () => {
    const context = baseContext();
    const plan = planned({ data: { pet_name: "Pamuk", species: null, complaint: "kontrol" } }) as Extract<PlanResult, { kind: "planned" }>;
    expect(planPostConfirmationReply(context, plan)).toEqual({
      kind: "send",
      category: "intake_received",
      text: POST_CONFIRMATION_APPOINTMENT_INVITATION_TEXT,
    });
  });

  it("keeps deterministic safety copy ahead of the invitation", () => {
    const context = baseContext();
    const plan = planned({ data: { pet_name: "Pamuk", species: "kedi" } }) as Extract<PlanResult, { kind: "planned" }>;
    plan.safetyDecision = { kind: "needs_safety_check", unknownSignals: ["breathing_difficulty"] };

    const reply = planPostConfirmationReply(context, plan);

    expect(reply.kind).toBe("send");
    if (reply.kind === "send") {
      expect(reply.category).toBe("safety_questions");
      expect(reply.text).not.toBe(POST_CONFIRMATION_APPOINTMENT_INVITATION_TEXT);
    }
  });

  it("never routes to human_handoff or emergency copy from a plain post-confirmation turn", () => {
    const context = baseContext();
    const plan = planned({ data: { pet_name: "Pamuk", species: null } }) as Extract<PlanResult, { kind: "planned" }>;
    const reply = planPostConfirmationReply(context, plan);
    expect(reply.kind).toBe("send");
    if (reply.kind === "send") {
      expect(reply.category).not.toBe("human_handoff");
      expect(reply.category).not.toBe("emergency_handoff");
    }
  });
});
