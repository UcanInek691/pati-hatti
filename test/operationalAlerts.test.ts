import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { IntakeQueueMessage } from "../src/intakeQueue";

function stubQueue(): Queue<IntakeQueueMessage> {
  return { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue<IntakeQueueMessage>;
}

const baseEnv: Env = {
  APP_TIMEZONE: "Europe/Istanbul",
  WHATSAPP_VERIFY_TOKEN: "secret-token",
  WHATSAPP_APP_SECRET: "test-app-secret",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "unused",
  SUPABASE_ANON_KEY: "unused-anon-key",
  OPENAI_API_KEY: "unused",
  INTAKE_QUEUE: stubQueue(),
  WHATSAPP_ACCOUNT_CREDENTIALS_JSON: "[]",
  WHATSAPP_GRAPH_API_VERSION: "v25.0",
};

const enabledEnv: Env = { ...baseEnv, OPERATIONAL_ALERTS_ENABLED: "true" };

// Every value below uses the RFC 2606 .test TLD / -test- convention: none
// of it is a real Resend/Cloudflare/Supabase identifier. RESEND_FROM_ADDRESS
// and STAFF_LOGIN_URL specifically must NOT use .invalid here: that TLD is
// reserved for the unconfigured-placeholder fixtures below (isNonReservedTldString
// rejects it while alerting is enabled).
const fullEnv: Env = {
  ...enabledEnv,
  RESEND_API_KEY: "resend-test-key",
  RESEND_FROM_ADDRESS: "alerts@vetai-alerts.test",
  STAFF_LOGIN_URL: "https://portal.vetai-portal.test/staff",
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  CLOUDFLARE_ALERTS_MONITORING_TOKEN: "cf-monitoring-test-token",
  DEPLOYMENT_NAME: "staging",
  INTAKE_QUEUE_NAME: "vetai-intake-staging",
  INTAKE_DLQ_NAME: "vetai-intake-dlq-staging",
  INTAKE_TERMINAL_DLQ_NAME: "vetai-intake-terminal-dlq-staging",
};

const QUEUE_LIST = [
  { queue_id: "qid-intake", queue_name: "vetai-intake-staging" },
  { queue_id: "qid-dlq", queue_name: "vetai-intake-dlq-staging" },
  { queue_id: "qid-term", queue_name: "vetai-intake-terminal-dlq-staging" },
];

const CLINIC_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLINIC_RECIPIENT_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORK_ITEM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLATFORM_RECIPIENT_USER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

// Exactly the 10 columns claim_alert_delivery() returns (Task 053 migration).
const CLINIC_CLAIM_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  signal_kind: "delivery_failure",
  recipient_scope: "clinic",
  clinic_id: CLINIC_ID,
  recipient_user_id: CLINIC_RECIPIENT_USER_ID,
  work_item_id: WORK_ITEM_ID,
  recipient_email: "clinic-staff@vetai-clinic.invalid",
  occurrence_count: 1,
  created_at: "2026-09-05T10:00:00.000Z",
  claim_token: "22222222-2222-4222-8222-222222222222",
};

const PLATFORM_CLAIM_ROW = {
  id: "33333333-3333-4333-8333-333333333333",
  signal_kind: "queue_backlog",
  recipient_scope: "platform",
  clinic_id: null,
  recipient_user_id: PLATFORM_RECIPIENT_USER_ID,
  work_item_id: null,
  recipient_email: "platform-admin@vetai-admin.invalid",
  occurrence_count: 3,
  created_at: "2026-09-05T09:00:00.000Z",
  claim_token: "44444444-4444-4444-8444-444444444444",
};

// Module-level caches (queueIdCache, primaryBacklogHistory) must not leak
// between tests, same convention as readiness.test.ts's loadCheckReadiness.
async function loadOperationalAlerts() {
  vi.resetModules();
  return import("../src/operationalAlerts");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
}

function bodyOf(call: [RequestInfo | URL, RequestInit?]): unknown {
  return JSON.parse(call[1]!.body as string);
}

type FetchCall = [RequestInfo | URL, RequestInit?];

type FetchOverrides = {
  queues?: Array<{ queue_id: string; queue_name: string }>;
  queuesOk?: boolean;
  metrics?: Record<string, { backlogCount: number; backlogBytes?: number; ageMs?: number | null; rawOldestMs?: number }>;
  claims?: unknown[];
  acceptResult?: string;
  releaseResult?: string;
  insertedCount?: number;
  reopenedCount?: number;
  platformSignalResult?: string;
  resendBody?: unknown;
  telemetry?: unknown;
  telemetryStatus?: number;
};

function telemetryResponse(statusCounts: ReadonlyArray<readonly [number, number]> = []): unknown {
  const statistics = { elapsed: 0.01, rows_read: 100, bytes_read: 1_000, abr_level: 1 };
  return {
    success: true,
    errors: [],
    messages: [{ message: "Successful request" }],
    result: {
      run: {
        id: "telemetry-run-test-id",
        query: {
          parameters: {
            calculations: [],
            datasets: [],
            filterCombination: "and",
            filters: [],
            groupBys: [],
            limit: 500,
          },
        },
        accountId: "0123456789abcdef0123456789abcdef",
        timeframe: {},
        userId: "telemetry-user-test-id",
        status: "COMPLETED",
        granularity: 30_000,
        dry: true,
        statistics,
      },
      calculations: [
        {
          alias: "request_count",
          calculation: "count",
          aggregates: statusCounts.map(([status, count]) => ({
            groups: [{ key: "$workers.event.response.status", value: status }],
            groupKey: String(status),
            value: count,
            interval: 1,
            sampleInterval: 1,
            count,
          })),
          series: [],
        },
      ],
      statistics,
    },
  };
}

