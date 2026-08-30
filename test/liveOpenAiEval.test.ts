import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractIntakeViaOpenAiForEvaluation, EVALUATION_MODELS } from "../src/openaiIntake";
import type { EvaluationModel } from "../src/openaiIntake";
import { INTAKE_EXTRACTION_PROMPT_VERSION } from "../prompts/intake-extraction-prompt";

/**
 * Opt-in live evaluation harness (Task 028). Never runs against the real
 * OpenAI API unless LIVE_OPENAI_EVAL=1 AND a real OPENAI_API_KEY are both
 * present, so `pnpm test` alone performs zero real calls. A live run is
 * evidence only — it never changes the production model, which stays Luna
 * regardless of results.
 */

const HAS_KEY = typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.trim() !== "";
const LIVE_EVAL_ENABLED = process.env.LIVE_OPENAI_EVAL === "1" && HAS_KEY;

const HARD_MAX_CALLS_PER_RUN = 2000;
const SAFETY_IDENTIFIER = "vetai-live-eval-harness-local-run";
const SAFETY_SIGNAL_KEYS = [
  "breathing_difficulty",
  "loss_of_consciousness",
  "active_seizure",
  "heavy_bleeding",
  "major_trauma",
  "possible_toxin_exposure",
  "possible_foreign_object",
  "unable_to_urinate",
] as const;

interface EvalCase {
  id: string;
  category: string;
  message: string;
  expected: Record<string, unknown>;
}

interface EvalCorpus {
  eval_version: string;
  prompt_version: string;
  models: EvaluationModel[];
  case_count: number;
  cases: EvalCase[];
}

function loadCorpus(): EvalCorpus {
  const filePath = path.join(__dirname, "..", "evals", "intake-live-cases.json");
  return JSON.parse(readFileSync(filePath, "utf8")) as EvalCorpus;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function selectEvaluationModels(value: string | undefined = process.env.LIVE_OPENAI_EVAL_MODEL): EvaluationModel[] {
  if (value === undefined || value.trim() === "") return [...EVALUATION_MODELS].sort() as EvaluationModel[];
  if (value === "gpt-5.6-luna" || value === "gpt-5.6-terra") return [value];
  throw new Error("LIVE_OPENAI_EVAL_MODEL must be gpt-5.6-luna or gpt-5.6-terra");
}

const PRICING_CHECKED_ON = "2026-08-29";
const PRICE_USD_PER_1M: Readonly<Record<EvaluationModel, { input: number; output: number }>> = Object.freeze({
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-5.6-terra": { input: 2, output: 12 },
});

function estimateCostUsd(model: EvaluationModel, inputTokens: number, outputTokens: number): number {
  const price = PRICE_USD_PER_1M[model];
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
  return sortedValues[index]!;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface FieldScore {
  matched: number;
  total: number;
}

/** Counts expected leaf fields independently so one wording difference cannot erase an otherwise useful case result. */
function scoreExpectedFields(actual: unknown, expected: unknown): FieldScore {
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
    return { matched: deepEqual(actual, expected) ? 1 : 0, total: 1 };
  }
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
    return { matched: 0, total: Object.keys(expected).length || 1 };
  }

  let matched = 0;
  let total = 0;
  for (const [key, expectedValue] of Object.entries(expected)) {
    const score = scoreExpectedFields((actual as Record<string, unknown>)[key], expectedValue);
    matched += score.matched;
    total += score.total;
  }
  return { matched, total };
}

function ratio(matched: number, total: number): number | null {
  return total === 0 ? null : matched / total;
}

