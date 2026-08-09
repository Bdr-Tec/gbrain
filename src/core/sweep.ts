/**
 * Serve-resident maintenance sweep [CX-P0.1, CX-P0.3, CX2-4].
 *
 * Nothing previously ingested the transcript corpus into a live brain
 * (dream is disabled by default; the CLI can't open PGLite under a live
 * serve), and remote `put_page` deliberately skips auto link/timeline
 * extraction — so the graph never compounded from harness writes. The
 * sweep is the serve process's (the lock owner's) bounded, spend-gated
 * answer. Three passes, each individually fail-soft:
 *
 *   1. FACTS-FENCE RECONCILIATION [CX2-4] — zero-LLM. Recently-modified
 *      pages carrying a `## Facts` fence get reconciled into the facts DB
 *      index by the SAME cycle extractor the dream cycle uses
 *      (src/core/cycle/extract-facts.ts:runExtractFacts, scoped via
 *      opts.slugs). Fence rows carry explicit per-row visibility; the
 *      corpus pass below resolves unset visibility through
 *      resolveDefaultVisibility inside the shared pipeline (backstop.ts).
 *
 *   2. LINK/TIMELINE EXTRACTION [CX-P0.3] — zero-LLM, deterministic. The
 *      same per-page cores `gbrain extract links|timeline --source db`
 *      runs: extractPageLinks + parseTimelineEntries, endpoint-validated
 *      through resolveCandidateSources and batch-written via
 *      addLinksBatch / addTimelineEntriesBatch, then watermark-stamped
 *      (stampExtracted) since both kinds ran.
 *
 *   3. CORPUS INGEST [CX-P0.1] — LLM-backed, spend-gated. Unprocessed
 *      `.txt` files in the dream corpus dir run through the narrowest
 *      one-transcript entry (runFactsPipeline: extract → resolve → dedup
 *      → insert). KEYLESS RULE [CX-P0.5]: no extraction provider ⇒ skip
 *      with {reason:'keyless'} — agent-authored fences cover it. A
 *      `<file>.ingested` sidecar (written AFTER success — crash-safe,
 *      exactly-once) marks completion.
 *
 * Budget: a wall-clock budget aborts BETWEEN items (and threads an
 * AbortSignal into the fence pass + corpus extraction); the report
 * carries the partial counts. runMaintenanceSweep NEVER throws.
 *
 * Heavy dependencies (cycle extractor, extract command cores, facts
 * pipeline, gateway) are lazy-imported inside each pass — the
 * backstop.ts:335 precedent — so importing this module at serve boot is
 * cheap and a broken optional dep degrades to a skip, never a crash.
 */

import { join } from 'node:path';
import type { BrainEngine, LinkBatchInput, TimelineBatchInput } from './engine.ts';
import type { FactsBackstopCtx } from './facts/backstop.ts';
import { detectCapabilities, type CapabilityReport } from './capability.ts';

/** Delay before the serve-startup sweep fires (post-connect settle). */
export const STARTUP_SWEEP_DELAY_MS = 3_000;

/** Fence begin marker — duplicated from facts-fence.ts to keep this module light. */
const FACTS_FENCE_BEGIN_MARKER = 'gbrain:facts:begin';

/** Sidecar suffix marking a corpus file as processed. */
export const CORPUS_INGESTED_SUFFIX = '.ingested';

export interface SweepOpts {
  /** Source to sweep. Default 'default' (the serve's registered source). */
  sourceId?: string;
  /** Max pages per pass / corpus files per sweep. Default 20. */
  batchLimit?: number;
  /** Wall-clock budget; the sweep stops between items when exceeded. Default 5000. */
  budgetMs?: number;
  /** Recency window (days) for "recently-modified pages". Default 7. */
  recentDays?: number;
  /** Diagnostic sink (stderr in serve contexts). Default: silent. */
  log?: (msg: string) => void;
  /**
   * Capability report override (test seam / caller already computed one).
   * Default: detectCapabilities() — config-plane, no network.
   */
  capabilities?: CapabilityReport;
}

