import type { Env } from "./env";
import { parseIntakeQueueMessage } from "./intakeQueue";
import { claimIntakeQueueJob, finalizeIntakeQueueJob } from "./intakeJobLease";
import type { FinalizeIntakeQueueJobInput } from "./intakeJobLease";
import { getConversationIntakeContext } from "./conversationState";
import type { ConversationIntakeContext, IntakeStage } from "./conversationState";
import { extractIntakeViaOpenAi } from "./openaiIntake";
import { planIntakeTurn, readCanonicalPersistedSnapshot } from "./intakeTurn";
import type { PersistedIntakeData, PlanResult } from "./intakeTurn";
import type { IntakeExtraction } from "./intakeExtraction";
import { evaluateSafetyDecision, type SafetyDecision } from "./safetyDecision";
import { planIntakeReply, planUnsupportedMediaReply } from "./intakeReply";
import type { IntakeReplyPlan } from "./intakeReply";
import { UNSUPPORTED_MEDIA_MARKER } from "./whatsappIngest";
import { planAppointmentAction, finalizeAppointmentOfferQueueJob, finalizeAppointmentDecisionQueueJob } from "./appointmentFlow";

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

/** True when the two most recent outbound messages before the exact current inbound are identical eligible questions. */
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
  return mostRecent === secondMostRecent && isEligibleClinicQuestion(mostRecent!);
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
      if (finalizeResult.kind === "applied" || finalizeResult.kind === "already_completed" || finalizeResult.kind === "stale_claim") {
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
      const replyPlan = planIntakeReply(context.intakeStage, handoffPlan);
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
      if (finalizeResult.kind === "applied" || finalizeResult.kind === "already_completed" || finalizeResult.kind === "stale_claim") {
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
        decisionResult.kind === "already_completed" ||
        decisionResult.kind === "stale_claim"
      ) {
        return "ack";
      }
      return "retry";
    }

    const replyPlan = planIntakeReply(context.intakeStage, effectivePlan);

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

    if (finalizeResult.kind === "applied" || finalizeResult.kind === "already_completed" || finalizeResult.kind === "stale_claim") {
      return "ack";
    }
    return "retry";
  } catch {
    return "retry";
  }
}
