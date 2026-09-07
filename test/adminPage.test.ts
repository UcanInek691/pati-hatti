import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import type { IntakeQueueMessage } from "../src/intakeQueue";
import {
  ADMIN_APP_JS,
  ADMIN_HTML,
  ADMIN_MFA_VALIDATION_JS,
  ADMIN_OVERVIEW_VALIDATION_JS,
  handleAdminConfig,
  handleAdminScript,
  handleAdminShell,
  readAdminConfig,
} from "../src/adminPage";

function stubQueue(): Queue<IntakeQueueMessage> {
  return { send: async () => {} } as unknown as Queue<IntakeQueueMessage>;
}

const baseEnv: Env = {
  APP_TIMEZONE: "Europe/Istanbul",
  WHATSAPP_VERIFY_TOKEN: "secret-token",
  WHATSAPP_APP_SECRET: "test-app-secret",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "placeholder-service-role-key",
  SUPABASE_ANON_KEY: "placeholder-anon-key",
  OPENAI_API_KEY: "unused",
  INTAKE_QUEUE: stubQueue(),
  WHATSAPP_ACCOUNT_CREDENTIALS_JSON: JSON.stringify([{ whatsapp_account_id: "33333333-3333-3333-3333-333333333333", phone_number_id: "918000001", access_token: "test-access-token" }]),
  WHATSAPP_GRAPH_API_VERSION: "v25.0",
};

const SECURITY_HEADER_EXPECTATIONS: Array<[string, string]> = [
  ["Cache-Control", "no-store"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
];

function expectSecurityHeaders(res: Response): void {
  for (const [name, value] of SECURITY_HEADER_EXPECTATIONS) {
    expect(res.headers.get(name)).toBe(value);
  }
}

type OverviewValidator = (rows: unknown, monthStart: string) => boolean;

const validateOverviewRows = new Function(`${ADMIN_OVERVIEW_VALIDATION_JS}\nreturn validateOverviewRows;`)() as OverviewValidator;

type FactorRoute =
  | { kind: "enroll" | "unsupported" }
  | { kind: "challenge" | "restart"; factorId: string };
type MfaValidators = {
  decideFactorRoute: (factors: unknown) => FactorRoute;
  qrSvgToDataUrl: (value: unknown) => string | null;
  validateEnrollResponse: (value: unknown) => { factorId: string; qrCode: string; secret: string } | null;
  validateChallengeResponse: (value: unknown) => { challengeId: string } | null;
  validateAccessTokenResponse: (value: unknown) => string | null;
  parseRecoveryFragment: (value: unknown) => string | null;
  isValidNewPassword: (value: unknown) => boolean;
  classifyAuthStatus: (status: unknown) => "ok" | "session_expired" | "failed";
};

const mfaValidators = new Function(
  `${ADMIN_OVERVIEW_VALIDATION_JS}\n${ADMIN_MFA_VALIDATION_JS}\nreturn { decideFactorRoute, qrSvgToDataUrl, validateEnrollResponse, validateChallengeResponse, validateAccessTokenResponse, parseRecoveryFragment, isValidNewPassword, classifyAuthStatus };`,
)() as MfaValidators;

type LifecycleResultValidator = (rows: unknown, allowedResults: string[]) => string | null;

const lifecycleValidatorSource = ADMIN_APP_JS.match(/function validateLifecycleResult\([\s\S]*?\n}\n/);
if (!lifecycleValidatorSource) {
  throw new Error("validateLifecycleResult not found in ADMIN_APP_JS");
}
const validateLifecycleResult = new Function(
  `${ADMIN_OVERVIEW_VALIDATION_JS}\n${lifecycleValidatorSource[0]}\nreturn validateLifecycleResult;`,
)() as LifecycleResultValidator;

const PROVISION_RESULTS = ["forbidden", "provisioned", "already_provisioned"];
const SUSPEND_RESULTS = ["forbidden", "suspended", "already_suspended", "not_found"];
const RESUME_RESULTS = ["forbidden", "resumed", "already_active", "refused_offboarding", "not_found"];

function reportedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    result: "reported",
    clinic_id: "43000000-0000-0000-2000-000000000001",
    clinic_name: "Klinik A",
    operational_status: "active",
    whatsapp_account_count: 1,
    open_work_item_count: 2,
    urgent_work_item_count: 1,
    pending_outbound_count: 1,
    processing_outbound_count: 0,
    failed_outbound_count: 0,
    last_inbound_at: "2026-06-25T08:00:00+00:00",
    last_outbound_at: null,
    period_start: "2026-06-01",
    period_end: "2026-07-01",
    ai_turn_count: 2,
    ai_touched_conversation_count: 1,
    input_tokens: 10,
    output_tokens: 20,
    total_tokens: 30,
    missing_token_usage_count: 1,
    ...overrides,
  };
}

function sentinel(result: "empty" | "forbidden", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return reportedRow({
    result,
    clinic_id: null,
    clinic_name: null,
    operational_status: null,
    whatsapp_account_count: null,
    open_work_item_count: null,
    urgent_work_item_count: null,
    pending_outbound_count: null,
    processing_outbound_count: null,
    failed_outbound_count: null,
    last_inbound_at: null,
    last_outbound_at: null,
    ai_turn_count: null,
    ai_touched_conversation_count: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    missing_token_usage_count: null,
    ...overrides,
  });
}

