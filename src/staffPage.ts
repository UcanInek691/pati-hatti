import type { Env } from "./env";
import { PANEL_STYLES, PANEL_STYLES_CSP_HASH } from "./panelStyles";

export interface StaffConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export const STAFF_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function normalizeSupabaseUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    return null;
  }

  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    return null;
  }

  return parsed.origin;
}

export function readStaffConfig(env: Env): StaffConfig | null {
  const supabaseUrl = env.SUPABASE_URL?.trim();
  const supabaseAnonKey = env.SUPABASE_ANON_KEY?.trim();
  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }
  const normalizedUrl = normalizeSupabaseUrl(supabaseUrl);
  if (!normalizedUrl) {
    return null;
  }
  return { supabaseUrl: normalizedUrl, supabaseAnonKey };
}

function serviceUnavailable(): Response {
  return new Response("Service Unavailable", { status: 503, headers: STAFF_SECURITY_HEADERS });
}

export const STAFF_HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>Pati Hattı Personel Paneli</title>
<style>${PANEL_STYLES}</style>
</head>
<body>
<header class="app-header">
  <p class="app-eyebrow">Pati Hattı</p>
  <h1>Pati Hattı Personel Paneli</h1>
  <p class="app-subtitle">Klinik işleri, otomasyon ve çalışma takvimi</p>
  <p id="status-region" role="status" aria-live="polite"></p>
  <p id="error-region" role="alert" aria-live="assertive"></p>
</header>

<nav id="section-nav" aria-label="Panel bölümleri" hidden>
  <button type="button" class="nav-tab" id="nav-tab-queue" data-destination="queue" aria-controls="queue-section" aria-current="true">İşler</button>
  <button type="button" class="nav-tab" id="nav-tab-automation" data-destination="automation" aria-controls="automation-section" aria-current="false">WhatsApp otomasyonu</button>
  <button type="button" class="nav-tab" id="nav-tab-schedule" data-destination="schedule" aria-controls="schedule-section" aria-current="false">Takvim</button>
  <button type="button" class="nav-tab" id="nav-tab-alerts" data-destination="alerts" aria-controls="alert-prefs-section" aria-current="false">E-posta uyarıları</button>
</nav>

<main>
<section id="login-section" aria-labelledby="login-heading">
  <h2 id="login-heading">Giriş</h2>
  <form id="login-form">
    <label for="email-input">E-posta</label>
    <input type="email" id="email-input" name="email" required autocomplete="username">
    <label for="password-input">Şifre</label>
    <input type="password" id="password-input" name="password" required autocomplete="current-password">
    <button type="submit" class="btn-primary">Giriş yap</button>
  </form>
</section>

<section id="queue-section" aria-labelledby="queue-heading" hidden>
  <h2 id="queue-heading">Açık işler</h2>
  <button type="button" id="refresh-button">Yenile</button>
  <button type="button" id="logout-button">Çıkış yap</button>
  <button type="button" id="notify-button">Bildirimleri aç</button>
  <span id="notify-status"></span>
  <ul id="queue-list"></ul>
</section>

<section id="automation-section" aria-labelledby="automation-heading" hidden>
  <h2 id="automation-heading">WhatsApp otomasyonu</h2>
  <p id="automation-policy-region" hidden>Strict whitelist doğrulandı: yalnızca listede <strong>AI açık</strong> olarak işaretlenen numaralar otomatik işlenir. Meta imzalı webhook'u Pati Hattı'na iletir; listede olmayan numaraların yönlendirme zarfı kontrol edildikten sonra mesaj içeriği incelenmez, kaydedilmez ve bot yanıt vermez.</p>
  <p id="automation-status-region" role="status" aria-live="polite"></p>
  <p id="automation-error-region" role="alert" aria-live="assertive"></p>
  <label for="account-select">Hat</label>
  <select id="account-select"></select>
  <ul id="route-list"></ul>
  <form id="route-form">
    <label for="contact-input">Telefon numarası (+90...)</label>
    <input type="text" id="contact-input" name="contact" required>
    <button type="submit" name="mode" value="ai">AI açık</button>
    <button type="submit" name="mode" value="manual">Sadece insan</button>
    <button type="submit" name="mode" value="personal">Kişisel / yok say</button>
    <button type="submit" name="mode" value="inherit">Numara varsayılanı</button>
  </form>
  <dl>
    <dt>AI açık</dt>
    <dd>Bu numaradan gelen mesajlara Pati Hattı otomatik yanıt verir.</dd>
    <dt>Sadece insan</dt>
    <dd>Bu numaradan gelen mesajlar klinik için Pati Hattı'nda kaydedilir; Pati Hattı otomatik yanıt vermez ve OpenAI çağırmaz. Numarayı yalnızca personel telefonla veya başka bir kanaldan yanıtlayabilir.</dd>
    <dt>Kişisel / yok say</dt>
    <dd>Meta imzalı webhook'u Pati Hattı'na iletir. Yönlendirme zarfı kontrol edildikten sonra mesaj içeriği incelenmez, hashlenmez, loglanmaz, Supabase veya OpenAI'a gönderilmez ve kaydedilmez. Açık bir Kişisel kaydı seçerseniz yönlendirme için telefon numarası Pati Hattı'nda saklanır; listede olmayan numara için rota kaydı tutulmaz. Bot otomatik yanıt vermez.</dd>
    <dt>Numara varsayılanı</dt>
    <dd>Bu numara için özel ayar silinir; gelecekteki mesajlar kişisel varsayılana döner.</dd>
  </dl>
  <p>Modu insan veya kişisel olarak değiştirmek önceki kayıtları silmez. Daha önce işlenmek üzere alınmış bir yanıtın süresi dolarsa kalan sınırlı denemeleri yapılabilir ve yanıt ulaşabilir; Meta'ya verilmiş bir istek geri çağrılamaz. Bu işlem hiçbir personeli bilgilendirmez ve otomatik bir insan yanıtı oluşturmaz.</p>
</section>

<section id="schedule-section" aria-labelledby="schedule-heading" hidden>
  <h2 id="schedule-heading">Klinik takvimi</h2>
  <label for="clinic-select">Klinik</label>
  <select id="clinic-select"></select>
  <p id="schedule-readonly-notice" hidden>Bu ayarları yalnızca klinik yöneticisi değiştirebilir.</p>
  <p id="schedule-status-region" role="status" aria-live="polite"></p>
  <p id="schedule-error-region" role="alert" aria-live="assertive"></p>
  <p>Saat ve kapanış değişiklikleri onaylı veya tutulan randevuları iptal etmez, taşımaz ve sahiplerine bildirim göndermez.</p>

  <div class="table-wrap">
  <table>
    <caption>Haftalık çalışma saatleri</caption>
    <thead>
      <tr><th>Gün</th><th>Açık</th><th>Açılış</th><th>Kapanış</th><th></th></tr>
    </thead>
    <tbody id="weekly-hours-body"></tbody>
  </table>
  </div>

  <h3>Kapanış günleri</h3>
  <form id="closure-form" hidden>
    <label for="closure-date-input">Tarih</label>
    <input type="date" id="closure-date-input" data-schedule-mutation-control required>
    <button type="submit" data-schedule-mutation-control>Ekle</button>
  </form>
  <ul id="closure-list"></ul>

  <h3>Randevu slotları</h3>
  <form id="generate-form" hidden>
    <label for="generate-date-input">Slot üretilecek tarih</label>
    <input type="date" id="generate-date-input" data-schedule-mutation-control required>
    <button type="submit" data-schedule-mutation-control>Slotları üret</button>
  </form>
  <ul id="slot-list"></ul>
</section>

<section id="alert-prefs-section" aria-labelledby="alert-prefs-heading" hidden>
  <h2 id="alert-prefs-heading">E-posta uyarı tercihleri</h2>
  <p id="alert-prefs-status-region" role="status" aria-live="polite"></p>
  <p id="alert-prefs-error-region" role="alert" aria-live="assertive"></p>
  <p>Klinik geneli anahtarı yalnızca platform yöneticisi açabilir. O anahtar kapalıyken, kendi tercihiniz açık olsa bile size e-posta gönderilmez. Kapatmadan önce gönderimi başlamış bir e-posta geri çağrılamaz ve yine de ulaşabilir.</p>
  <div class="table-wrap">
  <table>
    <caption>Klinik uyarıları</caption>
    <thead>
      <tr><th>Klinik</th><th>Klinik geneli anahtar</th><th>Benim tercihim</th><th>Etkin</th></tr>
    </thead>
    <tbody id="alert-prefs-body"></tbody>
  </table>
  </div>
</section>

<section id="detail-section" aria-labelledby="detail-heading" hidden>
  <h2 id="detail-heading">Detay</h2>
  <p id="workitem-status-region"></p>
  <div id="detail-content"></div>
  <div id="reply-composer" hidden>
    <h3>Personel yanıtı</h3>
    <label for="reply-content-input">Mesaj</label>
    <textarea id="reply-content-input" rows="4"></textarea>
    <p id="reply-char-count"></p>
    <button type="button" id="reply-send-button" disabled>Yanıtı kuyruğa al</button>
    <p id="reply-status-region" role="status" aria-live="polite"></p>
    <p id="reply-error-region" role="alert" aria-live="assertive"></p>
  </div>
  <button type="button" id="claim-button">İşi üstlen</button>
  <button type="button" id="resolve-button">Çözüldü olarak işaretle</button>
  <button type="button" id="back-button">Listeye dön</button>
</section>
</main>

<script src="/staff/app.js"></script>
</body>
</html>
`;

export const STAFF_APP_JS = `"use strict";

const SESSION_STORAGE_KEY = "vetai_staff_access_token";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTACT_E164_PATTERN = /^\\+[1-9]\\d{1,14}$/;
const POLL_INTERVAL_MS = 30000;

