import type { Env } from "./env";

// Task 053 Phase B. Every exported function here is best-effort and never
// throws: a missing/placeholder config value, a network failure, or an
// unexpected response shape silently skips that one check instead of
// blocking the caller (the intake queue consumer, the /ready route, or the
// scheduled Cron tick). No recipient address, message content, patient
// data, or provider raw error body is ever logged. See
// docs/operational-alerting.md for the activation plan this implements.

const REQUEST_TIMEOUT_MS = 10_000;
const ALERT_HEARTBEAT_MAX_AGE_SECONDS = 180;
const MAX_ALERT_ROWS_PER_RUN = 10;
const QUEUE_ID_CACHE_MS = 5 * 60_000;
// docs/operational-alerting.md section 1, row 3.
const PRIMARY_QUEUE_AGE_THRESHOLD_MS = 5 * 60_000;
const PRIMARY_QUEUE_TREND_LEN = 3;
// Cloudflare queue ids are opaque hex/UUID-shaped strings; this only bounds
// length and charset before one is ever interpolated into an API path.
const QUEUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
// docs/operational-alerting.md section 3: the account's actual plan/retention
// is not verified in this phase, so the conservative recovery budget is a
// flat 24h floor until that is confirmed; row 5's rule is half of it.
const TERMINAL_DLQ_AGE_THRESHOLD_MS = 12 * 60 * 60_000;

// Duplicated from readiness.ts per this repo's per-file config-validation
// duplication convention rather than importing it.
const PLACEHOLDER_PATTERN = /^(?:change[_-]?me|replace[_-]?me|your[_-].*|<[^>]*>|\[[^\]]*\]|placeholder|todo|x{3,}|unset|not[_-]?set)$/i;

function isNonPlaceholderString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.trim() !== value) return false;
  return !PLACEHOLDER_PATTERN.test(value);
}

