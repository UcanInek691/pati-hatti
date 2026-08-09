import { afterEach, describe, expect, it, vi } from "vitest";
import { processIntakeQueueMessage } from "../src/intakeConsumer";
import type { QueueDisposition } from "../src/intakeConsumer";
import * as intakeReplyModule from "../src/intakeReply";
import * as intakeTurnModule from "../src/intakeTurn";
import type { Env } from "../src/env";
import type { IntakeQueueMessage } from "../src/intakeQueue";

const CONVERSATION_ID = "11111111-1111-1111-1111-111111111111";
const PROVIDER_MESSAGE_ID = "wamid.ID1";
const CLAIM_TOKEN = "22222222-2222-2222-2222-222222222222";
const OWNER_ID = "33333333-3333-3333-3333-333333333333";
const OWNER_ID_2 = "44444444-4444-4444-4444-444444444444";
const CLINIC_ID = "55555555-5555-5555-5555-555555555555";
const PET_ID = "66666666-6666-6666-6666-666666666666";
const OWNER_NAME = "Ada Lovelace";
const MESSAGE_TEXT = "my cat has been vomiting since this morning";

const env: Env = {
  APP_TIMEZONE: "Europe/Istanbul",
  WHATSAPP_VERIFY_TOKEN: "secret-token",
  WHATSAPP_APP_SECRET: "test-app-secret",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  SUPABASE_ANON_KEY: "test-anon-key",
  OPENAI_API_KEY: "test-openai-key",
  INTAKE_QUEUE: { send: async () => {} } as unknown as Queue<IntakeQueueMessage>,
  WHATSAPP_ACCESS_TOKEN: "test-whatsapp-access-token",
  WHATSAPP_GRAPH_API_VERSION: "v25.0",
};

const validBody = { version: 1, conversationId: CONVERSATION_ID, providerMessageId: PROVIDER_MESSAGE_ID };

const ALL_FALSE_SIGNALS = {
  breathing_difficulty: false,
  loss_of_consciousness: false,
  active_seizure: false,
  heavy_bleeding: false,
  major_trauma: false,
  possible_toxin_exposure: false,
  possible_foreign_object: false,
  unable_to_urinate: false,
};

const ALL_NULL_SIGNALS = {
  breathing_difficulty: null,
  loss_of_consciousness: null,
  active_seizure: null,
  heavy_bleeding: null,
  major_trauma: null,
  possible_toxin_exposure: null,
  possible_foreign_object: null,
  unable_to_urinate: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function claimRow(result: "claimed" | "completed" | "busy" | "not_found", extra: { claim_token?: string; message_text?: string } = {}): Response {
  return jsonResponse([{ result, claim_token: extra.claim_token ?? null, message_text: extra.message_text ?? null }]);
}

function contextRow(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse([
    {
      conversation_id: CONVERSATION_ID,
      clinic_id: CLINIC_ID,
      owner_id: OWNER_ID,
      pet_id: null,
      status: "active",
      intake_stage: "safety_check",
      intake_data: {},
      state_version: 1,
      owner_name: OWNER_NAME,
      pets: [{ id: PET_ID, name: "Fluffy", species: "cat" }],
      recent_messages: [{ direction: "inbound", content: "OLD MESSAGE TEXT", created_at: "2026-01-01T00:00:00Z" }],
      ...overrides,
    },
  ]);
}

function extractionJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: "report_symptom",
    pet_name: null,
    species: null,
    complaint: "vomiting",
    symptoms: [],
    reported_safety_signals: ALL_FALSE_SIGNALS,
    missing_information: [],
    user_requested_human: false,
    ...overrides,
  };
}

function openAiResponse(extraction: Record<string, unknown>): Response {
  return jsonResponse({
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(extraction) }] }],
  });
}

function finalizeRow(
  result: "applied" | "already_completed" | "stale_claim" | "stale_state",
  extra: { intake_stage?: string; state_version?: number } = {},
): Response {
  if (result === "applied") {
    return jsonResponse([{ result, intake_stage: extra.intake_stage ?? "ready_for_triage", state_version: extra.state_version ?? 2 }]);
  }
  return jsonResponse([{ result, intake_stage: null, state_version: null }]);
}