const statusRegion = document.getElementById("status-region");
const errorRegion = document.getElementById("error-region");
const loginSection = document.getElementById("login-section");
const queueSection = document.getElementById("queue-section");
const detailSection = document.getElementById("detail-section");
const automationSection = document.getElementById("automation-section");
const automationPolicyRegion = document.getElementById("automation-policy-region");
const automationStatusRegion = document.getElementById("automation-status-region");
const automationErrorRegion = document.getElementById("automation-error-region");
const accountSelect = document.getElementById("account-select");
const routeList = document.getElementById("route-list");
const routeForm = document.getElementById("route-form");
const contactInput = document.getElementById("contact-input");
const loginForm = document.getElementById("login-form");
const emailInput = document.getElementById("email-input");
const passwordInput = document.getElementById("password-input");
const refreshButton = document.getElementById("refresh-button");
const logoutButton = document.getElementById("logout-button");
const notifyButton = document.getElementById("notify-button");
const notifyStatus = document.getElementById("notify-status");
const queueList = document.getElementById("queue-list");
const workItemStatusRegion = document.getElementById("workitem-status-region");
const detailContent = document.getElementById("detail-content");
const claimButton = document.getElementById("claim-button");
const resolveButton = document.getElementById("resolve-button");
const backButton = document.getElementById("back-button");
const replyComposer = document.getElementById("reply-composer");
const replyContentInput = document.getElementById("reply-content-input");
const replyCharCount = document.getElementById("reply-char-count");
const replySendButton = document.getElementById("reply-send-button");
const replyStatusRegion = document.getElementById("reply-status-region");
const replyErrorRegion = document.getElementById("reply-error-region");
const scheduleSection = document.getElementById("schedule-section");
const clinicSelect = document.getElementById("clinic-select");
const scheduleReadonlyNotice = document.getElementById("schedule-readonly-notice");
const scheduleStatusRegion = document.getElementById("schedule-status-region");
const scheduleErrorRegion = document.getElementById("schedule-error-region");
const weeklyHoursBody = document.getElementById("weekly-hours-body");
const closureForm = document.getElementById("closure-form");
const closureDateInput = document.getElementById("closure-date-input");
const closureList = document.getElementById("closure-list");
const generateForm = document.getElementById("generate-form");
const generateDateInput = document.getElementById("generate-date-input");
const slotList = document.getElementById("slot-list");
const alertPrefsSection = document.getElementById("alert-prefs-section");
const alertPrefsStatusRegion = document.getElementById("alert-prefs-status-region");
const alertPrefsErrorRegion = document.getElementById("alert-prefs-error-region");
const alertPrefsBody = document.getElementById("alert-prefs-body");
const sectionNav = document.getElementById("section-nav");
const navTabQueue = document.getElementById("nav-tab-queue");
const navTabAutomation = document.getElementById("nav-tab-automation");
const navTabSchedule = document.getElementById("nav-tab-schedule");
const navTabAlerts = document.getElementById("nav-tab-alerts");

const KIND_LABELS = { human_handoff: "\\u0130nsan devri", delivery_failure: "Teslimat hatas\\u0131" };
const REASON_LABELS = {
  emergency_handoff: "Acil durum devri",
  human_handoff: "Personel talebi",
  send_attempts_exhausted: "G\\u00f6nderim denemeleri t\\u00fckendi",
  provider_failed: "Sa\\u011flay\\u0131c\\u0131 hatas\\u0131",
};
const STATUS_LABELS = { open: "A\\u00e7\\u0131k", seen: "G\\u00f6r\\u00fcld\\u00fc", in_progress: "\\u0130\\u015fleniyor" };
const MODE_LABELS = { ai: "AI a\\u00e7\\u0131k", manual: "Sadece insan", personal: "Ki\\u015fisel / yok say" };
const WEEKDAY_LABELS = {
  1: "Pazartesi",
  2: "Sal\\u0131",
  3: "\\u00c7ar\\u015famba",
  4: "Per\\u015fembe",
  5: "Cuma",
  6: "Cumartesi",
  7: "Pazar",
};
const SLOT_STATUS_LABELS = { available: "Bo\\u015f", held: "Tutuluyor", confirmed: "Onayl\\u0131" };
const CLINIC_ROLES = ["admin", "veterinarian", "receptionist"];
const CLINIC_STATUSES = ["active", "suspended", "offboarding"];
const ISO_TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;
const REPLY_MAX_LENGTH = 4096;
const INBOUND_MESSAGE_MAX_LENGTH = 65536;
const REPLY_RPC_TIMEOUT_MS = 10000;
const REPLY_RESULTS = ["queued", "already_queued", "not_found", "not_allowed", "inactive", "window_closed"];
const REPLY_RESULT_MESSAGES = {
  not_found: "\\u0130\\u015f bulunamad\\u0131.",
  not_allowed: "Bu yan\\u0131t\\u0131 \\u015fu anda g\\u00f6nderemezsiniz.",
  inactive: "Klinik \\u015fu anda aktif de\\u011fil.",
  window_closed: "24 saatlik m\\u00fc\\u015fteri yan\\u0131t penceresi kapand\\u0131.",
};
const ALERT_PREF_RESULTS = ["forbidden", "already_disabled", "email_unconfirmed", "already_enabled", "enabled", "disabled"];

let config = null;
let currentUserId = null;
let currentWorkItemId = null;
let currentWorkItemKind = null;
let currentWorkItemReason = null;
let queueLoadInFlight = false;
let knownWorkItemIds = null;
let pollIntervalId = null;
let selectedAccountId = null;
let routeSubmitInFlight = false;
let clinics = [];
let selectedClinicId = null;
let scheduleMutationInFlight = false;
let alertPrefsMutationInFlight = false;
let composerEligible = false;
let currentReplyRequestId = null;
let lastReplyRequestContent = null;
let replySubmitInFlight = false;

function isExactRecord(value, keys) {
  try {
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype &&
      Reflect.ownKeys(value).length === keys.length &&
      keys.every((key) => Object.prototype.propertyIsEnumerable.call(value, key))
    );
  } catch {
    return false;
  }
}

function showError(message) {
  errorRegion.textContent = message;
}

function showStatus(message) {
  statusRegion.textContent = message;
}

function clearMessages() {
  errorRegion.textContent = "";
  statusRegion.textContent = "";
}

const DESTINATIONS = [
  ["queue", queueSection, navTabQueue],
  ["automation", automationSection, navTabAutomation],
  ["schedule", scheduleSection, navTabSchedule],
  ["alerts", alertPrefsSection, navTabAlerts],
];

let activeDestination = "queue";
let queueSubview = "list";

function renderActiveDestination() {
  for (const [key, section, tab] of DESTINATIONS) {
    section.hidden = key !== activeDestination;
    tab.setAttribute("aria-current", key === activeDestination ? "true" : "false");
  }
  if (activeDestination === "queue" && queueSubview === "detail") {
    queueSection.hidden = true;
    detailSection.hidden = false;
  } else {
    detailSection.hidden = true;
  }
}

function selectDestination(destination) {
  if (!DESTINATIONS.some(([key]) => key === destination)) {
    return;
  }
  activeDestination = destination;
  renderActiveDestination();
}

navTabQueue.addEventListener("click", () => selectDestination("queue"));
navTabAutomation.addEventListener("click", () => selectDestination("automation"));
navTabSchedule.addEventListener("click", () => selectDestination("schedule"));
navTabAlerts.addEventListener("click", () => selectDestination("alerts"));

function showLoginView() {
  loginSection.hidden = false;
  sectionNav.hidden = true;
  queueSection.hidden = true;
  detailSection.hidden = true;
  automationSection.hidden = true;
  scheduleSection.hidden = true;
  alertPrefsSection.hidden = true;
}

function showQueueView() {
  loginSection.hidden = true;
  sectionNav.hidden = false;
  activeDestination = "queue";
  queueSubview = "list";
  renderActiveDestination();
}

function showDetailView() {
  loginSection.hidden = true;
  sectionNav.hidden = false;
  activeDestination = "queue";
  queueSubview = "detail";
  renderActiveDestination();
}

function stopPolling() {
  if (pollIntervalId !== null) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
  knownWorkItemIds = null;
}

function startPolling() {
  if (pollIntervalId !== null) {
    return;
  }
  pollIntervalId = setInterval(pollQueue, POLL_INTERVAL_MS);
}

function clearSession() {
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
  currentUserId = null;
  currentWorkItemId = null;
  currentWorkItemKind = null;
  currentWorkItemReason = null;
  selectedAccountId = null;
  accountSelect.textContent = "";
  routeList.textContent = "";
  automationPolicyRegion.hidden = true;
  automationStatusRegion.textContent = "";
  automationErrorRegion.textContent = "";
  clinics = [];
  selectedClinicId = null;
  clinicSelect.textContent = "";
  weeklyHoursBody.textContent = "";
  closureList.textContent = "";
  slotList.textContent = "";
  scheduleReadonlyNotice.hidden = true;
  scheduleStatusRegion.textContent = "";
  scheduleErrorRegion.textContent = "";
  alertPrefsBody.textContent = "";
  alertPrefsStatusRegion.textContent = "";
  alertPrefsErrorRegion.textContent = "";
  composerEligible = false;
  replyComposer.hidden = true;
  replyStatusRegion.textContent = "";
  replyErrorRegion.textContent = "";
  resetReplyDraftState();
  stopPolling();
  clearMessages();
  showLoginView();
}

function ownershipLabel(assignedTo) {
  if (!assignedTo) {
    return "Sahipsiz";
  }
  return assignedTo === currentUserId ? "Sizde" : "Ba\\u015fka personelde";
}

function updateNotifyStatus() {
  if (typeof Notification === "undefined") {
    notifyStatus.textContent = "Bu taray\\u0131c\\u0131da bildirim desteklenmiyor.";
    notifyButton.disabled = true;
    return;
  }
  if (Notification.permission === "granted") {
    notifyStatus.textContent = "Bildirimler a\\u00e7\\u0131k.";
  } else if (Notification.permission === "denied") {
    notifyStatus.textContent = "Bildirim izni reddedildi.";
  } else {
    notifyStatus.textContent = "Bildirim izni verilmedi.";
  }
}

