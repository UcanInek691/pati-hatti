import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractIntakeViaOpenAiForEvaluation, EVALUATION_MODELS } from "../src/openaiIntake";
import type { EvaluationModel } from "../src/openaiIntake";
import type { ReportedSafetySignals } from "../src/intakeExtraction";
import { INTAKE_EXTRACTION_PROMPT_VERSION } from "../prompts/intake-extraction-prompt";

/**
 * Opt-in live multi-turn evaluation harness (Task 029). Never runs against
 * the real OpenAI API unless LIVE_OPENAI_MULTITURN_EVAL=1 AND a real
 * OPENAI_API_KEY are both present, so `pnpm test` alone performs zero real
 * calls. The existing LIVE_OPENAI_EVAL=1 flag (Task 028) never activates
 * this separate harness. A live run is evidence only — it never changes the
 * production model, which stays Luna regardless of results.
 */

const HAS_KEY = typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.trim() !== "";
const LIVE_MULTITURN_EVAL_ENABLED = process.env.LIVE_OPENAI_MULTITURN_EVAL === "1" && HAS_KEY;

const HARD_MAX_CALLS_PER_RUN = 100;
const SAFETY_IDENTIFIER = "vetai-live-multiturn-eval-harness-local-run";
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
  previous_question: string;
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
  const filePath = path.join(__dirname, "..", "evals", "intake-multiturn-live-cases.json");
  return JSON.parse(readFileSync(filePath, "utf8")) as EvalCorpus;
}

const PRICING_CHECKED_ON = "2026-08-13";
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

function scoreUnexpectedExplicitTrue(
  actual: ReportedSafetySignals,
  expected: Record<string, unknown>,
): { count: number; opportunities: number } {
  let count = 0;
  let opportunities = 0;
  for (const key of SAFETY_SIGNAL_KEYS) {
    if (expected[key] === true) continue;
    opportunities += 1;
    if (actual[key] === true) count += 1;
  }
  return { count, opportunities };
}