describe.skipIf(!LIVE_EVAL_ENABLED)("live OpenAI intake evaluation (opt-in, real API calls)", () => {
  it(
    "runs the synthetic corpus against Luna and Terra with bounded concurrency and reports only aggregate metrics",
    async () => {
      const corpus = loadCorpus();
      const models = selectEvaluationModels();
      const repeatCount = parsePositiveInt(process.env.LIVE_OPENAI_EVAL_REPEAT, 1);

      const totalPlannedCalls = corpus.cases.length * models.length * repeatCount;
      expect(totalPlannedCalls).toBeLessThanOrEqual(HARD_MAX_CALLS_PER_RUN);

      const credentials = { OPENAI_API_KEY: process.env.OPENAI_API_KEY };
      const report: Record<string, unknown> = {};

      for (const model of models) {
        let schemaSuccessCount = 0;
        let schemaFailureCount = 0;
        let expectedFieldMatchedCount = 0;
        let expectedFieldTotalCount = 0;
        let expectedCaseExactMatchCount = 0;
        let missingUsageCount = 0;
        const failingCaseIds: string[] = [];
        const latenciesMs: number[] = [];
        const signalCounts = Object.fromEntries(
          SAFETY_SIGNAL_KEYS.map((key) => [key, { true: 0, false: 0, null: 0 }]),
        ) as Record<(typeof SAFETY_SIGNAL_KEYS)[number], { true: number; false: number; null: number }>;
        const safetyExpectation = {
          true: { matched: 0, total: 0 },
          false: { matched: 0, total: 0 },
          null: { matched: 0, total: 0 },
          unspecifiedNotFalse: { matched: 0, total: 0 },
        };
        let tokenInputTotal = 0;
        let tokenOutputTotal = 0;
        let tokenTotal = 0;
        const humanIntent = { matched: 0, total: 0 };
        const medicalIntent = { matched: 0, total: 0 };
        const appointmentIntent = { matched: 0, total: 0 };

        // Bounded concurrency of one: every call is awaited before the next starts.
        for (const evalCase of corpus.cases) {
          for (let repeat = 0; repeat < repeatCount; repeat += 1) {
            const result = await extractIntakeViaOpenAiForEvaluation(evalCase.message, SAFETY_IDENTIFIER, model, credentials);
            latenciesMs.push(result.elapsedMs);

            if (!result.ok) {
              schemaFailureCount += 1;
              failingCaseIds.push(evalCase.id);
              continue;
            }

            schemaSuccessCount += 1;
            const fieldScore = scoreExpectedFields(result.extraction, evalCase.expected);
            expectedFieldMatchedCount += fieldScore.matched;
            expectedFieldTotalCount += fieldScore.total;
            if (fieldScore.matched === fieldScore.total) {
              expectedCaseExactMatchCount += 1;
            } else {
              failingCaseIds.push(evalCase.id);
            }

            if (result.usage === null) {
              missingUsageCount += 1;
            } else {
              tokenInputTotal += result.usage.inputTokens;
              tokenOutputTotal += result.usage.outputTokens;
              tokenTotal += result.usage.totalTokens;
            }

            for (const key of SAFETY_SIGNAL_KEYS) {
              const value = result.extraction.reported_safety_signals[key];
              signalCounts[key][value === null ? "null" : value ? "true" : "false"] += 1;

              const expectedSignals = evalCase.expected.reported_safety_signals as Record<string, unknown>;
              const expectedValue = expectedSignals[key];
              const bucket = expectedValue === true ? "true" : expectedValue === false ? "false" : "null";
              safetyExpectation[bucket].total += 1;
              if (value === expectedValue) safetyExpectation[bucket].matched += 1;
              if (expectedValue === null) {
                safetyExpectation.unspecifiedNotFalse.total += 1;
                if (value !== false) safetyExpectation.unspecifiedNotFalse.matched += 1;
              }
            }

            if (evalCase.category === "human_request") {
              humanIntent.total += 1;
              if (result.extraction.user_requested_human === true) humanIntent.matched += 1;
            }
            if (evalCase.category === "medical_advice_request") {
              medicalIntent.total += 1;
              if (result.extraction.intent === "medical_advice_request") medicalIntent.matched += 1;
            }
            if (evalCase.category === "appointment_request") {
              appointmentIntent.total += 1;
              if (result.extraction.intent === "appointment_request") appointmentIntent.matched += 1;
            }
          }
        }

        const sortedLatencies = [...latenciesMs].sort((a, b) => a - b);

        report[model] = {
          totalCalls: latenciesMs.length,
          schemaSuccessCount,
          schemaFailureCount,
          expectedFieldMatchedCount,
          expectedFieldTotalCount,
          expectedFieldMatchRate: ratio(expectedFieldMatchedCount, expectedFieldTotalCount),
          expectedCaseExactMatchCount,
          failingCaseIds: [...new Set(failingCaseIds)],
          perSignalCounts: signalCounts,
          safetyExpectation: {
            ...safetyExpectation,
            explicitTrueRecall: ratio(safetyExpectation.true.matched, safetyExpectation.true.total),
            explicitFalseAccuracy: ratio(safetyExpectation.false.matched, safetyExpectation.false.total),
            unspecifiedNotFalseRate: ratio(
              safetyExpectation.unspecifiedNotFalse.matched,
              safetyExpectation.unspecifiedNotFalse.total,
            ),
          },
          humanIntentMatch: humanIntent,
          medicalIntentMatch: medicalIntent,
          appointmentIntentMatch: appointmentIntent,
          latencyMsP50: percentile(sortedLatencies, 0.5),
          latencyMsP90: percentile(sortedLatencies, 0.9),
          latencyMsP99: percentile(sortedLatencies, 0.99),
          providerFailureCount: schemaFailureCount,
          missingUsageCount,
          tokenTotals: { input: tokenInputTotal, output: tokenOutputTotal, total: tokenTotal },
          pricingCheckedOn: PRICING_CHECKED_ON,
          priceUsdPer1M: PRICE_USD_PER_1M[model],
          estimatedCostUsd: estimateCostUsd(model, tokenInputTotal, tokenOutputTotal),
        };
      }

      // Aggregate metrics only — never the case message text, provider body, or model output.
      console.log(JSON.stringify(report, null, 2));
    },
    10 * 60 * 1000,
  );
});

