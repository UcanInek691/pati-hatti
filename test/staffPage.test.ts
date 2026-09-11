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
    expect(csp).toBe("default-src 'none'; script-src 'self'; style-src 'sha256-YPvTUDSxjpMTosU17ou+TQQ+PibSHCUhQCJMsxMJLoY='; connect-src 'self' https://example.supabase.co; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
    expect(await res.text()).toBe(STAFF_HTML);
    expect(STAFF_HTML).toContain("<title>Pati Hattı Personel Paneli</title>");
    expect(STAFF_HTML).not.toContain("VetAI");
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
    expect(STAFF_APP_JS).toContain("function applyWorkItemState(state, preserveReplyDraft = false)");
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
    expect(STAFF_APP_JS).not.toMatch(/outbox(?!_id)/i);
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
    expect(STAFF_APP_JS).toContain('new Notification("Pati Hatt\\u0131 personel kuyru\\u011fu", {');
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
    expect(STAFF_HTML).toContain("Meta imzalı webhook'u Pati Hattı'na iletir.");
    expect(STAFF_APP_JS).toContain("automationPolicyRegion.hidden = true;");
    expect(STAFF_APP_JS).toContain("automationPolicyRegion.hidden = false;");
    expect(STAFF_APP_JS).toContain(
      "Strict whitelist do\\u011frulanamad\\u0131; numara ayarlar\\u0131 kapal\\u0131.",
    );
  });

  it("states the exact manual and personal retention boundaries in Turkish", () => {
    expect(STAFF_HTML).toContain(
      "Bu numaradan gelen mesajlar klinik için Pati Hattı'nda kaydedilir; Pati Hattı otomatik yanıt vermez ve OpenAI çağırmaz.",
    );
    expect(STAFF_HTML).toContain(
      "Açık bir Kişisel kaydı seçerseniz yönlendirme için telefon numarası Pati Hattı'nda saklanır; listede olmayan numara için rota kaydı tutulmaz.",
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
      STAFF_APP_JS.indexOf('loginForm.addEventListener("submit"') + 500,
    );
    expect(loginBody).toContain(
      "await refreshQueue();\n    await loadAutomationAccounts();\n    await loadClinicSchedule();\n    await loadAlertPreferences();\n    startPolling();",
    );

    const initBody = STAFF_APP_JS.slice(STAFF_APP_JS.indexOf("async function init() {"));
    expect(initBody).toContain(
      "await refreshQueue();\n      await loadAutomationAccounts();\n      await loadClinicSchedule();\n      await loadAlertPreferences();\n      startPolling();",
    );
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

describe("handleStaffScript: Klinik takvimi (Task 044)", () => {
  it("renders the schedule section with weekday, closure and slot controls, hidden until login", () => {
    expect(STAFF_HTML).toContain('<section id="schedule-section" aria-labelledby="schedule-heading" hidden>');
    expect(STAFF_HTML).toContain('<select id="clinic-select"></select>');
    expect(STAFF_HTML).toContain('<p id="schedule-readonly-notice" hidden>');
    expect(STAFF_HTML).toContain(
      '<input type="date" id="closure-date-input" data-schedule-mutation-control required>',
    );
    expect(STAFF_HTML).toContain(
      '<input type="date" id="generate-date-input" data-schedule-mutation-control required>',
    );
    expect(STAFF_HTML).toContain('<tbody id="weekly-hours-body"></tbody>');
    expect(STAFF_HTML).toContain('<ul id="closure-list"></ul>');
    expect(STAFF_HTML).toContain('<ul id="slot-list"></ul>');
  });

  it("shows the schedule section only when Takvim is the active destination, and hides it on login/detail", () => {
    const renderActiveBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("function renderActiveDestination() {"),
      STAFF_APP_JS.indexOf("function selectDestination("),
    );
    expect(STAFF_APP_JS).toContain('["schedule", scheduleSection, navTabSchedule]');
    expect(renderActiveBody).toContain("section.hidden = key !== activeDestination;");
    const showLoginBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("function showLoginView() {"),
      STAFF_APP_JS.indexOf("function showQueueView() {"),
    );
    expect(showLoginBody).toContain("scheduleSection.hidden = true;");
    expect(renderActiveBody).toContain("section.hidden = key !== activeDestination;");
    expect(renderActiveBody).toContain('activeDestination === "queue" && queueSubview === "detail"');
  });

  it("loads clinic memberships scoped to the current user only, validating exact shape, canonical UUIDs, closed role/status enums, bounded size and uniqueness", () => {
    expect(STAFF_APP_JS).toContain("async function fetchClinicMemberships() {");
    const body = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function fetchClinicMemberships() {"),
      STAFF_APP_JS.indexOf("function renderClinicSelect("),
    );
    expect(body).toContain('"/rest/v1/clinic_staff?user_id=eq." +\n      encodeURIComponent(currentUserId) +');
    expect(body).toContain('isExactRecord(row, ["clinic_id", "role", "clinics"])');
    expect(body).toContain("UUID_PATTERN.test(row.clinic_id)");
    expect(body).toContain("CLINIC_ROLES.indexOf(row.role) === -1");
    expect(body).toContain('isExactRecord(row.clinics, ["name", "operational_status"])');
    expect(body).toContain("CLINIC_STATUSES.indexOf(row.clinics.operational_status) === -1");
    expect(body).toContain("rows.length > 50");
    expect(body).toContain("seen.has(row.clinic_id)");
    expect(STAFF_APP_JS).toContain('const CLINIC_ROLES = ["admin", "veterinarian", "receptionist"];');
    expect(STAFF_APP_JS).toContain('const CLINIC_STATUSES = ["active", "suspended", "offboarding"];');
  });

  it("selects a clinic from the dropdown, never from a WhatsApp account, and reloads that clinic's schedule on change", () => {
    expect(STAFF_APP_JS).toContain(
      'clinicSelect.addEventListener("change", () => {\n  selectedClinicId = clinicSelect.value || null;\n  scheduleStatusRegion.textContent = "";\n  loadScheduleForSelectedClinic();\n});',
    );
    expect(STAFF_APP_JS).not.toMatch(/selectedClinicId\s*=\s*selectedAccountId/);
    expect(STAFF_APP_JS).not.toMatch(/selectedAccountId\s*=\s*selectedClinicId/);
  });

  it("reads weekly hours, closure dates and slots strictly scoped to the selected clinic, and slots only through the RPC", () => {
    expect(STAFF_APP_JS).toContain('"/rest/v1/clinic_weekly_hours?clinic_id=eq." +');
    expect(STAFF_APP_JS).toContain('"&select=iso_weekday,opens_at,closes_at&order=iso_weekday.asc&limit=7"');
    expect(STAFF_APP_JS).toContain('"/rest/v1/clinic_closure_dates?clinic_id=eq." +');
    expect(STAFF_APP_JS).toContain('"&select=closed_on&order=closed_on.asc&limit=200"');
    expect(STAFF_APP_JS).toContain('await authedFetch("/rest/v1/rpc/list_clinic_appointment_slots_v1"');
    expect(STAFF_APP_JS).not.toMatch(/\/rest\/v1\/appointment_slots/);
  });

  it("strictly validates unique half-hour weekly rows and real, unique closure dates", () => {
    const hoursBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function fetchWeeklyHours("),
      STAFF_APP_JS.indexOf("function renderWeeklyHours("),
    );
    expect(hoursBody).toContain('isExactRecord(row, ["iso_weekday", "opens_at", "closes_at"])');
    expect(hoursBody).toContain('/^([01]\\d|2[0-3]):(00|30):00$/.test(row.opens_at)');
    expect(hoursBody).toContain('/^([01]\\d|2[0-3]):(00|30):00$/.test(row.closes_at)');
    expect(hoursBody).toContain("row.opens_at < row.closes_at");
    expect(hoursBody).toContain("!seen.has(row.iso_weekday)");

    const closureBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function fetchClosureDates("),
      STAFF_APP_JS.indexOf("function renderClosures("),
    );
    expect(closureBody).toContain("isValidIsoDate(row.closed_on)");
    expect(closureBody).toContain("!seen.has(row.closed_on)");
    expect(STAFF_APP_JS).toContain('new Date(value + "T00:00:00Z")');
    expect(STAFF_APP_JS).toContain("date.toISOString().slice(0, 10) === value");
  });

  it("rejects malformed, negative or incoherent mutation counts before rendering them", () => {
    const body = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function callScheduleMutationRpc("),
      STAFF_APP_JS.indexOf("function reportPreservedActiveSlots("),
    );
    expect(body).toContain('if (expectedKeys.includes("removed_slots")) {');
    expect(body).toContain("Number.isInteger(row.removed_slots)");
    expect(body).toContain("row.removed_slots >= 0");
    expect(body).toContain("Number.isInteger(row.preserved_active_slots)");
    expect(body).toContain('if (expectedKeys.includes("candidate_count")) {');
    expect(body).toContain("row.candidate_count <= 48");
    expect(body).toContain("row.created_count + row.existing_count === row.candidate_count");
    expect(body).toContain('(row.result === "generated") !== (row.created_count > 0)');
  });

  it("strictly validates the slot projection: exact keys, unique canonical UUIDs, timestamps, duration, count and closed status", () => {
    const body = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function fetchClinicSlots("),
      STAFF_APP_JS.indexOf("function renderSlots("),
    );
    expect(body).toContain('isExactRecord(row, ["slot_id", "starts_at", "ends_at", "status"])');
    expect(body).toContain("UUID_PATTERN.test(row.slot_id)");
    expect(body).toContain("ISO_TIMESTAMP_PATTERN.test(row.starts_at)");
    expect(body).toContain("ISO_TIMESTAMP_PATTERN.test(row.ends_at)");
    expect(body).toContain("Number.isFinite(startsAt)");
    expect(body).toContain("Number.isFinite(endsAt)");
    expect(body).toContain("endsAt - startsAt === 30 * 60 * 1000");
    expect(body).toContain("!seen.has(row.slot_id)");
    expect(body).toContain("rows.length > 700");
    expect(body).toContain('(row.status === "available" || row.status === "held" || row.status === "confirmed")');
  });

  it("renders slot start/end times with an explicit Europe/Istanbul time zone, independent of browser locale", () => {
    const body = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("function renderSlots("),
      STAFF_APP_JS.indexOf("async function submitGenerateSlots("),
    );
    expect(body).toContain('new Date(row.starts_at).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })');
    expect(body).toContain('new Date(row.ends_at).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })');
  });

  it("only offers a delete control for future available slots, never for held or confirmed rows", () => {
    const body = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("function renderSlots("),
      STAFF_APP_JS.indexOf("async function submitGenerateSlots("),
    );
    expect(body).toContain('if (canMutate && row.status === "available") {');
    expect(body).not.toMatch(/status === "held"[\s\S]{0,80}deleteButton/);
    expect(body).not.toMatch(/status === "confirmed"[\s\S]{0,80}deleteButton/);
  });

  it("disables every weekly-hours control and hides all mutation surfaces unless the caller is an active-clinic admin", () => {
    const body = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("function renderWeeklyHours("),
      STAFF_APP_JS.indexOf("async function submitWeeklyHours("),
    );
    expect(body).toContain("enabledInput.disabled = !canMutate || scheduleMutationInFlight;");
    expect(body).toContain("opensInput.disabled = !canMutate || scheduleMutationInFlight;");
    expect(body).toContain("closesInput.disabled = !canMutate || scheduleMutationInFlight;");
    expect(body).toContain("if (canMutate) {");
    expect(STAFF_APP_JS).toContain(
      'const canMutate = !!clinic && clinic.role === "admin" && clinic.operationalStatus === "active";',
    );
    expect(STAFF_APP_JS).toContain("closureForm.hidden = !canMutate;");
    expect(STAFF_APP_JS).toContain("generateForm.hidden = !canMutate;");
    expect(STAFF_HTML).toContain(
      'id="schedule-readonly-notice" hidden>Bu ayarları yalnızca klinik yöneticisi değiştirebilir.',
    );
  });

  it("calls set_clinic_weekly_hours_v1 with the exact body shape and closed result handling", () => {
    const body = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function submitWeeklyHours("),
      STAFF_APP_JS.indexOf("async function fetchClosureDates("),
    );
    expect(body).toContain('"set_clinic_weekly_hours_v1",');
    expect(body).toContain("p_clinic_id: selectedClinicId,");
    expect(body).toContain("p_iso_weekday: isoWeekday,");
    expect(body).toContain("p_enabled: enabled,");
    expect(body).toContain("p_opens_at: opensAt,");
    expect(body).toContain("p_closes_at: closesAt,");
    expect(body).toContain('["result", "removed_slots", "preserved_active_slots"],');
    expect(body).toContain('["updated", "removed", "unchanged", "not_found", "forbidden", "inactive"]');
  });

  it("validates half-hour alignment and opens<closes locally before ever calling set_clinic_weekly_hours_v1", () => {
    const body = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function submitWeeklyHours("),
      STAFF_APP_JS.indexOf("async function fetchClosureDates("),
    );
    const validationIndex = body.indexOf("isHalfHourAligned(opensValue)");
    const rpcIndex = body.indexOf("callScheduleMutationRpc(");
    expect(validationIndex).toBeGreaterThan(-1);
    expect(rpcIndex).toBeGreaterThan(-1);
    expect(validationIndex).toBeLessThan(rpcIndex);
    expect(body).toContain("if (opensValue >= closesValue) {");
    expect(STAFF_APP_JS).toContain('function isHalfHourAligned(timeValue) {\n  return /^([01]\\d|2[0-3]):(00|30)$/.test(timeValue);\n}');
  });

  it("calls set_clinic_closure_date_v1 and generate_clinic_appointment_slots_v1 with exact bodies, validating the date bound locally first", () => {
    const closureBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function submitClosureDate("),
      STAFF_APP_JS.indexOf("async function fetchClinicSlots("),
    );
    expect(closureBody).toContain('"set_clinic_closure_date_v1",');
    expect(closureBody).toContain("{ p_clinic_id: selectedClinicId, p_closed_on: closedOn, p_closed: closed },");
    expect(
      closureBody.indexOf("!isValidIsoDate(closedOn) || closedOn < today || closedOn > addDaysIso(today, 366)"),
    ).toBeLessThan(
      closureBody.indexOf("callScheduleMutationRpc("),
    );

    const generateBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function submitGenerateSlots("),
      STAFF_APP_JS.indexOf("async function submitDeleteSlot("),
    );
    expect(generateBody).toContain('"generate_clinic_appointment_slots_v1",');
    expect(generateBody).toContain("{ p_clinic_id: selectedClinicId, p_local_date: localDate },");
    expect(generateBody).toContain(
      '["result", "candidate_count", "created_count", "existing_count"],',
    );
    expect(
      generateBody.indexOf("!isValidIsoDate(localDate) || localDate < today || localDate > addDaysIso(today, 366)"),
    ).toBeLessThan(
      generateBody.indexOf("callScheduleMutationRpc("),
    );
  });

  it("calls delete_clinic_appointment_slot_v1 with the exact body and closed result set", () => {
    const body = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function submitDeleteSlot("),
      STAFF_APP_JS.indexOf("async function loadScheduleForSelectedClinic("),
    );
    expect(body).toContain('"delete_clinic_appointment_slot_v1",');
    expect(body).toContain("{ p_clinic_id: selectedClinicId, p_slot_id: slotId },");
    expect(body).toContain('["deleted", "not_found", "in_use", "past", "forbidden", "inactive"]');
  });

  it("routes every schedule mutation through authedFetch, so it always carries the apikey/Authorization headers", () => {
    const body = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function callScheduleMutationRpc("),
      STAFF_APP_JS.indexOf("function reportPreservedActiveSlots("),
    );
    expect(body).toContain('const res = await authedFetch("/rest/v1/rpc/" + rpcName, {');
  });

  it("guards every schedule mutation with the shared in-flight flag and clears it in a finally block", () => {
    for (const fn of ["submitWeeklyHours", "submitClosureDate", "submitGenerateSlots", "submitDeleteSlot"]) {
      const body = STAFF_APP_JS.slice(STAFF_APP_JS.indexOf(`async function ${fn}(`));
      const fnBody = body.slice(0, body.indexOf("\nasync function ", 1));
      expect(fnBody).toContain("if (scheduleMutationInFlight) {\n    return;\n  }");
      expect(fnBody).toContain("setScheduleMutationInFlight(true);");
      expect(fnBody).toContain("setScheduleMutationInFlight(false);");
    }
    expect(STAFF_APP_JS).toContain(
      'for (const control of scheduleSection.querySelectorAll("[data-schedule-mutation-control]")) {',
    );
    expect(STAFF_APP_JS).toContain("control.disabled = disabled;");
  });

  it("refreshes authoritative schedule state after every mutation and clears stale data on fetch/parse failure", () => {
    for (const fn of ["submitWeeklyHours", "submitClosureDate", "submitGenerateSlots", "submitDeleteSlot"]) {
      const body = STAFF_APP_JS.slice(STAFF_APP_JS.indexOf(`async function ${fn}(`));
      const fnBody = body.slice(0, body.indexOf("\nasync function ", 1));
      expect(fnBody).toContain("await loadScheduleForSelectedClinic();");
    }
    const loadBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function loadScheduleForSelectedClinic("),
      STAFF_APP_JS.indexOf("async function loadClinicSchedule("),
    );
    expect(loadBody).toContain(
      'weeklyHoursBody.textContent = "";\n    closureList.textContent = "";\n    slotList.textContent = "";\n    scheduleErrorRegion.textContent = "Takvim y\\u00fcklenemedi.";',
    );
    expect(loadBody).toContain("const requestedClinicId = selectedClinicId;");
    expect(loadBody).toContain("if (selectedClinicId !== requestedClinicId) {");
  });

  it("shows a truthful preserved-active-slot warning that never claims cancellation or owner contact", () => {
    expect(STAFF_APP_JS).toContain("function reportPreservedActiveSlots(preservedActiveSlots) {");
    const body = STAFF_APP_JS.slice(STAFF_APP_JS.indexOf("function reportPreservedActiveSlots("));
    const fnBody = body.slice(0, body.indexOf("\nasync function "));
    expect(fnBody).toContain("iptal edilmedi ve sahibine bildirim g\\u00f6nderilmedi.");
    expect(STAFF_APP_JS).not.toMatch(/iptal edildi/);
    expect(STAFF_APP_JS).not.toMatch(/bildirim g\\u00f6nderildi/);
  });

  it("reports removed available slots even when the schedule row itself was unchanged", () => {
    expect(STAFF_APP_JS).toContain("function reportRemovedAvailableSlots(removedSlots) {");
    expect(STAFF_APP_JS).toContain("bo\\u015f randevu saati kald\\u0131r\\u0131ld\\u0131.");

    const weeklyBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function submitWeeklyHours("),
      STAFF_APP_JS.indexOf("async function fetchClosureDates("),
    );
    expect(weeklyBody).toContain("reportRemovedAvailableSlots(row.removed_slots);");
    expect(weeklyBody).toContain("Saat ayar\\u0131 de\\u011fi\\u015fmedi.");

    const closureBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function submitClosureDate("),
      STAFF_APP_JS.indexOf("async function fetchClinicSlots("),
    );
    expect(closureBody).toContain("reportRemovedAvailableSlots(row.removed_slots);");
    expect(closureBody).toContain("Kapan\\u0131\\u015f kayd\\u0131 zaten vard\\u0131.");
  });

  it("clears every clinic/schedule field and hides the readonly notice on logout", () => {
    const clearSessionStart = STAFF_APP_JS.indexOf("function clearSession() {");
    const clearSessionBody = STAFF_APP_JS.slice(clearSessionStart, STAFF_APP_JS.indexOf("\nfunction ", clearSessionStart));
    expect(clearSessionBody).toContain("clinics = [];");
    expect(clearSessionBody).toContain("selectedClinicId = null;");
    expect(clearSessionBody).toContain('clinicSelect.textContent = "";');
    expect(clearSessionBody).toContain('weeklyHoursBody.textContent = "";');
    expect(clearSessionBody).toContain('closureList.textContent = "";');
    expect(clearSessionBody).toContain('slotList.textContent = "";');
    expect(clearSessionBody).toContain("scheduleReadonlyNotice.hidden = true;");
  });

  it("routes every dynamic schedule value to the DOM only through textContent, never innerHTML", () => {
    expect(STAFF_APP_JS).toContain("dayTd.textContent = WEEKDAY_LABELS[weekday];");
    expect(STAFF_APP_JS).toContain("span.textContent = row.closed_on;");
    expect(STAFF_APP_JS).not.toMatch(/schedule\w*\.innerHTML/);
  });
});

