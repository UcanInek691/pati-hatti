import type { Env } from "./env";

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
<title>VetAI Personel Paneli</title>
</head>
<body>
<header>
  <h1>VetAI Personel Paneli</h1>
  <p id="status-region" role="status" aria-live="polite"></p>
  <p id="error-region" role="alert" aria-live="assertive"></p>
</header>

<section id="login-section" aria-labelledby="login-heading">
  <h2 id="login-heading">Giriş</h2>
  <form id="login-form">
    <label for="email-input">E-posta</label>
    <input type="email" id="email-input" name="email" required autocomplete="username">
    <label for="password-input">Şifre</label>
    <input type="password" id="password-input" name="password" required autocomplete="current-password">
    <button type="submit">Giriş yap</button>
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
  <p id="automation-policy-region" hidden>Strict whitelist doğrulandı: yalnızca listede <strong>AI açık</strong> olarak işaretlenen numaralar otomatik işlenir. Meta imzalı webhook'u VetAI'ye iletir; listede olmayan numaraların yönlendirme zarfı kontrol edildikten sonra mesaj içeriği incelenmez, kaydedilmez ve bot yanıt vermez.</p>
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
    <dd>Bu numaradan gelen mesajlara VetAI otomatik yanıt verir.</dd>
    <dt>Sadece insan</dt>
    <dd>Bu numaradan gelen mesajlar klinik için VetAI'de kaydedilir; VetAI otomatik yanıt vermez ve OpenAI çağırmaz. Numarayı yalnızca personel telefonla veya başka bir kanaldan yanıtlayabilir.</dd>
    <dt>Kişisel / yok say</dt>
    <dd>Meta imzalı webhook'u VetAI'ye iletir. Yönlendirme zarfı kontrol edildikten sonra mesaj içeriği incelenmez, hashlenmez, loglanmaz, Supabase veya OpenAI'a gönderilmez ve kaydedilmez. Açık bir Kişisel kaydı seçerseniz yönlendirme için telefon numarası VetAI'de saklanır; listede olmayan numara için rota kaydı tutulmaz. Bot otomatik yanıt vermez.</dd>
    <dt>Numara varsayılanı</dt>
    <dd>Bu numara için özel ayar silinir; gelecekteki mesajlar kişisel varsayılana döner.</dd>
  </dl>
  <p>Modu insan veya kişisel olarak değiştirmek önceki kayıtları silmez. Daha önce işlenmek üzere alınmış bir yanıtın süresi dolarsa kalan sınırlı denemeleri yapılabilir ve yanıt ulaşabilir; Meta'ya verilmiş bir istek geri çağrılamaz. Bu işlem hiçbir personeli bilgilendirmez ve otomatik bir insan yanıtı oluşturmaz.</p>
</section>

<section id="detail-section" aria-labelledby="detail-heading" hidden>
  <h2 id="detail-heading">Detay</h2>
  <p id="workitem-status-region"></p>
  <div id="detail-content"></div>
  <button type="button" id="claim-button">İşi üstlen</button>
  <button type="button" id="resolve-button">Çözüldü olarak işaretle</button>
  <button type="button" id="back-button">Listeye dön</button>
</section>

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

const KIND_LABELS = { human_handoff: "\\u0130nsan devri", delivery_failure: "Teslimat hatas\\u0131" };
const REASON_LABELS = {
  emergency_handoff: "Acil durum devri",
  human_handoff: "Personel talebi",
  send_attempts_exhausted: "G\\u00f6nderim denemeleri t\\u00fckendi",
  provider_failed: "Sa\\u011flay\\u0131c\\u0131 hatas\\u0131",
};
const STATUS_LABELS = { open: "A\\u00e7\\u0131k", seen: "G\\u00f6r\\u00fcld\\u00fc", in_progress: "\\u0130\\u015fleniyor" };
const MODE_LABELS = { ai: "AI a\\u00e7\\u0131k", manual: "Sadece insan", personal: "Ki\\u015fisel / yok say" };

let config = null;
let currentUserId = null;
let currentWorkItemId = null;
let queueLoadInFlight = false;
let knownWorkItemIds = null;
let pollIntervalId = null;
let selectedAccountId = null;
let routeSubmitInFlight = false;

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

function showLoginView() {
  loginSection.hidden = false;
  queueSection.hidden = true;
  detailSection.hidden = true;
  automationSection.hidden = true;
}

function showQueueView() {
  loginSection.hidden = true;
  queueSection.hidden = false;
  detailSection.hidden = true;
  automationSection.hidden = false;
}

function showDetailView() {
  loginSection.hidden = true;
  queueSection.hidden = true;
  detailSection.hidden = false;
  automationSection.hidden = true;
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
  selectedAccountId = null;
  accountSelect.textContent = "";
  routeList.textContent = "";
  automationPolicyRegion.hidden = true;
  automationStatusRegion.textContent = "";
  automationErrorRegion.textContent = "";
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
    new Notification("VetAI personel kuyru\\u011fu", {
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
    "/rest/v1/staff_work_items?id=eq." + encodeURIComponent(workItemId) + "&select=status,assigned_to",
    { headers: { Accept: "application/json" } }
  );
  if (!res.ok) {
    throw new Error("work item state fetch failed");
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("work item state unavailable");
  }
  return rows[0];
}

function applyWorkItemState(state) {
  const statusLabel = STATUS_LABELS[state.status] || state.status;
  workItemStatusRegion.textContent = statusLabel + " \\u2014 " + ownershipLabel(state.assigned_to);
  const claimable =
    state.status === "open" ||
    state.status === "seen" ||
    (state.status === "in_progress" && (state.assigned_to === null || state.assigned_to === currentUserId));
  claimButton.disabled = !claimable;
  resolveButton.disabled = !(state.status === "in_progress" && state.assigned_to === currentUserId);
}

async function refreshWorkItemState() {
  if (!currentWorkItemId) {
    return;
  }
  try {
    applyWorkItemState(await fetchWorkItemState(currentWorkItemId));
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
    li.textContent = "[" + message.direction + "] " + when + ": " + message.content;
    list.appendChild(li);
  }
  detailContent.appendChild(list);
}

async function openDetail(workItemId, conversationId) {
  currentWorkItemId = workItemId;
  errorRegion.textContent = "";
  try {
    const seenResult = await callWorkItemRpc("mark_staff_work_item_seen", workItemId, [
      "seen",
      "already_seen",
      "already_resolved",
      "not_found",
    ]);
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

    applyWorkItemState(await fetchWorkItemState(workItemId));

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
        "&select=direction,content,created_at&order=created_at.desc&limit=20",
      { headers: { Accept: "application/json" } }
    );
    if (!messagesRes.ok) {
      throw new Error("messages fetch failed");
    }
    const messageRows = await messagesRes.json();
    if (!Array.isArray(messageRows)) {
      throw new Error("malformed messages response");
    }
    const chronological = messageRows.slice().reverse();

    renderDetail(owner, pet, conversation, chronological);
    showDetailView();
  } catch {
    showError("Detay y\\u00fcklenemedi.");
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
  const confirmed = window.confirm("Bu i\\u015fi \\u00e7\\u00f6z\\u00fcld\\u00fc olarak i\\u015faretlemek istedi\\u011finize emin misiniz?");
  if (!confirmed) {
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
    showQueueView();
    await refreshQueue();
  } catch {
    showError("\\u0130\\u015f \\u00e7\\u00f6z\\u00fcl\\u00fcrken bir hata olu\\u015ftu.");
    resolveButton.disabled = false;
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
  const csp = `default-src 'none'; script-src 'self'; connect-src 'self' ${origin}; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`;
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