describe("live eval opt-in gate", () => {
  it("can restrict an approved live run to Luna and rejects unknown models before any call", () => {
    expect(selectEvaluationModels("gpt-5.6-luna")).toEqual(["gpt-5.6-luna"]);
    expect(() => selectEvaluationModels("gpt-unknown")).toThrow(/LIVE_OPENAI_EVAL_MODEL/);
  });

  it("is skipped unless LIVE_OPENAI_EVAL=1 and a real OPENAI_API_KEY are both present", () => {
    expect(LIVE_EVAL_ENABLED).toBe(process.env.LIVE_OPENAI_EVAL === "1" && HAS_KEY);
    if (process.env.LIVE_OPENAI_EVAL !== "1" || !HAS_KEY) {
      expect(LIVE_EVAL_ENABLED).toBe(false);
    }
  });

  it("loads a corpus of at least 60 synthetic cases without making any network call", () => {
    const corpus = loadCorpus();
    expect(corpus.cases.length).toBeGreaterThanOrEqual(60);
    expect(corpus.case_count).toBe(corpus.cases.length);
    expect(corpus.prompt_version).toBe(INTAKE_EXTRACTION_PROMPT_VERSION);
    expect(corpus.models).toEqual(EVALUATION_MODELS);
    expect(new Set(corpus.cases.map(({ id }) => id)).size).toBe(corpus.cases.length);
    expect(corpus.cases.every(({ id }) => /^T028-\d{3}$/.test(id))).toBe(true);
    for (const evalCase of corpus.cases) {
      const signals = evalCase.expected.reported_safety_signals as Record<string, unknown>;
      expect(Object.keys(signals).sort()).toEqual([...SAFETY_SIGNAL_KEYS].sort());
    }
  });

  it("scores expected leaf fields independently and preserves explicit negative safety facts", () => {
    expect(scoreExpectedFields({ a: 1, nested: { b: 2, c: 4 } }, { a: 1, nested: { b: 2, c: 3 } })).toEqual({
      matched: 2,
      total: 3,
    });

    const corpus = loadCorpus();
    const negativeBleedingCase = corpus.cases.find(({ id }) => id === "T028-064");
    expect(negativeBleedingCase?.expected.reported_safety_signals).toMatchObject({ heavy_bleeding: false });
  });

  it("uses the reviewed official token prices for a non-null cost estimate", () => {
    expect(estimateCostUsd("gpt-5.6-luna", 1_000_000, 1_000_000)).toBe(1.4);
    expect(estimateCostUsd("gpt-5.6-terra", 1_000_000, 1_000_000)).toBe(14);
  });
});
