/**
 * #550 — pages(source_id, slug) unique-index drift: detection + self-heal.
 *
 * A brain stamped >= v23 whose `pages_source_slug_key` constraint never
 * materialized (or was later dropped) fails EVERY put_page with "no unique or
 * exclusion constraint matching the ON CONFLICT specification" while reads
 * stay green. The old v21/v23 guards matched the constraint NAME, so
 * re-running migrations could never repair it, and `initSchema()` was a
 * no-op. These tests pin: the reproduction, the every-pass migrate self-heal
 * (the behavioral fix — fails on master), shape-not-name detection (partial
 * indexes rejected, differently-named satisfying indexes accepted), the
 * name-collision fallback, and the doctor check's literal repair SQL.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrations } from '../src/core/migrate.ts';
import {
  checkPagesUniqueIndex,
  repairPagesUniqueIndex,
  PAGES_UNIQUE_REPAIR_SQL,
} from '../src/core/pages-unique-repair.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// Dynamic so the module loads on a master checkout too — the discrimination
// proof for #550 runs this file against unmodified master, where doctor.ts
// has no pagesUniqueIndexCheck export and runMigrations has no heal.
async function doctorCheck(eng: BrainEngine) {
  const doctor = await import('../src/commands/doctor.ts');
  if (typeof doctor.pagesUniqueIndexCheck !== 'function') {
    throw new Error('doctor.ts does not export pagesUniqueIndexCheck (#550 check missing)');
  }
  return doctor.pagesUniqueIndexCheck(eng);
}

let engine: PGLiteEngine;
/** Schema-less engine (no initSchema) — the fresh-brain / no-pages-table case. */
let bare: PGLiteEngine;
let n = 0;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  bare = new PGLiteEngine();
  await bare.connect({});
});

afterAll(async () => {
  await engine.disconnect();
  await bare.disconnect();
});

/** One put_page upsert — the exact write path #550 kills. */
function put() {
  n++;
  return engine.putPage(
    `notes/issue-550-${n}`,
    { type: 'note', title: `t${n}`, compiled_truth: `body ${n}` },
    { sourceId: 'default' },
  );
}

/** Wedge the brain: drop every arbiter the repair may have added. */
async function dropArbiters() {
  await engine.executeRaw(`ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_slug_key`);
  await engine.executeRaw(`ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_slug_uniq`);
  await engine.executeRaw(`DROP INDEX IF EXISTS pages_ss_other_name`);
  await engine.executeRaw(`DROP INDEX IF EXISTS pages_source_slug_key`);
}

describe('#550 pages(source_id, slug) unique-index drift', () => {
  test('reproduction: dropping the constraint kills put_page; a plain migrate pass heals it', async () => {
    await put(); // baseline — fresh brain writes fine

    await dropArbiters();
    expect(put()).rejects.toThrow(/unique or exclusion constraint|ON CONFLICT/i);

    // The brain is stamped at head, so nothing is "pending" — on master this
    // pass is a no-op and the brain stays write-dead forever. The #550 fix
    // heals on every pass, shape-keyed.
    const res = await runMigrations(engine);
    expect(res.applied).toBe(0); // proves the heal is NOT a pending migration

    await put(); // writes restored
    const status = await checkPagesUniqueIndex(engine);
    expect(status.satisfied).toBe(true);
    expect(status.indexName).toBe('pages_source_slug_key');
  });

  test('detection is by columns: a satisfying unique index under a different name counts', async () => {
    await dropArbiters();
    await engine.executeRaw(
      `CREATE UNIQUE INDEX pages_ss_other_name ON pages(slug, source_id)`, // reversed order also satisfies inference
    );

    const status = await checkPagesUniqueIndex(engine);
    expect(status.satisfied).toBe(true);
    expect(status.indexName).toBe('pages_ss_other_name');

    // Repair must be a no-op — no duplicate constraint piled on top.
    const r = await repairPagesUniqueIndex(engine);
    expect(r.repaired).toBe(false);
    expect(r.reason).toBe('already_correct');

    await put(); // ON CONFLICT (source_id, slug) accepts the reversed-column arbiter

    await dropArbiters();
    await repairPagesUniqueIndex(engine); // restore canonical state
  });

  test('a partial unique index does NOT satisfy ON CONFLICT and is not accepted', async () => {
    await dropArbiters();
    await engine.executeRaw(
      `CREATE UNIQUE INDEX pages_ss_other_name ON pages(source_id, slug) WHERE slug <> ''`,
    );

    expect(put()).rejects.toThrow(/unique or exclusion constraint|ON CONFLICT/i);
    const status = await checkPagesUniqueIndex(engine);
    expect(status.satisfied).toBe(false);

    const r = await repairPagesUniqueIndex(engine);
    expect(r.repaired).toBe(true);
    await put();

    await engine.executeRaw(`DROP INDEX IF EXISTS pages_ss_other_name`);
  });

  test('canonical name taken by a wrong-shaped index: repair falls back instead of failing', async () => {
    await dropArbiters();
    // Correctly named, wrong shape (partial) — must not block the repair.
    await engine.executeRaw(
      `CREATE UNIQUE INDEX pages_source_slug_key ON pages(source_id, slug) WHERE slug <> ''`,
    );

    const r = await repairPagesUniqueIndex(engine);
    expect(r.repaired).toBe(true);
    const status = await checkPagesUniqueIndex(engine);
    expect(status.satisfied).toBe(true);
    expect(status.indexName).toBe('pages_source_slug_uniq');
    await put();

    // Restore canonical state for later tests.
    await dropArbiters();
    await repairPagesUniqueIndex(engine);
  });

  test('repair is idempotent', async () => {
    const first = await repairPagesUniqueIndex(engine);
    expect(first.reason).toBe('already_correct');
    const second = await repairPagesUniqueIndex(engine);
    expect(second.reason).toBe('already_correct');
  });

  test('doctor check FAILS loudly with the literal repair SQL (and never mentions --force-schema)', async () => {
    await dropArbiters();

    const check = await doctorCheck(engine);
    expect(check.name).toBe('pages_unique_index');
    expect(check.status).toBe('fail');
    expect(check.message).toContain(PAGES_UNIQUE_REPAIR_SQL);
    expect(check.message).toContain(
      'ALTER TABLE pages ADD CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug);',
    );
    expect(check.message).not.toContain('force-schema');

    await repairPagesUniqueIndex(engine);
    const healthy = await doctorCheck(engine);
    expect(healthy.status).toBe('ok');
  });

  test('missing pages table is OK/skip, not FAIL — a fresh brain is not broken', async () => {
    const status = await checkPagesUniqueIndex(bare);
    expect(status.tablePresent).toBe(false);
    expect(status.satisfied).toBe(false);

    const r = await repairPagesUniqueIndex(bare);
    expect(r.repaired).toBe(false);
    expect(r.reason).toBe('no_table');

    const check = await doctorCheck(bare);
    expect(check.status).toBe('ok');
  });
});
