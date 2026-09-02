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

  it("never renders lifecycle, pricing, billing, export, chart, or messaging controls", () => {
    expect(ADMIN_HTML.toLowerCase()).not.toMatch(/suspend|offboard|price|invoice|quota|csv|chart|send.?message/);
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

  it("calls only the overview RPC, never a lifecycle/pricing/messaging endpoint", () => {
    expect(ADMIN_APP_JS).toContain('"/rest/v1/rpc/get_platform_admin_overview_v1"');
    expect(ADMIN_APP_JS).toContain("body: JSON.stringify({ p_month_start: monthStart })");
    // STATUS_LABELS legitimately contains the substrings
    // "suspend"/"offboard" (it renders the read-only operational_status
    // field), so this checks for an actual call site, not those labels.
    expect(ADMIN_APP_JS.match(/rpc\/[a-z_0-9]+/g)).toEqual(["rpc/get_platform_admin_overview_v1"]);
    expect(ADMIN_APP_JS).not.toMatch(/suspend_clinic|resume_clinic|provision_clinic|offboarding_v1|set_clinic_operational_status/);
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

  it("disables the submit button while an Auth request is in flight, for login, recovery, and both MFA code forms", () => {
    expect(ADMIN_APP_JS.match(/button\.disabled = true;/g)?.length).toBe(4);
    expect(ADMIN_APP_JS.match(/button\.disabled = false;/g)?.length).toBe(4);
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
