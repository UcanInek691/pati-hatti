import type { Env } from "./env";
import { parseIntakeQueueMessage } from "./intakeQueue";
import { claimIntakeQueueJob, completeIntakeQueueJob, finalizeIntakeQueueJob } from "./intakeJobLease";
import type { FinalizeIntakeQueueJobInput } from "./intakeJobLease";
import { getConversationIntakeContext } from "./conversationState";
import type { ConversationIntakeContext, IntakeStage } from "./conversationState";
import { extractIntakeViaOpenAi } from "./openaiIntake";
import { planIntakeTurn, readCanonicalPersistedSnapshot } from "./intakeTurn";
import type { PersistedIntakeData, PlanResult } from "./intakeTurn";
import type { IntakeExtraction } from "./intakeExtraction";
import { evaluateSafetyDecision, type SafetyDecision } from "./safetyDecision";
import { applyClinicHandoffContext, planIntakeReply, planUnsupportedMediaReply } from "./intakeReply";
import type { IntakeReplyPlan } from "./intakeReply";
import { getConversationClinicOperationalContext } from "./clinicOperations";
import { UNSUPPORTED_MEDIA_MARKER } from "./whatsappIngest";
import { planAppointmentAction, finalizeAppointmentOfferQueueJob, finalizeAppointmentDecisionQueueJob } from "./appointmentFlow";
import { planPetRegistrationAction, planPetRegistrationReply, planPostConfirmationReply } from "./petRegistration";

export type QueueDisposition = "ack" | "retry";

const SAFETY_IDENTIFIER_DOMAIN = "vetai-owner:";
const MAX_PREVIOUS_QUESTION_CODE_POINTS = 4096;
/** Conservative per-conversation paid-work ceiling (Task 029): at this state version, stop calling OpenAI. */
const NO_MODEL_STATE_VERSION_CEILING = 12;

function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** A prior clinic message is usable as short-answer context only if it reads as an actual question of bounded length. */
function isEligibleClinicQuestion(text: string): boolean {
  if (!text.includes("?")) return false;
  const length = codePointLength(text);
  return length >= 1 && length <= MAX_PREVIOUS_QUESTION_CODE_POINTS;
}

/**
 * Selects at most one previous clinic question to give the extractor bounded
 * turn context (Task 029). Returns null unless the most recent recorded
 * message is exactly the current claimed message and the message
 * immediately preceding it (skipping any non-outbound messages) is a single
 * eligible outbound question. Never mutates the supplied context.
 */
function selectPreviousClinicQuestion(context: ConversationIntakeContext, currentMessage: string): string | null {
  if (context.intakeStage === "human_handoff" || context.intakeStage === "completed") return null;

  const messages = context.recentMessages;
  const last = messages[messages.length - 1];
  if (last === undefined || last.direction !== "inbound" || last.content !== currentMessage) return null;

  for (let i = messages.length - 2; i >= 0; i--) {
    const item = messages[i]!;
    if (item.direction !== "outbound") continue;
    return isEligibleClinicQuestion(item.content) ? item.content : null;
  }
  return null;
}

/** True when the current turn's extraction expresses no explicit actionable fact (Task 029 no-progress fallback). */
function isNoActionableFact(extraction: IntakeExtraction): boolean {
  if (extraction.intent !== "unknown") return false;
  if (extraction.pet_name !== null || extraction.species !== null || extraction.complaint !== null) return false;
  if (extraction.symptoms.length > 0) return false;
  if (extraction.user_requested_human) return false;
  return Object.values(extraction.reported_safety_signals).every((value) => value === null);
}

/**
 * True when the last two outbound messages before the exact current inbound
 * are byte-identical and of bounded length.
 *
 * Task 036 dropped the `isEligibleClinicQuestion` test here. That predicate
 * exists to pick a message worth *feeding the extractor* as turn context,
 * where a non-question is useless — but for detecting a stall, the shape of
 * the message is irrelevant. Sending the owner the identical sentence twice
 * while they tell us nothing new is the stall, question mark or not. The old
 * test made `INTAKE_RECEIVED_TEXT` (which contains no "?") permanently exempt,
 * which is exactly what produced the repeated "Bilgileri aldım..." Maya
 * reported on 2026-08-26.
 */