function backlogSignalQueueIds(fetchMock: ReturnType<typeof vi.fn>): (string | null)[] {
  return (fetchMock.mock.calls as FetchCall[])
    .filter((c) => urlOf(c[0]).includes("/rpc/record_platform_signal"))
    .map((c) => bodyOf(c) as { p_signal_kind: string; p_queue_id: string | null })
    .filter((b) => b.p_signal_kind === "queue_backlog")
    .map((b) => b.p_queue_id);
}

function metricsFor(
  primary: { backlogCount: number; ageMs?: number | null },
  dlqBacklogCount: number,
  terminal: { backlogCount: number; ageMs?: number | null },
): FetchOverrides["metrics"] {
  return {
    "qid-intake": { backlogCount: primary.backlogCount, ageMs: primary.ageMs ?? null },
    "qid-dlq": { backlogCount: dlqBacklogCount },
    "qid-term": { backlogCount: terminal.backlogCount, ageMs: terminal.ageMs ?? null },
  };
}

// A single routed fetch stand-in for every endpoint operationalAlerts.ts
// calls (Supabase RPC, Cloudflare Queues, Cloudflare Observability, Resend),
// keyed by URL substring so each test only needs to set the fields it cares
// about. `claims` is served one row per call, in order; once exhausted it
// returns zero rows (claim_alert_delivery's real empty-result shape).
function buildFetchMock(overrides: FetchOverrides = {}) {
  let claimCallIndex = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);

    if (url.includes("/workers/observability/telemetry/query")) {
      return jsonResponse(overrides.telemetry ?? telemetryResponse(), overrides.telemetryStatus ?? 200);
    }
    if (url.includes("/queues/") && url.includes("/metrics")) {
      const queueId = url.split("/queues/")[1]!.split("/metrics")[0]!;
      const m = overrides.metrics?.[queueId];
      if (!m) return jsonResponse({ result: { backlog_count: 0, backlog_bytes: 0, oldest_message_timestamp_ms: null } });
      return jsonResponse({
        result: {
          backlog_count: m.backlogCount,
          backlog_bytes: m.backlogBytes ?? 0,
          oldest_message_timestamp_ms: m.rawOldestMs ?? (m.ageMs == null ? null : Date.now() - m.ageMs),
        },
      });
    }
    if (url.endsWith("/queues")) {
      if (overrides.queuesOk === false) return new Response("", { status: 500 });
      return jsonResponse({ result: overrides.queues ?? [] });
    }
    if (url.includes("/rpc/claim_alert_delivery")) {
      const claims = overrides.claims ?? [];
      const row = claimCallIndex < claims.length ? claims[claimCallIndex] : undefined;
      claimCallIndex++;
      return jsonResponse(row === undefined ? [] : [row]);
    }
    if (url.includes("/rpc/accept_alert_delivery")) {
      return jsonResponse([{ result: overrides.acceptResult ?? "accepted" }]);
    }
    if (url.includes("/rpc/release_alert_delivery")) {
      return jsonResponse([{ result: overrides.releaseResult ?? "retrying" }]);
    }
    if (url.includes("/rpc/sync_alert_delivery_candidates")) {
      return jsonResponse([{ inserted_count: overrides.insertedCount ?? 0 }]);
    }
    if (url.includes("/rpc/schedule_alert_repeat_notifications")) {
      return jsonResponse([{ reopened_count: overrides.reopenedCount ?? 0 }]);
    }
    if (url.includes("/rpc/record_platform_signal")) {
      return jsonResponse([{ result: overrides.platformSignalResult ?? "recorded" }]);
    }
    if (url.includes("/rpc/")) {
      return jsonResponse([{ result: "recorded" }]);
    }
    if (url.includes("api.resend.com/emails")) {
      return jsonResponse(overrides.resendBody ?? { id: "re_default-test-id" });
    }
    return new Response("", { status: 500 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("recordOpenAiExtractionFailureSignal", () => {
  it("makes no call when alerting is disabled", async () => {
    const { recordOpenAiExtractionFailureSignal } = await loadOperationalAlerts();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await recordOpenAiExtractionFailureSignal(baseEnv);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records a platform signal with a null queue id when enabled", async () => {
    const { recordOpenAiExtractionFailureSignal } = await loadOperationalAlerts();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "recorded" }]));
    vi.stubGlobal("fetch", fetchMock);

    await recordOpenAiExtractionFailureSignal(enabledEnv);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as FetchCall;
    expect(urlOf(call[0])).toContain("/rpc/record_platform_signal");
    expect(bodyOf(call)).toEqual({ p_signal_kind: "openai_extraction_failure", p_queue_id: null });
  });
});

