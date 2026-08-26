/**
 * Local-only Turkish product-behavior simulator (Task 027). This is a
 * separate Worker entry that is never imported by src/index.ts or any
 * production runtime module, performs no outbound fetch, database mutation,
 * Queue operation, or persistence, and holds no Supabase/OpenAI/Meta
 * credential. It reuses the reviewed pure planners over fixed synthetic
 * fixtures only.
 */
import type { ConversationIntakeContext, IntakePet, IntakeStage } from "./conversationState";
import type { IntakeExtraction, ReportedSafetySignals } from "./intakeExtraction";
import { planIntakeTurn } from "./intakeTurn";
import type { PlanResult } from "./intakeTurn";
import { planIntakeReply } from "./intakeReply";
import type { IntakeReplyPlan } from "./intakeReply";
import { planAppointmentAction } from "./appointmentFlow";
import type { AppointmentAction } from "./appointmentFlow";

const CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const BANNER_TEXT = "Yerel simülasyon — gerçek WhatsApp, yapay zekâ ve veritabanı kullanılmaz.";

function allSignalsFalse(): ReportedSafetySignals {
  return {
    breathing_difficulty: false,
    loss_of_consciousness: false,
    active_seizure: false,
    heavy_bleeding: false,
    major_trauma: false,
    possible_toxin_exposure: false,
    possible_foreign_object: false,
    unable_to_urinate: false,
  };
}

function allSignalsUnknown(): ReportedSafetySignals {
  return {
    breathing_difficulty: null,
    loss_of_consciousness: null,
    active_seizure: null,
    heavy_bleeding: null,
    major_trauma: null,
    possible_toxin_exposure: null,
    possible_foreign_object: null,
    unable_to_urinate: null,
  };
}

function baseExtraction(overrides: Partial<IntakeExtraction>): IntakeExtraction {
  return {
    intent: "unknown",
    pet_name: null,
    species: null,
    complaint: null,
    symptoms: [],
    reported_safety_signals: allSignalsFalse(),
    missing_information: [],
    user_requested_human: false,
    ...overrides,
  };
}

function baseContext(overrides: Partial<ConversationIntakeContext>): ConversationIntakeContext {
  return {
    conversationId: "demo-conversation",
    clinicId: "demo-clinic",
    ownerId: "demo-owner",
    petId: null,
    status: "active",
    intakeStage: "pet_identification",
    intakeData: {},
    stateVersion: 1,
    ownerName: "Demo Sahip",
    pets: [],
    recentMessages: [],
    ...overrides,
  };
}

const PET_BONCUK: IntakePet = { id: "demo-pet-boncuk", name: "Boncuk", species: "kedi" };
const PET_ZEYTIN: IntakePet = { id: "demo-pet-zeytin", name: "Zeytin", species: "köpek" };
const PET_DUMAN: IntakePet = { id: "demo-pet-duman", name: "Duman", species: "köpek" };
const PET_MIA: IntakePet = { id: "demo-pet-mia", name: "Mia", species: "kedi" };

const APPOINTMENT_INTAKE_DATA: Record<string, unknown> = {
  schema_version: 1,
  intent: "appointment_request",
  pet_name: "Duman",
  species: "köpek",
  complaint: "Kontrol için randevu istiyorum",
  symptoms: [],
  reported_safety_signals: allSignalsFalse(),
  missing_information: [],
  user_requested_human: false,
};

interface ScenarioDefinition {
  id: string;
  label: string;
  messageText: string;
  context: ConversationIntakeContext;
  extraction: IntakeExtraction;
}

