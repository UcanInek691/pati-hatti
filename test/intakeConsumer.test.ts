import { afterEach, describe, expect, it, vi } from "vitest";
import { RECORDING_NOTICE_DRAFT_TEXT, processIntakeQueueMessage } from "../src/intakeConsumer";
import type { QueueDisposition } from "../src/intakeConsumer";
import * as intakeReplyModule from "../src/intakeReply";
import * as intakeTurnModule from "../src/intakeTurn";
import type { Env } from "../src/env";
import type { IntakeQueueMessage } from "../src/intakeQueue";
import { UNSUPPORTED_MEDIA_MARKER } from "../src/whatsappIngest";
import { PET_IDENTITY_TEXT } from "../src/intakeReply";
import { OPENAI_INTAKE_MODEL } from "../src/openaiIntake";
import { INTAKE_EXTRACTION_PROMPT_VERSION } from "../prompts/intake-extraction-prompt";
import {
  INTAKE_CORRECTION_PROMPT_TEXT,
  POST_CONFIRMATION_APPOINTMENT_INVITATION_TEXT,
  buildIntakeConfirmationText,
} from "../src/petRegistration";

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
  WHATSAPP_ACCOUNT_CREDENTIALS_JSON: JSON.stringify([{ whatsapp_account_id: "33333333-3333-3333-3333-333333333333", phone_number_id: "918000001", access_token: "test-access-token" }]),
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

function claimRow(
  result: "claimed" | "completed" | "busy" | "not_found" | "superseded" | "overflow",
  extra: { claim_token?: string; message_text?: string | null; automation_mode?: "ai" | "manual" | "personal" } = {},
): Response {
  return jsonResponse([
    {
      result,
      claim_token: extra.claim_token ?? null,
      message_text: extra.message_text ?? null,
      automation_mode: extra.automation_mode ?? (result === "claimed" ? "ai" : null),
    },
  ]);
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
      // Mid-conversation by default, consistent with the prior `recent_messages`
      // entry below. Task 036 keys the recording notice on `state_version === 1`
      // (the conversation's very first turn), so a fixture that is not modelling
      // a first turn must not claim to be one.
      state_version: 2,
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

function openAiResponse(extraction: Record<string, unknown>, usage?: Record<string, unknown>): Response {
  return jsonResponse({
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(extraction) }] }],
    ...(usage === undefined ? {} : { usage }),
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

function meteringRow(result: "recorded" | "duplicate" | "stale_claim" | "not_found"): Response {
  return jsonResponse([{ result }]);
}

function offerRow(
  result: "offered" | "unavailable" | "existing_confirmed" | "in_progress" | "already_completed" | "stale_claim" | "stale_state",
  extra: { intake_stage?: string; state_version?: number } = {},
): Response {
  if (result === "offered" || result === "unavailable" || result === "existing_confirmed" || result === "in_progress") {
    const intakeStage =
      result === "offered" ? "appointment_selection" : result === "existing_confirmed" ? "completed" : "human_handoff";
    return jsonResponse([{ result, intake_stage: extra.intake_stage ?? intakeStage, state_version: extra.state_version ?? 2 }]);
  }
  return jsonResponse([{ result, intake_stage: null, state_version: null }]);
}

function decisionRow(
  result: "confirmed" | "declined" | "repeated" | "stale_hold" | "already_completed" | "stale_claim" | "stale_state",
  extra: { intake_stage?: string; state_version?: number } = {},
): Response {
  if (result === "confirmed" || result === "declined" || result === "repeated" || result === "stale_hold") {
    const intakeStage =
      result === "repeated" ? "appointment_selection" : result === "stale_hold" ? "human_handoff" : "completed";
    return jsonResponse([{ result, intake_stage: extra.intake_stage ?? intakeStage, state_version: extra.state_version ?? 2 }]);
  }
  return jsonResponse([{ result, intake_stage: null, state_version: null }]);
}

function cancelOfferRow(
  result: "offered" | "no_appointment" | "already_completed" | "stale_claim" | "stale_state",
): Response {
  if (result === "offered") return jsonResponse([{ result, intake_stage: "appointment_cancel_confirmation", state_version: 3 }]);
  if (result === "no_appointment") return jsonResponse([{ result, intake_stage: "completed", state_version: 3 }]);
  return jsonResponse([{ result, intake_stage: null, state_version: null }]);
}

function cancelDecisionRow(
  result: "cancelled" | "kept" | "repeated" | "stale_appointment" | "already_completed" | "stale_claim" | "stale_state",
): Response {
  if (result === "repeated") return jsonResponse([{ result, intake_stage: "appointment_cancel_confirmation", state_version: 4 }]);
  if (result === "cancelled" || result === "kept" || result === "stale_appointment") {
    return jsonResponse([{ result, intake_stage: "completed", state_version: 4 }]);
  }
  return jsonResponse([{ result, intake_stage: null, state_version: null }]);
}

type Routes = {
  claim?: () => Response;
  complete?: () => Response;
  context?: () => Response;
  openai?: () => Response;
  metering?: () => Response;
  finalize?: () => Response;
  appointmentOffer?: () => Response;
  appointmentDecision?: () => Response;
  appointmentCancelOffer?: () => Response;
  appointmentCancelDecision?: () => Response;
  clinic?: () => Response;
};

function routedFetch(routes: Routes) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/rpc/claim_intake_queue_job")) return routes.claim ? routes.claim() : new Response("", { status: 500 });
    if (url.includes("/rpc/complete_intake_queue_job")) return routes.complete ? routes.complete() : new Response("", { status: 500 });
    if (url.includes("/rpc/get_conversation_intake_context")) return routes.context ? routes.context() : new Response("", { status: 500 });
    if (url.includes("api.openai.com")) return routes.openai ? routes.openai() : new Response("", { status: 500 });
    if (url.includes("/rpc/record_intake_ai_usage_v1")) return routes.metering ? routes.metering() : new Response("", { status: 500 });
    if (url.includes("/rpc/finalize_appointment_offer_queue_job")) {
      return routes.appointmentOffer ? routes.appointmentOffer() : new Response("", { status: 500 });
    }
    if (url.includes("/rpc/finalize_appointment_decision_queue_job")) {
      return routes.appointmentDecision ? routes.appointmentDecision() : new Response("", { status: 500 });
    }
    if (url.includes("/rpc/finalize_appointment_cancel_offer_queue_job")) {
      return routes.appointmentCancelOffer ? routes.appointmentCancelOffer() : new Response("", { status: 500 });
    }
    if (url.includes("/rpc/finalize_appointment_cancel_decision_queue_job")) {
      return routes.appointmentCancelDecision ? routes.appointmentCancelDecision() : new Response("", { status: 500 });
    }
    if (url.includes("/rpc/finalize_intake_queue_job")) return routes.finalize ? routes.finalize() : new Response("", { status: 500 });
    if (url.includes("/rpc/get_conversation_clinic_operational_context")) {
      return routes.clinic ? routes.clinic() : new Response("", { status: 500 });
    }
    return new Response("", { status: 500 });
  });
}

function happyRoutes(overrides: Partial<Routes> & { extraction?: Record<string, unknown> } = {}) {
  return routedFetch({
    claim: overrides.claim ?? (() => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: MESSAGE_TEXT })),
    context: overrides.context !== undefined ? overrides.context : () => contextRow(),
    openai: overrides.openai ?? (() => openAiResponse(overrides.extraction ?? extractionJson())),
    metering: overrides.metering ?? (() => meteringRow("recorded")),
    finalize: overrides.finalize ?? (() => finalizeRow("applied")),
    appointmentOffer: overrides.appointmentOffer,
    appointmentDecision: overrides.appointmentDecision,
    appointmentCancelOffer: overrides.appointmentCancelOffer,
    appointmentCancelDecision: overrides.appointmentCancelDecision,
    clinic: overrides.clinic,
  });
}