describe("checkAlertMonitorHeartbeat", () => {
  it("returns enabled:false and makes no call when disabled", async () => {
    const { checkAlertMonitorHeartbeat } = await loadOperationalAlerts();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkAlertMonitorHeartbeat(baseEnv)).resolves.toEqual({ enabled: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed to fresh:false without any RPC call when the flag is on but the rest of config is missing (Task 053 Codex review item 1)", async () => {
    const { checkAlertMonitorHeartbeat } = await loadOperationalAlerts();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkAlertMonitorHeartbeat(enabledEnv)).resolves.toEqual({ enabled: true, fresh: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns fresh:true when fully configured and the RPC reports the heartbeat as fresh", async () => {
    const { checkAlertMonitorHeartbeat } = await loadOperationalAlerts();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ fresh: true }])));

    await expect(checkAlertMonitorHeartbeat(fullEnv)).resolves.toEqual({ enabled: true, fresh: true });
  });

  it("fails closed to fresh:false without any RPC call when a queue name is missing (Task 053 Codex re-review item 5)", async () => {
    const { checkAlertMonitorHeartbeat } = await loadOperationalAlerts();
    const envMissingQueueName: Env = { ...fullEnv, INTAKE_TERMINAL_DLQ_NAME: undefined };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkAlertMonitorHeartbeat(envMissingQueueName)).resolves.toEqual({ enabled: true, fresh: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed to fresh:false without any RPC call when two queue names collide (Task 053 Codex re-review item 5)", async () => {
    const { checkAlertMonitorHeartbeat } = await loadOperationalAlerts();
    const envDuplicateQueueName: Env = { ...fullEnv, INTAKE_DLQ_NAME: fullEnv.INTAKE_QUEUE_NAME };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkAlertMonitorHeartbeat(envDuplicateQueueName)).resolves.toEqual({ enabled: true, fresh: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["RESEND_FROM_ADDRESS", "STAFF_LOGIN_URL"] as const)(
    "fails closed to fresh:false without any RPC call when %s uses the .invalid TLD (Task 053 Codex re-review item 5)",
    async (field) => {
      const { checkAlertMonitorHeartbeat } = await loadOperationalAlerts();
      const envWithInvalidTld: Env = {
        ...fullEnv,
        [field]: field === "STAFF_LOGIN_URL" ? "https://portal.vetai-portal.invalid/staff" : "alerts@vetai-alerts.invalid",
      };
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(checkAlertMonitorHeartbeat(envWithInvalidTld)).resolves.toEqual({ enabled: true, fresh: false });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("returns fresh:false when the RPC reports the heartbeat as stale", async () => {
    const { checkAlertMonitorHeartbeat } = await loadOperationalAlerts();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ fresh: false }])));

    await expect(checkAlertMonitorHeartbeat(fullEnv)).resolves.toEqual({ enabled: true, fresh: false });
  });

  it("fails closed to fresh:false on a malformed RPC response shape", async () => {
    const { checkAlertMonitorHeartbeat } = await loadOperationalAlerts();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ not: "an array" })));

    await expect(checkAlertMonitorHeartbeat(fullEnv)).resolves.toEqual({ enabled: true, fresh: false });
  });

  it("fails closed to fresh:false when the RPC call itself fails", async () => {
    const { checkAlertMonitorHeartbeat } = await loadOperationalAlerts();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));

    await expect(checkAlertMonitorHeartbeat(fullEnv)).resolves.toEqual({ enabled: true, fresh: false });
  });
});

