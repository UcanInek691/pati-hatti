import type { ConversationIntakeContext, IntakeStage } from "./conversationState";
import { parseIntakeExtraction, resolvePet } from "./intakeExtraction";
import type { IntakeExtraction, IntakeIntent, MissingInformationItem, PetResolution, ReportedSafetySignals } from "./intakeExtraction";
import { evaluateSafetyDecision } from "./safetyDecision";
import type { SafetyDecision } from "./safetyDecision";

export interface PersistedIntakeData {
  schema_version: 1;
  intent: IntakeIntent;
  pet_name: string | null;
  species: string | null;
  complaint: string | null;
  symptoms: string[];
  reported_safety_signals: ReportedSafetySignals;
  missing_information: MissingInformationItem[];
  user_requested_human: boolean;
  /**
   * Task 039 Part B: set only by `finalize_appointment_cancel_offer_queue_job`,
   * which pins the exact appointment slot being offered for cancellation so
   * `finalize_appointment_cancel_decision_queue_job` re-validates that same
   * appointment rather than any replacement. Opaque to this module — never
   * produced by extraction, never merged, only passed through unchanged.
   */
  pending_cancel_slot_id: string | null;
}

export type PlanResult =
  | {
      kind: "planned";
      nextStage: IntakeStage;
      petId: string | null;
      intakeData: PersistedIntakeData;
      petResolution: PetResolution;
      safetyDecision: SafetyDecision;
    }
  | { kind: "failed" };

const PERSISTED_DATA_KEYS = [
  "schema_version",
  "intent",
  "pet_name",
  "species",
  "complaint",
  "symptoms",
  "reported_safety_signals",
  "missing_information",
  "user_requested_human",
  "pending_cancel_slot_id",
] as const;

const MAX_SYMPTOMS = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Pre-Task-039 persisted rows have no `pending_cancel_slot_id` key at all.
// Accepted as an equally-valid legacy shape (defaulting to null) so an
// in-flight conversation from before this migration is never treated as
// invalid by the fail-closed exact-key boundary below.
const LEGACY_PERSISTED_DATA_KEYS = PERSISTED_DATA_KEYS.filter((key) => key !== "pending_cancel_slot_id");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function emptySnapshot(): PersistedIntakeData {
  return {
    schema_version: 1,
    intent: "unknown",
    pet_name: null,
    species: null,
    complaint: null,
    symptoms: [],
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
    missing_information: [],
    user_requested_human: false,
    pending_cancel_slot_id: null,
  };
}

type SnapshotResult = { kind: "empty" } | { kind: "snapshot"; value: PersistedIntakeData } | { kind: "invalid" };

/** Fails closed on any shape outside the exact empty-object or exact PersistedIntakeData trust boundary. */
function parsePersistedSnapshot(value: unknown): SnapshotResult {
  try {
    if (!isPlainObject(value)) return { kind: "invalid" };

    const keys = Reflect.ownKeys(value);
    if (keys.length === 0) return { kind: "empty" };

    const hasPendingCancelKey = keys.includes("pending_cancel_slot_id");
    const expectedKeys: readonly string[] = hasPendingCancelKey ? PERSISTED_DATA_KEYS : LEGACY_PERSISTED_DATA_KEYS;
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string") ||
      !expectedKeys.every((key) => keys.includes(key))
    ) {
      return { kind: "invalid" };
    }
    if (value.schema_version !== 1) return { kind: "invalid" };

    const pendingCancelSlotId = hasPendingCancelKey ? value.pending_cancel_slot_id : null;
    if (pendingCancelSlotId !== null && !(typeof pendingCancelSlotId === "string" && UUID_PATTERN.test(pendingCancelSlotId))) {
      return { kind: "invalid" };
    }

    const parsed = parseIntakeExtraction({
      intent: value.intent,
      pet_name: value.pet_name,
      species: value.species,
      complaint: value.complaint,
      symptoms: value.symptoms,
      reported_safety_signals: value.reported_safety_signals,
      missing_information: value.missing_information,
      user_requested_human: value.user_requested_human,
    });
    if (!parsed.ok) return { kind: "invalid" };

    return {
      kind: "snapshot",
      value: { schema_version: 1, ...parsed.value, pending_cancel_slot_id: pendingCancelSlotId },
    };
  } catch {
    return { kind: "invalid" };
  }
}

function mergeSymptoms(stored: readonly string[], current: readonly string[]): string[] {
  const merged = [...stored];
  const seen = new Set(merged);
  for (const symptom of current) {
    if (!seen.has(symptom)) {
      merged.push(symptom);
      seen.add(symptom);
    }
  }
  return merged.length > MAX_SYMPTOMS ? merged.slice(merged.length - MAX_SYMPTOMS) : merged;
}

function mergeSafetySignals(stored: ReportedSafetySignals, current: ReportedSafetySignals): ReportedSafetySignals {
  const merged: ReportedSafetySignals = { ...stored };
  for (const key of Object.keys(stored) as (keyof ReportedSafetySignals)[]) {
    if (stored[key] === true) {
      merged[key] = true;
    } else if (current[key] === null) {
      merged[key] = stored[key];
    } else {
      merged[key] = current[key];
    }
  }
  return merged;
}