describe.skipIf(!LIVE_MULTITURN_EVAL_ENABLED)("live OpenAI multi-turn intake evaluation (opt-in, real API calls)", () => {
  it(
    "runs the synthetic multi-turn corpus against Luna and Terra with bounded concurrency and reports only aggregate metrics",
    async () => {
      const corpus = loadCorpus();
      const models = [...EVALUATION_MODELS].sort() as EvaluationModel[];

      const totalPlannedCalls = corpus.cases.length * models.length;
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
        const safetyExpectation = {
          true: { matched: 0, total: 0 },
          false: { matched: 0, total: 0 },
          null: { matched: 0, total: 0 },
          unspecifiedNotFalse: { matched: 0, total: 0 },
        };
        let tokenInputTotal = 0;
        let tokenOutputTotal = 0;
        let tokenTotal = 0;
        let unexpectedExplicitTrueCount = 0;
        let unexpectedExplicitTrueOpportunities = 0;

        // Bounded concurrency of one: every call is awaited before the next starts.
        for (const evalCase of corpus.cases) {
          const result = await extractIntakeViaOpenAiForEvaluation(
            evalCase.message,
            SAFETY_IDENTIFIER,
            model,
            credentials,
            evalCase.previous_question,
          );
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
          const expectedSignals = (evalCase.expected.reported_safety_signals ?? {}) as Record<string, unknown>;
          const unexpectedTrue = scoreUnexpectedExplicitTrue(
            result.extraction.reported_safety_signals,
            expectedSignals,
          );
          unexpectedExplicitTrueCount += unexpectedTrue.count;
          unexpectedExplicitTrueOpportunities += unexpectedTrue.opportunities;

          if (fieldScore.matched === fieldScore.total && unexpectedTrue.count === 0) {
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
            if (!Object.prototype.hasOwnProperty.call(expectedSignals, key)) {
              safetyExpectation.unspecifiedNotFalse.total += 1;
              if (value !== false) safetyExpectation.unspecifiedNotFalse.matched += 1;
              continue;
            }
            const expectedValue = expectedSignals[key];
            const bucket = expectedValue === true ? "true" : expectedValue === false ? "false" : "null";
            safetyExpectation[bucket].total += 1;
            if (value === expectedValue) safetyExpectation[bucket].matched += 1;
            if (expectedValue === null) {
              safetyExpectation.unspecifiedNotFalse.total += 1;
              if (value !== false) safetyExpectation.unspecifiedNotFalse.matched += 1;
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
          safetyExpectation: {
            ...safetyExpectation,
            explicitTrueRecall: ratio(safetyExpectation.true.matched, safetyExpectation.true.total),
            explicitFalseAccuracy: ratio(safetyExpectation.false.matched, safetyExpectation.false.total),
            unspecifiedNotFalseRate: ratio(
              safetyExpectation.unspecifiedNotFalse.matched,
              safetyExpectation.unspecifiedNotFalse.total,
            ),
          },
          latencyMsP50: percentile(sortedLatencies, 0.5),
          latencyMsP90: percentile(sortedLatencies, 0.9),
          latencyMsP99: percentile(sortedLatencies, 0.99),
          providerFailureCount: schemaFailureCount,
          unexpectedExplicitTrueCount,
          unexpectedExplicitTrueRate: ratio(
            unexpectedExplicitTrueCount,
            unexpectedExplicitTrueOpportunities,
          ),
          missingUsageCount,
          tokenTotals: { input: tokenInputTotal, output: tokenOutputTotal, total: tokenTotal },
          pricingCheckedOn: PRICING_CHECKED_ON,
          priceUsdPer1M: PRICE_USD_PER_1M[model],
          estimatedCostUsd: estimateCostUsd(model, tokenInputTotal, tokenOutputTotal),
        };
      }

      // Aggregate metrics only — never the case text, context, provider body, model output, or key.
      console.log(JSON.stringify(report, null, 2));
    },
    10 * 60 * 1000,
  );
});

describe("live multi-turn eval opt-in gate", () => {
  it("is skipped unless LIVE_OPENAI_MULTITURN_EVAL=1 and a real OPENAI_API_KEY are both present", () => {
    expect(LIVE_MULTITURN_EVAL_ENABLED).toBe(process.env.LIVE_OPENAI_MULTITURN_EVAL === "1" && HAS_KEY);
    if (process.env.LIVE_OPENAI_MULTITURN_EVAL !== "1" || !HAS_KEY) {
      expect(LIVE_MULTITURN_EVAL_ENABLED).toBe(false);
    }
  });

  it("is not activated by the separate Task 028 LIVE_OPENAI_EVAL flag alone", () => {
    if (process.env.LIVE_OPENAI_EVAL === "1" && process.env.LIVE_OPENAI_MULTITURN_EVAL !== "1") {
      expect(LIVE_MULTITURN_EVAL_ENABLED).toBe(false);
    }
  });

  it("loads a corpus of at least 24 synthetic multi-turn cases without making any network call", () => {
    const corpus = loadCorpus();
    expect(corpus.cases.length).toBeGreaterThanOrEqual(24);
    expect(corpus.case_count).toBe(corpus.cases.length);
    expect(corpus.prompt_version).toBe(INTAKE_EXTRACTION_PROMPT_VERSION);
    expect(corpus.models).toEqual(EVALUATION_MODELS);
    expect(new Set(corpus.cases.map(({ id }) => id)).size).toBe(corpus.cases.length);
    expect(corpus.cases.every(({ id }) => /^T029-\d{3}$/.test(id))).toBe(true);
    expect(corpus.cases.every(({ previous_question }) => typeof previous_question === "string")).toBe(true);
    expect(
      corpus.cases.every(
        (evalCase) =>
          Reflect.ownKeys(evalCase).length === 5 &&
          ["id", "category", "previous_question", "message", "expected"].every((key) => key in evalCase),
      ),
    ).toBe(true);
  });

  it("covers every required Task 029 category at least once", () => {
    const corpus = loadCorpus();
    const categories = new Set(corpus.cases.map((c) => c.category));
    for (const signal of SAFETY_SIGNAL_KEYS) {
      expect(categories.has(`${signal}_yes`)).toBe(true);
      expect(categories.has(`${signal}_no`)).toBe(true);
    }
    for (const required of [
      "ordinal_multi_answer",
      "none_of_the_above",
      "all_no",
      "uncertain",
      "ambiguous_non_question_context",
      "prompt_injection_context",
      "prompt_injection_answer",
      "human_request_followup",
      "medical_advice_followup",
      "pet_name_followup",
      "complaint_followup",
      "casing_unicode_whitespace_variant",
      "production_safety_block_ambiguous_yes",
      "production_safety_block_all_no",
    ]) {
      expect(categories.has(required)).toBe(true);
    }
  });

  it("uses the reviewed official token prices for a non-null cost estimate", () => {
    expect(estimateCostUsd("gpt-5.6-luna", 1_000_000, 1_000_000)).toBe(1.4);
    expect(estimateCostUsd("gpt-5.6-terra", 1_000_000, 1_000_000)).toBe(14);
  });

  it("counts an unexpected explicit true safety signal as a false-positive opportunity", () => {
    const actual: ReportedSafetySignals = {
      breathing_difficulty: false,
      loss_of_consciousness: null,
      active_seizure: true,
      heavy_bleeding: null,
      major_trauma: null,
      possible_toxin_exposure: null,
      possible_foreign_object: null,
      unable_to_urinate: null,
    };

    expect(scoreUnexpectedExplicitTrue(actual, { breathing_difficulty: false })).toEqual({
      count: 1,
      opportunities: 8,
    });
  });
});