describe("handleStaffScript: Klinik uyari tercihleri (Task 056)", () => {
  it("renders the alert-prefs section hidden until login, reachable via the E-posta uyarıları destination, hidden on detail view", () => {
    expect(STAFF_HTML).toContain('<section id="alert-prefs-section" aria-labelledby="alert-prefs-heading" hidden>');
    const showLoginBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("function showLoginView() {"),
      STAFF_APP_JS.indexOf("function showQueueView() {"),
    );
    const renderActiveBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("function renderActiveDestination() {"),
      STAFF_APP_JS.indexOf("function selectDestination("),
    );
    expect(showLoginBody).toContain("alertPrefsSection.hidden = true;");
    expect(STAFF_APP_JS).toContain('["alerts", alertPrefsSection, navTabAlerts]');
    expect(renderActiveBody).toContain("section.hidden = key !== activeDestination;");
    expect(renderActiveBody).toContain('activeDestination === "queue" && queueSubview === "detail"');
  });

  it("loads alert preferences via get_my_clinic_alert_preferences with an empty body and strictly validates the closed 5-key row shape", () => {
    expect(STAFF_APP_JS).toContain('"/rest/v1/rpc/get_my_clinic_alert_preferences"');
    const fetchBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function fetchMyClinicAlertPreferences() {"),
      STAFF_APP_JS.indexOf("async function callAlertPreferenceRpc("),
    );
    expect(fetchBody).toContain("body: JSON.stringify({})");
    expect(fetchBody).toContain(
      '"clinic_id",\n          "clinic_name",\n          "clinic_gate_enabled",\n          "my_preference_enabled",\n          "effective_enabled",',
    );
    expect(fetchBody).toContain("rows.length > 50");
    expect(fetchBody).toContain("UUID_PATTERN.test(row.clinic_id)");
    expect(fetchBody).toContain("row.effective_enabled === (row.clinic_gate_enabled && row.my_preference_enabled)");
    expect(fetchBody).toContain("seenClinicIds.has(row.clinic_id)");
  });

  it("submits a preference change with exactly clinic_id and enabled, never a target user, e-mail, or actor from the browser", () => {
    const rpcBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function callAlertPreferenceRpc("),
      STAFF_APP_JS.indexOf("function renderAlertPreferences("),
    );
    expect(rpcBody).toContain('"/rest/v1/rpc/set_my_clinic_alert_preference"');
    expect(rpcBody).toContain("body: JSON.stringify({ p_clinic_id: clinicId, p_enabled: enabled })");
    expect(rpcBody).toContain('!isExactRecord(rows[0], ["result"])');
    expect(rpcBody).not.toMatch(/p_email|p_actor|p_user|p_reason/);
  });

  it("strictly validates the alert preference RPC result against the closed 6-result set", () => {
    expect(STAFF_APP_JS).toContain(
      'const ALERT_PREF_RESULTS = ["forbidden", "already_disabled", "email_unconfirmed", "already_enabled", "enabled", "disabled"];',
    );
    expect(STAFF_APP_JS).toContain("ALERT_PREF_RESULTS.indexOf(rows[0].result) === -1");
  });

  it("guards a preference toggle against overlap with the shared alertPrefsMutationInFlight flag and always reloads true state in a finally block", () => {
    const submitBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function submitAlertPreference("),
      STAFF_APP_JS.length,
    );
    expect(submitBody).toContain("if (alertPrefsMutationInFlight) {\n    checkbox.checked = !enabled;\n    return;\n  }");
    expect(submitBody).toContain("alertPrefsMutationInFlight = true;");
    expect(submitBody).toContain("} finally {\n    alertPrefsMutationInFlight = false;\n    await loadAlertPreferences();\n  }");
  });

  it("behaviorally executes success, idempotent, forbidden, and rejected preference handlers and reloads authoritative state", async () => {
    const source = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function submitAlertPreference("),
      STAFF_APP_JS.indexOf('\n\naccountSelect.addEventListener("change"'),
    );
    const makeHarness = new Function(
      "callAlertPreferenceRpc",
      `"use strict";
       let alertPrefsMutationInFlight = false;
       const alertPrefsErrorRegion = { textContent: "" };
       const alertPrefsStatusRegion = { textContent: "" };
       let reloads = 0;
       const loadAlertPreferences = async () => { reloads += 1; };
       ${source}
       return { submitAlertPreference, alertPrefsErrorRegion, alertPrefsStatusRegion, getReloads: () => reloads };`,
    ) as (rpc: (clinicId: string, enabled: boolean) => Promise<string>) => {
      submitAlertPreference: (clinicId: string, enabled: boolean, checkbox: { checked: boolean; disabled: boolean }) => Promise<void>;
      alertPrefsErrorRegion: { textContent: string };
      alertPrefsStatusRegion: { textContent: string };
      getReloads: () => number;
    };

    for (const [result, expectedRegion] of [
      ["enabled", "status"],
      ["already_enabled", "status"],
      ["forbidden", "error"],
    ] as const) {
      const harness = makeHarness(async () => result);
      const checkbox = { checked: true, disabled: false };
      await harness.submitAlertPreference("56000000-0000-0000-1000-000000000001", true, checkbox);
      expect(harness.getReloads()).toBe(1);
      expect(expectedRegion === "status" ? harness.alertPrefsStatusRegion.textContent : harness.alertPrefsErrorRegion.textContent).not.toBe("");
    }

    const rejected = makeHarness(async () => { throw new Error("malformed or expired session"); });
    await rejected.submitAlertPreference(
      "56000000-0000-0000-1000-000000000001",
      true,
      { checked: true, disabled: false },
    );
    expect(rejected.alertPrefsErrorRegion.textContent).not.toBe("");
    expect(rejected.getReloads()).toBe(1);
  });

  it("shows fixed Turkish copy for every closed result without leaking internals, distinguishing forbidden and email_unconfirmed as errors", () => {
    const submitBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function submitAlertPreference("),
      STAFF_APP_JS.length,
    );
    expect(submitBody).toContain('result === "forbidden"');
    expect(submitBody).toContain('result === "email_unconfirmed"');
    expect(submitBody).not.toMatch(/error\.message|err\.message/);
  });

  it("clears alert-prefs body, status and error regions on logout", () => {
    const clearSessionStart = STAFF_APP_JS.indexOf("function clearSession() {");
    const clearSessionBody = STAFF_APP_JS.slice(clearSessionStart, STAFF_APP_JS.indexOf("\nfunction ", clearSessionStart));
    expect(clearSessionBody).toContain('alertPrefsBody.textContent = "";');
    expect(clearSessionBody).toContain('alertPrefsStatusRegion.textContent = "";');
    expect(clearSessionBody).toContain('alertPrefsErrorRegion.textContent = "";');
  });

  it("routes every dynamic alert-prefs value to the DOM only through textContent, never innerHTML", () => {
    expect(STAFF_APP_JS).toContain("nameTd.textContent = row.clinic_name;");
    expect(STAFF_APP_JS).toContain('prefInput.setAttribute("aria-label", row.clinic_name + " e-posta uyarı tercihim");');
    expect(STAFF_APP_JS).not.toMatch(/alertPrefs\w*\.innerHTML/);
  });

  it("states that an already-started provider send cannot be recalled", () => {
    expect(STAFF_HTML).toContain("Kapatmadan önce gönderimi başlamış bir e-posta geri çağrılamaz ve yine de ulaşabilir.");
  });

  it("loads alert preferences right after login and on the resumed-session path", () => {
    expect(STAFF_APP_JS).toContain("await loadClinicSchedule();\n    await loadAlertPreferences();\n    startPolling();");
    expect(STAFF_APP_JS).toContain("await loadClinicSchedule();\n      await loadAlertPreferences();\n      startPolling();");
  });
});

