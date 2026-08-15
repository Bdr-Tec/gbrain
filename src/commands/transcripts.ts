/**
 * gbrain transcripts — session transcripts: recent corpus reads and the
 * cathedral-4 import lane.
 *
 *   gbrain transcripts recent   — dream-corpus .txt reader (v0.29 surface).
 *   gbrain transcripts ingest   — import dead session logs (Claude Code,
 *                                 Codex, OpenClaw, Hermes) and consumer chat
 *                                 exports (ChatGPT, Claude.ai) into
 *                                 conversation pages. Local-only, explicit
 *                                 paths are trusted CLI input; embedding is
 *                                 OFF by default (bulk imports defer to the
 *                                 embed backfill lane).
 *
 * PGLite note: like every engine-opening command, ingest cannot run while
 * `gbrain serve` holds the single-writer lock — the lock error names the PID.
 */

import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import type { TranscriptFormat } from '../core/transcripts/types.ts';
import { runTranscriptsIngest, type TranscriptsIngestResult } from '../core/transcripts/ingest.ts';
import { isOpenclawCheckpointFile } from '../core/transcripts/openclaw.ts';

interface RecentOpts {
  days?: number;
  full?: boolean;
  limit?: number;
  json?: boolean;
}

function parseRecentArgs(args: string[]): RecentOpts | { help: true } {
  const opts: RecentOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--full') { opts.full = true; continue; }
    if (a === '--days') {
      const n = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n) && n >= 0) opts.days = n;
      continue;
    }
    if (a === '--limit') {
      const n = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n) && n > 0) opts.limit = n;
      continue;
    }
  }
  return opts;
}

const FORMATS: readonly TranscriptFormat[] = [
  'claude-code',
  'codex',
  'openclaw',
  'hermes',
  'chatgpt',
  'claude-export',
];

interface IngestCliOpts {
  paths: string[];
  format?: TranscriptFormat;
  dryRun?: boolean;
  limit?: number;
  since?: string;
  source?: string;
  facts?: boolean;
  maxCostUsd?: number;
  embed?: boolean;
  json?: boolean;
  quiet?: boolean;
}

function parseIngestArgs(args: string[]): IngestCliOpts | { help: true } | { error: string } {
  const opts: IngestCliOpts = { paths: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--quiet') { opts.quiet = true; continue; }
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--embed') { opts.embed = true; continue; }
    if (a === '--facts') { opts.facts = true; continue; }
    if (a === '--format') {
      const v = args[++i] as TranscriptFormat | undefined;
      if (!v || !FORMATS.includes(v)) {
        return { error: `unknown format '${v ?? ''}' (expected one of: ${FORMATS.join(', ')})` };
      }
      opts.format = v;
      continue;
    }
    if (a === '--limit') {
      const n = parseInt(args[++i] ?? '', 10);
      if (!Number.isFinite(n) || n <= 0) return { error: 'limit must be a positive integer' };
      opts.limit = n;
      continue;
    }
    if (a === '--since') {
      const v = args[++i];
      if (!v) return { error: 'since needs an ISO timestamp or the word last' };
      opts.since = v;
      continue;
    }
    if (a === '--source-id' || a === '--source') {
      const v = args[++i];
      if (!v) return { error: 'source-id needs a value' };
      opts.source = v;
      continue;
    }
    if (a === '--max-cost-usd') {
      const n = parseFloat(args[++i] ?? '');
      if (!Number.isFinite(n) || n <= 0) return { error: 'max-cost-usd must be a positive number' };
      opts.maxCostUsd = n;
      continue;
    }
    if (a.startsWith('-')) return { error: `unknown flag ${a}` };
    opts.paths.push(a);
  }
  return opts;
}

const HELP = `Usage:
  gbrain transcripts ingest <path-or-glob>... [options]
  gbrain transcripts recent [options]

ingest — import dead session logs and chat exports as conversation pages
(readable text-turn archive: user/assistant text only, secrets redacted,
long sessions split into searchable parts). Re-runs are free (content-hash
skip). Embedding is OFF by default; run the embed backfill later or opt in.

  --format F        claude-code | codex | openclaw | hermes | chatgpt |
                    claude-export (auto-detected when omitted)
  --dry-run         Parse + redact + report; writes nothing
  --limit N         Max sessions this run
  --since T         Only sessions newer than ISO time T; the word "last"
                    resumes from the previous clean run
  --source-id S     Target source (default: the canonical 6-tier resolution)
  --embed           Embed pages at import (default: defer to embed backfill)
  --facts           Extract facts from imported pages (budget-capped)
  --max-cost-usd F  Facts budget cap (default 5)
  --json            Machine-readable result
  --quiet           Suppress the human summary

recent — read recent dream-corpus transcripts (.txt):
  --days N / --limit N / --full / --json    (see gbrain transcripts recent -h)

Notes: consumer exports must be unzipped first (pass conversations.json).
On PGLite, stop gbrain serve first (single-writer lock).
`;