function requestNotificationIfNeeded(newItems) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || newItems.length === 0) {
    return;
  }
  const hasUrgent = newItems.some((item) => item.priority === "urgent");
  try {
    new Notification("Pati Hatt\\u0131 personel kuyru\\u011fu", {
      body: hasUrgent ? "Yeni acil personel i\\u015fi var." : "Yeni personel i\\u015fi var.",
    });
  } catch {
    // A browser/OS notification failure must not block the queue refresh.
  }
}

async function loadConfig() {
  const res = await fetch("/staff/config.json");
  if (!res.ok) {
    throw new Error("config unavailable");
  }
  const data = await res.json();
  if (typeof data.supabaseUrl !== "string" || typeof data.supabaseAnonKey !== "string") {
    throw new Error("malformed config");
  }
  return data;
}

async function login(email, password) {
  const res = await fetch(config.supabaseUrl + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: config.supabaseAnonKey,
    },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error("login failed");
  }
  const data = await res.json();
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new Error("malformed login response");
  }
  sessionStorage.setItem(SESSION_STORAGE_KEY, data.access_token);
}

async function authedFetch(path, init) {
  const token = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!token) {
    clearSession();
    throw new Error("no session");
  }
  const requestInit = init || {};
  const headers = Object.assign({}, requestInit.headers, {
    apikey: config.supabaseAnonKey,
    Authorization: "Bearer " + token,
  });
  const res = await fetch(config.supabaseUrl + path, Object.assign({}, requestInit, { headers }));
  if (res.status === 401 || res.status === 403) {
    clearSession();
    throw new Error("session expired");
  }
  return res;
}

async function fetchCurrentUser() {
  const res = await authedFetch("/auth/v1/user", { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error("current user fetch failed");
  }
  const data = await res.json();
  if (typeof data.id !== "string" || !UUID_PATTERN.test(data.id)) {
    throw new Error("malformed current user response");
  }
  return data.id;
}

async function callWorkItemRpc(rpcName, workItemId, allowedResults) {
  const res = await authedFetch("/rest/v1/rpc/" + rpcName, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ p_work_item_id: workItemId }),
  });
  if (!res.ok) {
    throw new Error("rpc request failed");
  }
  const rows = await res.json();
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    typeof rows[0] !== "object" ||
    rows[0] === null ||
    Array.isArray(rows[0]) ||
    Object.keys(rows[0]).length !== 1 ||
    typeof rows[0].result !== "string" ||
    allowedResults.indexOf(rows[0].result) === -1
  ) {
    throw new Error("malformed rpc response");
  }
  return rows[0].result;
}

async function fetchWorkItemState(workItemId) {
  const res = await authedFetch(
    "/rest/v1/staff_work_items?id=eq." + encodeURIComponent(workItemId) + "&select=status,assigned_to,kind,reason",
    { headers: { Accept: "application/json" } }
  );
  if (!res.ok) {
    throw new Error("work item state fetch failed");
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("work item state unavailable");
  }
  return validateWorkItemState(rows[0]);
}

function applyWorkItemState(state, preserveReplyDraft = false) {
  currentWorkItemKind = state.kind;
  currentWorkItemReason = state.reason;
  const statusLabel = STATUS_LABELS[state.status] || state.status;
  workItemStatusRegion.textContent = statusLabel + " \\u2014 " + ownershipLabel(state.assigned_to);
  const claimable =
    state.status === "open" ||
    state.status === "seen" ||
    (state.status === "in_progress" && (state.assigned_to === null || state.assigned_to === currentUserId));
  claimButton.disabled = !claimable;
  resolveButton.disabled = !(state.status === "in_progress" && state.assigned_to === currentUserId);
  composerEligible =
    state.kind === "human_handoff" && state.status === "in_progress" && state.assigned_to === currentUserId;
  replyComposer.hidden = !composerEligible;
  if (!composerEligible && !preserveReplyDraft) {
    resetReplyDraftState();
  } else {
    updateReplySendButtonState();
  }
}

function validateWorkItemState(value) {
  if (
    !isExactRecord(value, ["status", "assigned_to", "kind", "reason"]) ||
    ["open", "seen", "in_progress", "resolved"].indexOf(value.status) === -1 ||
    ["human_handoff", "delivery_failure"].indexOf(value.kind) === -1 ||
    ["human_handoff", "emergency_handoff", "send_attempts_exhausted", "provider_failed"].indexOf(value.reason) === -1 ||
    (value.kind === "human_handoff" && value.reason !== "human_handoff" && value.reason !== "emergency_handoff") ||
    (value.kind === "delivery_failure" &&
      value.reason !== "send_attempts_exhausted" &&
      value.reason !== "provider_failed") ||
    (value.assigned_to !== null &&
      (typeof value.assigned_to !== "string" || !UUID_PATTERN.test(value.assigned_to)))
  ) {
    throw new Error("malformed work item state");
  }
  return value;
}

function replyCodePointLength(value) {
  return Array.from(value).length;
}

function isValidMessageHistoryItem(message) {
  if (
    !isExactRecord(message, ["direction", "content", "created_at", "outbound_origin"]) ||
    ["inbound", "outbound", "system"].indexOf(message.direction) === -1 ||
    typeof message.content !== "string" ||
    replyCodePointLength(message.content) < 1 ||
    replyCodePointLength(message.content) >
      (message.direction === "inbound" ? INBOUND_MESSAGE_MAX_LENGTH : REPLY_MAX_LENGTH) ||
    typeof message.created_at !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(message.created_at) ||
    !Number.isFinite(Date.parse(message.created_at))
  ) {
    return false;
  }
  return (
    (message.direction === "outbound" &&
      (message.outbound_origin === "automation" || message.outbound_origin === "staff")) ||
    (message.direction !== "outbound" && message.outbound_origin === null)
  );
}

function validateReplyResult(value) {
  if (
    !isExactRecord(value, ["result", "outbox_id", "window_expires_at"]) ||
    typeof value.result !== "string" ||
    REPLY_RESULTS.indexOf(value.result) === -1
  ) {
    throw new Error("malformed reply rpc response");
  }

  const successful = value.result === "queued" || value.result === "already_queued";
  const validQueueId =
    typeof value.outbox_id === "string" &&
    UUID_PATTERN.test(value.outbox_id) &&
    value.outbox_id === value.outbox_id.toLowerCase();
  const validWindow =
    typeof value.window_expires_at === "string" &&
    ISO_TIMESTAMP_PATTERN.test(value.window_expires_at) &&
    Number.isFinite(Date.parse(value.window_expires_at));

  if (
    (successful && (!validQueueId || !validWindow)) ||
    (!successful && (value.outbox_id !== null || value.window_expires_at !== null))
  ) {
    throw new Error("incoherent reply rpc response");
  }
  return value;
}

function newReplyRequestId() {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    return null;
  }
  const requestId = crypto.randomUUID();
  return typeof requestId === "string" && UUID_PATTERN.test(requestId) && requestId === requestId.toLowerCase()
    ? requestId
    : null;
}

function resolveReplyRequestId(content) {
  if (currentReplyRequestId !== null && lastReplyRequestContent === content) {
    return currentReplyRequestId;
  }
  const requestId = newReplyRequestId();
  if (requestId === null) {
    return null;
  }
  currentReplyRequestId = requestId;
  lastReplyRequestContent = content;
  return requestId;
}

function resetReplyDraftState() {
  currentReplyRequestId = null;
  lastReplyRequestContent = null;
  replyContentInput.value = "";
  updateReplySendButtonState();
}

function updateReplySendButtonState() {
  const length = replyCodePointLength(replyContentInput.value);
  replyCharCount.textContent = length + " / " + REPLY_MAX_LENGTH;
  const trimmedNonEmpty = replyContentInput.value.trim().length > 0;
  replySendButton.disabled =
    !composerEligible || replySubmitInFlight || !trimmedNonEmpty || length > REPLY_MAX_LENGTH;
}

replyContentInput.addEventListener("input", updateReplySendButtonState);

