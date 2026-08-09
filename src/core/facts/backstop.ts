/**
 * v0.31.2 — runFactsBackstop: shared facts pipeline used by every brain
 * write surface that wants real-time hot memory extraction.
 *
 * Encapsulates the v0.31 smart pipeline:
 *
 *   extract (extractFactsFromTurn — sanitize + LLM + parser fixed in B1)
 *     ↓
 *   resolve (resolveEntitySlug — canonicalize free-form entity refs)
 *     ↓
 *   dedup   (findCandidateDuplicates + cosineSimilarity @ 0.95)
 *     ↓
 *   insert  (engine.insertFact with supersede support)
 *
 * Replaces five divergent implementations (put_page hook, extract_facts
 * MCP op, sync.ts post-import block, file_upload, code_import) with one
 * choke point. Eligibility runs through `isFactsBackstopEligible` from
 * src/core/facts/eligibility.ts; kill-switch via `isFactsExtractionEnabled`.
 *
 * Two execution modes (D8 from /plan-eng-review):
 *
 *   - 'queue' (default): fire-and-forget via `getFactsQueue().enqueue`.
 *     Caller's await is ~zero (just the enqueue + microtask schedule).
 *     Used by sync, put_page, file_upload, code_import. Sync stays fast
 *     even on a 50-page batch.
 *
 *   - 'inline': await the full pipeline; return real {inserted, duplicate,
 *     superseded, fact_ids} counts. Used by the explicit extract_facts
 *     MCP op so tool-call responses carry truthful numbers.
 *
 * Notability filter (D4): per-caller policy via FactsBackstopCtx.notabilityFilter.
 * Sync passes 'high-only' (HIGH lands now, MEDIUM waits for the dream
 * cycle, LOW dropped at LLM layer). Other surfaces default to 'all'.
 *
 * Failure modes route to ingest_log (D5) via writeFactsAbsorbLog (lands
 * in PR1 commit 13). For PR1 commit 6 the absorb writer is a placeholder;
 * commit 13 wires it.
 */

import type { BrainEngine, FactInsertStatus, NewFact } from '../engine.ts';
import { isFactsBackstopEligible } from './eligibility.ts';
import type { PageType } from '../types.ts';

export interface FactsBackstopCtx {
  engine: BrainEngine;
  /** Brain source identifier; default 'default'. */
  sourceId: string;
  /** source_session for provenance; null if absent. */
  sessionId: string | null;
  /**
   * Provenance source string written into facts.source. Stable values:
   *   - 'sync:import'        — git sync post-import hook
   *   - 'mcp:put_page'       — MCP put_page backstop
   *   - 'mcp:extract_facts'  — explicit MCP op (inline mode)
   *   - 'file_upload'        — file_upload import path
   *   - 'code_import'        — code import path
   */
  source: 'sync:import' | 'mcp:put_page' | 'mcp:extract_facts' | 'file_upload' | 'code_import';
  /** Execution mode — D8. Default 'queue' (fire-and-forget). */
  mode?: 'queue' | 'inline';
  /** Notability filter — D4. Default 'all'; sync uses 'high-only'. */
  notabilityFilter?: 'all' | 'high-only';
  /** Abort signal for shutdown propagation. */
  abortSignal?: AbortSignal;
  /** Mirrors OperationContext.remote for trust-aware logging paths. */
  remote?: boolean;
  /** Optional entity hints (extract_facts MCP op forwards these). */
  entityHints?: string[];
  /** Optional visibility tier (default 'private'). extract_facts forwards `world` when caller asks. */
  visibility?: 'private' | 'world';
  /** Override the chat model (extract_facts forwards user's model param when set). */
  model?: string;
  /**
   * #2108: prefer the durable facts-absorb minion job over the in-process
   * queue when a live `gbrain jobs work` worker can process it. Set by
   * put_page for remote/MCP callers (fail-closed spelling at the call site:
   * `ctx.remote !== false`) — an MCP/remote server process can exit before
   * the in-process absorb finishes its 5-30s extraction chat, and the exit
   * drain (cli-force-exit.ts, GBRAIN_DRAIN_TIMEOUT_MS default 2000ms) aborts
   * it: page persists, facts silently never land. A durable job survives the
   * process.
   */
  preferDurableAbsorb?: boolean;
}

