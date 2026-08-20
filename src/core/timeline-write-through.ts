/**
 * #1856 — write-through for manual timeline entries.
 *
 * `add_timeline_entry` historically wrote ONLY the `timeline_entries` table.
 * On an FS/git-canonical brain (markdown on disk is the committable source of
 * truth) that stranded every manual entry: invisible to git, absent from
 * `gbrain get <slug>`, and silently lost on any FS→DB rebuild because no
 * bullet in the canonical markdown could reconstruct it.
 *
 * This module routes manual timeline writes through the SAME write-through
 * seam pages and facts use (`resolvePageWriteTarget` / `writePageThrough`,
 * the #4204 precedent): when the brain resolves a disk target for the page,
 * the entry is
 *   1. rendered as a canonical `- **date** | source — summary` bullet,
 *   2. spliced date-ordered into the page row's `timeline` text,
 *   3. inserted into `timeline_entries` with the tuple the FS extractor
 *      (`extractTimelineFromContent`) recovers from that exact bullet, and
 *   4. persisted to disk via `writePageThrough` (atomic, all #2018/#2831
 *      guards, durability commit).
 *
 * Step 3 is the dedup-critical part the issue called out: the table's
 * uniqueness is `(page_id, date, summary, source)`, and sync re-extracts the
 * bullet on every pass — if the stored tuple differed from the re-extracted
 * one, every sync would insert a duplicate. We derive the stored tuple BY
 * RUNNING the extractor over the rendered block, so convergence holds by
 * construction. When derivation can't produce exactly one entry (pathological
 * source strings), we return `handled: false` and the caller falls back to
 * the legacy DB-only insert — an entry is never dropped.
 *
 * DB-only brains (no repo target, or `sync.write_through` off) always take
 * the `handled: false` path, so their behavior is byte-identical to before.
 *
 * Reconcile note: the pages row's `content_hash` is deliberately NOT updated
 * here — the on-disk file now hashes differently from the stored hash, so the
 * next `gbrain sync` re-imports the page (refreshing chunks + re-extracting
 * the timeline, which conflicts-no-ops against the row written here). Same
 * eventual-consistency contract as the facts fence lane.
 */

import type { BrainEngine } from './engine.ts';
import { sanitizeForJsonb } from './batch-rows.ts';
import {
  isWriteThroughDisabled,
  resolvePageWriteTarget,
  writePageThrough,
  type WriteThroughLogger,
  type WriteThroughResult,
} from './write-through.ts';
import { extractTimelineFromContent } from '../commands/extract.ts';

/** Raw op params for one manual timeline entry (date pre-validated by caller). */
export interface TimelineEntryWriteInput {
  /** Strict YYYY-MM-DD (the op validates before calling). */
  date: string;
  summary: string;
  source?: string;
  detail?: string;
}

/** Canonical tuple actually stored (matches FS re-extraction of the bullet). */
export interface CanonicalTimelineTuple {
  date: string;
  source: string;
  summary: string;
}

export interface TimelineWriteThroughOutcome {
  /**
   * True when this helper OWNED the write: `pages.timeline` spliced, the
   * canonical `timeline_entries` row inserted, and the disk write attempted
   * (its own outcome in `file` — best-effort, like put_page's write-through).
   * False → nothing was written here; the caller MUST run the legacy DB-only
   * insert so the entry is recorded (unchanged pre-#1856 path).
   */
  handled: boolean;
  /** Disk write outcome (present when handled). */
  file?: WriteThroughResult;
  /** The tuple stored in timeline_entries (present when handled). */
  entry?: CanonicalTimelineTuple;
  /** Why the FS-canonical path didn't apply (when handled=false). */
  skipped?:
    | 'disabled_by_config'
    | 'no_repo_configured'
    | 'repo_not_found'
    | 'source_repo_belongs_to_other_source'
    | 'path_escapes_source_root'
    | 'page_not_found'
    | 'render_not_roundtrippable';
  /** Set when the helper threw mid-way; caller still falls back to DB-only. */
  error?: string;
}

/**
 * Default source label for manual entries with no provenance ref. A bullet
 * MUST carry a source segment: the FS extractor assigns `'markdown'` to
 * delimiter-less bullets and splits summary-first bullets on interior dashes
 * (#1856 Bug 1's fragmentation class), so rendering `| <summary>` alone can
 * never round-trip to `source: ''`. `'manual'` is honest provenance for a
 * hand-added entry and contains no delimiter the extractor could mis-split.
 */
const DEFAULT_MANUAL_SOURCE = 'manual';

/** Collapse a free-text field onto one line (the bullet is line-anchored). */
function inlineText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Rendered markdown block + the tuple the FS extractor recovers from it. */
export interface RenderedTimelineEntry {
  /** Bullet line plus indented detail lines (when representable). */
  block: string;
  canonical: CanonicalTimelineTuple;
}

/**
 * Render one entry as a canonical source-first bullet and derive the tuple
 * the FS extractor will recover from it. Returns null when the rendered
 * block does not round-trip to exactly one entry with the requested date —
 * the caller then keeps the entry DB-only rather than writing a bullet that
 * would fragment or duplicate on the next sync.
 */
