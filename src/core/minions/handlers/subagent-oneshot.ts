/**
 * #4216 — oneshot synthesis runner.
 *
 * Replaces the 10-25-round-trip agentic loop with ONE completion + programmatic
 * validated writes for dream-cycle synthesis jobs (`data.mode === 'oneshot'`):
 *
 *   1. Single tool-less chat call. The prompt already carries the
 *      pre-retrieval LINK CANDIDATES manifest + ALLOWED WRITE PATHS block
 *      (built at fan-out); the static ONESHOT_SYSTEM contract rides
 *      `cacheSystem` so consecutive jobs share the prompt-cache prefix.
 *   2. Strict validation BEFORE any write (all-or-nothing): JSON contract,
 *      slug grammar + allow-list + task shape + hash suffix (CDX-9 — the
 *      suffix is the idempotency boundary, never trusted to prompt
 *      discipline), exact-match wikilink rule (OV-1).
 *   3. Writes through the SAME brain_put_page tool executor the agentic loop
 *      uses (slug fences, trusted-workspace side effects, provenance all
 *      identical) with `deferEmbeds` — the embed network call leaves the
 *      model path entirely. Each write is bracketed by the standard
 *      tool-execution ledger rows under invocation-scoped ids
 *      (`oneshot-<inv8>-p<i>`), so slug collection, provenance stamping,
 *      reverse-writes and #4217 accounting all work unchanged.
 *   4. Any validation failure → `{kind:'fallback'}` and the SAME job falls
 *      through to the agentic loop (same prompt, same idempotency key).
 *
 * Crash safety (OV-4 ledger-first recovery): the runner only calls the model
 * when the job has NO oneshot ledger rows. A retried job that already wrote
 * (any invocation) finalizes from the ledger instead of re-calling a
 * nondeterministic model — no double-writes, no near-duplicate pages.
 * Transcript messages are persisted ONLY after success, so the
 * `alreadyTerminal` replay check can never replay a failed attempt's JSON as
 * a completed result.
 */

import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../engine.ts';
import type { MinionJobContext, SubagentHandlerData, SubagentResult, ToolDef, ContentBlock } from '../types.ts';
import { chat as gatewayChat, type ChatResult } from '../../ai/gateway.ts';
import { parseLlmJson } from '../../llm-json.ts';
import { PAGE_SLUG_SEG } from '../../cjk.ts';
import { matchesSlugAllowList } from '../../ops/context.ts';
import { autoLinkWrittenPage } from '../../ops/pages.ts';
import { acquireLease, releaseLease } from '../rate-leases.ts';
import { logSubagentHeartbeat } from './subagent-audit.ts';
import {
  persistMessage,
  persistToolExecPending,
  persistToolExecComplete,
  persistToolExecFailed,
} from './subagent-persistence.ts';

export type OneshotFallbackReason =
  | 'unparseable' | 'length' | 'refusal' | 'bad_slug' | 'no_wikilink' | 'empty_no_skip' | 'oneshot_timeout';

export type OneshotOutcome =
  | { kind: 'done'; result: SubagentResult }
  | { kind: 'fallback'; reason: OneshotFallbackReason };

const SLUG_RE = new RegExp(`^${PAGE_SLUG_SEG}(\\/${PAGE_SLUG_SEG})*$`, 'u');
const MAX_PAGES_PER_RESPONSE = 12;
const ONESHOT_CALL_BUDGET_MS = 300_000;

/**
 * Static system contract — deliberately free of per-job content so the
 * Anthropic prompt-cache breakpoint on the system block hits across every
 * oneshot job in a cycle.
 */