function hasRepeatedNoProgressQuestion(context: ConversationIntakeContext, currentMessage: string): boolean {
  const messages = context.recentMessages;
  const last = messages[messages.length - 1];
  if (last === undefined || last.direction !== "inbound" || last.content !== currentMessage) return false;

  const recentOutbound: string[] = [];
  for (let i = messages.length - 2; i >= 0 && recentOutbound.length < 2; i--) {
    const item = messages[i]!;
    if (item.direction === "outbound") recentOutbound.push(item.content);
  }
  if (recentOutbound.length < 2) return false;
  const [mostRecent, secondMostRecent] = recentOutbound;
  if (mostRecent !== secondMostRecent) return false;
  const length = codePointLength(mostRecent!);
  return length >= 1 && length <= MAX_PREVIOUS_QUESTION_CODE_POINTS;
}

/** Builds a no-model handoff plan while preserving deterministic safety precedence from the canonical snapshot. */
function buildHandoffPlan(petId: string | null, intakeData: PersistedIntakeData): Extract<PlanResult, { kind: "planned" }> {
  return {
    kind: "planned",
    nextStage: "human_handoff",
    petId,
    intakeData,
    petResolution: { kind: "needs_clarification" },
    safetyDecision: evaluateSafetyDecision(intakeData),
  };
}