function clinicRow(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse([
    {
      result: "configured",
      clinic_name: "Merkez Veteriner Klinigi",
      contact_phone_e164: "+905551112233",
      public_address: "Bagdat Cad. No 1",
      is_open: true,
      ...overrides,
    },
  ]);
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
    { label: "superseded", response: claimRow("superseded"), expected: "ack" as QueueDisposition },
    { label: "failed (RPC error)", response: new Response("", { status: 500 }), expected: "retry" as QueueDisposition },
  ])("claim $label -> $expected without any further call", async ({ response, expected }) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("claim overflow (Task 039 Part C) -> routes to human_handoff with zero OpenAI calls", async () => {
    const fetchMock = happyRoutes({
      claim: () => claimRow("overflow", { claim_token: CLAIM_TOKEN }),
      context: () => contextRow({ intake_stage: "complaint_collection", pet_id: PET_ID, intake_data: {} }),
      finalize: () => finalizeRow("applied", { intake_stage: "human_handoff", state_version: 2 }),
      clinic: () => clinicRow({ is_open: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    expect(fetchMock.mock.calls.some(([input]) => input.toString().includes("api.openai.com"))).toBe(false);
    const finalizeBody = bodyOf(fetchMock, 3);
    expect(finalizeBody.p_next_stage).toBe("human_handoff");
    expect(finalizeBody.p_reply_category).toBe("human_handoff");
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
    const finalizeBody = bodyOf(fetchMock, 4);
    expect(finalizeBody.p_next_stage).toBe("ready_for_triage");
    expect(finalizeBody.p_pet_id).toBe(PET_ID);
    expect(finalizeBody.p_claim_token).toBe(CLAIM_TOKEN);
    expect(finalizeBody.p_expected_version).toBe(2);
    expect(finalizeBody.p_reply_category).toBe("intake_received");
    expect(finalizeBody.p_reply_text).toBe(POST_CONFIRMATION_APPOINTMENT_INVITATION_TEXT);
  });

  it("emergency signal plan finalizes with human_handoff", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "safety_check", pet_id: PET_ID }),
      extraction: extractionJson({ reported_safety_signals: { ...ALL_FALSE_SIGNALS, breathing_difficulty: true } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 4);
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
    const finalizeBody = bodyOf(fetchMock, 5);
    expect(finalizeBody.p_next_stage).toBe("human_handoff");
    expect(finalizeBody.p_reply_category).toBe("human_handoff");
    expect(typeof finalizeBody.p_reply_text).toBe("string");
  });

  it("new-pet registration does not bind a stated name to an existing same-name pet", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          pet_id: null,
          pets: [{ id: PET_ID, name: "Pamuk", species: "cat" }],
        }),
      extraction: extractionJson({ intent: "human_handoff", pet_name: "Pamuk", species: "kedi", user_requested_human: false }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 5);
    expect(finalizeBody.p_next_stage).toBe("human_handoff");
    expect(finalizeBody.p_pet_id).toBeNull();
    expect(finalizeBody.p_intake_data).toMatchObject({ intent: "human_handoff", pet_name: "Pamuk", species: "kedi" });
    expect(finalizeBody.p_reply_category).toBe("human_handoff");
  });

  it("unnamed new-pet registration does not fall back to the owner's only existing pet", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ pet_id: null }),
      extraction: extractionJson({ intent: "human_handoff", pet_name: null, species: "kedi", user_requested_human: false }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 5);
    expect(finalizeBody.p_next_stage).toBe("human_handoff");
    expect(finalizeBody.p_pet_id).toBeNull();
  });

  it("an explicit staff request also avoids introducing a new pet association", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ pet_id: null }),
      extraction: extractionJson({ intent: "human_handoff", pet_name: "Fluffy", user_requested_human: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 5);
    expect(finalizeBody.p_next_stage).toBe("human_handoff");
    expect(finalizeBody.p_pet_id).toBeNull();
  });

  it("a registration request combined with medical advice cannot bind an existing same-name pet", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          pet_id: null,
          pets: [{ id: PET_ID, name: "Pamuk", species: "cat" }],
        }),
      extraction: extractionJson({ intent: "medical_advice_request", pet_name: "Pamuk", user_requested_human: false }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 5);
    expect(finalizeBody.p_next_stage).toBe("human_handoff");
    expect(finalizeBody.p_pet_id).toBeNull();
    expect(finalizeBody.p_reply_category).toBe("human_handoff");
  });

  it("needs_safety_check plan persists the same stage", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "ready_for_triage", pet_id: PET_ID }),
      extraction: extractionJson({ reported_safety_signals: ALL_NULL_SIGNALS }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 4);
    expect(finalizeBody.p_next_stage).toBe("ready_for_triage");
    expect(finalizeBody.p_reply_category).toBe("safety_questions");
    expect(typeof finalizeBody.p_reply_text).toBe("string");
  });

  it("does not repeat the appointment invitation after ready_for_triage is already reached", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "ready_for_triage", pet_id: PET_ID }),
      extraction: extractionJson({ reported_safety_signals: ALL_FALSE_SIGNALS }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 4);
    expect(finalizeBody.p_next_stage).toBe("ready_for_triage");
    expect(finalizeBody.p_reply_text).not.toBe(POST_CONFIRMATION_APPOINTMENT_INVITATION_TEXT);
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
    const finalizeBody = bodyOf(fetchMock, 4);
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
    const finalizeBody = bodyOf(fetchMock, 4);
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
    const finalizeBody = bodyOf(fetchMock, 4);
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
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(replySpy).not.toHaveBeenCalled();
  });
});