/** Expand path-or-glob args; checkpoint snapshots are never imported. */
async function expandPaths(specs: string[]): Promise<string[]> {
  const { statSync } = await import('node:fs');
  const out: string[] = [];
  for (const spec of specs) {
    let matched = false;
    try {
      if (statSync(spec).isFile()) {
        out.push(spec);
        continue;
      }
      if (statSync(spec).isDirectory()) {
        const glob = new Bun.Glob('**/*');
        for (const p of glob.scanSync({ cwd: spec, absolute: true, onlyFiles: true })) {
          out.push(p);
          matched = true;
        }
        continue;
      }
    } catch {
      // Not a literal path — try as a glob below.
    }
    const glob = new Bun.Glob(spec);
    for (const p of glob.scanSync({ cwd: process.cwd(), absolute: true, onlyFiles: true })) {
      out.push(p);
      matched = true;
    }
    if (!matched && !out.includes(spec)) {
      // Keep the unmatched spec so the per-file error names it.
      out.push(spec);
    }
  }
  return [...new Set(out)].filter((p) => !isOpenclawCheckpointFile(p));
}

function fmtSummary(r: TranscriptsIngestResult): string {
  const byHarness = new Map<string, number>();
  for (const f of r.files) {
    for (const s of f.sessions) {
      if (!s.error) byHarness.set(s.harness, (byHarness.get(s.harness) ?? 0) + 1);
    }
  }
  const lines: string[] = [];
  const counts = [...byHarness.entries()].map(([h, n]) => `${h}: ${n}`).join(', ');
  lines.push(
    `sessions: ${r.sessionsImported} imported (${counts || 'none'}), ` +
      `${r.sessionsFiltered} filtered, ${r.sessionsErrored} errored, ${r.sessionsSeen} seen`,
  );
  lines.push(
    `pages: ${r.pages.imported} imported, ${r.pages.skipped} unchanged` +
      (r.pages.planned ? `, ${r.pages.planned} planned (dry run)` : '') +
      (r.partsDeleted ? `, ${r.partsDeleted} stale parts deleted` : ''),
  );
  if (r.redactions > 0) lines.push(`redactions: ${r.redactions} secrets/patterns redacted before write`);
  if (r.imperatives > 0) lines.push(`flagged: ${r.imperatives} agent-directed imperative(s) noted in frontmatter`);
  if (r.driftFiles > 0) {
    lines.push(
      `DRIFT WARNING: ${r.driftFiles} file(s) parsed to zero sessions — the host ` +
        `format may have changed; see the adapter SPEC_TARGET runbook`,
    );
  }
  for (const f of r.files) {
    if (f.error) lines.push(`error: ${f.path}: ${f.error}`);
    for (const s of f.sessions) {
      if (s.error) lines.push(`error: ${f.path} session ${s.sessionId}: ${s.error}`);
    }
  }
  return lines.join('\n');
}

