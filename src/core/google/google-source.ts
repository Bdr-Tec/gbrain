/**
 * google-source — Gmail/Calendar/Contacts sync for the `google` source kind.
 *
 * Mirrors the github source kind (github-source.ts): a source registered
 * with kind=google is API-backed, not git-backed. Threads, events, and
 * contacts materialize as markdown under the source's managed dir and flow
 * through the standard import pipeline (chunks, embeds, aliases, links).
 *
 * Sweep order: contacts → calendar → gmail — alias rows must exist before
 * the loop detector resolves counterparties.
 *
 * Cursor discipline (per service, independent):
 *  - contacts / calendar: syncToken committed only after that service's
 *    fully-successful sweep; 410 GONE drops the token and re-runs windowed.
 *  - gmail delta: history.list from gmail_history_id; 404 (expired, ~1 week)
 *    falls back to a bookmark-windowed messages.list, then re-anchors.
 *  - gmail INITIAL BACKFILL is explicitly resumable (outside-voice F7a): the
 *    window is drained newest→oldest with a floor cursor persisted per
 *    batch, so a killed 50k-message backfill resumes at the floor instead of
 *    restarting. historyId is captured BEFORE the backfill starts, so the
 *    delta lane takes over with zero gap (overlap re-renders are idempotent).
 *
 * Credentials come from the vault (gbrain google connect) — never from
 * sources.config, which stores only the account pointer.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { CredentialError, isCredentialError } from '../creds/errors.ts';
import { GOOGLE_PROVIDER, GoogleTokenProvider } from '../creds/providers/google.ts';
import { credentialId, openVault, type CredentialEntry, type CredentialVault } from '../creds/vault.ts';
import { createProgress, startHeartbeat } from '../progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../cli-options.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import {
  CalendarClient,
  GmailClient,
  GoogleCursorExpiredError,
  PeopleClient,
  type FetchImpl,
} from './google-clients.ts';
import {
  calendarRelPath,
  personSlugFromContact,
  renderCalendarEventPage,
  renderPersonPage,
  renderThreadPage,
} from './google-render.ts';
import {
  ALL_GOOGLE_SERVICES,
  type GmailThreadData,
  type GoogleService,
  type GoogleSourceConfig,
  type GoogleSourceState,
} from './types.ts';
import { LOOPS_EXTRACT_WINDOW_DAYS } from './loops-extract.ts';

export type { GoogleSourceConfig } from './types.ts';

// ── Config ───────────────────────────────────────────────────────────────────

const G_KIND = 'google';

export function isGoogleSourceConfig(config: Record<string, unknown>): boolean {
  return config.kind === G_KIND;
}

export function parseGoogleSourceConfig(
  config: Record<string, unknown>,
  fallbackDir: string,
): GoogleSourceConfig {
  const account =
    typeof config.g_account === 'string' ? config.g_account.trim().toLowerCase() : '';
  const services =
    typeof config.g_services === 'string'
      ? (config.g_services
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter((s): s is GoogleService => (ALL_GOOGLE_SERVICES as string[]).includes(s)))
      : [...ALL_GOOGLE_SERVICES];
  const historyDays =
    typeof config.g_history_days === 'number' &&
    Number.isFinite(config.g_history_days) &&
    config.g_history_days > 0
      ? Math.min(3650, Math.floor(config.g_history_days))
      : 90;
  const dir =
    typeof config.g_dir === 'string' && config.g_dir.length > 0 ? config.g_dir : fallbackDir;
  return { account, services: services.length > 0 ? services : [...ALL_GOOGLE_SERVICES], historyDays, dir };
}

// ── State ────────────────────────────────────────────────────────────────────

export function googleStateFile(dir: string): string {
  return join(dir, '.google-source.json');
}

function emptyState(): GoogleSourceState {
  return {
    gmail_history_id: null,
    gmail_backfill_floor_ms: null,
    gmail_backfill_done: false,
    gmail_newest_ms: null,
    calendar_sync_token: null,
    contacts_sync_token: null,
    last_full_at: null,
  };
}

export function readGoogleState(dir: string): GoogleSourceState {
  try {
    const parsed = JSON.parse(readFileSync(googleStateFile(dir), 'utf-8')) as Partial<GoogleSourceState>;
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

function writeGoogleState(dir: string, state: GoogleSourceState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(googleStateFile(dir), JSON.stringify(state, null, 2), 'utf-8');
}

/** The "my addresses" identity set: account + Gmail sendAs aliases. */
export function myAddressSet(entry: CredentialEntry): Set<string> {
  const out = new Set<string>();
  if (entry.meta.account) out.add(entry.meta.account.toLowerCase());
  for (const a of entry.meta.sendas_aliases ?? []) out.add(a.toLowerCase());
  return out;
}

