import type { Env } from "./env";
import { PANEL_STYLES, PANEL_STYLES_CSP_HASH } from "./panelStyles";

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
<meta name="robots" content="noindex, nofollow, noarchive">
<title>Pati Hattı Platform Yönetici Paneli</title>
<style>${PANEL_STYLES}</style>
</head>
<body>
<header class="app-header">
  <p class="app-eyebrow">Pati Hattı</p>
  <h1>Pati Hattı Platform Yönetici Paneli</h1>
  <p class="app-subtitle">Klinik yaşam döngüsü ve platform görünürlüğü</p>
  <details class="security-notice">
    <summary>Yetki ve güvenlik sınırları</summary>
    <p>Bu panel yalnızca salt-okunur operasyonel metadata ve seçilen ayın kullanım özetini gösterir; müşteri mesajlarını veya telefon numaralarını göstermez. Klinik oluşturma (her zaman askıya alınmış durumda başlar), askıya alma ve devam ettirme dışında müdahale yetkisi yoktur; kapanış, fiyatlandırma, faturalandırma, e-posta/parola/Meta kimlik bilgisi işlemleri ve müşteri içeriğine erişim bu panelden yapılamaz. MVP sürümünde bu panele erişim, şifre girişinin ardından veritabanı düzeyinde zorunlu kılınan TOTP tabanlı çok faktörlü doğrulamayı (MFA) gerektirir; yalnızca ikinci faktörü (aal2) doğrulanmış oturumlar genel bakış verisini görebilir. Staging doğrulaması production erişim onayı değildir; production için ayrı aktivasyon, kurtarma ve operasyon onayı gerekir.</p>
  </details>
  <p id="status-region" role="status" aria-live="polite"></p>
  <p id="error-region" role="alert" aria-live="assertive"></p>
</header>

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

<section id="recovery-section" aria-labelledby="recovery-heading" hidden>
  <h2 id="recovery-heading">Yeni parola belirle</h2>
  <p>Yeni parolanızı iki kez girin. Bu işlem yönetici paneline giriş yapmaz; parola değiştikten sonra normal giriş ve TOTP doğrulaması yine gereklidir.</p>
  <form id="recovery-form">
    <label for="new-password-input">Yeni parola</label>
    <input type="password" id="new-password-input" name="password" minlength="12" maxlength="128" required autocomplete="new-password">
    <label for="confirm-password-input">Yeni parolayı tekrar girin</label>
    <input type="password" id="confirm-password-input" name="password_confirmation" minlength="12" maxlength="128" required autocomplete="new-password">
    <button type="submit">Parolayı güncelle</button>
  </form>
</section>

<section id="enroll-section" aria-labelledby="enroll-heading" hidden>
  <h2 id="enroll-heading">Çok faktörlü doğrulama kurulumu</h2>
  <p>Bu hesapta doğrulanmış bir TOTP faktörü yok. Bir doğrulayıcı uygulamayla (ör. Google Authenticator, 1Password) aşağıdaki QR kodunu okutun veya metin anahtarını elle girin, ardından uygulamanın gösterdiği 6 haneli kodu girin.</p>
  <img id="enroll-qr-image" alt="TOTP kurulum QR kodu" width="200" height="200">
  <p>Metin anahtarı: <code id="enroll-secret-text"></code></p>
  <form id="enroll-form">
    <label for="enroll-code-input">6 haneli kod</label>
    <input type="text" id="enroll-code-input" name="code" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" required>
    <button type="submit">Doğrula</button>
  </form>
</section>

<section id="challenge-section" aria-labelledby="challenge-heading" hidden>
  <h2 id="challenge-heading">Çok faktörlü doğrulama</h2>
  <p>Doğrulayıcı uygulamanızdaki 6 haneli kodu girin.</p>
  <form id="challenge-form">
    <label for="challenge-code-input">6 haneli kod</label>
    <input type="text" id="challenge-code-input" name="code" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" required>
    <button type="submit">Doğrula</button>
  </form>
</section>

