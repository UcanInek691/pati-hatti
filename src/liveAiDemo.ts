/**
 * Local-only isolated Turkish live-chat surface (Task 028). This is a
 * separate Worker entry that is never imported by src/index.ts or any
 * production runtime module. It sends synthetic free text to the real
 * OpenAI Responses API through the existing reviewed adapter, then reuses
 * the existing pure planners over a fixed synthetic clinic/owner/pet
 * context. It performs no WhatsApp send, Supabase mutation, Queue
 * operation, staff notification, or appointment booking, and holds no
 * Supabase/Meta credential — only an OpenAI API key.
 */
import type { ConversationIntakeContext, IntakePet, IntakeStage } from "./conversationState";
import { planIntakeTurn, readCanonicalPersistedSnapshot } from "./intakeTurn";
import { planIntakeReply } from "./intakeReply";
import { planAppointmentAction } from "./appointmentFlow";
import { extractIntakeViaOpenAiForEvaluation, EVALUATION_MODELS } from "./openaiIntake";
import type { EvaluationModel } from "./openaiIntake";

interface LiveAiDemoEnv {
  OPENAI_API_KEY?: string;
}

const CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_CODE_POINTS = 2000;
const MAX_CALLS_PER_SESSION = 20;
const SAFETY_IDENTIFIER = "vetai-live-ai-demo-local-session";

const BANNER_TEXT =
  "Canlı yapay zekâ testi — girdiğiniz metin gerçekten OpenAI'ye gönderilir. Yalnızca uydurma/sentetik metin kullanın.";

const INTAKE_STAGES = new Set<IntakeStage>([
  "pet_identification",
  "complaint_collection",
  "intake_confirmation",
  "safety_check",
  "ready_for_triage",
  "appointment_offer",
  "appointment_selection",
  "appointment_confirmation",
  "human_handoff",
  "completed",
]);

function isIntakeStage(value: unknown): value is IntakeStage {
  return typeof value === "string" && INTAKE_STAGES.has(value as IntakeStage);
}

function isEvaluationModel(value: string): value is EvaluationModel {
  return (EVALUATION_MODELS as readonly string[]).includes(value);
}

const SYNTHETIC_PET: IntakePet = { id: "live-demo-synthetic-pet", name: "Deneme Kedi", species: "kedi" };
const SYNTHETIC_CONVERSATION_ID = "live-demo-synthetic-conversation";
const SYNTHETIC_CLINIC_ID = "live-demo-synthetic-clinic";
const SYNTHETIC_OWNER_ID = "live-demo-synthetic-owner";
const SYNTHETIC_OWNER_NAME = "Deneme Sahip";

interface ClientState {
  intakeStage: IntakeStage;
  intakeData: Record<string, unknown>;
  petId: string | null;
  callCount: number;
}

