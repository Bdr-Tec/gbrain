/**
 * discover.ts — harness-root discovery + the status gap table (cathedral-4).
 *
 * Discovery is CONFINED to the static harness roots (detect.ts) — this is
 * the untrusted-enumeration side of the trust split, so symlinks are
 * lstat-rejected and only the expected extensions are picked up. Consumer
 * exports have no canonical root and never appear here.
 *
 * The status table derives its "imported" side from PAGES (one paginated
 * listPages walk, client-side transcript_import filtering, distinct
 * session ids) — durable truth that catches late-arriving sessions no
 * watermark can. File↔session matching for the gap column uses the
 * session-id-in-filename property of the three JSONL harnesses; the Hermes
 * store is one file holding many sessions, so its gap is reported at
 * session granularity only.
 */

import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { TranscriptFormat } from './types.ts';
import { harnessRoots, type HarnessRoot } from './detect.ts';
import { isOpenclawCheckpointFile } from './openclaw.ts';

export interface DiscoveredFile {
  format: TranscriptFormat;
  path: string;
  bytes: number;
}

/** Recursively list regular files under root (lstat: symlinks are skipped). */
function walk(dir: string, out: string[], depth = 0): void {
  if (depth > 6) return; // harness layouts are shallow; don't wander
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out, depth + 1);
    else if (st.isFile()) out.push(p);
  }
}

export function discoverTranscriptFiles(roots?: HarnessRoot[]): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  for (const { format, root, extension } of harnessRoots(roots)) {
    if (format === 'hermes') {
      const store = join(root, 'state.db');
      try {
        const st = lstatSync(store);
        if (st.isFile()) out.push({ format, path: store, bytes: st.size });
      } catch {
        // No store — hermes simply absent from discovery.
      }
      continue;
    }
    const files: string[] = [];
    walk(root, files);
    for (const p of files) {
      if (!p.endsWith(extension)) continue;
      if (isOpenclawCheckpointFile(p)) continue;
      let bytes = 0;
      try {
        bytes = lstatSync(p).size;
      } catch {
        continue;
      }
      out.push({ format, path: p, bytes });
    }
  }
  return out;
}

export interface ImportedSessionIndex {
  /** harness → distinct imported session ids. */
  byHarness: Map<string, Set<string>>;
  pagesScanned: number;
}

/**
 * ONE paginated pages walk (type=conversation) with client-side
 * transcript_import filtering — never a query per harness.
 */
export async function indexImportedSessions(
  engine: BrainEngine,
  sourceId: string,
): Promise<ImportedSessionIndex> {
  const byHarness = new Map<string, Set<string>>();
  let pagesScanned = 0;
  const PAGE_BATCH = 200;
  let offset = 0;
  for (;;) {
    const batch = await engine.listPages({ type: 'conversation', sourceId, limit: PAGE_BATCH, offset });
    if (batch.length === 0) break;
    for (const page of batch) {
      pagesScanned++;
      const fm = page.frontmatter as Record<string, unknown> | null | undefined;
      const ti = fm?.transcript_import as
        | { harness?: string; session_id?: string }
        | undefined;
      if (!ti || typeof ti.harness !== 'string' || typeof ti.session_id !== 'string') continue;
      let set = byHarness.get(ti.harness);
      if (!set) {
        set = new Set();
        byHarness.set(ti.harness, set);
      }
      set.add(ti.session_id);
    }
    if (batch.length < PAGE_BATCH) break;
    offset += PAGE_BATCH;
  }
  return { byHarness, pagesScanned };
}

export interface StatusRow {
  format: TranscriptFormat;
  /** Files (stores, for hermes) found under the harness root. */
  found: number;
  /** Distinct imported session ids for this harness. */
  importedSessions: number;
  /** Found files with no imported session id in their basename (JSONL harnesses; null for hermes). */
  gapFiles: number | null;
}

export function buildStatusRows(
  discovered: DiscoveredFile[],
  imported: ImportedSessionIndex,
): StatusRow[] {
  const formats: TranscriptFormat[] = ['claude-code', 'codex', 'openclaw', 'hermes'];
  return formats.map((format) => {
    const files = discovered.filter((d) => d.format === format);
    const sessionIds = imported.byHarness.get(format) ?? new Set<string>();
    let gapFiles: number | null = null;
    if (format !== 'hermes') {
      gapFiles = files.filter((f) => {
        const base = f.path.split('/').pop() ?? '';
        for (const id of sessionIds) {
          if (id && base.includes(id)) return false;
        }
        return true;
      }).length;
    }
    return { format, found: files.length, importedSessions: sessionIds.size, gapFiles };
  });
}