/** Discriminated return shape based on FactsBackstopCtx.mode. */
export type FactsBackstopResult =
  | {
      mode: 'queue';
      enqueued: boolean;
      queueDepth: number;
      skipped?: 'extraction_disabled' | 'queue_overflow' | 'queue_shutdown' | `eligibility_failed:${string}`;
    }
  | {
      mode: 'inline';
      inserted: number;
      duplicate: number;
      superseded: number;
      fact_ids: number[];
      skipped?: 'extraction_disabled' | `eligibility_failed:${string}`;
    };

interface ParsedPageInput {
  slug: string;
  type: PageType;
  compiled_truth: string;
  frontmatter: Record<string, unknown>;
}

/**
 * Cosine similarity threshold for the dedup fast-path. Matches the existing
 * extract_facts op behavior at operations.ts:2460. Higher = stricter
 * dedup (more rows kept distinct); lower = looser (more rows treated as
 * duplicates of older ones).
 */
const DEDUP_THRESHOLD = 0.95;

/** k for findCandidateDuplicates — ceiling on candidates considered. */
const DEDUP_CANDIDATE_LIMIT = 5;

/**
 * Once-per-process stderr warning memo. v0.32.2 uses this to surface
 * the thin-client / no-local_path fallback without spamming a warning
 * on every put_page in a long-running brain.
 */
const _warnedKeys = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (_warnedKeys.has(key)) return;
  _warnedKeys.add(key);
  // eslint-disable-next-line no-console
  console.warn(msg);
}
/** Test-only: reset the once-per-process warning memo. */
export function __resetBackstopWarningsForTests(): void {
  _warnedKeys.clear();
}

/**
 * #2108 test seam — override the live-worker probe. Production leaves this
 * null and probes the file-based worker registry (readWorkers prunes dead
 * PIDs and filters by brain id).
 */
let _liveWorkerProbeOverride: (() => boolean) | null = null;
export function __setLiveWorkerProbeForTests(p: (() => boolean) | null): void {
  _liveWorkerProbeOverride = p;
}

/**
 * Queue the durable facts-absorb job is submitted to. The live-worker probe
 * MUST check this same queue — a worker draining a different queue can never
 * claim the job, so its presence proves nothing.
 */
const FACTS_ABSORB_QUEUE = 'default';

/**
 * Short-TTL memo for the live-worker probe. readWorkers() execs `ps`
 * synchronously per registry entry, and un-memoized that cost lands inside
 * EVERY remote put_page. 5s of staleness is harmless here — worst case one
 * page's facts run in-process (worker just started) or ride the in-process
 * queue once more (worker just died; the durable submit would have parked
 * anyway).
 */
const WORKER_PROBE_TTL_MS = 5_000;
let _workerProbeCache: { at: number; value: boolean } | null = null;
/** Test-only: reset the worker-probe TTL memo. */
export function __resetWorkerProbeCacheForTests(): void {
  _workerProbeCache = null;
}

/**
 * Is a live minion worker available to process a durable facts-absorb job
 * for this brain — on the queue the job actually goes to? Cheap file-registry
 * read (no DB), memoized for WORKER_PROBE_TTL_MS. Fail-open to `false`: a
 * probe error must never block the in-process fallback.
 *
 * Red-team (#2108 residual): the probe is queue-aware. A queue-blind
 * presence check let a worker on another queue (`gbrain jobs work --queue
 * shell`) satisfy the probe while never claiming the 'default'-queue job —
 * parking it forever AND skipping the in-process fallback: the exact silent
 * loss #2108 closed.
 */
async function hasLiveMinionWorker(): Promise<boolean> {
  if (_liveWorkerProbeOverride) return _liveWorkerProbeOverride();
  const now = Date.now();
  if (_workerProbeCache !== null && now - _workerProbeCache.at < WORKER_PROBE_TTL_MS) {
    return _workerProbeCache.value;
  }
  let value = false;
  try {
    const { readWorkers } = await import('../minions/worker-registry.ts');
    value = readWorkers().some((w) => w.queue === FACTS_ABSORB_QUEUE);
  } catch {
    value = false;
  }
  _workerProbeCache = { at: now, value };
  return value;
}