export function renderTimelineEntry(
  entry: TimelineEntryWriteInput,
  slug: string,
): RenderedTimelineEntry | null {
  const summary = inlineText(entry.summary ?? '');
  if (!summary) return null;
  const source = inlineText(entry.source ?? '') || DEFAULT_MANUAL_SOURCE;
  const line = `- **${entry.date}** | ${source} — ${summary}`;
  // Detail rides along as indented continuation lines so the canonical file
  // keeps the full content (the FS extractor ignores continuation lines; the
  // DB-path parser reads them back as detail).
  const detailLines = (entry.detail ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => `  ${l}`);

  const derive = (block: string): CanonicalTimelineTuple | null => {
    const entries = extractTimelineFromContent(block, slug);
    if (entries.length !== 1) return null;
    if (entries[0].date !== entry.date) return null;
    return { date: entries[0].date, source: entries[0].source ?? '', summary: entries[0].summary };
  };

  let block = [line, ...detailLines].join('\n');
  let canonical = derive(block);
  if (!canonical && detailLines.length > 0) {
    // A detail line can carry its own `[Source: …, date]` citation that the
    // extractor's Format 3 would file as a second entry. Keep detail out of
    // the file in that case (it stays in the DB row) rather than planting a
    // block that re-extracts to more than one entry.
    block = line;
    canonical = derive(block);
  }
  if (!canonical) return null;
  return { block, canonical };
}

/** Line-anchored Format-1 bullet detector (date capture only). */
const BULLET_DATE_RE = /^-\s+\*\*(\d{4}-\d{2}-\d{2})\*\*\s*\|/;

/**
 * Splice a rendered entry block into a page's `timeline` text, date-ordered
 * among the existing Format-1 bullets. Preserves the list's existing sort
 * direction (ascending unless the first bullet's date is greater than the
 * last's). Insertion lands immediately BEFORE the first bullet that should
 * follow the new entry, so a neighbor's indented detail lines are never
 * split; when no bullet follows, the block is appended at the end.
 */
export function spliceTimelineBlock(timelineText: string, date: string, block: string): string {
  const text = (timelineText ?? '').trimEnd();
  if (!text.trim()) {
    return `## Timeline\n\n${block}`;
  }
  const lines = text.split('\n');
  const bullets: Array<{ index: number; date: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = BULLET_DATE_RE.exec(lines[i]);
    if (m) bullets.push({ index: i, date: m[1] });
  }
  if (bullets.length === 0) {
    return `${text}\n\n${block}`;
  }
  const descending = bullets.length >= 2 && bullets[0].date > bullets[bullets.length - 1].date;
  let insertBefore = -1;
  for (const b of bullets) {
    if (descending ? b.date < date : b.date > date) {
      insertBefore = b.index;
      break;
    }
  }
  if (insertBefore === -1) {
    return `${text}\n${block}`;
  }
  return [...lines.slice(0, insertBefore), ...block.split('\n'), ...lines.slice(insertBefore)].join('\n');
}

/**
 * Write one manual timeline entry through the page/facts write-through seam.
 *
 * Trust gating (subagent sandbox, dry-run) stays at the CALLER, exactly like
 * `writePageThrough` — this helper only does "target resolves → splice +
 * insert + render". Never throws: failures return `handled: false` so the
 * caller's legacy DB-only insert still records the entry.
 */
export async function writeTimelineEntryThrough(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
  entry: TimelineEntryWriteInput,
  opts: { logger?: WriteThroughLogger } = {},
): Promise<TimelineWriteThroughOutcome> {
  try {
    if (await isWriteThroughDisabled(engine)) {
      return { handled: false, skipped: 'disabled_by_config' };
    }
    const target = await resolvePageWriteTarget(engine, slug, sourceId);
    if (!target.ok) {
      return { handled: false, skipped: target.skipped };
    }

    const page = await engine.getPage(slug, { sourceId });
    if (!page) {
      // Let the caller's legacy insert raise the canonical "page not found"
      // error instead of inventing a second error shape here.
      return { handled: false, skipped: 'page_not_found' };
    }

    const rendered = renderTimelineEntry(entry, slug);
    if (!rendered) {
      return { handled: false, skipped: 'render_not_roundtrippable' };
    }

    const newTimeline = sanitizeForJsonb(
      spliceTimelineBlock(page.timeline ?? '', entry.date, rendered.block),
    );
    await engine.executeRaw(
      `UPDATE pages SET timeline = $1, updated_at = now()
        WHERE slug = $2 AND source_id = $3 AND deleted_at IS NULL`,
      [newTimeline, slug, sourceId],
    );

    // Store the tuple the FS extractor recovers from the bullet just spliced
    // in, so every later sync/rebuild re-extraction conflicts-no-ops instead
    // of duplicating (#1856's dedup-tuple divergence).
    await engine.addTimelineEntry(slug, { // gbrain-allow-direct-insert: timeline write-through — the canonical markdown gains the same entry in this call, and the stored tuple is derived from the rendered bullet so sync/extract reconciliation dedups against it
      date: rendered.canonical.date,
      source: rendered.canonical.source,
      summary: rendered.canonical.summary,
      detail: entry.detail || '',
    }, { sourceId, skipExistenceCheck: true });

    const file = await writePageThrough(engine, slug, { sourceId, logger: opts.logger });
    return { handled: true, file, entry: rendered.canonical };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    opts.logger?.warn(`[timeline-write-through] failed for ${slug}: ${msg}`);
    return { handled: false, error: msg };
  }
}
