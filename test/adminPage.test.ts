import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import type { IntakeQueueMessage } from "../src/intakeQueue";
import {
  ADMIN_APP_JS,
  ADMIN_HTML,
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
    expect(csp).toBe("default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' https://example.supabase.co; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
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
      "overview-section",
      "login-form",
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
    expect(ADMIN_APP_JS).toContain("sessionStorage.setItem(SESSION_STORAGE_KEY, data.access_token)");
    expect(ADMIN_APP_JS).toContain("sessionStorage.getItem(SESSION_STORAGE_KEY)");
    expect(ADMIN_APP_JS).toContain("sessionStorage.removeItem(SESSION_STORAGE_KEY)");
  });

  it("authenticates with the password grant against Supabase Auth", () => {
    expect(ADMIN_APP_JS).toContain('"/auth/v1/token?grant_type=password"');
  });

  it("calls only the overview RPC, never a lifecycle/pricing/messaging endpoint", () => {
    expect(ADMIN_APP_JS).toContain('"/rest/v1/rpc/get_platform_admin_overview_v1"');
    expect(ADMIN_APP_JS).toContain("body: JSON.stringify({ p_month_start: monthStart })");
    // Only two fetch targets exist: the Supabase Auth password grant and the
    // overview RPC. STATUS_LABELS legitimately contains the substrings
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
