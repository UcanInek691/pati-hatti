import { afterEach, describe, expect, it, vi } from "vitest";
import {
  finalizeAppointmentDecisionQueueJob,
  finalizeAppointmentOfferQueueJob,
  parseAppointmentDecision,
  planAppointmentAction,
} from "../src/appointmentFlow";
import type { FinalizeAppointmentDecisionInput, FinalizeAppointmentOfferInput } from "../src/appointmentFlow";
import type { ConversationIntakeContext, IntakeStage } from "../src/conversationState";
import type { PersistedIntakeData, PlanResult } from "../src/intakeTurn";
import type { PetResolution } from "../src/intakeExtraction";
import type { SafetyDecision } from "../src/safetyDecision";
import type { Env } from "../src/env";
import type { IntakeQueueMessage } from "../src/intakeQueue";

const env: Env = {
  APP_TIMEZONE: "Europe/Istanbul",
  WHATSAPP_VERIFY_TOKEN: "secret-token",
  WHATSAPP_APP_SECRET: "test-app-secret",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  SUPABASE_ANON_KEY: "test-anon-key",
  OPENAI_API_KEY: "unused",
  INTAKE_QUEUE: { send: async () => {} } as unknown as Queue<IntakeQueueMessage>,
  WHATSAPP_ACCESS_TOKEN: "test-whatsapp-access-token",
  WHATSAPP_GRAPH_API_VERSION: "v25.0",
};

const conversationId = "11111111-1111-1111-1111-111111111111";
const claimToken = "22222222-2222-2222-2222-222222222222";
const petId = "66666666-6666-6666-6666-666666666666";
const providerMessageId = "wamid.ID1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function rawJsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseAppointmentDecision", () => {
  it.each(["evet", "EVET", "Evet", "  evet  ", "evet "])("accepts exact %j as confirm", (text) => {
    expect(parseAppointmentDecision(text)).toBe("confirm");
  });

  it.each(["hayır", "HAYIR", "Hayır", "hayir", "  hayır  "])("accepts exact %j as decline", (text) => {
    expect(parseAppointmentDecision(text)).toBe("decline");
  });

  it.each([
    "evet lütfen",
    "kesinlikle evet",
    "hayır olmaz",
    "tamam",
    "belki",
    "1",
    "22222222-2222-2222-2222-222222222222",
    "2026-08-10",
    "09:30",
    "",
    "   ",
    "evetevet",
  ])("never confirms or declines unrecognized text %j; falls back to repeat", (text) => {
    expect(parseAppointmentDecision(text)).toBe("repeat");
  });

  it("collapses internal whitespace before comparing", () => {
    expect(parseAppointmentDecision("e v e t")).toBe("repeat");
    expect(parseAppointmentDecision("evet")).toBe("confirm");
  });

  it("is a pure function returning the same result for the same input", () => {
    expect(parseAppointmentDecision("evet")).toBe(parseAppointmentDecision("evet"));
  });
});

const ALL_SIGNALS_FALSE = {
  breathing_difficulty: false,
  loss_of_consciousness: false,
  active_seizure: false,
  heavy_bleeding: false,
  major_trauma: false,
  possible_toxin_exposure: false,
  possible_foreign_object: false,
  unable_to_urinate: false,
} as const;

function intakeData(overrides: Partial<PersistedIntakeData> = {}): PersistedIntakeData {
  return {
    schema_version: 1,
    intent: "appointment_request",
    pet_name: "Tarçın",
    species: "dog",
    complaint: "kontrol",
    symptoms: [],
    reported_safety_signals: { ...ALL_SIGNALS_FALSE },
    missing_information: [],
    user_requested_human: false,
    ...overrides,
  };
}

function planned(
  overrides: {
    nextStage?: IntakeStage;
    petId?: string | null;
    data?: Partial<PersistedIntakeData>;
    petResolution?: PetResolution;
    safetyDecision?: SafetyDecision;
  } = {},
): PlanResult {
  return {
    kind: "planned",
    nextStage: overrides.nextStage ?? "ready_for_triage",
    petId: overrides.petId ?? petId,
    intakeData: intakeData(overrides.data),
    petResolution: overrides.petResolution ?? { kind: "matched", petId },
    safetyDecision: overrides.safetyDecision ?? { kind: "continue_intake" },
  };
}