async function queueStaffReply(workItemId, requestId, content) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REPLY_RPC_TIMEOUT_MS);
  try {
    const res = await authedFetch("/rest/v1/rpc/queue_staff_reply_v1", {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ p_work_item_id: workItemId, p_request_id: requestId, p_content: content }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error("reply rpc failed");
    }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new Error("malformed reply rpc response");
    }
    return validateReplyResult(rows[0]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function refreshWorkItemState(preserveReplyDraft = false) {
  if (!currentWorkItemId) {
    return;
  }
  try {
    applyWorkItemState(await fetchWorkItemState(currentWorkItemId), preserveReplyDraft);
  } catch {
    showError("\\u0130\\u015f durumu g\\u00fcncellenemedi.");
  }
}

async function fetchQueueItems() {
  const columns =
    "id,kind,priority,reason,status,created_at,conversation_id,first_seen_at,assigned_at,assigned_to";
  const query =
    "select=" + columns + "&status=neq.resolved&order=priority.desc,created_at.asc,id.asc&limit=100";
  const res = await authedFetch("/rest/v1/staff_work_items?" + query, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error("list fetch failed");
  }
  const rows = await res.json();
  if (!Array.isArray(rows)) {
    throw new Error("malformed list response");
  }
  return rows;
}

function computeNewItems(items) {
  const currentIds = new Set();
  for (const item of items) {
    currentIds.add(item.id);
  }
  const newItems = knownWorkItemIds === null ? [] : items.filter((item) => !knownWorkItemIds.has(item.id));
  knownWorkItemIds = currentIds;
  return newItems;
}

function renderQueue(items) {
  queueList.textContent = "";
  for (const item of items) {
    const li = document.createElement("li");

    const label = document.createElement("span");
    const urgentPrefix = item.priority === "urgent" ? "[ACIL] " : "";
    const kindLabel = KIND_LABELS[item.kind] || item.kind;
    const reasonLabel = REASON_LABELS[item.reason] || item.reason;
    const statusLabel = STATUS_LABELS[item.status] || item.status;
    const created = new Date(item.created_at).toLocaleString("tr-TR");
    label.textContent =
      urgentPrefix +
      kindLabel +
      " \\u2014 " +
      reasonLabel +
      " \\u2014 " +
      statusLabel +
      " \\u2014 " +
      ownershipLabel(item.assigned_to) +
      " \\u2014 " +
      created;
    li.appendChild(label);

    const detailButton = document.createElement("button");
    detailButton.type = "button";
    detailButton.textContent = "Detay";
    detailButton.addEventListener("click", () => {
      openDetail(item.id, item.conversation_id);
    });
    li.appendChild(detailButton);

    queueList.appendChild(li);
  }
}

async function loadQueue(showLoadingStatus) {
  if (queueLoadInFlight) {
    return;
  }
  queueLoadInFlight = true;
  if (showLoadingStatus) {
    showStatus("Y\\u00fckleniyor...");
    errorRegion.textContent = "";
  }
  try {
    const items = await fetchQueueItems();
    const newItems = computeNewItems(items);
    requestNotificationIfNeeded(newItems);
    if (!queueSection.hidden) {
      renderQueue(items);
    }
    showStatus(items.length + " a\\u00e7\\u0131k i\\u015f");
  } catch {
    if (showLoadingStatus) {
      showError("Liste y\\u00fcklenemedi.");
    }
  } finally {
    queueLoadInFlight = false;
  }
}

async function refreshQueue() {
  await loadQueue(true);
}

async function pollQueue() {
  await loadQueue(false);
}

function messageLabel(message) {
  if (message.direction === "inbound") {
    return "M\\u00fc\\u015fteri";
  }
  if (message.direction === "system") {
    return "Sistem";
  }
  return message.outbound_origin === "staff" ? "Personel" : "Otomatik";
}

function renderDetail(owner, pet, conversation, messages) {
  detailContent.textContent = "";

  const ownerP = document.createElement("p");
  ownerP.textContent = "Sahip: " + owner.full_name + " (" + owner.phone_e164 + ")";
  detailContent.appendChild(ownerP);

  const petP = document.createElement("p");
  petP.textContent = pet
    ? "Hayvan: " + pet.name + (pet.species ? " (" + pet.species + ")" : "")
    : "Hayvan: kay\\u0131tl\\u0131 de\\u011fil";
  detailContent.appendChild(petP);

  const statusP = document.createElement("p");
  statusP.textContent = "Durum: " + conversation.status + " / " + conversation.intake_stage;
  detailContent.appendChild(statusP);

  const list = document.createElement("ul");
  for (const message of messages) {
    const li = document.createElement("li");
    const when = new Date(message.created_at).toLocaleString("tr-TR");
    li.textContent = "[" + messageLabel(message) + "] " + when + ": " + message.content;
    list.appendChild(li);
  }
  detailContent.appendChild(list);
}

async function openDetail(workItemId, conversationId) {
  currentWorkItemId = workItemId;
  currentWorkItemKind = null;
  currentWorkItemReason = null;
  resetReplyDraftState();
  replyStatusRegion.textContent = "";
  replyErrorRegion.textContent = "";
  errorRegion.textContent = "";
  try {
    const seenResult = await callWorkItemRpc("mark_staff_work_item_seen", workItemId, [
      "seen",
      "already_seen",
      "already_resolved",
      "not_found",
    ]);
    if (currentWorkItemId !== workItemId) {
      return;
    }
    if (seenResult === "already_resolved" || seenResult === "not_found") {
      currentWorkItemId = null;
      showError(
        seenResult === "not_found"
          ? "\\u0130\\u015f bulunamad\\u0131."
          : "\\u0130\\u015f zaten \\u00e7\\u00f6z\\u00fcld\\u00fc olarak i\\u015faretlenmi\\u015f."
      );
      showQueueView();
      await refreshQueue();
      return;
    }

    const workItemState = await fetchWorkItemState(workItemId);
    if (currentWorkItemId !== workItemId) {
      return;
    }
    applyWorkItemState(workItemState);

    const convRes = await authedFetch(
      "/rest/v1/conversations?id=eq." + encodeURIComponent(conversationId) + "&select=owner_id,pet_id,status,intake_stage",
      { headers: { Accept: "application/json" } }
    );
    if (!convRes.ok) {
      throw new Error("conversation fetch failed");
    }
    const convRows = await convRes.json();
    if (!Array.isArray(convRows) || convRows.length !== 1) {
      throw new Error("conversation unavailable");
    }
    const conversation = convRows[0];

    const ownerRes = await authedFetch(
      "/rest/v1/owners?id=eq." + encodeURIComponent(conversation.owner_id) + "&select=full_name,phone_e164",
      { headers: { Accept: "application/json" } }
    );
    if (!ownerRes.ok) {
      throw new Error("owner fetch failed");
    }
    const ownerRows = await ownerRes.json();
    if (!Array.isArray(ownerRows) || ownerRows.length !== 1) {
      throw new Error("owner unavailable");
    }
    const owner = ownerRows[0];

    let pet = null;
    if (conversation.pet_id) {
      const petRes = await authedFetch(
        "/rest/v1/pets?id=eq." + encodeURIComponent(conversation.pet_id) + "&select=name,species",
        { headers: { Accept: "application/json" } }
      );
      if (!petRes.ok) {
        throw new Error("pet fetch failed");
      }
      const petRows = await petRes.json();
      if (!Array.isArray(petRows) || petRows.length !== 1) {
        throw new Error("pet unavailable");
      }
      pet = petRows[0];
    }

    const messagesRes = await authedFetch(
      "/rest/v1/messages?conversation_id=eq." +
        encodeURIComponent(conversationId) +
        "&select=direction,content,created_at,outbound_origin&order=created_at.desc&limit=20",
      { headers: { Accept: "application/json" } }
    );
    if (!messagesRes.ok) {
      throw new Error("messages fetch failed");
    }
    const messageRows = await messagesRes.json();
    if (
      !Array.isArray(messageRows) ||
      messageRows.length > 20 ||
      !messageRows.every(isValidMessageHistoryItem)
    ) {
      throw new Error("malformed messages response");
    }
    const chronological = messageRows.slice().reverse();

    if (currentWorkItemId !== workItemId) {
      return;
    }
    renderDetail(owner, pet, conversation, chronological);
    showDetailView();
  } catch {
    if (currentWorkItemId === workItemId) {
      showError("Detay y\\u00fcklenemedi.");
    }
  }
}

async function fetchAutomationAccounts() {
  const res = await authedFetch("/rest/v1/whatsapp_accounts?select=id,display_name,automation_default&order=display_name.asc&limit=100", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error("account list fetch failed");
  }
  const rows = await res.json();
  if (
    !Array.isArray(rows) ||
    rows.length > 100 ||
    !rows.every(
      (row) =>
        isExactRecord(row, ["id", "display_name", "automation_default"]) &&
        typeof row.id === "string" &&
        UUID_PATTERN.test(row.id) &&
        (row.display_name === null ||
          (typeof row.display_name === "string" &&
            row.display_name.trim() === row.display_name &&
            row.display_name.length >= 1 &&
            row.display_name.length <= 200)) &&
        row.automation_default === "personal"
    )
  ) {
    throw new Error("malformed account list response");
  }
  return rows;
}

function renderAccounts(accounts) {
  accountSelect.textContent = "";
  for (const account of accounts) {
    const option = document.createElement("option");
    option.value = account.id;
    option.textContent = (account.display_name || "WhatsApp hesab\\u0131") + " (Strict whitelist)";
    accountSelect.appendChild(option);
  }
}

async function fetchContactRoutes(accountId) {
  const res = await authedFetch(
    "/rest/v1/whatsapp_contact_routes?whatsapp_account_id=eq." +
      encodeURIComponent(accountId) +
      "&select=contact_e164,mode,updated_at&order=updated_at.desc&limit=100",
    { headers: { Accept: "application/json" } }
  );
  if (!res.ok) {
    throw new Error("route list fetch failed");
  }
  const rows = await res.json();
  if (
    !Array.isArray(rows) ||
    rows.length > 100 ||
    !rows.every(
      (row) =>
        isExactRecord(row, ["contact_e164", "mode", "updated_at"]) &&
        typeof row.contact_e164 === "string" &&
        CONTACT_E164_PATTERN.test(row.contact_e164) &&
        (row.mode === "ai" || row.mode === "manual" || row.mode === "personal") &&
        typeof row.updated_at === "string" &&
        Number.isFinite(Date.parse(row.updated_at))
    )
  ) {
    throw new Error("malformed route list response");
  }
  return rows;
}

function renderRoutes(routes) {
  routeList.textContent = "";
  for (const route of routes) {
    const li = document.createElement("li");
    const updated = new Date(route.updated_at).toLocaleString("tr-TR");
    li.textContent = route.contact_e164 + " \\u2014 " + MODE_LABELS[route.mode] + " \\u2014 " + updated;
    routeList.appendChild(li);
  }
}

async function loadAutomationRoutes() {
  if (!selectedAccountId) {
    routeList.textContent = "";
    return;
  }
  try {
    renderRoutes(await fetchContactRoutes(selectedAccountId));
  } catch {
    automationErrorRegion.textContent = "Numara listesi y\\u00fcklenemedi.";
  }
}

async function loadAutomationAccounts() {
  automationPolicyRegion.hidden = true;
  selectedAccountId = null;
  try {
    const accounts = await fetchAutomationAccounts();
    renderAccounts(accounts);
    automationPolicyRegion.hidden = false;
    selectedAccountId = accounts.length > 0 ? accounts[0].id : null;
    if (selectedAccountId) {
      accountSelect.value = selectedAccountId;
    }
    await loadAutomationRoutes();
  } catch {
    accountSelect.textContent = "";
    routeList.textContent = "";
    automationErrorRegion.textContent = "Strict whitelist do\\u011frulanamad\\u0131; numara ayarlar\\u0131 kapal\\u0131.";
  }
}

async function submitContactRoute(accountId, contactE164, mode) {
  const res = await authedFetch("/rest/v1/rpc/set_whatsapp_contact_route", {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ p_whatsapp_account_id: accountId, p_contact_e164: contactE164, p_mode: mode }),
  });
  if (!res.ok) {
    throw new Error("route rpc failed");
  }
  const rows = await res.json();
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    typeof rows[0] !== "object" ||
    rows[0] === null ||
    Array.isArray(rows[0]) ||
    !isExactRecord(rows[0], ["result"]) ||
    typeof rows[0].result !== "string" ||
    ["updated", "unchanged", "not_found"].indexOf(rows[0].result) === -1
  ) {
    throw new Error("malformed route rpc response");
  }
  return rows[0].result;
}