describe("processIntakeQueueMessage: clinic operational context personalization (Task 031)", () => {
  const GENERIC_HUMAN_HANDOFF_TEXT =
    "Bu talebi bot üzerinden yanıtlayamam. Lütfen kliniğimizi telefonla arayın. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.";

  function openClinicText(clinicName: string, phone: string): string {
    return `Bu talebi bot üzerinden yanıtlayamam. ${clinicName} ile ${phone} numarasından iletişime geçin. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.`;
  }

  function closedClinicText(clinicName: string, phone: string): string {
    return `Bu talebi bot üzerinden yanıtlayamam. ${clinicName} şu anda kapalı. Acil olmayan konular için çalışma saatleri içinde ${phone} numarasından iletişime geçin. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.`;
  }

  function clinicCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
    return fetchMock.mock.calls.filter(([input]) =>
      (input as { toString(): string }).toString().includes("/rpc/get_conversation_clinic_operational_context"),
    ).length;
  }

  it("personalizes an open clinic's human_handoff reply with the truthful name and phone", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "safety_check", pet_id: PET_ID }),
      extraction: extractionJson({ user_requested_human: true }),
      clinic: () => clinicRow({ is_open: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    expect(bodyOf(fetchMock, 4)).toEqual({ p_conversation_id: CONVERSATION_ID });
    const finalizeBody = bodyOf(fetchMock, 5);
    expect(finalizeBody.p_reply_category).toBe("human_handoff");
    expect(finalizeBody.p_reply_text).toBe(openClinicText("Merkez Veteriner Klinigi", "+905551112233"));
  });

  it("personalizes a closed clinic's human_handoff reply with truthful closed wording", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "safety_check", pet_id: PET_ID }),
      extraction: extractionJson({ user_requested_human: true }),
      clinic: () => clinicRow({ is_open: false }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 5);
    expect(finalizeBody.p_reply_category).toBe("human_handoff");
    expect(finalizeBody.p_reply_text).toBe(closedClinicText("Merkez Veteriner Klinigi", "+905551112233"));
  });

  it.each([
    ["the clinic RPC fails", () => new Response("", { status: 500 })],
    ["the clinic result is unconfigured", () => jsonResponse([{ result: "unconfigured", clinic_name: null, contact_phone_e164: null, public_address: null, is_open: null }])],
    ["the clinic result is not_found", () => jsonResponse([{ result: "not_found", clinic_name: null, contact_phone_e164: null, public_address: null, is_open: null }])],
  ])("falls back to the generic handoff text when %s", async (_label, clinic) => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "safety_check", pet_id: PET_ID }),
      extraction: extractionJson({ user_requested_human: true }),
      clinic,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 5);
    expect(finalizeBody.p_reply_category).toBe("human_handoff");
    expect(finalizeBody.p_reply_text).toBe(GENERIC_HUMAN_HANDOFF_TEXT);
  });

  it("never calls the clinic RPC for a non-human_handoff category reply", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "safety_check", pet_id: PET_ID, intake_data: { schema_version: 1, ...extractionJson() } }),
      extraction: extractionJson({ complaint: "vomiting", reported_safety_signals: ALL_FALSE_SIGNALS }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    expect(clinicCallCount(fetchMock)).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("never calls the clinic RPC for an emergency_handoff category reply", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "safety_check", pet_id: PET_ID }),
      extraction: extractionJson({ reported_safety_signals: { ...ALL_FALSE_SIGNALS, breathing_difficulty: true } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    expect(clinicCallCount(fetchMock)).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("personalizes the handoff reply reached directly from the human_handoff stage without an OpenAI call", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "human_handoff", pet_id: PET_ID, state_version: 5, intake_data: {} }),
      finalize: () => finalizeRow("applied", { intake_stage: "human_handoff", state_version: 6 }),
      clinic: () => clinicRow({ is_open: false }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    expect(clinicCallCount(fetchMock)).toBe(1);
    const finalizeBody = bodyOf(fetchMock, 3);
    expect(finalizeBody.p_reply_category).toBe("human_handoff");
    expect(finalizeBody.p_reply_text).toBe(closedClinicText("Merkez Veteriner Klinigi", "+905551112233"));
  });

  it("personalizes the truthful handoff reply for unsupported media forced to human_handoff", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "human_handoff", pet_id: PET_ID, intake_data: {} }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: UNSUPPORTED_MEDIA_MARKER }),
      finalize: () => finalizeRow("applied", { intake_stage: "human_handoff", state_version: 2 }),
      clinic: () => clinicRow({ is_open: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    expect(clinicCallCount(fetchMock)).toBe(1);
    const finalizeBody = bodyOf(fetchMock, 3);
    expect(finalizeBody.p_reply_category).toBe("human_handoff");
    expect(finalizeBody.p_reply_text).toBe(openClinicText("Merkez Veteriner Klinigi", "+905551112233"));
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
    const finalizeBody = bodyOf(fetchMock, 5);
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
    const finalizeBody = bodyOf(fetchMock, 4);
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
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

describe("processIntakeQueueMessage: appointment offer routing", () => {
  it("a matched pet with an appointment_request intent reaching ready_for_triage calls the offer RPC instead of finalize_intake_queue_job", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "safety_check", pet_id: PET_ID }),
      extraction: extractionJson({ intent: "appointment_request", reported_safety_signals: ALL_FALSE_SIGNALS }),
      appointmentOffer: () => offerRow("offered", { intake_stage: "appointment_selection", state_version: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const urls = fetchMock.mock.calls.map(([input]) => (input as { toString(): string }).toString());
    expect(urls.some((url) => url.includes("finalize_appointment_offer_queue_job"))).toBe(true);
    expect(urls.some((url) => url.includes("finalize_intake_queue_job"))).toBe(false);

    const offerBody = bodyOf(fetchMock, 4);
    expect(offerBody.p_conversation_id).toBe(CONVERSATION_ID);
    expect(offerBody.p_provider_message_id).toBe(PROVIDER_MESSAGE_ID);
    expect(offerBody.p_claim_token).toBe(CLAIM_TOKEN);
    expect(offerBody.p_expected_version).toBe(2);
    expect(offerBody.p_planned_next_stage).toBe("ready_for_triage");
    expect(offerBody.p_pet_id).toBe(PET_ID);
  });

  it.each([
    { label: "offered", response: offerRow("offered"), expected: "ack" as QueueDisposition },
    { label: "unavailable", response: offerRow("unavailable"), expected: "ack" as QueueDisposition },
    { label: "existing_confirmed", response: offerRow("existing_confirmed"), expected: "ack" as QueueDisposition },
    { label: "in_progress", response: offerRow("in_progress"), expected: "ack" as QueueDisposition },
    { label: "already_completed", response: offerRow("already_completed"), expected: "ack" as QueueDisposition },
    { label: "stale_claim", response: offerRow("stale_claim"), expected: "ack" as QueueDisposition },
    { label: "stale_state", response: offerRow("stale_state"), expected: "retry" as QueueDisposition },
    { label: "failed (RPC error)", response: new Response("", { status: 500 }), expected: "retry" as QueueDisposition },
  ])("offer RPC $label -> $expected", async ({ response, expected }) => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "safety_check", pet_id: PET_ID }),
      extraction: extractionJson({ intent: "appointment_request", reported_safety_signals: ALL_FALSE_SIGNALS }),
      appointmentOffer: () => response,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe(expected);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("a matched-pet appointment_request plan with no resolved pet id retries without calling the offer RPC", async () => {
    vi.spyOn(intakeTurnModule, "planIntakeTurn").mockReturnValue({
      kind: "planned",
      nextStage: "ready_for_triage",
      petId: null,
      intakeData: { ...extractionJson({ intent: "appointment_request", reported_safety_signals: ALL_FALSE_SIGNALS }), schema_version: 1 } as never,
      petResolution: { kind: "matched", petId: PET_ID },
      safetyDecision: { kind: "continue_intake" },
    });
    const fetchMock = happyRoutes({ context: () => contextRow({ intake_stage: "safety_check", pet_id: PET_ID }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("retry");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("a report_symptom intent at ready_for_triage still finalizes normally, never calling the offer RPC", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "safety_check", pet_id: PET_ID }),
      extraction: extractionJson({ intent: "report_symptom", reported_safety_signals: ALL_FALSE_SIGNALS }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const urls = fetchMock.mock.calls.map(([input]) => (input as { toString(): string }).toString());
    expect(urls.some((url) => url.includes("finalize_appointment_offer_queue_job"))).toBe(false);
    expect(urls.some((url) => url.includes("finalize_intake_queue_job"))).toBe(true);
    expect(bodyOf(fetchMock, 4).p_reply_text).toBe(POST_CONFIRMATION_APPOINTMENT_INVITATION_TEXT);
  });
});

describe("processIntakeQueueMessage: appointment decision routing", () => {
  it("appointment_selection stage calls the decision RPC with EVET normalized to confirm, bypassing finalize_intake_queue_job", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "appointment_selection", pet_id: PET_ID }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: "EVET" }),
      appointmentDecision: () => decisionRow("confirmed", { intake_stage: "completed", state_version: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const urls = fetchMock.mock.calls.map(([input]) => (input as { toString(): string }).toString());
    expect(urls.some((url) => url.includes("finalize_appointment_decision_queue_job"))).toBe(true);
    expect(urls.some((url) => url.includes("finalize_intake_queue_job"))).toBe(false);

    const decisionBody = bodyOf(fetchMock, 4);
    expect(decisionBody.p_decision).toBe("confirm");
    expect(decisionBody.p_pet_id).toBe(PET_ID);
    expect(decisionBody.p_claim_token).toBe(CLAIM_TOKEN);
    expect(decisionBody.p_expected_version).toBe(2);
  });

  it.each([
    { text: "HAYIR", decision: "decline" },
    { text: "hayır", decision: "decline" },
    { text: "belki", decision: "repeat" },
  ])("appointment_selection stage maps message text $text to decision $decision", async ({ text, decision }) => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "appointment_selection", pet_id: PET_ID }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: text }),
      appointmentDecision: () => decisionRow("repeated", { intake_stage: "appointment_selection", state_version: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    const decisionBody = bodyOf(fetchMock, 4);
    expect(decisionBody.p_decision).toBe(decision);
  });

  it.each([
    { label: "confirmed", response: decisionRow("confirmed"), expected: "ack" as QueueDisposition },
    { label: "declined", response: decisionRow("declined"), expected: "ack" as QueueDisposition },
    { label: "repeated", response: decisionRow("repeated"), expected: "ack" as QueueDisposition },
    { label: "stale_hold", response: decisionRow("stale_hold"), expected: "ack" as QueueDisposition },
    { label: "already_completed", response: decisionRow("already_completed"), expected: "ack" as QueueDisposition },
    { label: "stale_claim", response: decisionRow("stale_claim"), expected: "ack" as QueueDisposition },
    { label: "stale_state", response: decisionRow("stale_state"), expected: "retry" as QueueDisposition },
    { label: "failed (RPC error)", response: new Response("", { status: 500 }), expected: "retry" as QueueDisposition },
  ])("decision RPC $label -> $expected", async ({ response, expected }) => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "appointment_selection", pet_id: PET_ID }),
      appointmentDecision: () => response,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe(expected);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("appointment_selection stage with no resolved pet id retries without calling the decision RPC", async () => {
    vi.spyOn(intakeTurnModule, "planIntakeTurn").mockReturnValue({
      kind: "planned",
      nextStage: "appointment_selection",
      petId: null,
      intakeData: { ...extractionJson({ reported_safety_signals: ALL_FALSE_SIGNALS }), schema_version: 1 } as never,
      petResolution: { kind: "matched", petId: PET_ID },
      safetyDecision: { kind: "continue_intake" },
    });
    const fetchMock = happyRoutes({ context: () => contextRow({ intake_stage: "appointment_selection", pet_id: PET_ID }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("retry");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("a handoff-grade safety decision at appointment_selection stage bypasses the decision RPC entirely and finalizes to human_handoff", async () => {
    vi.spyOn(intakeTurnModule, "planIntakeTurn").mockReturnValue({
      kind: "planned",
      nextStage: "human_handoff",
      petId: PET_ID,
      intakeData: { ...extractionJson({ reported_safety_signals: ALL_FALSE_SIGNALS }), schema_version: 1 } as never,
      petResolution: { kind: "matched", petId: PET_ID },
      safetyDecision: { kind: "human_handoff", reason: "user_requested_human" },
    });
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "appointment_selection", pet_id: PET_ID }),
      finalize: () => finalizeRow("applied", { intake_stage: "human_handoff", state_version: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const urls = fetchMock.mock.calls.map(([input]) => (input as { toString(): string }).toString());
    expect(urls.some((url) => url.includes("finalize_appointment_decision_queue_job"))).toBe(false);
    expect(urls.some((url) => url.includes("finalize_intake_queue_job"))).toBe(true);
  });
});

describe("processIntakeQueueMessage: Task 039 cancellation routing", () => {
  const cancellationSnapshot = {
    schema_version: 1,
    ...extractionJson({ intent: "appointment_cancel_request", reported_safety_signals: ALL_FALSE_SIGNALS }),
    pending_cancel_slot_id: "77777777-7777-7777-7777-777777777777",
  };

  it("a safe matched-pet cancellation request calls only the cancellation-offer finalizer", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "ready_for_triage", pet_id: PET_ID }),
      extraction: extractionJson({ intent: "appointment_cancel_request", reported_safety_signals: ALL_FALSE_SIGNALS }),
      appointmentCancelOffer: () => cancelOfferRow("offered"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(processIntakeQueueMessage(validBody, env)).resolves.toBe("ack");
    const urls = fetchMock.mock.calls.map(([input]) => input.toString());
    expect(urls.some((url) => url.includes("finalize_appointment_cancel_offer_queue_job"))).toBe(true);
    expect(urls.some((url) => url.includes("finalize_intake_queue_job"))).toBe(false);
    const body = bodyOf(fetchMock, 4);
    expect(body.p_pet_id).toBe(PET_ID);
    expect(body.p_expected_version).toBe(2);
    expect(body.p_intake_data).toMatchObject({ intent: "appointment_cancel_request" });
  });

  it.each([
    {
      label: "names an existing pet",
      pets: [
        { id: "77777777-7777-7777-7777-777777777777", name: "Minnoş", species: "cat" },
        { id: PET_ID, name: "Pamuk", species: "cat" },
      ],
      petName: "Pamuk",
    },
    {
      label: "has exactly one existing pet and omits its name",
      pets: [{ id: PET_ID, name: "Pamuk", species: "cat" }],
      petName: null,
    },
  ])("a first-message cancellation that $label reaches the cancellation offer despite unknown safety answers", async ({ pets, petName }) => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "pet_identification", state_version: 1, pet_id: null, pets }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: "Randevumu iptal etmek istiyorum" }),
      extraction: extractionJson({
        intent: "appointment_cancel_request",
        pet_name: petName,
        reported_safety_signals: ALL_NULL_SIGNALS,
      }),
      appointmentCancelOffer: () => cancelOfferRow("offered"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(processIntakeQueueMessage(validBody, env)).resolves.toBe("ack");
    const urls = fetchMock.mock.calls.map(([input]) => input.toString());
    expect(urls.some((url) => url.includes("finalize_appointment_cancel_offer_queue_job"))).toBe(true);
    expect(urls.some((url) => url.includes("finalize_intake_queue_job"))).toBe(false);
    expect(bodyOf(fetchMock, 4)).toMatchObject({ p_pet_id: PET_ID, p_expected_version: 1 });
  });

  it("a first-message cancellation without a pet name asks which pet when multiple pets exist", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "pet_identification",
          state_version: 1,
          pet_id: null,
          pets: [
            { id: "77777777-7777-7777-7777-777777777777", name: "Minnoş", species: "cat" },
            { id: PET_ID, name: "Pamuk", species: "cat" },
          ],
        }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: "Randevumu iptal etmek istiyorum" }),
      extraction: extractionJson({
        intent: "appointment_cancel_request",
        pet_name: null,
        reported_safety_signals: ALL_NULL_SIGNALS,
      }),
      finalize: () => finalizeRow("applied", { intake_stage: "pet_identification", state_version: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(processIntakeQueueMessage(validBody, env)).resolves.toBe("ack");
    const urls = fetchMock.mock.calls.map(([input]) => input.toString());
    expect(urls.some((url) => url.includes("finalize_appointment_cancel_offer_queue_job"))).toBe(false);
    expect(bodyOf(fetchMock, 4)).toMatchObject({
      p_next_stage: "pet_identification",
      p_pet_id: null,
      p_reply_category: "pet_identity",
    });
  });

  it("acks an unbound unmatched cancellation with pet clarification instead of retrying an invalid cancel stage", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "pet_identification",
          state_version: 1,
          pet_id: null,
          pets: [
            { id: "77777777-7777-7777-7777-777777777777", name: "Minnoş", species: "cat" },
            { id: PET_ID, name: "Pamuk", species: "cat" },
          ],
        }),
      extraction: extractionJson({
        intent: "appointment_cancel_request",
        pet_name: "Pamuk’un",
        reported_safety_signals: ALL_FALSE_SIGNALS,
      }),
      finalize: () => finalizeRow("applied", { intake_stage: "pet_identification", state_version: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(processIntakeQueueMessage(validBody, env)).resolves.toBe("ack");
    const urls = fetchMock.mock.calls.map(([input]) => input.toString());
    expect(urls.some((url) => url.includes("finalize_appointment_cancel_offer_queue_job"))).toBe(false);
    expect(urls.some((url) => url.includes("finalize_intake_queue_job"))).toBe(true);
    expect(bodyOf(fetchMock, 4)).toMatchObject({
      p_next_stage: "pet_identification",
      p_pet_id: null,
      p_reply_category: "pet_identity",
    });
  });

  it.each([
    ["offered", "ack"],
    ["no_appointment", "ack"],
    ["already_completed", "ack"],
    ["stale_claim", "ack"],
    ["stale_state", "retry"],
  ] as const)("maps cancellation-offer result %s to %s", async (rpcResult, disposition) => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "ready_for_triage", pet_id: PET_ID }),
      extraction: extractionJson({ intent: "appointment_cancel_request", reported_safety_signals: ALL_FALSE_SIGNALS }),
      appointmentCancelOffer: () => cancelOfferRow(rpcResult),
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(processIntakeQueueMessage(validBody, env)).resolves.toBe(disposition);
  });

  it.each([
    ["EVET", "cancel", "cancelled", "ack"],
    ["HAYIR", "keep", "kept", "ack"],
    ["EVET", "cancel", "stale_appointment", "ack"],
    ["EVET", "cancel", "stale_state", "retry"],
  ] as const)("handles exact raw %s as deterministic %s/%s -> %s with zero OpenAI calls", async (message, decision, rpcResult, disposition) => {
    const fetchMock = happyRoutes({
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: message }),
      context: () => contextRow({
        intake_stage: "appointment_cancel_confirmation",
        state_version: 99,
        pet_id: PET_ID,
        intake_data: cancellationSnapshot,
      }),
      appointmentCancelDecision: () => cancelDecisionRow(rpcResult),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(processIntakeQueueMessage(validBody, env)).resolves.toBe(disposition);
    const urls = fetchMock.mock.calls.map(([input]) => input.toString());
    expect(urls.some((url) => url.includes("finalize_appointment_cancel_decision_queue_job"))).toBe(true);
    expect(urls.some((url) => url.includes("finalize_intake_queue_job"))).toBe(false);
    expect(urls.some((url) => url.includes("api.openai.com"))).toBe(false);
    expect(bodyOf(fetchMock, 2)).toMatchObject({ p_decision: decision, p_expected_version: 99 });
  });

  it("sends a non-exact cancellation answer through extraction, then repeats without mutation", async () => {
    const fetchMock = happyRoutes({
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: "belki" }),
      context: () => contextRow({
        intake_stage: "appointment_cancel_confirmation",
        pet_id: PET_ID,
        intake_data: cancellationSnapshot,
      }),
      extraction: extractionJson({ intent: "unknown", reported_safety_signals: ALL_NULL_SIGNALS }),
      appointmentCancelDecision: () => cancelDecisionRow("repeated"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(processIntakeQueueMessage(validBody, env)).resolves.toBe("ack");
    const urls = fetchMock.mock.calls.map(([input]) => input.toString());
    expect(urls.some((url) => url.includes("api.openai.com"))).toBe(true);
    expect(bodyOf(fetchMock, 4).p_decision).toBe("repeat");
  });

  it("keeps deterministic emergency precedence over a cancellation request", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "ready_for_triage", pet_id: PET_ID }),
      extraction: extractionJson({
        intent: "appointment_cancel_request",
        reported_safety_signals: { ...ALL_FALSE_SIGNALS, breathing_difficulty: true },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(processIntakeQueueMessage(validBody, env)).resolves.toBe("ack");
    const urls = fetchMock.mock.calls.map(([input]) => input.toString());
    expect(urls.some((url) => url.includes("finalize_appointment_cancel"))).toBe(false);
    expect(urls.some((url) => url.includes("finalize_intake_queue_job"))).toBe(true);
    expect(bodyOf(fetchMock, 4)).toMatchObject({
      p_next_stage: "human_handoff",
      p_reply_category: "emergency_handoff",
    });
  });
});