const SCENARIOS: readonly ScenarioDefinition[] = [
  {
    id: "bilinen-hayvan-sikayet",
    label: "1) Bilinen hayvan + sıradan şikayet",
    messageText: "Kedim Boncuk üç gündür iştahsız duruyor.",
    context: baseContext({ intakeStage: "pet_identification", pets: [PET_BONCUK] }),
    extraction: baseExtraction({
      intent: "report_symptom",
      pet_name: "Boncuk",
      species: "kedi",
      complaint: "İştahsızlık",
      symptoms: ["iştahsızlık"],
    }),
  },
  {
    id: "hayvan-kimlik-belirsiz",
    label: "2) Hangi hayvan olduğu belirsiz",
    messageText: "Hasta gibi görünüyor, yardım eder misiniz?",
    context: baseContext({ intakeStage: "pet_identification", pets: [PET_BONCUK, PET_ZEYTIN] }),
    extraction: baseExtraction({ intent: "report_symptom", complaint: "Halsiz görünüyor", symptoms: ["halsizlik"] }),
  },
  {
    id: "guvenlik-bilinmiyor",
    label: "3) Güvenlik soruları bilinmiyor",
    messageText: "Az önce bir kaza oldu, ne yapmalıyım bilmiyorum.",
    context: baseContext({
      intakeStage: "safety_check",
      petId: PET_DUMAN.id,
      pets: [PET_DUMAN],
      intakeData: {
        schema_version: 1,
        intent: "report_symptom",
        pet_name: "Duman",
        species: "köpek",
        complaint: "Aracın altında kaldı",
        symptoms: ["olası travma"],
        reported_safety_signals: allSignalsUnknown(),
        missing_information: [],
        user_requested_human: false,
      },
    }),
    extraction: baseExtraction({ intent: "report_symptom", reported_safety_signals: allSignalsUnknown() }),
  },
  {
    id: "acil-sinyal",
    label: "4) Açık acil durum sinyali",
    messageText: "Kedim nefes alamıyor, çok kötü durumda!",
    context: baseContext({ intakeStage: "complaint_collection", petId: PET_MIA.id, pets: [PET_MIA] }),
    extraction: baseExtraction({
      intent: "report_symptom",
      complaint: "Nefes almakta çok zorlanıyor",
      symptoms: ["nefes darlığı"],
      reported_safety_signals: { ...allSignalsFalse(), breathing_difficulty: true },
    }),
  },
  {
    id: "insan-talebi",
    label: "5) Doğrudan personel talebi",
    messageText: "Lütfen beni bir görevliye bağlayın, robotla konuşmak istemiyorum.",
    context: baseContext({ intakeStage: "complaint_collection", petId: PET_MIA.id, pets: [PET_MIA] }),
    extraction: baseExtraction({ intent: "human_handoff", user_requested_human: true, complaint: "Biriyle konuşmak istiyorum" }),
  },
  {
    id: "tibbi-tavsiye-talebi",
    label: "6) Tıbbi tavsiye / teşhis talebi",
    messageText: "Köpeğime hangi ağrı kesiciyi kaç mg vermeliyim?",
    context: baseContext({ intakeStage: "complaint_collection", petId: PET_MIA.id, pets: [PET_MIA] }),
    extraction: baseExtraction({ intent: "medical_advice_request", complaint: "Hangi ilacı ne kadar vermeliyim?" }),
  },
  {
    id: "randevu-teklifi",
    label: "7) Randevu talebi → teklif aşamasına ulaşır",
    messageText: "Duman için kontrol randevusu almak istiyorum.",
    context: baseContext({
      intakeStage: "safety_check",
      petId: PET_DUMAN.id,
      pets: [PET_DUMAN],
      intakeData: APPOINTMENT_INTAKE_DATA,
    }),
    extraction: baseExtraction({ intent: "appointment_request", pet_name: "Duman", complaint: "Kontrol için randevu istiyorum" }),
  },
  {
    id: "randevu-evet",
    label: "8) Randevu teklifine tam EVET yanıtı",
    messageText: "EVET",
    context: baseContext({
      intakeStage: "appointment_selection",
      petId: PET_DUMAN.id,
      pets: [PET_DUMAN],
      intakeData: APPOINTMENT_INTAKE_DATA,
    }),
    extraction: baseExtraction({ intent: "appointment_request", pet_name: "Duman", complaint: "Kontrol için randevu istiyorum" }),
  },
  {
    id: "randevu-hayir",
    label: "9) Randevu teklifine tam HAYIR yanıtı",
    messageText: "HAYIR",
    context: baseContext({
      intakeStage: "appointment_selection",
      petId: PET_DUMAN.id,
      pets: [PET_DUMAN],
      intakeData: APPOINTMENT_INTAKE_DATA,
    }),
    extraction: baseExtraction({ intent: "appointment_request", pet_name: "Duman", complaint: "Kontrol için randevu istiyorum" }),
  },
  {
    id: "randevu-tanimsiz",
    label: "10) Randevu teklifine anlaşılmayan yanıt",
    messageText: "tamam",
    context: baseContext({
      intakeStage: "appointment_selection",
      petId: PET_DUMAN.id,
      pets: [PET_DUMAN],
      intakeData: APPOINTMENT_INTAKE_DATA,
    }),
    extraction: baseExtraction({ intent: "appointment_request", pet_name: "Duman", complaint: "Kontrol için randevu istiyorum" }),
  },
];

