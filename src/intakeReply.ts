import type { IntakeStage } from "./conversationState";
import type { PlanResult } from "./intakeTurn";
import type { SafetySignal } from "./safetyDecision";
import type { ClinicOperationalContextResult } from "./clinicOperations";

export type IntakeReplyCategory =
  | "emergency_handoff"
  | "human_handoff"
  | "safety_questions"
  | "pet_identity"
  | "intake_confirmation"
  | "complaint"
  | "intake_received"
  | "appointment_offer"
  | "appointment_confirmed"
  | "appointment_declined"
  | "appointment_unavailable";

export type IntakeReplyPlan = { kind: "none" } | { kind: "send"; category: IntakeReplyCategory; text: string };

const EMERGENCY_HANDOFF_TEXT =
  "Bu durum acil olabilir. Bot üzerinden yanıt beklemeyin; en yakın açık veteriner kliniğini hemen arayın veya doğrudan kliniğe başvurun.";
const HUMAN_HANDOFF_TEXT =
  "Bu talebi bot üzerinden yanıtlayamam. Lütfen kliniğimizi telefonla arayın. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.";
// Exported (not duplicated) because src/petRegistration.ts's bounded-attempt
// counter must exact-string-match this value; unlike this repo's usual
// per-file duplication convention for small pure logic, a byte-identical
// string constant is required for that comparison to stay correct, so a
// single source of truth is used here instead.
export const PET_IDENTITY_TEXT = "Hangi evcil hayvanınız için yazıyorsunuz? Lütfen adını belirtin.";
const COMPLAINT_TEXT = "Evcil hayvanınızla ilgili sizi endişelendiren durumu veya fark ettiğiniz belirtileri kısaca yazar mısınız?";
const INTAKE_RECEIVED_TEXT =
  "Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum kötüleşirse kliniğimizi telefonla arayın ya da en yakın açık veteriner kliniğine başvurun.";
const UNSUPPORTED_MEDIA_TEXT =
  "Bu bot şu anda görsel, ses, video, belge, konum veya kişi kartı içeriğini değerlendiremiyor. Lütfen durumu yazılı mesajla açıklayın veya kliniğimizi telefonla arayın. Durum acilse bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.";
const SAFETY_QUESTIONS_PREFIX =
  "Güvenlik için lütfen aşağıdaki soruları her biri için evet veya hayır diye yanıtlayın. Bu durumlardan biri varsa veya emin değilseniz bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun:";

const SAFETY_SIGNAL_QUESTIONS: Record<SafetySignal, string> = {
  breathing_difficulty: "Nefes almakta güçlük var mı?",
  loss_of_consciousness: "Bilinç kaybı var mı?",
  active_seizure: "Şu anda devam eden nöbet var mı?",
  heavy_bleeding: "Şiddetli veya durmayan kanama var mı?",
  major_trauma: "Araç çarpması, yüksekten düşme veya başka ciddi bir travma oldu mu?",
  possible_toxin_exposure: "Zehirli olabilecek bir maddeye maruz kalmış olabilir mi?",
  possible_foreign_object: "Yabancı bir cisim yutmuş olabilir mi?",
  unable_to_urinate: "İdrar yapamıyor mu?",
};

function sendReply(category: IntakeReplyCategory, text: string): IntakeReplyPlan {
  return { kind: "send", category, text };
}

/** Fails closed to the fixed human-handoff reply on an empty or unrecognized signal list; never emits an empty safety prompt. */
function planSafetyQuestionsReply(unknownSignals: readonly SafetySignal[]): IntakeReplyPlan {
  if (unknownSignals.length === 0) return sendReply("human_handoff", HUMAN_HANDOFF_TEXT);

  let text = SAFETY_QUESTIONS_PREFIX;
  for (const signal of unknownSignals) {
    if (!Object.prototype.hasOwnProperty.call(SAFETY_SIGNAL_QUESTIONS, signal)) {
      return sendReply("human_handoff", HUMAN_HANDOFF_TEXT);
    }
    text += `\n- ${SAFETY_SIGNAL_QUESTIONS[signal]}`;
  }
  return sendReply("safety_questions", text);
}