function istanbulTodayIso() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Istanbul" });
}

function addDaysIso(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isHalfHourAligned(timeValue) {
  return /^([01]\\d|2[0-3]):(00|30)$/.test(timeValue);
}

function isValidIsoDate(value) {
  if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function canMutateSelectedClinic() {
  const clinic = clinics.find((item) => item.clinicId === selectedClinicId);
  return !!clinic && clinic.role === "admin" && clinic.operationalStatus === "active";
}

function syncScheduleMutationControls() {
  const disabled = scheduleMutationInFlight || !canMutateSelectedClinic();
  clinicSelect.disabled = scheduleMutationInFlight;
  for (const control of scheduleSection.querySelectorAll("[data-schedule-mutation-control]")) {
    control.disabled = disabled;
  }
}

function setScheduleMutationInFlight(value) {
  scheduleMutationInFlight = value;
  syncScheduleMutationControls();
}

function scheduleAuthMessage(result) {
  if (result === "not_found") {
    return "Klinik bulunamad\\u0131.";
  }
  if (result === "forbidden") {
    return "Bu klinik i\\u00e7in yetkiniz yok.";
  }
  if (result === "inactive") {
    return "Klinik aktif de\\u011fil; de\\u011fi\\u015fiklik yap\\u0131lamaz.";
  }
  return null;
}

async function callScheduleMutationRpc(rpcName, body, expectedKeys, allowedResults) {
  const res = await authedFetch("/rest/v1/rpc/" + rpcName, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error("schedule rpc failed");
  }
  const rows = await res.json();
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    typeof rows[0] !== "object" ||
    rows[0] === null ||
    Array.isArray(rows[0]) ||
    !isExactRecord(rows[0], expectedKeys) ||
    typeof rows[0].result !== "string" ||
    allowedResults.indexOf(rows[0].result) === -1
  ) {
    throw new Error("malformed schedule rpc response");
  }
  const row = rows[0];
  const isClosedAuthResult = row.result === "not_found" || row.result === "forbidden" || row.result === "inactive";
  if (expectedKeys.includes("removed_slots")) {
    const countsAreNull = row.removed_slots === null && row.preserved_active_slots === null;
    const countsAreValid =
      Number.isInteger(row.removed_slots) &&
      row.removed_slots >= 0 &&
      Number.isInteger(row.preserved_active_slots) &&
      row.preserved_active_slots >= 0;
    if ((isClosedAuthResult && !countsAreNull) || (!isClosedAuthResult && !countsAreValid)) {
      throw new Error("malformed schedule rpc counts");
    }
  }
  if (expectedKeys.includes("candidate_count")) {
    const countsAreNull = row.candidate_count === null && row.created_count === null && row.existing_count === null;
    const countsAreValid =
      Number.isInteger(row.candidate_count) &&
      row.candidate_count >= 0 &&
      row.candidate_count <= 48 &&
      Number.isInteger(row.created_count) &&
      row.created_count >= 0 &&
      Number.isInteger(row.existing_count) &&
      row.existing_count >= 0 &&
      row.created_count + row.existing_count === row.candidate_count;
    const hasCounts = row.result === "generated" || row.result === "unchanged";
    if ((hasCounts && !countsAreValid) || (!hasCounts && !countsAreNull)) {
      throw new Error("malformed schedule rpc counts");
    }
    if ((row.result === "generated") !== (row.created_count > 0)) {
      throw new Error("incoherent schedule rpc result");
    }
  }
  return row;
}

function reportPreservedActiveSlots(preservedActiveSlots) {
  if (preservedActiveSlots) {
    scheduleStatusRegion.textContent +=
      " " +
      preservedActiveSlots +
      " onayl\\u0131/tutulan randevu bu de\\u011fi\\u015fiklikten etkilenmedi; iptal edilmedi ve sahibine bildirim g\\u00f6nderilmedi.";
  }
}

function reportRemovedAvailableSlots(removedSlots) {
  if (removedSlots) {
    scheduleStatusRegion.textContent +=
      " " + removedSlots + " bo\\u015f randevu saati kald\\u0131r\\u0131ld\\u0131.";
  }
}

async function fetchClinicMemberships() {
  const res = await authedFetch(
    "/rest/v1/clinic_staff?user_id=eq." +
      encodeURIComponent(currentUserId) +
      "&select=clinic_id,role,clinics(name,operational_status)&order=clinic_id.asc&limit=50",
    { headers: { Accept: "application/json" } }
  );
  if (!res.ok) {
    throw new Error("clinic list fetch failed");
  }
  const rows = await res.json();
  const seen = new Set();
  if (
    !Array.isArray(rows) ||
    rows.length > 50 ||
    !rows.every((row) => {
      if (
        !isExactRecord(row, ["clinic_id", "role", "clinics"]) ||
        typeof row.clinic_id !== "string" ||
        !UUID_PATTERN.test(row.clinic_id) ||
        CLINIC_ROLES.indexOf(row.role) === -1 ||
        !isExactRecord(row.clinics, ["name", "operational_status"]) ||
        typeof row.clinics.name !== "string" ||
        row.clinics.name.length < 1 ||
        row.clinics.name.length > 200 ||
        CLINIC_STATUSES.indexOf(row.clinics.operational_status) === -1
      ) {
        return false;
      }
      if (seen.has(row.clinic_id)) {
        return false;
      }
      seen.add(row.clinic_id);
      return true;
    })
  ) {
    throw new Error("malformed clinic list response");
  }
  return rows.map((row) => ({
    clinicId: row.clinic_id,
    role: row.role,
    name: row.clinics.name,
    operationalStatus: row.clinics.operational_status,
  }));
}

function renderClinicSelect(items) {
  clinicSelect.textContent = "";
  for (const clinic of items) {
    const option = document.createElement("option");
    option.value = clinic.clinicId;
    option.textContent = clinic.name;
    clinicSelect.appendChild(option);
  }
}

async function fetchWeeklyHours(clinicId) {
  const res = await authedFetch(
    "/rest/v1/clinic_weekly_hours?clinic_id=eq." +
      encodeURIComponent(clinicId) +
      "&select=iso_weekday,opens_at,closes_at&order=iso_weekday.asc&limit=7",
    { headers: { Accept: "application/json" } }
  );
  if (!res.ok) {
    throw new Error("weekly hours fetch failed");
  }
  const rows = await res.json();
  const seen = new Set();
  if (
    !Array.isArray(rows) ||
    rows.length > 7 ||
    !rows.every((row) => {
      if (!isExactRecord(row, ["iso_weekday", "opens_at", "closes_at"])) {
        return false;
      }
      const valid =
        Number.isInteger(row.iso_weekday) &&
        row.iso_weekday >= 1 &&
        row.iso_weekday <= 7 &&
        typeof row.opens_at === "string" &&
        /^([01]\\d|2[0-3]):(00|30):00$/.test(row.opens_at) &&
        typeof row.closes_at === "string" &&
        /^([01]\\d|2[0-3]):(00|30):00$/.test(row.closes_at) &&
        row.opens_at < row.closes_at &&
        !seen.has(row.iso_weekday);
      seen.add(row.iso_weekday);
      return valid;
    })
  ) {
    throw new Error("malformed weekly hours response");
  }
  return rows;
}

function renderWeeklyHours(rows, canMutate) {
  weeklyHoursBody.textContent = "";
  const byWeekday = new Map();
  for (const row of rows) {
    byWeekday.set(row.iso_weekday, row);
  }
  for (let weekday = 1; weekday <= 7; weekday++) {
    const row = byWeekday.get(weekday);
    const tr = document.createElement("tr");

    const dayTd = document.createElement("td");
    dayTd.textContent = WEEKDAY_LABELS[weekday];
    tr.appendChild(dayTd);

    const enabledTd = document.createElement("td");
    const enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = !!row;
    enabledInput.disabled = !canMutate || scheduleMutationInFlight;
    enabledInput.dataset.scheduleMutationControl = "";
    enabledTd.appendChild(enabledInput);
    tr.appendChild(enabledTd);

    const opensTd = document.createElement("td");
    const opensInput = document.createElement("input");
    opensInput.type = "time";
    opensInput.step = "1800";
    opensInput.value = row ? row.opens_at.slice(0, 5) : "";
    opensInput.disabled = !canMutate || scheduleMutationInFlight;
    opensInput.dataset.scheduleMutationControl = "";
    opensTd.appendChild(opensInput);
    tr.appendChild(opensTd);

    const closesTd = document.createElement("td");
    const closesInput = document.createElement("input");
    closesInput.type = "time";
    closesInput.step = "1800";
    closesInput.value = row ? row.closes_at.slice(0, 5) : "";
    closesInput.disabled = !canMutate || scheduleMutationInFlight;
    closesInput.dataset.scheduleMutationControl = "";
    closesTd.appendChild(closesInput);
    tr.appendChild(closesTd);

    const actionTd = document.createElement("td");
    if (canMutate) {
      const saveButton = document.createElement("button");
      saveButton.type = "button";
      saveButton.textContent = "Kaydet";
      saveButton.disabled = scheduleMutationInFlight;
      saveButton.dataset.scheduleMutationControl = "";
      saveButton.addEventListener("click", () => {
        submitWeeklyHours(weekday, enabledInput.checked, opensInput.value, closesInput.value);
      });
      actionTd.appendChild(saveButton);
    }
    tr.appendChild(actionTd);

    weeklyHoursBody.appendChild(tr);
  }
}

async function submitWeeklyHours(isoWeekday, enabled, opensValue, closesValue) {
  scheduleErrorRegion.textContent = "";
  scheduleStatusRegion.textContent = "";
  if (scheduleMutationInFlight) {
    return;
  }
  let opensAt = null;
  let closesAt = null;
  if (enabled) {
    if (!isHalfHourAligned(opensValue) || !isHalfHourAligned(closesValue)) {
      scheduleErrorRegion.textContent = "Saatler yar\\u0131m saate hizal\\u0131 olmal\\u0131 (\\u00f6r. 09:00, 09:30).";
      return;
    }
    if (opensValue >= closesValue) {
      scheduleErrorRegion.textContent = "A\\u00e7\\u0131l\\u0131\\u015f kapan\\u0131\\u015ftan \\u00f6nce olmal\\u0131.";
      return;
    }
    opensAt = opensValue;
    closesAt = closesValue;
  }
  setScheduleMutationInFlight(true);
  try {
    const row = await callScheduleMutationRpc(
      "set_clinic_weekly_hours_v1",
      {
        p_clinic_id: selectedClinicId,
        p_iso_weekday: isoWeekday,
        p_enabled: enabled,
        p_opens_at: opensAt,
        p_closes_at: closesAt,
      },
      ["result", "removed_slots", "preserved_active_slots"],
      ["updated", "removed", "unchanged", "not_found", "forbidden", "inactive"]
    );
    const authMsg = scheduleAuthMessage(row.result);
    if (authMsg) {
      scheduleErrorRegion.textContent = authMsg;
    } else {
      scheduleStatusRegion.textContent = row.result === "unchanged" ? "Saat ayar\\u0131 de\\u011fi\\u015fmedi." : "Saatler kaydedildi.";
      reportRemovedAvailableSlots(row.removed_slots);
      reportPreservedActiveSlots(row.preserved_active_slots);
    }
    await loadScheduleForSelectedClinic();
  } catch {
    scheduleErrorRegion.textContent = "Saatler kaydedilemedi.";
  } finally {
    setScheduleMutationInFlight(false);
  }
}

async function fetchClosureDates(clinicId) {
  const res = await authedFetch(
    "/rest/v1/clinic_closure_dates?clinic_id=eq." +
      encodeURIComponent(clinicId) +
      "&select=closed_on&order=closed_on.asc&limit=200",
    { headers: { Accept: "application/json" } }
  );
  if (!res.ok) {
    throw new Error("closure list fetch failed");
  }
  const rows = await res.json();
  const seen = new Set();
  if (
    !Array.isArray(rows) ||
    rows.length > 200 ||
    !rows.every((row) => {
      if (!isExactRecord(row, ["closed_on"])) {
        return false;
      }
      const valid = isValidIsoDate(row.closed_on) && !seen.has(row.closed_on);
      seen.add(row.closed_on);
      return valid;
    })
  ) {
    throw new Error("malformed closure list response");
  }
  return rows;
}

function renderClosures(rows, canMutate) {
  closureList.textContent = "";
  for (const row of rows) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = row.closed_on;
    li.appendChild(span);
    if (canMutate) {
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.textContent = "Kald\\u0131r";
      removeButton.disabled = scheduleMutationInFlight;
      removeButton.dataset.scheduleMutationControl = "";
      removeButton.addEventListener("click", () => {
        submitClosureDate(row.closed_on, false);
      });
      li.appendChild(removeButton);
    }
    closureList.appendChild(li);
  }
}