/**
 * Submit a durable `facts-absorb` minion job for one page (processed by the
 * long-lived `gbrain jobs work` daemon; handler in src/commands/jobs.ts).
 * Content-hash idempotency key: re-submits after edits, dedups rapid
 * identical writes (idempotent ON CONFLICT returns the existing row).
 * Throws when minions infra is unavailable (old schema, etc.) — callers
 * fall back to the in-process queue.
 */
async function submitDurableFactsAbsorb(
  parsedPage: ParsedPageInput,
  ctx: FactsBackstopCtx,
): Promise<void> {
  const { MinionQueue } = await import('../minions/queue.ts');
  const { createHash } = await import('node:crypto');
  const contentHash = createHash('sha256')
    .update(parsedPage.compiled_truth)
    .digest('hex')
    .slice(0, 16);
  const minions = new MinionQueue(ctx.engine);
  await minions.add(
    'facts-absorb',
    {
      slug: parsedPage.slug,
      sourceId: ctx.sourceId,
      source: ctx.source,
      sessionId: ctx.sessionId,
      notabilityFilter: ctx.notabilityFilter ?? 'all',
      visibility: ctx.visibility ?? 'private',
      ...(ctx.model ? { model: ctx.model } : {}),
    },
    {
      queue: FACTS_ABSORB_QUEUE,
      idempotency_key: `facts-absorb:${ctx.sourceId}:${parsedPage.slug}:${contentHash}`,
      max_attempts: 3,
      timeout_ms: 180_000,
    },
  );
}

/**
 * Run the facts pipeline for one page write. See module docstring for
 * the full lifecycle and mode semantics.
 *
 * Re-throws AbortError; absorbs gateway/parse/queue errors as
 * `skipped: '...'` envelope (operator visibility lands via PR1 commit 13's
 * ingest_log writer).
 */