const SCENARIO_MAP: ReadonlyMap<string, ScenarioDefinition> = new Map(SCENARIOS.map((scenario) => [scenario.id, scenario]));

interface ScenarioResult {
  scenarioId: string;
  scenarioLabel: string;
  messageText: string;
  plan: PlanResult;
  appointmentAction: AppointmentAction;
  reply: IntakeReplyPlan | null;
}

/**
 * Mirrors the real intake-consumer routing order (see src/intakeConsumer.ts):
 * a reply is only planned when no appointment action was taken, because the
 * actual appointment-offer/decision reply text is produced inside the
 * database RPC, not by these pure TypeScript functions.
 */
function runScenario(definition: ScenarioDefinition): ScenarioResult {
  const plan = planIntakeTurn(definition.context, definition.extraction);
  const appointmentAction = planAppointmentAction(definition.context, plan, definition.messageText);
  const reply = appointmentAction.kind === "none" ? planIntakeReply(definition.context.intakeStage, plan) : null;

  return {
    scenarioId: definition.id,
    scenarioLabel: definition.label,
    messageText: definition.messageText,
    plan,
    appointmentAction,
    reply,
  };
}

const LOCAL_DEMO_HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VetAI Yerel Test Ekranı</title>
</head>
<body>
<header>
  <h1>VetAI Yerel Test Ekranı</h1>
  <p id="banner" role="status">${BANNER_TEXT}</p>
</header>

<section aria-labelledby="about-heading">
  <h2 id="about-heading">Bu ekran ne işe yarar?</h2>
  <p>Bu sayfa, gerçek bir mesajlaşma veya yapay zekâ çağrısı olmadan botun karar mantığını göstermek içindir.</p>
  <p><strong>Test edilen:</strong> Hayvan tanıma, şikayet toplama, güvenlik soru sırası, acil/insan devri kuralları ve randevu teklif/karar akışının, incelenmiş ve onaylanmış kararlı kod tarafından nasıl işlendiği.</p>
  <p><strong>Test edilmeyen:</strong> Gerçek WhatsApp mesajlaşması, gerçek yapay zekâ (OpenAI) yanıtı, gerçek veritabanı (Supabase) kaydı, gerçek randevu saatleri, gerçek personel bildirimi. Hiçbir gerçek kişi, telefon numarası veya hayvan bilgisi kullanılmaz.</p>
  <p id="error-region" role="alert" aria-live="assertive"></p>
</section>

<section aria-labelledby="scenarios-heading">
  <h2 id="scenarios-heading">Senaryolar</h2>
  <ul id="scenario-list"></ul>
  <button type="button" id="reset-button">Ekranı sıfırla</button>
</section>

<section aria-labelledby="result-heading">
  <h2 id="result-heading">Sonuç</h2>
  <div id="result-panel"></div>
</section>

