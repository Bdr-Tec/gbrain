/**
 * ingest.ts — the transcripts-import core (cathedral-4).
 *
 * Engine-facing, CLI-free: `gbrain transcripts ingest` parses flags and
 * calls runTranscriptsIngest; e2e tests call it directly. Pipeline per
 * session (ATOMICITY = SESSION, never file — a multi-session file commits
 * the sessions that pass and skips the ones that fail; idempotent re-runs
 * complete the rest):
 *
 *   detect → adapter.parse (AsyncGenerator, per-session) → since/limit
 *   filters → redactSession (fail-closed) → renderSessionParts →
 *   importFromContent per part (embed OFF unless opted in) →
 *   putRawData(baseSlug) → stale-part reconciliation (delete part > of).
 *
 * Error taxonomy:
 *   - per-FILE: unreadable / unknown format / symlink → counted, run continues.
 *   - per-SESSION: scan failure, oversize part, adapter throw → counted,
 *     file continues.
 *   - RUN-LEVEL (fail-closed integrity): importFromContent duplicate-lookup
 *     or read-back failures and putRawData misses rethrow and abort the run.
 *     Heuristic seam: import errors matching /too large/ stay per-session.
 *
 * Watermark: the RESULT carries `cleanScan` (no errors anywhere, no limit
 * truncation) + `maxSessionTs`; the COMMAND advances the `--since last`
 * checkpoint only on a clean scan — a truncated or partially-failed run
 * must never skip work permanently.
 */

import type { BrainEngine } from '../engine.ts';
import { importFromContent } from '../import-file.ts';
import type { TranscriptAdapter, TranscriptFormat } from './types.ts';
import { detectAdapter } from './detect.ts';
import { redactSession, renderSessionParts } from './render.ts';

export interface IngestActivePack {
  page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }>;
}

export interface TranscriptsIngestOpts {
  /** Files to import (post-glob, pre-detection). */
  paths: string[];
  /** Explicit format wins over detection. */
  format?: TranscriptFormat;
  /** Parse + redact + render + report; ZERO engine writes. */
  dryRun?: boolean;
  /** Max sessions imported this run (session granularity; truncation ⇒ not a clean scan). */
  limit?: number;
  /** Only sessions whose LAST message is strictly newer than this ISO. */
  sinceIso?: string;
  /** Resolved source id — threads through import, raw-data, reconciliation. */
  sourceId: string;
  /** Embedding opt-in (default OFF: bulk imports defer to the embed backfill). */
  embed?: boolean;
  activePack?: IngestActivePack;
  /** Test seam for the redaction user-pattern file. */
  userPatternsPath?: string;
  /** Adapter registry override (tests). */
  adapters?: TranscriptAdapter[];
  /** Called once per processed file (progress heartbeats). */
  onFileDone?: (done: number, total: number, path: string) => void;
}

export interface IngestSessionOutcome {
  sessionId: string;
  harness: TranscriptFormat;
  baseSlug: string;
  parts: number;
  /** Per-part import statuses (dry-run: 'planned'). */
  statuses: Array<'imported' | 'skipped' | 'error' | 'planned'>;
  redactions: number;
  imperatives: number;
  error?: string;
}

export interface IngestFileOutcome {
  path: string;
  format?: TranscriptFormat;
  sessions: IngestSessionOutcome[];
  skippedLines: number;
  drift: boolean;
  error?: string;
}

export interface TranscriptsIngestResult {
  files: IngestFileOutcome[];
  pages: { imported: number; skipped: number; errored: number; planned: number };
  sessionsSeen: number;
  sessionsImported: number;
  sessionsFiltered: number;
  sessionsErrored: number;
  redactions: number;
  imperatives: number;
  partsDeleted: number;
  driftFiles: number;
  erroredFiles: number;
  /** EVERY slug the run touched — imported AND hash-skipped (--facts targets all). */
  slugsTouched: string[];
  /** True ⇔ no file/session errors and no limit truncation: watermark may advance. */
  cleanScan: boolean;
  /** Newest session last-message ISO seen (imported or filtered). */
  maxSessionTs: string;
}

/** Session's last message timestamp ('' when none carry one). */
function lastMessageTs(messages: Array<{ timestamp: string }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].timestamp) return messages[i].timestamp;
  }
  return '';
}

const RUN_ABORT_MARKER = 'transcripts-ingest run abort';

function isPerSessionImportError(err: unknown): boolean {
  return err instanceof Error && /too large/i.test(err.message);
}

