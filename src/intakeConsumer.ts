import type { Env } from "./env";
import { parseIntakeQueueMessage } from "./intakeQueue";
import { claimIntakeQueueJob, finalizeIntakeQueueJob } from "./intakeJobLease";
import type { FinalizeIntakeQueueJobInput } from "./intakeJobLease";
import { getConversationIntakeContext } from "./conversationState";
import type { IntakeStage } from "./conversationState";
import { extractIntakeViaOpenAi } from "./openaiIntake";
import { planIntakeTurn } from "./intakeTurn";
import type { PersistedIntakeData } from "./intakeTurn";
import type { IntakeExtraction } from "./intakeExtraction";
import type { SafetyDecision } from "./safetyDecision";

export type QueueDisposition = "ack" | "retry";

const SAFETY_IDENTIFIER_DOMAIN = "vetai-owner:";

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

    const safetyIdentifier = await deriveSafetyIdentifier(context.ownerId);
    const extractionResult = await extractIntakeViaOpenAi(claim.messageText, safetyIdentifier, env);
    if (!extractionResult.ok) return "retry";
    const extraction = extractionResult.extraction;

    const plan = planIntakeTurn(context, extraction);

    let nextStage: IntakeStage;
    let petId: string | null;
    let intakeData: PersistedIntakeData;

    if (plan.kind === "planned") {
      if (!isHandoffConsistent(context.intakeStage, plan.nextStage, plan.safetyDecision)) return "retry";

      if (plan.nextStage === "completed" && (plan.safetyDecision.kind === "emergency_handoff" || plan.safetyDecision.kind === "human_handoff")) {
        console.warn("intake consumer: terminal_safety_signal");
      }

      nextStage = plan.nextStage;
      petId = plan.petId;
      intakeData = plan.intakeData;
    } else {
      console.warn("intake consumer: poison_intake_state");
      const fallback = poisonFallback(context.intakeStage, extraction);
      nextStage = fallback.nextStage;
      petId = null;
      intakeData = fallback.intakeData;
    }

    const finalizeInput: FinalizeIntakeQueueJobInput = {
      conversationId,
      providerMessageId,
      claimToken: claim.claimToken,
      expectedVersion: context.stateVersion,
      nextStage,
      petId,
      intakeData: intakeData as unknown as Record<string, unknown>,
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