export const ONESHOT_SYSTEM = `You are a knowledge-synthesis engine. You have NO tools. Read the user message (task instructions + transcript) and respond with ONLY a JSON object — no prose before or after, no code fence — in exactly this shape:

{"pages": [{"slug": "<full slug obeying ALLOWED WRITE PATHS and the Task A/B templates, ending with the hash suffix from CONTEXT>",
            "title": "<short human title>",
            "type": "note",
            "body": "<markdown page body. MUST contain at least one wikilink like [[people/jane-doe]] whose target is taken from LINK CANDIDATES or is another page in this response. Follow every OUTPUT POLICY rule from the user message.>"}],
 "skipped": false,
 "skip_reason": null}

If nothing in the transcript meets the bar (Task D), respond with:
{"pages": [], "skipped": true, "skip_reason": "<one line>"}

Hard rules: at most ${MAX_PAGES_PER_RESPONSE} pages; slugs are lowercase, hyphen-separated, slash-delimited, no underscores, no file extensions; never invent wikilink targets that are not in LINK CANDIDATES or this response.`;

export interface OneshotPage {
  slug: string;
  title: string;
  type: string;
  body: string;
}

export interface ParsedOneshot {
  pages: OneshotPage[];
  skipped: boolean;
  skip_reason: string | null;
}

/** Tolerant parse + shape validation (no slug/link policy here — that needs job context). */
export function parseOneshotResponse(raw: string): ParsedOneshot | null {
  const parsed = parseLlmJson<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const pagesRaw = (parsed as { pages?: unknown }).pages;
  if (!Array.isArray(pagesRaw)) return null;
  const pages: OneshotPage[] = [];
  for (const p of pagesRaw) {
    if (!p || typeof p !== 'object') return null;
    const rec = p as Record<string, unknown>;
    if (typeof rec.slug !== 'string' || rec.slug.trim() === '') return null;
    if (typeof rec.body !== 'string' || rec.body.trim() === '') return null;
    pages.push({
      slug: rec.slug.trim(),
      title: typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : rec.slug.trim().split('/').pop()!,
      type: typeof rec.type === 'string' && rec.type.trim() ? rec.type.trim() : 'note',
      body: rec.body,
    });
  }
  const skipped = (parsed as { skipped?: unknown }).skipped === true;
  const skipReasonRaw = (parsed as { skip_reason?: unknown }).skip_reason;
  return {
    pages,
    skipped,
    skip_reason: typeof skipReasonRaw === 'string' ? skipReasonRaw : null,
  };
}

/**
 * Extract wikilink targets from a body: `[[slug]]` / `[[slug|alias]]` /
 * `[[slug#anchor]]` plus relative markdown links `[text](path/to-page)`
 * (the two forms the synthesis prompt teaches). http(s)/mailto links are not
 * page links.
 */
