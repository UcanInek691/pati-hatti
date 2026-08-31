import type { Env } from "./env";

export interface AdminConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export const ADMIN_SECURITY_HEADERS: Readonly<Record<string, string>> = {
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

export function readAdminConfig(env: Env): AdminConfig | null {
  if (typeof env.SUPABASE_URL !== "string" || typeof env.SUPABASE_ANON_KEY !== "string") {
    return null;
  }
  const supabaseUrl = env.SUPABASE_URL.trim();
  const supabaseAnonKey = env.SUPABASE_ANON_KEY.trim();
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
  return new Response("Service Unavailable", { status: 503, headers: ADMIN_SECURITY_HEADERS });
}

export const ADMIN_HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VetAI Platform Yönetici Paneli</title>
<style>
  :root { color-scheme: light; font-family: system-ui, sans-serif; }
  body { max-width: 96rem; margin: 0 auto; padding: 1rem; color: #172033; background: #f5f7fb; }
  header, section { background: white; border: 1px solid #dce2ed; border-radius: .75rem; padding: 1rem; margin-bottom: 1rem; }
  form { display: flex; flex-wrap: wrap; gap: .75rem; align-items: end; }
  label { font-weight: 600; }
  input, button { font: inherit; padding: .55rem .7rem; }
  button { cursor: pointer; }
  #overview-content { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; background: white; }
  th, td { padding: .65rem; border-bottom: 1px solid #e5e9f0; text-align: left; white-space: nowrap; }
  th { background: #eef2f8; }
  #error-region { color: #a11919; font-weight: 600; }
  @media (max-width: 42rem) { body { padding: .5rem; } header, section { padding: .75rem; } }
</style>
</head>
<body>
<header>
  <h1>VetAI Platform Yönetici Paneli</h1>
  <p>Bu panel yalnızca salt-okunur operasyonel metadata ve seçilen ayın kullanım özetini gösterir; müşteri mesajlarını veya telefon numaralarını göstermez. Herhangi bir müdahale (askıya alma, kapatma, fiyatlandırma, faturalandırma vb.) yetkisi yoktur. MVP sürümünde çok faktörlü doğrulama (MFA) veya eşdeğer bir üst-seviye erişim kontrolü henüz doğrulanmadığından, bu panel üretimde onaylı ayrıcalıklı erişim olarak kabul edilemez.</p>
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

<section id="overview-section" aria-labelledby="overview-heading" hidden>
  <h2 id="overview-heading">Klinik genel bakışı</h2>
  <form id="month-form">
    <label for="month-input">Ay</label>
    <input type="month" id="month-input" name="month" required>
    <button type="submit">Yenile</button>
  </form>
  <button type="button" id="logout-button">Çıkış yap</button>
  <p id="period-region"></p>
  <div id="overview-content"></div>
</section>

<script src="/admin/app.js"></script>
</body>
</html>
`;

export const ADMIN_OVERVIEW_VALIDATION_JS = `
const EXPECTED_KEYS = [
  "result", "clinic_id", "clinic_name", "operational_status",
  "whatsapp_account_count", "open_work_item_count", "urgent_work_item_count",
  "pending_outbound_count", "processing_outbound_count", "failed_outbound_count",
  "last_inbound_at", "last_outbound_at", "period_start", "period_end",
  "ai_turn_count", "ai_touched_conversation_count",
  "input_tokens", "output_tokens", "total_tokens", "missing_token_usage_count"
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONTH_START_PATTERN = /^(?!0000)([0-9]{4})-(0[1-9]|1[0-2])-01$/;
const ISO_TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;

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

function isNonnegativeCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTimestamp(value) {
  return typeof value === "string" && ISO_TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function expectedPeriodEnd(monthStart) {
  if (typeof monthStart !== "string") return null;
  const match = MONTH_START_PATTERN.exec(monthStart);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  if (nextYear > 9999) return null;
  return String(nextYear).padStart(4, "0") + "-" + String(nextMonth).padStart(2, "0") + "-01";
}

function validateRow(row, monthStart) {
  if (!isExactRecord(row, EXPECTED_KEYS)) {
    return false;
  }
  if (row.result !== "forbidden" && row.result !== "empty" && row.result !== "reported") {
    return false;
  }
  const periodEnd = expectedPeriodEnd(monthStart);
  if (periodEnd === null || row.period_start !== monthStart || row.period_end !== periodEnd) {
    return false;
  }
  if (row.result !== "reported") {
    const clinicFields = [
      row.clinic_id, row.clinic_name, row.operational_status,
      row.whatsapp_account_count, row.open_work_item_count, row.urgent_work_item_count,
      row.pending_outbound_count, row.processing_outbound_count, row.failed_outbound_count,
      row.last_inbound_at, row.last_outbound_at,
      row.ai_turn_count, row.ai_touched_conversation_count,
      row.input_tokens, row.output_tokens, row.total_tokens, row.missing_token_usage_count,
    ];
    return clinicFields.every((field) => field === null);
  }
  return (
    typeof row.clinic_id === "string" && UUID_PATTERN.test(row.clinic_id) &&
    typeof row.clinic_name === "string" &&
    row.clinic_name === row.clinic_name.trim() &&
    Array.from(row.clinic_name).length >= 1 &&
    Array.from(row.clinic_name).length <= 200 &&
    !/[\\u0000-\\u001f\\u007f]/.test(row.clinic_name) &&
    (row.operational_status === "active" || row.operational_status === "suspended" || row.operational_status === "offboarding") &&
    isNonnegativeCount(row.whatsapp_account_count) &&
    isNonnegativeCount(row.open_work_item_count) &&
    isNonnegativeCount(row.urgent_work_item_count) &&
    isNonnegativeCount(row.pending_outbound_count) &&
    isNonnegativeCount(row.processing_outbound_count) &&
    isNonnegativeCount(row.failed_outbound_count) &&
    (row.last_inbound_at === null || isIsoTimestamp(row.last_inbound_at)) &&
    (row.last_outbound_at === null || isIsoTimestamp(row.last_outbound_at)) &&
    isNonnegativeCount(row.ai_turn_count) &&
    isNonnegativeCount(row.ai_touched_conversation_count) &&
    isNonnegativeCount(row.input_tokens) &&
    isNonnegativeCount(row.output_tokens) &&
    isNonnegativeCount(row.total_tokens) &&
    isNonnegativeCount(row.missing_token_usage_count) &&
    row.urgent_work_item_count <= row.open_work_item_count &&
    row.ai_touched_conversation_count <= row.ai_turn_count &&
    row.missing_token_usage_count <= row.ai_turn_count
  );
}

function validateOverviewRows(rows, monthStart) {
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every((row) => validateRow(row, monthStart))) {
    return false;
  }
  if (rows[0].result === "forbidden" || rows[0].result === "empty") {
    return rows.length === 1;
  }
  if (!rows.every((row) => row.result === "reported")) {
    return false;
  }
  return new Set(rows.map((row) => row.clinic_id)).size === rows.length;
}
`;

export const ADMIN_APP_JS = `"use strict";

${ADMIN_OVERVIEW_VALIDATION_JS}

const SESSION_STORAGE_KEY = "vetai_admin_access_token";
const STATUS_LABELS = { active: "Aktif", suspended: "Ask\\u0131ya al\\u0131nd\\u0131", offboarding: "Kapan\\u0131\\u015f s\\u00fcrecinde" };

const statusRegion = document.getElementById("status-region");
const errorRegion = document.getElementById("error-region");
const loginSection = document.getElementById("login-section");
const overviewSection = document.getElementById("overview-section");
const loginForm = document.getElementById("login-form");
const emailInput = document.getElementById("email-input");
const passwordInput = document.getElementById("password-input");
const monthForm = document.getElementById("month-form");
const monthInput = document.getElementById("month-input");
const logoutButton = document.getElementById("logout-button");
const periodRegion = document.getElementById("period-region");
const overviewContent = document.getElementById("overview-content");

let config = null;

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
  overviewSection.hidden = true;
}

function showOverviewView() {
  loginSection.hidden = true;
  overviewSection.hidden = false;
}

function clearSession() {
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
  overviewContent.textContent = "";
  periodRegion.textContent = "";
  clearMessages();
  showLoginView();
}

function istanbulMonthStart() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === "year").value;
  const month = parts.find((p) => p.type === "month").value;
  return { inputValue: year + "-" + month, monthStart: year + "-" + month + "-01" };
}

async function loadConfig() {
  const res = await fetch("/admin/config.json");
  if (!res.ok) {
    throw new Error("config unavailable");
  }
  const data = await res.json();
  if (!isExactRecord(data, ["supabaseUrl", "supabaseAnonKey"]) ||
      typeof data.supabaseUrl !== "string" || !data.supabaseUrl ||
      typeof data.supabaseAnonKey !== "string" || !data.supabaseAnonKey) {
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

function renderOverview(rows) {
  overviewContent.textContent = "";

  if (rows.length === 1 && rows[0].result === "forbidden") {
    showError("Bu hesap platform y\\u00f6neticisi olarak yetkilendirilmemi\\u015f.");
    return;
  }
  if (rows.length === 1 && rows[0].result === "empty") {
    const p = document.createElement("p");
    p.textContent = "Sistemde kay\\u0131tl\\u0131 klinik yok.";
    overviewContent.appendChild(p);
    return;
  }

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  [
    "Klinik", "Durum", "WhatsApp hatt\\u0131", "A\\u00e7\\u0131k i\\u015f", "Acil i\\u015f",
    "Bekleyen g\\u00f6nderim", "\\u0130\\u015flenen g\\u00f6nderim", "Ba\\u015far\\u0131s\\u0131z g\\u00f6nderim",
    "Son gelen mesaj", "Son giden mesaj",
    "AI tur say\\u0131s\\u0131", "AI'in dokundu\\u011fu konu\\u015fma", "Girdi token", "\\u00c7\\u0131kt\\u0131 token", "Toplam token", "Eksik token kayd\\u0131",
  ].forEach((label) => {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    const cells = [
      row.clinic_name,
      STATUS_LABELS[row.operational_status] || row.operational_status,
      String(row.whatsapp_account_count),
      String(row.open_work_item_count),
      String(row.urgent_work_item_count),
      String(row.pending_outbound_count),
      String(row.processing_outbound_count),
      String(row.failed_outbound_count),
      row.last_inbound_at ? new Date(row.last_inbound_at).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }) : "\\u2014",
      row.last_outbound_at ? new Date(row.last_outbound_at).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }) : "\\u2014",
      String(row.ai_turn_count),
      String(row.ai_touched_conversation_count),
      String(row.input_tokens),
      String(row.output_tokens),
      String(row.total_tokens),
      String(row.missing_token_usage_count),
    ];
    for (const value of cells) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  overviewContent.appendChild(table);
}

async function loadOverview(monthStart) {
  clearMessages();
  showStatus("Y\\u00fckleniyor...");
  overviewContent.textContent = "";
  try {
    const res = await authedFetch("/rest/v1/rpc/get_platform_admin_overview_v1", {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ p_month_start: monthStart }),
    });
    if (!res.ok) {
      throw new Error("overview rpc failed");
    }
    const rows = await res.json();
    if (!validateOverviewRows(rows, monthStart)) {
      throw new Error("malformed overview response");
    }
    clearMessages();
    periodRegion.textContent = "D\\u00f6nem: " + rows[0].period_start + " \\u2013 " + rows[0].period_end;
    renderOverview(rows);
  } catch {
    overviewContent.textContent = "";
    periodRegion.textContent = "";
    showError("Genel bak\\u0131\\u015f y\\u00fcklenemedi.");
  }
}

monthForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!monthInput.value) {
    return;
  }
  await loadOverview(monthInput.value + "-01");
});

