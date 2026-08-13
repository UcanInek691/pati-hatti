import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractIntakeViaOpenAi, extractIntakeViaOpenAiForEvaluation, EVALUATION_MODELS, OPENAI_INTAKE_MODEL } from "../src/openaiIntake";
import { INTAKE_EXTRACTION_SYSTEM_PROMPT } from "../prompts/intake-extraction-prompt";
import type { Env } from "../src/env";
import type { IntakeQueueMessage } from "../src/intakeQueue";

const ENV: Env = {
  APP_TIMEZONE: "Europe/Istanbul",
  WHATSAPP_VERIFY_TOKEN: "test-verify-token",
  WHATSAPP_APP_SECRET: "test-app-secret",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  SUPABASE_ANON_KEY: "test-anon-key",
  OPENAI_API_KEY: "test-openai-key",
  INTAKE_QUEUE: { send: async () => {} } as unknown as Queue<IntakeQueueMessage>,
  WHATSAPP_ACCESS_TOKEN: "test-whatsapp-access-token",
  WHATSAPP_GRAPH_API_VERSION: "v25.0",
};

const VALID_EXTRACTION = {
  intent: "report_symptom",
  pet_name: "Tarcin",
  species: "cat",
  complaint: "not eating",
  symptoms: ["lethargy"],
  reported_safety_signals: {
    breathing_difficulty: null,
    loss_of_consciousness: null,
    active_seizure: null,
    heavy_bleeding: null,
    major_trauma: null,
    possible_toxin_exposure: null,
    possible_foreign_object: null,
    unable_to_urinate: null,
  },
  missing_information: ["duration"],
  user_requested_human: false,
};

function completedResponse(outputTextJson: string, extraOutputItems: unknown[] = []): unknown {
  return {
    status: "completed",
    output: [
      ...extraOutputItems,
      {
        type: "message",
        content: [{ type: "output_text", text: outputTextJson }],
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("extractIntakeViaOpenAi — request shape", () => {
  it("sends the fixed endpoint, method, headers, and exact fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completedResponse(JSON.stringify(VALID_EXTRACTION))));
    globalThis.fetch = fetchMock;

    const result = await extractIntakeViaOpenAi("my cat won't eat", "conv-hash-abc", ENV);
    expect(result.ok).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer test-openai-key");
    expect(init.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(OPENAI_INTAKE_MODEL);
    expect(OPENAI_INTAKE_MODEL).toBe("gpt-5.6-luna");
    expect(body.reasoning).toEqual({ effort: "none", context: "current_turn" });
    expect(body.max_output_tokens).toBe(1200);
    expect(body.store).toBe(false);
    expect(body.safety_identifier).toBe("conv-hash-abc");
    expect(body.tools).toBeUndefined();
    expect(body.previous_response_id).toBeUndefined();
    expect(body.conversation).toBeUndefined();
    expect(body.metadata).toBeUndefined();
    expect(body.user).toBeUndefined();

    expect(body.input).toHaveLength(2);
    expect(body.input[0]).toEqual({ role: "system", content: INTAKE_EXTRACTION_SYSTEM_PROMPT });
    expect(body.input[1]).toEqual({ role: "user", content: "my cat won't eat" });
  });

  it("bounds the request with a 30-second AbortSignal timeout", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completedResponse(JSON.stringify(VALID_EXTRACTION))));
    globalThis.fetch = fetchMock;

    await extractIntakeViaOpenAi("hello", "conv-hash-abc", ENV);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not trim, rewrite, or concatenate the message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completedResponse(JSON.stringify(VALID_EXTRACTION))));
    globalThis.fetch = fetchMock;

    const raw = "  cat is sick  \n";
    await extractIntakeViaOpenAi(raw, "conv-hash-abc", ENV);

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.input[1].content).toBe(raw);
  });

  it("sends a strict json_schema with exact required keys, enums, nullable fields, and additionalProperties:false at both levels", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completedResponse(JSON.stringify(VALID_EXTRACTION))));
    globalThis.fetch = fetchMock;

    await extractIntakeViaOpenAi("hello", "conv-hash-abc", ENV);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);

    const format = body.text.format;
    expect(format.type).toBe("json_schema");
    expect(format.name).toBe("vetai_intake_extraction");
    expect(format.strict).toBe(true);

    const schema = format.schema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(
      [
        "intent",
        "pet_name",
        "species",
        "complaint",
        "symptoms",
        "reported_safety_signals",
        "missing_information",
        "user_requested_human",
      ].sort(),
    );
    expect(schema.properties.intent.enum.sort()).toEqual(
      [
        "report_symptom",
        "routine_request",
        "appointment_request",
        "human_handoff",
        "medical_advice_request",
        "unknown",
      ].sort(),
    );
    expect(schema.properties.pet_name.type.sort()).toEqual(["null", "string"]);
    expect(schema.properties.species.type.sort()).toEqual(["null", "string"]);
    expect(schema.properties.complaint.type.sort()).toEqual(["null", "string"]);
    expect(schema.properties.user_requested_human.type).toBe("boolean");

    const missingEnum = schema.properties.missing_information.items.enum;
    expect(missingEnum.sort()).toEqual(
      [
        "pet_identity",
        "species",
        "complaint",
        "duration",
        "water_intake",
        "breathing_status",
        "blood_presence",
        "consciousness",
        "toxin_or_foreign_object",
      ].sort(),
    );

    const signals = schema.properties.reported_safety_signals;
    expect(signals.additionalProperties).toBe(false);
    expect(signals.required.sort()).toEqual(
      [
        "breathing_difficulty",
        "loss_of_consciousness",
        "active_seizure",
        "heavy_bleeding",
        "major_trauma",
        "possible_toxin_exposure",
        "possible_foreign_object",
        "unable_to_urinate",
      ].sort(),
    );
    for (const key of signals.required) {
      expect(signals.properties[key].type.sort()).toEqual(["boolean", "null"]);
    }
  });
});