/**
 * A selected-pet conflict is about a different animal, so an old explicit
 * `false` must not turn the new animal's `null` into a false assurance. Keep
 * only sticky prior emergencies; otherwise the current turn is authoritative.
 */
function mergeConflictSafetySignals(stored: ReportedSafetySignals, current: ReportedSafetySignals): ReportedSafetySignals {
  const merged: ReportedSafetySignals = { ...current };
  for (const key of Object.keys(stored) as (keyof ReportedSafetySignals)[]) {
    if (stored[key] === true) merged[key] = true;
  }
  return merged;
}

/** Deterministic merge of a validated current-turn extraction into the accepted persisted snapshot. See `docs/intake-turn-planning.md`. */
function mergeSnapshot(stored: PersistedIntakeData, extraction: IntakeExtraction): PersistedIntakeData {
  return {
    schema_version: 1,
    intent: extraction.intent !== "unknown" ? extraction.intent : stored.intent,
    pet_name: extraction.pet_name !== null ? extraction.pet_name : stored.pet_name,
    species: extraction.species !== null ? extraction.species : stored.species,
    complaint: extraction.complaint !== null ? extraction.complaint : stored.complaint,
    symptoms: mergeSymptoms(stored.symptoms, extraction.symptoms),
    reported_safety_signals: mergeSafetySignals(stored.reported_safety_signals, extraction.reported_safety_signals),
    missing_information: [...extraction.missing_information],
    user_requested_human: stored.user_requested_human || extraction.user_requested_human,
    pending_cancel_slot_id: stored.pending_cancel_slot_id,
  };
}

export type CanonicalSnapshotResult = { ok: true; value: PersistedIntakeData } | { ok: false };

/**
 * Fail-closed reader for the no-model consumer path (Task 029): returns a
 * fresh canonical `PersistedIntakeData` for the already-supported empty
 * object or a valid persisted snapshot, and `{ ok: false }` for every other
 * shape. Reuses `parsePersistedSnapshot`'s exact-key/schema/parser trust
 * boundary rather than duplicating it.
 */
export function readCanonicalPersistedSnapshot(intakeData: unknown): CanonicalSnapshotResult {
  const result = parsePersistedSnapshot(intakeData);
  if (result.kind === "invalid") return { ok: false };
  return { ok: true, value: result.kind === "snapshot" ? result.value : emptySnapshot() };
}

type PetOutcome = { petId: string | null; resolution: PetResolution };

/** Retains an already-selected pet as authoritative; only a same-turn explicit conflicting name yields clarification. */
function resolvePetForContext(context: ConversationIntakeContext, extraction: IntakeExtraction, merged: PersistedIntakeData): PetOutcome | null {
  if (context.petId !== null) {
    const stillPresent = context.pets.filter((pet) => pet.id === context.petId).length === 1;
    if (!stillPresent) return null;

    if (extraction.pet_name !== null) {
      const attempt = resolvePet(extraction, context.pets);
      if (attempt.kind === "matched" && attempt.petId === context.petId) {
        return { petId: context.petId, resolution: { kind: "matched", petId: context.petId } };
      }
      return { petId: context.petId, resolution: { kind: "needs_clarification" } };
    }

    return { petId: context.petId, resolution: { kind: "matched", petId: context.petId } };
  }

  const resolution = resolvePet(merged, context.pets);
  return resolution.kind === "matched" ? { petId: resolution.petId, resolution } : { petId: null, resolution };
}

/**
 * True once we know *which* animal the conversation is about, whether or not a
 * `public.pets` row exists for it yet: a matched pet, or (Task 037 decision 3)
 * an unbound conversation's captured candidate name that `intake_confirmation`
 * will put back to the owner before anything is written. `resolvePetForContext`
 * never yields `new_candidate` while a pet is already selected, so this is
 * decision 3's "only when `context.petId === null`" rule without repeating it.
 */
function isPetIdentityKnown(petResolution: PetResolution): boolean {
  return petResolution.kind === "matched" || petResolution.kind === "new_candidate";
}

/**
 * Task 037 decision 5: while a pet is already selected, an explicit name that
 * does not resolve back to that same pet (a different match, an ambiguous
 * one, or a brand-new candidate) is a conflicting second animal, not a
 * correction — the active conversation may carry the selected pet's clinical
 * history and must not be silently relinked or blended with another animal's.
 */
function detectSelectedPetConflict(context: ConversationIntakeContext, extraction: IntakeExtraction): boolean {
  if (context.petId === null || extraction.pet_name === null) return false;
  const attempt = resolvePet(extraction, context.pets);
  return !(attempt.kind === "matched" && attempt.petId === context.petId);
}

/**
 * Task 037 decision 5: on a selected-pet conflict, keep the selected pet's
 * identity and clinical facts exactly as stored — only the safety-gate inputs
 * (`intent`, `reported_safety_signals`, `user_requested_human`) still merge,
 * so a true emergency reported alongside the conflicting name still escalates.
 */