const FAILED: PlanResult = { kind: "failed" };
const NEEDS_CLARIFICATION: PetResolution = { kind: "needs_clarification" };

function baseContext(overrides: Partial<ConversationIntakeContext> = {}): ConversationIntakeContext {
  return {
    conversationId,
    clinicId: "55555555-5555-5555-5555-555555555555",
    ownerId: "33333333-3333-3333-3333-333333333333",
    petId,
    status: "active",
    intakeStage: "safety_check",
    intakeData: {},
    stateVersion: 1,
    ownerName: "Ada Lovelace",
    pets: [{ id: petId, name: "Tarçın", species: "dog" }],
    recentMessages: [],
    ...overrides,
  };
}

describe("planAppointmentAction", () => {
  it("a failed plan never routes to an appointment RPC", () => {
    expect(planAppointmentAction(baseContext(), FAILED, "evet")).toEqual({ kind: "none" });
  });

  it.each<SafetyDecision>([
    { kind: "emergency_handoff", positiveSignals: ["heavy_bleeding"] },
    { kind: "human_handoff", reason: "user_requested_human" },
  ])("a handoff-grade safety decision always bypasses appointment routing, even mid-selection", (safetyDecision) => {
    const context = baseContext({ intakeStage: "appointment_selection" });
    const plan = planned({ nextStage: "human_handoff", safetyDecision });
    expect(planAppointmentAction(context, plan, "evet")).toEqual({ kind: "none" });
  });

  it("a human_handoff next stage bypasses appointment routing even with a continue safety decision", () => {
    const context = baseContext({ intakeStage: "appointment_selection" });
    const plan = planned({ nextStage: "human_handoff", safetyDecision: { kind: "continue_intake" } });
    expect(planAppointmentAction(context, plan, "evet")).toEqual({ kind: "none" });
  });

  it.each(["appointment_selection", "ready_for_triage"] as const)(
    "unknown safety signals bypass appointment routing at %s",
    (stage) => {
      const context = baseContext({ intakeStage: stage });
      const plan = planned({
        nextStage: stage,
        safetyDecision: { kind: "needs_safety_check", unknownSignals: ["heavy_bleeding"] },
      });
      expect(planAppointmentAction(context, plan, "evet")).toEqual({ kind: "none" });
    },
  );

  it("appointment_selection stage always parses a decision, regardless of intent or pet resolution", () => {
    const context = baseContext({ intakeStage: "appointment_selection" });
    const plan = planned({ nextStage: "appointment_selection", data: { intent: "report_symptom" }, petResolution: NEEDS_CLARIFICATION });
    expect(planAppointmentAction(context, plan, "evet")).toEqual({ kind: "decision", decision: "confirm" });
    expect(planAppointmentAction(context, plan, "hayır")).toEqual({ kind: "decision", decision: "decline" });
    expect(planAppointmentAction(context, plan, "tamam")).toEqual({ kind: "decision", decision: "repeat" });
  });

  it.each<IntakeStage>(["ready_for_triage", "appointment_offer"])(
    "a matched pet with an appointment_request intent reaching %s offers a slot",
    (nextStage) => {
      const context = baseContext({ intakeStage: "safety_check" });
      const plan = planned({ nextStage, data: { intent: "appointment_request" } });
      expect(planAppointmentAction(context, plan, "irrelevant text")).toEqual({ kind: "offer" });
    },
  );

  it("does not offer when the pet still needs clarification", () => {
    const context = baseContext({ intakeStage: "safety_check" });
    const plan = planned({ nextStage: "ready_for_triage", petResolution: NEEDS_CLARIFICATION, data: { intent: "appointment_request" } });
    expect(planAppointmentAction(context, plan, "text")).toEqual({ kind: "none" });
  });

  it("does not offer when the intent is not an appointment request", () => {
    const context = baseContext({ intakeStage: "safety_check" });
    const plan = planned({ nextStage: "ready_for_triage", data: { intent: "report_symptom" } });
    expect(planAppointmentAction(context, plan, "text")).toEqual({ kind: "none" });
  });

  it.each<IntakeStage>(["pet_identification", "complaint_collection", "safety_check", "appointment_confirmation", "completed"])(
    "does not offer when the next stage is %s even with a matched pet and appointment_request intent",
    (nextStage) => {
      const context = baseContext({ intakeStage: "safety_check" });
      const plan = planned({ nextStage, data: { intent: "appointment_request" } });
      expect(planAppointmentAction(context, plan, "text")).toEqual({ kind: "none" });
    },
  );

  it("never calls an RPC client and never throws", () => {
    expect(() => planAppointmentAction(baseContext(), planned(), "evet")).not.toThrow();
  });
});