// ── Sync runner ──────────────────────────────────────────────────────────────

interface GoogleSyncSummary {
  status: 'synced' | 'up_to_date' | 'first_sync' | 'partial';
  added: number;
  modified: number;
  deleted: number;
  chunksCreated: number;
  embedded: number;
  pagesAffected: string[];
  threadsSeen: number;
  failedFiles: number;
}

interface GoogleSyncDeps {
  engine: BrainEngine;
  sourceId: string;
  cfg: GoogleSourceConfig;
  opts: SyncOpts;
  vault: CredentialVault;
  entry: CredentialEntry;
  log: (msg: string) => void;
  /** Threads whose newest message falls in the recent window — LLM
   *  extraction candidates, enqueued (capped) after the sweep. */
  extractCandidates: Array<{ slug: string; threadId: string; newestMs: number }>;
}

type ActivePack = { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> } | undefined;

function assertContained(dir: string, path: string): void {
  if (!isWriteTargetContained(path, dir)) {
    throw new Error(`Path escapes managed dir: "${path}"`);
  }
}

async function importRendered(
  deps: GoogleSyncDeps,
  relPath: string,
  markdown: string,
  activePack: ActivePack,
  summary: GoogleSyncSummary,
  countedSlugs: Set<string>,
): Promise<string> {
  const filePath = join(deps.cfg.dir, relPath);
  assertContained(deps.cfg.dir, filePath);
  mkdirSync(dirname(filePath), { recursive: true });
  const before = existsSync(filePath);
  // Temp-write → import → rename: a failed import never destroys the
  // previously-good page (github-source pattern).
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, markdown, 'utf-8');
  try {
    const { importFile } = await import('../import-file.ts');
    const result = await importFile(deps.engine, tmpPath, relPath, {
      noEmbed: true, // embeds handled by the size gate below, like sync
      sourceId: deps.sourceId,
      ...(activePack ? { activePack } : {}),
    });
    if (result.status === 'error' || result.error) {
      throw new Error(result.error ?? `Import failed for ${relPath}`);
    }
    renameSync(tmpPath, filePath);
    if (result.status === 'imported') {
      summary.pagesAffected.push(result.slug);
      summary.chunksCreated += result.chunks;
      if (!countedSlugs.has(result.slug)) {
        if (before) summary.modified++;
        else summary.added++;
        countedSlugs.add(result.slug);
      }
    }
    return result.slug;
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

async function deletePageByRelPath(
  deps: GoogleSyncDeps,
  relPath: string,
  summary: GoogleSyncSummary,
): Promise<void> {
  const rows = await deps.engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND source_path = $2 AND deleted_at IS NULL`,
    [deps.sourceId, relPath],
  );
  if (rows.length > 0) {
    await deps.engine.deletePages(rows.map((r) => r.slug), { sourceId: deps.sourceId });
    summary.deleted += rows.length;
  }
  rmSync(join(deps.cfg.dir, relPath), { force: true });
}

// ── Contacts sweep ───────────────────────────────────────────────────────────

async function sweepContacts(
  deps: GoogleSyncDeps,
  people: PeopleClient,
  state: GoogleSourceState,
  activePack: ActivePack,
  summary: GoogleSyncSummary,
  countedSlugs: Set<string>,
): Promise<void> {
  let result;
  try {
    result = await people.listConnections({
      syncToken: deps.opts.full ? null : state.contacts_sync_token,
      ...(deps.opts.signal ? { signal: deps.opts.signal } : {}),
    });
  } catch (e) {
    if (e instanceof GoogleCursorExpiredError) {
      deps.log('[google] contacts syncToken expired; full re-list');
      state.contacts_sync_token = null;
      result = await people.listConnections({ syncToken: null, ...(deps.opts.signal ? { signal: deps.opts.signal } : {}) });
    } else {
      throw e;
    }
  }
  for (const c of result.contacts) {
    if (deps.opts.signal?.aborted) return;
    const slug = personSlugFromContact(c);
    if (!slug) continue;
    const relPath = `${slug}.md`;
    if (c.deleted) {
      await deletePageByRelPath(deps, relPath, summary);
      continue;
    }
    const rendered = renderPersonPage(c);
    if (!rendered) continue;
    // Ownership guard: a page at this path that the connector did not write
    // (no google_contact_id marker) is never rewritten — hand-authored person
    // pages keep their body; the alias projection comes from OUR pages only.
    const filePath = join(deps.cfg.dir, rendered.relPath);
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf-8');
      if (!existing.includes('google_contact_id:')) {
        deps.log(`[google] skipping hand-authored ${rendered.relPath}`);
        continue;
      }
    }
    await importRendered(deps, rendered.relPath, rendered.markdown, activePack, summary, countedSlugs);
  }
  // Cursor commits only after the whole sweep succeeded.
  if (result.nextSyncToken) state.contacts_sync_token = result.nextSyncToken;
}

// ── Calendar sweep ───────────────────────────────────────────────────────────

async function sweepCalendar(
  deps: GoogleSyncDeps,
  calendar: CalendarClient,
  state: GoogleSourceState,
  activePack: ActivePack,
  summary: GoogleSyncSummary,
  countedSlugs: Set<string>,
): Promise<void> {
  const now = Date.now();
  const windowOpts = {
    timeMinIso: new Date(now - deps.cfg.historyDays * 86_400_000).toISOString(),
    timeMaxIso: new Date(now + 60 * 86_400_000).toISOString(),
  };
  let result;
  try {
    result = await calendar.listEvents(deps.cfg.account, {
      ...(deps.opts.full || !state.calendar_sync_token ? windowOpts : { syncToken: state.calendar_sync_token }),
      ...(deps.opts.signal ? { signal: deps.opts.signal } : {}),
    });
  } catch (e) {
    if (e instanceof GoogleCursorExpiredError) {
      deps.log('[google] calendar syncToken expired; windowed re-list');
      state.calendar_sync_token = null;
      result = await calendar.listEvents(deps.cfg.account, {
        ...windowOpts,
        ...(deps.opts.signal ? { signal: deps.opts.signal } : {}),
      });
    } else {
      throw e;
    }
  }
  for (const ev of result.events) {
    if (deps.opts.signal?.aborted) return;
    const rendered = renderCalendarEventPage(ev);
    if (!rendered) {
      // Cancelled instance → remove its page if one exists.
      await deletePageByRelPath(deps, calendarRelPath(ev), summary);
      continue;
    }
    await importRendered(deps, rendered.relPath, rendered.markdown, activePack, summary, countedSlugs);
  }
  if (result.nextSyncToken) state.calendar_sync_token = result.nextSyncToken;
}

// ── Gmail sweep ──────────────────────────────────────────────────────────────

const BACKFILL_BATCH_THREADS = 25;

async function processThread(
  deps: GoogleSyncDeps,
  gmail: GmailClient,
  threadId: string,
  activePack: ActivePack,
  summary: GoogleSyncSummary,
  countedSlugs: Set<string>,
): Promise<GmailThreadData | null> {
  const thread = await gmail.getThread(threadId, deps.cfg.account, {
    ...(deps.opts.signal ? { signal: deps.opts.signal } : {}),
  });
  summary.threadsSeen++;
  const rendered = renderThreadPage(thread);
  if (!rendered) return thread; // pure noise — detector still sees it for closes
  const slug = await importRendered(deps, rendered.relPath, rendered.markdown, activePack, summary, countedSlugs);
  await applyLoopDetection(deps, thread, slug);
  // LLM extraction candidates: trickle + the bounded recent window only —
  // the deep historical backfill is never extracted (spend honesty, F9).
  const newestMs = thread.messages[thread.messages.length - 1]?.internalDateMs ?? 0;
  const windowMs = LOOPS_EXTRACT_WINDOW_DAYS * 86_400_000;
  if (newestMs > 0 && Date.now() - newestMs <= windowMs) {
    deps.extractCandidates.push({ slug, threadId: thread.threadId, newestMs });
  }
  return thread;
}

/** Enqueue capped loops_extract jobs for this sweep's candidates. */
async function enqueueLoopsExtraction(deps: GoogleSyncDeps): Promise<void> {
  if (deps.extractCandidates.length === 0) return;
  try {
    const { isLoopsExtractionEnabled, LOOPS_EXTRACT_JOB, LOOPS_EXTRACT_MAX_PER_SWEEP } = await import('./loops-extract.ts');
    if (!(await isLoopsExtractionEnabled(deps.engine))) return;
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(deps.engine);
    // Newest first: the freshest threads carry the most actionable loops.
    const picked = [...deps.extractCandidates]
      .sort((a, b) => b.newestMs - a.newestMs)
      .slice(0, LOOPS_EXTRACT_MAX_PER_SWEEP);
    const dropped = deps.extractCandidates.length - picked.length;
    if (dropped > 0) {
      deps.log(`[google] loops_extract cap: enqueuing ${picked.length}, deferring ${dropped} (they re-candidate on next touch)`);
    }
    for (const c of picked) {
      await queue.add(
        LOOPS_EXTRACT_JOB,
        { slug: c.slug, sourceId: deps.sourceId, threadId: c.threadId },
        {
          priority: 5,
          // Page-revision keyed: a re-sweep of an unchanged thread is a no-op.
          idempotency_key: `loops:${c.slug}:${c.newestMs}`,
          maxWaiting: LOOPS_EXTRACT_MAX_PER_SWEEP * 2,
        },
      );
    }
  } catch (e) {
    deps.log(`[google] loops_extract enqueue failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Loop detection hook — wired to loop-detect.ts (Phase 4); tolerant when absent. */
async function applyLoopDetection(
  deps: GoogleSyncDeps,
  thread: GmailThreadData,
  pageSlug: string,
): Promise<void> {
  try {
    const { applyThreadLoopVerdict } = await import('./loop-detect.ts');
    await applyThreadLoopVerdict(deps.engine, deps.sourceId, thread, myAddressSet(deps.entry), pageSlug);
  } catch (e) {
    // Detection must never fail a sync; it re-runs on the next touch.
    deps.log(`[google] loop detection failed for ${thread.threadId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function sweepGmail(
  deps: GoogleSyncDeps,
  gmail: GmailClient,
  state: GoogleSourceState,
  activePack: ActivePack,
  summary: GoogleSyncSummary,
  countedSlugs: Set<string>,
  progressTick: (note: string) => void,
): Promise<void> {
  const nowMs = Date.now();
  const cutoffMs = nowMs - deps.cfg.historyDays * 86_400_000;

  // ── Initial (or resumed) backfill ──
  if (!state.gmail_backfill_done) {
    // Anchor the delta lane BEFORE importing anything: changes that land
    // during the backfill are replayed by history.list afterwards.
    if (!state.gmail_history_id) {
      const profile = await gmail.getProfile({ ...(deps.opts.signal ? { signal: deps.opts.signal } : {}) });
      if (profile.emailAddress.toLowerCase() !== deps.cfg.account) {
        deps.log(`[google] warning: token account ${profile.emailAddress} != source account ${deps.cfg.account}`);
      }
      state.gmail_history_id = profile.historyId;
      writeGoogleState(deps.cfg.dir, state);
    }
    let floorMs = state.gmail_backfill_floor_ms ?? nowMs + 60_000;
    for (;;) {
      if (deps.opts.signal?.aborted) return;
      const q = `after:${Math.floor(cutoffMs / 1000)} before:${Math.ceil(floorMs / 1000)}`;
      const ids = await gmail.listMessageIds(q, { ...(deps.opts.signal ? { signal: deps.opts.signal } : {}) });
      if (ids.length === 0) break;
      // Newest-first listing → unique threads in newest-first order.
      const threadIds = [...new Set(ids.map((m) => m.threadId))];
      let processedAny = false;
      let batchFailed = false;
      let batchOldest = floorMs;
      for (let i = 0; i < threadIds.length; i += BACKFILL_BATCH_THREADS) {
        if (deps.opts.signal?.aborted) break;
        const batch = threadIds.slice(i, i + BACKFILL_BATCH_THREADS);
        for (const tid of batch) {
          if (deps.opts.signal?.aborted) break;
          try {
            const thread = await processThread(deps, gmail, tid, activePack, summary, countedSlugs);
            processedAny = true;
            const newest = thread?.messages[thread.messages.length - 1]?.internalDateMs ?? 0;
            if (newest > 0 && newest < batchOldest) batchOldest = newest;
            if (newest > (state.gmail_newest_ms ?? 0)) state.gmail_newest_ms = newest;
            progressTick(`thread ${tid}`);
          } catch (e) {
            if (e instanceof GoogleCursorExpiredError && e.status === 404) {
              // Thread deleted between listing and fetch — gone is gone.
              // Skipping (not failing) keeps the cursor moving; --full
              // reconcile removes any page it left behind.
              deps.log(`[google] thread ${tid} vanished (404); skipping`);
              progressTick(`thread ${tid} gone`);
              continue;
            }
            batchFailed = true;
            summary.failedFiles++;
            summary.status = 'partial';
            deps.log(`[google] thread ${tid} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        // Monotone forward progress: the floor commits per FULLY-SUCCESSFUL
        // batch. A batch with any failure must NOT advance the floor — a
        // failed thread NEWER than a committed floor would fall outside the
        // resume window (`before:floor`) forever, and the delta lane can't
        // replay it either (its messages predate the history anchor).
        if (batchFailed) break;
        if (processedAny && batchOldest < floorMs) {
          state.gmail_backfill_floor_ms = batchOldest;
          writeGoogleState(deps.cfg.dir, state);
        }
      }
      if (deps.opts.signal?.aborted) return;
      if (batchFailed) {
        // Leave the floor at the last good batch; the next run re-lists from
        // there and retries the failed thread first.
        return;
      }
      if (!processedAny || batchOldest >= floorMs) {
        // Nothing moved the floor (all skipped/vanished or all
        // same-timestamp): step below the oldest listed page to guarantee
        // termination. Only reachable with zero failures.
        state.gmail_backfill_floor_ms = Math.max(cutoffMs - 1, floorMs - 86_400_000);
        writeGoogleState(deps.cfg.dir, state);
      }
      floorMs = state.gmail_backfill_floor_ms ?? cutoffMs;
      if (floorMs <= cutoffMs) break;
    }
    if (summary.failedFiles === 0) {
      state.gmail_backfill_done = true;
      state.gmail_backfill_floor_ms = null;
      writeGoogleState(deps.cfg.dir, state);
    } else {
      // Failures stay in the window; the next run retries from the floor.
      return;
    }
  }

  // ── Delta lane ──
  if (!state.gmail_history_id) return;
  let threadIds: string[];
  let newHistoryId: string | null = null;
  try {
    ({ threadIds, newHistoryId } = await gmail.listHistoryThreadIds(state.gmail_history_id, {
      ...(deps.opts.signal ? { signal: deps.opts.signal } : {}),
    }));
  } catch (e) {
    if (!(e instanceof GoogleCursorExpiredError)) throw e;
    // History expired (~1 week idle): windowed fallback from the newest
    // imported message, then re-anchor a fresh historyId.
    deps.log('[google] historyId expired; falling back to bookmark window');
    const sinceSec = Math.floor(((state.gmail_newest_ms ?? cutoffMs) - 86_400_000) / 1000);
    const ids = await gmail.listMessageIds(`after:${sinceSec}`, {
      ...(deps.opts.signal ? { signal: deps.opts.signal } : {}),
    });
    threadIds = [...new Set(ids.map((m) => m.threadId))];
    const profile = await gmail.getProfile({ ...(deps.opts.signal ? { signal: deps.opts.signal } : {}) });
    newHistoryId = profile.historyId;
  }
  let failed = 0;
  for (const tid of threadIds) {
    if (deps.opts.signal?.aborted) return;
    try {
      const thread = await processThread(deps, gmail, tid, activePack, summary, countedSlugs);
      const newest = thread?.messages[thread.messages.length - 1]?.internalDateMs ?? 0;
      if (newest > (state.gmail_newest_ms ?? 0)) state.gmail_newest_ms = newest;
      progressTick(`thread ${tid}`);
    } catch (e) {
      if (e instanceof GoogleCursorExpiredError && e.status === 404) {
        // Thread deleted after the history record was written — gone is
        // gone. Treating this as a failure would freeze the delta cursor
        // and re-404 the same thread every sync until the historyId itself
        // expired (~1 week of wedged deltas).
        deps.log(`[google] thread ${tid} vanished (404); skipping`);
        progressTick(`thread ${tid} gone`);
        continue;
      }
      failed++;
      summary.failedFiles++;
      summary.status = 'partial';
      deps.log(`[google] thread ${tid} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // The delta cursor advances only when every flagged thread landed —
  // a partial drain re-lists the same window next run (idempotent).
  if (failed === 0 && newHistoryId) {
    state.gmail_history_id = newHistoryId;
  }
}

// ── Full reconcile (deletes) ─────────────────────────────────────────────────

async function reconcileGmailDeletes(
  deps: GoogleSyncDeps,
  gmail: GmailClient,
  summary: GoogleSyncSummary,
): Promise<void> {
  // Enumerate the live window; anything under emails/ not in it vanished
  // (trash/spam/deleted). Only runs when enumeration fully succeeded — an
  // errored listing must never read as a bulk deletion.
  const cutoffSec = Math.floor((Date.now() - deps.cfg.historyDays * 86_400_000) / 1000);
  const ids = await gmail.listMessageIds(`after:${cutoffSec}`, {
    ...(deps.opts.signal ? { signal: deps.opts.signal } : {}),
  });
  const liveThreads = new Set(ids.map((m) => m.threadId));
  const rows = await deps.engine.executeRaw<{ slug: string; source_path: string | null; frontmatter: unknown }>(
    `SELECT slug, source_path, frontmatter FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE 'emails/%'`,
    [deps.sourceId],
  );
  const stale: Array<{ slug: string; source_path: string | null }> = [];
  for (const r of rows) {
    const fm =
      typeof r.frontmatter === 'string'
        ? (JSON.parse(r.frontmatter) as Record<string, unknown>)
        : ((r.frontmatter ?? {}) as Record<string, unknown>);
    const tid = typeof fm.thread_id === 'string' ? fm.thread_id : null;
    const firstIso = typeof fm.first_message_date === 'string' ? fm.first_message_date : null;
    // Pages older than the window are out of enumeration scope — keep them.
    if (firstIso && Date.parse(firstIso) / 1000 < cutoffSec) continue;
    if (tid && !liveThreads.has(tid)) stale.push({ slug: r.slug, source_path: r.source_path });
  }
  if (stale.length === 0) return;
  const { massReconcileAllowed } = await import('../../commands/sync.ts');
  if (stale.length > 200 && !massReconcileAllowed()) {
    deps.log(`[google] mass-delete guard refused ${stale.length} deletes for source ${deps.sourceId}`);
    return;
  }
  await deps.engine.deletePages(stale.map((s) => s.slug), { sourceId: deps.sourceId });
  for (const s of stale) {
    if (s.source_path) rmSync(join(deps.cfg.dir, s.source_path), { force: true });
  }
  summary.deleted += stale.length;
}

// ── Extract + embed (mirrors github-source's size-gated tail) ───────────────

async function runExtractAndEmbed(
  deps: GoogleSyncDeps,
  summary: GoogleSyncSummary,
): Promise<void> {
  const totalChanges = summary.added + summary.modified;
  const pagesAffected = summary.pagesAffected;
  if (totalChanges === 0 || pagesAffected.length === 0) return;

  if (!deps.opts.noExtract && totalChanges <= 100) {
    try {
      const { extractLinksForSlugs, extractTimelineForSlugs, stampExtracted } = await import('../../commands/extract.ts');
      const extractOpts = { sourceId: deps.sourceId };
      await extractLinksForSlugs(deps.engine, deps.cfg.dir, pagesAffected, extractOpts);
      await extractTimelineForSlugs(deps.engine, deps.cfg.dir, pagesAffected, extractOpts);
      await stampExtracted(
        deps.engine,
        pagesAffected.map((slug) => ({ slug, source_id: deps.sourceId })),
      );
    } catch { /* extraction is best-effort */ }
  } else if (totalChanges > 100 && !deps.opts.noExtract) {
    process.stderr.write(`[google] large sync (${totalChanges} pages); extraction deferred to 'gbrain extract --stale --source-id ${deps.sourceId}'\n`);
  }

  if (!deps.opts.noEmbed && totalChanges <= 100 && pagesAffected.length > 0) {
    try {
      const { runEmbedCore } = await import('../../commands/embed.ts');
      await runEmbedCore(deps.engine, { slugs: pagesAffected, sourceId: deps.sourceId });
      summary.embedded = pagesAffected.length;
    } catch { /* embed is best-effort */ }
  } else if (!deps.opts.noEmbed && totalChanges > 100) {
    const drainHint = `run 'gbrain embed --stale --source ${deps.sourceId}' to drain now`;
    try {
      const { submitEmbedBackfill } = await import('../embed-backfill-submit.ts');
      const sub = await submitEmbedBackfill(deps.engine, deps.sourceId, { reason: 'google_sync_defer' });
      if (sub.status === 'submitted') {
        process.stderr.write(`[google] large sync (${totalChanges} pages); embeds deferred to embed-backfill job ${sub.jobId} — or ${drainHint}\n`);
      } else {
        process.stderr.write(`[google] large sync (${totalChanges} pages); embed-backfill not queued (${sub.status}) — ${drainHint}\n`);
      }
    } catch (err) {
      process.stderr.write(`[google] embed-backfill submission failed: ${err instanceof Error ? err.message : String(err)} — ${drainHint}\n`);
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runGoogleSync(
  engine: BrainEngine,
  sourceId: string,
  cfg: GoogleSourceConfig,
  opts: SyncOpts,
  fetchImpl?: FetchImpl,
  vaultOverride?: CredentialVault,
): Promise<SyncResult> {
  if (!cfg.account) {
    throw new Error(
      `Google source "${sourceId}" has no account configured. Re-add it: gbrain sources add ${sourceId} --kind google --account <email>`,
    );
  }
  const vault = vaultOverride ?? openVault();
  const entry = await vault.get(credentialId(GOOGLE_PROVIDER, cfg.account));
  if (!entry) {
    throw new CredentialError('not_connected', ` for ${cfg.account} — run: gbrain google connect --account ${cfg.account}`);
  }
  const log = (msg: string): void => {
    process.stderr.write(msg + '\n');
  };
  const tokens = new GoogleTokenProvider(vault, entry.id, fetchImpl ?? fetch);
  const clientArgs = [tokens, fetchImpl ?? fetch, log, entry.meta.client_id] as const;
  const gmail = new GmailClient(...clientArgs);
  const calendar = new CalendarClient(...clientArgs);
  const people = new PeopleClient(...clientArgs);
  const deps: GoogleSyncDeps = { engine, sourceId, cfg, opts, vault, entry, log, extractCandidates: [] };

  const summary: GoogleSyncSummary = {
    status: 'synced',
    added: 0,
    modified: 0,
    deleted: 0,
    chunksCreated: 0,
    embedded: 0,
    pagesAffected: [],
    threadsSeen: 0,
    failedFiles: 0,
  };
  const countedSlugs = new Set<string>();

  // Active pack for pack-aware typing, mirroring performSyncInner.
  let activePack: ActivePack;
  if (!opts.noSchemaPack) {
    try {
      const { loadActivePack } = await import('../schema-pack/load-active.ts');
      const { loadConfig } = await import('../config.ts');
      const resolved = await loadActivePack({ cfg: loadConfig(), remote: false, sourceId });
      activePack = { page_types: resolved.manifest.page_types };
    } catch { /* legacy prefix typing */ }
  }

  const state = readGoogleState(cfg.dir);
  const firstRun = !state.gmail_backfill_done && state.gmail_history_id === null;
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('sync.google_materialize');
  const tick = (note: string): void => progress.tick(1, note);

  try {
    const serviceErrors: string[] = [];

    if (cfg.services.includes('contacts')) {
      const stop = startHeartbeat(progress, 'contacts sweep');
      try {
        await sweepContacts(deps, people, state, activePack, summary, countedSlugs);
      } catch (e) {
        serviceErrors.push(`contacts: ${e instanceof Error ? e.message : String(e)}`);
        summary.status = 'partial';
        if (isCredentialError(e) && (e.code === 'api_not_enabled' || e.code === 'scope_missing')) log(e.toHuman());
        else log(`[google] contacts sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        stop();
      }
    }

    if (cfg.services.includes('calendar')) {
      const stop = startHeartbeat(progress, 'calendar sweep');
      try {
        await sweepCalendar(deps, calendar, state, activePack, summary, countedSlugs);
      } catch (e) {
        serviceErrors.push(`calendar: ${e instanceof Error ? e.message : String(e)}`);
        summary.status = 'partial';
        if (isCredentialError(e)) log(e.toHuman());
        else log(`[google] calendar sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        stop();
      }
    }

    if (cfg.services.includes('gmail')) {
      const stop = startHeartbeat(progress, 'gmail sweep');
      try {
        await sweepGmail(deps, gmail, state, activePack, summary, countedSlugs, tick);
        if (opts.full) await reconcileGmailDeletes(deps, gmail, summary);
      } catch (e) {
        serviceErrors.push(`gmail: ${e instanceof Error ? e.message : String(e)}`);
        summary.status = 'partial';
        if (isCredentialError(e)) log(e.toHuman());
        else log(`[google] gmail sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        stop();
      }
    }

    summary.pagesAffected = [...new Set(summary.pagesAffected)];
    if (opts.signal?.aborted) summary.status = 'partial';
    if (opts.full && summary.status === 'synced') state.last_full_at = new Date().toISOString();

    // Per-service cursors were advanced in-place only on success; persist.
    writeGoogleState(cfg.dir, state);
    await runExtractAndEmbed(deps, summary);
    await enqueueLoopsExtraction(deps);

    // Commitment-loop staleness pass (v1 close semantics): overdue >14d or
    // >90d inactive → 'stale'. Cheap indexed UPDATE, once per sweep.
    try {
      const { markStaleLoops } = await import('../loops/loops-store.ts');
      await markStaleLoops(engine, sourceId);
    } catch { /* best-effort */ }

    try {
      await engine.executeRaw(
        `UPDATE sources SET last_sync_at = now(), newest_content_at = $1::timestamptz WHERE id = $2`,
        [new Date(state.gmail_newest_ms ?? Date.now()).toISOString(), sourceId],
      );
    } catch { /* best-effort */ }

    const changed = summary.added + summary.modified + summary.deleted > 0;
    return {
      status:
        summary.status === 'partial'
          ? 'partial'
          : firstRun && changed
            ? 'first_sync'
            : changed
              ? 'synced'
              : 'up_to_date',
      fromCommit: null,
      toCommit: '',
      added: summary.added,
      modified: summary.modified,
      deleted: summary.deleted,
      renamed: 0,
      chunksCreated: summary.chunksCreated,
      embedded: summary.embedded,
      pagesAffected: summary.pagesAffected,
      ...(summary.failedFiles > 0 ? { failedFiles: summary.failedFiles } : {}),
    };
  } finally {
    progress.finish();
  }
}