function mergeSnapshotPreservingIdentity(stored: PersistedIntakeData, extraction: IntakeExtraction): PersistedIntakeData {
  return {
    schema_version: 1,
    intent: extraction.intent !== "unknown" ? extraction.intent : stored.intent,
    pet_name: stored.pet_name,
    species: stored.species,
    complaint: stored.complaint,
    symptoms: stored.symptoms,
    reported_safety_signals: mergeConflictSafetySignals(stored.reported_safety_signals, extraction.reported_safety_signals),
    missing_information: stored.missing_information,
    user_requested_human: stored.user_requested_human || extraction.user_requested_human,
    pending_cancel_slot_id: stored.pending_cancel_slot_id,
  };
}

/**
 * Task 039 decision: an `appointment_cancel_request` is the only thing that
 * can move a conversation out of the otherwise-terminal `completed` stage,
 * and it can do so from any non-`human_handoff` stage. Safety/handoff
 * precedence is unchanged: a `completed` conversation with no cancel intent
 * stays `completed` even under an emergency signal, exactly as before.
 */
function decideNextStage(
  currentStage: IntakeStage,
  safetyDecision: SafetyDecision,
  identityKnown: boolean,
  merged: PersistedIntakeData,
  petConflict: boolean,
): IntakeStage {
  const wantsCancel = identityKnown && merged.intent === "appointment_cancel_request";

  if (currentStage === "completed") {
    if (!wantsCancel) return "completed";
    if (petConflict || safetyDecision.kind === "emergency_handoff" || safetyDecision.kind === "human_handoff") {
      return "human_handoff";
    }
    return "appointment_cancel_confirmation";
  }
  if (petConflict || safetyDecision.kind === "emergency_handoff" || safetyDecision.kind === "human_handoff") return "human_handoff";
  if (currentStage === "human_handoff") return "human_handoff";

  if (currentStage === "appointment_cancel_confirmation") {
    // Held deliberately, mirroring `appointment_selection`: only the
    // deterministic EVET/HAYIR RPC path (via `planAppointmentAction`'s
    // `cancel_decision`) advances out of this stage.
    return "appointment_cancel_confirmation";
  }
  if (wantsCancel) return "appointment_cancel_confirmation";

  if (currentStage === "pet_identification") {
    return identityKnown ? "complaint_collection" : "pet_identification";
  }
  if (currentStage === "complaint_collection") {
    return merged.complaint !== null || merged.symptoms.length > 0 ? "intake_confirmation" : "complaint_collection";
  }
  if (currentStage === "intake_confirmation") {
    // Held deliberately. Only an owner's answer settles a confirmation, and
    // that answer is read by `planPetRegistrationAction`, which drives the
    // advance to `safety_check` through the consumer.
    return "intake_confirmation";
  }
  if (currentStage === "safety_check") {
    return safetyDecision.kind === "continue_intake" ? "ready_for_triage" : "safety_check";
  }

  return currentStage;
}

/**
 * Pure, provider-neutral planner for one intake turn. Combines the already-
 * validated current-turn extraction with the conversation's persisted intake
 * snapshot, resolves the pet only against tenant-scoped context, evaluates
 * the existing deterministic safety gate, and chooses a database-valid next
 * intake stage. Performs no persistence, LLM call, or other external effect.
 */
export function planIntakeTurn(context: ConversationIntakeContext, extraction: IntakeExtraction): PlanResult {
  try {
    const snapshotResult = parsePersistedSnapshot(context.intakeData);
    if (snapshotResult.kind === "invalid") return { kind: "failed" };
    const stored = snapshotResult.kind === "snapshot" ? snapshotResult.value : emptySnapshot();

    const petConflict = detectSelectedPetConflict(context, extraction);
    const merged = petConflict ? mergeSnapshotPreservingIdentity(stored, extraction) : mergeSnapshot(stored, extraction);

    const resolvedPetOutcome = resolvePetForContext(context, extraction, merged);
    if (resolvedPetOutcome === null) return { kind: "failed" };

    // A cancellation can target only an existing, tenant-scoped pet. When an
    // unbound conversation names something that does not match exactly, keep
    // the turn at pet clarification instead of treating the name as a new-pet
    // candidate and entering a cancellation stage with no cancellable pet.
    const petOutcome =
      context.petId === null &&
      merged.intent === "appointment_cancel_request" &&
      resolvedPetOutcome.resolution.kind !== "matched"
        ? { petId: null, resolution: { kind: "needs_clarification" as const } }
        : resolvedPetOutcome;

    const safetyDecision = evaluateSafetyDecision(merged);
    const nextStage = decideNextStage(
      context.intakeStage,
      safetyDecision,
      isPetIdentityKnown(petOutcome.resolution),
      merged,
      petConflict,
    );

    return {
      kind: "planned",
      nextStage,
      petId: petOutcome.petId,
      intakeData: merged,
      petResolution: petOutcome.resolution,
      safetyDecision,
    };
  } catch {
    return { kind: "failed" };
  }
}