describe("processIntakeQueueMessage: Task 029 previous-question context (Part 1)", () => {
  it.each(["evet", "hayır", "hiçbiri", "ilkine evet, diğerlerine hayır"])(
    "threads exactly one labelled question before the exact current answer %s",
    async (currentMessage) => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "safety_check",
          recent_messages: [
            { direction: "outbound", content: "Nefes almakta güçlük var mı?", created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: currentMessage, created_at: "2026-01-01T00:00:01Z" },
          ],
        }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: currentMessage }),
      extraction: extractionJson({ reported_safety_signals: { ...ALL_FALSE_SIGNALS, breathing_difficulty: true } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    const body = bodyOf(fetchMock, 2);
    const input = body.input as Array<{ role: string; content: string }>;
    expect(input).toHaveLength(3);
    expect(input[1]!.role).toBe("user");
    expect(input[1]!.content).toContain("Nefes almakta güçlük var mı?");
    expect(input[1]!.content.toLowerCase()).toContain("untrusted");
    expect(input[2]).toEqual({ role: "user", content: currentMessage });
    },
  );

  it("threads the prior question when the burst claim labels a single eligible message", async () => {
    const rawMessage = "evet";
    const claimedTurn = `Mesaj 1: ${rawMessage}`;
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "safety_check",
          recent_messages: [
            { direction: "outbound", content: "Nefes almakta güçlük var mı?", created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: rawMessage, created_at: "2026-01-01T00:00:01Z" },
          ],
        }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: claimedTurn }),
      extraction: extractionJson({ reported_safety_signals: { ...ALL_FALSE_SIGNALS, breathing_difficulty: true } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    expect(bodyOf(fetchMock, 2).input).toEqual([
      expect.objectContaining({ role: "system" }),
      expect.objectContaining({ role: "user", content: expect.stringContaining("Nefes almakta güçlük var mı?") }),
      { role: "user", content: claimedTurn },
    ]);
  });

  it("threads the prior question when the newest raw inbound is the final item in a labelled burst", async () => {
    const newestRawMessage = "ama yürürken dengesiz";
    const claimedTurn = `Mesaj 1: Bunların hiçbiri yok\nMesaj 2: ${newestRawMessage}`;
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "safety_check",
          recent_messages: [
            { direction: "outbound", content: "Bu belirtilerden biri var mı?", created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "Bunların hiçbiri yok", created_at: "2026-01-01T00:00:01Z" },
            { direction: "inbound", content: newestRawMessage, created_at: "2026-01-01T00:00:02Z" },
          ],
        }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: claimedTurn }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    expect(bodyOf(fetchMock, 2).input).toEqual([
      expect.objectContaining({ role: "system" }),
      expect.objectContaining({ role: "user", content: expect.stringContaining("Bu belirtilerden biri var mı?") }),
      { role: "user", content: claimedTurn },
    ]);
  });

  it("does not thread stale context when a labelled burst does not end with the newest recorded inbound", async () => {
    const claimedTurn = "Mesaj 1: evet\nMesaj 2: başka bir yanıt";
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "safety_check",
          recent_messages: [
            { direction: "outbound", content: "Nefes almakta güçlük var mı?", created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "evet", created_at: "2026-01-01T00:00:01Z" },
          ],
        }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: claimedTurn }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    expect((bodyOf(fetchMock, 2).input as unknown[])).toHaveLength(2);
  });

  it("sends only the nearest prior outbound question and excludes history, identifiers, timestamps, and persisted data", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_data: {
            schema_version: 1,
            ...extractionJson({ complaint: "SNAPSHOT_MUST_NOT_LEAK" }),
          },
          recent_messages: [
            { direction: "outbound", content: "OLD_OUTBOUND_MUST_NOT_LEAK?", created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "OLD_INBOUND_MUST_NOT_LEAK", created_at: "2026-01-01T00:00:01Z" },
            { direction: "outbound", content: "Güncel güvenlik sorusu?", created_at: "2026-01-01T00:00:02Z" },
            { direction: "inbound", content: "evet", created_at: "2026-01-01T00:00:03Z" },
          ],
        }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: "evet" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    const serialized = JSON.stringify(bodyOf(fetchMock, 2));
    expect(serialized).toContain("Güncel güvenlik sorusu?");
    for (const forbidden of [
      "OLD_OUTBOUND_MUST_NOT_LEAK",
      "OLD_INBOUND_MUST_NOT_LEAK",
      "SNAPSHOT_MUST_NOT_LEAK",
      CONVERSATION_ID,
      CLINIC_ID,
      OWNER_ID,
      PET_ID,
      "2026-01-01T00:00:02Z",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("threads the fixed post-confirmation appointment invitation as the one bounded question", async () => {
    const currentMessage = "uygun saatlere bakalım";
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "safety_check",
          pet_id: PET_ID,
          recent_messages: [
            { direction: "outbound", content: POST_CONFIRMATION_APPOINTMENT_INVITATION_TEXT, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: currentMessage, created_at: "2026-01-01T00:00:01Z" },
          ],
        }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: currentMessage }),
      extraction: extractionJson({ intent: "appointment_request", reported_safety_signals: ALL_FALSE_SIGNALS }),
      appointmentOffer: () => offerRow("offered"),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");

    const openAiBody = bodyOf(fetchMock, 2);
    expect(openAiBody.input).toEqual([
      expect.objectContaining({ role: "system" }),
      expect.objectContaining({ role: "user", content: expect.stringContaining(POST_CONFIRMATION_APPOINTMENT_INVITATION_TEXT) }),
      { role: "user", content: currentMessage },
    ]);
    const urls = fetchMock.mock.calls.map(([input]) => input.toString());
    expect(urls.some((url) => url.includes("finalize_appointment_offer_queue_job"))).toBe(true);
  });

  it("does not resurrect a persisted appointment request after an unknown invitation reply", async () => {
    const currentMessage = "şimdilik istemiyorum";
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "safety_check",
          pet_id: PET_ID,
          intake_data: {
            schema_version: 1,
            ...extractionJson({
              intent: "appointment_request",
              pet_name: "Fluffy",
              reported_safety_signals: ALL_FALSE_SIGNALS,
            }),
          },
          recent_messages: [
            { direction: "outbound", content: POST_CONFIRMATION_APPOINTMENT_INVITATION_TEXT, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: currentMessage, created_at: "2026-01-01T00:00:01Z" },
            { direction: "inbound", content: "ardından gelen ikinci mesaj", created_at: "2026-01-01T00:00:02Z" },
          ],
        }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: currentMessage }),
      extraction: extractionJson({
        intent: "unknown",
        complaint: null,
        reported_safety_signals: ALL_FALSE_SIGNALS,
      }),
      finalize: () => finalizeRow("applied"),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");

    const urls = fetchMock.mock.calls.map(([input]) => input.toString());
    expect(bodyOf(fetchMock, 2).input).toHaveLength(2);
    expect(urls.some((url) => url.includes("finalize_appointment_offer_queue_job"))).toBe(false);
    expect(bodyOf(fetchMock, 4).p_intake_data).toMatchObject({ intent: "routine_request" });
  });

  it("omits the context item when the nearest prior outbound message is not a question", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "safety_check",
          recent_messages: [
            { direction: "outbound", content: "Teşekkürler, bilgi için bekliyoruz.", created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: MESSAGE_TEXT, created_at: "2026-01-01T00:00:01Z" },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    const body = bodyOf(fetchMock, 2);
    const input = body.input as Array<{ role: string; content: string }>;
    const userMessages = input.filter((item) => item.role === "user");
    expect(userMessages).toEqual([{ role: "user", content: MESSAGE_TEXT }]);
  });

  it.each([
    ["the final inbound does not match the claimed message", "Nefes almakta güçlük var mı?", "different message"],
    ["the prior question is over 4096 Unicode code points", `${"a".repeat(4096)}?`, MESSAGE_TEXT],
  ])("omits context when %s", async (_label, priorQuestion, finalInbound) => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          recent_messages: [
            { direction: "outbound", content: priorQuestion, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: finalInbound, created_at: "2026-01-01T00:00:01Z" },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    expect((bodyOf(fetchMock, 2).input as unknown[])).toHaveLength(2);
  });
});