describe("appointment client result ownership", () => {
  it("returns a fresh object from every successful call", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "offered", intake_stage: "appointment_selection", state_version: 2 }])));
    const offerInput: FinalizeAppointmentOfferInput = {
      conversationId,
      providerMessageId,
      claimToken,
      expectedVersion: 1,
      plannedNextStage: "ready_for_triage",
      petId,
      intakeData: { a: 1 },
    };
    const firstOffer = await finalizeAppointmentOfferQueueJob(offerInput, env);
    const secondOffer = await finalizeAppointmentOfferQueueJob(offerInput, env);
    expect(firstOffer).not.toBe(secondOffer);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "confirmed", intake_stage: "completed", state_version: 2 }])));
    const decisionInput: FinalizeAppointmentDecisionInput = {
      conversationId,
      providerMessageId,
      claimToken,
      expectedVersion: 1,
      decision: "confirm",
      petId,
      intakeData: { a: 1 },
    };
    const firstDecision = await finalizeAppointmentDecisionQueueJob(decisionInput, env);
    const secondDecision = await finalizeAppointmentDecisionQueueJob(decisionInput, env);
    expect(firstDecision).not.toBe(secondDecision);
  });

  it("never throws and always resolves to { kind: \"failed\" } for a locally-invalid input", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const invalidOffer: FinalizeAppointmentOfferInput = {
      conversationId: "invalid",
      providerMessageId,
      claimToken,
      expectedVersion: 1,
      plannedNextStage: "ready_for_triage",
      petId,
      intakeData: { a: 1 },
    };
    await expect(finalizeAppointmentOfferQueueJob(invalidOffer, env)).resolves.toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a fresh object from every failed call", async () => {
    const invalidOffer = {
      conversationId: "invalid",
      providerMessageId,
      claimToken,
      expectedVersion: 1,
      plannedNextStage: "ready_for_triage",
      petId,
      intakeData: { a: 1 },
    } as FinalizeAppointmentOfferInput;
    const invalidDecision = {
      conversationId: "invalid",
      providerMessageId,
      claimToken,
      expectedVersion: 1,
      decision: "confirm",
      petId,
      intakeData: { a: 1 },
    } as FinalizeAppointmentDecisionInput;

    expect(await finalizeAppointmentOfferQueueJob(invalidOffer, env)).not.toBe(
      await finalizeAppointmentOfferQueueJob(invalidOffer, env),
    );
    expect(await finalizeAppointmentDecisionQueueJob(invalidDecision, env)).not.toBe(
      await finalizeAppointmentDecisionQueueJob(invalidDecision, env),
    );
  });
});