describe("readAdminConfig", () => {
  it("returns a trimmed config for a valid https URL and non-blank anon key", () => {
    const config = readAdminConfig({ ...baseEnv, SUPABASE_URL: " https://example.supabase.co/ ", SUPABASE_ANON_KEY: " placeholder-anon-key " });
    expect(config).toEqual({ supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "placeholder-anon-key" });
  });

  it.each(["http://localhost:54321", "http://127.0.0.1:54321", "http://[::1]:54321"])(
    "accepts loopback http URL %s",
    (loopbackUrl) => {
      expect(readAdminConfig({ ...baseEnv, SUPABASE_URL: loopbackUrl })).not.toBeNull();
    },
  );

  it("rejects a blank SUPABASE_URL", () => {
    expect(readAdminConfig({ ...baseEnv, SUPABASE_URL: "" })).toBeNull();
  });

  it("rejects a blank SUPABASE_ANON_KEY", () => {
    expect(readAdminConfig({ ...baseEnv, SUPABASE_ANON_KEY: "" })).toBeNull();
  });

  it("rejects non-string runtime bindings without throwing", () => {
    expect(readAdminConfig({ ...baseEnv, SUPABASE_URL: 42 as unknown as string })).toBeNull();
    expect(readAdminConfig({ ...baseEnv, SUPABASE_ANON_KEY: {} as string })).toBeNull();
  });

  it("rejects a whitespace-only SUPABASE_URL", () => {
    expect(readAdminConfig({ ...baseEnv, SUPABASE_URL: "   " })).toBeNull();
  });

  it("rejects an unparsable SUPABASE_URL", () => {
    expect(readAdminConfig({ ...baseEnv, SUPABASE_URL: "not-a-url" })).toBeNull();
  });

  it("rejects a non-loopback http SUPABASE_URL", () => {
    expect(readAdminConfig({ ...baseEnv, SUPABASE_URL: "http://example.supabase.co" })).toBeNull();
  });

  it.each([
    "https://user:password@example.supabase.co",
    "https://example.supabase.co/rest/v1",
    "https://example.supabase.co?key=value",
    "https://example.supabase.co#fragment",
  ])("rejects a non-origin SUPABASE_URL %s", (unsafeUrl) => {
    expect(readAdminConfig({ ...baseEnv, SUPABASE_URL: unsafeUrl })).toBeNull();
  });
});

