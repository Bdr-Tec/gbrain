/**
 * #4121 — expand() (query expansion) calls generateObject/generateText
 * directly and never went through chat()'s `_recordBudget` closure, so
 * expansion LLM spend was invisible to BudgetTracker even inside a
 * `withBudgetTracker()` scope.
 *
 * Pins the fix's public contract:
 *   - Every SUCCESSFUL expand() call site (native generateObject path,
 *     openai-compatible structured-output generateObject path, and the
 *     schemaless generateText fallback path) records usage on the ambient
 *     BudgetTracker with a distinct `sub_label: 'gateway.expand'` — never
 *     conflated with chat()'s `gateway.chat` audit rows.
 *   - expand() outside any withBudgetTracker scope stays a budget no-op
 *     (back-compat, mirrors gateway-budget-composition.test.ts).
 *   - record() throwing BudgetExhausted (TX1, over-cap) is swallowed —
 *     expand() still returns its best-effort result, matching chat()'s
 *     fail-open posture.
 *
 * Hermetic: routes through __setGenerateObjectTransportForTests /
 * __setGenerateTextTransportForTests so no network / provider / env
 * variable is touched.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expand,
  configureGateway,
  resetGateway,
  withBudgetTracker,
  getCurrentBudgetTracker,
  __setGenerateObjectTransportForTests,
  __setGenerateTextTransportForTests,
} from '../../../src/core/ai/gateway.ts';
import {
  BudgetTracker,
  _resetBudgetTrackerWarningsForTest,
} from '../../../src/core/budget/budget-tracker.ts';
import { getRecipe, __setTestRecipesForTests } from '../../../src/core/ai/recipes/index.ts';
import type { Recipe } from '../../../src/core/ai/types.ts';

let tmp: string;
let auditPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-expand-budget-'));
  auditPath = join(tmp, 'budget.jsonl');
  _resetBudgetTrackerWarningsForTest();
});

afterEach(() => {
  __setGenerateObjectTransportForTests(null);
  __setGenerateTextTransportForTests(null);
  resetGateway();
  rmSync(tmp, { recursive: true, force: true });
});

/** Read + parse every JSONL line in the tracker's audit file. */
function readAudit(): any[] {
  return readFileSync(auditPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

describe('expand() budget accounting — native generateObject path', () => {
  beforeEach(() => {
    configureGateway({
      expansion_model: 'anthropic:claude-haiku-4-5-20251001',
      env: { ANTHROPIC_API_KEY: 'sk-test-fake' },
    });
  });

  test('a successful expansion records usage under the ambient tracker', async () => {
    __setGenerateObjectTransportForTests(async () => ({
      object: { queries: ['alt one', 'alt two'] },
      usage: { inputTokens: 120, outputTokens: 40 },
    }) as any);

    const tracker = new BudgetTracker({ maxCostUsd: 1.0, label: 'test-expand', auditPath });

    let result: string[] = [];
    await withBudgetTracker(tracker, async () => {
      result = await expand('original query');
    });

    expect(result).toContain('original query');
    expect(result).toContain('alt one');
    expect(tracker.snapshot().callsRecorded).toBe(1);
    // Haiku pricing is non-zero, so a priced call must move totalSpent.
    expect(tracker.totalSpent).toBeGreaterThan(0);

    const rows = readAudit();
    const recordRow = rows.find(r => r.event === 'record');
    expect(recordRow).toBeTruthy();
    // The core of #4121: expansion spend must carry its own sub_label, never
    // the chat() one — that conflation is exactly what made it invisible.
    expect(recordRow.sub_label).toBe('gateway.expand');
    expect(recordRow.sub_label).not.toBe('gateway.chat');
    expect(recordRow.model).toBe('anthropic:claude-haiku-4-5-20251001');
    expect(recordRow.input_tokens).toBe(120);
    expect(recordRow.output_tokens).toBe(40);
  });

  test('outside any withBudgetTracker scope, expand() is a budget no-op (back-compat)', async () => {
    __setGenerateObjectTransportForTests(async () => ({
      object: { queries: ['alt one'] },
      usage: { inputTokens: 120, outputTokens: 40 },
    }) as any);

    expect(getCurrentBudgetTracker()).toBeNull();
    const result = await expand('original query');
    expect(result).toContain('original query');
    expect(result).toContain('alt one');
    // No tracker was ever installed — nothing to assert beyond "no throw".
    expect(getCurrentBudgetTracker()).toBeNull();
  });

  test('BudgetExhausted from record() (TX1) is swallowed — expand() still returns its result', async () => {
    // Tiny cap: reserve() has no pre-flight for expand() (only chat() calls
    // reserve()), so the first record() itself pushes cumulative > cap and
    // throws internally. recordExpansionUsage must swallow it.
    __setGenerateObjectTransportForTests(async () => ({
      object: { queries: ['alt one'] },
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    }) as any);

    const tracker = new BudgetTracker({ maxCostUsd: 0.0001, label: 'tight-expand', auditPath });

    let result: string[] = [];
    let threw: unknown = null;
    await withBudgetTracker(tracker, async () => {
      try {
        result = await expand('original query');
      } catch (err) {
        threw = err;
      }
    });

    expect(threw).toBeNull();
    expect(result).toContain('original query');
    expect(tracker.totalSpent).toBeGreaterThan(0.0001);
  });
});

describe('expand() budget accounting — openai-compatible schemaless (viaText) path', () => {
  beforeEach(() => {
    // litellm: requires no auth env and declares no chat.supports_structured_outputs,
    // so recipeSupportsStructuredOutputs() is false and expand() routes straight
    // to viaText() — the generateText fallback path, not generateObject.
    configureGateway({
      expansion_model: 'litellm:my-proxied-model',
      env: {},
    });
  });

  test('a successful viaText() expansion records usage with the same sub_label', async () => {
    __setGenerateTextTransportForTests(async () => ({
      text: '{"queries": ["alt one", "alt two"]}',
      usage: { inputTokens: 80, outputTokens: 30 },
    }) as any);

    const tracker = new BudgetTracker({ label: 'test-expand-viatext', auditPath });

    let result: string[] = [];
    await withBudgetTracker(tracker, async () => {
      result = await expand('original query');
    });

    expect(result).toContain('original query');
    expect(result).toContain('alt one');
    expect(tracker.snapshot().callsRecorded).toBe(1);

    const rows = readAudit();
    // litellm has no pricing entry, so this lands as record_unpriced — still
    // proves the call site fired (this is the exact code path #4121 reported
    // as never reaching the tracker at all).
    const recordRow = rows.find(r => r.event === 'record' || r.event === 'record_unpriced');
    expect(recordRow).toBeTruthy();
    expect(recordRow.sub_label).toBe('gateway.expand');
    expect(recordRow.model).toBe('litellm:my-proxied-model');
    expect(recordRow.input_tokens).toBe(80);
    expect(recordRow.output_tokens).toBe(30);
  });
});

describe('expand() budget accounting — openai-compatible structured-output (generateObject) path', () => {
  // No built-in recipe currently opts into supports_structured_outputs (it's
  // an opt-in per-backend capability declared in ChatTouchpoint — see
  // recipeSupportsStructuredOutputs()'s own unit test in gateway-chat.test.ts
  // for the same "no shipped recipe exercises this today" situation). Rather
  // than mutating a shipped recipe singleton, use the established synthetic-
  // recipe seam (__setTestRecipesForTests, already used by
  // no-batch-cap-suppression.serial.test.ts / adaptive-embed-batch.test.ts):
  // clone litellm under a test-only id with supports_structured_outputs
  // flipped on, so expand() takes the SECOND generateObject call site (the
  // one guarded by recipeSupportsStructuredOutputs(recipe)) through the real
  // resolution path instead of the native-provider branch already covered
  // above — without touching the real `litellm` recipe object at all.
  const baseLitellm = getRecipe('litellm')!;
  const structuredLitellm: Recipe = {
    ...baseLitellm,
    id: 'synthetic-structured-litellm',
    touchpoints: {
      ...baseLitellm.touchpoints,
      chat: { ...baseLitellm.touchpoints.chat!, supports_structured_outputs: true },
    },
  };

  beforeEach(() => {
    __setTestRecipesForTests([structuredLitellm]);
    configureGateway({
      expansion_model: 'synthetic-structured-litellm:my-proxied-model',
      env: {},
    });
  });

  afterEach(() => {
    __setTestRecipesForTests([]);
  });

  test('a successful structured-output expansion records usage — NOT via viaText()', async () => {
    __setGenerateObjectTransportForTests(async () => ({
      object: { queries: ['alt one', 'alt two'] },
      usage: { inputTokens: 55, outputTokens: 22 },
    }) as any);
    // If the code regresses to falling through to viaText() (e.g. the
    // try/catch around the structured call swallows a non-error condition),
    // this transport must NOT be reached — assert it never fires.
    let viaTextCalled = false;
    __setGenerateTextTransportForTests(async () => {
      viaTextCalled = true;
      return { text: '{"queries": ["fallback"]}', usage: { inputTokens: 1, outputTokens: 1 } } as any;
    });

    const tracker = new BudgetTracker({ label: 'test-expand-structured', auditPath });

    let result: string[] = [];
    await withBudgetTracker(tracker, async () => {
      result = await expand('original query');
    });

    expect(viaTextCalled).toBe(false);
    expect(result).toContain('original query');
    expect(result).toContain('alt one');
    expect(tracker.snapshot().callsRecorded).toBe(1);

    const rows = readAudit();
    const recordRow = rows.find(r => r.event === 'record' || r.event === 'record_unpriced');
    expect(recordRow).toBeTruthy();
    expect(recordRow.sub_label).toBe('gateway.expand');
    expect(recordRow.model).toBe('synthetic-structured-litellm:my-proxied-model');
    expect(recordRow.input_tokens).toBe(55);
    expect(recordRow.output_tokens).toBe(22);
  });
});
