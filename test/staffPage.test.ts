import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import type { IntakeQueueMessage } from "../src/intakeQueue";
import { STAFF_APP_JS, STAFF_HTML, handleStaffConfig, handleStaffScript, handleStaffShell, readStaffConfig } from "../src/staffPage";

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
  WHATSAPP_ACCESS_TOKEN: "test-whatsapp-access-token",
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

describe("readStaffConfig", () => {
  it("returns a trimmed config for a valid https URL and non-blank anon key", () => {
    const config = readStaffConfig({ ...baseEnv, SUPABASE_URL: " https://example.supabase.co/ ", SUPABASE_ANON_KEY: " placeholder-anon-key " });
    expect(config).toEqual({ supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "placeholder-anon-key" });
  });

  it.each(["http://localhost:54321", "http://127.0.0.1:54321", "http://[::1]:54321"])(
    "accepts loopback http URL %s",
    (loopbackUrl) => {
      expect(readStaffConfig({ ...baseEnv, SUPABASE_URL: loopbackUrl })).not.toBeNull();
    },
  );

  it("rejects a blank SUPABASE_URL", () => {
    expect(readStaffConfig({ ...baseEnv, SUPABASE_URL: "" })).toBeNull();
  });

  it("rejects a blank SUPABASE_ANON_KEY", () => {
    expect(readStaffConfig({ ...baseEnv, SUPABASE_ANON_KEY: "" })).toBeNull();
  });

  it("rejects a whitespace-only SUPABASE_URL", () => {
    expect(readStaffConfig({ ...baseEnv, SUPABASE_URL: "   " })).toBeNull();
  });

  it("rejects an unparsable SUPABASE_URL", () => {
    expect(readStaffConfig({ ...baseEnv, SUPABASE_URL: "not-a-url" })).toBeNull();
  });

  it("rejects a non-loopback http SUPABASE_URL", () => {
    expect(readStaffConfig({ ...baseEnv, SUPABASE_URL: "http://example.supabase.co" })).toBeNull();
  });

  it.each([
    "https://user:password@example.supabase.co",
    "https://example.supabase.co/rest/v1",
    "https://example.supabase.co?key=value",
    "https://example.supabase.co#fragment",
  ])("rejects a non-origin SUPABASE_URL %s", (unsafeUrl) => {
    expect(readStaffConfig({ ...baseEnv, SUPABASE_URL: unsafeUrl })).toBeNull();
  });
});