<script src="/app.js"></script>
</body>
</html>
`;

const LOCAL_DEMO_APP_JS = `"use strict";

const STAGE_LABELS = {
  pet_identification: "Hayvan kimliği belirleniyor",
  complaint_collection: "Şikayet toplanıyor",
  intake_confirmation: "Bilgi onayı bekleniyor",
  safety_check: "Güvenlik kontrolü",
  ready_for_triage: "Değerlendirmeye hazır",
  appointment_offer: "Randevu teklif aşaması",
  appointment_selection: "Randevu seçim aşaması",
  appointment_confirmation: "Randevu onay aşaması",
  human_handoff: "İnsana devredildi",
  completed: "Tamamlandı",
};

const SAFETY_KIND_LABELS = {
  emergency_handoff: "ACİL — insana devredildi",
  human_handoff: "İnsana devredildi",
  needs_safety_check: "Güvenlik soruları soruluyor",
  continue_intake: "Otomasyon devam ediyor",
};

const SAFETY_REASON_LABELS = {
  user_requested_human: "Kullanıcı personel istedi",
  medical_advice_request: "Tıbbi tavsiye/teşhis talebi",
};

const PET_RESOLUTION_LABELS = {
  matched: "Hayvan eşleşti",
  needs_clarification: "Hangi hayvan olduğu belirsiz",
};

const REPLY_CATEGORY_LABELS = {
  emergency_handoff: "Acil yönlendirme mesajı",
  human_handoff: "Personel yönlendirme mesajı",
  safety_questions: "Güvenlik soruları",
  pet_identity: "Hayvan kimliği sorusu",
  intake_confirmation: "Bilgi onay sorusu",
  complaint: "Şikayet sorusu",
  intake_received: "Bilgi alındı mesajı",
};

const APPOINTMENT_DECISION_LABELS = {
  confirm: "Randevu onay kararı işlenecek (EVET)",
  decline: "Randevu iptal kararı işlenecek (HAYIR)",
  repeat: "Anlaşılmadı, teklif tekrar sorulacak",
};

const scenarioList = document.getElementById("scenario-list");
const resultPanel = document.getElementById("result-panel");
const resetButton = document.getElementById("reset-button");
const errorRegion = document.getElementById("error-region");

function clearResult() {
  resultPanel.textContent = "";
  errorRegion.textContent = "";
}

function addRow(container, labelText, valueText) {
  const row = document.createElement("p");
  const label = document.createElement("strong");
  label.textContent = labelText + ": ";
  row.appendChild(label);
  const value = document.createElement("span");
  value.textContent = valueText;
  row.appendChild(value);
  container.appendChild(row);
}

function renderResult(data) {
  resultPanel.textContent = "";

  const title = document.createElement("h3");
  title.textContent = data.scenarioLabel;
  resultPanel.appendChild(title);

  addRow(resultPanel, "Sentetik kullanıcı mesajı", data.messageText);

  if (data.plan.kind === "failed") {
    addRow(resultPanel, "Planlama sonucu", "Başarısız — insana devredilir");
    return;
  }

  const plan = data.plan;
  addRow(resultPanel, "Sonraki aşama", STAGE_LABELS[plan.nextStage] || plan.nextStage);
  addRow(resultPanel, "Hayvan eşleşmesi", PET_RESOLUTION_LABELS[plan.petResolution.kind] || plan.petResolution.kind);

  const safety = plan.safetyDecision;
  let safetyText = SAFETY_KIND_LABELS[safety.kind] || safety.kind;
  if (safety.kind === "human_handoff") {
    safetyText += " (" + (SAFETY_REASON_LABELS[safety.reason] || safety.reason) + ")";
  }
  if (safety.kind === "emergency_handoff") {
    safetyText += " (" + safety.positiveSignals.join(", ") + ")";
  }
  if (safety.kind === "needs_safety_check") {
    safetyText += " (" + safety.unknownSignals.length + " soru)";
  }
  addRow(resultPanel, "Güvenlik kararı", safetyText);

  const action = data.appointmentAction;
  let actionText = action.kind === "none" ? "Randevu işlemi yok" : action.kind === "offer" ? "Randevu teklif edilecek (gerçek saat/slot veritabanından gelir, burada gösterilmez)" : (APPOINTMENT_DECISION_LABELS[action.decision] || action.decision);
  addRow(resultPanel, "Randevu işlemi", actionText);

  if (data.reply === null) {
    addRow(resultPanel, "Planlanan yanıt", "Bu senaryoda yanıt metni burada üretilmez (gerçek randevu mesajı veritabanında planlanır)");
  } else if (data.reply.kind === "none") {
    addRow(resultPanel, "Planlanan yanıt", "Yanıt yok (konuşma tamamlandı)");
  } else {
    addRow(resultPanel, "Yanıt kategorisi", REPLY_CATEGORY_LABELS[data.reply.category] || data.reply.category);
    addRow(resultPanel, "Planlanan yanıt metni", data.reply.text);
  }

  const note = document.createElement("p");
  note.textContent = "Not: Bu ekran hiçbir mesaj göndermez, veritabanı değiştirmez veya personeli bilgilendirmez.";
  resultPanel.appendChild(note);
}