export async function runTranscriptsIngest(
  engine: BrainEngine,
  opts: TranscriptsIngestOpts,
): Promise<TranscriptsIngestResult> {
  const result: TranscriptsIngestResult = {
    files: [],
    pages: { imported: 0, skipped: 0, errored: 0, planned: 0 },
    sessionsSeen: 0,
    sessionsImported: 0,
    sessionsFiltered: 0,
    sessionsErrored: 0,
    redactions: 0,
    imperatives: 0,
    partsDeleted: 0,
    driftFiles: 0,
    erroredFiles: 0,
    slugsTouched: [],
    cleanScan: true,
    maxSessionTs: '',
  };
  let limitTruncated = false;

  const total = opts.paths.length;
  let done = 0;

  for (const path of opts.paths) {
    if (limitTruncated) break;
    const fileOutcome: IngestFileOutcome = {
      path,
      sessions: [],
      skippedLines: 0,
      drift: false,
    };
    result.files.push(fileOutcome);

    const detected = detectAdapter(path, {
      explicitFormat: opts.format,
      adapters: opts.adapters,
    });
    if (!detected.ok) {
      fileOutcome.error =
        detected.reason === 'unknown_format'
          ? `unknown format (tried: ${detected.tried.join(', ')}); pass an explicit format flag`
          : detected.reason;
      result.erroredFiles++;
      result.cleanScan = false;
      done++;
      opts.onFileDone?.(done, total, path);
      continue;
    }
    fileOutcome.format = detected.adapter.format;

    const gen = detected.adapter.parse(path);
    try {
      let step = await gen.next();
      while (!step.done) {
        if (limitTruncated) {
          // Stop consuming; the generator's finally blocks clean up.
          await gen.return?.(undefined as never);
          break;
        }
        const session = step.value;
        result.sessionsSeen++;
        const lastTs = lastMessageTs(session.messages);
        if (lastTs && lastTs > result.maxSessionTs) result.maxSessionTs = lastTs;

        if (opts.sinceIso && lastTs && lastTs <= opts.sinceIso) {
          result.sessionsFiltered++;
          step = await gen.next();
          continue;
        }
        if (opts.limit !== undefined && result.sessionsImported >= opts.limit) {
          limitTruncated = true;
          result.cleanScan = false;
          await gen.return?.(undefined as never);
          break;
        }

        const outcome: IngestSessionOutcome = {
          sessionId: session.meta.sessionId,
          harness: session.meta.harness,
          baseSlug: '',
          parts: 0,
          statuses: [],
          redactions: 0,
          imperatives: 0,
        };
        fileOutcome.sessions.push(outcome);

        try {
          const redacted = redactSession(session, { userPatternsPath: opts.userPatternsPath });
          outcome.redactions = redacted.redactionCount;
          outcome.imperatives = redacted.imperativesFlagged;
          const rendered = renderSessionParts(redacted, { sourcePath: path });
          outcome.baseSlug = rendered.baseSlug;
          outcome.parts = rendered.parts.length;

          if (opts.dryRun) {
            outcome.statuses = rendered.parts.map(() => 'planned' as const);
            result.pages.planned += rendered.parts.length;
          } else {
            for (const part of rendered.parts) {
              try {
                const r = await importFromContent(engine, part.slug, part.content, {
                  noEmbed: !opts.embed,
                  sourceId: opts.sourceId,
                  activePack: opts.activePack,
                  source_kind: `transcript:${session.meta.harness}`,
                  source_uri: path,
                  ingested_via: 'cli:transcripts-ingest',
                });
                outcome.statuses.push(r.status);
                if (r.status === 'imported') result.pages.imported++;
                else if (r.status === 'skipped') result.pages.skipped++;
                else result.pages.errored++;
                result.slugsTouched.push(part.slug);
              } catch (err) {
                if (isPerSessionImportError(err)) throw err; // → per-session catch
                const e = new Error(
                  `${RUN_ABORT_MARKER}: import integrity failure on ${part.slug}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
                (e as { cause?: unknown }).cause = err;
                throw e;
              }
            }

            // Session metadata rides the base page's raw_data. The page is
            // guaranteed present (part 1 just imported or hash-skipped);
            // a miss here is an integrity failure → run abort.
            if (session.meta.raw) {
              try {
                await engine.putRawData(
                  rendered.baseSlug,
                  `transcript:${session.meta.harness}`,
                  session.meta.raw,
                  { sourceId: opts.sourceId },
                );
              } catch (err) {
                const e = new Error(
                  `${RUN_ABORT_MARKER}: putRawData failed for ${rendered.baseSlug}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
                (e as { cause?: unknown }).cause = err;
                throw e;
              }
            }

            // Stale-part reconciliation: a session that shrank or re-split
            // leaves higher-numbered part pages behind — delete them, or a
            // stale part stays searchable forever.
            let n = rendered.parts.length + 1;
            for (;;) {
              const staleSlug = `${rendered.baseSlug}-p${n}`;
              const existing = await engine.getPage(staleSlug, { sourceId: opts.sourceId });
              if (!existing) break;
              await engine.deletePage(staleSlug, { sourceId: opts.sourceId });
              result.partsDeleted++;
              n++;
            }
          }
          result.sessionsImported++;
          result.redactions += outcome.redactions;
          result.imperatives += outcome.imperatives;
        } catch (err) {
          if (err instanceof Error && err.message.startsWith(RUN_ABORT_MARKER)) throw err;
          outcome.error = err instanceof Error ? err.message : String(err);
          result.sessionsErrored++;
          result.cleanScan = false;
        }

        step = await gen.next();
      }
      if (step.done && step.value) {
        const diag = step.value;
        fileOutcome.skippedLines = diag.skippedLines;
        if (diag.bytesRead > 0 && diag.sessions === 0) {
          fileOutcome.drift = true;
          result.driftFiles++;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(RUN_ABORT_MARKER)) throw err;
      fileOutcome.error = err instanceof Error ? err.message : String(err);
      result.erroredFiles++;
      result.cleanScan = false;
    }

    done++;
    opts.onFileDone?.(done, total, path);
  }

  if (opts.dryRun) result.cleanScan = false; // dry-runs never advance watermarks
  return result;
}
