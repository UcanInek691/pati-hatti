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
    for (const id of [
      "login-section",
      "queue-section",
      "detail-section",
      "refresh-button",
      "logout-button",
      "notify-button",
      "notify-status",
      "resolve-button",
      "claim-button",
      "workitem-status-region",
      "status-region",
      "error-region",
      "login-form",
      "back-button",
    ]) {
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

  it("queries the non-resolved work list with the exact required shape", () => {
    expect(STAFF_APP_JS).toContain(
      "id,kind,priority,reason,status,created_at,conversation_id,first_seen_at,assigned_at,assigned_to",
    );
    expect(STAFF_APP_JS).toContain("status=neq.resolved");
    expect(STAFF_APP_JS).not.toContain("status=eq.open");
    expect(STAFF_APP_JS).toContain("order=priority.desc,created_at.asc,id.asc");
    expect(STAFF_APP_JS).toContain("limit=100");
  });

  it("fetches at most the latest 20 messages", () => {
    expect(STAFF_APP_JS).toContain("&order=created_at.desc&limit=20");
  });

  it("calls all three work-item RPCs through one shared closed-result helper", () => {
    expect(STAFF_APP_JS).toContain("async function callWorkItemRpc(rpcName, workItemId, allowedResults)");
    expect(STAFF_APP_JS).toContain('"/rest/v1/rpc/" + rpcName');
    expect(STAFF_APP_JS).toContain("body: JSON.stringify({ p_work_item_id: workItemId })");
    expect(STAFF_APP_JS).toContain("allowedResults.indexOf(rows[0].result) === -1");
    expect(STAFF_APP_JS).toContain("Object.keys(rows[0]).length !== 1");
    expect(STAFF_APP_JS).toContain('callWorkItemRpc("mark_staff_work_item_seen", workItemId, [');
    expect(STAFF_APP_JS).toContain('callWorkItemRpc("claim_staff_work_item", currentWorkItemId, [');
    expect(STAFF_APP_JS).toContain('callWorkItemRpc("resolve_staff_work_item", currentWorkItemId, [');
  });

  it("accepts the exact closed result set for each work-item RPC", () => {
    expect(STAFF_APP_JS).toMatch(/"seen",\s*"already_seen",\s*"already_resolved",\s*"not_found",/);
    expect(STAFF_APP_JS).toMatch(/"claimed",\s*"already_claimed",\s*"busy",\s*"already_resolved",\s*"not_found",/);
    expect(STAFF_APP_JS).toMatch(/"resolved",\s*"already_resolved",\s*"not_claimed",\s*"not_owner",\s*"not_found",/);
  });

  it("marks a work item seen before loading detail, and stops on already_resolved/not_found", () => {
    expect(STAFF_APP_JS).toContain("async function openDetail(workItemId, conversationId) {");
    const openDetailBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function openDetail(workItemId, conversationId) {"),
    );
    const seenCallIndex = openDetailBody.indexOf("callWorkItemRpc(\"mark_staff_work_item_seen\"");
    const convFetchIndex = openDetailBody.indexOf("/rest/v1/conversations?id=eq.");
    expect(seenCallIndex).toBeGreaterThan(-1);
    expect(convFetchIndex).toBeGreaterThan(-1);
    expect(seenCallIndex).toBeLessThan(convFetchIndex);
    expect(openDetailBody.indexOf('seenResult === "already_resolved" || seenResult === "not_found"')).toBeGreaterThan(-1);
  });

  it("gates claim availability and owner-only resolve from work-item state", () => {
    expect(STAFF_APP_JS).toContain("function applyWorkItemState(state)");
    expect(STAFF_APP_JS).toContain('state.status === "open" ||');
    expect(STAFF_APP_JS).toContain('state.status === "seen" ||');
    expect(STAFF_APP_JS).toContain(
      '(state.status === "in_progress" && (state.assigned_to === null || state.assigned_to === currentUserId))',
    );
    expect(STAFF_APP_JS).toContain("claimButton.disabled = !claimable;");
    expect(STAFF_APP_JS).toContain(
      'resolveButton.disabled = !(state.status === "in_progress" && state.assigned_to === currentUserId);',
    );
  });

  it("shows a fixed busy status and generic not_claimed/not_owner guidance without leaking an actor", () => {
    expect(STAFF_APP_JS).toContain('if (result === "busy") {');
    expect(STAFF_APP_JS).toContain('if (result === "not_claimed" || result === "not_owner") {');
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

  it("clears a newly stored session if current-user validation fails during login", () => {
    const loginHandler = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf('loginForm.addEventListener("submit"'),
      STAFF_APP_JS.indexOf('refreshButton.addEventListener("click"'),
    );
    expect(loginHandler).toMatch(/catch \{\s+clearSession\(\);\s+showError\("Giri\\u015f/);
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
    expect(STAFF_APP_JS).toContain("workItemStatusRegion.textContent =");
  });

  it("loads the current user from /auth/v1/user and validates a UUID id, in memory only", () => {
    expect(STAFF_APP_JS).toContain('async function fetchCurrentUser() {\n  const res = await authedFetch("/auth/v1/user"');
    expect(STAFF_APP_JS).toContain("const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;");
    expect(STAFF_APP_JS).toContain("!UUID_PATTERN.test(data.id)");
    expect(STAFF_APP_JS).toContain("let currentUserId = null;");
    expect(STAFF_APP_JS).toContain("currentUserId = await fetchCurrentUser();");
    expect(STAFF_APP_JS).not.toMatch(/sessionStorage\.setItem\(SESSION_STORAGE_KEY, data\.id\)/);
    expect(STAFF_APP_JS).not.toMatch(/sessionStorage\.setItem\(SESSION_STORAGE_KEY, data\.email\)/);
  });

  it("labels ownership as Sahipsiz/Sizde/Başka personelde by comparing assigned_to to the current user, never a raw UUID", () => {
    expect(STAFF_APP_JS).toContain("function ownershipLabel(assignedTo) {");
    expect(STAFF_APP_JS).toContain('return "Sahipsiz";');
    expect(STAFF_APP_JS).toContain('return assignedTo === currentUserId ? "Sizde" : "Ba\\u015fka personelde";');
    expect(STAFF_APP_JS).toContain("ownershipLabel(item.assigned_to)");
    expect(STAFF_APP_JS).toContain("ownershipLabel(state.assigned_to)");
    expect(STAFF_APP_JS).not.toMatch(/textContent\s*=[^;]*\.assigned_to(?!\s*[=)])/);
  });

  it("polls the queue on one 30-second interval and prevents overlapping refresh requests", () => {
    expect(STAFF_APP_JS).toContain("const POLL_INTERVAL_MS = 30000;");
    expect(STAFF_APP_JS).toContain("pollIntervalId = setInterval(pollQueue, POLL_INTERVAL_MS);");
    expect(STAFF_APP_JS).toContain("function startPolling() {\n  if (pollIntervalId !== null) {\n    return;\n  }");
    expect(STAFF_APP_JS).toContain("if (queueLoadInFlight) {\n    return;\n  }\n  queueLoadInFlight = true;");
  });

  it("stops polling on logout/session failure and clears the baseline", () => {
    expect(STAFF_APP_JS).toContain("function stopPolling() {\n  if (pollIntervalId !== null) {\n    clearInterval(pollIntervalId);\n    pollIntervalId = null;\n  }\n  knownWorkItemIds = null;\n}");
    const clearSessionStart = STAFF_APP_JS.indexOf("function clearSession() {");
    const clearSessionBody = STAFF_APP_JS.slice(clearSessionStart, STAFF_APP_JS.indexOf("\nfunction ", clearSessionStart));
    expect(clearSessionBody).toContain("stopPolling();");
  });

  it("keeps manual refresh working and continues polling during detail view without replacing its DOM", () => {
    expect(STAFF_APP_JS).toContain("async function refreshQueue() {\n  await loadQueue(true);\n}");
    expect(STAFF_APP_JS).toContain("async function pollQueue() {\n  await loadQueue(false);\n}");
    expect(STAFF_APP_JS).toContain("if (!queueSection.hidden) {\n      renderQueue(items);\n    }");
  });

  it("establishes a no-alert baseline on first load, then alerts only for new IDs and retains the baseline after a failed refresh", () => {
    expect(STAFF_APP_JS).toContain("let knownWorkItemIds = null;");
    expect(STAFF_APP_JS).toContain("function computeNewItems(items) {");
    expect(STAFF_APP_JS).toContain(
      "const newItems = knownWorkItemIds === null ? [] : items.filter((item) => !knownWorkItemIds.has(item.id));",
    );
    expect(STAFF_APP_JS).toContain("knownWorkItemIds = currentIds;");
    // computeNewItems() (which reassigns the baseline) runs before the catch block that would leave it untouched on failure.
    const loadQueueBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function loadQueue(showLoadingStatus) {"),
      STAFF_APP_JS.indexOf("async function refreshQueue()"),
    );
    expect(loadQueueBody).toContain("const newItems = computeNewItems(items);");
    expect(loadQueueBody.indexOf("try {")).toBeLessThan(loadQueueBody.indexOf("computeNewItems(items)"));
  });

  it("requests Notification permission only from an explicit button click, never at load/login", () => {
    expect(STAFF_APP_JS).toContain('notifyButton.addEventListener("click", async () => {');
    const clickBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf('notifyButton.addEventListener("click", async () => {'),
    );
    expect(clickBody).toContain("Notification.requestPermission()");
    expect(STAFF_APP_JS.indexOf("Notification.requestPermission()")).toBe(clickBody.indexOf("Notification.requestPermission()") + STAFF_APP_JS.indexOf('notifyButton.addEventListener("click", async () => {'));
    const initBody = STAFF_APP_JS.slice(STAFF_APP_JS.indexOf("async function init() {"));
    expect(initBody).not.toContain("requestPermission");
    const loginBody = STAFF_APP_JS.slice(STAFF_APP_JS.indexOf('loginForm.addEventListener("submit"'));
    expect(loginBody.slice(0, loginBody.indexOf("refreshButton.addEventListener"))).not.toContain("requestPermission");
  });

  it("treats unsupported/denied/default notification permission as non-fatal with fixed Turkish status text", () => {
    expect(STAFF_APP_JS).toContain('typeof Notification === "undefined"');
    expect(STAFF_APP_JS).toContain("Bu taray\\u0131c\\u0131da bildirim desteklenmiyor.");
    expect(STAFF_APP_JS).toContain("Bildirim izni reddedildi.");
    expect(STAFF_APP_JS).toContain("Bildirim izni verilmedi.");
    expect(STAFF_APP_JS).toContain("Bildirimler a\\u00e7\\u0131k.");
  });

  it("emits a PII-free notification with only the fixed title and urgent/normal body", () => {
    expect(STAFF_APP_JS).toContain("function requestNotificationIfNeeded(newItems) {");
    expect(STAFF_APP_JS).toContain('new Notification("VetAI personel kuyru\\u011fu", {');
    expect(STAFF_APP_JS).toContain('body: hasUrgent ? "Yeni acil personel i\\u015fi var." : "Yeni personel i\\u015fi var.",');
    expect(STAFF_APP_JS).not.toMatch(/silent\s*:/);
    const notifyBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("function requestNotificationIfNeeded(newItems) {"),
      STAFF_APP_JS.indexOf("function requestNotificationIfNeeded(newItems) {") + 500,
    );
    expect(notifyBody).not.toMatch(/item\.id|item\.reason|item\.conversation_id|\.full_name|\.phone_e164/);
  });

  it("keeps a browser/OS notification failure from blocking the queue refresh", () => {
    const notifyBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("function requestNotificationIfNeeded(newItems) {"),
      STAFF_APP_JS.indexOf("async function loadConfig()"),
    );
    expect(notifyBody).toMatch(/try \{\s+new Notification\(/);
    expect(notifyBody).toMatch(
      /catch \{\s+\/\/ A browser\/OS notification failure must not block the queue refresh\.\s+\}/,
    );
  });

  it("never interpolates a work-item ID, name, phone, or reason into the notification", () => {
    expect(STAFF_APP_JS).not.toMatch(/Notification\([^)]*\+[^)]*item\./s);
  });
});