describe("runOperationalAlertMonitor", () => {
  it("makes no fetch calls at all when alerting is disabled", async () => {
    const { runOperationalAlertMonitor } = await loadOperationalAlerts();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runOperationalAlertMonitor(baseEnv);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs sync, repeat scheduling and the claim drain in that relative order", async () => {
    const { runOperationalAlertMonitor } = await loadOperationalAlerts();
    const fetchMock = buildFetchMock({ claims: [] });
    vi.stubGlobal("fetch", fetchMock);

    await runOperationalAlertMonitor(fullEnv);

    const urls = fetchMock.mock.calls.map((call) => urlOf(call[0] as RequestInfo | URL));
    const syncIndex = urls.findIndex((u) => u.includes("/rpc/sync_alert_delivery_candidates"));
    const repeatIndex = urls.findIndex((u) => u.includes("/rpc/schedule_alert_repeat_notifications"));
    const claimIndex = urls.findIndex((u) => u.includes("/rpc/claim_alert_delivery"));

    expect(syncIndex).toBeGreaterThan(-1);
    expect(repeatIndex).toBeGreaterThan(syncIndex);
    expect(claimIndex).toBeGreaterThan(repeatIndex);
  });

  it("records the heartbeat when queue backlog, verified telemetry, sync, repeat scheduling and the drain all succeed", async () => {
    const { runOperationalAlertMonitor } = await loadOperationalAlerts();
    const fetchMock = buildFetchMock({
      queues: QUEUE_LIST,
      metrics: metricsFor({ backlogCount: 0, ageMs: 0 }, 0, { backlogCount: 0 }),
      claims: [],
    });
    vi.stubGlobal("fetch", fetchMock);

    await runOperationalAlertMonitor(fullEnv);

    expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/record_alert_monitor_heartbeat"))).toBe(true);
  });

  describe("queue backlog (docs/operational-alerting.md section 1 rows 3-5; Task 053 Codex review item 2)", () => {
    it("returns unavailable when a firing threshold cannot be recorded because no platform recipient is enabled", async () => {
      const { checkQueueBacklogs } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({
        queues: QUEUE_LIST,
        metrics: metricsFor({ backlogCount: 1, ageMs: 6 * 60_000 }, 0, { backlogCount: 0 }),
        platformSignalResult: "no_recipients",
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(checkQueueBacklogs(fullEnv)).resolves.toBe("unavailable");
      expect(backlogSignalQueueIds(fetchMock)).toEqual(["qid-intake"]);
    });

    it("alerts the primary queue when the oldest message is older than 5 minutes", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({
        queues: QUEUE_LIST,
        metrics: metricsFor({ backlogCount: 1, ageMs: 6 * 60_000 }, 0, { backlogCount: 0 }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      expect(backlogSignalQueueIds(fetchMock)).toEqual(["qid-intake"]);
    });

    it.each([0, -1])(
      "treats an oldest_message_timestamp_ms of %i as unknown age, not as a message stranded since the epoch (Task 053 Codex re-review item 4)",
      async (rawOldestMs) => {
        const { runOperationalAlertMonitor } = await loadOperationalAlerts();
        const fetchMock = buildFetchMock({
          queues: QUEUE_LIST,
          metrics: {
            "qid-intake": { backlogCount: 1, rawOldestMs },
            "qid-dlq": { backlogCount: 0 },
            "qid-term": { backlogCount: 0 },
          },
        });
        vi.stubGlobal("fetch", fetchMock);

        await runOperationalAlertMonitor(fullEnv);

        expect(backlogSignalQueueIds(fetchMock)).toEqual([]);
      },
    );

    it("does not alert the primary queue on a single measurement under the age threshold with a flat backlog", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({
        queues: QUEUE_LIST,
        metrics: metricsFor({ backlogCount: 5, ageMs: 60_000 }, 0, { backlogCount: 0 }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      expect(backlogSignalQueueIds(fetchMock)).toEqual([]);
    });

    it("alerts the primary queue once backlog_count rises for 3 consecutive measurements, even with age unknown", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      let lastFetchMock: ReturnType<typeof buildFetchMock> | undefined;
      for (const count of [5, 7, 9]) {
        const fetchMock = buildFetchMock({ queues: QUEUE_LIST, metrics: metricsFor({ backlogCount: count, ageMs: null }, 0, { backlogCount: 0 }) });
        vi.stubGlobal("fetch", fetchMock);
        await runOperationalAlertMonitor(fullEnv);
        lastFetchMock = fetchMock;
      }
      expect(backlogSignalQueueIds(lastFetchMock!)).toEqual(["qid-intake"]);
    });

    it("does not alert the primary queue on a rising-then-falling backlog", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      let lastFetchMock: ReturnType<typeof buildFetchMock> | undefined;
      for (const count of [5, 9, 7]) {
        const fetchMock = buildFetchMock({ queues: QUEUE_LIST, metrics: metricsFor({ backlogCount: count, ageMs: null }, 0, { backlogCount: 0 }) });
        vi.stubGlobal("fetch", fetchMock);
        await runOperationalAlertMonitor(fullEnv);
        lastFetchMock = fetchMock;
      }
      expect(backlogSignalQueueIds(lastFetchMock!)).toEqual([]);
    });

    it("alerts the DLQ whenever backlog_count is greater than zero, regardless of age (Task 053 Codex review item 2)", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({ queues: QUEUE_LIST, metrics: metricsFor({ backlogCount: 0, ageMs: 0 }, 3, { backlogCount: 0 }) });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      expect(backlogSignalQueueIds(fetchMock)).toEqual(["qid-dlq"]);
    });

    it("reports unavailable (not success) when the DLQ threshold fires but record_platform_signal fails to durably record it (Task 053 Codex re-review item 6)", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const routed = buildFetchMock({ queues: QUEUE_LIST, metrics: metricsFor({ backlogCount: 0, ageMs: 0 }, 3, { backlogCount: 0 }) });
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (urlOf(input).includes("/rpc/record_platform_signal")) return new Response("", { status: 500 });
        return routed(input, init);
      });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/record_alert_monitor_heartbeat"))).toBe(false);
    });

    it("does not alert the DLQ when backlog_count is exactly zero", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({ queues: QUEUE_LIST, metrics: metricsFor({ backlogCount: 0, ageMs: 0 }, 0, { backlogCount: 0 }) });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      expect(backlogSignalQueueIds(fetchMock)).toEqual([]);
    });

    it("alerts the terminal DLQ only once backlog_count>0 AND the oldest message is older than the 12h floor (docs section 3)", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({
        queues: QUEUE_LIST,
        metrics: metricsFor({ backlogCount: 0, ageMs: 0 }, 0, { backlogCount: 1, ageMs: 13 * 60 * 60_000 }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      expect(backlogSignalQueueIds(fetchMock)).toEqual(["qid-term"]);
    });

    it("does not alert the terminal DLQ when it has backlog but is still under the 12h floor", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({
        queues: QUEUE_LIST,
        metrics: metricsFor({ backlogCount: 0, ageMs: 0 }, 0, { backlogCount: 1, ageMs: 60 * 60_000 }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      expect(backlogSignalQueueIds(fetchMock)).toEqual([]);
    });

    it("does not alert the terminal DLQ when it is old but empty", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({
        queues: QUEUE_LIST,
        metrics: metricsFor({ backlogCount: 0, ageMs: 0 }, 0, { backlogCount: 0, ageMs: 20 * 60 * 60_000 }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      expect(backlogSignalQueueIds(fetchMock)).toEqual([]);
    });

    it("fails closed (no crash, no false alert) when one queue's metrics response is missing backlog_count, while still evaluating the others", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const routed = buildFetchMock({
        queues: QUEUE_LIST,
        metrics: metricsFor({ backlogCount: 0, ageMs: 0 }, 0, { backlogCount: 1, ageMs: 20 * 60 * 60_000 }),
      });
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (urlOf(input).includes("/queues/qid-dlq/metrics")) return jsonResponse({ result: { backlog_bytes: 0 } });
        return routed(input, init);
      });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      expect(backlogSignalQueueIds(fetchMock)).toEqual(["qid-term"]);
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
      "fails closed for a single queue when its backlog_count is %s, while still evaluating the others (Task 053 Codex re-review item 4)",
      async (backlogCount) => {
        const { runOperationalAlertMonitor } = await loadOperationalAlerts();
        const routed = buildFetchMock({
          queues: QUEUE_LIST,
          metrics: metricsFor({ backlogCount: 0, ageMs: 0 }, 0, { backlogCount: 1, ageMs: 20 * 60 * 60_000 }),
        });
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (urlOf(input).includes("/queues/qid-dlq/metrics")) return jsonResponse({ result: { backlog_count: backlogCount, backlog_bytes: 0 } });
          return routed(input, init);
        });
        vi.stubGlobal("fetch", fetchMock);

        await runOperationalAlertMonitor(fullEnv);

        expect(backlogSignalQueueIds(fetchMock)).toEqual(["qid-term"]);
      },
    );

    it("skips the whole check when Cloudflare monitoring config is missing", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({ queues: [{ queue_id: "qid-intake", queue_name: "vetai-intake-staging" }], metrics: { "qid-intake": { backlogCount: 999 } } });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(enabledEnv);

      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).endsWith("/queues"))).toBe(false);
    });

    it("fails closed on an ambiguous queue-name match instead of guessing which id is real (Task 053 Worker item 3)", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({
        queues: [
          { queue_id: "qid-real", queue_name: "vetai-intake-staging" },
          { queue_id: "qid-decoy", queue_name: "vetai-intake-staging" },
          { queue_id: "qid-dlq", queue_name: "vetai-intake-dlq-staging" },
        ],
        metrics: { "qid-real": { backlogCount: 999 }, "qid-decoy": { backlogCount: 999 }, "qid-dlq": { backlogCount: 999 } },
      });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      const urls = fetchMock.mock.calls.map((c) => urlOf(c[0] as RequestInfo | URL));
      expect(urls.some((u) => u.includes("/metrics"))).toBe(false);
      expect(urls.some((u) => u.includes("/rpc/record_platform_signal"))).toBe(false);
    });

    it("fails closed without listing queues when two of the three configured queue names collide (Task 053 Codex re-review item 5)", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const envWithDuplicateNames: Env = { ...fullEnv, INTAKE_DLQ_NAME: fullEnv.INTAKE_QUEUE_NAME };
      const fetchMock = buildFetchMock({ queues: QUEUE_LIST, metrics: metricsFor({ backlogCount: 999, ageMs: 999 * 60_000 }, 999, { backlogCount: 999 }) });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(envWithDuplicateNames);

      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).endsWith("/queues"))).toBe(false);
    });

    it("fails closed entirely (no queue checked) when any one of the three configured queue names fails to resolve (Task 053 Codex review item 2)", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({
        queues: [QUEUE_LIST[0]!, QUEUE_LIST[2]!],
        metrics: metricsFor({ backlogCount: 999, ageMs: 999 * 60_000 }, 999, { backlogCount: 999, ageMs: 999 * 60_000 }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      const urls = fetchMock.mock.calls.map((c) => urlOf(c[0] as RequestInfo | URL));
      expect(urls.some((u) => u.includes("/metrics"))).toBe(false);
      expect(backlogSignalQueueIds(fetchMock)).toEqual([]);
    });

    it("does not cache a failed partial queue-name resolution across ticks (Task 053 Codex review item 2)", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();

      const partialFetchMock = buildFetchMock({ queues: [QUEUE_LIST[0]!, QUEUE_LIST[2]!], claims: [] });
      vi.stubGlobal("fetch", partialFetchMock);
      await runOperationalAlertMonitor(fullEnv);
      expect(partialFetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("/metrics"))).toBe(false);

      const fullFetchMock = buildFetchMock({
        queues: QUEUE_LIST,
        metrics: metricsFor({ backlogCount: 0, ageMs: 0 }, 0, { backlogCount: 0 }),
        claims: [],
      });
      vi.stubGlobal("fetch", fullFetchMock);
      await runOperationalAlertMonitor(fullEnv);
      expect(fullFetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).endsWith("/queues"))).toBe(true);
    });

    it("fails closed when the queue-list request itself is not ok", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({ queuesOk: false });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      const urls = fetchMock.mock.calls.map((c) => urlOf(c[0] as RequestInfo | URL));
      expect(urls.some((u) => u.includes("/metrics"))).toBe(false);
      expect(urls.some((u) => u.includes("/rpc/record_platform_signal"))).toBe(false);
    });
  });

  describe("verified webhook telemetry (Task 054 Phase A)", () => {
    function webhookSignalKinds(fetchMock: ReturnType<typeof vi.fn>): string[] {
      return (fetchMock.mock.calls as FetchCall[])
        .filter((c) => urlOf(c[0]).includes("/rpc/record_platform_signal"))
        .map((c) => (bodyOf(c) as { p_signal_kind: string }).p_signal_kind)
        .filter((kind) => kind === "webhook_401" || kind === "webhook_5xx");
    }

    it("queries only the staging Worker POST webhook aggregate over a bounded window without raw event fields", async () => {
      vi.useFakeTimers();
      vi.setSystemTime("2026-09-07T00:06:42.000Z");
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({});
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      const call = (fetchMock.mock.calls as FetchCall[]).find((c) => urlOf(c[0]).includes("/workers/observability/telemetry/query"));
      expect(call).toBeDefined();
      expect(urlOf(call![0])).toBe(
        "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/workers/observability/telemetry/query",
      );
      expect(call![1]?.method).toBe("POST");
      expect(call![1]?.signal).toBeInstanceOf(AbortSignal);
      expect(timeoutSpy).toHaveBeenCalledWith(10_000);
      const query = bodyOf(call!) as Record<string, any>;
      expect(query.timeframe).toEqual({
        from: Date.parse("2026-09-07T00:01:00.000Z"),
        to: Date.parse("2026-09-07T00:04:00.000Z"),
      });
      expect(query).toMatchObject({ view: "calculations", chart: false, chartType: "aggregate", dry: true, ignoreSeries: true });
      expect(query.parameters).toEqual({
        calculations: [{ operator: "count", alias: "request_count" }],
        datasets: [],
        filterCombination: "and",
        filters: [
          { key: "$workers.scriptName", operation: "eq", type: "string", value: "vetai-staging" },
          { key: "$metadata.origin", operation: "eq", type: "string", value: "fetch" },
          { key: "$workers.eventType", operation: "eq", type: "string", value: "fetch" },
          { key: "$workers.event.request.method", operation: "eq", type: "string", value: "POST" },
          { key: "$workers.event.path", operation: "eq", type: "string", value: "/webhooks/whatsapp" },
        ],
        groupBys: [{ type: "number", value: "$workers.event.response.status" }],
        limit: 500,
      });
      expect(JSON.stringify(query)).not.toMatch(/body|header|signature|phone|message|token|challenge|email/i);
    });

    it("treats a verified empty aggregate as a healthy zero and advances the heartbeat", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({
        telemetry: telemetryResponse(),
        queues: QUEUE_LIST,
        metrics: metricsFor({ backlogCount: 0, ageMs: 0 }, 0, { backlogCount: 0 }),
        claims: [],
      });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      expect(webhookSignalKinds(fetchMock)).toEqual([]);
      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/record_alert_monitor_heartbeat"))).toBe(true);
    });

    it.each([
      ["401 only", [[401, 2]], ["webhook_401"]],
      ["5xx only", [[503, 3]], ["webhook_5xx"]],
      ["mixed", [[200, 7], [401, 2], [500, 1], [503, 3]], ["webhook_401", "webhook_5xx"]],
    ] as const)("records exactly the required platform signal for %s", async (_label, statusCounts, expected) => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({ telemetry: telemetryResponse(statusCounts), claims: [] });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      expect(webhookSignalKinds(fetchMock)).toEqual(expected);
    });

    it.each([
      ["top-level extra field", { ...(telemetryResponse() as Record<string, unknown>), extra: true }],
      ["missing calculations field", (() => { const v = structuredClone(telemetryResponse()) as any; delete v.result.calculations; return v; })()],
      ["incomplete run", (() => { const v = structuredClone(telemetryResponse()) as any; v.result.run.status = "RUNNING"; return v; })()],
      ["missing echoed datasets", (() => { const v = structuredClone(telemetryResponse()) as any; delete v.result.run.query.parameters.datasets; return v; })()],
      ["non-empty echoed datasets", (() => { const v = structuredClone(telemetryResponse()) as any; v.result.run.query.parameters.datasets = ["workers_trace_events"]; return v; })()],
      ["extra echoed query parameter", (() => { const v = structuredClone(telemetryResponse()) as any; v.result.run.query.parameters.raw = true; return v; })()],
      ["sampled run", (() => { const v = structuredClone(telemetryResponse([[401, 1]])) as any; v.result.statistics.abr_level = 2; return v; })()],
      ["sampled aggregate", (() => { const v = structuredClone(telemetryResponse([[401, 1]])) as any; v.result.calculations[0].aggregates[0].sampleInterval = 2; return v; })()],
      ["duplicate status group", telemetryResponse([[401, 1], [401, 1]])],
      ["ambiguous group key", (() => { const v = structuredClone(telemetryResponse([[401, 1]])) as any; v.result.calculations[0].aggregates[0].groupKey = "500"; return v; })()],
      ["count mismatch", (() => { const v = structuredClone(telemetryResponse([[500, 2]])) as any; v.result.calculations[0].aggregates[0].count = 1; return v; })()],
      ["wrong account", (() => { const v = structuredClone(telemetryResponse()) as any; v.result.run.accountId = "ffffffffffffffffffffffffffffffff"; return v; })()],
      ["out-of-range status", telemetryResponse([[600, 1]])],
      ["negative count", telemetryResponse([[401, -1]])],
      ["fractional count", telemetryResponse([[503, 1.5]])],
      ["unknown response field", (() => { const v = structuredClone(telemetryResponse([[500, 1]])) as any; v.result.calculations[0].aggregates[0].raw = "forbidden"; return v; })()],
    ])("fails closed for a malformed or ambiguous %s envelope", async (_label, telemetry) => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({ telemetry, claims: [] });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      expect(webhookSignalKinds(fetchMock)).toEqual([]);
      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/record_alert_monitor_heartbeat"))).toBe(false);
    });

    it("fails closed on a non-2xx telemetry response", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({ telemetryStatus: 429, claims: [] });
      vi.stubGlobal("fetch", fetchMock);
      await runOperationalAlertMonitor(fullEnv);
      expect(webhookSignalKinds(fetchMock)).toEqual([]);
      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/record_alert_monitor_heartbeat"))).toBe(false);
    });

    it("fails closed on invalid JSON", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const routed = buildFetchMock({ claims: [] });
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (urlOf(input).includes("/workers/observability/telemetry/query")) return new Response("not-json", { status: 200 });
        return routed(input, init);
      });
      vi.stubGlobal("fetch", fetchMock);
      await runOperationalAlertMonitor(fullEnv);
      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/record_alert_monitor_heartbeat"))).toBe(false);
    });

    it.each([new Error("network down"), new DOMException("timed out", "AbortError")])("fails closed on telemetry fetch rejection", async (error) => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const routed = buildFetchMock({ claims: [] });
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (urlOf(input).includes("/workers/observability/telemetry/query")) throw error;
        return routed(input, init);
      });
      vi.stubGlobal("fetch", fetchMock);
      await runOperationalAlertMonitor(fullEnv);
      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/record_alert_monitor_heartbeat"))).toBe(false);
    });

    it("fails closed when a required webhook signal has no enabled platform recipient", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({ telemetry: telemetryResponse([[401, 1]]), platformSignalResult: "no_recipients", claims: [] });
      vi.stubGlobal("fetch", fetchMock);
      await runOperationalAlertMonitor(fullEnv);
      expect(webhookSignalKinds(fetchMock)).toEqual(["webhook_401"]);
      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/record_alert_monitor_heartbeat"))).toBe(false);
    });

    it("fails closed when recording a required webhook signal returns non-2xx", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const routed = buildFetchMock({ telemetry: telemetryResponse([[503, 1]]), claims: [] });
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (urlOf(input).includes("/rpc/record_platform_signal")) return new Response("", { status: 500 });
        return routed(input, init);
      });
      vi.stubGlobal("fetch", fetchMock);
      await runOperationalAlertMonitor(fullEnv);
      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/record_alert_monitor_heartbeat"))).toBe(false);
    });

    it("does not query telemetry for an unknown deployment name", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({});
      vi.stubGlobal("fetch", fetchMock);
      await runOperationalAlertMonitor({ ...fullEnv, DEPLOYMENT_NAME: "preview" });
      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("/workers/observability/telemetry/query"))).toBe(false);
    });

    it("does not call either Cloudflare API for a malformed account id", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({});
      vi.stubGlobal("fetch", fetchMock);
      await runOperationalAlertMonitor({ ...fullEnv, CLOUDFLARE_ACCOUNT_ID: "../wrong-account" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("never logs telemetry request or response data", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      vi.stubGlobal("fetch", buildFetchMock({ telemetry: telemetryResponse([[401, 1], [503, 1]]), claims: [] }));
      await runOperationalAlertMonitor(fullEnv);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });
  });

  describe("claim validation (Task 053 Codex review item 4: exact-shape, fail-closed readAlertClaim)", () => {
    function deleteKey(row: Record<string, unknown>, key: string): Record<string, unknown> {
      const copy = { ...row };
      delete copy[key];
      return copy;
    }

    const invalidClaimCases: Array<[string, Record<string, unknown>]> = [
      ["an unrecognized recipient_scope instead of falling back to clinic", { ...CLINIC_CLAIM_ROW, recipient_scope: "unknown_scope" }],
      ["a clinic-scope row with a null clinic_id", { ...CLINIC_CLAIM_ROW, clinic_id: null }],
      ["a platform-scope row carrying a non-null clinic_id", { ...PLATFORM_CLAIM_ROW, clinic_id: CLINIC_ID }],
      ["a malformed id that is not a UUID", { ...CLINIC_CLAIM_ROW, id: "not-a-uuid" }],
      ["an out-of-enum signal_kind", { ...CLINIC_CLAIM_ROW, signal_kind: "unknown_kind" }],
      ["a malformed recipient_email", { ...CLINIC_CLAIM_ROW, recipient_email: "not-an-email" }],
      ["an unparseable created_at timestamp", { ...CLINIC_CLAIM_ROW, created_at: "not-a-date" }],
      ["a non-integer occurrence_count", { ...CLINIC_CLAIM_ROW, occurrence_count: 1.5 }],
      ["a zero occurrence_count", { ...CLINIC_CLAIM_ROW, occurrence_count: 0 }],
      ["an extra, undocumented column", { ...CLINIC_CLAIM_ROW, unexpected_extra_column: "x" }],
      ["a row missing recipient_user_id entirely", deleteKey(CLINIC_CLAIM_ROW, "recipient_user_id")],
      ["a row missing work_item_id entirely", deleteKey(CLINIC_CLAIM_ROW, "work_item_id")],
    ];

    it.each(invalidClaimCases)("rejects %s and stops the drain without sending mail", async (_label, row) => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({ claims: [row] });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("api.resend.com/emails"))).toBe(false);
      expect(fetchMock.mock.calls.filter((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/claim_alert_delivery"))).toHaveLength(1);
    });
  });

  describe("delivery drain / mail content", () => {
    it("skips the drain entirely when Resend isn't configured", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const envNoResend: Env = { ...fullEnv, RESEND_API_KEY: undefined, RESEND_FROM_ADDRESS: undefined };
      const fetchMock = buildFetchMock({ claims: [CLINIC_CLAIM_ROW] });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(envNoResend);

      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/claim_alert_delivery"))).toBe(false);
    });

    it("sends clinic-scope mail with a generic /staff link and no environment/count content, then accepts", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({ claims: [CLINIC_CLAIM_ROW], acceptResult: "accepted" });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      const resendCall = fetchMock.mock.calls.find((c) => urlOf(c[0] as RequestInfo | URL).includes("api.resend.com/emails")) as FetchCall;
      expect(resendCall).toBeDefined();
      const body = bodyOf(resendCall) as { to: string[]; text: string };
      expect(body.to).toEqual([CLINIC_CLAIM_ROW.recipient_email]);
      expect(body.text).toContain("/staff");
      expect(body.text).not.toContain("/admin");
      expect(body.text).not.toContain(String(CLINIC_CLAIM_ROW.occurrence_count));
      expect((resendCall[1] as RequestInit).headers).toMatchObject({ "idempotency-key": CLINIC_CLAIM_ROW.id });

      const acceptCall = fetchMock.mock.calls.find((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/accept_alert_delivery")) as FetchCall;
      expect(bodyOf(acceptCall)).toEqual({ p_id: CLINIC_CLAIM_ROW.id, p_claim_token: CLINIC_CLAIM_ROW.claim_token });
    });

    it("sends platform-scope mail with environment, aggregate count/time and a distinct /admin link, and no clinic identifier (Task 053 Worker item 6)", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({ claims: [PLATFORM_CLAIM_ROW], acceptResult: "accepted" });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      const resendCall = fetchMock.mock.calls.find((c) => urlOf(c[0] as RequestInfo | URL).includes("api.resend.com/emails")) as FetchCall;
      const body = bodyOf(resendCall) as { text: string };
      expect(body.text).toContain(fullEnv.DEPLOYMENT_NAME as string);
      expect(body.text).toContain(String(PLATFORM_CLAIM_ROW.occurrence_count));
      expect(body.text).toContain(PLATFORM_CLAIM_ROW.created_at);
      expect(body.text).toMatch(/\/admin\b/);
      expect(body.text).not.toContain("/staff");
    });

    it("does not claim or consume a delivery attempt when DEPLOYMENT_NAME is missing", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const envWithoutDeployment: Env = { ...fullEnv, DEPLOYMENT_NAME: undefined };
      const fetchMock = buildFetchMock({ claims: [PLATFORM_CLAIM_ROW], releaseResult: "retrying" });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(envWithoutDeployment);

      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("api.resend.com/emails"))).toBe(false);
      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/claim_alert_delivery"))).toBe(false);
      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/release_alert_delivery"))).toBe(false);
    });

    it.each([
      ["STAFF_LOGIN_URL", { STAFF_LOGIN_URL: "https://portal.vetai-portal.invalid/staff" }],
      ["a queue name", { INTAKE_DLQ_NAME: undefined }],
      ["Cloudflare monitoring", { CLOUDFLARE_ALERTS_MONITORING_TOKEN: undefined }],
    ] as const)("makes no calls and consumes no delivery attempt when %s is not configured", async (_label, missing) => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({ claims: [CLINIC_CLAIM_ROW] });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor({ ...fullEnv, ...missing });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("releases with a fixed send_failed reason when Resend itself reports failure", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const routed = buildFetchMock({ claims: [CLINIC_CLAIM_ROW], releaseResult: "retrying" });
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (urlOf(input).includes("api.resend.com/emails")) return new Response("", { status: 500 });
        return routed(input, init);
      });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      const releaseCall = fetchMock.mock.calls.find((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/release_alert_delivery")) as FetchCall;
      expect(releaseCall).toBeDefined();
      expect((bodyOf(releaseCall) as { p_failure_reason: string }).p_failure_reason).toBe("send_failed");
    });

    it("releases with a fixed send_failed reason when Resend's success response has no id field (Task 053 Codex review item 4)", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({ claims: [CLINIC_CLAIM_ROW], releaseResult: "retrying", resendBody: { object: "email" } });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      const releaseCall = fetchMock.mock.calls.find((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/release_alert_delivery")) as FetchCall;
      expect(releaseCall).toBeDefined();
      expect((bodyOf(releaseCall) as { p_failure_reason: string }).p_failure_reason).toBe("send_failed");
    });

    it("releases with a fixed send_failed reason when Resend's id field is an empty string", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({ claims: [CLINIC_CLAIM_ROW], releaseResult: "retrying", resendBody: { id: "" } });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      const releaseCall = fetchMock.mock.calls.find((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/release_alert_delivery")) as FetchCall;
      expect(releaseCall).toBeDefined();
      expect((bodyOf(releaseCall) as { p_failure_reason: string }).p_failure_reason).toBe("send_failed");
    });

    it("rejects a claim row missing the new occurrence_count/created_at fields and stops the drain", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const malformedRow: Record<string, unknown> = { ...CLINIC_CLAIM_ROW };
      delete malformedRow.occurrence_count;
      const fetchMock = buildFetchMock({ claims: [malformedRow] });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("api.resend.com/emails"))).toBe(false);
      expect(fetchMock.mock.calls.filter((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/claim_alert_delivery"))).toHaveLength(1);
    });

    it("stops the drain on an unexpected accept_alert_delivery result instead of looping forever", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({ claims: [CLINIC_CLAIM_ROW, CLINIC_CLAIM_ROW], acceptResult: "unexpected_value" });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      expect(fetchMock.mock.calls.filter((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/claim_alert_delivery"))).toHaveLength(1);
    });

    it.each(["stale_claim", "not_found"])(
      "does not treat a %s accept_alert_delivery result after a successful send as durably recorded (Task 053 Codex re-review item 8)",
      async (acceptResult) => {
        const { runOperationalAlertMonitor } = await loadOperationalAlerts();
        const fetchMock = buildFetchMock({ claims: [CLINIC_CLAIM_ROW, CLINIC_CLAIM_ROW], acceptResult });
        vi.stubGlobal("fetch", fetchMock);

        await runOperationalAlertMonitor(fullEnv);

        expect(fetchMock.mock.calls.filter((c) => urlOf(c[0] as RequestInfo | URL).includes("api.resend.com/emails"))).toHaveLength(1);
        expect(fetchMock.mock.calls.filter((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/claim_alert_delivery"))).toHaveLength(1);
        expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/record_alert_monitor_heartbeat"))).toBe(false);
      },
    );

    it("stops the drain on an unexpected release_alert_delivery result instead of reporting success (Task 053 Codex second re-review item 1)", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const fetchMock = buildFetchMock({
        claims: [CLINIC_CLAIM_ROW, CLINIC_CLAIM_ROW],
        releaseResult: "unexpected_value",
        resendBody: { object: "email" },
      });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      expect(fetchMock.mock.calls.filter((c) => urlOf(c[0] as RequestInfo | URL).includes("api.resend.com/emails"))).toHaveLength(1);
      expect(fetchMock.mock.calls.filter((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/claim_alert_delivery"))).toHaveLength(1);
      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/record_alert_monitor_heartbeat"))).toBe(false);
    });

    it.each(["stale_claim", "not_found"])(
      "does not treat a %s release_alert_delivery result after a failed send as durably recorded (Task 053 Codex second re-review item 1)",
      async (releaseResult) => {
        const { runOperationalAlertMonitor } = await loadOperationalAlerts();
        const fetchMock = buildFetchMock({
          claims: [CLINIC_CLAIM_ROW, CLINIC_CLAIM_ROW],
          releaseResult,
          resendBody: { object: "email" },
        });
        vi.stubGlobal("fetch", fetchMock);

        await runOperationalAlertMonitor(fullEnv);

        expect(fetchMock.mock.calls.filter((c) => urlOf(c[0] as RequestInfo | URL).includes("api.resend.com/emails"))).toHaveLength(1);
        expect(fetchMock.mock.calls.filter((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/claim_alert_delivery"))).toHaveLength(1);
        const releaseCall = fetchMock.mock.calls.find((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/release_alert_delivery")) as FetchCall;
        expect(releaseCall).toBeDefined();
        expect((bodyOf(releaseCall) as { p_failure_reason: string }).p_failure_reason).toBe("send_failed");
        expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/record_alert_monitor_heartbeat"))).toBe(false);
      },
    );

    it("drains multiple queued deliveries in one run", async () => {
      const { runOperationalAlertMonitor } = await loadOperationalAlerts();
      const secondRow = { ...PLATFORM_CLAIM_ROW, id: "55555555-5555-4555-8555-555555555555", claim_token: "66666666-6666-4666-8666-666666666666" };
      const fetchMock = buildFetchMock({ claims: [CLINIC_CLAIM_ROW, secondRow], acceptResult: "accepted" });
      vi.stubGlobal("fetch", fetchMock);

      await runOperationalAlertMonitor(fullEnv);

      expect(fetchMock.mock.calls.filter((c) => urlOf(c[0] as RequestInfo | URL).includes("api.resend.com/emails"))).toHaveLength(2);
      expect(fetchMock.mock.calls.filter((c) => urlOf(c[0] as RequestInfo | URL).includes("/rpc/claim_alert_delivery"))).toHaveLength(3);
    });
  });
});