/**
 * Fixed reply for an inbound message the bot recognized but cannot interpret
 * (the closed unsupported-media set). Reuses the neutral informational
 * `intake_received` category so no database category value changes. Claims no
 * analysis, upload, notification, or staff action, and keeps an immediate
 * off-bot emergency path.
 */
export function planUnsupportedMediaReply(): IntakeReplyPlan {
  return sendReply("intake_received", UNSUPPORTED_MEDIA_TEXT);
}

/**
 * Pure, provider-neutral planner that converts an already-reviewed intake-turn
 * result into a closed, fixed-copy Turkish reply or an explicit `none`. Never
 * calls an LLM and never inserts dynamic user/provider data into reply text.
 * See `docs/intake-replies.md` for the exact precedence and copy.
 */
export function planIntakeReply(currentStage: IntakeStage, result: PlanResult): IntakeReplyPlan {
  if (currentStage === "completed") return { kind: "none" };

  if (result.kind === "failed") return sendReply("human_handoff", HUMAN_HANDOFF_TEXT);

  const { nextStage, intakeData, safetyDecision } = result;

  if (safetyDecision.kind === "emergency_handoff") return sendReply("emergency_handoff", EMERGENCY_HANDOFF_TEXT);
  if (safetyDecision.kind === "human_handoff") return sendReply("human_handoff", HUMAN_HANDOFF_TEXT);
  if (nextStage === "human_handoff") return sendReply("human_handoff", HUMAN_HANDOFF_TEXT);

  if (safetyDecision.kind === "needs_safety_check") return planSafetyQuestionsReply(safetyDecision.unknownSignals);

  // Task 036: keyed on the stage, not on `petResolution`. Since the pet row is
  // no longer written in `pet_identification`, a first-time owner keeps
  // resolving as `needs_clarification` for the rest of the conversation — this
  // used to re-ask "hangi hayvanınız" forever once the flow had moved on.
  // `decideNextStage` holds at `pet_identification` exactly while the identity
  // is still unknown, so that is the honest condition.
  if (nextStage === "pet_identification") return sendReply("pet_identity", PET_IDENTITY_TEXT);

  if (intakeData.complaint === null && intakeData.symptoms.length === 0) return sendReply("complaint", COMPLAINT_TEXT);

  return sendReply("intake_received", INTAKE_RECEIVED_TEXT);
}

function clinicHandoffText(context: ClinicOperationalContextResult): string {
  if (context.result !== "configured") return HUMAN_HANDOFF_TEXT;

  const { clinicName, phone, isOpen } = context;
  if (isOpen) {
    return `Bu talebi bot üzerinden yanıtlayamam. ${clinicName} ile ${phone} numarasından iletişime geçin. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.`;
  }
  return `Bu talebi bot üzerinden yanıtlayamam. ${clinicName} şu anda kapalı. Acil olmayan konular için çalışma saatleri içinde ${phone} numarasından iletişime geçin. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.`;
}

/**
 * Personalizes only an existing `{ kind: "send", category: "human_handoff" }`
 * plan with configured clinic name/phone and truthful open/closed wording.
 * Every other category, `none`, and any non-`configured` operational-context
 * result return a fresh, behaviorally identical plan using the existing
 * generic `HUMAN_HANDOFF_TEXT`. Never interpolates owner, pet, complaint,
 * message, address, provider, or model data.
 */
export function applyClinicHandoffContext(plan: IntakeReplyPlan, context: ClinicOperationalContextResult): IntakeReplyPlan {
  if (plan.kind !== "send" || plan.category !== "human_handoff") {
    return plan.kind === "none" ? { kind: "none" } : { kind: "send", category: plan.category, text: plan.text };
  }
  return sendReply("human_handoff", clinicHandoffText(context));
}