describe("processIntakeQueueMessage: Task 042 AI usage metering wiring", () => {
  it("calls record_intake_ai_usage_v1 exactly once with the correct request shape before finalization", async () => {
    const fetchMock = happyRoutes({
      openai: () =>
        openAiResponse(extractionJson(), {
          input_tokens: 456,
          output_tokens: 78,
          total_tokens: 534,
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");

    const urls = fetchMock.mock.calls.map(([input]) => (input as { toString(): string }).toString());
    expect(urls.filter((url) => url.includes("record_intake_ai_usage_v1")).length).toBe(1);
    expect(urls.indexOf(urls.find((url) => url.includes("record_intake_ai_usage_v1"))!)).toBeLessThan(
      urls.findIndex((url) => url.includes("finalize_intake_queue_job")),
    );

    const meteringBody = bodyOf(fetchMock, 3);
    expect(meteringBody).toEqual({
      p_conversation_id: CONVERSATION_ID,
      p_provider_message_id: PROVIDER_MESSAGE_ID,
      p_claim_token: CLAIM_TOKEN,
      p_model: OPENAI_INTAKE_MODEL,
      p_prompt_version: INTAKE_EXTRACTION_PROMPT_VERSION,
      p_input_tokens: 456,
      p_output_tokens: 78,
      p_total_tokens: 534,
    });

    const serialized = JSON.stringify(meteringBody);
    for (const forbidden of [MESSAGE_TEXT, OWNER_ID, "vomiting"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("calls the metering RPC with a null token triplet when the model call omits usage", async () => {
    const fetchMock = happyRoutes({ openai: () => openAiResponse(extractionJson()) });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");

    const meteringBody = bodyOf(fetchMock, 3);
    expect(meteringBody.p_input_tokens).toBeNull();
    expect(meteringBody.p_output_tokens).toBeNull();
    expect(meteringBody.p_total_tokens).toBeNull();
  });

  it.each([
    { label: "recorded", response: meteringRow("recorded") },
    { label: "duplicate", response: meteringRow("duplicate") },
  ])("metering result $label preserves normal finalize behavior", async ({ response }) => {
    const fetchMock = happyRoutes({ metering: () => response });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    const urls = fetchMock.mock.calls.map(([input]) => (input as { toString(): string }).toString());
    expect(urls.some((url) => url.includes("finalize_intake_queue_job"))).toBe(true);
  });

  it.each([
    { label: "stale_claim", response: meteringRow("stale_claim") },
    { label: "not_found", response: meteringRow("not_found") },
  ])("metering result $label acknowledges without finalizing", async ({ response }) => {
    const fetchMock = happyRoutes({ metering: () => response, finalize: () => new Response("", { status: 500 }) });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries without finalizing when the metering RPC fails", async () => {
    const fetchMock = happyRoutes({
      metering: () => new Response("", { status: 500 }),
      finalize: () => new Response("", { status: 500 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("retry");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("no longer logs an openai_usage console line", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = happyRoutes({});
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    expect(logSpy.mock.calls.some(([message]) => message === "intake consumer: openai_usage")).toBe(false);
  });

  it("does not call the metering RPC on a no-model handoff path", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "human_handoff", pet_id: PET_ID, state_version: 5 }),
      finalize: () => finalizeRow("applied", { intake_stage: "human_handoff", state_version: 6 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    const urls = fetchMock.mock.calls.map(([input]) => (input as { toString(): string }).toString());
    expect(urls.some((url) => url.includes("record_intake_ai_usage_v1"))).toBe(false);
  });
});

describe("processIntakeQueueMessage: Task 029 no-model terminal/budget path (Part 2)", () => {
  it("human_handoff stage finalizes to human_handoff without any OpenAI call", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "human_handoff", pet_id: PET_ID, state_version: 5, intake_data: {} }),
      finalize: () => finalizeRow("applied", { intake_stage: "human_handoff", state_version: 6 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const urls = fetchMock.mock.calls.map(([input]) => (input as { toString(): string }).toString());
    expect(urls.some((url) => url.includes("api.openai.com"))).toBe(false);
    const finalizeBody = bodyOf(fetchMock, 3);
    expect(finalizeBody.p_next_stage).toBe("human_handoff");
    expect(finalizeBody.p_pet_id).toBe(PET_ID);
    expect(finalizeBody.p_reply_category).toBe("human_handoff");
  });

  it("preserves an already-persisted emergency signal and emergency reply without any OpenAI call", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "human_handoff",
          pet_id: PET_ID,
          state_version: 5,
          intake_data: {
            schema_version: 1,
            ...extractionJson({
              reported_safety_signals: { ...ALL_FALSE_SIGNALS, breathing_difficulty: true },
            }),
          },
        }),
      finalize: () => finalizeRow("applied", { intake_stage: "human_handoff", state_version: 6 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map(([input]) => (input as { toString(): string }).toString());
    expect(urls.some((url) => url.includes("api.openai.com"))).toBe(false);
    const finalizeBody = bodyOf(fetchMock, 2);
    expect(finalizeBody.p_next_stage).toBe("human_handoff");
    expect(finalizeBody.p_reply_category).toBe("emergency_handoff");
  });

  it("stateVersion at or above the ceiling routes a non-completed, non-handoff stage to human_handoff without any OpenAI call", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "safety_check", pet_id: PET_ID, state_version: 12, intake_data: {} }),
      finalize: () => finalizeRow("applied", { intake_stage: "human_handoff", state_version: 13 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const finalizeBody = bodyOf(fetchMock, 3);
    expect(finalizeBody.p_next_stage).toBe("human_handoff");
  });

  it("stateVersion just below the ceiling still performs a normal OpenAI call", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "safety_check", pet_id: PET_ID, state_version: 11 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const urls = fetchMock.mock.calls.map(([input]) => (input as { toString(): string }).toString());
    expect(urls.some((url) => url.includes("api.openai.com"))).toBe(true);
  });

  it("a completed stage is exempt from the stateVersion ceiling and still performs a normal OpenAI call", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "completed", pet_id: PET_ID, state_version: 20 }),
      finalize: () => finalizeRow("applied", { intake_stage: "completed", state_version: 21 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const urls = fetchMock.mock.calls.map(([input]) => (input as { toString(): string }).toString());
    expect(urls.some((url) => url.includes("api.openai.com"))).toBe(true);
  });

  it("a malformed persisted snapshot on the no-model human_handoff path retries and never finalizes", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "human_handoff", pet_id: PET_ID, intake_data: { bogus_field: true } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("retry");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("processIntakeQueueMessage: Task 029 no-progress fallback (Part 3)", () => {
  const REPEATED_QUESTION = "Hangi evcil hayvanınız için yazıyorsunuz? Lütfen adını belirtin.";

  it("two identical eligible prior clinic questions with no actionable extracted fact forces human_handoff", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "pet_identification",
          pet_id: null,
          recent_messages: [
            { direction: "outbound", content: REPEATED_QUESTION, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "anlamadım", created_at: "2026-01-01T00:00:01Z" },
            { direction: "outbound", content: REPEATED_QUESTION, created_at: "2026-01-01T00:00:02Z" },
            { direction: "inbound", content: MESSAGE_TEXT, created_at: "2026-01-01T00:00:03Z" },
          ],
        }),
      extraction: extractionJson({
        intent: "unknown",
        pet_name: null,
        species: null,
        complaint: null,
        symptoms: [],
        reported_safety_signals: ALL_NULL_SIGNALS,
        user_requested_human: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 5);
    expect(finalizeBody.p_next_stage).toBe("human_handoff");
    expect(finalizeBody.p_reply_category).toBe("human_handoff");
  });

  it("recognizes the same no-progress turn when the burst claim labels its single message", async () => {
    const rawMessage = "anlamadım";
    const fetchMock = happyRoutes({
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: `Mesaj 1: ${rawMessage}` }),
      context: () =>
        contextRow({
          intake_stage: "pet_identification",
          pet_id: null,
          recent_messages: [
            { direction: "outbound", content: REPEATED_QUESTION, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "bilmiyorum", created_at: "2026-01-01T00:00:01Z" },
            { direction: "outbound", content: REPEATED_QUESTION, created_at: "2026-01-01T00:00:02Z" },
            { direction: "inbound", content: rawMessage, created_at: "2026-01-01T00:00:03Z" },
          ],
        }),
      extraction: extractionJson({
        intent: "unknown",
        pet_name: null,
        species: null,
        complaint: null,
        symptoms: [],
        reported_safety_signals: ALL_NULL_SIGNALS,
        user_requested_human: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    expect(bodyOf(fetchMock, 5)).toMatchObject({
      p_next_stage: "human_handoff",
      p_reply_category: "human_handoff",
    });
  });

  it("only one prior eligible question does not trigger the fallback", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "pet_identification",
          pet_id: null,
          recent_messages: [
            { direction: "outbound", content: REPEATED_QUESTION, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: MESSAGE_TEXT, created_at: "2026-01-01T00:00:01Z" },
          ],
        }),
      extraction: extractionJson({
        intent: "unknown",
        pet_name: null,
        species: null,
        complaint: null,
        symptoms: [],
        reported_safety_signals: ALL_NULL_SIGNALS,
        user_requested_human: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    const finalizeBody = bodyOf(fetchMock, 4);
    expect(finalizeBody.p_next_stage).not.toBe("human_handoff");
  });

  // Was "an actionable extracted fact does not trigger the fallback even with
  // two identical prior questions", asserted with `pet_name: "Pamuk"` against
  // an owner whose only pet is Fluffy. That combination does not advance the
  // stage, so the old fixture was pinning the pet_identification loop as
  // correct. The guard it was really meant to provide — a turn that makes
  // progress must not be handed off — is kept here with a name that resolves.
  it("an actionable extracted fact that advances the stage does not trigger the fallback", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "pet_identification",
          pet_id: null,
          recent_messages: [
            { direction: "outbound", content: REPEATED_QUESTION, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "anlamadım", created_at: "2026-01-01T00:00:01Z" },
            { direction: "outbound", content: REPEATED_QUESTION, created_at: "2026-01-01T00:00:02Z" },
            { direction: "inbound", content: MESSAGE_TEXT, created_at: "2026-01-01T00:00:03Z" },
          ],
        }),
      extraction: extractionJson({ pet_name: "Fluffy", reported_safety_signals: ALL_NULL_SIGNALS }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    // Asserted positively: `not.toBe` also passes on an undefined body, which
    // is how the old fixture could have gone green for the wrong reason.
    const finalizeBody = bodyOf(fetchMock, 4);
    expect(finalizeBody.p_next_stage).toBe("complaint_collection");
  });

  // Was "an owner with an existing pet naming a different animal is handed
  // off after the identical question repeats" (the live-smoke loop of
  // 2026-08-27, bounded by Task 036's fallback because the turn resolved
  // `needs_clarification` and held at `pet_identification` forever). Task 037
  // makes an unmatched name against an *unbound* conversation a `new_candidate`
  // instead, so the second pet now registers on the very first turn and the
  // bounded fallback is never reached — even with two identical prior
  // questions already on record.
  it("an owner with an existing pet naming a distinct second pet now advances instead of hitting the bounded fallback", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "pet_identification",
          pet_id: null,
          recent_messages: [
            { direction: "outbound", content: REPEATED_QUESTION, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "Minnoş", created_at: "2026-01-01T00:00:01Z" },
            { direction: "outbound", content: REPEATED_QUESTION, created_at: "2026-01-01T00:00:02Z" },
            { direction: "inbound", content: MESSAGE_TEXT, created_at: "2026-01-01T00:00:03Z" },
          ],
        }),
      extraction: extractionJson({ pet_name: "Minnoş", species: "kedi", reported_safety_signals: ALL_NULL_SIGNALS }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 4);
    expect(finalizeBody.p_next_stage).toBe("complaint_collection");
    expect(finalizeBody.p_reply_category).not.toBe("human_handoff");
  });

  // Same fix (Task 037), with only one prior identical question on record:
  // the old bound never engaged this case anyway, but the second pet must
  // still register normally rather than stalling at `pet_identification`.
  it("an owner naming a distinct second pet advances after only one prior question too", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "pet_identification",
          pet_id: null,
          recent_messages: [
            { direction: "outbound", content: REPEATED_QUESTION, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: MESSAGE_TEXT, created_at: "2026-01-01T00:00:01Z" },
          ],
        }),
      extraction: extractionJson({ pet_name: "Minnoş", species: "kedi", reported_safety_signals: ALL_NULL_SIGNALS }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    const finalizeBody = bodyOf(fetchMock, 4);
    expect(finalizeBody.p_next_stage).toBe("complaint_collection");
  });

  it("two different prior questions do not trigger the fallback", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "pet_identification",
          pet_id: null,
          recent_messages: [
            { direction: "outbound", content: "Soru A nedir?", created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "anlamadım", created_at: "2026-01-01T00:00:01Z" },
            { direction: "outbound", content: "Soru B nedir?", created_at: "2026-01-01T00:00:02Z" },
            { direction: "inbound", content: MESSAGE_TEXT, created_at: "2026-01-01T00:00:03Z" },
          ],
        }),
      extraction: extractionJson({
        intent: "unknown",
        pet_name: null,
        species: null,
        complaint: null,
        symptoms: [],
        reported_safety_signals: ALL_NULL_SIGNALS,
        user_requested_human: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    const finalizeBody = bodyOf(fetchMock, 4);
    expect(finalizeBody.p_next_stage).not.toBe("human_handoff");
  });

  it("two identical non-question outbound messages do not trigger the fallback", async () => {
    const repeatedStatement = "Lütfen evcil hayvanınızın adını yazın.";
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "pet_identification",
          pet_id: null,
          recent_messages: [
            { direction: "outbound", content: repeatedStatement, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "anlamadım", created_at: "2026-01-01T00:00:01Z" },
            { direction: "outbound", content: repeatedStatement, created_at: "2026-01-01T00:00:02Z" },
            { direction: "inbound", content: MESSAGE_TEXT, created_at: "2026-01-01T00:00:03Z" },
          ],
        }),
      extraction: extractionJson({
        intent: "unknown",
        pet_name: null,
        species: null,
        complaint: null,
        symptoms: [],
        reported_safety_signals: ALL_NULL_SIGNALS,
        user_requested_human: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    expect(bodyOf(fetchMock, 4).p_next_stage).not.toBe("human_handoff");
  });

  it("does not trigger from stale history when the final inbound is not the claimed message", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "pet_identification",
          pet_id: null,
          recent_messages: [
            { direction: "outbound", content: REPEATED_QUESTION, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "anlamadım", created_at: "2026-01-01T00:00:01Z" },
            { direction: "outbound", content: REPEATED_QUESTION, created_at: "2026-01-01T00:00:02Z" },
            { direction: "inbound", content: "later inbound", created_at: "2026-01-01T00:00:03Z" },
          ],
        }),
      extraction: extractionJson({
        intent: "unknown",
        pet_name: null,
        species: null,
        complaint: null,
        symptoms: [],
        reported_safety_signals: ALL_NULL_SIGNALS,
        user_requested_human: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    expect(bodyOf(fetchMock, 4).p_next_stage).not.toBe("human_handoff");
  });

  it("never overrides a completed conversation even with repeated questions and no actionable fact", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "completed",
          pet_id: PET_ID,
          recent_messages: [
            { direction: "outbound", content: REPEATED_QUESTION, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "anlamadım", created_at: "2026-01-01T00:00:01Z" },
            { direction: "outbound", content: REPEATED_QUESTION, created_at: "2026-01-01T00:00:02Z" },
            { direction: "inbound", content: MESSAGE_TEXT, created_at: "2026-01-01T00:00:03Z" },
          ],
        }),
      extraction: extractionJson({
        intent: "unknown",
        pet_name: null,
        species: null,
        complaint: null,
        symptoms: [],
        reported_safety_signals: ALL_NULL_SIGNALS,
        user_requested_human: false,
      }),
      finalize: () => finalizeRow("applied", { intake_stage: "completed", state_version: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 4);
    expect(finalizeBody.p_next_stage).toBe("completed");
    expect(finalizeBody.p_reply_category).toBeNull();
  });
});