describe("handleAdminShell", () => {
  it("returns 200 HTML with security headers and a CSP scoped to the Supabase origin", async () => {
    const res = handleAdminShell(baseEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expectSecurityHeaders(res);
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBe("default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'self' https://example.supabase.co; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
    expect(await res.text()).toBe(ADMIN_HTML);
  });

  it("returns 503 with security headers and no config leakage when config is missing", async () => {
    const res = handleAdminShell({ ...baseEnv, SUPABASE_ANON_KEY: "" });
    expect(res.status).toBe(503);
    expectSecurityHeaders(res);
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    const body = await res.text();
    expect(body).not.toContain(baseEnv.SUPABASE_SERVICE_ROLE_KEY);
    expect(body).not.toContain(baseEnv.SUPABASE_URL);
  });

  it("HTML declares the required semantic regions and only the self-hosted script, with no inline script", () => {
    for (const id of [
      "login-section",
      "recovery-section",
      "enroll-section",
      "challenge-section",
      "unsupported-section",
      "overview-section",
      "login-form",
      "recovery-form",
      "new-password-input",
      "confirm-password-input",
      "enroll-form",
      "enroll-code-input",
      "enroll-qr-image",
      "enroll-secret-text",
      "challenge-form",
      "challenge-code-input",
      "month-form",
      "month-input",
      "logout-button",
      "period-region",
      "overview-content",
      "status-region",
      "error-region",
    ]) {
      expect(ADMIN_HTML).toContain(`id="${id}"`);
    }
    const scriptTags = ADMIN_HTML.match(/<script[^>]*>/g) ?? [];
    expect(scriptTags).toEqual(['<script src="/admin/app.js">']);
    expect(ADMIN_HTML).not.toMatch(/\son\w+\s*=/i);
  });

  it("states the MVP/no-MFA-yet notice", () => {
    expect(ADMIN_HTML).toContain("MVP");
    expect(ADMIN_HTML).toContain("MFA");
  });

  it("contains a dependency-free responsive table layout", () => {
    expect(ADMIN_HTML).toContain("#overview-content { overflow-x: auto; }");
    expect(ADMIN_HTML).toContain("@media (max-width: 42rem)");
  });

  it("never renders offboarding, pricing, billing, export, chart, or messaging controls in the static shell", () => {
    expect(ADMIN_HTML.toLowerCase()).not.toMatch(/suspend|offboard|price|invoice|quota|csv|chart|send.?message/);
  });

  it("renders a bounded provisioning form with only the decision-5 fields, no email/password/token/offboarding control", () => {
    for (const id of [
      "lifecycle-section",
      "provision-form",
      "provision-clinic-name-input",
      "provision-owner-user-id-input",
      "provision-staff-role-select",
      "provision-whatsapp-account-id-input",
      "provision-phone-number-id-input",
      "provision-display-name-input",
    ]) {
      expect(ADMIN_HTML).toContain(`id="${id}"`);
    }
    const provisionFormHtml = ADMIN_HTML.slice(ADMIN_HTML.indexOf('<form id="provision-form">'), ADMIN_HTML.indexOf("</form>", ADMIN_HTML.indexOf('<form id="provision-form">')));
    expect(provisionFormHtml).not.toMatch(/type="email"|type="password"/);
    expect(provisionFormHtml).not.toMatch(/access[_-]?token|app[_-]?secret|webhook[_-]?secret|waba/i);
    expect(ADMIN_HTML).not.toMatch(/access[_-]?token|app[_-]?secret|webhook[_-]?secret|waba/i);
  });
});

describe("handleAdminScript", () => {
  it("returns 200 text/javascript with security headers and the fixed source", async () => {
    const res = handleAdminScript();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expectSecurityHeaders(res);
    expect(await res.text()).toBe(ADMIN_APP_JS);
  });

  it("uses native fetch and sessionStorage under a distinct admin session key", () => {
    expect(ADMIN_APP_JS).toContain('const SESSION_STORAGE_KEY = "vetai_admin_access_token";');
    expect(ADMIN_APP_JS).toMatch(/fetch\(/);
    expect(ADMIN_APP_JS).toContain("sessionStorage.setItem(SESSION_STORAGE_KEY, accessToken)");
    expect(ADMIN_APP_JS).toContain("sessionStorage.getItem(SESSION_STORAGE_KEY)");
    expect(ADMIN_APP_JS).toContain("sessionStorage.removeItem(SESSION_STORAGE_KEY)");
  });

  it("authenticates with the password grant against Supabase Auth", () => {
    expect(ADMIN_APP_JS).toContain('"/auth/v1/token?grant_type=password"');
  });

  it("calls only the overview RPC, the 3 platform_* lifecycle RPCs, and the 2 Task 056 clinic alert gate RPCs, never a service-role/pricing/messaging endpoint", () => {
    expect(ADMIN_APP_JS).toContain('"/rest/v1/rpc/get_platform_admin_overview_v1"');
    expect(ADMIN_APP_JS).toContain("body: JSON.stringify({ p_month_start: monthStart })");
    // Every literal "rpc/<name>" call site in the source, deduplicated. This
    // must be exactly the overview RPC, the 3 platform_* lifecycle wrappers,
    // and the 2 Task 056 clinic alert gate RPCs -- never Task 041's
    // service-role functions (suspend_clinic_v1, resume_clinic_v1,
    // provision_clinic_v1, prepare/finalize_offboarding) called directly, and
    // never set_clinic_operational_status.
    const calledRpcs = [...new Set(ADMIN_APP_JS.match(/rpc\/[a-z_0-9]+/g))].sort();
    expect(calledRpcs).toEqual(
      [
        "rpc/get_platform_admin_overview_v1",
        "rpc/get_platform_clinic_alert_gates",
        "rpc/platform_provision_clinic_v1",
        "rpc/platform_resume_clinic_v1",
        "rpc/platform_suspend_clinic_v1",
        "rpc/set_platform_clinic_alert_gate",
      ].sort()
    );
    expect(ADMIN_APP_JS).not.toMatch(/offboarding_v1|set_clinic_operational_status/);
  });

  it("strictly validates the closed 20-key row shape before rendering", () => {
    expect(ADMIN_APP_JS).toContain("function isExactRecord(value, keys)");
    expect(ADMIN_APP_JS).toContain("function validateRow(row, monthStart)");
    expect(ADMIN_APP_JS).toContain('row.result !== "forbidden" && row.result !== "empty" && row.result !== "reported"');
    expect(ADMIN_APP_JS).toContain("function validateOverviewRows(rows, monthStart)");
    expect(ADMIN_APP_JS).toContain("if (!validateOverviewRows(rows, monthStart))");
  });

  it("clears the overview and shows a fixed message on the forbidden sentinel", () => {
    expect(ADMIN_APP_JS).toContain('rows.length === 1 && rows[0].result === "forbidden"');
    expect(ADMIN_APP_JS).toContain("Bu hesap platform y\\u00f6neticisi olarak yetkilendirilmemi\\u015f.");
  });

  it("shows a fixed message on the empty sentinel", () => {
    expect(ADMIN_APP_JS).toContain('rows.length === 1 && rows[0].result === "empty"');
    expect(ADMIN_APP_JS).toContain("Sistemde kay\\u0131tl\\u0131 klinik yok.");
  });

  it("defaults the month input to the current Europe/Istanbul month", () => {
    expect(ADMIN_APP_JS).toContain("function istanbulMonthStart()");
    expect(ADMIN_APP_JS).toContain('timeZone: "Europe/Istanbul"');
  });

  it("renders message timestamps explicitly in Europe/Istanbul", () => {
    expect(ADMIN_APP_JS.match(/toLocaleString\("tr-TR", \{ timeZone: "Europe\/Istanbul" \}\)/g)).toHaveLength(2);
  });

  it("provides a logout action that clears the session", () => {
    expect(ADMIN_APP_JS).toContain('logoutButton.addEventListener("click", () => {\n  clearSession();\n});');
  });

  it("clears the session on 401/403 responses", () => {
    expect(ADMIN_APP_JS).toContain("if (res.status === 401 || res.status === 403) {");
  });

  it("never references the service-role credential", () => {
    expect(ADMIN_APP_JS).not.toMatch(/service[_-]?role/i);
  });

  it("never calls console", () => {
    expect(ADMIN_APP_JS).not.toMatch(/console\./);
  });

  it("never uses a dynamic HTML sink", () => {
    expect(ADMIN_APP_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });

  it("never uses eval or the Function constructor", () => {
    expect(ADMIN_APP_JS).not.toMatch(/\beval\s*\(/);
    expect(ADMIN_APP_JS).not.toMatch(/new\s+Function\s*\(/);
  });

  it("never persists the refresh token", () => {
    expect(ADMIN_APP_JS).not.toMatch(/refresh_token/);
  });

  it("never references phone, message, owner, pet, or content fields", () => {
    expect(ADMIN_APP_JS).not.toMatch(/phone_e164|full_name|message_id|provider_message_id|conversation_id|content:/);
  });

  it("never issues an unrestricted select", () => {
    expect(ADMIN_APP_JS).not.toMatch(/select=\*/);
  });

  it("renders every dynamic value only through textContent", () => {
    expect(ADMIN_APP_JS).toContain("td.textContent = value;");
    expect(ADMIN_APP_JS).toContain("th.textContent = label;");
    expect(ADMIN_APP_JS).toContain("errorRegion.textContent");
    expect(ADMIN_APP_JS).not.toMatch(/\.innerHTML/);
  });

  it("generates request/clinic UUIDs via Web Crypto and validates the operator-supplied WhatsApp-account UUID", () => {
    expect(ADMIN_APP_JS).toContain("function generateRequestId() {");
    expect(ADMIN_APP_JS).toContain('if (!window.crypto || typeof window.crypto.randomUUID !== "function") return null;');
    expect(ADMIN_APP_JS).toContain("return UUID_PATTERN.test(id) ? id : null;");
    expect(ADMIN_APP_JS).toContain("const whatsappAccountId = provisionWhatsappAccountIdInput.value.trim();");
    expect(ADMIN_APP_JS).toContain("if (!UUID_PATTERN.test(whatsappAccountId)) {");
    expect(ADMIN_APP_JS).not.toContain("const whatsappAccountId = generateRequestId();");
    // Never persisted or placed in a URL.
    expect(ADMIN_APP_JS).not.toMatch(/localStorage\.setItem\([^)]*requestId/i);
  });

  it("validates each lifecycle RPC response against its own closed result set", () => {
    expect(validateLifecycleResult([{ result: "provisioned" }], PROVISION_RESULTS)).toBe("provisioned");
    expect(validateLifecycleResult([{ result: "already_provisioned" }], PROVISION_RESULTS)).toBe("already_provisioned");
    expect(validateLifecycleResult([{ result: "suspended" }], SUSPEND_RESULTS)).toBe("suspended");
    expect(validateLifecycleResult([{ result: "resumed" }], RESUME_RESULTS)).toBe("resumed");
    expect(validateLifecycleResult([{ result: "refused_offboarding" }], RESUME_RESULTS)).toBe("refused_offboarding");
    // Cross-action results are rejected (a suspend response is never accepted as a resume outcome).
    expect(validateLifecycleResult([{ result: "resumed" }], SUSPEND_RESULTS)).toBeNull();
    // Unknown result, extra key, empty/duplicate rows, and non-array bodies never validate.
    expect(validateLifecycleResult([{ result: "offboarding" }], SUSPEND_RESULTS)).toBeNull();
    expect(validateLifecycleResult([{ result: "suspended", clinic_id: "x" }], SUSPEND_RESULTS)).toBeNull();
    expect(validateLifecycleResult([], SUSPEND_RESULTS)).toBeNull();
    expect(validateLifecycleResult([{ result: "suspended" }, { result: "suspended" }], SUSPEND_RESULTS)).toBeNull();
    expect(validateLifecycleResult({ result: "suspended" }, SUSPEND_RESULTS)).toBeNull();
    expect(validateLifecycleResult(null, SUSPEND_RESULTS)).toBeNull();
  });

  it("requires a fresh explicit confirmation before suspend or resume, and resume copy enumerates external checks without claiming they were verified", () => {
    expect(ADMIN_APP_JS).toContain("async function handleSuspend(clinicId, button) {");
    expect(ADMIN_APP_JS).toContain("async function handleResume(clinicId, button) {");
    const suspendConfirm = ADMIN_APP_JS.match(/async function handleSuspend[\s\S]*?window\.confirm\("([^"]+)"\)/);
    const resumeConfirm = ADMIN_APP_JS.match(/async function handleResume[\s\S]*?window\.confirm\("([^"]+)"\)/);
    expect(suspendConfirm).not.toBeNull();
    expect(resumeConfirm).not.toBeNull();
    const resumeCopy = resumeConfirm![1]!;
    for (const term of ["WhatsApp", "phone_number_id", "Cloudflare", "/ready", "Meta", "webhook", "çalışma saatleri", "rota izin listesi", "insan onayı"]) {
      expect(resumeCopy).toContain(term);
    }
    // Must disclaim machine verification, not assert it.
    expect(resumeCopy.toUpperCase()).toContain("DOĞRULAMAZ");
  });

  it("blocks overlapping lifecycle mutations behind a single shared busy flag reset in a finally block", () => {
    // 3 lifecycle mutations (suspend/resume/provision) plus the Task 056 alert gate toggle.
    expect((ADMIN_APP_JS.match(/if \(lifecycleBusy\) return;/g) || []).length).toBe(3);
    expect((ADMIN_APP_JS.match(/lifecycleBusy = true;/g) || []).length).toBe(4);
    // Excludes the initial `let lifecycleBusy = false;` declaration -- only the 4 finally-block resets.
    expect((ADMIN_APP_JS.match(/(?<!let )lifecycleBusy = false;/g) || []).length).toBe(4);
  });

  it("keeps request/entity IDs in memory across retryable failures and clears them on terminal responses or logout", () => {
    expect(ADMIN_APP_JS).toContain("let pendingProvisionAttempt = null;");
    expect(ADMIN_APP_JS).toContain("const pendingClinicActionRequestIds = new Map();");
    expect(ADMIN_APP_JS).toContain("pendingProvisionAttempt.inputSignature !== inputSignature");
    expect(ADMIN_APP_JS).toContain("const { requestId, clinicId } = pendingProvisionAttempt;");
    expect(ADMIN_APP_JS).toContain("pendingClinicActionRequestIds.set(key, requestId);");
    expect(ADMIN_APP_JS.match(/pendingClinicActionRequestIds\.delete\(request\.key\);/g)).toHaveLength(2);
    expect(ADMIN_APP_JS.match(/pendingProvisionAttempt = null;/g)).toHaveLength(3);
    expect(ADMIN_APP_JS).toContain("pendingClinicActionRequestIds.clear();");
  });

  it("does not report not-found or offboarding refusal as a successful mutation", () => {
    expect(ADMIN_APP_JS).toContain("Klinik bulunamadı; hiçbir değişiklik yapılmadı.");
    expect(ADMIN_APP_JS).toContain("Kapanış sürecindeki klinik yeniden etkinleştirilemez; hiçbir değişiklik yapılmadı.");
    expect(ADMIN_APP_JS).not.toContain('showStatus("İşlem tamamlandı.")');
  });

  it("describes suspension honestly without claiming clinic-staff membership is removed", () => {
    expect(ADMIN_APP_JS).toContain("Personel üyelikleri silinmez.");
    expect(ADMIN_APP_JS).not.toContain("personel erişimi kesilecek");
    expect(ADMIN_HTML).toContain("her klinik günlük operasyonlarını kendi <code>/staff</code> panelinden yürütür");
    expect(ADMIN_HTML).not.toContain("kendi personel erişimini");
  });

  it("reloads the overview after every successful lifecycle mutation", () => {
    // 3 lifecycle mutations (suspend/resume/provision) plus the Task 056 alert gate toggle.
    expect((ADMIN_APP_JS.match(/const \{ monthStart \} = istanbulMonthStart\(\);\s*\n\s*await loadOverview\(monthStart\);/g) || []).length).toBe(4);
  });

  it("never renders the clinic UUID as visible text or a DOM attribute, only as an in-memory closure argument", () => {
    expect(ADMIN_APP_JS).toContain("handleSuspend(row.clinic_id, suspendButton)");
    expect(ADMIN_APP_JS).toContain("handleResume(row.clinic_id, resumeButton)");
    expect(ADMIN_APP_JS).not.toMatch(/\.textContent\s*=\s*row\.clinic_id/);
    expect(ADMIN_APP_JS).not.toMatch(/setAttribute\([^)]*clinic_id/);
    expect(ADMIN_APP_JS).not.toMatch(/dataset\.\w+\s*=\s*row\.clinic_id/);
  });

  it("offers no control for an offboarding clinic, only suspend for active and resume for suspended", () => {
    const renderOverviewBody = ADMIN_APP_JS.match(/function renderOverview\(rows, alertGates\) \{[\s\S]*?\n}\n/);
    expect(renderOverviewBody).not.toBeNull();
    const body = renderOverviewBody![0];
    expect(body).toContain('row.operational_status === "active"');
    expect(body).toContain('row.operational_status === "suspended"');
    expect(body).not.toContain('row.operational_status === "offboarding"');
  });

  it("clears the provisioning form only after a terminal success, and retains it after a retryable failure", () => {
    const submitHandler = ADMIN_APP_JS.match(/provisionForm\.addEventListener\("submit"[\s\S]*?\n\}\);/);
    expect(submitHandler).not.toBeNull();
    const handlerBody = submitHandler![0];
    const successBranch = handlerBody.slice(handlerBody.indexOf("} else {"), handlerBody.indexOf("} catch {"));
    const catchBranch = handlerBody.slice(handlerBody.indexOf("} catch {"), handlerBody.indexOf("} finally {"));
    expect(successBranch).toContain("provisionForm.reset();");
    expect(catchBranch).not.toContain("provisionForm.reset();");
  });

  it("fetches clinic alert gates with an empty body and strictly validates the closed clinic_id/enabled row shape", () => {
    const fetchBody = ADMIN_APP_JS.slice(
      ADMIN_APP_JS.indexOf("async function fetchClinicAlertGates() {"),
      ADMIN_APP_JS.indexOf("async function handleAlertGateToggle("),
    );
    expect(fetchBody).toContain('"/rest/v1/rpc/get_platform_clinic_alert_gates"');
    expect(fetchBody).toContain("body: JSON.stringify({})");
    expect(fetchBody).toContain('isExactRecord(row, ["clinic_id", "enabled"])');
    expect(fetchBody).toContain("UUID_PATTERN.test(row.clinic_id)");
    expect(fetchBody).toContain('typeof row.enabled === "boolean"');
    expect(fetchBody).toContain("gates.has(row.clinic_id)");
  });

  it("skips the alert gates fetch on the forbidden/empty sentinel, otherwise fetches gates before rendering", () => {
    const loadOverviewBody = ADMIN_APP_JS.slice(
      ADMIN_APP_JS.indexOf("async function loadOverview("),
      ADMIN_APP_JS.indexOf('monthForm.addEventListener("submit"'),
    );
    expect(loadOverviewBody).toContain(
      'const isSentinel = rows.length === 1 && (rows[0].result === "forbidden" || rows[0].result === "empty");',
    );
    expect(loadOverviewBody).toContain("const alertGates = isSentinel ? new Map() : await fetchClinicAlertGates();");
    expect(loadOverviewBody).toContain("alertGates.size !== rows.length");
    expect(loadOverviewBody).toContain("!rows.every((row) => alertGates.has(row.clinic_id))");
    const sentinelIndex = loadOverviewBody.indexOf("isSentinel =");
    const renderIndex = loadOverviewBody.indexOf("renderOverview(rows, alertGates)");
    expect(sentinelIndex).toBeGreaterThan(-1);
    expect(renderIndex).toBeGreaterThan(sentinelIndex);
  });

  it("toggles the clinic alert gate via set_platform_clinic_alert_gate with exactly clinic_id and enabled, never a target user or e-mail", () => {
    const toggleBody = ADMIN_APP_JS.slice(
      ADMIN_APP_JS.indexOf("async function handleAlertGateToggle("),
      ADMIN_APP_JS.indexOf("function renderOverview("),
    );
    expect(toggleBody).toContain('"/rest/v1/rpc/set_platform_clinic_alert_gate"');
    expect(toggleBody).toContain("{ p_clinic_id: clinicId, p_enabled: enabled }");
    expect(toggleBody).toContain("ALERT_GATE_RESULTS\n    );");
    expect(ADMIN_APP_JS).toContain(
      'const ALERT_GATE_RESULTS = ["forbidden", "enabled", "already_enabled", "disabled", "already_disabled", "not_found"];',
    );
    expect(toggleBody).not.toMatch(/p_email|p_actor|p_user|p_reason/);
  });

  it("reverts the checkbox and re-enables it on forbidden/not_found/failure, and reverts it without acting when already busy", () => {
    const toggleBody = ADMIN_APP_JS.slice(
      ADMIN_APP_JS.indexOf("async function handleAlertGateToggle("),
      ADMIN_APP_JS.indexOf("function renderOverview("),
    );
    expect(toggleBody).toContain("if (lifecycleBusy) {\n    checkbox.checked = !enabled;\n    return;\n  }");
    expect(toggleBody).toContain("let reloaded = false;");
    expect(toggleBody).toContain(
      "} finally {\n    lifecycleBusy = false;\n    if (!reloaded) {\n      checkbox.checked = !enabled;\n      checkbox.disabled = false;\n    }\n  }",
    );
    const forbiddenIndex = toggleBody.indexOf('result === "forbidden"');
    const notFoundIndex = toggleBody.indexOf('result === "not_found"');
    const reloadedTrueIndex = toggleBody.indexOf("reloaded = true;");
    expect(forbiddenIndex).toBeGreaterThan(-1);
    expect(notFoundIndex).toBeGreaterThan(forbiddenIndex);
    expect(reloadedTrueIndex).toBeGreaterThan(notFoundIndex);
  });

  it("behaviorally executes success, idempotent, forbidden, not-found, and rejected alert-gate handlers", async () => {
    const source = ADMIN_APP_JS.slice(
      ADMIN_APP_JS.indexOf("async function handleAlertGateToggle("),
      ADMIN_APP_JS.indexOf("function renderOverview("),
    );
    const makeHarness = new Function(
      "callLifecycleRpc",
      `"use strict";
       let lifecycleBusy = false;
       const ALERT_GATE_RESULTS = ["forbidden", "enabled", "already_enabled", "disabled", "already_disabled", "not_found"];
       const clearMessages = () => {};
       const istanbulMonthStart = () => ({ monthStart: "2026-09-01" });
       let reloads = 0;
       let error = "";
       const loadOverview = async () => { reloads += 1; };
       const showError = (value) => { error = value; };
       ${source}
       return { handleAlertGateToggle, getReloads: () => reloads, getError: () => error };`,
    ) as (rpc: (...args: unknown[]) => Promise<string>) => {
      handleAlertGateToggle: (clinicId: string, enabled: boolean, checkbox: { checked: boolean; disabled: boolean }) => Promise<void>;
      getReloads: () => number;
      getError: () => string;
    };

    for (const result of ["enabled", "already_enabled"]) {
      const harness = makeHarness(async () => result);
      const checkbox = { checked: true, disabled: false };
      await harness.handleAlertGateToggle("56000000-0000-0000-1000-000000000001", true, checkbox);
      expect(harness.getReloads()).toBe(1);
    }
    for (const result of ["forbidden", "not_found"]) {
      const harness = makeHarness(async () => result);
      const checkbox = { checked: true, disabled: false };
      await harness.handleAlertGateToggle("56000000-0000-0000-1000-000000000001", true, checkbox);
      expect(harness.getReloads()).toBe(0);
      expect(checkbox).toEqual({ checked: false, disabled: false });
      expect(harness.getError()).not.toBe("");
    }
    const rejected = makeHarness(async () => { throw new Error("malformed or expired session"); });
    const checkbox = { checked: true, disabled: false };
    await rejected.handleAlertGateToggle("56000000-0000-0000-1000-000000000001", true, checkbox);
    expect(checkbox).toEqual({ checked: false, disabled: false });
    expect(rejected.getError()).not.toBe("");
  });

  it("renders one alert-gate checkbox per clinic row, reflecting the fetched gate map and disabled while lifecycleBusy", () => {
    const renderOverviewBody = ADMIN_APP_JS.match(/function renderOverview\(rows, alertGates\) \{[\s\S]*?\n}\n/);
    expect(renderOverviewBody).not.toBeNull();
    const body = renderOverviewBody![0];
    expect(body).toContain('"E-posta uyar\\u0131s\\u0131", "\\u0130\\u015flem",');
    expect(body).toContain("alertGateCheckbox.checked = alertGates.get(row.clinic_id) || false;");
    expect(body).toContain("alertGateCheckbox.disabled = lifecycleBusy;");
    expect(body).toContain('alertGateCheckbox.setAttribute("aria-label", row.clinic_name + " e-posta uyarı anahtarı");');
    expect(body).toContain("handleAlertGateToggle(row.clinic_id, alertGateCheckbox.checked, alertGateCheckbox);");
  });

  it("states the two-key boundary and that an already-started provider send cannot be recalled", () => {
    expect(ADMIN_HTML).toContain("personelin kendi kapalı tercihini geçersiz kılamaz");
    expect(ADMIN_HTML).toContain("gönderimi başlamış bir e-posta geri çağrılamaz ve yine de ulaşabilir");
  });
});

describe("TOTP MFA boundary", () => {
  it("declares the six mutually exclusive UI states", () => {
    for (const id of ["login-section", "recovery-section", "enroll-section", "challenge-section", "unsupported-section", "overview-section"]) {
      expect(ADMIN_HTML).toContain(`id="${id}"`);
    }
    expect(ADMIN_APP_JS).toContain("function showView(name) {");
  });

  it("uses exactly the required Supabase Auth endpoint allowlist and no invite/recovery/admin endpoint", () => {
    for (const path of [
      '"/auth/v1/token?grant_type=password"',
      '"/auth/v1/user"',
      '"/auth/v1/factors"',
      '"/auth/v1/factors/" + factorId',
      '"/auth/v1/factors/" + factorId + "/challenge"',
      '"/auth/v1/factors/" + factorId + "/verify"',
    ]) {
      expect(ADMIN_APP_JS).toContain(path);
    }
    expect(ADMIN_APP_JS).not.toMatch(/\/auth\/v1\/(invite|recover|admin|logout|sso)/);
    expect(ADMIN_APP_JS.match(/method:\s*"DELETE"/g)).toHaveLength(1);
  });

  it("keeps the pre-verification access token out of sessionStorage until the MFA challenge is verified", () => {
    expect(ADMIN_APP_JS).toContain("pendingAccessToken = accessToken;");
    expect(ADMIN_APP_JS).not.toContain("sessionStorage.setItem(SESSION_STORAGE_KEY, pendingAccessToken)");
    expect(ADMIN_APP_JS.match(/sessionStorage\.setItem\(SESSION_STORAGE_KEY,/g)).toHaveLength(1);
  });

  it("accepts only a bounded recovery fragment and never reads or persists other fragment material", () => {
    const token = "header.payload.signature";
    expect(mfaValidators.parseRecoveryFragment(`#type=recovery&access_token=${token}&ignored=value`)).toBe(token);
    for (const invalid of [
      undefined,
      "",
      "type=recovery&access_token=" + token,
      "#type=signup&access_token=" + token,
      "#type=recovery",
      "#type=recovery&access_token=bad%20token",
      "#" + "x".repeat(20001),
    ]) {
      expect(mfaValidators.parseRecoveryFragment(invalid)).toBeNull();
    }
    expect(ADMIN_APP_JS).toContain('history.replaceState(null, "", location.pathname + location.search);');
    expect(ADMIN_APP_JS).toContain("let pendingRecoveryAccessToken = null;");
    expect(ADMIN_APP_JS.match(/sessionStorage\.setItem\(SESSION_STORAGE_KEY,/g)).toHaveLength(1);
    expect(ADMIN_APP_JS).not.toMatch(/refresh_token/);
  });

  it("validates recovery passwords before PUT /auth/v1/user and returns to normal MFA-gated login", () => {
    expect(mfaValidators.isValidNewPassword("uzun-guvenli-parola")).toBe(true);
    expect(mfaValidators.isValidNewPassword("🐾".repeat(12))).toBe(true);
    expect(mfaValidators.isValidNewPassword("kisa")).toBe(false);
    expect(mfaValidators.isValidNewPassword("x".repeat(129))).toBe(false);
    expect(mfaValidators.isValidNewPassword("valid-password\n")).toBe(false);
    expect(ADMIN_APP_JS).toContain('method: "PUT"');
    expect(ADMIN_APP_JS).toContain('config.supabaseUrl + "/auth/v1/user"');
    expect(ADMIN_APP_JS).toContain("body: JSON.stringify({ password })");
    expect(ADMIN_APP_JS).toContain("TOTP doğrulaması yine gereklidir.");
  });

  it("requires exactly six ASCII digits for a one-time code", () => {
    expect(ADMIN_APP_JS).toContain("const CODE_PATTERN = /^[0-9]{6}$/;");
    expect(ADMIN_APP_JS.match(/CODE_PATTERN\.test\(code\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("routes no factors to enrollment, one interrupted TOTP to restart, and one verified TOTP to challenge", () => {
    const factorId = "43000000-0000-0000-2000-000000000010";
    expect(mfaValidators.decideFactorRoute(undefined)).toEqual({ kind: "enroll" });
    expect(mfaValidators.decideFactorRoute([])).toEqual({ kind: "enroll" });
    expect(mfaValidators.decideFactorRoute([{ id: factorId, factor_type: "totp", status: "unverified" }])).toEqual({
      kind: "restart",
      factorId,
    });
    expect(mfaValidators.decideFactorRoute([{ id: factorId, factor_type: "totp", status: "verified" }])).toEqual({
      kind: "challenge",
      factorId,
    });
  });

  it("fails closed for multiple, unsupported, and malformed factor states", () => {
    const factorId = "43000000-0000-0000-2000-000000000010";
    for (const factors of [
      null,
      {},
      [{ id: factorId, factor_type: "phone", status: "verified" }],
      [
        { id: factorId, factor_type: "totp", status: "verified" },
        { id: "43000000-0000-0000-2000-000000000011", factor_type: "totp", status: "verified" },
      ],
      [{ id: "not-a-uuid", factor_type: "totp", status: "verified" }],
      [{ id: factorId, factor_type: "totp", status: "unknown" }],
    ]) {
      expect(mfaValidators.decideFactorRoute(factors)).toEqual({ kind: "unsupported" });
    }
    expect(ADMIN_APP_JS).toContain('function showUnsupported() {\n  clearSession();\n  showView("unsupported");\n}');
    expect(ADMIN_APP_JS).toContain('if (!pendingAccessToken) throw new Error("session expired");\n      showUnsupported();');
  });

  it("removes only the exact UUID of one interrupted TOTP factor before fresh enrollment", () => {
    expect(ADMIN_APP_JS).toContain('async function removeUnverifiedFactor(factorId) {');
    expect(ADMIN_APP_JS).toContain('config.supabaseUrl + "/auth/v1/factors/" + factorId');
    expect(ADMIN_APP_JS).toContain('method: "DELETE"');
    expect(ADMIN_APP_JS).toContain('if (route.kind === "restart") {\n        await removeUnverifiedFactor(route.factorId);\n        showStatus("Yarım kalan doğrulama kurulumu güvenli biçimde yenilendi.");\n      }\n      enrolled = await enrollFactor();');
    expect(ADMIN_APP_JS.indexOf("await removeUnverifiedFactor(route.factorId)")).toBeLessThan(
      ADMIN_APP_JS.indexOf("enrolled = await enrollFactor()"),
    );
  });

  it("converts the raw Supabase SVG into one bounded encoded data URL", () => {
    const url = mfaValidators.qrSvgToDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
    expect(url).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
    const realSupabaseShape = mfaValidators.qrSvgToDataUrl(
      '<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generated by SVGo -->\n<svg><path/></svg>',
    );
    expect(realSupabaseShape).toBe("data:image/svg+xml;charset=utf-8,%3Csvg%3E%3Cpath%2F%3E%3C%2Fsvg%3E");
    for (const invalid of [
      '<?xml version="1.1"?><svg></svg>',
      '<?xml-stylesheet href="https://example.test/leak"?><svg></svg>',
      "data:image/svg+xml;utf-8,<svg></svg>",
      "<svg><script>alert(1)</script></svg>",
      '<svg><image href="https://example.test/leak"/></svg>',
      '<svg onload="alert(1)"></svg>',
      "<svg>" + "x".repeat(60001) + "</svg>",
      "not svg",
    ]) {
      expect(mfaValidators.qrSvgToDataUrl(invalid)).toBeNull();
    }
  });

  it("validates real REST-style enroll and challenge response fields", () => {
    const factorId = "43000000-0000-0000-2000-000000000010";
    const enroll = mfaValidators.validateEnrollResponse({
      id: factorId,
      type: "totp",
      totp: { qr_code: "<svg><path/></svg>", secret: "ABCDEFGHIJKLMNOP" },
    });
    expect(enroll).toEqual({
      factorId,
      qrCode: "data:image/svg+xml;charset=utf-8,%3Csvg%3E%3Cpath%2F%3E%3C%2Fsvg%3E",
      secret: "ABCDEFGHIJKLMNOP",
    });
    expect(mfaValidators.validateEnrollResponse({
      id: factorId,
      type: "totp",
      totp: { qr_code: "bad", secret: "ABCDEFGHIJKLMNOP" },
    })).toEqual({ factorId, qrCode: null, secret: "ABCDEFGHIJKLMNOP" });
    expect(mfaValidators.validateEnrollResponse({ id: factorId, type: "totp", totp: { qr_code: "<svg></svg>", secret: "not-base32!" } })).toBeNull();
    expect(mfaValidators.validateChallengeResponse({ id: factorId })).toEqual({ challengeId: factorId });
    expect(mfaValidators.validateChallengeResponse({ id: "bad" })).toBeNull();
  });

  it("validates access-token responses and classifies every non-success status", () => {
    expect(mfaValidators.validateAccessTokenResponse({ access_token: "header.payload.signature" })).toBe("header.payload.signature");
    for (const value of [null, {}, { access_token: "" }, { access_token: "bad token" }, { access_token: "x".repeat(16385) }]) {
      expect(mfaValidators.validateAccessTokenResponse(value)).toBeNull();
    }
    expect(mfaValidators.classifyAuthStatus(200)).toBe("ok");
    expect(mfaValidators.classifyAuthStatus(299)).toBe("ok");
    expect(mfaValidators.classifyAuthStatus(401)).toBe("session_expired");
    expect(mfaValidators.classifyAuthStatus(403)).toBe("session_expired");
    expect(mfaValidators.classifyAuthStatus(400)).toBe("failed");
    expect(mfaValidators.classifyAuthStatus(500)).toBe("failed");
  });

  it("renders an optional QR and the required secret only via image src / textContent, never innerHTML", () => {
    expect(ADMIN_APP_JS).toContain('if (enrolled.qrCode === null) {');
    expect(ADMIN_APP_JS).toContain("enrollQrImage.src = enrolled.qrCode;");
    expect(ADMIN_APP_JS).toContain("enrollSecretText.textContent = enrolled.secret;");
  });

  it("clears enrollment material, the password, and one-time codes on session clear", () => {
    expect(ADMIN_APP_JS).toContain('enrollQrImage.removeAttribute("src");');
    expect(ADMIN_APP_JS).toContain('enrollSecretText.textContent = "";');
    expect(ADMIN_APP_JS).toContain('passwordInput.value = "";');
  });

  it("creates a fresh challenge for every submitted code and keeps retryable failures in the MFA view", () => {
    expect(ADMIN_APP_JS.match(/const challenge = await createChallenge\(pendingFactorId\);/g)).toHaveLength(2);
    expect(ADMIN_APP_JS.match(/await verifyChallenge\(pendingFactorId, challenge\.challengeId, code\);/g)).toHaveLength(2);
    expect(ADMIN_APP_JS).toContain("if (pendingAccessToken) {");
    expect(ADMIN_APP_JS).toContain("Yeni bir kodla tekrar deneyin.");
  });

  it("clears every Auth-session failure from the factor endpoints", () => {
    expect(ADMIN_APP_JS).toContain('if (result === "session_expired") {');
    expect(ADMIN_APP_JS).toContain("clearSession();");
  });

  it("never shows the overview directly after a password login without re-deriving factor/AAL state first", () => {
    expect(ADMIN_APP_JS).toContain('await login(emailInput.value, passwordInput.value);\n    passwordInput.value = "";\n    await afterAuthenticated();');
  });

  it("re-derives factor/AAL state from a stored token on page load before ever showing the overview", () => {
    expect(ADMIN_APP_JS).toContain('pendingAccessToken = stored;\n  try {\n    await afterAuthenticated();');
  });

  it("disables the submit/action button while a request is in flight, for login, recovery, both MFA code forms, and the 3 lifecycle mutations", () => {
    expect(ADMIN_APP_JS.match(/button\.disabled = true;/g)?.length).toBe(7);
    expect(ADMIN_APP_JS.match(/button\.disabled = false;/g)?.length).toBe(7);
  });

  it("states the truthful MFA-enforced copy instead of the obsolete no-MFA notice", () => {
    expect(ADMIN_HTML).not.toContain("MFA veya eşdeğer bir üst-seviye erişim kontrolü henüz doğrulanmadığından");
    expect(ADMIN_HTML).toContain("TOTP tabanlı çok faktörlü doğrulamayı (MFA) gerektirir");
  });
});

describe("admin overview response validator", () => {
  it("accepts coherent reported rows and exact singleton sentinels", () => {
    expect(validateOverviewRows([reportedRow()], "2026-06-01")).toBe(true);
    expect(validateOverviewRows([sentinel("empty")], "2026-06-01")).toBe(true);
    expect(validateOverviewRows([sentinel("forbidden")], "2026-06-01")).toBe(true);
  });

  it("rejects a non-canonical clinic UUID, wrong period end, and malformed timestamp", () => {
    expect(validateOverviewRows([reportedRow({ clinic_id: "NOT-A-UUID" })], "2026-06-01")).toBe(false);
    expect(validateOverviewRows([reportedRow({ period_end: "2026-08-01" })], "2026-06-01")).toBe(false);
    expect(validateOverviewRows([reportedRow({ last_inbound_at: "tomorrow" })], "2026-06-01")).toBe(false);
  });

  it("rejects duplicate clinics and every mixed sentinel/result set", () => {
    expect(validateOverviewRows([reportedRow(), reportedRow()], "2026-06-01")).toBe(false);
    expect(validateOverviewRows([sentinel("forbidden"), reportedRow()], "2026-06-01")).toBe(false);
    expect(validateOverviewRows([sentinel("empty"), sentinel("empty")], "2026-06-01")).toBe(false);
  });

  it("rejects extra keys, unsafe counts, and incoherent aggregate subsets", () => {
    expect(validateOverviewRows([reportedRow({ extra: true })], "2026-06-01")).toBe(false);
    expect(validateOverviewRows([reportedRow({ ai_turn_count: Number.MAX_SAFE_INTEGER + 1 })], "2026-06-01")).toBe(false);
    expect(validateOverviewRows([reportedRow({ urgent_work_item_count: 3 })], "2026-06-01")).toBe(false);
    expect(validateOverviewRows([reportedRow({ ai_touched_conversation_count: 3 })], "2026-06-01")).toBe(false);
    expect(validateOverviewRows([reportedRow({ missing_token_usage_count: 3 })], "2026-06-01")).toBe(false);
  });

  it("rejects malformed clinic names, invalid requested months, and sentinel leakage", () => {
    expect(validateOverviewRows([reportedRow({ clinic_name: " Klinik A" })], "2026-06-01")).toBe(false);
    expect(validateOverviewRows([reportedRow({ clinic_name: "Klinik\nA" })], "2026-06-01")).toBe(false);
    expect(validateOverviewRows([reportedRow()], "2026-13-01")).toBe(false);
    expect(validateOverviewRows([sentinel("forbidden", { clinic_name: "leak" })], "2026-06-01")).toBe(false);
  });
});

describe("handleAdminConfig", () => {
  it("returns exactly the two public fields with no-store security headers", async () => {
    const res = handleAdminConfig(baseEnv);
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    const body = await res.json();
    expect(Object.keys(body as object).sort()).toEqual(["supabaseAnonKey", "supabaseUrl"]);
    expect(body).toEqual({ supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "placeholder-anon-key" });
  });

  it("never includes the service-role key value or name", async () => {
    const res = handleAdminConfig(baseEnv);
    const text = await res.clone().text();
    expect(text).not.toContain(baseEnv.SUPABASE_SERVICE_ROLE_KEY);
    expect(text.toLowerCase()).not.toContain("service_role");
  });

  it("returns 503 when configuration is missing or unsafe", async () => {
    const res = handleAdminConfig({ ...baseEnv, SUPABASE_URL: "http://example.supabase.co" });
    expect(res.status).toBe(503);
    expectSecurityHeaders(res);
  });
});
