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
  <ul id="queue-list"></ul>
</section>

<section id="detail-section" aria-labelledby="detail-heading" hidden>
  <h2 id="detail-heading">Detay</h2>
  <div id="detail-content"></div>
  <button type="button" id="resolve-button">Çözüldü olarak işaretle</button>
  <button type="button" id="back-button">Listeye dön</button>
</section>

<script src="/staff/app.js"></script>
</body>
</html>
`;

export const STAFF_APP_JS = `"use strict";

const SESSION_STORAGE_KEY = "vetai_staff_access_token";

const statusRegion = document.getElementById("status-region");
const errorRegion = document.getElementById("error-region");
const loginSection = document.getElementById("login-section");
const queueSection = document.getElementById("queue-section");
const detailSection = document.getElementById("detail-section");
const loginForm = document.getElementById("login-form");
const emailInput = document.getElementById("email-input");
const passwordInput = document.getElementById("password-input");
const refreshButton = document.getElementById("refresh-button");
const logoutButton = document.getElementById("logout-button");
const queueList = document.getElementById("queue-list");
const detailContent = document.getElementById("detail-content");
const resolveButton = document.getElementById("resolve-button");
const backButton = document.getElementById("back-button");

const KIND_LABELS = { human_handoff: "\\u0130nsan devri", delivery_failure: "Teslimat hatas\\u0131" };
const REASON_LABELS = {
  emergency_handoff: "Acil durum devri",
  human_handoff: "Personel talebi",
  send_attempts_exhausted: "G\\u00f6nderim denemeleri t\\u00fckendi",
  provider_failed: "Sa\\u011flay\\u0131c\\u0131 hatas\\u0131",
};

let config = null;
let currentWorkItemId = null;

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
}

function showQueueView() {
  loginSection.hidden = true;
  queueSection.hidden = false;
  detailSection.hidden = true;
}

function showDetailView() {
  loginSection.hidden = true;
  queueSection.hidden = true;
  detailSection.hidden = false;
}

function clearSession() {
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
  currentWorkItemId = null;
  clearMessages();
  showLoginView();
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

async function fetchOpenItems() {
  const columns = "id,kind,priority,reason,created_at,conversation_id";
  const query =
    "select=" + columns + "&status=eq.open&order=priority.desc,created_at.asc,id.asc&limit=100";
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

function renderQueue(items) {
  queueList.textContent = "";
  for (const item of items) {
    const li = document.createElement("li");

    const label = document.createElement("span");
    const urgentPrefix = item.priority === "urgent" ? "[ACIL] " : "";
    const kindLabel = KIND_LABELS[item.kind] || item.kind;
    const reasonLabel = REASON_LABELS[item.reason] || item.reason;
    const created = new Date(item.created_at).toLocaleString("tr-TR");
    label.textContent = urgentPrefix + kindLabel + " \\u2014 " + reasonLabel + " \\u2014 " + created;
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

async function refreshQueue() {
  showStatus("Y\\u00fckleniyor...");
  errorRegion.textContent = "";
  try {
    const items = await fetchOpenItems();
    renderQueue(items);
    showStatus(items.length + " a\\u00e7\\u0131k i\\u015f");
  } catch {
    showError("Liste y\\u00fcklenemedi.");
  }
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

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessages();
  try {
    await login(emailInput.value, passwordInput.value);
    passwordInput.value = "";
    showQueueView();
    await refreshQueue();
  } catch {
    showError("Giri\\u015f ba\\u015far\\u0131s\\u0131z.");
  }
});

refreshButton.addEventListener("click", () => {
  refreshQueue();
});

logoutButton.addEventListener("click", () => {
  clearSession();
});

backButton.addEventListener("click", () => {
  currentWorkItemId = null;
  showQueueView();
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
    const res = await authedFetch("/rest/v1/rpc/resolve_staff_work_item", {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ p_work_item_id: currentWorkItemId }),
    });
    if (!res.ok) {
      throw new Error("resolve request failed");
    }
    const rows = await res.json();
    if (
      !Array.isArray(rows) ||
      rows.length !== 1 ||
      typeof rows[0] !== "object" ||
      rows[0] === null ||
      Array.isArray(rows[0]) ||
      Object.keys(rows[0]).length !== 1 ||
      typeof rows[0].result !== "string"
    ) {
      throw new Error("malformed resolve response");
    }
    const result = rows[0].result;
    if (result !== "resolved" && result !== "already_resolved" && result !== "not_found") {
      throw new Error("unexpected resolve result");
    }
    if (result === "not_found") {
      showError("I\\u015f bulunamad\\u0131.");
      return;
    }
    currentWorkItemId = null;
    showQueueView();
    await refreshQueue();
  } catch {
    showError("\\u0130\\u015f \\u00e7\\u00f6z\\u00fcl\\u00fcrken bir hata olu\\u015ftu.");
  } finally {
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
  if (sessionStorage.getItem(SESSION_STORAGE_KEY)) {
    showQueueView();
    await refreshQueue();
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