type Routes = {
  claim?: () => Response;
  context?: () => Response;
  openai?: () => Response;
  finalize?: () => Response;
};

function routedFetch(routes: Routes) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/rpc/claim_intake_queue_job")) return routes.claim ? routes.claim() : new Response("", { status: 500 });
    if (url.includes("/rpc/get_conversation_intake_context")) return routes.context ? routes.context() : new Response("", { status: 500 });
    if (url.includes("api.openai.com")) return routes.openai ? routes.openai() : new Response("", { status: 500 });
    if (url.includes("/rpc/finalize_intake_queue_job")) return routes.finalize ? routes.finalize() : new Response("", { status: 500 });
    return new Response("", { status: 500 });
  });
}

function happyRoutes(overrides: Partial<Routes> & { extraction?: Record<string, unknown> } = {}) {
  return routedFetch({
    claim: overrides.claim ?? (() => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: MESSAGE_TEXT })),
    context: overrides.context !== undefined ? overrides.context : () => contextRow(),
    openai: overrides.openai ?? (() => openAiResponse(overrides.extraction ?? extractionJson())),
    finalize: overrides.finalize ?? (() => finalizeRow("applied")),
  });
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[callIndex] as [unknown, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("processIntakeQueueMessage: parse and claim", () => {
  it("invalid body -> ack with zero network calls", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage({ bogus: true }, env);

    expect(result).toBe("ack");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "completed", response: claimRow("completed"), expected: "ack" as QueueDisposition },
    { label: "not_found", response: claimRow("not_found"), expected: "ack" as QueueDisposition },
    { label: "busy", response: claimRow("busy"), expected: "retry" as QueueDisposition },
    { label: "failed (RPC error)", response: new Response("", { status: 500 }), expected: "retry" as QueueDisposition },
  ])("claim $label -> $expected without any further call", async ({ response, expected }) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("processIntakeQueueMessage: context fetch", () => {
  it("context not_found -> retry without OpenAI/finalization", async () => {
    const fetchMock = happyRoutes({ context: () => jsonResponse([]) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("retry");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("context failed -> retry without OpenAI/finalization", async () => {
    const fetchMock = happyRoutes({ context: () => new Response("", { status: 500 }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("retry");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("processIntakeQueueMessage: safety identifier", () => {
  it("is a stable, 64-char lowercase hex digest that differs per owner and excludes raw identifiers", async () => {
    const fetchMock1 = happyRoutes({ context: () => contextRow({ owner_id: OWNER_ID }) });
    vi.stubGlobal("fetch", fetchMock1);
    await processIntakeQueueMessage(validBody, env);
    const id1a = bodyOf(fetchMock1, 2).safety_identifier as string;

    const fetchMock1b = happyRoutes({ context: () => contextRow({ owner_id: OWNER_ID }) });
    vi.stubGlobal("fetch", fetchMock1b);
    await processIntakeQueueMessage(validBody, env);
    const id1b = bodyOf(fetchMock1b, 2).safety_identifier as string;

    const fetchMock2 = happyRoutes({ context: () => contextRow({ owner_id: OWNER_ID_2 }) });
    vi.stubGlobal("fetch", fetchMock2);
    await processIntakeQueueMessage(validBody, env);
    const id2 = bodyOf(fetchMock2, 2).safety_identifier as string;

    expect(id1a).toMatch(/^[0-9a-f]{64}$/);
    expect(id1a).toBe(id1b);
    expect(id1a).not.toBe(id2);

    for (const id of [id1a, id2]) {
      expect(id).not.toContain(OWNER_ID);
      expect(id).not.toContain(OWNER_ID_2);
      expect(id).not.toContain(CONVERSATION_ID);
      expect(id).not.toContain(CLINIC_ID);
      expect(id).not.toContain(PROVIDER_MESSAGE_ID);
      expect(id.toLowerCase()).not.toContain(OWNER_NAME.toLowerCase());
    }
  });
});

describe("processIntakeQueueMessage: OpenAI input minimization", () => {
  it("sends only the claimed message text; no recent history or snapshot text", async () => {
    const fetchMock = happyRoutes({ context: () => contextRow({ intake_data: {} }) });
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    const body = bodyOf(fetchMock, 2);
    const raw = JSON.stringify(body);
    expect(raw).toContain(MESSAGE_TEXT);
    expect(raw).not.toContain("OLD MESSAGE TEXT");

    const input = body.input as Array<{ role: string; content: string }>;
    const userMessages = input.filter((item) => item.role === "user");
    expect(userMessages).toEqual([{ role: "user", content: MESSAGE_TEXT }]);
  });

  it("extraction failure/refusal -> retry without finalization", async () => {
    const fetchMock = happyRoutes({ openai: () => new Response("", { status: 500 }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("retry");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("processIntakeQueueMessage: planned outcomes reach finalization exactly", () => {
  it("normal continue_intake plan finalizes with the exact planned stage/pet/data", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "safety_check", pet_id: PET_ID, intake_data: { schema_version: 1, ...extractionJson() } }),
      extraction: extractionJson({ complaint: "vomiting", reported_safety_signals: ALL_FALSE_SIGNALS }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 3);
    expect(finalizeBody.p_next_stage).toBe("ready_for_triage");
    expect(finalizeBody.p_pet_id).toBe(PET_ID);
    expect(finalizeBody.p_claim_token).toBe(CLAIM_TOKEN);
    expect(finalizeBody.p_expected_version).toBe(1);
    expect(finalizeBody.p_reply_category).toBe("intake_received");
    expect(typeof finalizeBody.p_reply_text).toBe("string");
    expect((finalizeBody.p_reply_text as string).length).toBeGreaterThan(0);
  });

  it("emergency signal plan finalizes with human_handoff", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "safety_check", pet_id: PET_ID }),
      extraction: extractionJson({ reported_safety_signals: { ...ALL_FALSE_SIGNALS, breathing_difficulty: true } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 3);
    expect(finalizeBody.p_next_stage).toBe("human_handoff");
    expect(finalizeBody.p_reply_category).toBe("emergency_handoff");
    expect(typeof finalizeBody.p_reply_text).toBe("string");
  });

  it("human-requested plan finalizes with human_handoff", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "safety_check", pet_id: PET_ID }),
      extraction: extractionJson({ user_requested_human: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 3);
    expect(finalizeBody.p_next_stage).toBe("human_handoff");
    expect(finalizeBody.p_reply_category).toBe("human_handoff");
    expect(typeof finalizeBody.p_reply_text).toBe("string");
  });

  it("needs_safety_check plan persists the same stage", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "ready_for_triage", pet_id: PET_ID }),
      extraction: extractionJson({ reported_safety_signals: ALL_NULL_SIGNALS }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 3);
    expect(finalizeBody.p_next_stage).toBe("ready_for_triage");
    expect(finalizeBody.p_reply_category).toBe("safety_questions");
    expect(typeof finalizeBody.p_reply_text).toBe("string");
  });

  it("ambiguous pet plan forwards the pet-identity reply", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({
        intake_stage: "pet_identification",
        pet_id: null,
        pets: [
          { id: PET_ID, name: "Fluffy", species: "cat" },
          { id: "77777777-7777-7777-7777-777777777777", name: "Misty", species: "cat" },
        ],
      }),
      extraction: extractionJson({ pet_name: null }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 3);
    expect(finalizeBody.p_next_stage).toBe("pet_identification");
    expect(finalizeBody.p_reply_category).toBe("pet_identity");
    expect(typeof finalizeBody.p_reply_text).toBe("string");
  });

  it("missing complaint plan forwards the complaint reply", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "complaint_collection", pet_id: PET_ID }),
      extraction: extractionJson({ complaint: null, symptoms: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 3);
    expect(finalizeBody.p_next_stage).toBe("complaint_collection");
    expect(finalizeBody.p_reply_category).toBe("complaint");
    expect(typeof finalizeBody.p_reply_text).toBe("string");
  });

  it("terminal completed stage with a handoff-grade signal stays completed and logs only a generic warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "completed", pet_id: PET_ID }),
      extraction: extractionJson({ reported_safety_signals: { ...ALL_FALSE_SIGNALS, major_trauma: true } }),
      finalize: () => finalizeRow("applied", { intake_stage: "completed", state_version: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 3);
    expect(finalizeBody.p_next_stage).toBe("completed");
    expect(finalizeBody.p_reply_category).toBeNull();
    expect(finalizeBody.p_reply_text).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("terminal_safety_signal"));
    const loggedText = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    for (const secret of [CONVERSATION_ID, PROVIDER_MESSAGE_ID, CLAIM_TOKEN, MESSAGE_TEXT, OWNER_ID, OWNER_NAME]) {
      expect(loggedText).not.toContain(secret);
    }
  });

  it("an inconsistent handoff safety decision is retried without finalization", async () => {
    const replySpy = vi.spyOn(intakeReplyModule, "planIntakeReply");
    vi.spyOn(intakeTurnModule, "planIntakeTurn").mockReturnValue({
      kind: "planned",
      nextStage: "safety_check",
      petId: PET_ID,
      intakeData: { ...extractionJson({ reported_safety_signals: ALL_FALSE_SIGNALS }), schema_version: 1 } as never,
      petResolution: { kind: "matched", petId: PET_ID },
      safetyDecision: { kind: "human_handoff", reason: "user_requested_human" },
    });
    const fetchMock = happyRoutes({ context: () => contextRow({ intake_stage: "safety_check", pet_id: PET_ID }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("retry");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(replySpy).not.toHaveBeenCalled();
  });
});

describe("processIntakeQueueMessage: poison snapshot fallback", () => {
  it("corrupt persisted snapshot on a non-completed stage falls back to human_handoff, null pet, fresh data", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "safety_check", pet_id: PET_ID, intake_data: { bogus_field: true } }),
      extraction: extractionJson({ complaint: "limping", reported_safety_signals: ALL_FALSE_SIGNALS }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 3);
    expect(finalizeBody.p_next_stage).toBe("human_handoff");
    expect(finalizeBody.p_pet_id).toBeNull();
    expect(finalizeBody.p_intake_data).toMatchObject({ schema_version: 1, complaint: "limping" });
    expect(finalizeBody.p_reply_category).toBe("human_handoff");
    expect(typeof finalizeBody.p_reply_text).toBe("string");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("poison_intake_state"));
    const loggedText = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    for (const secret of [CONVERSATION_ID, PROVIDER_MESSAGE_ID, CLAIM_TOKEN, MESSAGE_TEXT, OWNER_ID]) {
      expect(loggedText).not.toContain(secret);
    }
  });

  it("a selected pet missing from the tenant pet list falls back and keeps a completed stage completed", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "completed", pet_id: "77777777-7777-7777-7777-777777777777" }),
      finalize: () => finalizeRow("applied", { intake_stage: "completed", state_version: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 3);
    expect(finalizeBody.p_next_stage).toBe("completed");
    expect(finalizeBody.p_pet_id).toBeNull();
    expect(finalizeBody.p_reply_category).toBeNull();
    expect(finalizeBody.p_reply_text).toBeNull();
  });
});

describe("processIntakeQueueMessage: finalization disposition mapping", () => {
  it.each([
    { label: "applied", response: finalizeRow("applied"), expected: "ack" as QueueDisposition },
    { label: "already_completed", response: finalizeRow("already_completed"), expected: "ack" as QueueDisposition },
    { label: "stale_claim", response: finalizeRow("stale_claim"), expected: "ack" as QueueDisposition },
    { label: "stale_state", response: finalizeRow("stale_state"), expected: "retry" as QueueDisposition },
    { label: "failed", response: new Response("", { status: 500 }), expected: "retry" as QueueDisposition },
  ])("finalize $label -> $expected", async ({ response, expected }) => {
    const fetchMock = happyRoutes({ finalize: () => response });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe(expected);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("processIntakeQueueMessage: bounded work per attempt", () => {
  it("calls claim, context, OpenAI, and finalize exactly once each on the happy path, and never completes separately", async () => {
    const replySpy = vi.spyOn(intakeReplyModule, "planIntakeReply");
    const fetchMock = happyRoutes();
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(replySpy).toHaveBeenCalledTimes(1);
    const urls = fetchMock.mock.calls.map(([input]) => (input as { toString(): string }).toString());
    expect(urls.some((url) => url.includes("complete_intake_queue_job"))).toBe(false);
  });

  it("never rejects, even when fetch throws a non-Error value", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce("boom");
    vi.stubGlobal("fetch", fetchMock);

    await expect(processIntakeQueueMessage(validBody, env)).resolves.toBe("retry");
  });
});