describe("finalizeAppointmentOfferQueueJob", () => {
  const baseInput: FinalizeAppointmentOfferInput = {
    conversationId,
    providerMessageId,
    claimToken,
    expectedVersion: 1,
    plannedNextStage: "ready_for_triage",
    petId,
    intakeData: { intent: "appointment_request" },
  };

  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "offered", intake_stage: "appointment_selection", state_version: 2 }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await finalizeAppointmentOfferQueueJob(baseInput, env);

    expect(result).toEqual({ kind: "offered", intakeStage: "appointment_selection", stateVersion: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/finalize_appointment_offer_queue_job");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      p_conversation_id: conversationId,
      p_provider_message_id: providerMessageId,
      p_claim_token: claimToken,
      p_expected_version: 1,
      p_planned_next_stage: "ready_for_triage",
      p_pet_id: petId,
      p_intake_data: { intent: "appointment_request" },
    });
  });

  it.each([
    ["offered", "appointment_selection"],
    ["unavailable", "human_handoff"],
  ] as const)("parses a %s result with its exact intake stage", async (result, intakeStage) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result, intake_stage: intakeStage, state_version: 3 }])));
    expect(await finalizeAppointmentOfferQueueJob(baseInput, env)).toEqual({ kind: result, intakeStage, stateVersion: 3 });
  });

  it.each(["already_completed", "stale_claim", "stale_state", "suppressed"] as const)("parses a %s result with null stage and version", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result, intake_stage: null, state_version: null }])));
    expect(await finalizeAppointmentOfferQueueJob(baseInput, env)).toEqual({ kind: result });
  });

  it.each([
    ["an invalid conversationId", { ...baseInput, conversationId: "not-a-uuid" }],
    ["an empty providerMessageId", { ...baseInput, providerMessageId: "" }],
    ["a providerMessageId over 512 code points", { ...baseInput, providerMessageId: "x".repeat(513) }],
    ["an invalid claimToken", { ...baseInput, claimToken: "not-a-uuid" }],
    ["a zero expectedVersion", { ...baseInput, expectedVersion: 0 }],
    ["a non-integer expectedVersion", { ...baseInput, expectedVersion: 1.5 }],
    ["an invalid plannedNextStage", { ...baseInput, plannedNextStage: "appointment_selection" as never }],
    ["an invalid petId", { ...baseInput, petId: "not-a-uuid" }],
    ["an empty intakeData object", { ...baseInput, intakeData: {} }],
    ["a non-object intakeData array", { ...baseInput, intakeData: [1] as never }],
  ])("rejects %s locally without calling fetch", async (_label, input) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await finalizeAppointmentOfferQueueJob(input, env)).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await finalizeAppointmentOfferQueueJob(baseInput, { ...env, SUPABASE_URL: "" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await finalizeAppointmentOfferQueueJob(baseInput, { ...env, SUPABASE_URL: "http://example.supabase.co" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows plain HTTP for loopback localhost testing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "offered", intake_stage: "appointment_selection", state_version: 2 }])));
    const result = await finalizeAppointmentOfferQueueJob(baseInput, { ...env, SUPABASE_URL: "http://localhost:54321" });
    expect(result).toEqual({ kind: "offered", intakeStage: "appointment_selection", stateVersion: 2 });
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await finalizeAppointmentOfferQueueJob(baseInput, env)).toEqual({ kind: "failed" });
  });

  it("treats a non-2xx response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await finalizeAppointmentOfferQueueJob(baseInput, env)).toEqual({ kind: "failed" });
  });

  it("treats malformed JSON as failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError("bad json");
        },
      } as unknown as Response),
    );
    expect(await finalizeAppointmentOfferQueueJob(baseInput, env)).toEqual({ kind: "failed" });
  });

  it.each([
    ["a non-array body", { result: "offered", intake_stage: "appointment_selection", state_version: 2 }],
    ["zero rows", []],
    [
      "more than one row",
      [
        { result: "offered", intake_stage: "appointment_selection", state_version: 2 },
        { result: "offered", intake_stage: "appointment_selection", state_version: 2 },
      ],
    ],
    ["a row with an extra column", [{ result: "offered", intake_stage: "appointment_selection", state_version: 2, extra: "x" }]],
    ["a row with an unknown result", [{ result: "invented", intake_stage: "appointment_selection", state_version: 2 }]],
    ["a success row with an invalid intake_stage", [{ result: "offered", intake_stage: "not_a_stage", state_version: 2 }]],
    ["a success row with a null intake_stage", [{ result: "offered", intake_stage: null, state_version: 2 }]],
    ["a success row with a zero state_version", [{ result: "offered", intake_stage: "appointment_selection", state_version: 0 }]],
    ["a success row with a non-integer state_version", [{ result: "offered", intake_stage: "appointment_selection", state_version: 1.5 }]],
    ["an offered row with the wrong valid stage", [{ result: "offered", intake_stage: "human_handoff", state_version: 2 }]],
    ["an unavailable row with the wrong valid stage", [{ result: "unavailable", intake_stage: "appointment_selection", state_version: 2 }]],
    ["an already_completed row with a non-null intake_stage", [{ result: "already_completed", intake_stage: "appointment_selection", state_version: null }]],
    ["an already_completed row with a non-null state_version", [{ result: "already_completed", intake_stage: null, state_version: 2 }]],
    ["a suppressed row with a non-null intake_stage", [{ result: "suppressed", intake_stage: "appointment_selection", state_version: null }]],
    ["a suppressed row with a non-null state_version", [{ result: "suppressed", intake_stage: null, state_version: 2 }]],
  ])("treats %s as a malformed response and fails", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await finalizeAppointmentOfferQueueJob(baseInput, env)).toEqual({ kind: "failed" });
  });

  it("rejects a non-plain row and hidden extra columns", async () => {
    const nonPlain = Object.assign(Object.create(null), { result: "offered", intake_stage: "appointment_selection", state_version: 2 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([nonPlain])));
    expect(await finalizeAppointmentOfferQueueJob(baseInput, env)).toEqual({ kind: "failed" });

    const hiddenExtra = { result: "offered", intake_stage: "appointment_selection", state_version: 2 };
    Object.defineProperty(hiddenExtra, "extra", { value: "x" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([hiddenExtra])));
    expect(await finalizeAppointmentOfferQueueJob(baseInput, env)).toEqual({ kind: "failed" });
  });

  it("does not mutate the caller's input", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "offered", intake_stage: "appointment_selection", state_version: 2 }])));
    const input = Object.freeze({ ...baseInput, intakeData: Object.freeze({ intent: "appointment_request" }) });
    await expect(finalizeAppointmentOfferQueueJob(input, env)).resolves.toEqual({
      kind: "offered",
      intakeStage: "appointment_selection",
      stateVersion: 2,
    });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "offered", intake_stage: "appointment_selection", state_version: 2 }])));

    await finalizeAppointmentOfferQueueJob(baseInput, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("finalizeAppointmentDecisionQueueJob", () => {
  const baseInput: FinalizeAppointmentDecisionInput = {
    conversationId,
    providerMessageId,
    claimToken,
    expectedVersion: 1,
    decision: "confirm",
    petId,
    intakeData: { intent: "appointment_request" },
  };

  it("calls the RPC with the documented URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ result: "confirmed", intake_stage: "completed", state_version: 2 }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await finalizeAppointmentDecisionQueueJob(baseInput, env);

    expect(result).toEqual({ kind: "confirmed", intakeStage: "completed", stateVersion: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.supabase.co/rest/v1/rpc/finalize_appointment_decision_queue_job");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("test-service-role-key");
    expect(headers.authorization).toBe("Bearer test-service-role-key");
    expect(JSON.parse(init.body as string)).toEqual({
      p_conversation_id: conversationId,
      p_provider_message_id: providerMessageId,
      p_claim_token: claimToken,
      p_expected_version: 1,
      p_decision: "confirm",
      p_pet_id: petId,
      p_intake_data: { intent: "appointment_request" },
    });
  });

  it.each([
    ["confirmed", "completed"],
    ["declined", "completed"],
    ["repeated", "appointment_selection"],
    ["stale_hold", "human_handoff"],
  ] as const)("parses a %s result with its exact intake stage", async (result, intakeStage) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result, intake_stage: intakeStage, state_version: 3 }])));
    expect(await finalizeAppointmentDecisionQueueJob(baseInput, env)).toEqual({ kind: result, intakeStage, stateVersion: 3 });
  });

  it.each(["already_completed", "stale_claim", "stale_state", "suppressed"] as const)("parses a %s result with null stage and version", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result, intake_stage: null, state_version: null }])));
    expect(await finalizeAppointmentDecisionQueueJob(baseInput, env)).toEqual({ kind: result });
  });

  it.each([
    ["an invalid conversationId", { ...baseInput, conversationId: "not-a-uuid" }],
    ["an empty providerMessageId", { ...baseInput, providerMessageId: "" }],
    ["a providerMessageId over 512 code points", { ...baseInput, providerMessageId: "x".repeat(513) }],
    ["an invalid claimToken", { ...baseInput, claimToken: "not-a-uuid" }],
    ["a zero expectedVersion", { ...baseInput, expectedVersion: 0 }],
    ["a non-integer expectedVersion", { ...baseInput, expectedVersion: 1.5 }],
    ["an invalid decision", { ...baseInput, decision: "yes" as never }],
    ["an invalid petId", { ...baseInput, petId: "not-a-uuid" }],
    ["an empty intakeData object", { ...baseInput, intakeData: {} }],
    ["a non-object intakeData array", { ...baseInput, intakeData: [1] as never }],
  ])("rejects %s locally without calling fetch", async (_label, input) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await finalizeAppointmentDecisionQueueJob(input, env)).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase configuration is missing, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await finalizeAppointmentDecisionQueueJob(baseInput, { ...env, SUPABASE_URL: "" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for plain HTTP against a non-loopback host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await finalizeAppointmentDecisionQueueJob(baseInput, { ...env, SUPABASE_URL: "http://example.supabase.co" });
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows plain HTTP for loopback localhost testing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "confirmed", intake_stage: "completed", state_version: 2 }])));
    const result = await finalizeAppointmentDecisionQueueJob(baseInput, { ...env, SUPABASE_URL: "http://127.0.0.1:54321" });
    expect(result).toEqual({ kind: "confirmed", intakeStage: "completed", stateVersion: 2 });
  });

  it("treats a network failure as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await finalizeAppointmentDecisionQueueJob(baseInput, env)).toEqual({ kind: "failed" });
  });

  it("treats a non-2xx response as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "error" }, 500)));
    expect(await finalizeAppointmentDecisionQueueJob(baseInput, env)).toEqual({ kind: "failed" });
  });

  it("treats malformed JSON as failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError("bad json");
        },
      } as unknown as Response),
    );
    expect(await finalizeAppointmentDecisionQueueJob(baseInput, env)).toEqual({ kind: "failed" });
  });

  it.each([
    ["a non-array body", { result: "confirmed", intake_stage: "completed", state_version: 2 }],
    ["zero rows", []],
    [
      "more than one row",
      [
        { result: "confirmed", intake_stage: "completed", state_version: 2 },
        { result: "confirmed", intake_stage: "completed", state_version: 2 },
      ],
    ],
    ["a row with an extra column", [{ result: "confirmed", intake_stage: "completed", state_version: 2, extra: "x" }]],
    ["a row with an unknown result", [{ result: "invented", intake_stage: "completed", state_version: 2 }]],
    ["a success row with an invalid intake_stage", [{ result: "confirmed", intake_stage: "not_a_stage", state_version: 2 }]],
    ["a success row with a null intake_stage", [{ result: "confirmed", intake_stage: null, state_version: 2 }]],
    ["a success row with a zero state_version", [{ result: "confirmed", intake_stage: "completed", state_version: 0 }]],
    ["a success row with a non-integer state_version", [{ result: "confirmed", intake_stage: "completed", state_version: 1.5 }]],
    ["a confirmed row with the wrong valid stage", [{ result: "confirmed", intake_stage: "appointment_selection", state_version: 2 }]],
    ["a declined row with the wrong valid stage", [{ result: "declined", intake_stage: "human_handoff", state_version: 2 }]],
    ["a repeated row with the wrong valid stage", [{ result: "repeated", intake_stage: "completed", state_version: 2 }]],
    ["a stale_hold row with the wrong valid stage", [{ result: "stale_hold", intake_stage: "completed", state_version: 2 }]],
    ["an already_completed row with a non-null intake_stage", [{ result: "already_completed", intake_stage: "completed", state_version: null }]],
    ["an already_completed row with a non-null state_version", [{ result: "already_completed", intake_stage: null, state_version: 2 }]],
    ["a suppressed row with a non-null intake_stage", [{ result: "suppressed", intake_stage: "completed", state_version: null }]],
    ["a suppressed row with a non-null state_version", [{ result: "suppressed", intake_stage: null, state_version: 2 }]],
  ])("treats %s as a malformed response and fails", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await finalizeAppointmentDecisionQueueJob(baseInput, env)).toEqual({ kind: "failed" });
  });

  it("rejects a non-plain row and hidden extra columns", async () => {
    const nonPlain = Object.assign(Object.create(null), { result: "confirmed", intake_stage: "completed", state_version: 2 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([nonPlain])));
    expect(await finalizeAppointmentDecisionQueueJob(baseInput, env)).toEqual({ kind: "failed" });

    const hiddenExtra = { result: "confirmed", intake_stage: "completed", state_version: 2 };
    Object.defineProperty(hiddenExtra, "extra", { value: "x" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rawJsonResponse([hiddenExtra])));
    expect(await finalizeAppointmentDecisionQueueJob(baseInput, env)).toEqual({ kind: "failed" });
  });

  it("does not mutate the caller's input", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "confirmed", intake_stage: "completed", state_version: 2 }])));
    const input = Object.freeze({ ...baseInput, intakeData: Object.freeze({ intent: "appointment_request" }) });
    await expect(finalizeAppointmentDecisionQueueJob(input, env)).resolves.toEqual({
      kind: "confirmed",
      intakeStage: "completed",
      stateVersion: 2,
    });
  });

  it("does not log the request or response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ result: "confirmed", intake_stage: "completed", state_version: 2 }])));

    await finalizeAppointmentDecisionQueueJob(baseInput, env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