export async function runFactsBackstop(
  parsedPage: ParsedPageInput,
  ctx: FactsBackstopCtx,
): Promise<FactsBackstopResult> {
  const mode = ctx.mode ?? 'queue';

  // --- Eligibility + kill-switch gates (run before any LLM cost) ---
  const { isFactsExtractionEnabled } = await import('./extract.ts');
  const enabled = await isFactsExtractionEnabled(ctx.engine);
  if (!enabled) {
    return mode === 'queue'
      ? { mode: 'queue', enqueued: false, queueDepth: 0, skipped: 'extraction_disabled' }
      : { mode: 'inline', inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], skipped: 'extraction_disabled' };
  }

  const eligible = isFactsBackstopEligible(parsedPage.slug, parsedPage);
  if (!eligible.ok) {
    const skipped = `eligibility_failed:${eligible.reason}` as const;
    return mode === 'queue'
      ? { mode: 'queue', enqueued: false, queueDepth: 0, skipped }
      : { mode: 'inline', inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], skipped };
  }

  // --- Mode dispatch ---
  if (mode === 'queue') {
    // Local patch 2026-06-11: in a one-shot CLI process the in-process queue
    // is doomed — cli.ts's exit drain aborts the in-flight chat after ~1-2s,
    // so every CLI capture logged `pipeline_error: [chat(...)] The operation
    // was aborted.` and extracted nothing. Submit a durable facts-absorb
    // minion job for the long-lived jobs worker instead. Falls through to
    // the in-process queue if durable submission fails (old schema, no
    // minions infra), preserving prior behavior + absorb-log visibility.
    //
    // #2108: the remote/MCP put_page path (ctx.preferDurableAbsorb) has the
    // same doomed shape when the server process exits mid-extraction, so it
    // ALSO prefers the durable job — but only when a live worker exists for
    // this brain. Unlike the one-shot CLI (where the in-process queue can
    // NEVER finish), a long-lived server usually finishes in-process work,
    // so unconditionally parking jobs in a queue no worker drains would
    // regress worker-less installs.
    const { isShortLivedCliProcess } = await import('./cli-process-mode.ts');
    const wantDurable =
      isShortLivedCliProcess() ||
      (ctx.preferDurableAbsorb === true && (await hasLiveMinionWorker()));
    if (wantDurable) {
      try {
        await submitDurableFactsAbsorb(parsedPage, ctx);
        return { mode: 'queue', enqueued: true, queueDepth: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnOnce(
          'facts-absorb-job-submit',
          `[facts] durable facts-absorb submit failed (${msg}); falling back to in-process queue`,
        );
      }
    }
    const { getFactsQueue } = await import('./queue.ts');
    const queue = getFactsQueue();
    const enqueued = queue.enqueue(async (signal) => {
      // v0.31.2 (PR1 commit 13): facts:absorb writer wired here. Errors
      // inside the queue worker were previously invisible (queue counter
      // increments only). Now they land in ingest_log so doctor +
      // dashboard surface failure modes per source.
      //
      // #2108: a drain-abort at process exit is NOT a terminal failure.
      // Nothing is ever stamped as "facts done" on this path (there is no
      // completion watermark; the absorb-log row is a failure record, and
      // conversation_facts_backfill's terminal audit row is only written by
      // that pass) — so re-queue the work durably and say so loudly instead
      // of losing it in silence. The facts sink drains FIRST (order 0) and
      // its abort is awaited, so the engine is still connected here.
      const requeueAborted = async (): Promise<void> => {
        let requeued = false;
        try {
          await submitDurableFactsAbsorb(parsedPage, ctx);
          requeued = true;
        } catch {
          /* minions infra unavailable — the stderr line below still names the loss */
        }
        // eslint-disable-next-line no-console
        console.error(
          `[facts] absorb aborted at process exit for "${parsedPage.slug}" — facts NOT extracted (the page itself is saved). ` +
          (requeued
            ? 'Re-queued as a durable facts-absorb job; the next `gbrain jobs work` / autopilot worker retries it.'
            : 'Durable re-queue unavailable; rewrite the page or run `gbrain extract-conversation-facts` to retry.'),
        );
      };
      try {
        const res = await runPipeline(parsedPage, ctx, signal);
        // Early-bail abort: runPipelineWithBody returns zeros WITHOUT
        // throwing when the signal fires before the extraction chat starts.
        // Same loss shape as the thrown abort — requeue + absorb-log. A
        // genuinely-zero extraction that raced the abort merely re-runs one
        // extraction on the worker (idempotency key dedups the job row).
        if (
          signal.aborted &&
          res.inserted + res.duplicate + res.superseded === 0 &&
          res.fact_ids.length === 0
        ) {
          await requeueAborted();
          const { writeFactsAbsorbLog } = await import('./absorb-log.ts');
          await writeFactsAbsorbLog(
            ctx.engine,
            parsedPage.slug,
            'pipeline_error',
            'absorb aborted at process exit before completion',
            ctx.sourceId,
          );
        }
      } catch (err) {
        // Red-team: honest abort detection. The old `/abort/i` message sniff
        // also matched Postgres's routine "current transaction is aborted,
        // commands ignored until end of transaction block" — a plain DB
        // failure that would spuriously requeue AND print the exit-drain
        // stderr banner. The real drain path needs no message sniff:
        // queue.shutdown() aborts `signal` before in-flight work observes
        // it, and a gateway fetch abort throws with err.name ===
        // 'AbortError'. Errors are classified by NAME + signal state only.
        const aborted =
          signal.aborted || (err instanceof Error && err.name === 'AbortError');
        if (aborted) {
          await requeueAborted();
        }
        const { classifyFactsAbsorbError, writeFactsAbsorbLog } = await import('./absorb-log.ts');
        const reason = classifyFactsAbsorbError(err);
        const msg = err instanceof Error ? err.message : String(err);
        await writeFactsAbsorbLog(ctx.engine, parsedPage.slug, reason, msg, ctx.sourceId);
      }
    }, ctx.sessionId ?? parsedPage.slug);

    if (enqueued < 0) {
      // -1 means the queue is shutting down OR cap-overflow drop fired.
      // Caller can disambiguate via getCounters() if they care; for now
      // collapse to a single skipped reason and record the absorb event.
      const { writeFactsAbsorbLog } = await import('./absorb-log.ts');
      await writeFactsAbsorbLog(
        ctx.engine,
        parsedPage.slug,
        'queue_overflow',
        `queue capacity hit; enqueue dropped (sessionId=${ctx.sessionId ?? parsedPage.slug})`,
        ctx.sourceId,
      );
      return { mode: 'queue', enqueued: false, queueDepth: 0, skipped: 'queue_overflow' };
    }
    return { mode: 'queue', enqueued: true, queueDepth: enqueued };
  }

  // 'inline' mode: caller awaits the full pipeline. Errors bubble to the
  // caller — extract_facts MCP op surfaces them as op-error responses
  // (the explicit-call contract). Unlike queue mode, we don't absorb-log
  // here because the caller decides whether the failure is interesting
  // enough to record (vs. retry, vs. surface directly to the user).
  const r = await runPipeline(parsedPage, ctx, ctx.abortSignal);
  return { mode: 'inline', ...r };
}