logoutButton.addEventListener("click", () => {
  clearSession();
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessages();
  try {
    await login(emailInput.value, passwordInput.value);
    passwordInput.value = "";
    const { inputValue, monthStart } = istanbulMonthStart();
    monthInput.value = inputValue;
    showOverviewView();
    await loadOverview(monthStart);
  } catch {
    clearSession();
    showError("Giri\\u015f ba\\u015far\\u0131s\\u0131z.");
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
    const { inputValue, monthStart } = istanbulMonthStart();
    monthInput.value = inputValue;
    showOverviewView();
    await loadOverview(monthStart);
  } else {
    showLoginView();
  }
}

init();
`;

export function handleAdminShell(env: Env): Response {
  const config = readAdminConfig(env);
  if (!config) {
    return serviceUnavailable();
  }
  const origin = new URL(config.supabaseUrl).origin;
  const csp = `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' ${origin}; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`;
  return new Response(ADMIN_HTML, {
    status: 200,
    headers: {
      ...ADMIN_SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
    },
  });
}

export function handleAdminScript(): Response {
  return new Response(ADMIN_APP_JS, {
    status: 200,
    headers: {
      ...ADMIN_SECURITY_HEADERS,
      "Content-Type": "text/javascript; charset=utf-8",
    },
  });
}

export function handleAdminConfig(env: Env): Response {
  const config = readAdminConfig(env);
  if (!config) {
    return serviceUnavailable();
  }
  return Response.json(
    { supabaseUrl: config.supabaseUrl, supabaseAnonKey: config.supabaseAnonKey },
    { status: 200, headers: ADMIN_SECURITY_HEADERS }
  );
}