async function submitClosureDate(closedOn, closed) {
  scheduleErrorRegion.textContent = "";
  scheduleStatusRegion.textContent = "";
  if (scheduleMutationInFlight) {
    return;
  }
  const today = istanbulTodayIso();
  if (!isValidIsoDate(closedOn) || closedOn < today || closedOn > addDaysIso(today, 366)) {
    scheduleErrorRegion.textContent = "Ge\\u00e7ersiz tarih.";
    return;
  }
  setScheduleMutationInFlight(true);
  try {
    const row = await callScheduleMutationRpc(
      "set_clinic_closure_date_v1",
      { p_clinic_id: selectedClinicId, p_closed_on: closedOn, p_closed: closed },
      ["result", "removed_slots", "preserved_active_slots"],
      ["updated", "removed", "unchanged", "not_found", "forbidden", "inactive"]
    );
    const authMsg = scheduleAuthMessage(row.result);
    if (authMsg) {
      scheduleErrorRegion.textContent = authMsg;
    } else if (closed) {
      scheduleStatusRegion.textContent = row.result === "unchanged" ? "Kapan\\u0131\\u015f kayd\\u0131 zaten vard\\u0131." : "Kapan\\u0131\\u015f eklendi.";
      reportRemovedAvailableSlots(row.removed_slots);
      reportPreservedActiveSlots(row.preserved_active_slots);
    } else {
      scheduleStatusRegion.textContent = row.result === "unchanged" ? "De\\u011fi\\u015fiklik yoktu." : "Kapan\\u0131\\u015f kald\\u0131r\\u0131ld\\u0131.";
    }
    closureDateInput.value = "";
    await loadScheduleForSelectedClinic();
  } catch {
    scheduleErrorRegion.textContent = "Kapan\\u0131\\u015f g\\u00fcncellenemedi.";
  } finally {
    setScheduleMutationInFlight(false);
  }
}

async function fetchClinicSlots(clinicId) {
  const from = istanbulTodayIso();
  const to = addDaysIso(from, 13);
  const res = await authedFetch("/rest/v1/rpc/list_clinic_appointment_slots_v1", {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ p_clinic_id: clinicId, p_from: from, p_to: to }),
  });
  if (!res.ok) {
    throw new Error("slot list fetch failed");
  }
  const rows = await res.json();
  const seen = new Set();
  if (
    !Array.isArray(rows) ||
    rows.length > 700 ||
    !rows.every((row) => {
      if (!isExactRecord(row, ["slot_id", "starts_at", "ends_at", "status"])) {
        return false;
      }
      const startsAt =
        typeof row.starts_at === "string" && ISO_TIMESTAMP_PATTERN.test(row.starts_at) ? Date.parse(row.starts_at) : NaN;
      const endsAt =
        typeof row.ends_at === "string" && ISO_TIMESTAMP_PATTERN.test(row.ends_at) ? Date.parse(row.ends_at) : NaN;
      const valid =
        typeof row.slot_id === "string" &&
        UUID_PATTERN.test(row.slot_id) &&
        Number.isFinite(startsAt) &&
        Number.isFinite(endsAt) &&
        endsAt - startsAt === 30 * 60 * 1000 &&
        (row.status === "available" || row.status === "held" || row.status === "confirmed") &&
        !seen.has(row.slot_id);
      seen.add(row.slot_id);
      return valid;
    })
  ) {
    throw new Error("malformed slot list response");
  }
  return rows;
}

function renderSlots(rows, canMutate) {
  slotList.textContent = "";
  for (const row of rows) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    const start = new Date(row.starts_at).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
    const end = new Date(row.ends_at).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
    span.textContent = start + " \\u2013 " + end + " \\u2014 " + SLOT_STATUS_LABELS[row.status];
    li.appendChild(span);
    if (canMutate && row.status === "available") {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.textContent = "Sil";
      deleteButton.disabled = scheduleMutationInFlight;
      deleteButton.dataset.scheduleMutationControl = "";
      deleteButton.addEventListener("click", () => {
        submitDeleteSlot(row.slot_id);
      });
      li.appendChild(deleteButton);
    }
    slotList.appendChild(li);
  }
}

async function submitGenerateSlots(localDate) {
  scheduleErrorRegion.textContent = "";
  scheduleStatusRegion.textContent = "";
  if (scheduleMutationInFlight) {
    return;
  }
  const today = istanbulTodayIso();
  if (!isValidIsoDate(localDate) || localDate < today || localDate > addDaysIso(today, 366)) {
    scheduleErrorRegion.textContent = "Ge\\u00e7ersiz tarih.";
    return;
  }
  setScheduleMutationInFlight(true);
  try {
    const row = await callScheduleMutationRpc(
      "generate_clinic_appointment_slots_v1",
      { p_clinic_id: selectedClinicId, p_local_date: localDate },
      ["result", "candidate_count", "created_count", "existing_count"],
      ["generated", "unchanged", "closed", "unconfigured", "past", "not_found", "forbidden", "inactive"]
    );
    const authMsg = scheduleAuthMessage(row.result);
    if (authMsg) {
      scheduleErrorRegion.textContent = authMsg;
    } else if (row.result === "closed") {
      scheduleErrorRegion.textContent = "Bu tarihte klinik kapal\\u0131.";
    } else if (row.result === "unconfigured") {
      scheduleErrorRegion.textContent = "Bu g\\u00fcn i\\u00e7in saat tan\\u0131ml\\u0131 de\\u011fil.";
    } else if (row.result === "past") {
      scheduleErrorRegion.textContent = "Ge\\u00e7mi\\u015f bir tarih i\\u00e7in slot \\u00fcretilemez.";
    } else {
      scheduleStatusRegion.textContent = row.result === "unchanged" ? "De\\u011fi\\u015fiklik yoktu." : "Slotlar \\u00fcretildi.";
    }
    generateDateInput.value = "";
    await loadScheduleForSelectedClinic();
  } catch {
    scheduleErrorRegion.textContent = "Slotlar \\u00fcretilemedi.";
  } finally {
    setScheduleMutationInFlight(false);
  }
}