describe("handleStaffScript: WhatsApp otomasyonu (Task 033)", () => {
  it("keeps the strict-allowlist claim hidden until the account response validates", () => {
    expect(STAFF_HTML).toContain('id="automation-policy-region" hidden');
    expect(STAFF_HTML).toContain("Strict whitelist doğrulandı");
    expect(STAFF_HTML).toContain("Meta imzalı webhook'u VetAI'ye iletir.");
    expect(STAFF_APP_JS).toContain("automationPolicyRegion.hidden = true;");
    expect(STAFF_APP_JS).toContain("automationPolicyRegion.hidden = false;");
    expect(STAFF_APP_JS).toContain(
      "Strict whitelist do\\u011frulanamad\\u0131; numara ayarlar\\u0131 kapal\\u0131.",
    );
  });

  it("states the exact manual and personal retention boundaries in Turkish", () => {
    expect(STAFF_HTML).toContain(
      "Bu numaradan gelen mesajlar klinik için VetAI'de kaydedilir; VetAI otomatik yanıt vermez ve OpenAI çağırmaz.",
    );
    expect(STAFF_HTML).toContain(
      "Açık bir Kişisel kaydı seçerseniz yönlendirme için telefon numarası VetAI'de saklanır; listede olmayan numara için rota kaydı tutulmaz.",
    );
    expect(STAFF_HTML).toContain(
      "Bu numara için özel ayar silinir; gelecekteki mesajlar kişisel varsayılana döner.",
    );
    expect(STAFF_HTML).toContain(
      "Daha önce işlenmek üzere alınmış bir yanıtın süresi dolarsa kalan sınırlı denemeleri yapılabilir ve yanıt ulaşabilir",
    );
  });

  it("loads automation accounts and routes right after the queue on both login and resumed-session paths", () => {
    const loginBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf('loginForm.addEventListener("submit"'),
      STAFF_APP_JS.indexOf('loginForm.addEventListener("submit"') + 400,
    );
    expect(loginBody).toContain("await refreshQueue();\n    await loadAutomationAccounts();\n    startPolling();");

    const initBody = STAFF_APP_JS.slice(STAFF_APP_JS.indexOf("async function init() {"));
    expect(initBody).toContain("await refreshQueue();\n      await loadAutomationAccounts();\n      startPolling();");
  });

  it("posts a route change to set_whatsapp_contact_route and strictly validates a single-key result", () => {
    expect(STAFF_APP_JS).toContain('await authedFetch("/rest/v1/rpc/set_whatsapp_contact_route"');
    expect(STAFF_APP_JS).toContain(
      "body: JSON.stringify({ p_whatsapp_account_id: accountId, p_contact_e164: contactE164, p_mode: mode }),",
    );
    const submitBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function submitContactRoute(accountId, contactE164, mode) {"),
      STAFF_APP_JS.indexOf("accountSelect.addEventListener"),
    );
    expect(submitBody).toContain('!isExactRecord(rows[0], ["result"])');
    expect(submitBody).toContain('["updated", "unchanged", "not_found"].indexOf(rows[0].result) === -1');
  });

  it("strictly validates bounded account and route projections before rendering", () => {
    expect(STAFF_APP_JS).toContain("rows.length > 100");
    expect(STAFF_APP_JS).toContain('isExactRecord(row, ["id", "display_name", "automation_default"])');
    expect(STAFF_APP_JS).toContain('row.automation_default === "personal"');
    expect(STAFF_APP_JS).not.toContain('row.automation_default === "ai" || row.automation_default === "manual"');
    expect(STAFF_APP_JS).toContain('isExactRecord(row, ["contact_e164", "mode", "updated_at"])');
    expect(STAFF_APP_JS).toContain('row.mode === "ai" || row.mode === "manual" || row.mode === "personal"');
    expect(STAFF_APP_JS).toContain("Number.isFinite(Date.parse(row.updated_at))");
  });

  it("reads the submitted mode from event.submitter and rejects anything outside the closed ai/manual/personal/inherit set", () => {
    const formBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf('routeForm.addEventListener("submit"'),
      STAFF_APP_JS.indexOf('loginForm.addEventListener("submit"'),
    );
    expect(formBody).toContain("const mode = event.submitter && event.submitter.value;");
    expect(formBody).toContain('if (mode !== "ai" && mode !== "manual" && mode !== "personal" && mode !== "inherit") {\n    return;\n  }');
    expect(formBody).toContain("if (!selectedAccountId || !CONTACT_E164_PATTERN.test(contactE164)) {");
  });

  it("guards the route form against double submission while a request is in flight", () => {
    const formBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf('routeForm.addEventListener("submit"'),
      STAFF_APP_JS.indexOf('loginForm.addEventListener("submit"'),
    );
    expect(formBody).toContain("if (routeSubmitInFlight) {\n    return;\n  }");
    expect(formBody).toContain("routeSubmitInFlight = true;");
    expect(formBody).toContain("routeSubmitInFlight = false;");
  });

  it("clears the account and route lists on logout", () => {
    const clearSessionStart = STAFF_APP_JS.indexOf("function clearSession() {");
    const clearSessionBody = STAFF_APP_JS.slice(clearSessionStart, STAFF_APP_JS.indexOf("\nfunction ", clearSessionStart));
    expect(clearSessionBody).toContain("selectedAccountId = null;");
    expect(clearSessionBody).toContain('accountSelect.textContent = "";');
    expect(clearSessionBody).toContain('routeList.textContent = "";');
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
