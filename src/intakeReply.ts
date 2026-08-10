import type { IntakeStage } from "./conversationState";
import type { PlanResult } from "./intakeTurn";
import type { SafetySignal } from "./safetyDecision";

export type IntakeReplyCategory =
  | "emergency_handoff"
  | "human_handoff"
  | "safety_questions"
  | "pet_identity"
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
const PET_IDENTITY_TEXT = "Hangi evcil hayvanınız için yazıyorsunuz? Lütfen adını belirtin.";
const COMPLAINT_TEXT = "Evcil hayvanınızla ilgili sizi endişelendiren durumu veya fark ettiğiniz belirtileri kısaca yazar mısınız?";
const INTAKE_RECEIVED_TEXT =
  "Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum kötüleşirse kliniğimizi telefonla arayın ya da en yakın açık veteriner kliniğine başvurun.";
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
 * Pure, provider-neutral planner that converts an already-reviewed intake-turn
 * result into a closed, fixed-copy Turkish reply or an explicit `none`. Never
 * calls an LLM and never inserts dynamic user/provider data into reply text.
 * See `docs/intake-replies.md` for the exact precedence and copy.
 */
export function planIntakeReply(currentStage: IntakeStage, result: PlanResult): IntakeReplyPlan {
  if (currentStage === "completed") return { kind: "none" };

  if (result.kind === "failed") return sendReply("human_handoff", HUMAN_HANDOFF_TEXT);

  const { nextStage, petResolution, intakeData, safetyDecision } = result;

  if (safetyDecision.kind === "emergency_handoff") return sendReply("emergency_handoff", EMERGENCY_HANDOFF_TEXT);
  if (safetyDecision.kind === "human_handoff") return sendReply("human_handoff", HUMAN_HANDOFF_TEXT);
  if (nextStage === "human_handoff") return sendReply("human_handoff", HUMAN_HANDOFF_TEXT);

  if (safetyDecision.kind === "needs_safety_check") return planSafetyQuestionsReply(safetyDecision.unknownSignals);

  if (petResolution.kind === "needs_clarification") return sendReply("pet_identity", PET_IDENTITY_TEXT);

  if (intakeData.complaint === null && intakeData.symptoms.length === 0) return sendReply("complaint", COMPLAINT_TEXT);

  return sendReply("intake_received", INTAKE_RECEIVED_TEXT);
}