<section id="unsupported-section" aria-labelledby="unsupported-heading" hidden>
  <h2 id="unsupported-heading">Doğrulama durumu desteklenmiyor</h2>
  <p>Bu hesabın çok faktörlü doğrulama durumu bu panel tarafından desteklenmiyor. Lütfen platform operatörüyle iletişime geçin.</p>
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

  <section id="lifecycle-section" aria-labelledby="lifecycle-heading">
    <h3 id="lifecycle-heading">Klinik yaşam döngüsü</h3>
    <p>Bu bölüm yalnızca platform sahibi içindir; her klinik günlük operasyonlarını kendi <code>/staff</code> panelinden yürütür. Burada oluşturulan klinik her zaman askıya alınmış durumda başlar ve otomatik olarak etkinleştirilmez.</p>
    <p>E-posta uyarı anahtarı yalnız klinik genelindeki dağıtımı açar; personelin kendi kapalı tercihini geçersiz kılamaz. Anahtar kapatılmadan önce gönderimi başlamış bir e-posta geri çağrılamaz ve yine de ulaşabilir.</p>
    <form id="provision-form">
      <label for="provision-clinic-name-input">Klinik adı</label>
      <input type="text" id="provision-clinic-name-input" name="clinic_name" required maxlength="200">
      <label for="provision-owner-user-id-input">İlk personelin Auth UUID'i</label>
      <input type="text" id="provision-owner-user-id-input" name="owner_user_id" required>
      <label for="provision-staff-role-select">Personel rolü</label>
      <select id="provision-staff-role-select" name="staff_role" required>
        <option value="admin">Yönetici</option>
        <option value="veterinarian">Veteriner</option>
        <option value="receptionist">Resepsiyon</option>
      </select>
      <label for="provision-whatsapp-account-id-input">WhatsApp hesap UUID'i (dahili)</label>
      <input type="text" id="provision-whatsapp-account-id-input" name="whatsapp_account_id" required>
      <label for="provision-phone-number-id-input">Meta phone_number_id</label>
      <input type="text" id="provision-phone-number-id-input" name="phone_number_id" required pattern="[0-9]{1,64}">
      <label for="provision-display-name-input">Görünen ad (opsiyonel)</label>
      <input type="text" id="provision-display-name-input" name="display_name" maxlength="200">
      <button type="submit">Klinik oluştur (askıya alınmış olarak)</button>
    </form>
  </section>
</section>
</main>

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

export const ADMIN_MFA_VALIDATION_JS = `
const CODE_PATTERN = /^[0-9]{6}$/;
const TOTP_SECRET_PATTERN = /^[A-Z2-7]{16,128}$/;
const QR_DATA_URL_PREFIX = "data:image/svg+xml;charset=utf-8,";
const QR_SVG_MAX_LENGTH = 60000;
const RECOVERY_FRAGMENT_MAX_LENGTH = 20000;

function isSupportedFactorStatus(value) {
  return value === "verified" || value === "unverified";
}

function validateFactorList(rawFactors) {
  if (rawFactors === undefined) return [];
  if (!Array.isArray(rawFactors)) return null;
  for (const factor of rawFactors) {
    if (typeof factor !== "object" || factor === null || Array.isArray(factor) ||
        typeof factor.id !== "string" || !UUID_PATTERN.test(factor.id) ||
        typeof factor.factor_type !== "string" || !isSupportedFactorStatus(factor.status)) {
      return null;
    }
  }
  return rawFactors;
}

function decideFactorRoute(rawFactors) {
  const factors = validateFactorList(rawFactors);
  if (factors === null) return { kind: "unsupported" };
  if (factors.length === 0) return { kind: "enroll" };
  if (factors.length === 1 && factors[0].factor_type === "totp" && factors[0].status === "unverified") {
    return { kind: "restart", factorId: factors[0].id };
  }
  if (factors.length === 1 && factors[0].factor_type === "totp" && factors[0].status === "verified") {
    return { kind: "challenge", factorId: factors[0].id };
  }
  return { kind: "unsupported" };
}

function qrSvgToDataUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > QR_SVG_MAX_LENGTH) return null;
  const svg = value.trim()
    .replace(/^<\\?xml\\s+version=(?:"1\\.0"|'1\\.0')(?:\\s+encoding=(?:"UTF-8"|'UTF-8'))?\\s*\\?>\\s*/i, "")
    .replace(/^(?:<!--[\\s\\S]*?-->\\s*)+/, "");
  if (!/^<svg(?:\\s|>)[\\s\\S]*<\\/svg>$/.test(svg)) return null;
  if (/<(?:script|foreignObject|iframe|object|embed)\\b/i.test(svg) ||
      /\\bon[a-z]+\\s*=/i.test(svg) ||
      /(?:href|xlink:href)\\s*=/i.test(svg) ||
      /url\\s*\\(/i.test(svg) ||
      /<\\?xml-stylesheet/i.test(svg)) return null;
  return QR_DATA_URL_PREFIX + encodeURIComponent(svg);
}

function isValidTotpSecret(value) {
  return typeof value === "string" && TOTP_SECRET_PATTERN.test(value);
}

function validateEnrollResponse(data) {
  if (typeof data !== "object" || data === null || Array.isArray(data) ||
      typeof data.id !== "string" || !UUID_PATTERN.test(data.id) || data.type !== "totp") return null;
  const totp = data.totp;
  if (typeof totp !== "object" || totp === null || Array.isArray(totp)) return null;
  const qrCode = qrSvgToDataUrl(totp.qr_code);
  if (!isValidTotpSecret(totp.secret)) return null;
  return { factorId: data.id, qrCode, secret: totp.secret };
}

function validateChallengeResponse(data) {
  if (typeof data !== "object" || data === null || Array.isArray(data) ||
      typeof data.id !== "string" || !UUID_PATTERN.test(data.id)) return null;
  return { challengeId: data.id };
}

function validateAccessTokenResponse(data) {
  if (typeof data !== "object" || data === null || Array.isArray(data) ||
      typeof data.access_token !== "string" || data.access_token.length === 0 ||
      data.access_token.length > 16384 || /[\\u0000-\\u0020\\u007f]/.test(data.access_token)) return null;
  return data.access_token;
}

function parseRecoveryFragment(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > RECOVERY_FRAGMENT_MAX_LENGTH || value[0] !== "#") {
    return null;
  }
  let params;
  try {
    params = new URLSearchParams(value.slice(1));
  } catch {
    return null;
  }
  if (params.get("type") !== "recovery") return null;
  const accessToken = params.get("access_token");
  return accessToken === null ? null : validateAccessTokenResponse({ access_token: accessToken });
}

function isValidNewPassword(value) {
  if (typeof value !== "string" || /[\\u0000-\\u001f\\u007f]/.test(value)) return false;
  const length = Array.from(value).length;
  return length >= 12 && length <= 128;
}

function classifyAuthStatus(status) {
  if (status === 401 || status === 403) return "session_expired";
  if (Number.isInteger(status) && status >= 200 && status <= 299) return "ok";
  return "failed";
}
`;