function initialState(): ClientState {
  return { intakeStage: "pet_identification", intakeData: {}, petId: null, callCount: 0 };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function parseIntakeData(value: unknown): Record<string, unknown> | null {
  const parsed = readCanonicalPersistedSnapshot(value);
  return parsed.ok ? (parsed.value as unknown as Record<string, unknown>) : null;
}

const STATE_KEYS = ["intakeStage", "intakeData", "petId", "callCount"] as const;

function parseClientState(value: unknown): ClientState | null {
  if (value === null) return initialState();
  if (!isPlainObject(value)) return null;

  const keys = Reflect.ownKeys(value);
  if (keys.length !== STATE_KEYS.length || !STATE_KEYS.every((key) => keys.includes(key))) return null;

  const { intakeStage, intakeData, petId, callCount } = value as Record<string, unknown>;
  if (!isIntakeStage(intakeStage)) return null;
  const parsedIntakeData = parseIntakeData(intakeData);
  if (parsedIntakeData === null) return null;
  if (petId !== null && petId !== SYNTHETIC_PET.id) return null;
  if (typeof callCount !== "number" || !Number.isInteger(callCount) || callCount < 0 || callCount > MAX_CALLS_PER_SESSION) {
    return null;
  }

  return { intakeStage, intakeData: parsedIntakeData, petId, callCount };
}

interface ParsedMessageRequest {
  message: string;
  model: EvaluationModel;
  state: ClientState;
}

const REQUEST_KEYS = ["message", "model", "state"] as const;

function parseRequestBody(value: unknown): ParsedMessageRequest | null {
  if (!isPlainObject(value)) return null;

  const keys = Reflect.ownKeys(value);
  if (keys.length !== REQUEST_KEYS.length || !REQUEST_KEYS.every((key) => keys.includes(key))) return null;

  const { message, model, state } = value as Record<string, unknown>;
  if (typeof message !== "string") return null;
  const length = Array.from(message).length;
  if (length === 0 || length > MAX_MESSAGE_CODE_POINTS) return null;

  if (typeof model !== "string" || !isEvaluationModel(model)) return null;

  const parsedState = parseClientState(state);
  if (parsedState === null || parsedState.callCount >= MAX_CALLS_PER_SESSION) return null;

  return { message, model, state: parsedState };
}

/** Reads the request body while enforcing a byte-count cap and strict UTF-8 decoding. */
async function readBodyText(request: Request, limit: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function htmlResponse(): Response {
  return new Response(LIVE_AI_DEMO_HTML, {
    status: 200,
    headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}

function scriptResponse(): Response {
  return new Response(LIVE_AI_DEMO_APP_JS, {
    status: 200,
    headers: { ...SECURITY_HEADERS, "Content-Type": "text/javascript; charset=utf-8" },
  });
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

async function handleMessageRequest(request: Request, env: LiveAiDemoEnv): Promise<Response> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return badRequest();

  const text = await readBodyText(request, MAX_BODY_BYTES);
  if (text === null) return badRequest();

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    return badRequest();
  }

  const parsedBody = parseRequestBody(parsedJson);
  if (parsedBody === null) return badRequest();

  const { message, model, state } = parsedBody;
  const newCallCount = state.callCount + 1;

  const context: ConversationIntakeContext = {
    conversationId: SYNTHETIC_CONVERSATION_ID,
    clinicId: SYNTHETIC_CLINIC_ID,
    ownerId: SYNTHETIC_OWNER_ID,
    petId: state.petId,
    status: "active",
    intakeStage: state.intakeStage,
    intakeData: state.intakeData,
    stateVersion: 1,
    ownerName: SYNTHETIC_OWNER_NAME,
    pets: [SYNTHETIC_PET],
    recentMessages: [],
  };

  const aiResult = await extractIntakeViaOpenAiForEvaluation(message, SAFETY_IDENTIFIER, model, {
    OPENAI_API_KEY: env.OPENAI_API_KEY,
  });

  if (!aiResult.ok) {
    return Response.json(
      {
        ok: false,
        model: aiResult.model,
        elapsedMs: aiResult.elapsedMs,
        state: { ...state, callCount: newCallCount },
      },
      { status: 200, headers: SECURITY_HEADERS },
    );
  }

  const plan = planIntakeTurn(context, aiResult.extraction);
  const appointmentAction = planAppointmentAction(context, plan, message);
  const reply = appointmentAction.kind === "none" ? planIntakeReply(context.intakeStage, plan) : null;

  const nextState: ClientState =
    plan.kind === "planned"
      ? {
          intakeStage: plan.nextStage,
          intakeData: plan.intakeData as unknown as Record<string, unknown>,
          petId: plan.petId,
          callCount: newCallCount,
        }
      : { ...state, callCount: newCallCount };

  return Response.json(
    {
      ok: true,
      extraction: aiResult.extraction,
      plan,
      appointmentAction,
      reply,
      model: aiResult.model,
      elapsedMs: aiResult.elapsedMs,
      usage: aiResult.usage,
      state: nextState,
    },
    { status: 200, headers: SECURITY_HEADERS },
  );
}

const LIVE_AI_DEMO_HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VetAI Canlı Yapay Zekâ Test Ekranı</title>
</head>
<body>
<header>
  <h1>VetAI Canlı Yapay Zekâ Test Ekranı</h1>
  <p id="banner" role="status">${BANNER_TEXT}</p>
</header>

<section aria-labelledby="about-heading">
  <h2 id="about-heading">Bu ekran ne yapar, ne yapmaz?</h2>
  <ul>
    <li>Yazdığınız metin gerçekten OpenAI'ye gönderilir; bu bir simülasyon değildir.</li>
    <li>Gerçek bir kişi, klinik, telefon numarası, hasta veya hayvan bilgisi girmeyin — yalnızca uydurma/sentetik metin kullanın.</li>
    <li>Bu ekran WhatsApp mesajı göndermez, personeli bilgilendirmez, veritabanını değiştirmez veya gerçek bir randevu oluşturmaz.</li>
    <li>Sayfayı yenilemek veya oturumu sıfırlamak, yerel oturumu tamamen temizler.</li>
    <li>Model bu görevde yalnızca o anki mesajı görür; önceki turdaki kısa yanıtları yorumlamaz (bu, ayrı bir görev kapsamındadır).</li>
  </ul>
  <p>Bir tarayıcı oturumu en fazla 20 canlı çağrı ile sınırlıdır. Bu sayaç bir faturalandırma limiti değildir; ayrı test projesinin kullanımını ve maliyetini OpenAI panelinden izleyin.</p>
  <p id="error-region" role="alert" aria-live="assertive"></p>
</section>

<section aria-labelledby="chat-heading">
  <h2 id="chat-heading">Sohbet</h2>
  <p>Kalan çağrı hakkı: <span id="calls-remaining">20</span></p>
  <label for="model-select">Model</label>
  <select id="model-select">
    <option value="gpt-5.6-luna">Luna</option>
    <option value="gpt-5.6-terra">Terra</option>
  </select>
  <div id="conversation" aria-live="polite"></div>
  <form id="message-form">
    <label for="message-input">Mesaj (sentetik/uydurma metin)</label>
    <textarea id="message-input" maxlength="2000"></textarea>
    <button type="submit" id="send-button">Gönder</button>
  </form>
  <button type="button" id="reset-button">Oturumu sıfırla</button>
</section>

<script src="/app.js"></script>
</body>
</html>
`;

const LIVE_AI_DEMO_APP_JS = `"use strict";

const MAX_CALLS = 20;

let state = null;
let callsUsed = 0;

const conversation = document.getElementById("conversation");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const modelSelect = document.getElementById("model-select");
const sendButton = document.getElementById("send-button");
const resetButton = document.getElementById("reset-button");
const errorRegion = document.getElementById("error-region");
const callsRemainingEl = document.getElementById("calls-remaining");

function updateCallsRemaining() {
  const remaining = MAX_CALLS - callsUsed;
  callsRemainingEl.textContent = String(remaining);
  if (remaining <= 0) {
    sendButton.disabled = true;
    messageInput.disabled = true;
  }
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

function renderTurn(userMessage, data) {
  const turn = document.createElement("article");

  const userPara = document.createElement("p");
  const userLabel = document.createElement("strong");
  userLabel.textContent = "Siz: ";
  userPara.appendChild(userLabel);
  const userText = document.createElement("span");
  userText.textContent = userMessage;
  userPara.appendChild(userText);
  turn.appendChild(userPara);

  if (!data.ok) {
    addRow(turn, "Sonuç", "OpenAI çağrısı başarısız oldu veya API anahtarı yapılandırılmamış.");
    addRow(turn, "Model", data.model);
    addRow(turn, "Süre (ms)", String(data.elapsedMs));
    conversation.appendChild(turn);
    return;
  }

  addRow(turn, "Model", data.model);
  addRow(turn, "Süre (ms)", String(data.elapsedMs));
  if (data.usage) {
    addRow(turn, "Token kullanımı", "girdi=" + data.usage.inputTokens + " çıktı=" + data.usage.outputTokens + " toplam=" + data.usage.totalTokens);
  } else {
    addRow(turn, "Token kullanımı", "Bilinmiyor (sağlayıcı raporlamadı)");
  }

  addRow(turn, "Niyet (model)", data.extraction.intent);
  addRow(turn, "Hayvan adı (model)", data.extraction.pet_name === null ? "belirtilmedi" : data.extraction.pet_name);
  addRow(turn, "Şikayet (model)", data.extraction.complaint === null ? "belirtilmedi" : data.extraction.complaint);

  if (data.plan.kind === "failed") {
    addRow(turn, "Planlama", "Başarısız — insana devredilir");
  } else {
    addRow(turn, "Sonraki aşama", data.plan.nextStage);
    addRow(turn, "Hayvan eşleşmesi", data.plan.petResolution.kind);
    addRow(turn, "Güvenlik kararı", data.plan.safetyDecision.kind);
  }

  addRow(turn, "Randevu işlemi", data.appointmentAction.kind);

  if (data.reply === null) {
    addRow(turn, "Planlanan yanıt", "Bu turda yanıt metni üretilmedi (randevu akışı veritabanında planlanır)");
  } else if (data.reply.kind === "none") {
    addRow(turn, "Planlanan yanıt", "Yanıt yok");
  } else {
    addRow(turn, "Planlanan yanıt", data.reply.text);
  }

  const note = document.createElement("p");
  note.textContent = "Not: Bu ekran hiçbir gerçek mesaj göndermez, veritabanı değiştirmez veya personeli bilgilendirmez.";
  turn.appendChild(note);

  conversation.appendChild(turn);
}

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorRegion.textContent = "";

  const message = messageInput.value;
  if (message.trim() === "") return;
  if (callsUsed >= MAX_CALLS) return;

  sendButton.disabled = true;
  try {
    const res = await fetch("/api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: message, model: modelSelect.value, state: state }),
    });
    if (!res.ok) {
      throw new Error("request failed");
    }
    const data = await res.json();
    state = data.state;
    callsUsed = data.state.callCount;
    renderTurn(message, data);
    messageInput.value = "";
  } catch {
    errorRegion.textContent = "İstek başarısız oldu.";
  } finally {
    updateCallsRemaining();
    if (callsUsed < MAX_CALLS) sendButton.disabled = false;
  }
});

resetButton.addEventListener("click", () => {
  state = null;
  callsUsed = 0;
  conversation.textContent = "";
  errorRegion.textContent = "";
  messageInput.value = "";
  sendButton.disabled = false;
  messageInput.disabled = false;
  updateCallsRemaining();
});

updateCallsRemaining();
`;

export default {
  async fetch(request: Request, env: LiveAiDemoEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return htmlResponse();
    }

    if (url.pathname === "/app.js") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return scriptResponse();
    }

    if (url.pathname === "/api/message") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return handleMessageRequest(request, env);
    }

    return notFound();
  },
};