async function submitDeleteSlot(slotId) {
  scheduleErrorRegion.textContent = "";
  scheduleStatusRegion.textContent = "";
  if (scheduleMutationInFlight) {
    return;
  }
  setScheduleMutationInFlight(true);
  try {
    const row = await callScheduleMutationRpc(
      "delete_clinic_appointment_slot_v1",
      { p_clinic_id: selectedClinicId, p_slot_id: slotId },
      ["result"],
      ["deleted", "not_found", "in_use", "past", "forbidden", "inactive"]
    );
    const authMsg = scheduleAuthMessage(row.result);
    if (authMsg) {
      scheduleErrorRegion.textContent = authMsg;
    } else if (row.result === "in_use") {
      scheduleErrorRegion.textContent = "Bu slot tutulan veya onaylanm\\u0131\\u015f bir randevuya ait; silinemez.";
    } else if (row.result === "past") {
      scheduleErrorRegion.textContent = "Bu slot ge\\u00e7mi\\u015fte; silinemez.";
    } else if (row.result === "not_found") {
      scheduleErrorRegion.textContent = "Slot bulunamad\\u0131.";
    } else {
      scheduleStatusRegion.textContent = "Slot silindi.";
    }
    await loadScheduleForSelectedClinic();
  } catch {
    scheduleErrorRegion.textContent = "Slot silinemedi.";
  } finally {
    setScheduleMutationInFlight(false);
  }
}

async function loadScheduleForSelectedClinic() {
  weeklyHoursBody.textContent = "";
  closureList.textContent = "";
  slotList.textContent = "";
  scheduleErrorRegion.textContent = "";
  if (!selectedClinicId) {
    scheduleReadonlyNotice.hidden = true;
    closureForm.hidden = true;
    generateForm.hidden = true;
    syncScheduleMutationControls();
    return;
  }
  const requestedClinicId = selectedClinicId;
  const clinic = clinics.find((item) => item.clinicId === requestedClinicId);
  const canMutate = !!clinic && clinic.role === "admin" && clinic.operationalStatus === "active";
  scheduleReadonlyNotice.hidden = canMutate;
  scheduleReadonlyNotice.textContent =
    clinic && clinic.role === "admin"
      ? "Klinik aktif değil; takvim yalnızca okunabilir."
      : "Bu ayarları yalnızca klinik yöneticisi değiştirebilir.";
  closureForm.hidden = !canMutate;
  generateForm.hidden = !canMutate;
  syncScheduleMutationControls();
  try {
    const [hours, closures, slots] = await Promise.all([
      fetchWeeklyHours(requestedClinicId),
      fetchClosureDates(requestedClinicId),
      fetchClinicSlots(requestedClinicId),
    ]);
    if (selectedClinicId !== requestedClinicId) {
      return;
    }
    renderWeeklyHours(hours, canMutate);
    renderClosures(closures, canMutate);
    renderSlots(slots, canMutate);
    syncScheduleMutationControls();
  } catch {
    if (selectedClinicId !== requestedClinicId) {
      return;
    }
    weeklyHoursBody.textContent = "";
    closureList.textContent = "";
    slotList.textContent = "";
    scheduleErrorRegion.textContent = "Takvim y\\u00fcklenemedi.";
  }
}

async function loadClinicSchedule() {
  scheduleErrorRegion.textContent = "";
  scheduleStatusRegion.textContent = "";
  const today = istanbulTodayIso();
  const maxDate = addDaysIso(today, 366);
  closureDateInput.min = today;
  closureDateInput.max = maxDate;
  generateDateInput.min = today;
  generateDateInput.max = maxDate;
  try {
    clinics = await fetchClinicMemberships();
    renderClinicSelect(clinics);
    selectedClinicId = clinics.length > 0 ? clinics[0].clinicId : null;
    if (selectedClinicId) {
      clinicSelect.value = selectedClinicId;
    }
    await loadScheduleForSelectedClinic();
  } catch {
    clinics = [];
    selectedClinicId = null;
    clinicSelect.textContent = "";
    weeklyHoursBody.textContent = "";
    closureList.textContent = "";
    slotList.textContent = "";
    scheduleErrorRegion.textContent = "Klinik listesi y\\u00fcklenemedi.";
  }
}

async function fetchMyClinicAlertPreferences() {
  const res = await authedFetch("/rest/v1/rpc/get_my_clinic_alert_preferences", {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error("alert preferences fetch failed");
  }
  const rows = await res.json();
  if (
    !Array.isArray(rows) ||
    rows.length > 50 ||
    !rows.every(
      (row) =>
        isExactRecord(row, [
          "clinic_id",
          "clinic_name",
          "clinic_gate_enabled",
          "my_preference_enabled",
          "effective_enabled",
        ]) &&
        typeof row.clinic_id === "string" &&
        UUID_PATTERN.test(row.clinic_id) &&
        typeof row.clinic_name === "string" &&
        row.clinic_name.length >= 1 &&
        row.clinic_name.length <= 200 &&
        typeof row.clinic_gate_enabled === "boolean" &&
        typeof row.my_preference_enabled === "boolean" &&
        typeof row.effective_enabled === "boolean" &&
        row.effective_enabled === (row.clinic_gate_enabled && row.my_preference_enabled)
    )
  ) {
    throw new Error("malformed alert preferences response");
  }
  const seenClinicIds = new Set();
  for (const row of rows) {
    if (seenClinicIds.has(row.clinic_id)) {
      throw new Error("duplicate alert preference clinic");
    }
    seenClinicIds.add(row.clinic_id);
  }
  return rows;
}

async function callAlertPreferenceRpc(clinicId, enabled) {
  const res = await authedFetch("/rest/v1/rpc/set_my_clinic_alert_preference", {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ p_clinic_id: clinicId, p_enabled: enabled }),
  });
  if (!res.ok) {
    throw new Error("alert preference rpc failed");
  }
  const rows = await res.json();
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !isExactRecord(rows[0], ["result"]) ||
    typeof rows[0].result !== "string" ||
    ALERT_PREF_RESULTS.indexOf(rows[0].result) === -1
  ) {
    throw new Error("malformed alert preference rpc response");
  }
  return rows[0].result;
}

function renderAlertPreferences(rows) {
  alertPrefsBody.textContent = "";
  for (const row of rows) {
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.textContent = row.clinic_name;
    tr.appendChild(nameTd);

    const gateTd = document.createElement("td");
    gateTd.textContent = row.clinic_gate_enabled ? "A\\u00e7\\u0131k" : "Kapal\\u0131";
    tr.appendChild(gateTd);

    const prefTd = document.createElement("td");
    const prefInput = document.createElement("input");
    prefInput.type = "checkbox";
    prefInput.checked = row.my_preference_enabled;
    prefInput.disabled = alertPrefsMutationInFlight;
    prefInput.setAttribute("aria-label", row.clinic_name + " e-posta uyarı tercihim");
    prefInput.addEventListener("change", () => {
      submitAlertPreference(row.clinic_id, prefInput.checked, prefInput);
    });
    prefTd.appendChild(prefInput);
    tr.appendChild(prefTd);

    const effectiveTd = document.createElement("td");
    effectiveTd.textContent = row.effective_enabled ? "A\\u00e7\\u0131k" : "Kapal\\u0131";
    tr.appendChild(effectiveTd);

    alertPrefsBody.appendChild(tr);
  }
}

async function loadAlertPreferences() {
  alertPrefsErrorRegion.textContent = "";
  try {
    const rows = await fetchMyClinicAlertPreferences();
    renderAlertPreferences(rows);
  } catch {
    alertPrefsBody.textContent = "";
    alertPrefsErrorRegion.textContent = "Uyar\\u0131 tercihleri y\\u00fcklenemedi.";
  }
}

async function submitAlertPreference(clinicId, enabled, checkbox) {
  if (alertPrefsMutationInFlight) {
    checkbox.checked = !enabled;
    return;
  }
  alertPrefsErrorRegion.textContent = "";
  alertPrefsStatusRegion.textContent = "";
  alertPrefsMutationInFlight = true;
  checkbox.disabled = true;
  try {
    const result = await callAlertPreferenceRpc(clinicId, enabled);
    if (result === "forbidden") {
      alertPrefsErrorRegion.textContent = "Bu klinik i\\u00e7in yetkiniz yok.";
    } else if (result === "email_unconfirmed") {
      alertPrefsErrorRegion.textContent = "E-posta adresiniz onayl\\u0131 de\\u011fil; abonelik a\\u00e7\\u0131lamad\\u0131.";
    } else if (result === "already_enabled") {
      alertPrefsStatusRegion.textContent = "Zaten a\\u00e7\\u0131kt\\u0131; de\\u011fi\\u015fiklik yap\\u0131lmad\\u0131.";
    } else if (result === "already_disabled") {
      alertPrefsStatusRegion.textContent = "Zaten kapal\\u0131yd\\u0131; de\\u011fi\\u015fiklik yap\\u0131lmad\\u0131.";
    } else if (result === "enabled") {
      alertPrefsStatusRegion.textContent = "Uyar\\u0131 aboneli\\u011finiz a\\u00e7\\u0131ld\\u0131.";
    } else {
      alertPrefsStatusRegion.textContent = "Uyar\\u0131 aboneli\\u011finiz kapat\\u0131ld\\u0131.";
    }
  } catch {
    alertPrefsErrorRegion.textContent = "Uyar\\u0131 tercihi g\\u00fcncellenirken bir hata olu\\u015ftu.";
  } finally {
    alertPrefsMutationInFlight = false;
    await loadAlertPreferences();
  }
}

accountSelect.addEventListener("change", () => {
  selectedAccountId = accountSelect.value || null;
  automationErrorRegion.textContent = "";
  loadAutomationRoutes();
});

routeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  automationErrorRegion.textContent = "";
  automationStatusRegion.textContent = "";
  if (routeSubmitInFlight) {
    return;
  }
  const mode = event.submitter && event.submitter.value;
  if (mode !== "ai" && mode !== "manual" && mode !== "personal" && mode !== "inherit") {
    return;
  }
  const contactE164 = contactInput.value.trim();
  if (!selectedAccountId || !CONTACT_E164_PATTERN.test(contactE164)) {
    automationErrorRegion.textContent = "Ge\\u00e7erli bir E.164 numaras\\u0131 girin (\\u00f6rn. +90...).";
    return;
  }
  routeSubmitInFlight = true;
  try {
    const result = await submitContactRoute(selectedAccountId, contactE164, mode);
    if (result === "not_found") {
      automationErrorRegion.textContent = "Hat bulunamad\\u0131.";
      return;
    }
    contactInput.value = "";
    automationStatusRegion.textContent = result === "updated" ? "Numara g\\u00fcncellendi." : "De\\u011fi\\u015fiklik yoktu.";
    await loadAutomationRoutes();
  } catch {
    automationErrorRegion.textContent = "Numara g\\u00fcncellenirken bir hata olu\\u015ftu.";
  } finally {
    routeSubmitInFlight = false;
  }
});