describe("handleStaffShell", () => {
  it("returns 200 HTML with security headers and a CSP scoped to the Supabase origin", async () => {
    const res = handleStaffShell(baseEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expectSecurityHeaders(res);
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBe("default-src 'none'; script-src 'self'; connect-src 'self' https://example.supabase.co; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
    expect(await res.text()).toBe(STAFF_HTML);
  });

  it("returns 503 with security headers and no config leakage when config is missing", async () => {
    const res = handleStaffShell({ ...baseEnv, SUPABASE_ANON_KEY: "" });
    expect(res.status).toBe(503);
    expectSecurityHeaders(res);
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    const body = await res.text();
    expect(body).not.toContain(baseEnv.SUPABASE_SERVICE_ROLE_KEY);
    expect(body).not.toContain(baseEnv.SUPABASE_URL);
  });

  it("HTML declares the required semantic regions and only the self-hosted script, with no inline script", () => {
    for (const id of ["login-section", "queue-section", "detail-section", "refresh-button", "logout-button", "resolve-button", "status-region", "error-region", "login-form", "back-button"]) {
      expect(STAFF_HTML).toContain(`id="${id}"`);
    }
    const scriptTags = STAFF_HTML.match(/<script[^>]*>/g) ?? [];
    expect(scriptTags).toEqual(['<script src="/staff/app.js">']);
    expect(STAFF_HTML).not.toMatch(/\son\w+\s*=/i);
  });
});

describe("handleStaffScript", () => {
  it("returns 200 text/javascript with security headers and the fixed source", async () => {
    const res = handleStaffScript();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expectSecurityHeaders(res);
    expect(await res.text()).toBe(STAFF_APP_JS);
  });

  it("uses native fetch and sessionStorage for the access token only", () => {
    expect(STAFF_APP_JS).toMatch(/fetch\(/);
    expect(STAFF_APP_JS).toContain("sessionStorage.setItem(SESSION_STORAGE_KEY, data.access_token)");
    expect(STAFF_APP_JS).toContain("sessionStorage.getItem(SESSION_STORAGE_KEY)");
    expect(STAFF_APP_JS).toContain("sessionStorage.removeItem(SESSION_STORAGE_KEY)");
  });

  it("authenticates with the password grant against Supabase Auth", () => {
    expect(STAFF_APP_JS).toContain('"/auth/v1/token?grant_type=password"');
  });

  it("queries the open-work list with the exact required shape", () => {
    expect(STAFF_APP_JS).toContain("status=eq.open");
    expect(STAFF_APP_JS).toContain("order=priority.desc,created_at.asc,id.asc");
    expect(STAFF_APP_JS).toContain("limit=100");
  });

  it("fetches at most the latest 20 messages", () => {
    expect(STAFF_APP_JS).toContain("&order=created_at.desc&limit=20");
  });

  it("calls the closed resolve RPC and only accepts its exact result set", () => {
    expect(STAFF_APP_JS).toContain("/rest/v1/rpc/resolve_staff_work_item");
    expect(STAFF_APP_JS).toContain('body: JSON.stringify({ p_work_item_id: currentWorkItemId })');
    expect(STAFF_APP_JS).toContain('result !== "resolved" && result !== "already_resolved" && result !== "not_found"');
    expect(STAFF_APP_JS).toContain("Object.keys(rows[0]).length !== 1");
  });

  it("requires a fixed confirmation before resolving", () => {
    expect(STAFF_APP_JS).toMatch(/window\.confirm\(/);
  });

  it("provides a logout action that clears the session", () => {
    expect(STAFF_APP_JS).toContain('logoutButton.addEventListener("click", () => {\n  clearSession();\n});');
  });

  it("clears the session on 401/403 responses", () => {
    expect(STAFF_APP_JS).toContain("if (res.status === 401 || res.status === 403) {");
  });

  it("never references the service-role credential", () => {
    expect(STAFF_APP_JS).not.toMatch(/service[_-]?role/i);
  });

  it("never calls console", () => {
    expect(STAFF_APP_JS).not.toMatch(/console\./);
  });

  it("never uses a dynamic HTML sink", () => {
    expect(STAFF_APP_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });

  it("never uses eval or the Function constructor", () => {
    expect(STAFF_APP_JS).not.toMatch(/\beval\s*\(/);
    expect(STAFF_APP_JS).not.toMatch(/new\s+Function\s*\(/);
  });

  it("never persists the refresh token", () => {
    expect(STAFF_APP_JS).not.toMatch(/refresh_token/);
  });

  it("never references webhook, outbox, or intake-data internals", () => {
    expect(STAFF_APP_JS).not.toMatch(/webhook/i);
    expect(STAFF_APP_JS).not.toMatch(/outbox/i);
    expect(STAFF_APP_JS).not.toMatch(/intake_data/i);
  });

  it("never issues an unrestricted select", () => {
    expect(STAFF_APP_JS).not.toMatch(/select=\*/);
  });

  it("routes dynamic provider/user values only through textContent", () => {
    expect(STAFF_APP_JS).toContain("label.textContent =");
    expect(STAFF_APP_JS).toContain("ownerP.textContent =");
    expect(STAFF_APP_JS).toContain("petP.textContent =");
    expect(STAFF_APP_JS).toContain("statusP.textContent =");
    expect(STAFF_APP_JS).toContain("li.textContent =");
  });
});

describe("handleStaffConfig", () => {
  it("returns exactly the two public fields with no-store security headers", async () => {
    const res = handleStaffConfig(baseEnv);
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    const body = await res.json();
    expect(Object.keys(body as object).sort()).toEqual(["supabaseAnonKey", "supabaseUrl"]);
    expect(body).toEqual({ supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "placeholder-anon-key" });
  });

  it("never includes the service-role key value or name", async () => {
    const res = handleStaffConfig(baseEnv);
    const text = await res.clone().text();
    expect(text).not.toContain(baseEnv.SUPABASE_SERVICE_ROLE_KEY);
    expect(text.toLowerCase()).not.toContain("service_role");
  });

  it("returns 503 when configuration is missing or unsafe", async () => {
    const res = handleStaffConfig({ ...baseEnv, SUPABASE_URL: "http://example.supabase.co" });
    expect(res.status).toBe(503);
    expectSecurityHeaders(res);
  });
});