describe("processIntakeQueueMessage: selected-pet conflict handoff (Task 037)", () => {
  it("naming a different, unmatched pet while one is already selected routes to human_handoff without relinking, creating, or persisting the new animal's identity or clinical facts", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "complaint_collection",
          pet_id: PET_ID,
          pets: [{ id: PET_ID, name: "Fluffy", species: "cat" }],
          intake_data: {
            schema_version: 1,
            intent: "report_symptom",
            pet_name: "Fluffy",
            species: "cat",
            complaint: "eating less",
            symptoms: [],
            reported_safety_signals: ALL_NULL_SIGNALS,
            missing_information: [],
            user_requested_human: false,
          },
        }),
      extraction: extractionJson({ pet_name: "Rocky", species: "dog", complaint: "kusuyor" }),
      clinic: () => clinicRow(),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    // 6 calls: claim, context, OpenAI, metering, clinic-operational-context (a
    // human_handoff-category reply is personalized before finalize), finalize.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const body = bodyOf(fetchMock, 5);
    expect(body.p_next_stage).toBe("human_handoff");
    expect(body.p_reply_category).toBe("human_handoff");
    expect(body.p_pet_id).toBe(PET_ID);
    expect(body.p_create_pet_name).toBeNull();
    const intakeData = body.p_intake_data as Record<string, unknown>;
    // The already-selected pet's identity and clinical facts are preserved;
    // the conflicting animal's name/species/complaint are never persisted.
    expect(intakeData.pet_name).toBe("Fluffy");
    expect(intakeData.species).toBe("cat");
    expect(intakeData.complaint).toBe("eating less");
  });

  it("a true safety signal reported alongside a conflicting pet name still merges through for escalation", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "complaint_collection",
          pet_id: PET_ID,
          pets: [{ id: PET_ID, name: "Fluffy", species: "cat" }],
          intake_data: {
            schema_version: 1,
            intent: "report_symptom",
            pet_name: "Fluffy",
            species: "cat",
            complaint: "eating less",
            symptoms: [],
            reported_safety_signals: ALL_NULL_SIGNALS,
            missing_information: [],
            user_requested_human: false,
          },
        }),
      extraction: extractionJson({
        pet_name: "Rocky",
        species: "dog",
        complaint: "kusuyor",
        reported_safety_signals: { ...ALL_FALSE_SIGNALS, heavy_bleeding: true },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    // 5 calls: claim, context, OpenAI, metering, finalize — an emergency-grade
    // reply is not clinic-personalized (Task 031's gate is human_handoff-only).
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const body = bodyOf(fetchMock, 4);
    expect(body.p_next_stage).toBe("human_handoff");
    const intakeData = body.p_intake_data as Record<string, unknown>;
    expect(intakeData.pet_name).toBe("Fluffy");
    expect((intakeData.reported_safety_signals as Record<string, unknown>).heavy_bleeding).toBe(true);
  });

  it("does not call OpenAI on the turn after a conflict has already forced human_handoff", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "human_handoff", pet_id: PET_ID }),
      finalize: () => finalizeRow("applied", { intake_stage: "human_handoff", state_version: 3 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    // claim, context, clinic-operational-context, finalize — no OpenAI call.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("processIntakeQueueMessage: bounded work per attempt", () => {
  it("calls claim, context, OpenAI, metering, and finalize exactly once each on the happy path, and never completes separately", async () => {
    const fetchMock = happyRoutes();
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const urls = fetchMock.mock.calls.map(([input]) => (input as { toString(): string }).toString());
    expect(urls.some((url) => url.includes("complete_intake_queue_job"))).toBe(false);
  });

  it("never rejects, even when fetch throws a non-Error value", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce("boom");
    vi.stubGlobal("fetch", fetchMock);

    await expect(processIntakeQueueMessage(validBody, env)).resolves.toBe("retry");
  });
});