describe("handleStaffScript: Personel yanit kompozeri (Task 048)", () => {
  it("renders a reply composer inside detail-section, hidden until the item is eligible", () => {
    expect(STAFF_HTML).toContain('<div id="reply-composer" hidden>');
    expect(STAFF_HTML).toContain('id="reply-send-button" disabled>Yanıtı kuyruğa al</button>');
    for (const id of [
      "reply-content-input",
      "reply-char-count",
      "reply-send-button",
      "reply-status-region",
      "reply-error-region",
    ]) {
      expect(STAFF_HTML).toContain(`id="${id}"`);
    }
  });

  it("binds every composer element and defines closed enums for its constants", () => {
    for (const decl of [
      'const replyComposer = document.getElementById("reply-composer");',
      'const replyContentInput = document.getElementById("reply-content-input");',
      'const replyCharCount = document.getElementById("reply-char-count");',
      'const replySendButton = document.getElementById("reply-send-button");',
      'const replyStatusRegion = document.getElementById("reply-status-region");',
      'const replyErrorRegion = document.getElementById("reply-error-region");',
    ]) {
      expect(STAFF_APP_JS).toContain(decl);
    }
    expect(STAFF_APP_JS).toContain("const REPLY_MAX_LENGTH = 4096;");
    expect(STAFF_APP_JS).toContain("const INBOUND_MESSAGE_MAX_LENGTH = 65536;");
    expect(STAFF_APP_JS).toContain("const REPLY_RPC_TIMEOUT_MS = 10000;");
    expect(STAFF_APP_JS).toContain(
      'const REPLY_RESULTS = ["queued", "already_queued", "not_found", "not_allowed", "inactive", "window_closed"];',
    );
  });

  it("queues a staff reply via queue_staff_reply_v1 with exactly the three required parameters", () => {
    expect(STAFF_APP_JS).toContain("async function queueStaffReply(workItemId, requestId, content) {");
    expect(STAFF_APP_JS).toContain('"/rest/v1/rpc/queue_staff_reply_v1"');
    expect(STAFF_APP_JS).toContain(
      "body: JSON.stringify({ p_work_item_id: workItemId, p_request_id: requestId, p_content: content }),",
    );
  });

  it("never sends a phone, account, clinic, or actor identifier from the composer", () => {
    const body = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function queueStaffReply(workItemId, requestId, content) {"),
      STAFF_APP_JS.indexOf("async function refreshWorkItemState("),
    );
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/phone|account_id|clinic_id|actor/i);
  });

  it("strictly validates the RPC response as one row with exactly three closed-enum-checked fields", () => {
    const body = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function queueStaffReply(workItemId, requestId, content) {"),
      STAFF_APP_JS.indexOf("async function refreshWorkItemState("),
    );
    expect(body).toContain("return validateReplyResult(rows[0]);");
    const validator = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("function validateReplyResult(value) {"),
      STAFF_APP_JS.indexOf("function newReplyRequestId() {"),
    );
    expect(validator).toContain('isExactRecord(value, ["result", "outbox_id", "window_expires_at"])');
    expect(validator).toContain("REPLY_RESULTS.indexOf(value.result) === -1");
    expect(validator).toContain("UUID_PATTERN.test(value.outbox_id)");
    expect(validator).toContain("ISO_TIMESTAMP_PATTERN.test(value.window_expires_at)");
    expect(validator).toContain("Number.isFinite(Date.parse(value.window_expires_at))");
    expect(validator).toContain("!successful && (value.outbox_id !== null || value.window_expires_at !== null)");
  });

  it("bounds the reply RPC with a 10-second AbortController timeout", () => {
    const body = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function queueStaffReply(workItemId, requestId, content) {"),
      STAFF_APP_JS.indexOf("async function refreshWorkItemState("),
    );
    expect(body).toContain("const controller = new AbortController();");
    expect(body).toContain("setTimeout(() => controller.abort(), REPLY_RPC_TIMEOUT_MS);");
    expect(body).toContain("signal: controller.signal,");
    expect(body).toContain("clearTimeout(timeoutId);");
  });

  it("shows the composer only for an in-progress human_handoff item assigned to the caller", () => {
    expect(STAFF_APP_JS).toContain(
      'composerEligible =\n    state.kind === "human_handoff" && state.status === "in_progress" && state.assigned_to === currentUserId;',
    );
    expect(STAFF_APP_JS).toContain("replyComposer.hidden = !composerEligible;");
    expect(STAFF_APP_JS).toContain("&select=status,assigned_to,kind,reason");
  });

  it("resets an ineligible reply draft unless an authoritative refresh explicitly preserves it", () => {
    const applyBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("function applyWorkItemState(state, preserveReplyDraft = false) {"),
      STAFF_APP_JS.indexOf("function newReplyRequestId() {"),
    );
    expect(applyBody).toContain(
      "if (!composerEligible && !preserveReplyDraft) {\n    resetReplyDraftState();\n  } else {\n    updateReplySendButtonState();\n  }",
    );

    const openDetailBody = STAFF_APP_JS.slice(STAFF_APP_JS.indexOf("async function openDetail(workItemId, conversationId) {"));
    const resetIndex = openDetailBody.indexOf("resetReplyDraftState();");
    const seenCallIndex = openDetailBody.indexOf('callWorkItemRpc("mark_staff_work_item_seen"');
    expect(resetIndex).toBeGreaterThan(-1);
    expect(resetIndex).toBeLessThan(seenCallIndex);

    const clearSessionStart = STAFF_APP_JS.indexOf("function clearSession() {");
    const clearSessionBody = STAFF_APP_JS.slice(clearSessionStart, STAFF_APP_JS.indexOf("\nfunction ", clearSessionStart));
    expect(clearSessionBody).toContain("composerEligible = false;");
    expect(clearSessionBody).toContain("replyComposer.hidden = true;");
    expect(clearSessionBody).toContain("resetReplyDraftState();");
  });

  it("keeps the same request ID for unedited content and mints a fresh one when the draft changes", () => {
    const body = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("function resolveReplyRequestId(content) {"),
      STAFF_APP_JS.indexOf("function resetReplyDraftState() {"),
    );
    expect(body).toContain(
      "if (currentReplyRequestId !== null && lastReplyRequestContent === content) {\n    return currentReplyRequestId;\n  }",
    );
    expect(body).toContain("currentReplyRequestId = requestId;");
    expect(body).toContain("lastReplyRequestContent = content;");
  });

  it("behaviorally keeps a request ID for the same draft and rotates it after an edit", () => {
    const source = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("function newReplyRequestId() {"),
      STAFF_APP_JS.indexOf("function resetReplyDraftState() {"),
    );
    const ids = [
      "48800000-0000-4000-8000-000000000001",
      "48800000-0000-4000-8000-000000000002",
    ];
    const makeHarness = new Function(
      "crypto",
      `"use strict";
       const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
       let currentReplyRequestId = null;
       let lastReplyRequestContent = null;
       ${source}
       return { resolveReplyRequestId };`,
    ) as (cryptoValue: { randomUUID: () => string }) => {
      resolveReplyRequestId: (content: string) => string | null;
    };
    const harness = makeHarness({ randomUUID: () => ids.shift() ?? "" });

    expect(harness.resolveReplyRequestId("aynı taslak")).toBe("48800000-0000-4000-8000-000000000001");
    expect(harness.resolveReplyRequestId("aynı taslak")).toBe("48800000-0000-4000-8000-000000000001");
    expect(harness.resolveReplyRequestId("düzenlenmiş taslak")).toBe("48800000-0000-4000-8000-000000000002");
  });

  it("fails closed without sending a request when crypto.randomUUID is unavailable", () => {
    expect(STAFF_APP_JS).toContain(
      'if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {\n    return null;\n  }',
    );
    expect(STAFF_APP_JS).toContain("requestId === requestId.toLowerCase()");
    const clickBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf('replySendButton.addEventListener("click"'),
      STAFF_APP_JS.indexOf("async function init() {"),
    );
    const requestIdNullCheck = clickBody.indexOf("if (requestId === null) {");
    const confirmIndex = clickBody.indexOf("window.confirm(");
    expect(requestIdNullCheck).toBeGreaterThan(-1);
    expect(requestIdNullCheck).toBeLessThan(confirmIndex);
  });

  it("requires a fixed Turkish confirmation naming WhatsApp delivery before queuing", () => {
    const clickBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf('replySendButton.addEventListener("click"'),
      STAFF_APP_JS.indexOf("async function init() {"),
    );
    expect(clickBody).toContain(
      'window.confirm(\n    "Bu mesaj m\\u00fc\\u015fteriye WhatsApp \\u00fczerinden g\\u00f6nderilmek \\u00fczere kuyru\\u011fa al\\u0131nacak. Kuyru\\u011fa al\\u0131nmas\\u0131 teslim edildi\\u011fi anlam\\u0131na gelmez. Devam etmek istedi\\u011finize emin misiniz?"\n  );',
    );
    expect(clickBody).toContain("if (!confirmed) {\n    return;\n  }");
    const confirmIndex = clickBody.indexOf("window.confirm(");
    const queueCallIndex = clickBody.indexOf("await queueStaffReply(");
    expect(confirmIndex).toBeGreaterThan(-1);
    expect(queueCallIndex).toBeGreaterThan(-1);
    expect(confirmIndex).toBeLessThan(queueCallIndex);
  });

  it("guards the send button against duplicate submission while a request is in flight", () => {
    const clickBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf('replySendButton.addEventListener("click"'),
      STAFF_APP_JS.indexOf("async function init() {"),
    );
    expect(clickBody).toContain("if (!currentWorkItemId || !composerEligible || replySubmitInFlight) {\n    return;\n  }");
    expect(clickBody).toContain("replySubmitInFlight = true;");
    expect(clickBody).toContain("replySubmitInFlight = false;");
    expect(clickBody).toContain("} finally {");
  });

  it("behaviorally ignores a second click while the first queue request is unresolved", async () => {
    const clickSource = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf('replySendButton.addEventListener("click"'),
      STAFF_APP_JS.indexOf("async function init() {"),
    );
    type ClickButton = {
      listener?: () => Promise<void>;
      addEventListener: (event: string, listener: () => Promise<void>) => void;
    };
    const button: ClickButton = {
      addEventListener(_event, listener) {
        this.listener = listener;
      },
    };
    let queueCalls = 0;
    let finishQueue: ((value: { result: string; outbox_id: string; window_expires_at: string }) => void) | undefined;
    const queueStaffReply = async () => {
      queueCalls += 1;
      return await new Promise<{ result: string; outbox_id: string; window_expires_at: string }>((resolve) => {
        finishQueue = resolve;
      });
    };
    const installHandler = new Function(
      "replySendButton",
      "queueStaffReply",
      `"use strict";
       const currentWorkItemId = "48800000-0000-4000-8000-000000000201";
       const composerEligible = true;
       let replySubmitInFlight = false;
       const replyContentInput = { value: "Merhaba" };
       const replyErrorRegion = { textContent: "" };
       const replyStatusRegion = { textContent: "" };
       const REPLY_MAX_LENGTH = 4096;
       const REPLY_RESULT_MESSAGES = {};
       const replyCodePointLength = (value) => Array.from(value).length;
       const resolveReplyRequestId = () => "48800000-0000-4000-8000-000000000401";
       const window = { confirm: () => true };
       const updateReplySendButtonState = () => {};
       const resetReplyDraftState = () => {};
       const refreshWorkItemState = async () => {};
       const sessionStorage = { getItem: () => "token" };
       const showError = () => {};
       ${clickSource}`,
    ) as (replyButton: ClickButton, queueCall: typeof queueStaffReply) => void;
    installHandler(button, queueStaffReply);

    const first = button.listener!();
    const second = button.listener!();
    expect(queueCalls).toBe(1);
    finishQueue!({
      result: "queued",
      outbox_id: "48800000-0000-4000-8000-000000000501",
      window_expires_at: "2026-09-04T12:00:00Z",
    });
    await Promise.all([first, second]);
    expect(queueCalls).toBe(1);
  });

  it("shows fixed truthful Turkish copy for every closed reply result without leaking internals", () => {
    expect(STAFF_APP_JS).toContain(
      'const REPLY_RESULT_MESSAGES = {\n  not_found: "\\u0130\\u015f bulunamad\\u0131.",\n  not_allowed: "Bu yan\\u0131t\\u0131 \\u015fu anda g\\u00f6nderemezsiniz.",\n  inactive: "Klinik \\u015fu anda aktif de\\u011fil.",\n  window_closed: "24 saatlik m\\u00fc\\u015fteri yan\\u0131t penceresi kapand\\u0131.",\n};',
    );
    const clickBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf('replySendButton.addEventListener("click"'),
      STAFF_APP_JS.indexOf("async function init() {"),
    );
    expect(clickBody).toContain(
      'replyErrorRegion.textContent = REPLY_RESULT_MESSAGES[outcome.result] || "Yan\\u0131t g\\u00f6nderilemedi.";',
    );
    expect(clickBody).toContain(
      'outcome.result === "queued"\n          ? "Yan\\u0131t g\\u00f6nderim kuyru\\u011funa eklendi."\n          : "Bu yan\\u0131t zaten kuyru\\u011fa eklenmi\\u015fti.";',
    );
  });

  it("refreshes work-item state after not_found/not_allowed/inactive but not after window_closed", () => {
    const clickBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf('replySendButton.addEventListener("click"'),
      STAFF_APP_JS.indexOf("async function init() {"),
    );
    expect(clickBody).toContain(
      'if (outcome.result === "not_found" || outcome.result === "not_allowed" || outcome.result === "inactive") {\n      await refreshWorkItemState(outcome.result === "not_allowed");\n    }',
    );
  });

  it("preserves typed text when a not_allowed refresh makes the composer ineligible", () => {
    expect(STAFF_APP_JS).toContain("async function refreshWorkItemState(preserveReplyDraft = false) {");
    expect(STAFF_APP_JS).toContain(
      "applyWorkItemState(await fetchWorkItemState(currentWorkItemId), preserveReplyDraft);",
    );
  });

  it("distinguishes a timeout abort from other send failures with distinct Turkish copy", () => {
    const clickBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf('replySendButton.addEventListener("click"'),
      STAFF_APP_JS.indexOf("async function init() {"),
    );
    expect(clickBody).toContain('err && err.name === "AbortError"');
    expect(clickBody).toContain(
      "Yan\\u0131t kuyru\\u011fa al\\u0131n\\u0131rken zaman a\\u015f\\u0131m\\u0131 oldu. Ayn\\u0131 taslakla tekrar deneyin.",
    );
    expect(clickBody).toContain("Oturumunuz sona erdi. L\\u00fctfen yeniden giri\\u015f yap\\u0131n.");
  });

  it("behaviorally aborts the reply RPC at exactly 10 seconds and clears its timer", async () => {
    const source = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function queueStaffReply(workItemId, requestId, content) {"),
      STAFF_APP_JS.indexOf("async function refreshWorkItemState("),
    );
    let observedDelay = 0;
    let clearedTimer: unknown;
    let observedSignal: AbortSignal | undefined;
    const makeQueue = new Function(
      "authedFetch",
      "setTimeout",
      "clearTimeout",
      `"use strict";
       const REPLY_RPC_TIMEOUT_MS = 10000;
       ${source}
       return queueStaffReply;`,
    ) as (
      fetchValue: (path: string, init: RequestInit) => Promise<Response>,
      timeoutValue: (callback: () => void, delay: number) => unknown,
      clearValue: (timer: unknown) => void,
    ) => (workItemId: string, requestId: string, content: string) => Promise<unknown>;
    const queue = makeQueue(
      async (_path, init) => {
        observedSignal = init.signal as AbortSignal;
        if (observedSignal.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        throw new Error("expected the immediate test timeout to abort first");
      },
      (callback, delay) => {
        observedDelay = delay;
        callback();
        return "timer-048";
      },
      (timer) => {
        clearedTimer = timer;
      },
    );

    await expect(
      queue(
        "48800000-0000-4000-8000-000000000201",
        "48800000-0000-4000-8000-000000000401",
        "Merhaba",
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(observedDelay).toBe(10_000);
    expect(observedSignal?.aborted).toBe(true);
    expect(clearedTimer).toBe("timer-048");
  });

  it("branches resolveButton's confirmation copy on the coherent work-item kind/reason pair", () => {
    const clickBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf('resolveButton.addEventListener("click"'),
      STAFF_APP_JS.indexOf('replySendButton.addEventListener("click"'),
    );
    expect(clickBody).toContain(
      'if (currentWorkItemKind === "human_handoff" && currentWorkItemReason === "emergency_handoff") {',
    );
    expect(clickBody).toContain('window.confirm("Klinik personeli bu acil durumla ilgilendi mi?")');
    expect(clickBody).toContain(
      'window.confirm(\n        "Bu konu\\u015fma kapanacak ve sonraki mesaj g\\u00fcvenlik sorular\\u0131n\\u0131 yeniden ba\\u015flatacak. Onayl\\u0131yor musunuz?"\n      )',
    );
    expect(clickBody).toContain(
      '} else if (currentWorkItemKind === "human_handoff" && currentWorkItemReason === "human_handoff") {',
    );
    expect(clickBody).toContain(
      'window.confirm(\n        "Bu i\\u015fi \\u00e7\\u00f6zmek konu\\u015fmay\\u0131 tamamlayacak; m\\u00fc\\u015fteri yeniden yazarsa yeni bir konu\\u015fma ba\\u015flar ve g\\u00fcvenlik sorular\\u0131 yeniden sorulur. Devam etmek istedi\\u011finize emin misiniz?"\n      )',
    );
    expect(clickBody).toContain(
      'window.confirm("Bu i\\u015fi \\u00e7\\u00f6z\\u00fcld\\u00fc olarak i\\u015faretlemek istedi\\u011finize emin misiniz?")',
    );

    const emergencyIndex = clickBody.indexOf('currentWorkItemReason === "emergency_handoff"');
    const humanHandoffIndex = clickBody.indexOf('currentWorkItemReason === "human_handoff"');
    const rpcCallIndex = clickBody.indexOf('await callWorkItemRpc("resolve_staff_work_item"');
    expect(emergencyIndex).toBeGreaterThan(-1);
    expect(humanHandoffIndex).toBeGreaterThan(emergencyIndex);
    expect(rpcCallIndex).toBeGreaterThan(humanHandoffIndex);
    expect(clickBody.match(/await callWorkItemRpc\("resolve_staff_work_item"/g)).toHaveLength(1);
  });

  describe("resolveButton confirmation branches", () => {
    type ResolveClickButton = {
      listener?: () => Promise<void>;
      disabled?: boolean;
      addEventListener: (event: string, listener: () => Promise<void>) => void;
    };
    type CallRpc = (rpcName: string, workItemId: string, allowedResults: string[]) => Promise<string>;

    function installResolveHandler(kind: string, reason: string, confirmResults: boolean[], rpcCalls: string[]) {
      const clickSource = STAFF_APP_JS.slice(
        STAFF_APP_JS.indexOf('resolveButton.addEventListener("click"'),
        STAFF_APP_JS.indexOf('replySendButton.addEventListener("click"'),
      );
      const button: ResolveClickButton = {
        addEventListener(_event, listener) {
          this.listener = listener;
        },
      };
      const windowStub = { confirm: () => confirmResults.shift() ?? false };
      const callWorkItemRpc: CallRpc = async (rpcName) => {
        rpcCalls.push(rpcName);
        return "resolved";
      };
      const install = new Function(
        "resolveButton",
        "window",
        "callWorkItemRpc",
        "showQueueView",
        "refreshQueue",
        "refreshWorkItemState",
        "showError",
        `"use strict";
         let currentWorkItemId = "48800000-0000-4000-8000-000000000301";
         let currentWorkItemKind = ${JSON.stringify(kind)};
         let currentWorkItemReason = ${JSON.stringify(reason)};
         ${clickSource}`,
      ) as (
        resolveButtonArg: ResolveClickButton,
        windowArg: { confirm: () => boolean },
        callWorkItemRpcArg: CallRpc,
        showQueueViewArg: () => void,
        refreshQueueArg: () => Promise<void>,
        refreshWorkItemStateArg: () => Promise<void>,
        showErrorArg: (message: string) => void,
      ) => void;
      install(
        button,
        windowStub,
        callWorkItemRpc,
        () => {},
        async () => {},
        async () => {},
        () => {},
      );
      return button;
    }

    it("requires both emergency confirmations and calls no RPC unless both are accepted", async () => {
      const cancelledFirst: string[] = [];
      await installResolveHandler("human_handoff", "emergency_handoff", [false], cancelledFirst).listener!();
      expect(cancelledFirst).toEqual([]);

      const cancelledSecond: string[] = [];
      await installResolveHandler("human_handoff", "emergency_handoff", [true, false], cancelledSecond).listener!();
      expect(cancelledSecond).toEqual([]);

      const acceptedBoth: string[] = [];
      await installResolveHandler("human_handoff", "emergency_handoff", [true, true], acceptedBoth).listener!();
      expect(acceptedBoth).toEqual(["resolve_staff_work_item"]);
    });

    it("requires exactly one truthful confirmation for a normal human handoff before calling the RPC", async () => {
      const cancelled: string[] = [];
      await installResolveHandler("human_handoff", "human_handoff", [false], cancelled).listener!();
      expect(cancelled).toEqual([]);

      const accepted: string[] = [];
      await installResolveHandler("human_handoff", "human_handoff", [true], accepted).listener!();
      expect(accepted).toEqual(["resolve_staff_work_item"]);
    });

    it("keeps the original single generic confirmation for a delivery_failure reason", async () => {
      const cancelled: string[] = [];
      await installResolveHandler("delivery_failure", "send_attempts_exhausted", [false], cancelled).listener!();
      expect(cancelled).toEqual([]);

      const accepted: string[] = [];
      await installResolveHandler("delivery_failure", "send_attempts_exhausted", [true], accepted).listener!();
      expect(accepted).toEqual(["resolve_staff_work_item"]);
    });

    it("makes no RPC call for an absent or incoherent kind/reason pair", async () => {
      for (const [kind, reason] of [
        ["human_handoff", "provider_failed"],
        ["delivery_failure", "emergency_handoff"],
        ["", ""],
      ] as const) {
        const rpcCalls: string[] = [];
        await installResolveHandler(kind, reason, [true, true], rpcCalls).listener!();
        expect(rpcCalls).toEqual([]);
      }
    });
  });

  it("never invokes resolve_staff_work_item from the composer path", () => {
    const clickBody = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf('replySendButton.addEventListener("click"'),
      STAFF_APP_JS.indexOf("async function init() {"),
    );
    expect(clickBody).not.toContain("resolve_staff_work_item");
  });

  it("labels messages as Musteri/Sistem/Personel/Otomatik from direction and outbound_origin only", () => {
    const body = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("function messageLabel(message) {"),
      STAFF_APP_JS.indexOf("function renderDetail("),
    );
    expect(body).toContain('return "M\\u00fc\\u015fteri";');
    expect(body).toContain('return "Sistem";');
    expect(body).toContain('return message.outbound_origin === "staff" ? "Personel" : "Otomatik";');
    expect(STAFF_APP_JS).toContain(
      'li.textContent = "[" + messageLabel(message) + "] " + when + ": " + message.content;',
    );
    expect(STAFF_APP_JS).toContain(
      "&select=direction,content,created_at,outbound_origin&order=created_at.desc&limit=20",
    );
  });

  it("enforces the 4096-character WhatsApp limit client-side and disables send for empty/whitespace-only drafts", () => {
    const body = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("function updateReplySendButtonState() {"),
      STAFF_APP_JS.indexOf('replyContentInput.addEventListener("input"'),
    );
    expect(body).toContain("const length = replyCodePointLength(replyContentInput.value);");
    expect(body).toContain("const trimmedNonEmpty = replyContentInput.value.trim().length > 0;");
    expect(body).toContain(
      "!composerEligible || replySubmitInFlight || !trimmedNonEmpty || length > REPLY_MAX_LENGTH;",
    );
  });

  it("validates work-item state and message-history origin shapes before enabling or rendering the composer", () => {
    expect(STAFF_APP_JS).toContain("return validateWorkItemState(rows[0]);");
    expect(STAFF_APP_JS).toContain('isExactRecord(value, ["status", "assigned_to", "kind", "reason"])');
    expect(STAFF_APP_JS).toContain(
      '["human_handoff", "emergency_handoff", "send_attempts_exhausted", "provider_failed"].indexOf(value.reason) === -1',
    );
    expect(STAFF_APP_JS).toContain(
      '(value.kind === "human_handoff" && value.reason !== "human_handoff" && value.reason !== "emergency_handoff")',
    );
    expect(STAFF_APP_JS).toContain(
      'isExactRecord(message, ["direction", "content", "created_at", "outbound_origin"])',
    );
    expect(STAFF_APP_JS).toContain(
      '(message.direction !== "outbound" && message.outbound_origin === null)',
    );
  });

  it("behaviorally fails closed for a malformed work-item kind or reason", () => {
    const source = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("function validateWorkItemState(value) {"),
      STAFF_APP_JS.indexOf("function replyCodePointLength(value) {"),
    );
    const makeValidator = new Function(
      "isExactRecord",
      "UUID_PATTERN",
      `"use strict";
       ${source}
       return validateWorkItemState;`,
    ) as (
      exactRecord: (value: unknown, keys: string[]) => boolean,
      uuidPattern: RegExp,
    ) => (value: unknown) => unknown;
    const validate = makeValidator(
      (value, keys) => typeof value === "object" && value !== null && Object.keys(value as object).length === keys.length,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const base = { status: "in_progress", assigned_to: null, kind: "human_handoff", reason: "human_handoff" };

    expect(validate(base)).toEqual(base);
    expect(() => validate({ ...base, kind: "not_a_real_kind" })).toThrow("malformed work item state");
    expect(() => validate({ ...base, reason: "not_a_real_reason" })).toThrow("malformed work item state");
    expect(() => validate({ ...base, reason: "provider_failed" })).toThrow("malformed work item state");
    expect(() =>
      validate({ ...base, kind: "delivery_failure", reason: "emergency_handoff" }),
    ).toThrow("malformed work item state");
    expect(validate({ ...base, kind: "delivery_failure", reason: "provider_failed" })).toEqual({
      ...base,
      kind: "delivery_failure",
      reason: "provider_failed",
    });
  });

  it("behaviorally accepts long inbound history while retaining the 4096 outbound cap", () => {
    const source = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("function replyCodePointLength(value) {"),
      STAFF_APP_JS.indexOf("function validateReplyResult(value) {"),
    );
    const makeValidator = new Function(
      "isExactRecord",
      `"use strict";
       const REPLY_MAX_LENGTH = 4096;
       const INBOUND_MESSAGE_MAX_LENGTH = 65536;
       const ISO_TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;
       ${source}
       return isValidMessageHistoryItem;`,
    ) as (exactRecord: (value: unknown, keys: string[]) => boolean) => (value: unknown) => boolean;
    const validate = makeValidator((value, keys) => {
      return typeof value === "object" && value !== null && Object.keys(value).length === keys.length;
    });
    const baseMessage = { created_at: "2026-09-03T12:00:00Z", outbound_origin: null };

    expect(validate({ ...baseMessage, direction: "inbound", content: "x".repeat(65_536) })).toBe(true);
    expect(validate({ ...baseMessage, direction: "inbound", content: "x".repeat(65_537) })).toBe(false);
    expect(
      validate({ ...baseMessage, direction: "outbound", outbound_origin: "staff", content: "x".repeat(4_097) }),
    ).toBe(false);
  });

  it("drops stale overlapping detail loads before they can replace the current item or composer state", () => {
    const body = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("async function openDetail(workItemId, conversationId) {"),
      STAFF_APP_JS.indexOf("async function fetchAutomationAccounts() {"),
    );
    expect(body.match(/currentWorkItemId !== workItemId/g)).toHaveLength(3);
    expect(body).toContain("const workItemState = await fetchWorkItemState(workItemId);");
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

describe("handleStaffScript: application shell and section navigation (Task 058)", () => {
  it("renders exactly one inline style block, no external stylesheet, font or CDN asset", () => {
    expect((STAFF_HTML.match(/<style>/g) || []).length).toBe(1);
    expect(STAFF_HTML).not.toMatch(/<link[^>]*stylesheet/i);
    expect(STAFF_HTML).not.toMatch(/https?:\/\//);
    expect(STAFF_HTML).not.toMatch(/\/\/[a-z0-9.-]+\.(?:googleapis|gstatic|jsdelivr|cloudflare)\.com/i);
    expect(STAFF_HTML).not.toContain("@import");
  });

  it("respects prefers-reduced-motion and remains usable at the 42rem narrow breakpoint", () => {
    expect(STAFF_HTML).toContain("@media (prefers-reduced-motion: reduce)");
    expect(STAFF_HTML).toContain("@media (max-width: 42rem)");
  });

  it("does not introduce a new client-side storage mechanism", () => {
    expect(STAFF_APP_JS).not.toContain("localStorage");
    expect(STAFF_APP_JS).not.toContain("indexedDB");
  });

  it("renders the four staff navigation destinations with the exact required Turkish labels and ARIA wiring, hidden before login", () => {
    expect(STAFF_HTML).toContain('<nav id="section-nav" aria-label="Panel bölümleri" hidden>');
    expect(STAFF_HTML).toContain(
      '<button type="button" class="nav-tab" id="nav-tab-queue" data-destination="queue" aria-controls="queue-section" aria-current="true">İşler</button>',
    );
    expect(STAFF_HTML).toContain(
      '<button type="button" class="nav-tab" id="nav-tab-automation" data-destination="automation" aria-controls="automation-section" aria-current="false">WhatsApp otomasyonu</button>',
    );
    expect(STAFF_HTML).toContain(
      '<button type="button" class="nav-tab" id="nav-tab-schedule" data-destination="schedule" aria-controls="schedule-section" aria-current="false">Takvim</button>',
    );
    expect(STAFF_HTML).toContain(
      '<button type="button" class="nav-tab" id="nav-tab-alerts" data-destination="alerts" aria-controls="alert-prefs-section" aria-current="false">E-posta uyarıları</button>',
    );
  });

  it("switching the active destination toggles exactly one visible section, invokes no loader, and never touches the reply draft", () => {
    const source = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("const DESTINATIONS = ["),
      STAFF_APP_JS.indexOf("function stopPolling() {"),
    );
    expect(source).not.toMatch(/resetReplyDraftState|authedFetch|fetch\(|replyContentInput/);

    function makeSection(hidden: boolean) {
      return { hidden };
    }
    function makeTab() {
      let handler: (() => void) | null = null;
      const attrs: Record<string, string> = {};
      return {
        setAttribute: (key: string, value: string) => {
          attrs[key] = value;
        },
        getAttribute: (key: string) => attrs[key],
        addEventListener: (type: string, fn: () => void) => {
          if (type === "click") handler = fn;
        },
        click: () => handler && handler(),
      };
    }
    const deps = {
      loginSection: makeSection(false),
      sectionNav: { hidden: true },
      queueSection: makeSection(true),
      automationSection: makeSection(true),
      scheduleSection: makeSection(true),
      alertPrefsSection: makeSection(true),
      detailSection: makeSection(true),
      navTabQueue: makeTab(),
      navTabAutomation: makeTab(),
      navTabSchedule: makeTab(),
      navTabAlerts: makeTab(),
    };
    const makeHarness = new Function(
      "deps",
      `"use strict";
       const { loginSection, sectionNav, queueSection, automationSection, scheduleSection, alertPrefsSection, detailSection, navTabQueue, navTabAutomation, navTabSchedule, navTabAlerts } = deps;
       ${source}
       return { showQueueView, showDetailView, getActiveDestination: () => activeDestination, getQueueSubview: () => queueSubview };`,
    ) as (deps: unknown) => {
      showQueueView: () => void;
      showDetailView: () => void;
      getActiveDestination: () => string;
      getQueueSubview: () => string;
    };
    const harness = makeHarness(deps);

    harness.showQueueView();
    expect(deps.queueSection.hidden).toBe(false);
    expect(deps.automationSection.hidden).toBe(true);
    expect(deps.scheduleSection.hidden).toBe(true);
    expect(deps.alertPrefsSection.hidden).toBe(true);

    harness.showDetailView();
    expect(deps.detailSection.hidden).toBe(false);
    expect(deps.queueSection.hidden).toBe(true);
    expect(harness.getQueueSubview()).toBe("detail");

    deps.navTabSchedule.click();
    expect(harness.getActiveDestination()).toBe("schedule");
    expect(deps.scheduleSection.hidden).toBe(false);
    expect(deps.detailSection.hidden).toBe(true);
    expect(deps.queueSection.hidden).toBe(true);
    expect(deps.automationSection.hidden).toBe(true);
    expect(deps.alertPrefsSection.hidden).toBe(true);

    deps.navTabQueue.click();
    expect(harness.getActiveDestination()).toBe("queue");
    expect(deps.queueSection.hidden).toBe(true);
    expect(deps.detailSection.hidden).toBe(false);
    expect(deps.scheduleSection.hidden).toBe(true);
  });

  it("ignores an unknown or tampered destination instead of blanking the shell (fail-closed)", () => {
    const source = STAFF_APP_JS.slice(
      STAFF_APP_JS.indexOf("const DESTINATIONS = ["),
      STAFF_APP_JS.indexOf("function showLoginView() {"),
    );
    function makeSection(hidden: boolean) {
      return { hidden };
    }
    const deps = {
      queueSection: makeSection(false),
      automationSection: makeSection(true),
      scheduleSection: makeSection(true),
      alertPrefsSection: makeSection(true),
      detailSection: makeSection(false),
      navTabQueue: { setAttribute: () => {}, addEventListener: () => {} },
      navTabAutomation: { setAttribute: () => {}, addEventListener: () => {} },
      navTabSchedule: { setAttribute: () => {}, addEventListener: () => {} },
      navTabAlerts: { setAttribute: () => {}, addEventListener: () => {} },
    };
    const makeHarness = new Function(
      "deps",
      `"use strict";
       const { queueSection, automationSection, scheduleSection, alertPrefsSection, detailSection, navTabQueue, navTabAutomation, navTabSchedule, navTabAlerts } = deps;
       ${source}
       return { selectDestination, getActiveDestination: () => activeDestination };`,
    ) as (deps: unknown) => { selectDestination: (destination: string) => void; getActiveDestination: () => string };
    const harness = makeHarness(deps);

    harness.selectDestination("__proto__");
    expect(harness.getActiveDestination()).toBe("queue");
    expect(deps.detailSection.hidden).toBe(false);
    expect(deps.queueSection.hidden).toBe(false);
  });

  it("wraps the schedule and alert-prefs tables in a horizontally scrollable container without changing table semantics", () => {
    expect(STAFF_HTML).toContain('<div class="table-wrap">\n  <table>\n    <caption>Haftalık çalışma saatleri</caption>');
    expect(STAFF_HTML).toContain('<div class="table-wrap">\n  <table>\n    <caption>Klinik uyarıları</caption>');
  });

  it("gives the shared shell a semantic main landmark wrapping the section content", () => {
    expect(STAFF_HTML).toContain("<main>");
    expect(STAFF_HTML).toContain("</main>");
    expect(STAFF_HTML.indexOf("<main>")).toBeGreaterThan(STAFF_HTML.indexOf("</header>"));
    expect(STAFF_HTML.indexOf("</main>")).toBeLessThan(STAFF_HTML.indexOf('<script src="/staff/app.js">'));
  });
});
