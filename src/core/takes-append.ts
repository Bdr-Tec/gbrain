/**
 * Shared dual-plane take append (Wave-4 review fix).
 *
 * Markdown is the source of truth for takes: `gbrain takes add` allocates
 * row numbers from the FILE fence (upsertTakeRow → max fence rowNum + 1),
 * then mirrors to the DB via addTakesBatch's ON CONFLICT (page_id, row_num)
 * DO UPDATE. Any writer that appends DB-only rows (the original
 * persistThinkTake did) allocates from DB MAX(row_num) instead — and the
 * next fence-allocated row at the same number deterministically OVERWRITES
 * it. This module is the single append path both surfaces call, so the two
 * planes cannot drift:
 *
 *   withPageLock(slug)
 *     → resolve the page (scoped: sourceIds > sourceId > unscoped)
 *     → resolve the brain dir (explicit override > sync.repo_path config)
 *     → file plane: upsertTakeRow allocates the row number (file-first)
 *     → writeBody
 *     → DB plane: addTakesBatch mirror at the fence-allocated row number
 *
 * Fallback posture (headless / DB-only brains): when no brain dir resolves,
 * the row is allocated DB-only (MAX(row_num)+1) and the
 * 'TAKE_FILE_PLANE_UNAVAILABLE' warning is returned — documented posture:
 * DB-only rows can be renumbered/overwritten by a later fence reconcile.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { BrainEngine, TakeKind } from './engine.ts';
import { upsertTakeRow } from './takes-fence.ts';
import { withPageLock } from './page-lock.ts';

/** Warning code returned when the append fell back to DB-only allocation. */
export const TAKE_FILE_PLANE_UNAVAILABLE = 'TAKE_FILE_PLANE_UNAVAILABLE';

/** Thrown when the (scoped) page lookup finds nothing. Callers map this to
 * their own surface signal (CLI error+exit, TAKE_ANCHOR_NOT_FOUND, ...). */
export class TakePageNotFoundError extends Error {
  readonly slug: string;
  readonly sourceId?: string;
  constructor(slug: string, sourceId?: string) {
    super(`Page not found in brain: ${slug}${sourceId ? ` (source=${sourceId})` : ''}`);
    this.name = 'TakePageNotFoundError';
    this.slug = slug;
    this.sourceId = sourceId;
  }
}

export function pageFilePath(brainDir: string, slug: string): string {
  return join(brainDir, `${slug}.md`);
}

export function readBodyOrEmpty(path: string): string {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

export function writeBody(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf-8');
}

/**
 * Resolve the on-disk brain dir for the file plane, or null when none is
 * available (headless install, unset/dangling sync.repo_path). An explicit
 * dir that does not exist ALSO returns null — the CLI wraps this with its
 * own loud error+exit; core callers fall back to DB-only allocation.
 */
export async function resolveBrainDirOrNull(
  engine: BrainEngine,
  explicitDir?: string | null,
): Promise<string | null> {
  if (explicitDir) return existsSync(explicitDir) ? explicitDir : null;
  try {
    const configured = await engine.getConfig('sync.repo_path');
    if (configured && existsSync(configured)) return configured;
  } catch {
    // Config read failure → treat as no file plane (fallback posture).
  }
  return null;
}

export interface AppendTakeInput {
  slug: string;
  /** Scalar source scope (sourceIds wins when both set — sourceScopeOpts precedence). */
  sourceId?: string;
  /** Federated source scope for the page lookup. */
  sourceIds?: string[];
  claim: string;
  kind: TakeKind;
  holder: string;
  weight?: number;
  source?: string;
  sinceDate?: string;
  /**
   * Pre-resolved brain dir (CLI --dir, or a caller that already validated
   * sync.repo_path). When omitted, resolves via resolveBrainDirOrNull; when
   * that yields nothing, the append falls back to DB-only allocation with
   * the TAKE_FILE_PLANE_UNAVAILABLE warning.
   */
  brainDir?: string;
}

export interface AppendTakeResult {
  rowNum: number;
  inserted: number;
  warnings: string[];
}

/**
 * Append one take row to a page on BOTH planes (file fence + DB), serialized
 * under withPageLock(slug) so concurrent appends can't race the allocation.
 *
 * The page lookup runs FIRST (inside the lock, before any file write) so a
 * missing page throws {@link TakePageNotFoundError} without leaving a
 * half-written fence behind.
 */
export async function appendTake(
  engine: BrainEngine,
  input: AppendTakeInput,
): Promise<AppendTakeResult> {
  const warnings: string[] = [];
  return withPageLock(input.slug, async () => {
    // Scoped page lookup: federated array > scalar > unscoped.
    const pageOpts: { sourceId?: string; sourceIds?: string[] } = {};
    if (input.sourceIds !== undefined) pageOpts.sourceIds = input.sourceIds;
    else if (input.sourceId !== undefined) pageOpts.sourceId = input.sourceId;
    const page = await engine.getPage(input.slug, pageOpts);
    if (!page) throw new TakePageNotFoundError(input.slug, input.sourceId);

    const brainDir = input.brainDir ?? await resolveBrainDirOrNull(engine);

    let rowNum: number;
    if (brainDir) {
      // File plane first: the fence allocates the row number.
      const path = pageFilePath(brainDir, input.slug);
      const body = readBodyOrEmpty(path);
      const up = upsertTakeRow(body, {
        claim: input.claim,
        kind: input.kind,
        holder: input.holder,
        weight: input.weight ?? 0.5,
        source: input.source,
        sinceDate: input.sinceDate,
        active: true,
      });
      writeBody(path, up.body);
      rowNum = up.rowNum;
    } else {
      // DB-only fallback (no file plane). MAX(row_num)+1 under the same page
      // lock. A later fence reconcile may renumber/overwrite these rows —
      // documented posture for headless brains.
      warnings.push(TAKE_FILE_PLANE_UNAVAILABLE);
      const rows = await engine.executeRaw<{ next: number | string }>(
        `SELECT (COALESCE(MAX(row_num), 0) + 1)::int AS next FROM takes WHERE page_id = $1`,
        [page.id],
      );
      rowNum = Number(rows[0]?.next ?? 1);
    }

    const inserted = await engine.addTakesBatch([{
      page_id: page.id,
      row_num: rowNum,
      claim: input.claim,
      kind: input.kind,
      holder: input.holder,
      weight: input.weight ?? 0.5,
      since_date: input.sinceDate,
      source: input.source,
      active: true,
      superseded_by: null,
    }]);

    return { rowNum, inserted, warnings };
  });
}