describe("extractIntakeViaOpenAi — accepted responses", () => {
  it("accepts a completed response with non-message reasoning output plus one valid message, normalized by the Task 007 parser", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(completedResponse(JSON.stringify(VALID_EXTRACTION), [{ type: "reasoning", id: "r1" }])),
    );
    globalThis.fetch = fetchMock;

    const result = await extractIntakeViaOpenAi("my cat won't eat", "conv-hash-abc", ENV);
    expect(result).toEqual({ ok: true, extraction: VALID_EXTRACTION });
  });
});

describe("extractIntakeViaOpenAi — rejected without a fetch call", () => {
  it("rejects a missing/whitespace API key", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const result = await extractIntakeViaOpenAi("hello", "conv-hash", { ...ENV, OPENAI_API_KEY: "   " });
    expect(result).toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty message", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const result = await extractIntakeViaOpenAi("", "conv-hash", ENV);
    expect(result).toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a message over 65,536 Unicode code points", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const oversized = "a".repeat(65537);
    const result = await extractIntakeViaOpenAi(oversized, "conv-hash", ENV);
    expect(result).toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty/whitespace-only safety identifier", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const result = await extractIntakeViaOpenAi("hello", "   ", ENV);
    expect(result).toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("extractIntakeViaOpenAi — generic failure on untrusted/malformed responses", () => {
  it("fails closed on a network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await extractIntakeViaOpenAi("hello", "conv-hash", ENV);
    expect(result).toEqual({ ok: false });
  });

  it("fails closed when the request aborts (timeout)", async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const controller = new AbortController();
    const originalTimeout = AbortSignal.timeout;
    AbortSignal.timeout = () => controller.signal;
    try {
      const pending = extractIntakeViaOpenAi("hello", "conv-hash", ENV);
      controller.abort();
      const result = await pending;
      expect(result).toEqual({ ok: false });
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  });

  it("fails closed on a non-2xx response without reading the body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, 500));
    const result = await extractIntakeViaOpenAi("hello", "conv-hash", ENV);
    expect(result).toEqual({ ok: false });
  });

  it("fails closed on invalid response JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    const result = await extractIntakeViaOpenAi("hello", "conv-hash", ENV);
    expect(result).toEqual({ ok: false });
  });

  it("fails closed when status is incomplete", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ status: "incomplete", output: [] }));
    const result = await extractIntakeViaOpenAi("hello", "conv-hash", ENV);
    expect(result).toEqual({ ok: false });
  });

  it("fails closed on an unknown status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ status: "queued", output: [] }));
    const result = await extractIntakeViaOpenAi("hello", "conv-hash", ENV);
    expect(result).toEqual({ ok: false });
  });

  it("fails closed when there are zero message output items", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ status: "completed", output: [{ type: "reasoning" }] }));
    const result = await extractIntakeViaOpenAi("hello", "conv-hash", ENV);
    expect(result).toEqual({ ok: false });
  });

  it("fails closed when there are multiple message output items", async () => {
    const message = { type: "message", content: [{ type: "output_text", text: JSON.stringify(VALID_EXTRACTION) }] };
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ status: "completed", output: [message, message] }));
    const result = await extractIntakeViaOpenAi("hello", "conv-hash", ENV);
    expect(result).toEqual({ ok: false });
  });

  it("fails closed on a refusal content item", async () => {
    const message = { type: "message", content: [{ type: "refusal", refusal: "I can't help with that" }] };
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ status: "completed", output: [message] }));
    const result = await extractIntakeViaOpenAi("hello", "conv-hash", ENV);
    expect(result).toEqual({ ok: false });
  });

  it("fails closed on mixed content items", async () => {
    const message = {
      type: "message",
      content: [
        { type: "output_text", text: JSON.stringify(VALID_EXTRACTION) },
        { type: "refusal", refusal: "partial" },
      ],
    };
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ status: "completed", output: [message] }));
    const result = await extractIntakeViaOpenAi("hello", "conv-hash", ENV);
    expect(result).toEqual({ ok: false });
  });

  it("fails closed on multiple output_text content items", async () => {
    const message = {
      type: "message",
      content: [
        { type: "output_text", text: JSON.stringify(VALID_EXTRACTION) },
        { type: "output_text", text: JSON.stringify(VALID_EXTRACTION) },
      ],
    };
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ status: "completed", output: [message] }));
    const result = await extractIntakeViaOpenAi("hello", "conv-hash", ENV);
    expect(result).toEqual({ ok: false });
  });

  it("fails closed when output_text.text is not a string", async () => {
    const message = { type: "message", content: [{ type: "output_text", text: 123 }] };
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ status: "completed", output: [message] }));
    const result = await extractIntakeViaOpenAi("hello", "conv-hash", ENV);
    expect(result).toEqual({ ok: false });
  });

  it("fails closed when the output_text is not valid JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(completedResponse("{not json")));
    const result = await extractIntakeViaOpenAi("hello", "conv-hash", ENV);
    expect(result).toEqual({ ok: false });
  });

  it("fails closed when the parsed JSON fails the Task 007 runtime parser", async () => {
    const invalid = { ...VALID_EXTRACTION, intent: "not_a_real_intent" };
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(completedResponse(JSON.stringify(invalid))));
    const result = await extractIntakeViaOpenAi("hello", "conv-hash", ENV);
    expect(result).toEqual({ ok: false });
  });
});