describe("processIntakeQueueMessage: Task 030 unsupported-media marker", () => {
  const MEDIA_REPLY_TEXT =
    "Bu bot şu anda görsel, ses, video, belge, konum veya kişi kartı içeriğini değerlendiremiyor. Lütfen durumu yazılı mesajla açıklayın veya kliniğimizi telefonla arayın. Durum acilse bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.";

  function markerRoutes(overrides: Partial<Routes> = {}) {
    return happyRoutes({
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: UNSUPPORTED_MEDIA_MARKER }),
      ...overrides,
    });
  }

  function urlsOf(fetchMock: ReturnType<typeof vi.fn>): string[] {
    return fetchMock.mock.calls.map(([input]) => (input as { toString(): string }).toString());
  }

  it("makes zero OpenAI calls, keeps the current stage/pet/snapshot, and sends the exact fixed reply", async () => {
    const snapshot = { schema_version: 1, ...extractionJson({ reported_safety_signals: ALL_FALSE_SIGNALS }) };
    const fetchMock = markerRoutes({
      context: () => contextRow({ intake_stage: "complaint_collection", pet_id: PET_ID, state_version: 3, intake_data: snapshot }),
      finalize: () => finalizeRow("applied", { intake_stage: "complaint_collection", state_version: 4 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(urlsOf(fetchMock).some((url) => url.includes("api.openai.com"))).toBe(false);
    const finalizeBody = bodyOf(fetchMock, 2);
    expect(finalizeBody.p_next_stage).toBe("complaint_collection");
    expect(finalizeBody.p_pet_id).toBe(PET_ID);
    expect(finalizeBody.p_expected_version).toBe(3);
    expect(finalizeBody.p_intake_data).toEqual({ ...snapshot, pending_cancel_slot_id: null });
    expect(finalizeBody.p_reply_category).toBe("intake_received");
    expect(finalizeBody.p_reply_text).toBe(MEDIA_REPLY_TEXT);
  });

  it("never sends the marker, prior question, snapshot, or media information anywhere near OpenAI", async () => {
    const fetchMock = markerRoutes({
      context: () =>
        contextRow({
          intake_stage: "pet_identification",
          intake_data: {},
          recent_messages: [
            { direction: "outbound", content: "Hangi evcil hayvanınız için yazıyorsunuz?", created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: UNSUPPORTED_MEDIA_MARKER, created_at: "2026-01-01T00:01:00Z" },
          ],
        }),
      finalize: () => finalizeRow("applied", { intake_stage: "pet_identification", state_version: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    expect(urlsOf(fetchMock).some((url) => url.includes("api.openai.com"))).toBe(false);
    const finalizeBody = JSON.stringify(bodyOf(fetchMock, 2));
    expect(finalizeBody).not.toContain(UNSUPPORTED_MEDIA_MARKER);
    expect(finalizeBody).not.toContain("Hangi evcil hayvanınız için yazıyorsunuz?");
  });

  it("preserves an already-persisted explicit emergency signal with the existing emergency reply and handoff", async () => {
    const fetchMock = markerRoutes({
      context: () =>
        contextRow({
          intake_stage: "safety_check",
          pet_id: PET_ID,
          state_version: 3,
          intake_data: {
            schema_version: 1,
            ...extractionJson({ reported_safety_signals: { ...ALL_FALSE_SIGNALS, heavy_bleeding: true } }),
          },
        }),
      finalize: () => finalizeRow("applied", { intake_stage: "human_handoff", state_version: 4 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    expect(urlsOf(fetchMock).some((url) => url.includes("api.openai.com"))).toBe(false);
    const finalizeBody = bodyOf(fetchMock, 2);
    expect(finalizeBody.p_next_stage).toBe("human_handoff");
    expect(finalizeBody.p_reply_category).toBe("emergency_handoff");
    expect(finalizeBody.p_reply_text).not.toBe(MEDIA_REPLY_TEXT);
  });

  it("does not infer a new safety fact from media: an all-false snapshot still gets the media reply", async () => {
    const fetchMock = markerRoutes({
      context: () =>
        contextRow({
          intake_stage: "safety_check",
          pet_id: PET_ID,
          intake_data: { schema_version: 1, ...extractionJson({ reported_safety_signals: ALL_NULL_SIGNALS }) },
        }),
      finalize: () => finalizeRow("applied", { intake_stage: "safety_check", state_version: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    expect(bodyOf(fetchMock, 2).p_reply_text).toBe(MEDIA_REPLY_TEXT);
  });

  it.each([
    { label: "the no-model state-version ceiling", intake_stage: "safety_check", state_version: 12 },
    { label: "an existing handoff stage", intake_stage: "human_handoff", state_version: 4 },
  ])("$label finalizes media to the truthful handoff without OpenAI", async ({ intake_stage, state_version }) => {
    const fetchMock = markerRoutes({
      context: () => contextRow({ intake_stage, state_version, intake_data: {} }),
      finalize: () => finalizeRow("applied", { intake_stage: "human_handoff", state_version: state_version + 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    expect(urlsOf(fetchMock).some((url) => url.includes("api.openai.com"))).toBe(false);
    const finalizeBody = bodyOf(fetchMock, 3);
    expect(finalizeBody.p_next_stage).toBe("human_handoff");
    expect(finalizeBody.p_reply_category).toBe("human_handoff");
    expect(finalizeBody.p_reply_text).not.toBe(MEDIA_REPLY_TEXT);
  });

  it("a malformed persisted snapshot retries and never finalizes", async () => {
    const fetchMock = markerRoutes({ context: () => contextRow({ intake_data: { bogus_field: true } }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("retry");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a completed conversation stays completed and produces no reply", async () => {
    const fetchMock = markerRoutes({
      context: () => contextRow({ intake_stage: "completed", pet_id: PET_ID, state_version: 9, intake_data: {} }),
      finalize: () => finalizeRow("already_completed"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processIntakeQueueMessage(validBody, env);

    expect(result).toBe("ack");
    const finalizeBody = bodyOf(fetchMock, 2);
    expect(finalizeBody.p_next_stage).toBe("completed");
    expect(finalizeBody.p_reply_category).toBeNull();
    expect(finalizeBody.p_reply_text).toBeNull();
  });

  it.each([
    { label: "applied", row: () => finalizeRow("applied", { intake_stage: "safety_check", state_version: 2 }), expected: "ack" as QueueDisposition },
    { label: "already_completed", row: () => finalizeRow("already_completed"), expected: "ack" as QueueDisposition },
    { label: "stale_claim", row: () => finalizeRow("stale_claim"), expected: "ack" as QueueDisposition },
    { label: "stale_state", row: () => finalizeRow("stale_state"), expected: "retry" as QueueDisposition },
    { label: "RPC failure", row: () => new Response("", { status: 500 }), expected: "retry" as QueueDisposition },
  ])("finalize $label -> $expected", async ({ row, expected }) => {
    const fetchMock = markerRoutes({ finalize: row });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe(expected);
  });

  it("a real text message that is not the exact marker still takes the normal OpenAI path", async () => {
    const fetchMock = happyRoutes({
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: `${UNSUPPORTED_MEDIA_MARKER} ` }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await processIntakeQueueMessage(validBody, env);

    expect(urlsOf(fetchMock).some((url) => url.includes("api.openai.com"))).toBe(true);
  });
});

describe("processIntakeQueueMessage: non-ai claim short-circuit (Task 033 race window a)", () => {
  function completeRow(result: "completed" | "stale"): Response {
    return jsonResponse([{ result }]);
  }

  it.each(["manual", "personal"] as const)(
    "completes the lease and acks immediately for a %s claim, without any context, OpenAI, or finalize call",
    async (automationMode) => {
      const fetchMock = routedFetch({
        claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: null, automation_mode: automationMode }),
        complete: () => completeRow("completed"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await processIntakeQueueMessage(validBody, env);

      expect(result).toBe("ack");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const completeBody = bodyOf(fetchMock, 1);
      expect(completeBody).toEqual({
        p_conversation_id: CONVERSATION_ID,
        p_provider_message_id: PROVIDER_MESSAGE_ID,
        p_claim_token: CLAIM_TOKEN,
      });
    },
  );

  it("retries when the immediate completion reports a stale claim", async () => {
    const fetchMock = routedFetch({
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: null, automation_mode: "manual" }),
      complete: () => completeRow("stale"),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("retry");
  });

  it("retries when the completion call fails closed", async () => {
    const fetchMock = routedFetch({
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: null, automation_mode: "manual" }),
      complete: () => new Response("", { status: 500 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("retry");
  });
});

describe("processIntakeQueueMessage: intake confirmation routing (Task 036)", () => {
  it("entering intake_confirmation asks one combined name/species/complaint question", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "complaint_collection",
          pet_id: null,
          pets: [],
          recent_messages: [
            { direction: "outbound", content: PET_IDENTITY_TEXT, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "Pamuk, topallıyor", created_at: "2026-01-01T00:00:01Z" },
          ],
        }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: "Pamuk, topallıyor" }),
      extraction: extractionJson({ pet_name: "Pamuk", species: "kedi", complaint: "topallıyor" }),
      finalize: () => finalizeRow("applied", { intake_stage: "intake_confirmation", state_version: 3 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    const body = bodyOf(fetchMock, 4);
    expect(body.p_next_stage).toBe("intake_confirmation");
    expect(body.p_reply_category).toBe("intake_confirmation");
    expect(body.p_reply_text).toBe(buildIntakeConfirmationText("Pamuk", "kedi", "topallıyor"));
    // Nothing is written to `pets` until the owner has actually confirmed.
    expect(body.p_create_pet_name).toBeNull();
    expect(body.p_pet_id).toBeNull();
    // Task 036: the pending fields survive the turn — they are what the next
    // turn compares the owner's answer against.
    expect((body.p_intake_data as Record<string, unknown>).pet_name).toBe("Pamuk");
    expect((body.p_intake_data as Record<string, unknown>).complaint).toBe("topallıyor");
  });

  it("an explicit evet to the exact combined summary creates the pet and advances to safety_check", async () => {
    const confirmationText = buildIntakeConfirmationText("Pamuk", "kedi", "topallıyor");
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "intake_confirmation",
          pet_id: null,
          pets: [],
          recent_messages: [
            { direction: "outbound", content: confirmationText, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "evet", created_at: "2026-01-01T00:00:01Z" },
          ],
        }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: "evet" }),
      extraction: extractionJson({ pet_name: "Pamuk", species: "kedi", complaint: "topallıyor" }),
      finalize: () => finalizeRow("applied", { intake_stage: "safety_check", state_version: 3 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    const body = bodyOf(fetchMock, 4);
    expect(body.p_next_stage).toBe("safety_check");
    expect(body.p_create_pet_name).toBe("Pamuk");
    expect(body.p_create_pet_species).toBe("kedi");
    expect(body.p_pet_id).toBeNull();
    expect(body.p_reply_category).toBe("intake_received");
    expect(body.p_reply_text).toBe(POST_CONFIRMATION_APPOINTMENT_INVITATION_TEXT);
  });

  it("creates a distinct second pet after exact evet when the unbound owner already has another pet", async () => {
    const confirmationText = buildIntakeConfirmationText("Pamuk", "kedi", "topallıyor");
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "intake_confirmation",
          pet_id: null,
          pets: [{ id: PET_ID, name: "Fluffy", species: "cat" }],
          recent_messages: [
            { direction: "outbound", content: confirmationText, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "evet", created_at: "2026-01-01T00:00:01Z" },
          ],
        }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: "evet" }),
      extraction: extractionJson({ pet_name: "Pamuk", species: "kedi", complaint: "topallıyor" }),
      finalize: () => finalizeRow("applied", { intake_stage: "safety_check", state_version: 3 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    const body = bodyOf(fetchMock, 4);
    expect(body.p_next_stage).toBe("safety_check");
    expect(body.p_pet_id).toBeNull();
    expect(body.p_create_pet_name).toBe("Pamuk");
    expect(body.p_create_pet_species).toBe("kedi");
  });

  it("an evet from an owner whose pet is already on file advances without creating a duplicate row", async () => {
    const confirmationText = buildIntakeConfirmationText("Fluffy", "cat", "topallıyor");
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "intake_confirmation",
          pet_id: null,
          recent_messages: [
            { direction: "outbound", content: confirmationText, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "evet", created_at: "2026-01-01T00:00:01Z" },
          ],
        }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: "evet" }),
      extraction: extractionJson({ pet_name: "Fluffy", species: "cat", complaint: "topallıyor" }),
      finalize: () => finalizeRow("applied", { intake_stage: "safety_check", state_version: 3 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    const body = bodyOf(fetchMock, 4);
    expect(body.p_next_stage).toBe("safety_check");
    expect(body.p_create_pet_name).toBeNull();
    expect(body.p_pet_id).toBe(PET_ID);
  });

  it("a hayır asks what to correct and — unlike Task 035 — keeps the collected fields", async () => {
    const confirmationText = buildIntakeConfirmationText("Pamuk", null, null);
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "intake_confirmation",
          pet_id: null,
          pets: [],
          recent_messages: [
            { direction: "outbound", content: confirmationText, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "hayır", created_at: "2026-01-01T00:00:01Z" },
          ],
        }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: "hayır" }),
      extraction: extractionJson({ pet_name: "Pamuk", species: null, complaint: null }),
      finalize: () => finalizeRow("applied", { intake_stage: "intake_confirmation", state_version: 3 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    const body = bodyOf(fetchMock, 4);
    expect(body.p_next_stage).toBe("intake_confirmation");
    expect(body.p_reply_category).toBe("intake_confirmation");
    expect(body.p_reply_text).toBe(INTAKE_CORRECTION_PROMPT_TEXT);
    expect(body.p_create_pet_name).toBeNull();
    // The Task 035 behaviour was to null these out and restart from the
    // generic identity question; the correction flow keeps them so the owner
    // only has to restate the part that is wrong.
    expect((body.p_intake_data as Record<string, unknown>).pet_name).toBe("Pamuk");
  });

  it("a correcting reply re-confirms the updated summary rather than creating under the old one", async () => {
    const confirmationText = buildIntakeConfirmationText("Pamuk", null, null);
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "intake_confirmation",
          pet_id: null,
          pets: [],
          recent_messages: [
            { direction: "outbound", content: confirmationText, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "hayır, adı Karabaş", created_at: "2026-01-01T00:00:01Z" },
          ],
        }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: "hayır, adı Karabaş" }),
      extraction: extractionJson({ pet_name: "Karabaş", species: null, complaint: null }),
      finalize: () => finalizeRow("applied", { intake_stage: "intake_confirmation", state_version: 3 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    const body = bodyOf(fetchMock, 4);
    expect(body.p_next_stage).toBe("intake_confirmation");
    expect(body.p_reply_text).toBe(buildIntakeConfirmationText("Karabaş", null, null));
    expect(body.p_create_pet_name).toBeNull();
  });

  it("forces human_handoff once the identical confirmation has been asked to the bound", async () => {
    const confirmationText = buildIntakeConfirmationText("Pamuk", null, null);
    const recentMessages = [
      ...Array.from({ length: 3 }, (_, i) => ({
        direction: "outbound" as const,
        content: confirmationText,
        created_at: `2026-01-01T00:00:0${i}Z`,
      })),
      { direction: "inbound" as const, content: "tamam", created_at: "2026-01-01T00:00:03Z" },
    ];
    const fetchMock = happyRoutes({
      context: () => contextRow({ intake_stage: "intake_confirmation", pet_id: null, pets: [], recent_messages: recentMessages }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: "tamam" }),
      extraction: extractionJson({ pet_name: "Pamuk", species: null, complaint: null }),
      finalize: () => finalizeRow("applied", { intake_stage: "human_handoff", state_version: 3 }),
      clinic: () => clinicRow(),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    // 6 calls: claim, context, OpenAI, metering, clinic-operational-context (a
    // human_handoff-category reply is personalized before finalize — see
    // `prepareOutboundReply`), finalize.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const body = bodyOf(fetchMock, 5);
    expect(body.p_next_stage).toBe("human_handoff");
    expect(body.p_reply_category).toBe("human_handoff");
    expect(body.p_create_pet_name).toBeNull();
  });

  it("a needs_safety_check signal takes precedence over an in-progress confirmation (safety must never be deferred)", async () => {
    const confirmationText = buildIntakeConfirmationText("Pamuk", null, null);
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "intake_confirmation",
          pet_id: null,
          pets: [],
          recent_messages: [
            { direction: "outbound", content: confirmationText, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "evet ama nefes almakta güçlük çekiyor", created_at: "2026-01-01T00:00:01Z" },
          ],
        }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: "evet ama nefes almakta güçlük çekiyor" }),
      extraction: extractionJson({
        pet_name: "Pamuk",
        species: null,
        complaint: null,
        reported_safety_signals: { ...ALL_FALSE_SIGNALS, breathing_difficulty: null },
      }),
      finalize: () => finalizeRow("applied", { intake_stage: "intake_confirmation", state_version: 3 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    const body = bodyOf(fetchMock, 4);
    // Must be the safety questionnaire, not a confirmation and not a pet
    // creation — no p_create_pet_name on this turn.
    expect(body.p_reply_category).toBe("safety_questions");
    expect(body.p_create_pet_name).toBeNull();
  });

  it("a duplicate_pet_name RPC result is treated as retryable, not acked", async () => {
    const confirmationText = buildIntakeConfirmationText("Pamuk", null, null);
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          intake_stage: "intake_confirmation",
          pet_id: null,
          pets: [],
          recent_messages: [
            { direction: "outbound", content: confirmationText, created_at: "2026-01-01T00:00:00Z" },
            { direction: "inbound", content: "evet", created_at: "2026-01-01T00:00:01Z" },
          ],
        }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: "evet" }),
      extraction: extractionJson({ pet_name: "Pamuk", species: null, complaint: null }),
      finalize: () => jsonResponse([{ result: "duplicate_pet_name", intake_stage: null, state_version: null }]),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("retry");
  });
});

describe("processIntakeQueueMessage: recording notice (Task 036)", () => {
  // The notice TEXT is a draft pending KVKK sign-off; these tests read the
  // exported constant rather than restating it, so a sign-off rewording does
  // not have to touch this file. What they pin is the mechanism: attached
  // once, on the conversation's first turn only.
  it("prefixes the first turn's reply with the recording notice", async () => {
    const fetchMock = happyRoutes({
      context: () =>
        contextRow({
          state_version: 1,
          recent_messages: [{ direction: "inbound", content: "merhaba", created_at: "2026-01-01T00:00:00Z" }],
        }),
      claim: () => claimRow("claimed", { claim_token: CLAIM_TOKEN, message_text: "merhaba" }),
      finalize: () => finalizeRow("applied", { intake_stage: "safety_check", state_version: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    const text = bodyOf(fetchMock, 4).p_reply_text as string;
    expect(text.startsWith(RECORDING_NOTICE_DRAFT_TEXT)).toBe(true);
    // Prefixed, not replacing: the turn's own reply still follows it.
    expect(text.length).toBeGreaterThan(RECORDING_NOTICE_DRAFT_TEXT.length + 2);
  });

  it("does not repeat the notice on later turns", async () => {
    const fetchMock = happyRoutes({
      context: () => contextRow({ state_version: 4 }),
      finalize: () => finalizeRow("applied", { intake_stage: "safety_check", state_version: 5 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await processIntakeQueueMessage(validBody, env)).toBe("ack");
    expect(bodyOf(fetchMock, 4).p_reply_text as string).not.toContain(RECORDING_NOTICE_DRAFT_TEXT);
  });
});