/**
 * Public pipeline entry-point — extract → resolve → dedup → insert.
 *
 * Used by:
 *   - runFactsBackstop (above) — wraps with eligibility + kill-switch
 *     gates and queue-mode dispatch.
 *   - extract_facts MCP op — calls directly with raw turn_text. The op
 *     is an explicit user request, not a page-write hook, so eligibility
 *     doesn't apply (no slug, no PageType, no frontmatter). Operator-
 *     level visibility filter (private vs world) and kill-switch gating
 *     are the op's responsibility.
 *
 * Inputs come from extractFactsFromTurn — the LLM extractor — but this
 * function itself is shape-agnostic: it takes a `turnText` and the same
 * FactsBackstopCtx used elsewhere. AbortError re-thrown; gateway / parse
 * / DB errors bubble (caller decides whether to absorb).
 */
export async function runFactsPipeline(
  turnText: string,
  ctx: FactsBackstopCtx,
): Promise<{ inserted: number; duplicate: number; superseded: number; fact_ids: number[] }> {
  return runPipelineWithBody({
    turnText,
    isDreamGenerated: false,
  }, ctx, ctx.abortSignal);
}

/**
 * Internal pipeline: extract → resolve → dedup → insert. Pure work
 * (no eligibility/kill-switch gates — those run upstream in the
 * exported entry point).
 *
 * Returns count envelope for inline-mode callers; queue-mode callers
 * discard the return value (the queue worker only cares that the
 * promise settled).
 */
async function runPipeline(
  parsedPage: ParsedPageInput,
  ctx: FactsBackstopCtx,
  abortSignal?: AbortSignal,
): Promise<{ inserted: number; duplicate: number; superseded: number; fact_ids: number[] }> {
  return runPipelineWithBody(
    {
      turnText: parsedPage.compiled_truth,
      isDreamGenerated: false,  // eligibility check already rejected dream pages
    },
    ctx,
    abortSignal,
  );
}

/**
 * Inner pipeline body. Shared between runFactsBackstop (page-shape entry)
 * and runFactsPipeline (raw turn-text entry). Eligibility + kill-switch
 * are upstream of this; we just extract → resolve → dedup → write fence
 * → stamp DB.
 *
 * v0.32.2 (Codex R2-#2): markdown-first rewrite. Both this function's
 * callers route through here, so making the write path fence-first here
 * makes BOTH runFactsBackstop AND runFactsPipeline canonical without
 * changing either entry-point signature.
 *
 * Pipeline:
 *   1. extract (extractFactsFromTurn — sanitize + LLM + parser)
 *   2. resolve (resolveEntitySlug — canonicalize free-form entity refs)
 *   3. dedup   (findCandidateDuplicates + cosineSimilarity @ 0.95)
 *   4. write   (writeFactsToFence → markdown atomic write + engine.insertFacts)
 *
 * Step 4 falls through to legacy single-row engine.insertFact when the
 * brain has no sources.local_path configured (thin-client install). A
 * once-per-process stderr warning names the missing config so operators
 * see the degraded mode at boot.
 *
 * Facts with no resolved entity_slug structurally can't be fenced (no
 * entity page to fence them on), so they take the same legacy DB-only
 * fallback regardless of local_path.
 */