// RFC 2606 reserves .invalid for addresses that are guaranteed undeliverable
// -- it is also this repo's checked-in wrangler.toml/wrangler.staging.toml
// placeholder for RESEND_FROM_ADDRESS/STAFF_LOGIN_URL, so it must never be
// treated as "configured" while alerting is enabled (Task 053 Codex
// re-review item 3). .test/.example/.localhost are left alone -- they are
// this repo's normal fixture-domain convention, not a shipped placeholder.
const INVALID_TLD_PATTERN = /\.invalid(?:[/:?#]|$)/i;

function isNonReservedTldString(value: unknown): value is string {
  return isNonPlaceholderString(value) && !INVALID_TLD_PATTERN.test(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasResendConfig(env: Env): boolean {
  return isNonPlaceholderString(env.RESEND_API_KEY) && isNonReservedTldString(env.RESEND_FROM_ADDRESS);
}

function hasCloudflareMonitoringConfig(env: Env): boolean {
  return isNonPlaceholderString(env.CLOUDFLARE_ACCOUNT_ID) && isNonPlaceholderString(env.CLOUDFLARE_ALERTS_MONITORING_TOKEN);
}

function hasStaffLoginUrl(env: Env): env is Env & { STAFF_LOGIN_URL: string } {
  return isNonReservedTldString(env.STAFF_LOGIN_URL) && env.STAFF_LOGIN_URL.startsWith("https://");
}

function hasDeploymentName(env: Env): env is Env & { DEPLOYMENT_NAME: string } {
  return isNonPlaceholderString(env.DEPLOYMENT_NAME);
}

// Task 053 Codex re-review item 3: all three queue names must be present and
// mutually distinct, or checkQueueBacklogs' own per-name branching
// (`name === env.INTAKE_QUEUE_NAME` etc.) becomes ambiguous and a queue can
// get another queue's backlog threshold applied to it.
function hasDistinctQueueNames(env: Env): boolean {
  const names = [env.INTAKE_QUEUE_NAME, env.INTAKE_DLQ_NAME, env.INTAKE_TERMINAL_DLQ_NAME];
  if (!names.every(isNonPlaceholderString)) return false;
  return new Set(names).size === names.length;
}

// The bare on/off switch used by the inline OpenAI-failure recorder. The
// scheduled monitor has a stronger all-or-nothing configuration gate below so
// it never claims a notification it cannot fully render and deliver.
function isAlertingEnabled(env: Env): boolean {
  return env.OPERATIONAL_ALERTS_ENABLED === "true";
}

// Task 053 Codex review item 1: /ready must fail closed the moment alerting
// is turned on but not fully usable, rather than staying green on stale
// heartbeat freshness while some mandatory piece of config (Resend,
// Cloudflare monitoring, staff login URL, deployment name) is missing.
function isAlertingConfigured(env: Env): boolean {
  return (
    env.OPERATIONAL_ALERTS_ENABLED === "true" &&
    isNonPlaceholderString(env.SUPABASE_URL) &&
    isNonPlaceholderString(env.SUPABASE_SERVICE_ROLE_KEY) &&
    hasResendConfig(env) &&
    hasCloudflareMonitoringConfig(env) &&
    hasStaffLoginUrl(env) &&
    hasDeploymentName(env) &&
    hasDistinctQueueNames(env)
  );
}

async function callSupabaseRpc(env: Env, fn: string, body: Record<string, unknown>): Promise<unknown[] | null> {
  try {
    const response = await fetch(new URL(`/rest/v1/rpc/${fn}`, env.SUPABASE_URL), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = await response.json();
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstResultField(rows: unknown[] | null, field: string): unknown {
  if (!rows || rows.length !== 1) return undefined;
  const row = rows[0];
  if (typeof row !== "object" || row === null) return undefined;
  return (row as Record<string, unknown>)[field];
}

async function recordPlatformSignal(env: Env, signalKind: string, queueId: string | null): Promise<boolean> {
  const result = firstResultField(await callSupabaseRpc(env, "record_platform_signal", { p_signal_kind: signalKind, p_queue_id: queueId }), "result");
  return result === "recorded";
}

// ---------------------------------------------------------------------
// Hook 1: called inline from the intake queue consumer on every OpenAI
// extraction failure. Bounded by the same 10s timeout as every other call
// in this file; the consumer's own "retry" disposition is decided before
// this is awaited and is never changed by its outcome.
// ---------------------------------------------------------------------

export async function recordOpenAiExtractionFailureSignal(env: Env): Promise<void> {
  if (!isAlertingEnabled(env)) return;
  await callSupabaseRpc(env, "record_platform_signal", { p_signal_kind: "openai_extraction_failure", p_queue_id: null });
}

// ---------------------------------------------------------------------
// Hook 2: called from the /ready route. Heartbeat freshness is an
// independent observer's view of whether the Cron-driven monitor tick
// below is still running -- /ready is polled by something other than this
// Worker's own Cron, so a wedged scheduled() cannot mask itself as ready.
// ---------------------------------------------------------------------

export type AlertMonitorHeartbeatStatus = { enabled: false } | { enabled: true; fresh: boolean };

export async function checkAlertMonitorHeartbeat(env: Env): Promise<AlertMonitorHeartbeatStatus> {
  if (env.OPERATIONAL_ALERTS_ENABLED !== "true") return { enabled: false };
  // Task 053 Codex review item 1: alerting turned on but missing/broken
  // config must fail /ready closed immediately, not wait for the heartbeat
  // to eventually age out.
  if (!isAlertingConfigured(env)) return { enabled: true, fresh: false };
  const rows = await callSupabaseRpc(env, "is_alert_monitor_heartbeat_fresh", { p_max_age_seconds: ALERT_HEARTBEAT_MAX_AGE_SECONDS });
  return { enabled: true, fresh: firstResultField(rows, "fresh") === true };
}

// ---------------------------------------------------------------------
// Hook 3: the Cron-driven monitor tick, run from a second, independent
// ctx.waitUntil() in scheduled(). Each stage is isolated so one failing
// signal source never blocks the others, and each reports a closed
// success/unavailable result so the heartbeat can only advance once every
// mandatory source was reliably queried (Task 053 Codex review item 1).
// ---------------------------------------------------------------------

type StageResult = "success" | "unavailable";

export async function runOperationalAlertMonitor(env: Env): Promise<void> {
  // Missing delivery or monitoring configuration must stop before any
  // candidate is claimed. Treating a configuration gap like a provider send
  // failure would consume the row's bounded delivery attempts without ever
  // making a real send.
  if (!isAlertingConfigured(env)) return;

  const [queueResult, telemetryResult] = await Promise.all([checkQueueBacklogs(env), checkWebhookTelemetry()]);
  const syncResult = await syncAlertDeliveryCandidates(env);
  // Reopen accepted deliveries whose repeat schedule has elapsed before
  // draining, so a due repeat is claimable in this same tick (Task 053
  // Codex review item 3: repeat/recovery states must be executed, not just
  // representable).
  const repeatResult = await scheduleAlertRepeats(env);
  const deliveryResult = await drainAlertDeliveries(env);

  if (
    queueResult === "success" &&
    telemetryResult === "success" &&
    syncResult === "success" &&
    repeatResult === "success" &&
    deliveryResult === "success"
  ) {
    await callSupabaseRpc(env, "record_alert_monitor_heartbeat", {});
  }
}

async function syncAlertDeliveryCandidates(env: Env): Promise<StageResult> {
  const rows = await callSupabaseRpc(env, "sync_alert_delivery_candidates", {});
  return typeof firstResultField(rows, "inserted_count") === "number" ? "success" : "unavailable";
}

async function scheduleAlertRepeats(env: Env): Promise<StageResult> {
  const rows = await callSupabaseRpc(env, "schedule_alert_repeat_notifications", {});
  return typeof firstResultField(rows, "reopened_count") === "number" ? "success" : "unavailable";
}

let queueIdCache: { at: number; ids: Map<string, string> } | null = null;

// Fail-closed: every requested name must resolve to exactly one queue id
// before anything is cached or used (Task 053 DB item 3 / Worker item 3) --
// a queue recreated under the same name, a partial List Queues response, or
// an ambiguous duplicate name never gets silently skipped or memoized.
async function resolveQueueIds(env: Env, names: readonly string[]): Promise<Map<string, string> | null> {
  const now = Date.now();
  if (queueIdCache && now - queueIdCache.at < QUEUE_ID_CACHE_MS && names.every((name) => queueIdCache!.ids.has(name))) {
    return queueIdCache.ids;
  }

  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/queues`, {
      headers: { authorization: `Bearer ${env.CLOUDFLARE_ALERTS_MONITORING_TOKEN}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as { result?: Array<{ queue_id?: unknown; queue_name?: unknown }> };
    if (!Array.isArray(parsed.result)) return null;

    const ids = new Map<string, string>();
    const seen = new Set<string>();
    const ambiguous = new Set<string>();
    for (const row of parsed.result) {
      if (
        typeof row.queue_name === "string" &&
        typeof row.queue_id === "string" &&
        // Task 053 Codex re-review item 3: bound the id before it is ever
        // interpolated into a Cloudflare API path segment below.
        QUEUE_ID_PATTERN.test(row.queue_id) &&
        names.includes(row.queue_name)
      ) {
        if (seen.has(row.queue_name)) ambiguous.add(row.queue_name);
        seen.add(row.queue_name);
        ids.set(row.queue_name, row.queue_id);
      }
    }
    // Fail closed on any ambiguous name instead of guessing which match is
    // real (Task 053 Worker item 3: "require exactly one match").
    if (ambiguous.size > 0) return null;
    if (!names.every((name) => ids.has(name))) return null;
    queueIdCache = { at: now, ids };
    return ids;
  } catch {
    return null;
  }
}

type QueueMetrics = { backlogCount: number; backlogBytes: number; oldestMessageAgeMs: number | null };

// Get Queue Metrics response fields confirmed against the reviewed Cloudflare
// Queues contract (docs/operational-alerting.md section 2): `backlog_count`,
// `backlog_bytes`, `oldest_message_timestamp_ms`. Parsed strictly -- a
// response missing either count field is treated as unavailable, never as
// zero backlog.
async function getQueueMetrics(env: Env, queueId: string): Promise<QueueMetrics | null> {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/queues/${encodeURIComponent(queueId)}/metrics`,
      { headers: { authorization: `Bearer ${env.CLOUDFLARE_ALERTS_MONITORING_TOKEN}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!response.ok) return null;
    const parsed = (await response.json()) as {
      result?: { backlog_count?: unknown; backlog_bytes?: unknown; oldest_message_timestamp_ms?: unknown };
    };
    const result = parsed.result;
    // Task 053 Codex re-review item 3: a negative/non-finite backlog reading
    // is never valid, not even to fall back to null on -- it means the
    // response shape or unit assumption is wrong, so the whole metrics read
    // is rejected rather than silently used.
    if (!isFiniteNonNegative(result?.backlog_count) || !isFiniteNonNegative(result?.backlog_bytes)) return null;
    // 0 is Cloudflare's zero-value default for "no timestamp recorded", not
    // a real epoch-1970 message, and a negative/non-finite value is never a
    // real timestamp either -- both are unknown, not "very old".
    const rawOldestMs = result.oldest_message_timestamp_ms;
    const oldestMs = isFiniteNonNegative(rawOldestMs) && rawOldestMs > 0 ? rawOldestMs : null;
    return { backlogCount: result.backlog_count, backlogBytes: result.backlog_bytes, oldestMessageAgeMs: oldestMs === null ? null : Date.now() - oldestMs };
  } catch {
    return null;
  }
}

// Last PRIMARY_QUEUE_TREND_LEN backlog_count readings for the primary queue,
// oldest first. Module-level, reset per Worker isolate/test module load --
// same lifetime as queueIdCache above.
let primaryBacklogHistory: number[] = [];

export async function checkQueueBacklogs(env: Env): Promise<StageResult> {
  if (!hasCloudflareMonitoringConfig(env)) return "unavailable";

  const named = (
    [
      env.INTAKE_QUEUE_NAME,
      env.INTAKE_DLQ_NAME,
      env.INTAKE_TERMINAL_DLQ_NAME,
    ] as const
  ).filter(isNonPlaceholderString);
  if (named.length === 0) return "unavailable";
  // Task 053 Codex re-review item 3: this stage's own per-name branching
  // below is ambiguous for duplicate names -- isAlertingConfigured() already
  // requires all three distinct. Keep the stage-level check as a fail-closed
  // boundary for direct calls and future refactors too.
  if (new Set(named).size !== named.length) return "unavailable";

  const queueIds = await resolveQueueIds(env, named);
  if (!queueIds) return "unavailable";

  let sawFailure = false;
  for (const name of named) {
    const queueId = queueIds.get(name);
    if (!queueId) {
      sawFailure = true;
      continue;
    }
    const metrics = await getQueueMetrics(env, queueId);
    if (!metrics) {
      sawFailure = true;
      continue;
    }

    if (name === env.INTAKE_QUEUE_NAME) {
      // docs/operational-alerting.md section 1, row 3: aging OR a rising
      // 3-measurement trend, never a single absolute count threshold.
      primaryBacklogHistory.push(metrics.backlogCount);
      if (primaryBacklogHistory.length > PRIMARY_QUEUE_TREND_LEN) primaryBacklogHistory.shift();
      const trendIncreasing =
        primaryBacklogHistory.length === PRIMARY_QUEUE_TREND_LEN &&
        primaryBacklogHistory[0]! < primaryBacklogHistory[1]! &&
        primaryBacklogHistory[1]! < primaryBacklogHistory[2]!;
      const aging = metrics.oldestMessageAgeMs !== null && metrics.oldestMessageAgeMs > PRIMARY_QUEUE_AGE_THRESHOLD_MS;
      // Task 053 Codex re-review item 3: a threshold firing but failing to
      // record must not be reported as a successful check -- the alarm was
      // silently dropped.
      if ((aging || trendIncreasing) && !(await recordPlatformSignal(env, "queue_backlog", queueId))) sawFailure = true;
    } else if (name === env.INTAKE_DLQ_NAME) {
      // docs/operational-alerting.md section 1, row 4: any DLQ message.
      if (metrics.backlogCount > 0 && !(await recordPlatformSignal(env, "queue_backlog", queueId))) sawFailure = true;
    } else {
      // docs/operational-alerting.md section 1, row 5: a terminal-DLQ
      // message old enough to be past half the conservative recovery
      // budget (section 3).
      if (
        metrics.backlogCount > 0 &&
        metrics.oldestMessageAgeMs !== null &&
        metrics.oldestMessageAgeMs > TERMINAL_DLQ_AGE_THRESHOLD_MS &&
        !(await recordPlatformSignal(env, "queue_backlog", queueId))
      ) {
        sawFailure = true;
      }
    }
  }
  return sawFailure ? "unavailable" : "success";
}

// Task 053 Codex re-review item 5: the Workers Observability query shape
// (field names, request/response contract) is NOT VERIFIED against a live
// account. Until it is, this source must produce zero platform-signal
// mutations and zero emails -- not even as a "best-effort" side effect --
// and must keep reporting unavailable so the heartbeat stays blocked.
// docs/operational-alerting.md section 2 tracks the verification work; wire
// the real query back in here once a real account confirms the shape.
async function checkWebhookTelemetry(): Promise<StageResult> {
  return "unavailable";
}

const SIGNAL_KINDS = new Set([
  "delivery_failure",
  "human_handoff_urgent",
  "human_handoff_normal",
  "intake_dead_letter",
  "queue_backlog",
  "webhook_5xx",
  "webhook_401",
  "openai_extraction_failure",
]);

// Exactly the columns claim_alert_delivery() returns (Task 053 migration).
const CLAIM_ROW_KEYS = new Set([
  "id",
  "signal_kind",
  "recipient_scope",
  "clinic_id",
  "recipient_user_id",
  "work_item_id",
  "recipient_email",
  "occurrence_count",
  "created_at",
  "claim_token",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Mirrors the DB's own clinic_alert_recipients/platform_alert_recipients
// email check (`email = lower(btrim(email))`, 3-320 chars, `_%@_%.__%`).
const CLAIM_EMAIL_PATTERN = /^.+@.+\..{2,}$/;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isValidAlertEmail(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 3 || value.length > 320) return false;
  if (value !== value.trim() || value !== value.toLowerCase()) return false;
  return CLAIM_EMAIL_PATTERN.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

type AlertClaim = {
  id: string;
  signalKind: string;
  recipientScope: "clinic" | "platform";
  recipientEmail: string;
  occurrenceCount: number;
  createdAt: string;
  claimToken: string;
};

// Task 053 Codex review item 4: an empty claim result (nothing pending) and
// an invalid/malformed one are different outcomes for the caller -- the
// first means the drain reliably finished, the second means it did not.
type ClaimReadResult = { kind: "claimed"; claim: AlertClaim } | { kind: "empty" } | { kind: "invalid" };

// Fail-closed, exact-shape validation: the row must have exactly the 10
// documented own-enumerable columns (no inherited/extra properties), every
// field closed-validated (UUID, known signal kind, known scope, bounded
// email, integer occurrence count, parseable timestamp), and scope/clinic_id
// coherence enforced here too. An unknown recipient_scope is rejected, never
// silently mapped to "clinic".
function readAlertClaim(rows: unknown[] | null): ClaimReadResult {
  if (rows === null) return { kind: "invalid" };
  if (rows.length === 0) return { kind: "empty" };
  if (rows.length !== 1) return { kind: "invalid" };

  const row = rows[0];
  if (typeof row !== "object" || row === null) return { kind: "invalid" };
  const keys = Object.keys(row as Record<string, unknown>);
  if (keys.length !== CLAIM_ROW_KEYS.size || !keys.every((key) => CLAIM_ROW_KEYS.has(key))) return { kind: "invalid" };

  const r = row as Record<string, unknown>;
  if (!isUuid(r.id)) return { kind: "invalid" };
  if (typeof r.signal_kind !== "string" || !SIGNAL_KINDS.has(r.signal_kind)) return { kind: "invalid" };
  if (r.recipient_scope !== "clinic" && r.recipient_scope !== "platform") return { kind: "invalid" };
  if (r.clinic_id !== null && !isUuid(r.clinic_id)) return { kind: "invalid" };
  if (r.recipient_scope === "clinic" && r.clinic_id === null) return { kind: "invalid" };
  if (r.recipient_scope === "platform" && r.clinic_id !== null) return { kind: "invalid" };
  if (!isUuid(r.recipient_user_id)) return { kind: "invalid" };
  if (r.work_item_id !== null && !isUuid(r.work_item_id)) return { kind: "invalid" };
  if (!isValidAlertEmail(r.recipient_email)) return { kind: "invalid" };
  if (typeof r.occurrence_count !== "number" || !Number.isInteger(r.occurrence_count) || r.occurrence_count < 1) return { kind: "invalid" };
  if (!isIsoTimestamp(r.created_at)) return { kind: "invalid" };
  if (!isUuid(r.claim_token)) return { kind: "invalid" };

  return {
    kind: "claimed",
    claim: {
      id: r.id,
      signalKind: r.signal_kind,
      recipientScope: r.recipient_scope,
      recipientEmail: r.recipient_email,
      occurrenceCount: r.occurrence_count,
      createdAt: r.created_at,
      claimToken: r.claim_token,
    },
  };
}

// Content restriction (docs/operational-alerting.md section 4): a generic
// body only. Never the work item id, conversation id, pet/owner name,
// phone number, message text, or clinical reason.
const CLINIC_SIGNAL_COPY: Partial<Record<string, { subject: string; urgency: "acil" | "normal" }>> = {
  delivery_failure: { subject: "VetAI: teslim edilemeyen bir mesaj var", urgency: "normal" },
  human_handoff_urgent: { subject: "VetAI: acil bir personel devri var", urgency: "acil" },
  human_handoff_normal: { subject: "VetAI: bekleyen bir personel devri var", urgency: "normal" },
  intake_dead_letter: { subject: "VetAI: degerlendirilmemis bir personel devri var", urgency: "normal" },
};

function clinicAlertCopy(signalKind: string, loginUrl: string): { subject: string; text: string } | null {
  const entry = CLINIC_SIGNAL_COPY[signalKind];
  if (!entry) return null;
  return { subject: entry.subject, text: `Kliniginizde acik bir ${entry.urgency} is var. Gormek icin: ${loginUrl}` };
}

// No new Env var: Worker item 1's allowed-Env list has no admin-URL entry,
// so the admin link is the same configured origin as STAFF_LOGIN_URL with
// its path replaced -- both pages are served by this same Worker.
function adminUrlFrom(staffLoginUrl: string): string {
  return new URL("/admin", staffLoginUrl).toString();
}

// Row 9 / section 7 open owner+KVKK decision: defaults to the no-clinic-
// identifier option (signal class + aggregate count/time only) until KVKK
// approves including a bare clinic UUID.
function platformAlertCopy(
  signalKind: string,
  deploymentName: string,
  occurrenceCount: number,
  createdAt: string,
  adminUrl: string,
): { subject: string; text: string } {
  return {
    subject: `VetAI platform sinyali (${deploymentName}): ${signalKind}`,
    text: `Sinyal: ${signalKind}. Ortam: ${deploymentName}. Tekrar sayisi: ${occurrenceCount}. Ilk kayit: ${createdAt}. Detaylar icin: ${adminUrl}`,
  };
}

async function sendAlertEmail(claim: AlertClaim, env: Env): Promise<boolean> {
  if (!hasResendConfig(env) || !hasStaffLoginUrl(env)) return false;

  let copy: { subject: string; text: string } | null;
  if (claim.recipientScope === "clinic") {
    copy = clinicAlertCopy(claim.signalKind, env.STAFF_LOGIN_URL);
  } else {
    if (!hasDeploymentName(env)) return false;
    copy = platformAlertCopy(claim.signalKind, env.DEPLOYMENT_NAME, claim.occurrenceCount, claim.createdAt, adminUrlFrom(env.STAFF_LOGIN_URL));
  }
  if (!copy) return false;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "idempotency-key": claim.id,
      },
      body: JSON.stringify({ from: env.RESEND_FROM_ADDRESS, to: [claim.recipientEmail], subject: copy.subject, text: copy.text }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    // Task 053 Codex review item 4: any 2xx was previously accepted
    // unconditionally -- validate Resend's documented success body (a
    // non-empty string `id`) instead of trusting the status code alone.
    const parsed = (await response.json()) as { id?: unknown };
    return typeof parsed.id === "string" && parsed.id.length > 0;
  } catch {
    return false;
  }
}

async function drainAlertDeliveries(env: Env): Promise<StageResult> {
  // Keep this guard independent of the outer monitor gate so a future caller
  // cannot claim work unless every value needed by either clinic or platform
  // mail is usable.
  if (!isAlertingConfigured(env)) return "unavailable";

  for (let i = 0; i < MAX_ALERT_ROWS_PER_RUN; i++) {
    const claimResult = readAlertClaim(await callSupabaseRpc(env, "claim_alert_delivery", {}));
    if (claimResult.kind === "empty") return "success";
    if (claimResult.kind === "invalid") return "unavailable";

    const claim = claimResult.claim;
    const sent = await sendAlertEmail(claim, env);
    if (sent) {
      const accept = firstResultField(await callSupabaseRpc(env, "accept_alert_delivery", { p_id: claim.id, p_claim_token: claim.claimToken }), "result");
      // Task 053 Codex re-review item 8: the email was already sent -- a
      // stale_claim/not_found (or any other unrecognized) accept result
      // means that send was never durably recorded, which must not be
      // reported as a successful drain tick.
      if (accept === "accepted" || accept === "already_accepted") continue;
      return "unavailable";
    }

    // Never the provider's raw error body -- a fixed, short reason only.
    // Task 053 Codex review item 1: a Resend failure only counts as a
    // completed check once its fixed failure outcome is durably recorded;
    // an unrecognized/missing release result suppresses the heartbeat.
    // Task 053 Codex second re-review item 1: stale_claim/not_found mean
    // the failure was never durably recorded either -- treat them the same
    // as an unrecognized result, not as a completed release.
    const release = firstResultField(
      await callSupabaseRpc(env, "release_alert_delivery", { p_id: claim.id, p_claim_token: claim.claimToken, p_failure_reason: "send_failed" }),
      "result",
    );
    if (release === "retrying" || release === "exhausted" || release === "already_terminal") continue;
    return "unavailable";
  }
  return "success";
}