async function runScenario(scenarioId) {
  clearResult();
  try {
    const res = await fetch("/api/scenario", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarioId: scenarioId }),
    });
    if (!res.ok) {
      throw new Error("scenario request failed");
    }
    const data = await res.json();
    renderResult(data);
  } catch {
    errorRegion.textContent = "Senaryo çalıştırılamadı.";
  }
}

async function loadScenarios() {
  scenarioList.textContent = "";
  try {
    const res = await fetch("/api/scenarios");
    if (!res.ok) {
      throw new Error("scenario list failed");
    }
    const items = await res.json();
    for (const item of items) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.label;
      button.addEventListener("click", () => {
        runScenario(item.id);
      });
      li.appendChild(button);
      scenarioList.appendChild(li);
    }
  } catch {
    errorRegion.textContent = "Senaryo listesi yüklenemedi.";
  }
}

resetButton.addEventListener("click", () => {
  clearResult();
});

loadScenarios();
`;

function htmlResponse(): Response {
  return new Response(LOCAL_DEMO_HTML, {
    status: 200,
    headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}

function scriptResponse(): Response {
  return new Response(LOCAL_DEMO_APP_JS, {
    status: 200,
    headers: { ...SECURITY_HEADERS, "Content-Type": "text/javascript; charset=utf-8" },
  });
}

function scenarioListResponse(): Response {
  return Response.json(
    SCENARIOS.map((scenario) => ({ id: scenario.id, label: scenario.label })),
    { status: 200, headers: SECURITY_HEADERS },
  );
}

function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: SECURITY_HEADERS });
}

function badRequest(): Response {
  return new Response("Bad Request", { status: 400, headers: SECURITY_HEADERS });
}

function methodNotAllowed(allow: string): Response {
  return new Response("Method Not Allowed", { status: 405, headers: { ...SECURITY_HEADERS, Allow: allow } });
}

async function handleRunScenarioRequest(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return badRequest();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest();
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.getPrototypeOf(body) !== Object.prototype ||
    Reflect.ownKeys(body).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(body, "scenarioId")
  ) {
    return badRequest();
  }

  const scenarioId = (body as Record<string, unknown>).scenarioId;
  if (typeof scenarioId !== "string") return badRequest();

  const definition = SCENARIO_MAP.get(scenarioId);
  if (!definition) return notFound();

  return Response.json(runScenario(definition), { status: 200, headers: SECURITY_HEADERS });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return htmlResponse();
    }

    if (url.pathname === "/app.js") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return scriptResponse();
    }

    if (url.pathname === "/api/scenarios") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return scenarioListResponse();
    }

    if (url.pathname === "/api/scenario") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return handleRunScenarioRequest(request);
    }

    return notFound();
  },
};