async function runPipelineWithBody(
  input: { turnText: string; isDreamGenerated: boolean },
  ctx: FactsBackstopCtx,
  abortSignal?: AbortSignal,
): Promise<{ inserted: number; duplicate: number; superseded: number; fact_ids: number[] }> {
  const { extractFactsFromTurn } = await import('./extract.ts');
  const { resolveEntitySlug } = await import('../entities/resolve.ts');
  const { cosineSimilarity } = await import('./classify.ts');
  const { writeFactsToFence, lookupSourceLocalPath } = await import('./fence-write.ts');

  if (abortSignal?.aborted) {
    return { inserted: 0, duplicate: 0, superseded: 0, fact_ids: [] };
  }

  const facts = await extractFactsFromTurn({
    turnText: input.turnText,
    sessionId: ctx.sessionId,
    entityHints: ctx.entityHints,
    source: ctx.source,
    isDreamGenerated: input.isDreamGenerated,
    engine: ctx.engine,
    abortSignal,
    model: ctx.model,
  });

  const filter = ctx.notabilityFilter ?? 'all';
  const visibility = ctx.visibility ?? 'private';

  let inserted = 0;
  let duplicate = 0;
  let superseded = 0;
  const fact_ids: number[] = [];

  // Phase 1: per-fact filter + dedup. Surviving facts (no dedup hit)
  // get grouped by entity_slug for the fence-write phase below.
  type SurvivedFact = {
    f: typeof facts[number];
    resolvedSlug: string | null;
  };
  const survived: SurvivedFact[] = [];

  for (const f of facts) {
    if (abortSignal?.aborted) break;

    // D4: notability filter applied post-extraction, pre-insert.
    if (filter === 'high-only' && f.notability !== 'high') continue;

    const resolvedSlug = f.entity_slug
      ? await resolveEntitySlug(ctx.engine, ctx.sourceId, f.entity_slug)
      : null;

    // Dedup against DB candidates (correct per Codex Q7: fence rows
    // have no embeddings; FS lock + sync invariant means DB == fence
    // at write time). Threshold 0.95 unchanged.
    let matchedExistingId: number | null = null;
    if (resolvedSlug && f.embedding) {
      const candidates = await ctx.engine.findCandidateDuplicates(
        ctx.sourceId,
        resolvedSlug,
        f.fact,
        { embedding: f.embedding, k: DEDUP_CANDIDATE_LIMIT },
      );
      let topId: number | null = null;
      let topScore = -1;
      for (const c of candidates) {
        if (!c.embedding) continue;
        const s = cosineSimilarity(f.embedding, c.embedding);
        if (s > topScore) { topScore = s; topId = c.id; }
      }
      if (topId !== null && topScore >= DEDUP_THRESHOLD) {
        matchedExistingId = topId;
      }
    }

    if (matchedExistingId !== null) {
      duplicate += 1;
      fact_ids.push(matchedExistingId);
      continue;
    }

    survived.push({ f, resolvedSlug });
  }

  if (survived.length === 0) {
    return { inserted, duplicate, superseded, fact_ids };
  }

  // Phase 2: group survived facts by resolved entity_slug. Facts with
  // no resolved slug go to a special legacy bucket.
  const byEntity = new Map<string, SurvivedFact[]>();
  const unparented: SurvivedFact[] = [];
  for (const s of survived) {
    if (s.resolvedSlug === null) {
      unparented.push(s);
    } else {
      const list = byEntity.get(s.resolvedSlug) ?? [];
      list.push(s);
      byEntity.set(s.resolvedSlug, list);
    }
  }

  // Phase 3: look up source.local_path once for the fence path. Null
  // means thin-client / no FS — fall through to legacy DB-only for
  // every fact.
  const localPath = await lookupSourceLocalPath(ctx.engine, ctx.sourceId);

  // Phase 4: legacy DB-only fallback for unparented + thin-client.
  // Single-row engine.insertFact preserves the v0.31 semantics for
  // these structurally-unfenceable cases.
  const legacyBucket: SurvivedFact[] = [];
  if (localPath === null) {
    warnOnce(
      'facts:thin-client-fallback',
      '[facts] sources.local_path unset for source_id=' + ctx.sourceId +
      ' — falling through to DB-only inserts. Configure local_path via `gbrain sources update` to enable system-of-record fence writes.',
    );
    for (const s of survived) legacyBucket.push(s);
  } else {
    for (const s of unparented) legacyBucket.push(s);
  }

  for (const { f, resolvedSlug } of legacyBucket) {
    const newFact: NewFact = {
      fact: f.fact,
      kind: f.kind,
      entity_slug: resolvedSlug,
      visibility,
      notability: f.notability,
      source: f.source,
      source_session: f.source_session ?? null,
      confidence: f.confidence,
      embedding: f.embedding ?? null,
    };
    const result = await ctx.engine.insertFact(newFact, { source_id: ctx.sourceId }); // gbrain-allow-direct-insert: legacy DB-only fallback for unparented / thin-client facts (no entity page to fence onto)
    fact_ids.push(result.id);
    if (result.status === 'inserted') inserted += 1;
    else if ((result.status as FactInsertStatus) === 'duplicate') duplicate += 1;
    else superseded += 1;
  }

  if (localPath === null) {
    // All went through legacy bucket; nothing left to fence.
    return { inserted, duplicate, superseded, fact_ids };
  }

  // Phase 5: fence-write per entity. writeFactsToFence handles the
  // page lock, stub-create, atomic .tmp+parse+rename, and the
  // engine.insertFacts batch.
  for (const [slug, group] of byEntity) {
    if (abortSignal?.aborted) break;

    const inputFacts = group.map(({ f }) => ({
      fact: f.fact,
      kind: f.kind,
      notability: f.notability,
      source: f.source,
      context: null,
      visibility,
      confidence: f.confidence,
      validFrom: f.valid_from ?? new Date(),
      embedding: f.embedding ?? null,
      sessionId: f.source_session ?? null,
    }));

    const result = await writeFactsToFence(
      ctx.engine,
      { sourceId: ctx.sourceId, localPath, slug },
      inputFacts,
    );

    if (result.fenceWriteFailed) {
      // Fence parse-validate rejected the .tmp; .tmp stays as
      // quarantine. The JSONL log is the operator surface. Treat
      // every fact in this entity group as not-inserted (no fact_id
      // returned). Do NOT fall through to legacy DB-only — that
      // would write rows to a DB index whose fence is broken.
      continue;
    }
    if (result.stubGuardBlocked) {
      // v0.34.5: writeFactsToFence refused to spawn a phantom
      // unprefixed entity page (e.g. `jared.md` at brain root).
      // Route these facts to the legacy DB-only path so they
      // aren't dropped — the slug stays attached but no markdown
      // file is created.
      for (const { f } of group) {
        const newFact: NewFact = {
          fact: f.fact,
          kind: f.kind,
          entity_slug: slug,
          visibility,
          notability: f.notability,
          source: f.source,
          source_session: f.source_session ?? null,
          confidence: f.confidence,
          embedding: f.embedding ?? null,
        };
        const legacyResult = await ctx.engine.insertFact(newFact, { source_id: ctx.sourceId }); // gbrain-allow-direct-insert: stub-guard fallback for unprefixed entity slugs (no fenceable page)
        fact_ids.push(legacyResult.id);
        if (legacyResult.status === 'inserted') inserted += 1;
        else if ((legacyResult.status as FactInsertStatus) === 'duplicate') duplicate += 1;
        else superseded += 1;
      }
      continue;
    }
    if (result.legacyFallback) {
      // Defensive: writeFactsToFence sees localPath as null. We
      // checked above so this shouldn't fire — log loud + skip.
      warnOnce(
        'facts:fence-write-unexpected-fallback',
        `[facts] writeFactsToFence returned legacyFallback for slug=${slug} despite localPath being set — investigation needed.`,
      );
      continue;
    }

    inserted += result.inserted;
    fact_ids.push(...result.ids);
  }

  return { inserted, duplicate, superseded, fact_ids };
}