/** Human-handled turns preserve only an already-selected pet; the closed schema cannot distinguish a new-pet name from an existing-pet name. */
function preserveHumanHandledPetBoundary(
  context: ConversationIntakeContext,
  extraction: IntakeExtraction,
  plan: PlanResult,
): PlanResult {
  const humanHandled =
    extraction.user_requested_human || extraction.intent === "human_handoff" || extraction.intent === "medical_advice_request";
  if (plan.kind !== "planned" || !humanHandled) return plan;

  return {
    ...plan,
    petId: context.petId,
    petResolution: { kind: "needs_clarification" },
  };
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Derives a stable, privacy-preserving OpenAI `safety_identifier` from the owner ID; never sends the raw ID. */
async function deriveSafetyIdentifier(ownerId: string): Promise<string> {
  const data = new TextEncoder().encode(`${SAFETY_IDENTIFIER_DOMAIN}${ownerId}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(digest));
}

/** True unless a handoff-grade safety decision was planned into a non-terminal, non-human-handoff stage. */
function isHandoffConsistent(currentStage: IntakeStage, nextStage: IntakeStage, safetyDecision: SafetyDecision): boolean {
  if (safetyDecision.kind !== "emergency_handoff" && safetyDecision.kind !== "human_handoff") return true;
  if (nextStage === "human_handoff") return true;
  return nextStage === "completed" && currentStage === "completed";
}

/**
 * Personalizes a planned reply with the conversation's own clinic contact/
 * hours only when it is already a `human_handoff` send. Every other category
 * makes no operational-context request and is returned unchanged (Task 031).
 */
/**
 * DRAFT COPY, NOT APPROVED TO SHIP. Task 036 approves the *mechanism* of a
 * recording notice; the wording is a KVKK sign-off item, filed as the third
 * bullet under the human gate in `docs/production-readiness.md` §1, and must
 * not be finalized by an engineer or by the AI. Whatever KVKK returns replaces
 * this string.
 */
export const RECORDING_NOTICE_DRAFT_TEXT =
  "Bilgilendirme: Güvenlik ve yasal yükümlülükler gereği bu görüşmedeki mesajlar kayıt altına alınmaktadır.";

/**
 * Prepends the recording notice to the first reply of a conversation.
 *
 * `stateVersion === 1` is the signal, not "no outbound rows in
 * `recentMessages`": `state_version` defaults to 1 and
 * `advance_conversation_intake` increments it on every finalize, so exactly
 * one turn per conversation ever sees 1, whereas `recentMessages` is a bounded
 * window that could re-qualify a long conversation later. A retry of that same
 * turn re-derives the identical text, and the outbox's one-reply-per-inbound
 * unique constraint keeps it to one row.
 *
 * Known gap, accepted: a first turn that plans no reply at all never carries
 * the notice, and no later turn picks it up. `planIntakeReply` returns `none`
 * only for `completed` and the appointment stages, neither of which a
 * conversation can start in.
 */
function withRecordingNotice(reply: IntakeReplyPlan, context: ConversationIntakeContext): IntakeReplyPlan {
  if (reply.kind !== "send" || context.stateVersion !== 1) return reply;
  return { ...reply, text: `${RECORDING_NOTICE_DRAFT_TEXT}\n\n${reply.text}` };
}

/** Single choke point for every reply this consumer writes to the outbox. */
async function prepareOutboundReply(
  conversationId: string,
  context: ConversationIntakeContext,
  reply: IntakeReplyPlan,
  env: Env,
): Promise<IntakeReplyPlan> {
  if (reply.kind !== "send" || reply.category !== "human_handoff") return withRecordingNotice(reply, context);
  const clinicContext = await getConversationClinicOperationalContext(conversationId, env);
  return withRecordingNotice(applyClinicHandoffContext(reply, clinicContext), context);
}

/** Shared finalize-call/ack-retry decision for the three new pet-registration branches only; the four pre-existing call sites in this file keep their own inline form unchanged. */
async function finalizeAndDecide(input: FinalizeIntakeQueueJobInput, env: Env): Promise<QueueDisposition> {
  const finalizeResult = await finalizeIntakeQueueJob(input, env);
  if (
    finalizeResult.kind === "applied" ||
    finalizeResult.kind === "suppressed" ||
    finalizeResult.kind === "already_completed" ||
    finalizeResult.kind === "stale_claim"
  ) {
    return "ack";
  }
  // "duplicate_pet_name" and "stale_state" both retry: a concurrent turn
  // already changed this conversation (created the pet, or advanced it some
  // other way) since this turn's context was read, and a fresh context read
  // on retry resolves against the real current state instead of a stale one.
  return "retry";
}

/** Replaces a poison persisted snapshot with a fresh, valid one built only from the current validated extraction. */
function poisonFallback(currentStage: IntakeStage, extraction: IntakeExtraction): { nextStage: IntakeStage; intakeData: PersistedIntakeData } {
  return {
    nextStage: currentStage === "completed" ? "completed" : "human_handoff",
    intakeData: {
      schema_version: 1,
      intent: extraction.intent,
      pet_name: extraction.pet_name,
      species: extraction.species,
      complaint: extraction.complaint,
      symptoms: [...extraction.symptoms],
      reported_safety_signals: { ...extraction.reported_safety_signals },
      missing_information: [...extraction.missing_information],
      user_requested_human: extraction.user_requested_human,
    },
  };
}

/**
 * Orchestrates one untrusted Queue body through parse -> claim -> context ->
 * extract -> plan -> atomic finalize, returning an explicit ack/retry
 * disposition. Never throws message content, identifiers, provider bodies,
 * claim tokens, or secrets; catches unexpected exceptions and retries.
 */
export async function processIntakeQueueMessage(body: unknown, env: Env): Promise<QueueDisposition> {
  try {
    const parsed = parseIntakeQueueMessage(body);
    if (!parsed.ok) return "ack";
    const { conversationId, providerMessageId } = parsed.message;

    const claim = await claimIntakeQueueJob(conversationId, providerMessageId, env);
    if (claim.kind === "completed" || claim.kind === "not_found") return "ack";
    if (claim.kind === "busy" || claim.kind === "failed") return "retry";

    if (claim.automationMode !== "ai") {
      // The route changed between ingest and claim (Task 033 race window a):
      // complete the lease immediately and acknowledge, before any context
      // lookup, safety hashing, OpenAI call, planning, appointment call,
      // clinic-hours lookup, or reply creation.
      const completeResult = await completeIntakeQueueJob(conversationId, providerMessageId, claim.claimToken, env);
      return completeResult.kind === "completed" ? "ack" : "retry";
    }

    const contextResult = await getConversationIntakeContext(conversationId, env);
    if (!contextResult.ok) return "retry";
    const context = contextResult.context;

    if (claim.messageText === UNSUPPORTED_MEDIA_MARKER) {
      const snapshot = readCanonicalPersistedSnapshot(context.intakeData);
      if (!snapshot.ok) return "retry";

      let nextStage = context.intakeStage;
      let reply: IntakeReplyPlan = { kind: "none" };
      if (context.intakeStage !== "completed") {
        const handoffPlan = buildHandoffPlan(context.petId, snapshot.value);
        const handoffRequired =
          context.intakeStage === "human_handoff" || context.stateVersion >= NO_MODEL_STATE_VERSION_CEILING;
        if (handoffPlan.safetyDecision.kind === "emergency_handoff" || handoffRequired) {
          nextStage = "human_handoff";
          reply = planIntakeReply(context.intakeStage, handoffPlan);
        } else {
          reply = planUnsupportedMediaReply();
        }
      }
      reply = await prepareOutboundReply(conversationId, context, reply, env);

      const finalizeResult = await finalizeIntakeQueueJob(
        {
          conversationId,
          providerMessageId,
          claimToken: claim.claimToken,
          expectedVersion: context.stateVersion,
          nextStage,
          petId: context.petId,
          intakeData: snapshot.value as unknown as Record<string, unknown>,
          reply,
        },
        env,
      );
      if (
        finalizeResult.kind === "applied" ||
        finalizeResult.kind === "suppressed" ||
        finalizeResult.kind === "already_completed" ||
        finalizeResult.kind === "stale_claim"
      ) {
        return "ack";
      }
      return "retry";
    }

    if (
      context.intakeStage === "human_handoff" ||
      (context.intakeStage !== "completed" && context.stateVersion >= NO_MODEL_STATE_VERSION_CEILING)
    ) {
      const snapshot = readCanonicalPersistedSnapshot(context.intakeData);
      if (!snapshot.ok) return "retry";

      const handoffPlan = buildHandoffPlan(context.petId, snapshot.value);
      const replyPlan = await prepareOutboundReply(conversationId, context, planIntakeReply(context.intakeStage, handoffPlan), env);
      const finalizeInput: FinalizeIntakeQueueJobInput = {
        conversationId,
        providerMessageId,
        claimToken: claim.claimToken,
        expectedVersion: context.stateVersion,
        nextStage: handoffPlan.nextStage,
        petId: handoffPlan.petId,
        intakeData: handoffPlan.intakeData as unknown as Record<string, unknown>,
        reply: replyPlan,
      };
      const finalizeResult = await finalizeIntakeQueueJob(finalizeInput, env);
      if (
        finalizeResult.kind === "applied" ||
        finalizeResult.kind === "suppressed" ||
        finalizeResult.kind === "already_completed" ||
        finalizeResult.kind === "stale_claim"
      ) {
        return "ack";
      }
      return "retry";
    }

    const previousQuestion = selectPreviousClinicQuestion(context, claim.messageText);
    const safetyIdentifier = await deriveSafetyIdentifier(context.ownerId);
    const extractionResult = await extractIntakeViaOpenAi(claim.messageText, safetyIdentifier, env, previousQuestion);
    if (!extractionResult.ok) return "retry";
    const extraction = extractionResult.extraction;

    const plan = preserveHumanHandledPetBoundary(context, extraction, planIntakeTurn(context, extraction));

    let nextStage: IntakeStage;
    let petId: string | null;
    let intakeData: PersistedIntakeData;
    let effectivePlan: PlanResult = plan;

    if (plan.kind === "planned") {
      if (!isHandoffConsistent(context.intakeStage, plan.nextStage, plan.safetyDecision)) return "retry";

      if (plan.nextStage === "completed" && (plan.safetyDecision.kind === "emergency_handoff" || plan.safetyDecision.kind === "human_handoff")) {
        console.warn("intake consumer: terminal_safety_signal");
      }

      const planned =
        context.intakeStage !== "completed" &&
        isNoActionableFact(extraction) &&
        hasRepeatedNoProgressQuestion(context, claim.messageText)
          ? { ...plan, nextStage: "human_handoff" as const }
          : plan;
      effectivePlan = planned;

      nextStage = planned.nextStage;
      petId = planned.petId;
      intakeData = planned.intakeData;
    } else {
      console.warn("intake consumer: poison_intake_state");
      const fallback = poisonFallback(context.intakeStage, extraction);
      nextStage = fallback.nextStage;
      petId = null;
      intakeData = fallback.intakeData;
    }

    const petRegistrationAction = planPetRegistrationAction(context, effectivePlan, claim.messageText);

    if (petRegistrationAction.kind === "bounded_handoff") {
      const handoffPlan = buildHandoffPlan(petId, intakeData);
      const reply = await prepareOutboundReply(conversationId, context, planIntakeReply(context.intakeStage, handoffPlan), env);
      return finalizeAndDecide(
        {
          conversationId,
          providerMessageId,
          claimToken: claim.claimToken,
          expectedVersion: context.stateVersion,
          nextStage: handoffPlan.nextStage,
          petId: handoffPlan.petId,
          intakeData: handoffPlan.intakeData as unknown as Record<string, unknown>,
          reply,
        },
        env,
      );
    }

    if (
      petRegistrationAction.kind === "ask_confirmation" ||
      petRegistrationAction.kind === "repeat_confirmation" ||
      petRegistrationAction.kind === "correction" ||
      petRegistrationAction.kind === "declined"
    ) {
      const reply = await prepareOutboundReply(conversationId, context, planPetRegistrationReply(petRegistrationAction), env);
      // Task 036: `declined` no longer erases `pet_name`/`species`. Throwing
      // away a correct species to fix a wrong name is what forced the owner
      // back to the generic identity question; the reply now asks for the
      // difference and the next turn's extraction overwrites only that.
      return finalizeAndDecide(
        {
          conversationId,
          providerMessageId,
          claimToken: claim.claimToken,
          expectedVersion: context.stateVersion,
          // One literal covers both halves of the stage: entering it from
          // `complaint_collection` (one forward step) and holding inside it
          // (`p_next_stage = current stage`, which the rank rule permits).
          nextStage: "intake_confirmation",
          petId,
          intakeData: intakeData as unknown as Record<string, unknown>,
          reply,
        },
        env,
      );
    }

    if (
      (petRegistrationAction.kind === "create" || petRegistrationAction.kind === "confirmed") &&
      effectivePlan.kind === "planned" &&
      context.intakeStage === "intake_confirmation"
    ) {
      const reply = await prepareOutboundReply(conversationId, context, planPostConfirmationReply(context, effectivePlan), env);
      return finalizeAndDecide(
        {
          conversationId,
          providerMessageId,
          claimToken: claim.claimToken,
          expectedVersion: context.stateVersion,
          nextStage: "safety_check",
          // A `create` has no pet id yet — the row is written inside the same
          // transaction by `finalize_intake_queue_job` and linked there. A
          // `confirmed` already has one and keeps it.
          petId: petRegistrationAction.kind === "create" ? null : petId,
          intakeData: effectivePlan.intakeData as unknown as Record<string, unknown>,
          reply,
          createPetName: petRegistrationAction.kind === "create" ? petRegistrationAction.name : undefined,
          createPetSpecies: petRegistrationAction.kind === "create" ? petRegistrationAction.species : undefined,
        },
        env,
      );
    }

    const appointmentAction = planAppointmentAction(context, effectivePlan, claim.messageText);

    if (appointmentAction.kind === "offer") {
      if (petId === null || (nextStage !== "ready_for_triage" && nextStage !== "appointment_offer")) return "retry";

      const offerResult = await finalizeAppointmentOfferQueueJob(
        {
          conversationId,
          providerMessageId,
          claimToken: claim.claimToken,
          expectedVersion: context.stateVersion,
          plannedNextStage: nextStage,
          petId,
          intakeData: intakeData as unknown as Record<string, unknown>,
        },
        env,
      );
      if (
        offerResult.kind === "offered" ||
        offerResult.kind === "unavailable" ||
        offerResult.kind === "suppressed" ||
        offerResult.kind === "already_completed" ||
        offerResult.kind === "stale_claim"
      ) {
        return "ack";
      }
      return "retry";
    }

    if (appointmentAction.kind === "decision") {
      if (petId === null) return "retry";

      const decisionResult = await finalizeAppointmentDecisionQueueJob(
        {
          conversationId,
          providerMessageId,
          claimToken: claim.claimToken,
          expectedVersion: context.stateVersion,
          decision: appointmentAction.decision,
          petId,
          intakeData: intakeData as unknown as Record<string, unknown>,
        },
        env,
      );
      if (
        decisionResult.kind === "confirmed" ||
        decisionResult.kind === "declined" ||
        decisionResult.kind === "repeated" ||
        decisionResult.kind === "stale_hold" ||
        decisionResult.kind === "suppressed" ||
        decisionResult.kind === "already_completed" ||
        decisionResult.kind === "stale_claim"
      ) {
        return "ack";
      }
      return "retry";
    }

    const replyPlan = await prepareOutboundReply(conversationId, context, planIntakeReply(context.intakeStage, effectivePlan), env);

    const finalizeInput: FinalizeIntakeQueueJobInput = {
      conversationId,
      providerMessageId,
      claimToken: claim.claimToken,
      expectedVersion: context.stateVersion,
      nextStage,
      petId,
      intakeData: intakeData as unknown as Record<string, unknown>,
      reply: replyPlan,
    };
    const finalizeResult = await finalizeIntakeQueueJob(finalizeInput, env);

    if (
      finalizeResult.kind === "applied" ||
      finalizeResult.kind === "suppressed" ||
      finalizeResult.kind === "already_completed" ||
      finalizeResult.kind === "stale_claim"
    ) {
      return "ack";
    }
    return "retry";
  } catch {
    return "retry";
  }
}
