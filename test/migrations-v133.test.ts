/**
 * Migration v133 (minion_private_queue_owner_metadata) — #4332.
 *
 * Durable ownership/liveness metadata for parent-owned dream-inline private
 * queues. Startup recovery uses the owner/token/lease columns to cancel only
 * orphaned private queues (terminal/missing owner or expired lease), never
 * live queues and never legacy unowned rows. The two partial indexes scope
 * the recovery scan to `dream-inline-%` queues in live statuses and the
 * owner lookup to non-NULL owners.
 *
 * Pinned contracts:
 * 1. v133 exists in MIGRATIONS with the canonical name, idempotent flag, and
 *    one engine-agnostic sql block (no sqlFor split) carrying all three
 *    ADD COLUMN IF NOT EXISTS statements and both CREATE INDEX IF NOT EXISTS
 *    statements with the dream-inline partial predicate.
 * 2. Fresh init: the schema declares all three columns and both partial
 *    indexes natively.
 * 3. Upgrade: on a brain stripped to the pre-v133 shape (positive control:
 *    columns and indexes verifiably absent), a ledger rewind to 132 →
 *    runMigrations re-adds every piece, the partial predicates survive the
 *    round-trip, re-run applies nothing, and re-executing the v133 SQL
 *    directly is a no-op (IF NOT EXISTS everywhere).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';

let engine: PGLiteEngine;

const V133_SQL = MIGRATIONS.find(m => m.version === 133)?.sql ?? '';

const PQ_COLUMNS = [
  'private_queue_lease_until',
  'private_queue_owner_job_id',
  'private_queue_owner_token',
];
const PQ_INDEXES = [
  'idx_minion_jobs_private_queue_owner',
  'idx_minion_jobs_private_queue_recovery',
];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' }); // in-memory
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

/** The private-queue columns currently present on minion_jobs, sorted. */
async function presentColumns(): Promise<string[]> {
  const rows = await engine.executeRaw<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'minion_jobs'
        AND column_name IN ('private_queue_owner_job_id','private_queue_owner_token','private_queue_lease_until')
      ORDER BY column_name`,
  );
  return rows.map(r => r.column_name);
}

/** The private-queue indexes currently present on minion_jobs, sorted by name. */
async function presentIndexes(): Promise<Array<{ indexname: string; indexdef: string }>> {
  return engine.executeRaw<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'minion_jobs'
        AND indexname IN ('idx_minion_jobs_private_queue_recovery','idx_minion_jobs_private_queue_owner')
      ORDER BY indexname`,
  );
}

describe('migration v133 — structure', () => {
  test('exists with canonical name, idempotent flag, engine-agnostic sql', () => {
    const v133 = MIGRATIONS.find(m => m.version === 133);
    expect(v133).toBeDefined();
    expect(v133?.name).toBe('minion_private_queue_owner_metadata');
    expect(v133?.idempotent).toBe(true);
    expect(v133?.sqlFor).toBeUndefined();
    for (const col of PQ_COLUMNS) {
      expect(V133_SQL).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
    for (const idx of PQ_INDEXES) {
      expect(V133_SQL).toContain(`CREATE INDEX IF NOT EXISTS ${idx}`);
    }
    // The recovery index must be partial on dream-inline queues; the owner
    // FK must detach (not cascade) when the owner row disappears.
    expect(V133_SQL).toContain(`WHERE queue LIKE 'dream-inline-%'`);
    expect(V133_SQL).toContain('REFERENCES minion_jobs(id) ON DELETE SET NULL');
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(133);
  });
});

describe('migration v133 — fresh init (PGLite)', () => {
  test('fresh schema has all three private-queue columns and both partial indexes', async () => {
    expect(await presentColumns()).toEqual(PQ_COLUMNS);
    const idx = await presentIndexes();
    expect(idx.map(i => i.indexname)).toEqual(PQ_INDEXES);
  });
});

describe('migration v133 — upgrade from a pre-v133 brain (PGLite)', () => {
  test('re-adds columns + dream-inline partial indexes; re-run applies nothing', async () => {
    // Simulate a pre-v133 brain: strip everything the migration adds.
    // Indexes first — dropping a column silently drops indexes that
    // reference it, which would mask a broken index-side assertion.
    await engine.executeRaw('DROP INDEX IF EXISTS idx_minion_jobs_private_queue_recovery');
    await engine.executeRaw('DROP INDEX IF EXISTS idx_minion_jobs_private_queue_owner');
    await engine.executeRaw('ALTER TABLE minion_jobs DROP COLUMN IF EXISTS private_queue_owner_job_id');
    await engine.executeRaw('ALTER TABLE minion_jobs DROP COLUMN IF EXISTS private_queue_owner_token');
    await engine.executeRaw('ALTER TABLE minion_jobs DROP COLUMN IF EXISTS private_queue_lease_until');

    // Positive control: the pre-v133 shape is verifiably column- and index-free.
    expect(await presentColumns()).toEqual([]);
    expect(await presentIndexes()).toEqual([]);

    // Apply v133 via the real migration runner (ledger rewind below 133).
    await engine.setConfig('version', '132');
    const res = await runMigrations(engine);
    expect(res.applied).toBeGreaterThanOrEqual(1);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));

    expect(await presentColumns()).toEqual(PQ_COLUMNS);
    const idx = await presentIndexes();
    expect(idx.map(i => i.indexname)).toEqual(PQ_INDEXES);

    // The partial predicates survived the round-trip (pg renders LIKE as ~~
    // in indexdef, so pin the literal + WHERE rather than the keyword).
    const recovery = idx.find(i => i.indexname === 'idx_minion_jobs_private_queue_recovery');
    expect(recovery?.indexdef).toContain('WHERE');
    expect(recovery?.indexdef).toContain('dream-inline-');
    const owner = idx.find(i => i.indexname === 'idx_minion_jobs_private_queue_owner');
    expect(owner?.indexdef).toContain('private_queue_owner_job_id IS NOT NULL');

    // Ledger idempotency: re-run applies nothing.
    const rerun = await runMigrations(engine);
    expect(rerun.applied).toBe(0);

    // SQL-level idempotency: re-executing the multi-statement v133 block on
    // an up-to-date brain is a no-op (IF NOT EXISTS everywhere), not an
    // error. runMigration is the production execution path for the block.
    await engine.runMigration(133, V133_SQL);
    expect(await presentColumns()).toEqual(PQ_COLUMNS);
    expect((await presentIndexes()).map(i => i.indexname)).toEqual(PQ_INDEXES);
  });
});