export const ADMIN_APP_JS = `"use strict";

${ADMIN_OVERVIEW_VALIDATION_JS}

${ADMIN_MFA_VALIDATION_JS}

const SESSION_STORAGE_KEY = "vetai_admin_access_token";
const STATUS_LABELS = { active: "Aktif", suspended: "Ask\\u0131ya al\\u0131nd\\u0131", offboarding: "Kapan\\u0131\\u015f s\\u00fcrecinde" };

const statusRegion = document.getElementById("status-region");
const errorRegion = document.getElementById("error-region");
const loginSection = document.getElementById("login-section");
const recoverySection = document.getElementById("recovery-section");
const enrollSection = document.getElementById("enroll-section");
const challengeSection = document.getElementById("challenge-section");
const unsupportedSection = document.getElementById("unsupported-section");
const overviewSection = document.getElementById("overview-section");
const loginForm = document.getElementById("login-form");
const emailInput = document.getElementById("email-input");
const passwordInput = document.getElementById("password-input");
const recoveryForm = document.getElementById("recovery-form");
const newPasswordInput = document.getElementById("new-password-input");
const confirmPasswordInput = document.getElementById("confirm-password-input");
const enrollForm = document.getElementById("enroll-form");
const enrollCodeInput = document.getElementById("enroll-code-input");
const enrollQrImage = document.getElementById("enroll-qr-image");
const enrollSecretText = document.getElementById("enroll-secret-text");
const challengeForm = document.getElementById("challenge-form");
const challengeCodeInput = document.getElementById("challenge-code-input");
const monthForm = document.getElementById("month-form");
const monthInput = document.getElementById("month-input");
const logoutButton = document.getElementById("logout-button");
const periodRegion = document.getElementById("period-region");
const overviewContent = document.getElementById("overview-content");
const provisionForm = document.getElementById("provision-form");
const provisionClinicNameInput = document.getElementById("provision-clinic-name-input");
const provisionOwnerUserIdInput = document.getElementById("provision-owner-user-id-input");
const provisionStaffRoleSelect = document.getElementById("provision-staff-role-select");
const provisionWhatsappAccountIdInput = document.getElementById("provision-whatsapp-account-id-input");
const provisionPhoneNumberIdInput = document.getElementById("provision-phone-number-id-input");
const provisionDisplayNameInput = document.getElementById("provision-display-name-input");

const FACTOR_FRIENDLY_NAME = "Pati Hattı Admin Paneli";
const PHONE_NUMBER_ID_PATTERN = /^[0-9]{1,64}$/;
const PROVISION_RESULTS = ["forbidden", "provisioned", "already_provisioned"];
const SUSPEND_RESULTS = ["forbidden", "suspended", "already_suspended", "not_found"];
const RESUME_RESULTS = ["forbidden", "resumed", "already_active", "refused_offboarding", "not_found"];
const ALERT_GATE_RESULTS = ["forbidden", "enabled", "already_enabled", "disabled", "already_disabled", "not_found"];

let config = null;
let pendingAccessToken = null;
let pendingFactorId = null;
let pendingRecoveryAccessToken = null;
let lifecycleBusy = false;
let pendingProvisionAttempt = null;
const pendingClinicActionRequestIds = new Map();

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

function showView(name) {
  loginSection.hidden = name !== "login";
  recoverySection.hidden = name !== "recovery";
  enrollSection.hidden = name !== "enroll";
  challengeSection.hidden = name !== "challenge";
  unsupportedSection.hidden = name !== "unsupported";
  overviewSection.hidden = name !== "overview";
}

function clearSession() {
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
  pendingAccessToken = null;
  pendingFactorId = null;
  pendingRecoveryAccessToken = null;
  overviewContent.textContent = "";
  periodRegion.textContent = "";
  enrollQrImage.removeAttribute("src");
  enrollSecretText.textContent = "";
  enrollCodeInput.value = "";
  challengeCodeInput.value = "";
  passwordInput.value = "";
  newPasswordInput.value = "";
  confirmPasswordInput.value = "";
  provisionForm.reset();
  pendingProvisionAttempt = null;
  pendingClinicActionRequestIds.clear();
  clearMessages();
  showView("login");
}

function showUnsupported() {
  clearSession();
  showView("unsupported");
}

function requireAuthResponse(res, failureMessage) {
  const result = classifyAuthStatus(res.status);
  if (result === "session_expired") {
    clearSession();
    throw new Error("session expired");
  }
  if (result !== "ok") throw new Error(failureMessage);
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
  const accessToken = validateAccessTokenResponse(data);
  if (accessToken === null) throw new Error("malformed login response");
  pendingAccessToken = accessToken;
}

async function updateRecoveredPassword(password) {
  if (!pendingRecoveryAccessToken) throw new Error("missing recovery session");
  const res = await fetch(config.supabaseUrl + "/auth/v1/user", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      apikey: config.supabaseAnonKey,
      Authorization: "Bearer " + pendingRecoveryAccessToken,
    },
    body: JSON.stringify({ password }),
  });
  requireAuthResponse(res, "password update failed");
  const data = await res.json();
  if (typeof data !== "object" || data === null || Array.isArray(data) ||
      typeof data.id !== "string" || !UUID_PATTERN.test(data.id)) {
    throw new Error("malformed password update response");
  }
}

async function fetchCurrentUser() {
  const res = await fetch(config.supabaseUrl + "/auth/v1/user", {
    method: "GET",
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: "Bearer " + pendingAccessToken,
    },
  });
  requireAuthResponse(res, "user lookup failed");
  const data = await res.json();
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("malformed user response");
  }
  return data;
}

async function enrollFactor() {
  const res = await fetch(config.supabaseUrl + "/auth/v1/factors", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: config.supabaseAnonKey,
      Authorization: "Bearer " + pendingAccessToken,
    },
    body: JSON.stringify({ factor_type: "totp", friendly_name: FACTOR_FRIENDLY_NAME }),
  });
  requireAuthResponse(res, "enroll failed");
  const data = await res.json();
  const parsed = validateEnrollResponse(data);
  if (!parsed) {
    throw new Error("malformed enroll response");
  }
  return parsed;
}

async function removeUnverifiedFactor(factorId) {
  const res = await fetch(config.supabaseUrl + "/auth/v1/factors/" + factorId, {
    method: "DELETE",
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: "Bearer " + pendingAccessToken,
    },
  });
  requireAuthResponse(res, "factor cleanup failed");
}

async function createChallenge(factorId) {
  const res = await fetch(config.supabaseUrl + "/auth/v1/factors/" + factorId + "/challenge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: config.supabaseAnonKey,
      Authorization: "Bearer " + pendingAccessToken,
    },
    body: JSON.stringify({}),
  });
  requireAuthResponse(res, "challenge failed");
  const data = await res.json();
  const parsed = validateChallengeResponse(data);
  if (!parsed) {
    throw new Error("malformed challenge response");
  }
  return parsed;
}

async function verifyChallenge(factorId, challengeId, code) {
  const res = await fetch(config.supabaseUrl + "/auth/v1/factors/" + factorId + "/verify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: config.supabaseAnonKey,
      Authorization: "Bearer " + pendingAccessToken,
    },
    body: JSON.stringify({ challenge_id: challengeId, code }),
  });
  requireAuthResponse(res, "verify failed");
  const data = await res.json();
  const accessToken = validateAccessTokenResponse(data);
  if (accessToken === null) throw new Error("malformed verify response");
  pendingAccessToken = accessToken;
  sessionStorage.setItem(SESSION_STORAGE_KEY, accessToken);
}

async function afterAuthenticated() {
  const user = await fetchCurrentUser();
  const route = decideFactorRoute(user.factors);
  if (route.kind === "unsupported") {
    showUnsupported();
    return;
  }
  if (route.kind === "enroll" || route.kind === "restart") {
    let enrolled;
    try {
      if (route.kind === "restart") {
        await removeUnverifiedFactor(route.factorId);
        showStatus("Yarım kalan doğrulama kurulumu güvenli biçimde yenilendi.");
      }
      enrolled = await enrollFactor();
    } catch {
      if (!pendingAccessToken) throw new Error("session expired");
      showUnsupported();
      return;
    }
    pendingFactorId = enrolled.factorId;
    if (enrolled.qrCode === null) {
      enrollQrImage.removeAttribute("src");
      enrollQrImage.hidden = true;
    } else {
      enrollQrImage.src = enrolled.qrCode;
      enrollQrImage.hidden = false;
    }
    enrollSecretText.textContent = enrolled.secret;
    showView("enroll");
    return;
  }
  pendingFactorId = route.factorId;
  showView("challenge");
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

function generateRequestId() {
  if (!window.crypto || typeof window.crypto.randomUUID !== "function") return null;
  const id = window.crypto.randomUUID();
  return UUID_PATTERN.test(id) ? id : null;
}

function validateLifecycleResult(rows, allowedResults) {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const row = rows[0];
  if (!isExactRecord(row, ["result"]) || typeof row.result !== "string" || !allowedResults.includes(row.result)) {
    return null;
  }
  return row.result;
}

function getLifecycleRequestId(action, clinicId) {
  const key = action + ":" + clinicId;
  const existing = pendingClinicActionRequestIds.get(key);
  if (existing) return { key, requestId: existing };
  const requestId = generateRequestId();
  if (requestId === null) return null;
  pendingClinicActionRequestIds.set(key, requestId);
  return { key, requestId };
}

async function callLifecycleRpc(path, body, allowedResults) {
  const res = await authedFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("lifecycle rpc failed");
  const data = await res.json();
  const result = validateLifecycleResult(data, allowedResults);
  if (result === null) throw new Error("malformed lifecycle response");
  return result;
}

async function handleSuspend(clinicId, button) {
  if (lifecycleBusy) return;
  if (!window.confirm("Bu kliniğin WhatsApp otomasyonu durdurulacak ve bekleyen/işleniyor durumundaki gönderimleri silinecek. Personel üyelikleri silinmez. Onaylıyor musunuz?")) {
    return;
  }
  const request = getLifecycleRequestId("suspend", clinicId);
  if (request === null) {
    showError("Bu tarayıcı güvenli UUID üretimini desteklemiyor.");
    return;
  }
  clearMessages();
  lifecycleBusy = true;
  button.disabled = true;
  try {
    const result = await callLifecycleRpc("/rest/v1/rpc/platform_suspend_clinic_v1", { p_request_id: request.requestId, p_clinic_id: clinicId }, SUSPEND_RESULTS);
    pendingClinicActionRequestIds.delete(request.key);
    if (result === "forbidden") {
      showError("Bu hesap platform yöneticisi olarak yetkilendirilmemiş.");
    } else {
      const { monthStart } = istanbulMonthStart();
      await loadOverview(monthStart);
      if (result === "suspended") {
        showStatus("Klinik askıya alındı.");
      } else if (result === "already_suspended") {
        showStatus("Klinik zaten askıya alınmış durumda.");
      } else {
        showError("Klinik bulunamadı; hiçbir değişiklik yapılmadı.");
      }
    }
  } catch {
    showError("Askıya alma başarısız. Ağ hatası veya oturum sorunu olabilir.");
  } finally {
    lifecycleBusy = false;
    button.disabled = false;
  }
}

async function handleResume(clinicId, button) {
  if (lifecycleBusy) return;
  if (!window.confirm("Bu klinik devam ettirilecek. Devam ettirmeden önce operatör olarak şunların TAMAMLANDIĞINI doğrulayın (bu onay bunları otomatik olarak DOĞRULAMAZ): doğru WhatsApp hesap ve phone_number_id kimlik bilgisi girişi, Cloudflare gizli anahtarının güncellenmesi, /ready kontrolü, Meta webhook/yapılandırma kontrolleri, klinik çalışma saatleri programı, rota izin listesi ve insan onayı kapıları. Onaylıyor musunuz?")) {
    return;
  }
  const request = getLifecycleRequestId("resume", clinicId);
  if (request === null) {
    showError("Bu tarayıcı güvenli UUID üretimini desteklemiyor.");
    return;
  }
  clearMessages();
  lifecycleBusy = true;
  button.disabled = true;
  try {
    const result = await callLifecycleRpc("/rest/v1/rpc/platform_resume_clinic_v1", { p_request_id: request.requestId, p_clinic_id: clinicId }, RESUME_RESULTS);
    pendingClinicActionRequestIds.delete(request.key);
    if (result === "forbidden") {
      showError("Bu hesap platform yöneticisi olarak yetkilendirilmemiş.");
    } else {
      const { monthStart } = istanbulMonthStart();
      await loadOverview(monthStart);
      if (result === "resumed") {
        showStatus("Klinik yeniden etkinleştirildi.");
      } else if (result === "already_active") {
        showStatus("Klinik zaten aktif durumda.");
      } else if (result === "refused_offboarding") {
        showError("Kapanış sürecindeki klinik yeniden etkinleştirilemez; hiçbir değişiklik yapılmadı.");
      } else {
        showError("Klinik bulunamadı; hiçbir değişiklik yapılmadı.");
      }
    }
  } catch {
    showError("Devam ettirme başarısız. Ağ hatası veya oturum sorunu olabilir.");
  } finally {
    lifecycleBusy = false;
    button.disabled = false;
  }
}

async function fetchClinicAlertGates() {
  const res = await authedFetch("/rest/v1/rpc/get_platform_clinic_alert_gates", {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error("alert gates rpc failed");
  const rows = await res.json();
  if (
    !Array.isArray(rows) ||
    !rows.every(
      (row) =>
        isExactRecord(row, ["clinic_id", "enabled"]) &&
        typeof row.clinic_id === "string" &&
        UUID_PATTERN.test(row.clinic_id) &&
        typeof row.enabled === "boolean"
    )
  ) {
    throw new Error("malformed alert gates response");
  }
  const gates = new Map();
  for (const row of rows) {
    if (gates.has(row.clinic_id)) {
      throw new Error("duplicate alert gate clinic");
    }
    gates.set(row.clinic_id, row.enabled);
  }
  return gates;
}

async function handleAlertGateToggle(clinicId, enabled, checkbox) {
  if (lifecycleBusy) {
    checkbox.checked = !enabled;
    return;
  }
  clearMessages();
  lifecycleBusy = true;
  checkbox.disabled = true;
  let reloaded = false;
  try {
    const result = await callLifecycleRpc(
      "/rest/v1/rpc/set_platform_clinic_alert_gate",
      { p_clinic_id: clinicId, p_enabled: enabled },
      ALERT_GATE_RESULTS
    );
    if (result === "forbidden") {
      showError("Bu hesap platform y\\u00f6neticisi olarak yetkilendirilmemi\\u015f.");
    } else if (result === "not_found") {
      showError("Klinik bulunamad\\u0131; hi\\u00e7bir de\\u011fi\\u015fiklik yap\\u0131lmad\\u0131.");
    } else {
      const { monthStart } = istanbulMonthStart();
      await loadOverview(monthStart);
      reloaded = true;
    }
  } catch {
    showError("E-posta uyar\\u0131 anahtar\\u0131 g\\u00fcncellenemedi.");
  } finally {
    lifecycleBusy = false;
    if (!reloaded) {
      checkbox.checked = !enabled;
      checkbox.disabled = false;
    }
  }
}

function renderOverview(rows, alertGates) {
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
    "E-posta uyar\\u0131s\\u0131", "\\u0130\\u015flem",
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
    const alertGateTd = document.createElement("td");
    const alertGateCheckbox = document.createElement("input");
    alertGateCheckbox.type = "checkbox";
    alertGateCheckbox.checked = alertGates.get(row.clinic_id) || false;
    alertGateCheckbox.disabled = lifecycleBusy;
    alertGateCheckbox.setAttribute("aria-label", row.clinic_name + " e-posta uyarı anahtarı");
    alertGateCheckbox.addEventListener("change", () => {
      handleAlertGateToggle(row.clinic_id, alertGateCheckbox.checked, alertGateCheckbox);
    });
    alertGateTd.appendChild(alertGateCheckbox);
    tr.appendChild(alertGateTd);
    const actionsTd = document.createElement("td");
    if (row.operational_status === "active") {
      const suspendButton = document.createElement("button");
      suspendButton.type = "button";
      suspendButton.textContent = "Ask\\u0131ya al";
      suspendButton.className = "btn-danger";
      suspendButton.addEventListener("click", () => handleSuspend(row.clinic_id, suspendButton));
      actionsTd.appendChild(suspendButton);
    } else if (row.operational_status === "suspended") {
      const resumeButton = document.createElement("button");
      resumeButton.type = "button";
      resumeButton.textContent = "Devam ettir";
      resumeButton.addEventListener("click", () => handleResume(row.clinic_id, resumeButton));
      actionsTd.appendChild(resumeButton);
    }
    tr.appendChild(actionsTd);
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
    const isSentinel = rows.length === 1 && (rows[0].result === "forbidden" || rows[0].result === "empty");
    const alertGates = isSentinel ? new Map() : await fetchClinicAlertGates();
    if (!isSentinel && (
      alertGates.size !== rows.length ||
      !rows.every((row) => alertGates.has(row.clinic_id))
    )) {
      throw new Error("alert gate clinic set mismatch");
    }
    clearMessages();
    periodRegion.textContent = "D\\u00f6nem: " + rows[0].period_start + " \\u2013 " + rows[0].period_end;
    renderOverview(rows, alertGates);
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

provisionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessages();
  if (lifecycleBusy) return;
  const ownerUserId = provisionOwnerUserIdInput.value.trim();
  const whatsappAccountId = provisionWhatsappAccountIdInput.value.trim();
  const phoneNumberId = provisionPhoneNumberIdInput.value.trim();
  if (!UUID_PATTERN.test(ownerUserId)) {
    showError("Personel Auth UUID'i geçersiz.");
    return;
  }
  if (!PHONE_NUMBER_ID_PATTERN.test(phoneNumberId)) {
    showError("Meta phone_number_id geçersiz.");
    return;
  }
  if (!UUID_PATTERN.test(whatsappAccountId)) {
    showError("WhatsApp hesap UUID'i geçersiz.");
    return;
  }
  const clinicName = provisionClinicNameInput.value.trim();
  const staffRole = provisionStaffRoleSelect.value;
  const displayName = provisionDisplayNameInput.value.trim() || null;
  const inputSignature = JSON.stringify({ clinicName, ownerUserId, staffRole, whatsappAccountId, phoneNumberId, displayName });
  if (pendingProvisionAttempt === null || pendingProvisionAttempt.inputSignature !== inputSignature) {
    const requestId = generateRequestId();
    const clinicId = generateRequestId();
    if (requestId === null || clinicId === null) {
      showError("Bu tarayıcı güvenli UUID üretimini desteklemiyor.");
      return;
    }
    pendingProvisionAttempt = { inputSignature, requestId, clinicId };
  }
  const { requestId, clinicId } = pendingProvisionAttempt;
  const button = provisionForm.querySelector("button[type=submit]");
  lifecycleBusy = true;
  button.disabled = true;
  try {
    const result = await callLifecycleRpc(
      "/rest/v1/rpc/platform_provision_clinic_v1",
      {
        p_request_id: requestId,
        p_clinic_id: clinicId,
        p_clinic_name: clinicName,
        p_owner_user_id: ownerUserId,
        p_staff_role: staffRole,
        p_whatsapp_account_id: whatsappAccountId,
        p_phone_number_id: phoneNumberId,
        p_display_name: displayName,
      },
      PROVISION_RESULTS
    );
    pendingProvisionAttempt = null;
    if (result === "forbidden") {
      showError("Bu hesap platform yöneticisi olarak yetkilendirilmemiş.");
    } else {
      provisionForm.reset();
      const { monthStart } = istanbulMonthStart();
      await loadOverview(monthStart);
      if (result === "provisioned") {
        showStatus("Klinik oluşturuldu (askıya alınmış durumda). Devam ettirmeden önce WhatsApp kimlik bilgileri, Cloudflare gizli anahtarı, /ready ve Meta doğrulamaları tamamlanmalıdır.");
      } else {
        showStatus("Bu oluşturma isteği daha önce tamamlanmıştı; klinik askıya alınmış durumda.");
      }
    }
  } catch {
    showError("Klinik oluşturma başarısız. Ağ hatası veya oturum sorunu olabilir.");
  } finally {
    lifecycleBusy = false;
    button.disabled = false;
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessages();
  const button = loginForm.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await login(emailInput.value, passwordInput.value);
    passwordInput.value = "";
    await afterAuthenticated();
  } catch {
    clearSession();
    showError("Giri\\u015f ba\\u015far\\u0131s\\u0131z.");
  } finally {
    button.disabled = false;
  }
});

recoveryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessages();
  const password = newPasswordInput.value;
  if (!isValidNewPassword(password)) {
    showError("Parola 12 ile 128 karakter arasında olmalı ve kontrol karakteri içermemeli.");
    return;
  }
  if (password !== confirmPasswordInput.value) {
    showError("Parolalar eşleşmiyor.");
    return;
  }
  const button = recoveryForm.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await updateRecoveredPassword(password);
    clearSession();
    showStatus("Parolanız güncellendi. Yeni parolanızla giriş yapın; TOTP doğrulaması yine gereklidir.");
  } catch {
    clearSession();
    showError("Parola güncellenemedi. Bağlantı geçersiz veya süresi dolmuş olabilir; yeni bir kurtarma e-postası isteyin.");
  } finally {
    button.disabled = false;
  }
});

enrollForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessages();
  const code = enrollCodeInput.value.trim();
  if (!CODE_PATTERN.test(code)) {
    showError("Kod 6 haneli olmal\\u0131.");
    return;
  }
  const button = enrollForm.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const challenge = await createChallenge(pendingFactorId);
    await verifyChallenge(pendingFactorId, challenge.challengeId, code);
    pendingFactorId = null;
    enrollCodeInput.value = "";
    enrollQrImage.removeAttribute("src");
    enrollSecretText.textContent = "";
    const { inputValue, monthStart } = istanbulMonthStart();
    monthInput.value = inputValue;
    showView("overview");
    await loadOverview(monthStart);
  } catch {
    if (pendingAccessToken) {
      showError("Kod do\\u011frulanamad\\u0131. Yeni bir kodla tekrar deneyin.");
    } else {
      showError("Oturum sona erdi. L\\u00fctfen yeniden giri\\u015f yap\\u0131n.");
    }
  } finally {
    button.disabled = false;
  }
});

challengeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessages();
  const code = challengeCodeInput.value.trim();
  if (!CODE_PATTERN.test(code)) {
    showError("Kod 6 haneli olmal\\u0131.");
    return;
  }
  const button = challengeForm.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const challenge = await createChallenge(pendingFactorId);
    await verifyChallenge(pendingFactorId, challenge.challengeId, code);
    pendingFactorId = null;
    challengeCodeInput.value = "";
    const { inputValue, monthStart } = istanbulMonthStart();
    monthInput.value = inputValue;
    showView("overview");
    await loadOverview(monthStart);
  } catch {
    if (pendingAccessToken) {
      showError("Kod do\\u011frulanamad\\u0131. Yeni bir kodla tekrar deneyin.");
    } else {
      showError("Oturum sona erdi. L\\u00fctfen yeniden giri\\u015f yap\\u0131n.");
    }
  } finally {
    button.disabled = false;
  }
});

async function init() {
  const recoveryFragment = location.hash;
  if (recoveryFragment) {
    history.replaceState(null, "", location.pathname + location.search);
  }
  const recoveryAccessToken = parseRecoveryFragment(recoveryFragment);
  if (recoveryFragment && recoveryAccessToken === null) {
    clearSession();
    showError("Geçersiz parola kurtarma bağlantısı.");
    return;
  }
  try {
    config = await loadConfig();
  } catch {
    showError("Yap\\u0131land\\u0131rma y\\u00fcklenemedi.");
    return;
  }
  if (recoveryAccessToken !== null) {
    clearSession();
    pendingRecoveryAccessToken = recoveryAccessToken;
    showView("recovery");
    return;
  }
  const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!stored) {
    showView("login");
    return;
  }
  pendingAccessToken = stored;
  try {
    await afterAuthenticated();
  } catch {
    clearSession();
    showError("Oturum do\\u011frulanamad\\u0131.");
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
  const csp = `default-src 'none'; script-src 'self'; style-src ${PANEL_STYLES_CSP_HASH}; img-src data:; connect-src 'self' ${origin}; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`;
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