describe("extractIntakeViaOpenAiForEvaluation — closed model set", () => {
  it("exposes exactly the reviewed Luna/Terra set", () => {
    expect([...EVALUATION_MODELS].sort()).toEqual(["gpt-5.6-luna", "gpt-5.6-terra"]);
  });

  it("rejects an unsupported model without calling fetch", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const result = await extractIntakeViaOpenAiForEvaluation(
      "hello",
      "conv-hash",
      "gpt-4o" as unknown as "gpt-5.6-luna",
      { OPENAI_API_KEY: "test-openai-key" },
    );
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["gpt-5.6-luna", "gpt-5.6-terra"] as const)("sends %s in the request body and returns it on success", async (model) => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(completedResponse(JSON.stringify(VALID_EXTRACTION))),
    );
    globalThis.fetch = fetchMock;

    const result = await extractIntakeViaOpenAiForEvaluation("hello", "conv-hash", model, {
      OPENAI_API_KEY: "test-openai-key",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(model);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.extraction).toEqual(VALID_EXTRACTION);
      expect(result.model).toBe(model);
      expect(typeof result.elapsedMs).toBe("number");
      expect(result.usage).toBeNull();
    }
  });

  it("parses usage totals when the provider reports them", async () => {
    const payload = completedResponse(JSON.stringify(VALID_EXTRACTION)) as Record<string, unknown>;
    payload.usage = { input_tokens: 120, output_tokens: 40, total_tokens: 160 };
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(payload));

    const result = await extractIntakeViaOpenAiForEvaluation("hello", "conv-hash", "gpt-5.6-terra", {
      OPENAI_API_KEY: "test-openai-key",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 40, totalTokens: 160 });
    }
  });

  it.each([
    { input_tokens: -1, output_tokens: 40, total_tokens: 39 },
    { input_tokens: 120.5, output_tokens: 40, total_tokens: 160.5 },
  ])("ignores invalid provider usage metadata without weakening a valid extraction", async (usage) => {
    const payload = completedResponse(JSON.stringify(VALID_EXTRACTION)) as Record<string, unknown>;
    payload.usage = usage;
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(payload));

    const result = await extractIntakeViaOpenAiForEvaluation("hello", "conv-hash", "gpt-5.6-luna", {
      OPENAI_API_KEY: "test-openai-key",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.usage).toBeNull();
  });

  it("fails closed on a missing API key without calling fetch, still returning model/elapsedMs", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const result = await extractIntakeViaOpenAiForEvaluation("hello", "conv-hash", "gpt-5.6-luna", {
      OPENAI_API_KEY: undefined,
    });
    expect(result).toEqual({ ok: false, model: "gpt-5.6-luna", elapsedMs: expect.any(Number) });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("test fixtures", () => {
  it("contain no real-looking secret", () => {
    expect(ENV.OPENAI_API_KEY).not.toMatch(/^sk-/);
  });
});