export function extractWikilinkTargets(body: string): string[] {
  const targets: string[] = [];
  const wikilink = /\[\[([^\]|#\n]+)(?:[|#][^\]]*)?\]\]/gu;
  for (const m of body.matchAll(wikilink)) {
    const t = m[1].trim();
    if (t) targets.push(t);
  }
  const mdLink = /\]\(((?!https?:\/\/|mailto:)[^()\s]+)\)/gu;
  for (const m of body.matchAll(mdLink)) {
    const t = m[1].trim().replace(/^\.\//, '').replace(/\.md$/, '');
    if (t && !t.startsWith('#')) targets.push(t);
  }
  return targets;
}

export interface OneshotArgs {
  engine: BrainEngine;
  ctx: MinionJobContext;
  data: SubagentHandlerData;
  model: string;
  maxOutputTokens: number;
  /** The deferEmbeds-enabled brain_put_page ToolDef (same executor as the loop). */
  putPageTool: ToolDef | undefined;
  leaseKey: string;
  maxConcurrent: number;
  leaseTtlMs: number;
  /** Test seam (extract-atoms pattern). */
  _chat?: typeof gatewayChat;
}

interface LedgerRow { tool_use_id: string; status: string; slug: string | null }

async function loadOneshotLedger(engine: BrainEngine, jobId: number): Promise<LedgerRow[]> {
  return engine.executeRaw<LedgerRow>(
    `SELECT tool_use_id, status, input->>'slug' AS slug
       FROM subagent_tool_executions
      WHERE job_id = $1 AND tool_use_id LIKE 'oneshot-%'
      ORDER BY id`,
    [jobId],
  );
}

export async function runSubagentOneshot(args: OneshotArgs): Promise<OneshotOutcome> {
  const { engine, ctx, data, model } = args;
  const chat = args._chat ?? gatewayChat;

  // ── OV-4: ledger-first recovery ─────────────────────────────────────────
  // A prior invocation of this job already reached the write stage. Never
  // re-call the model (nondeterministic output would double-write different
  // pages); the completed rows ARE the writes.
  const priorLedger = await loadOneshotLedger(engine, ctx.id);
  if (priorLedger.length > 0) {
    const writtenRefs = priorLedger
      .filter(r => r.status === 'complete' || r.status === 'failed')
      .map(r => ({ slug: r.slug ?? '', status: (r.status === 'complete' ? 'complete' : 'failed') as 'complete' | 'failed' }))
      .filter(r => r.slug !== '');
    const recoveredText = `oneshot recovery: finalized from a prior invocation's ledger (${writtenRefs.filter(r => r.status === 'complete').length} completed write(s))`;
    await persistOneshotTranscript(engine, ctx.id, data.prompt, recoveredText, model);
    return {
      kind: 'done',
      result: {
        result: recoveredText,
        turns_count: 1,
        stop_reason: 'end_turn',
        tokens: { in: 0, out: 0, cache_read: 0, cache_create: 0 },
        synth_mode_used: 'oneshot',
        written_refs: writtenRefs,
        recovered: true,
      },
    };
  }

  if (!args.putPageTool) {
    // No put_page in the registry (misconfigured allow-list) — the agentic
    // loop will surface the same problem through its own vocabulary.
    return { kind: 'fallback', reason: 'unparseable' };
  }

  // ── Single provider call under a rate lease + sub-budget (OV-9) ─────────
  const lease = await acquireLease(engine, args.leaseKey, ctx.id, args.maxConcurrent, { ttlMs: args.leaseTtlMs });
  if (!lease.acquired) {
    // Propagate through the caller's lease-full vocabulary by falling back?
    // NO — a full bucket is a scheduling condition, not a model failure. The
    // caller throws RateLeaseUnavailableError for us (see subagent.ts) — but
    // to keep this module self-contained we simply signal via exception.
    const { RateLeaseUnavailableError } = await import('./subagent.ts');
    throw new RateLeaseUnavailableError(args.leaseKey, lease.activeCount, lease.maxConcurrent);
  }

  const budgetMs = ctx.deadlineAtMs
    ? Math.min(ONESHOT_CALL_BUDGET_MS, Math.max(30_000, Math.floor((ctx.deadlineAtMs - Date.now()) / 4)))
    : ONESHOT_CALL_BUDGET_MS;
  const budgetAbort = AbortSignal.timeout(budgetMs);
  const callSignal = ctx.signal ? AbortSignal.any([ctx.signal, budgetAbort]) : budgetAbort;

  let chatResult: ChatResult;
  const t0 = Date.now();
  logSubagentHeartbeat({ job_id: ctx.id, event: 'llm_call_started', turn_idx: 0, mode: 'oneshot' });
  try {
    chatResult = await chat({
      model,
      system: ONESHOT_SYSTEM,
      messages: [{ role: 'user', content: data.prompt }],
      maxTokens: args.maxOutputTokens,
      abortSignal: callSignal,
      cacheSystem: true,
    });
  } catch (err) {
    if (budgetAbort.aborted && !(ctx.signal?.aborted)) {
      // The oneshot sub-budget expired — the agentic fallback still has the
      // rest of the job budget (OV-9). Never charge a slow single call
      // against the whole job.
      logSubagentHeartbeat({ job_id: ctx.id, event: 'oneshot_timeout', turn_idx: 0, ms_elapsed: Date.now() - t0 });
      return { kind: 'fallback', reason: 'oneshot_timeout' };
    }
    // Job-level abort or transport error: the job machinery owns these — a
    // provider outage would break the fallback identically (don't double-pay).
    throw err;
  } finally {
    await releaseLease(engine, lease.leaseId!).catch(() => { /* best-effort */ });
  }

  await ctx.updateTokens({
    input: chatResult.usage.input_tokens,
    output: chatResult.usage.output_tokens,
    cache_read: chatResult.usage.cache_read_tokens,
  });
  const tokens = {
    in: chatResult.usage.input_tokens,
    out: chatResult.usage.output_tokens,
    cache_read: chatResult.usage.cache_read_tokens,
    cache_create: chatResult.usage.cache_creation_tokens,
  };
  logSubagentHeartbeat({ job_id: ctx.id, event: 'llm_call_completed', turn_idx: 0, tokens: { in: tokens.in, out: tokens.out, cache_read: tokens.cache_read, cache_create: tokens.cache_create } });

  // ── Degenerate-output discipline (judgeSignificance parity) ─────────────
  if (chatResult.stopReason === 'length') return { kind: 'fallback', reason: 'length' };
  if (chatResult.stopReason === 'refusal' || chatResult.stopReason === 'content_filter') {
    return { kind: 'fallback', reason: 'refusal' };
  }

  const parsed = parseOneshotResponse(chatResult.text ?? '');
  if (!parsed) return { kind: 'fallback', reason: 'unparseable' };
  if (parsed.pages.length === 0) {
    if (!parsed.skipped) return { kind: 'fallback', reason: 'empty_no_skip' };
    // Task-D skip: a legitimate zero-write completion.
    const skipText = `oneshot: nothing met the bar — ${parsed.skip_reason ?? 'no reason given'}`;
    await persistOneshotTranscript(engine, ctx.id, data.prompt, chatResult.text ?? skipText, model, tokens);
    return {
      kind: 'done',
      result: {
        result: skipText,
        turns_count: 1,
        stop_reason: 'end_turn',
        tokens,
        synth_mode_used: 'oneshot',
        written_refs: [],
      },
    };
  }
  if (parsed.pages.length > MAX_PAGES_PER_RESPONSE) return { kind: 'fallback', reason: 'unparseable' };

  // ── Validate ALL pages before ANY write ─────────────────────────────────
  const prefixes = data.allowed_slug_prefixes ?? [];
  // CDX-9 task shapes: reflections/originals sub-trees of the allow-list.
  const taskShapePrefixes = prefixes
    .filter(p => p.includes('/personal/reflections/') || p.includes('/originals/'))
    .map(p => (p.endsWith('/*') ? p.slice(0, -1) : p.endsWith('/') ? p : `${p}/`));
  const inBatch = new Set(parsed.pages.map(p => p.slug));
  let existingSlugs: Set<string>;
  try {
    existingSlugs = await engine.getAllSlugs(data.source_id ? { sourceId: data.source_id } : undefined);
  } catch {
    existingSlugs = new Set();
  }
  // CEO-5 cold-brain relaxation: no manifest was offered AND the brain has
  // almost no pages — a resolving wikilink is impossible; accept syntactic
  // presence (content-first; the edge materializes once targets exist).
  const coldBrain = existingSlugs.size < 5 && !data.prompt.includes('LINK CANDIDATES (');

  for (const page of parsed.pages) {
    if (!SLUG_RE.test(page.slug)) return { kind: 'fallback', reason: 'bad_slug' };
    if (prefixes.length > 0 && !matchesSlugAllowList(page.slug, prefixes)) {
      return { kind: 'fallback', reason: 'bad_slug' };
    }
    if (taskShapePrefixes.length > 0 && !taskShapePrefixes.some(p => page.slug.startsWith(p))) {
      // Oneshot synthesis writes ONLY reflections/originals (Task C forbids
      // touching person pages; the orchestrator owns people enrichment).
      return { kind: 'fallback', reason: 'bad_slug' };
    }
    if (data.oneshot_slug_suffix && !page.slug.endsWith(`-${data.oneshot_slug_suffix}`)) {
      return { kind: 'fallback', reason: 'bad_slug' };
    }
    const targets = extractWikilinkTargets(page.body);
    if (targets.length === 0) return { kind: 'fallback', reason: 'no_wikilink' };
    if (!coldBrain) {
      const resolves = targets.some(t => existingSlugs.has(t) || (inBatch.has(t) && t !== page.slug));
      if (!resolves) return { kind: 'fallback', reason: 'no_wikilink' };
    }
  }

  // ── Programmatic writes through the shared put_page executor ────────────
  const inv8 = randomUUID().replace(/-/g, '').slice(0, 8);
  const writtenRefs: Array<{ slug: string; status: 'complete' | 'failed' }> = [];
  for (let i = 0; i < parsed.pages.length; i++) {
    const page = parsed.pages[i];
    const toolUseId = `oneshot-${inv8}-p${i}`;
    const input = { slug: page.slug, content: page.body };
    await persistToolExecPending(engine, ctx.id, 1, toolUseId, 'brain_put_page', input);
    try {
      const output = await args.putPageTool.execute(input, {
        engine,
        jobId: ctx.id,
        remote: true,
        signal: ctx.signal,
      });
      await persistToolExecComplete(engine, ctx.id, toolUseId, output);
      writtenRefs.push({ slug: page.slug, status: 'complete' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await persistToolExecFailed(engine, ctx.id, 1, toolUseId, 'brain_put_page', input, msg);
      writtenRefs.push({ slug: page.slug, status: 'failed' });
    }
  }

  // ── Post-batch auto-link pass (CEO-1/CDX-11) ─────────────────────────────
  // In-batch forward references (page A → page B written later) were dropped
  // by A's own auto-link run because B did not exist yet. Re-run now that the
  // whole batch landed; gated + best-effort inside the wrapper.
  for (const ref of writtenRefs) {
    if (ref.status !== 'complete') continue;
    await autoLinkWrittenPage(engine, ref.slug, data.source_id ? { sourceId: data.source_id } : undefined);
  }

  const written = writtenRefs.filter(r => r.status === 'complete');
  const resultText = `oneshot: wrote ${written.length}/${parsed.pages.length} page(s): ${written.map(r => r.slug).join(', ')}`;
  await persistOneshotTranscript(engine, ctx.id, data.prompt, chatResult.text ?? resultText, model, tokens);

  return {
    kind: 'done',
    result: {
      result: resultText,
      turns_count: 1,
      stop_reason: 'end_turn',
      tokens,
      synth_mode_used: 'oneshot',
      written_refs: writtenRefs,
    },
  };
}

/**
 * Persist the seed user + terminal assistant turns — ONLY on success paths
 * (done/skip/recovery). A failed attempt persists nothing, so the
 * alreadyTerminal replay check can never return its output as a completed
 * job, and CDX-2's fresh-job gate stays accurate for the fallback.
 */
async function persistOneshotTranscript(
  engine: BrainEngine,
  jobId: number,
  prompt: string,
  assistantText: string,
  model: string,
  tokens?: { in: number; out: number; cache_read: number; cache_create: number },
): Promise<void> {
  await persistMessage(engine, jobId, {
    message_idx: 0,
    role: 'user',
    content_blocks: [{ type: 'text', text: prompt }] as ContentBlock[],
    tokens_in: null, tokens_out: null, tokens_cache_read: null, tokens_cache_create: null,
    model: null,
  });
  await persistMessage(engine, jobId, {
    message_idx: 1,
    role: 'assistant',
    content_blocks: [{ type: 'text', text: assistantText }] as ContentBlock[],
    tokens_in: tokens?.in ?? null,
    tokens_out: tokens?.out ?? null,
    tokens_cache_read: tokens?.cache_read ?? null,
    tokens_cache_create: tokens?.cache_create ?? null,
    model,
  });
}