clinicSelect.addEventListener("change", () => {
  selectedClinicId = clinicSelect.value || null;
  scheduleStatusRegion.textContent = "";
  loadScheduleForSelectedClinic();
});

closureForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = closureDateInput.value;
  if (!value) {
    return;
  }
  submitClosureDate(value, true);
});

generateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = generateDateInput.value;
  if (!value) {
    return;
  }
  submitGenerateSlots(value);
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessages();
  try {
    await login(emailInput.value, passwordInput.value);
    passwordInput.value = "";
    currentUserId = await fetchCurrentUser();
    showQueueView();
    await refreshQueue();
    await loadAutomationAccounts();
    await loadClinicSchedule();
    await loadAlertPreferences();
    startPolling();
  } catch {
    clearSession();
    showError("Giri\\u015f ba\\u015far\\u0131s\\u0131z.");
  }
});

refreshButton.addEventListener("click", () => {
  refreshQueue();
});

logoutButton.addEventListener("click", () => {
  clearSession();
});

notifyButton.addEventListener("click", async () => {
  if (typeof Notification === "undefined") {
    updateNotifyStatus();
    return;
  }
  try {
    await Notification.requestPermission();
  } catch {
    // Ignore: unsupported or blocked permission requests remain non-fatal.
  }
  updateNotifyStatus();
});

backButton.addEventListener("click", () => {
  currentWorkItemId = null;
  currentWorkItemKind = null;
  currentWorkItemReason = null;
  showQueueView();
});

claimButton.addEventListener("click", async () => {
  if (!currentWorkItemId) {
    return;
  }
  claimButton.disabled = true;
  try {
    const result = await callWorkItemRpc("claim_staff_work_item", currentWorkItemId, [
      "claimed",
      "already_claimed",
      "busy",
      "already_resolved",
      "not_found",
    ]);
    if (result === "not_found" || result === "already_resolved") {
      currentWorkItemId = null;
      currentWorkItemKind = null;
      currentWorkItemReason = null;
      showQueueView();
      await refreshQueue();
      return;
    }
    if (result === "busy") {
      showError("Bu i\\u015fi ba\\u015fka personel \\u00fcstlendi.");
    }
    await refreshWorkItemState();
  } catch {
    showError("\\u0130\\u015f \\u00fcstlenilirken bir hata olu\\u015ftu.");
    claimButton.disabled = false;
  }
});

resolveButton.addEventListener("click", async () => {
  if (!currentWorkItemId) {
    return;
  }
  if (currentWorkItemKind === "human_handoff" && currentWorkItemReason === "emergency_handoff") {
    // Decision 7: two truthful confirmations for an emergency handoff.
    // Cancelling either one must make no RPC call.
    if (!window.confirm("Klinik personeli bu acil durumla ilgilendi mi?")) {
      return;
    }
    if (
      !window.confirm(
        "Bu konu\\u015fma kapanacak ve sonraki mesaj g\\u00fcvenlik sorular\\u0131n\\u0131 yeniden ba\\u015flatacak. Onayl\\u0131yor musunuz?"
      )
    ) {
      return;
    }
  } else if (currentWorkItemKind === "human_handoff" && currentWorkItemReason === "human_handoff") {
    // Decision 6: one truthful confirmation for a normal human handoff,
    // explaining the closure and fresh-conversation behavior.
    if (
      !window.confirm(
        "Bu i\\u015fi \\u00e7\\u00f6zmek konu\\u015fmay\\u0131 tamamlayacak; m\\u00fc\\u015fteri yeniden yazarsa yeni bir konu\\u015fma ba\\u015flar ve g\\u00fcvenlik sorular\\u0131 yeniden sorulur. Devam etmek istedi\\u011finize emin misiniz?"
      )
    ) {
      return;
    }
  } else if (
    currentWorkItemKind === "delivery_failure" &&
    (currentWorkItemReason === "send_attempts_exhausted" || currentWorkItemReason === "provider_failed")
  ) {
    // delivery_failure: existing generic confirmation. Resolving this never
    // touches the linked conversation.
    if (!window.confirm("Bu i\\u015fi \\u00e7\\u00f6z\\u00fcld\\u00fc olarak i\\u015faretlemek istedi\\u011finize emin misiniz?")) {
      return;
    }
  } else {
    return;
  }
  resolveButton.disabled = true;
  try {
    const result = await callWorkItemRpc("resolve_staff_work_item", currentWorkItemId, [
      "resolved",
      "already_resolved",
      "not_claimed",
      "not_owner",
      "not_found",
    ]);
    if (result === "not_found" || result === "already_resolved") {
      currentWorkItemId = null;
      currentWorkItemKind = null;
      currentWorkItemReason = null;
      showQueueView();
      await refreshQueue();
      return;
    }
    if (result === "not_claimed" || result === "not_owner") {
      showError("Bu i\\u015fi \\u00e7\\u00f6zmeden \\u00f6nce \\u00fcstlenmeniz gerekiyor.");
      await refreshWorkItemState();
      return;
    }
    currentWorkItemId = null;
    currentWorkItemKind = null;
    currentWorkItemReason = null;
    showQueueView();
    await refreshQueue();
  } catch {
    showError("\\u0130\\u015f \\u00e7\\u00f6z\\u00fcl\\u00fcrken bir hata olu\\u015ftu.");
    resolveButton.disabled = false;
  }
});

replySendButton.addEventListener("click", async () => {
  if (!currentWorkItemId || !composerEligible || replySubmitInFlight) {
    return;
  }
  const content = replyContentInput.value.trim();
  if (content.length === 0 || replyCodePointLength(content) > REPLY_MAX_LENGTH) {
    return;
  }
  const requestId = resolveReplyRequestId(content);
  if (requestId === null) {
    replyErrorRegion.textContent =
      "Bu taray\\u0131c\\u0131da g\\u00fcvenli yan\\u0131t g\\u00f6nderimi desteklenmiyor.";
    return;
  }
  const confirmed = window.confirm(
    "Bu mesaj m\\u00fc\\u015fteriye WhatsApp \\u00fczerinden g\\u00f6nderilmek \\u00fczere kuyru\\u011fa al\\u0131nacak. Kuyru\\u011fa al\\u0131nmas\\u0131 teslim edildi\\u011fi anlam\\u0131na gelmez. Devam etmek istedi\\u011finize emin misiniz?"
  );
  if (!confirmed) {
    return;
  }
  replySubmitInFlight = true;
  replyErrorRegion.textContent = "";
  replyStatusRegion.textContent = "";
  updateReplySendButtonState();
  try {
    const outcome = await queueStaffReply(currentWorkItemId, requestId, content);
    if (outcome.result === "queued" || outcome.result === "already_queued") {
      resetReplyDraftState();
      replyStatusRegion.textContent =
        outcome.result === "queued"
          ? "Yan\\u0131t g\\u00f6nderim kuyru\\u011funa eklendi."
          : "Bu yan\\u0131t zaten kuyru\\u011fa eklenmi\\u015fti.";
      return;
    }
    replyErrorRegion.textContent = REPLY_RESULT_MESSAGES[outcome.result] || "Yan\\u0131t g\\u00f6nderilemedi.";
    if (outcome.result === "not_found" || outcome.result === "not_allowed" || outcome.result === "inactive") {
      await refreshWorkItemState(outcome.result === "not_allowed");
    }
  } catch (err) {
    if (!sessionStorage.getItem(SESSION_STORAGE_KEY)) {
      showError("Oturumunuz sona erdi. L\\u00fctfen yeniden giri\\u015f yap\\u0131n.");
    } else {
      replyErrorRegion.textContent =
        err && err.name === "AbortError"
          ? "Yan\\u0131t kuyru\\u011fa al\\u0131n\\u0131rken zaman a\\u015f\\u0131m\\u0131 oldu. Ayn\\u0131 taslakla tekrar deneyin."
          : "Yan\\u0131t kuyru\\u011fa al\\u0131namad\\u0131. Ayn\\u0131 taslakla tekrar deneyin.";
    }
  } finally {
    replySubmitInFlight = false;
    updateReplySendButtonState();
  }
});

async function init() {
  try {
    config = await loadConfig();
  } catch {
    showError("Yap\\u0131land\\u0131rma y\\u00fcklenemedi.");
    return;
  }
  updateNotifyStatus();
  if (sessionStorage.getItem(SESSION_STORAGE_KEY)) {
    try {
      currentUserId = await fetchCurrentUser();
      showQueueView();
      await refreshQueue();
      await loadAutomationAccounts();
      await loadClinicSchedule();
      await loadAlertPreferences();
      startPolling();
    } catch {
      clearSession();
    }
  } else {
    showLoginView();
  }
}

init();
`;

export function handleStaffShell(env: Env): Response {
  const config = readStaffConfig(env);
  if (!config) {
    return serviceUnavailable();
  }
  const origin = new URL(config.supabaseUrl).origin;
  const csp = `default-src 'none'; script-src 'self'; style-src ${PANEL_STYLES_CSP_HASH}; connect-src 'self' ${origin}; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`;
  return new Response(STAFF_HTML, {
    status: 200,
    headers: {
      ...STAFF_SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
    },
  });
}

export function handleStaffScript(): Response {
  return new Response(STAFF_APP_JS, {
    status: 200,
    headers: {
      ...STAFF_SECURITY_HEADERS,
      "Content-Type": "text/javascript; charset=utf-8",
    },
  });
}

export function handleStaffConfig(env: Env): Response {
  const config = readStaffConfig(env);
  if (!config) {
    return serviceUnavailable();
  }
  return Response.json(
    { supabaseUrl: config.supabaseUrl, supabaseAnonKey: config.supabaseAnonKey },
    { status: 200, headers: STAFF_SECURITY_HEADERS }
  );
}