export interface SweepSkip {
  reason: string;
  count: number;
}

export interface SweepReport {
  corpusIngested: number;
  factsReconciled: number;
  linksExtracted: number;
  timelineExtracted: number;
  skipped: SweepSkip[];
  durationMs: number;
}

/**
 * Run one bounded maintenance sweep. Never throws — failures land in
 * report.skipped with a per-pass reason.
 */
export async function runMaintenanceSweep(
  engine: BrainEngine,
  opts: SweepOpts = {},
): Promise<SweepReport> {
  const started = Date.now();
  const sourceId = opts.sourceId ?? 'default';
  const batchLimit = Math.max(1, opts.batchLimit ?? 20);
  const budgetMs = Math.max(0, opts.budgetMs ?? 5_000);
  const recentDays = Math.max(1, opts.recentDays ?? 7);
  const log = opts.log ?? (() => {});
  const deadline = started + budgetMs;

  const report: SweepReport = {
    corpusIngested: 0,
    factsReconciled: 0,
    linksExtracted: 0,
    timelineExtracted: 0,
    skipped: [],
    durationMs: 0,
  };

  const skip = (reason: string, count = 1): void => {
    if (count <= 0) return;
    const existing = report.skipped.find(s => s.reason === reason);
    if (existing) existing.count += count;
    else report.skipped.push({ reason, count });
  };
  const overBudget = () => Date.now() >= deadline;

  // Budget abort signal: threads into the fence pass's per-page loop and
  // the corpus extraction's network call so a long item can be interrupted
  // at its own checkpoints. unref'd — the sweep must never hold the
  // process open (the serve unref convention).
  const budgetController = new AbortController();
  const budgetTimer = setTimeout(
    () => budgetController.abort(),
    Math.max(0, deadline - Date.now()),
  );
  budgetTimer.unref?.();

  const cutoffIso = new Date(started - recentDays * 86_400_000).toISOString();

  try {
    // ── Pass 1: facts-fence reconciliation [CX2-4] — zero-LLM ─────────
    try {
      if (overBudget()) {
        skip('budget_exhausted:facts_fence');
      } else {
        const rows = await engine.executeRaw<{ slug: string }>(
          `SELECT slug FROM pages
            WHERE source_id = $1
              AND deleted_at IS NULL
              AND updated_at >= $2::timestamptz
              AND compiled_truth LIKE $3
            ORDER BY updated_at DESC
            LIMIT $4`,
          [sourceId, cutoffIso, `%${FACTS_FENCE_BEGIN_MARKER}%`, batchLimit],
        );
        if (rows.length > 0) {
          const { runExtractFacts } = await import('./cycle/extract-facts.ts');
          const r = await runExtractFacts(engine, {
            slugs: rows.map(row => row.slug),
            sourceId,
            signal: budgetController.signal,
          });
          report.factsReconciled = r.factsInserted;
          if (r.guardTriggered) skip('facts_fence_guard');
          if (budgetController.signal.aborted) skip('budget_exhausted:facts_fence');
        }
      }
    } catch (e) {
      skip('facts_fence_error');
      log(`[sweep] facts-fence pass failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── Pass 2: link/timeline extraction [CX-P0.3] — zero-LLM ─────────
    try {
      if (overBudget()) {
        skip('budget_exhausted:links_timeline');
      } else {
        await runLinksTimelinePass(engine, {
          sourceId,
          batchLimit,
          cutoffIso,
          overBudget,
          report,
          skip,
        });
      }
    } catch (e) {
      skip('links_timeline_error');
      log(`[sweep] links/timeline pass failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── Pass 3: corpus ingest [CX-P0.1] — spend-gated [CX-P0.5] ───────
    try {
      if (overBudget()) {
        skip('budget_exhausted:corpus');
      } else {
        await runCorpusIngestPass(engine, {
          sourceId,
          batchLimit,
          overBudget,
          signal: budgetController.signal,
          capabilities: opts.capabilities,
          report,
          skip,
          log,
        });
      }
    } catch (e) {
      skip('corpus_error');
      log(`[sweep] corpus pass failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (e) {
    // Structural failure outside every per-pass catch (should be
    // unreachable). The never-throw contract holds regardless.
    skip('sweep_error');
    log(`[sweep] sweep failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(budgetTimer);
  }

  report.durationMs = Date.now() - started;
  return report;
}

interface PassCtx {
  sourceId: string;
  batchLimit: number;
  overBudget: () => boolean;
  report: SweepReport;
  skip: (reason: string, count?: number) => void;
}

/**
 * Pass 2 body. Calls the SAME per-page cores as `gbrain extract
 * links|timeline --source db` (extract.ts:extractLinksFromDB /
 * extractTimelineFromDB): extractPageLinks + parseTimelineEntries, with
 * resolveCandidateSources doing the multi-source endpoint validation and
 * stampExtracted advancing the links_extracted_at watermark (both kinds
 * run here, so stamping is correct per extract.ts's C3/D6 rule).
 */
async function runLinksTimelinePass(
  engine: BrainEngine,
  ctx: PassCtx & { cutoffIso: string },
): Promise<void> {
  const { sourceId, batchLimit, cutoffIso, overBudget, report, skip } = ctx;

  const {
    extractPageLinks,
    parseTimelineEntries,
    makeResolver,
    isGlobalBasenameEnabled,
    isAutoLinkEnabled,
    isAutoTimelineEnabled,
  } = await import('./link-extraction.ts');

  // Respect the same operator kill switches put_page's inline hooks honor.
  const [linksEnabled, timelineEnabled] = await Promise.all([
    isAutoLinkEnabled(engine),
    isAutoTimelineEnabled(engine),
  ]);
  if (!linksEnabled) skip('auto_link_disabled');
  if (!timelineEnabled) skip('auto_timeline_disabled');
  if (!linksEnabled && !timelineEnabled) return;

  const recent = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND updated_at >= $2::timestamptz
      ORDER BY updated_at DESC
      LIMIT $3`,
    [sourceId, cutoffIso, batchLimit],
  );
  if (recent.length === 0) return;

  // resolveCandidateSources + stampExtracted are the shared helpers the
  // extract command exports precisely so sibling walkers can't drift from
  // its F10 multi-source resolution (see extract.ts:114).
  const { resolveCandidateSources, stampExtracted } = await import('../commands/extract.ts');

  const resolver = makeResolver(engine, { mode: 'batch', sourceId });
  const globalBasename = await isGlobalBasenameEnabled(engine);

  // Full (slug, source_id) map so cross-source wikilinks resolve the same
  // way extractLinksFromDB's fullRefsForResolver does.
  const allRefs = await engine.listAllPageRefs();
  const allSlugs = new Set<string>();
  const slugToSources = new Map<string, string[]>();
  for (const ref of allRefs) {
    allSlugs.add(ref.slug);
    const list = slugToSources.get(ref.slug) ?? [];
    list.push(ref.source_id);
    slugToSources.set(ref.slug, list);
  }

  const linkBatch: LinkBatchInput[] = [];
  const tlBatch: TimelineBatchInput[] = [];
  const processedRefs: Array<{ slug: string; source_id: string }> = [];

  for (let i = 0; i < recent.length; i++) {
    if (overBudget()) {
      skip('budget_exhausted:links_timeline', recent.length - i);
      break;
    }
    const slug = recent[i].slug;
    const page = await engine.getPage(slug, { sourceId });
    if (!page) continue;

    const fullContent = page.compiled_truth + '\n' + page.timeline;

    if (linksEnabled) {
      // skipFrontmatter matches user-invoked `gbrain extract links`
      // (frontmatter backfill stays a migration-orchestrator concern).
      const extracted = await extractPageLinks(
        slug, fullContent, page.frontmatter, page.type, resolver,
        { skipFrontmatter: true, globalBasename },
      );
      for (const c of extracted.candidates) {
        const resolved = resolveCandidateSources(c, slug, sourceId, allSlugs, slugToSources);
        if (!resolved) continue;
        linkBatch.push({
          from_slug: resolved.fromSlug,
          to_slug: c.targetSlug,
          link_type: c.linkType,
          context: c.context,
          link_source: c.linkSource,
          origin_slug: c.originSlug,
          origin_field: c.originField,
          from_source_id: resolved.fromSourceId,
          to_source_id: resolved.toSourceId,
          origin_source_id: sourceId,
        });
      }
    }

    if (timelineEnabled) {
      for (const entry of parseTimelineEntries(fullContent)) {
        // Same row shape as extractTimelineFromDB's batch push (extract.ts):
        // no explicit source (engine default applies), detail '' when empty.
        tlBatch.push({
          slug,
          date: entry.date,
          summary: entry.summary,
          detail: entry.detail || '',
          source_id: sourceId,
        });
      }
    }

    processedRefs.push({ slug, source_id: sourceId });
  }

  // Engine batch primitives self-retry; default auditSite labels apply
  // (BATCH_AUDIT_SITES is a closed enum owned by retry.ts).
  if (linkBatch.length > 0) {
    report.linksExtracted += await engine.addLinksBatch(linkBatch); // gbrain-allow-direct-insert: the sweep IS the extract path for workspace pages — remote put_page skips extraction by design [CX-P0.3]
  }
  if (tlBatch.length > 0) {
    report.timelineExtracted += await engine.addTimelineEntriesBatch(tlBatch); // gbrain-allow-direct-insert: same extract-path rationale as addLinksBatch above [CX-P0.3]
  }
  // Stamp only when BOTH kinds ran for these pages (extract.ts C3/D6:
  // links_extracted_at covers links AND timeline).
  if (linksEnabled && timelineEnabled && processedRefs.length > 0) {
    await stampExtracted(engine, processedRefs);
  }
}

/**
 * Pass 3 body. One `runFactsPipeline` call per unprocessed corpus file —
 * the narrowest existing entry that takes raw transcript text through
 * extract → resolve → dedup → insert. Visibility left unset so the
 * pipeline resolves the operator default via resolveDefaultVisibility
 * (backstop.ts:359, [ENG-8]). Sidecar written AFTER success only.
 */
async function runCorpusIngestPass(
  engine: BrainEngine,
  ctx: PassCtx & {
    signal: AbortSignal;
    capabilities?: CapabilityReport;
    log: (msg: string) => void;
  },
): Promise<void> {
  const { sourceId, batchLimit, overBudget, signal, report, skip, log } = ctx;
  const { readdirSync, readFileSync, writeFileSync, existsSync } = await import('node:fs');

  // Corpus dir: dream's session corpus (transcripts.ts:66 precedent);
  // default ~/.gbrain/transcripts/corpus (GBRAIN_HOME-aware via configDir).
  let dir = await engine.getConfig('dream.synthesize.session_corpus_dir');
  if (!dir) {
    const { configDir } = await import('./config.ts');
    dir = join(configDir(), 'transcripts', 'corpus');
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // no corpus dir = nothing to ingest (not an error)
  }

  const txtFiles = entries.filter(n => n.endsWith('.txt')).sort();
  if (txtFiles.length === 0) return;

  const alreadyIngested = txtFiles.filter(n =>
    existsSync(join(dir, n + CORPUS_INGESTED_SUFFIX)),
  );
  skip('already_ingested', alreadyIngested.length);

  const candidates = txtFiles
    .filter(n => !existsSync(join(dir, n + CORPUS_INGESTED_SUFFIX)))
    .slice(0, batchLimit);
  if (candidates.length === 0) return;

  // [CX-P0.5] Keyless rule: no extraction provider configured ⇒ skip the
  // whole pass. Agent-authored fences (pass 1) carry keyless memory.
  const caps = ctx.capabilities ?? detectCapabilities();
  if (!caps.extraction.available) {
    skip('keyless', candidates.length);
    return;
  }

  // Existing spend gate: operators flip facts.extraction_enabled off to
  // stop ALL fact extraction brain-wide (facts/extract.ts:43).
  const { isFactsExtractionEnabled } = await import('./facts/extract.ts');
  if (!(await isFactsExtractionEnabled(engine))) {
    skip('extraction_disabled', candidates.length);
    return;
  }

  const { runFactsPipeline } = await import('./facts/backstop.ts');
  const { isDreamOutput } = await import('./cycle/transcript-discovery.ts');

  for (let i = 0; i < candidates.length; i++) {
    if (overBudget()) {
      skip('budget_exhausted:corpus', candidates.length - i);
      break;
    }
    const name = candidates[i];
    const full = join(dir, name);
    try {
      const raw = readFileSync(full, 'utf-8');

      // Anti-loop: never ingest dream-generated outputs. Marking them
      // processed is safe — the classification is deterministic and
      // permanent, and the sidecar stops the sweep re-reading them forever.
      if (isDreamOutput(raw)) {
        writeFileSync(
          full + CORPUS_INGESTED_SUFFIX,
          JSON.stringify({ ingested_at: new Date().toISOString(), skipped: 'dream_output' }) + '\n',
        );
        skip('dream_output');
        continue;
      }

      const r = await runFactsPipeline(raw, {
        engine,
        sourceId,
        sessionId: `sweep:corpus:${name}`,
        // Provenance tag outside FactsBackstopCtx's enumerated writers —
        // facts.source is free text at the DB layer; the cast only
        // side-steps the ctx union, which predates the sweep.
        source: 'sweep:corpus' as FactsBackstopCtx['source'],
        mode: 'inline',
        remote: false,
        abortSignal: signal,
        // visibility deliberately unset → resolveDefaultVisibility [ENG-8]
      });

      // Sidecar AFTER success — a crash before this line re-processes the
      // file next sweep (dedup absorbs the repeats), never loses it.
      writeFileSync(
        full + CORPUS_INGESTED_SUFFIX,
        JSON.stringify({
          ingested_at: new Date().toISOString(),
          facts_inserted: r.inserted,
          facts_duplicate: r.duplicate,
        }) + '\n',
      );
      report.corpusIngested += 1;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        skip('budget_exhausted:corpus', candidates.length - i);
        break;
      }
      skip('corpus_file_error');
      log(`[sweep] corpus ingest failed for ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ── Serve-startup arming [ENG-5] ─────────────────────────────────────────

export interface StartupSweepOpts {
  /** Post-connect settle delay. Default STARTUP_SWEEP_DELAY_MS (3s). */
  delayMs?: number;
  /** Source to sweep. Default 'default'. */
  sourceId?: string;
  /** Env for the GBRAIN_SWEEP kill switch. Default process.env. */
  env?: Record<string, string | undefined>;
  /** Timer seams (tests). Defaults: global setTimeout/clearTimeout. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Sweep body override (tests). Default: runMaintenanceSweep. */
  sweep?: (engine: BrainEngine) => Promise<unknown>;
}

/**
 * Arm the one-shot startup sweep for a serve process. Returns a cancel
 * handle for shutdown, or null when the GBRAIN_SWEEP=0 kill switch is set.
 * The timer is unref'd (never holds the process open) and the sweep body
 * swallows every error — best-effort by construction, same posture as the
 * resolve-IPC block in src/mcp/server.ts.
 */
export function armStartupSweep(
  engine: BrainEngine,
  opts: StartupSweepOpts = {},
): { cancel: () => void } | null {
  const env = opts.env ?? process.env;
  if (env.GBRAIN_SWEEP === '0') return null;

  const setT = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = opts.clearTimeoutFn
    ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const run = opts.sweep
    ?? ((e: BrainEngine) => runMaintenanceSweep(e, { sourceId: opts.sourceId }));

  const handle = setT(() => {
    Promise.resolve()
      .then(() => run(engine))
      .catch(() => { /* startup sweep is best-effort; never crash serve */ });
  }, opts.delayMs ?? STARTUP_SWEEP_DELAY_MS);
  (handle as { unref?: () => void } | null)?.unref?.();

  return {
    cancel: () => {
      try { clearT(handle); } catch { /* noop */ }
    },
  };
}