async function runIngest(engine: BrainEngine, args: string[]): Promise<void> {
  const parsed = parseIngestArgs(args);
  if ('help' in parsed) {
    console.log(HELP);
    return;
  }
  if ('error' in parsed) {
    console.error(`gbrain transcripts ingest: ${parsed.error}`);
    setCliExitVerdict(2);
    return;
  }
  if (parsed.paths.length === 0) {
    console.error('gbrain transcripts ingest: no paths given (discovery mode lands with `status`)');
    console.log(HELP);
    setCliExitVerdict(2);
    return;
  }

  // Source: the canonical 6-tier chain (capture.ts pattern) — one resolved
  // id threads import + raw-data + reconciliation + checkpoint fingerprint.
  let sourceId = 'default';
  try {
    const { resolveSourceWithTier } = await import('../core/source-resolver.ts');
    const r = await resolveSourceWithTier(engine, parsed.source ?? null);
    sourceId = r.source_id;
  } catch (e) {
    console.error(`gbrain transcripts ingest: ${e instanceof Error ? e.message : String(e)}`);
    setCliExitVerdict(1);
    return;
  }

  // Active pack ONCE per command (never per file).
  let activePack: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> } | undefined;
  try {
    const { loadActivePack } = await import('../core/schema-pack/load-active.ts');
    const { loadConfig } = await import('../core/config.ts');
    const resolved = await loadActivePack({ cfg: loadConfig(), remote: false, sourceId });
    activePack = { page_types: resolved.manifest.page_types };
  } catch {
    activePack = undefined;
  }

  const paths = await expandPaths(parsed.paths);
  if (paths.length === 0) {
    console.error('gbrain transcripts ingest: 0 files matched');
    return;
  }

  // --since last → op-checkpoint watermark (speed convenience only; the
  // status gap table is the correctness surface). Fingerprint binds
  // source + pathspec + format + adapter version so a second source or a
  // different root never inherits this watermark.
  const { fingerprint, loadOpCheckpoint, recordCompleted } = await import('../core/op-checkpoint.ts');
  const { TRANSCRIPT_IMPORT_VERSION } = await import('../core/transcripts/render.ts');
  const checkpointKey = {
    op: 'transcripts-ingest',
    fingerprint: fingerprint({
      sourceId,
      pathspec: [...parsed.paths].sort(),
      format: parsed.format ?? 'auto',
      version: TRANSCRIPT_IMPORT_VERSION,
    }),
  };
  let sinceIso = parsed.since;
  if (parsed.since === 'last') {
    sinceIso = undefined;
    const keys = await loadOpCheckpoint(engine, checkpointKey);
    for (const k of keys) {
      if (k.startsWith('since:')) {
        const v = k.slice('since:'.length);
        if (!sinceIso || v > sinceIso) sinceIso = v;
      }
    }
    if (!sinceIso && !parsed.quiet) {
      console.error('transcripts ingest: no previous clean run for this scope — full scan');
    }
  }

  const { createProgress } = await import('../core/progress.ts');
  const { cliOptsToProgressOptions, getCliOptions } = await import('../core/cli-options.ts');
  const reporter = createProgress(cliOptsToProgressOptions(getCliOptions()));
  reporter.start('transcripts.ingest', paths.length);

  let result: TranscriptsIngestResult;
  try {
    result = await runTranscriptsIngest(engine, {
      paths,
      format: parsed.format,
      dryRun: parsed.dryRun,
      limit: parsed.limit,
      sinceIso,
      sourceId,
      embed: parsed.embed,
      activePack,
      onFileDone: () => reporter.tick(),
    });
  } finally {
    reporter.finish();
  }

  if (!parsed.embed && !parsed.dryRun && result.pages.imported > 0 && !parsed.quiet) {
    console.error(
      'note: pages imported without embeddings (default) — run the embed backfill ' +
        'or re-run with the embed flag to make them vector-searchable now',
    );
  }

  // Watermark: advance ONLY on a clean, untruncated, non-dry scan.
  if (result.cleanScan && result.maxSessionTs) {
    await recordCompleted(engine, checkpointKey, [`since:${result.maxSessionTs}`]);
  }

  // --facts: ONE extractor invocation over every touched slug (including
  // hash-skipped pages — the extractor's version-token gate dedupes work).
  let factsSummary: { pages: number; spentUsd?: number } | undefined;
  if (parsed.facts && !parsed.dryRun && result.slugsTouched.length > 0) {
    const { runIngestFacts } = await import('../core/transcripts/ingest-facts.ts');
    factsSummary = await runIngestFacts(engine, {
      sourceId,
      slugs: [...new Set(result.slugsTouched)],
      maxCostUsd: parsed.maxCostUsd,
      quiet: parsed.quiet,
    });
  }

  if (parsed.json) {
    console.log(JSON.stringify({ ...result, facts: factsSummary ?? null, source_id: sourceId }, null, 2));
  } else if (!parsed.quiet) {
    console.log(fmtSummary(result));
    if (factsSummary) {
      console.log(
        `facts: extracted over ${factsSummary.pages} page(s)` +
          (factsSummary.spentUsd !== undefined ? `, ~$${factsSummary.spentUsd.toFixed(2)} spent` : ''),
      );
    }
    const firstImported = result.files.flatMap((f) => f.sessions).find((s) => !s.error && s.baseSlug);
    if (firstImported && !parsed.dryRun) {
      console.log(`try it: gbrain query "${firstImported.baseSlug.split('/').pop()}"`);
    }
  }

  const allFailed =
    result.files.length > 0 &&
    result.files.every((f) => f.error !== undefined || (f.drift && f.sessions.length === 0));
  if (allFailed) setCliExitVerdict(1);
}

export async function runTranscripts(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === 'ingest') {
    await runIngest(engine, args.slice(1));
    return;
  }
  if (sub !== 'recent') {
    console.log(HELP);
    if (sub && sub !== '--help' && sub !== '-h') setCliExitVerdict(2);
    return;
  }

  const parsed = parseRecentArgs(args.slice(1));
  if ('help' in parsed) {
    console.log(HELP);
    return;
  }
  const { listRecentTranscripts } = await import('../core/transcripts.ts');
  const rows = await listRecentTranscripts(engine, {
    days: parsed.days,
    summary: !parsed.full,
    limit: parsed.limit,
  });
  if (parsed.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('(no recent transcripts in the corpus dir)');
    return;
  }
  rows.forEach(r => {
    const date = r.date ?? r.mtime.slice(0, 10);
    console.log(`\n--- ${date} | ${r.path} | ${r.length} bytes ---`);
    console.log(r.summary);
  });
}
