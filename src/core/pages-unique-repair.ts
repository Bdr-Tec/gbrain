/**
 * #550 — pages(source_id, slug) unique-index drift detection + self-heal.
 *
 * Both engines' `putPage` upsert with `ON CONFLICT (source_id, slug)`. That
 * inference only succeeds when a NON-PARTIAL unique index (constraint-backed
 * or plain `CREATE UNIQUE INDEX`) exists whose key columns are exactly
 * {source_id, slug}. When it's missing, EVERY put_page write fails with
 * "there is no unique or exclusion constraint matching the ON CONFLICT
 * specification" while reads keep working — the brain looks healthy and is
 * write-dead.
 *
 * How the index goes missing: migration v23 (Postgres) / v21 (PGLite) guarded
 * the `ADD CONSTRAINT pages_source_slug_key` on `pg_constraint.conname` — a
 * NAME match, not a shape match. Any brain stamped >= v23 without that DDL
 * actually executing (fresh-init blob stamped to head, externally-created
 * `pages`, a later drop/rename) never gets it back: `runMigrations` early
 * returns at head and `initSchema()` is additive-only. Same class as #2038
 * (idx_timeline_dedup), so the repair follows the same pattern: keyed off the
 * actual index SHAPE, run on every migrate pass, idempotent.
 */

import type { BrainEngine } from './engine.ts';

/**
 * Selects the name of every index that satisfies `ON CONFLICT (source_id,
 * slug)` inference on `pages`:
 *   - unique
 *   - non-partial (a partial unique index does NOT satisfy inference without
 *     a matching WHERE clause, which putPage doesn't emit)
 *   - plain-column (no expression keys)
 *   - key columns exactly {source_id, slug}, in any order
 *
 * Matched BY COLUMNS, never by name — a correctly-named but wrong-shaped
 * index must not count. Shared verbatim by the doctor probe, the repair
 * helper, and the v21/v23 migration guards (embedded in `EXISTS (...)`).
 * `i.indkey` also lists INCLUDE columns, so with `indnkeyatts = 2` the
 * aggregate has exactly 2 names only when there are no INCLUDE columns —
 * conservative: an INCLUDE-bearing index is treated as not satisfying.
 */
export const PAGES_SOURCE_SLUG_UNIQUE_PROBE_SQL = `
  SELECT c.relname
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE t.relname = 'pages'
     AND i.indisunique
     AND i.indpred IS NULL
     AND i.indexprs IS NULL
     AND i.indnkeyatts = 2
     AND (
       SELECT array_agg(a.attname::text ORDER BY a.attname)
         FROM pg_attribute a
        WHERE a.attrelid = t.oid
          AND a.attnum = ANY (i.indkey)
     ) = ARRAY['slug', 'source_id']
`;

/** The literal operator repair — doctor prints this verbatim on FAIL. */
export const PAGES_UNIQUE_REPAIR_SQL =
  'ALTER TABLE pages ADD CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug);';

/**
 * The guard DDL shared by migration v23 (Postgres) and v21 (PGLite) and by
 * the every-pass self-heal. Column-shape-guarded, so:
 *   - a satisfying index under ANY name → no-op (no duplicate constraint)
 *   - the canonical name taken by a wrong-shaped relation → falls back to
 *     `pages_source_slug_uniq` instead of failing (ON CONFLICT inference is
 *     by shape; the name is not load-bearing)
 * Does NOT dedupe pages first: if unconstrained duplicates snuck in, ADD
 * CONSTRAINT fails naming the duplicated key — deleting pages automatically
 * would be data loss, so that call stays with the operator.
 */
export const PAGES_SOURCE_SLUG_UNIQUE_DDL = `
  DO $$ BEGIN
    IF NOT EXISTS (${PAGES_SOURCE_SLUG_UNIQUE_PROBE_SQL}) THEN
      IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pages_source_slug_key') THEN
        ALTER TABLE pages ADD CONSTRAINT pages_source_slug_uniq UNIQUE (source_id, slug);
      ELSE
        ALTER TABLE pages ADD CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug);
      END IF;
    END IF;
  END $$;
`;

export interface PagesUniqueStatus {
  /** The pages table exists (nothing to check on a fresh brain). */
  tablePresent: boolean;
  /** pages.source_id exists (pre-v21 schemas are the migration chain's job). */
  sourceIdPresent: boolean;
  /** A satisfying unique index exists — put_page's ON CONFLICT works. */
  satisfied: boolean;
  /** Name of the first satisfying index (null when unsatisfied). */
  indexName: string | null;
}

export async function checkPagesUniqueIndex(engine: BrainEngine): Promise<PagesUniqueStatus> {
  const tbl = await engine.executeRaw<{ reg: string | null }>(
    `SELECT to_regclass('pages')::text AS reg`,
  );
  if (!tbl[0]?.reg) {
    return { tablePresent: false, sourceIdPresent: false, satisfied: false, indexName: null };
  }
  const col = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'pages' AND column_name = 'source_id'`,
  );
  if (Number(col[0]?.n ?? 0) === 0) {
    return { tablePresent: true, sourceIdPresent: false, satisfied: false, indexName: null };
  }
  const rows = await engine.executeRaw<{ relname: string }>(PAGES_SOURCE_SLUG_UNIQUE_PROBE_SQL);
  return {
    tablePresent: true,
    sourceIdPresent: true,
    satisfied: rows.length > 0,
    indexName: rows[0]?.relname ?? null,
  };
}

export interface PagesUniqueRepairResult {
  repaired: boolean;
  reason: 'already_correct' | 'no_table' | 'pre_source_id' | 'added';
}

/**
 * Heal the missing unique index. Idempotent; a no-op on healthy brains and on
 * pre-v21 schemas (no source_id yet — the ordinary migration chain owns those).
 */
export async function repairPagesUniqueIndex(engine: BrainEngine): Promise<PagesUniqueRepairResult> {
  const status = await checkPagesUniqueIndex(engine);
  if (!status.tablePresent) return { repaired: false, reason: 'no_table' };
  if (!status.sourceIdPresent) return { repaired: false, reason: 'pre_source_id' };
  if (status.satisfied) return { repaired: false, reason: 'already_correct' };
  await engine.executeRaw(PAGES_SOURCE_SLUG_UNIQUE_DDL);
  return { repaired: true, reason: 'added' };
}
