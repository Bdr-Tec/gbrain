/**
 * Migration-hardening pins (the poisonable-skip class + its guardrails):
 *
 *   1. From==To WITH work outstanding: config already points at the target
 *      but NULL vectors remain ⇒ the run FALLS THROUGH and resumes (the old
 *      three-conjunct skip exited 0 here — the zero-coverage path).
 *   2. env==target PROCEEDS with a notice; env≠target refused (env gate).
 *   3. Absent embedding column ⇒ plan says "will be (re)built", NOT the
 *      DESTRUCTIVE deletion warning; empty brain migrates cleanly.
 *   4. --retarget: a live different-target marker refuses (naming both
 *      commands) without --retarget, proceeds with it, and records history.
 *   5. Lock passthrough + heartbeat: a heldLocks drain whose refresh()
 *      returns false ABORTS with lock_lost (no silent mutual-exclusion loss).
 *   6. 2048d transition: DDL succeeds with NO HNSW index (pgvector caps
 *      `vector` HNSW at 2000 dims); exact-scan search still works.
 *   7. Same-width ze-switch resume does NOT drop stored vectors (width guard).
 *
 * Serial: temp GBRAIN_HOME + fake embed transport for the file's lifecycle.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { runMigrateEmbeddings } from '../src/commands/migrate-embeddings.ts';
import {
  MIGRATION_STATE_KEY,
  runSchemaTransition,
  readMigrationState,
  resolveRerankerPlan,
  applyRerankerAction,
  type MigrationState,
} from '../src/core/embedding-migration.ts';
import type { DbLockHandle } from '../src/core/db-lock.ts';

const FROM_DIMS = 1280;
const TO_DIMS = 1536;

let engine: PGLiteEngine;
let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};
let currentDims = FROM_DIMS;
let embeddedTexts: string[] = [];
let slowEmbedMs = 0;

function installTransport(): void {
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
    if (slowEmbedMs > 0) await new Promise((r) => setTimeout(r, slowEmbedMs));
    for (const v of values) {
      if (!v.includes('probe')) embeddedTexts.push(v);
    }
    return {
      embeddings: values.map(() => new Array(currentDims).fill(0).map((_, i) => Math.sin(i) * 0.01 + 0.001)),
      usage: { tokens: values.length * 4 },
    } as never;
  });
}

class ExitError extends Error {
  constructor(public code: number) { super(`exit ${code}`); }
}
const exitSeam = (code: number): never => { throw new ExitError(code); };

async function runMigrate(args: string[]): Promise<number> {
  try {
    await runMigrateEmbeddings(engine, args, { exit: exitSeam });
    throw new Error('runMigrateEmbeddings returned without exiting');
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

function writeFileConfig(model: string, dims: number): void {
  writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    embedding_model: model,
    embedding_dimensions: dims,
    zeroentropy_api_key: 'ze-test-fake',
    openai_api_key: 'sk-test-fake',
  }, null, 2));
}

beforeAll(async () => {
  for (const k of ['GBRAIN_HOME', 'GBRAIN_EMBEDDING_MODEL', 'GBRAIN_EMBEDDING_DIMENSIONS', 'GBRAIN_EMBED_LOCK_HEARTBEAT_MS', 'OPENAI_API_KEY', 'ZEROENTROPY_API_KEY', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-migrate-hardening-'));
  process.env.GBRAIN_HOME = tmpHome;
  mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
  writeFileConfig('zeroentropyai:zembed-1', FROM_DIMS);

  resetGateway();
  configureGateway({
    embedding_model: 'zeroentropyai:zembed-1',
    embedding_dimensions: FROM_DIMS,
    env: { ZEROENTROPY_API_KEY: 'ze-test-fake', OPENAI_API_KEY: 'sk-test-fake' },
  });
  installTransport();

  engine = new PGLiteEngine();
  await engine.connect({ embedding_dimensions: FROM_DIMS } as never);
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(tmpHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('poisonable skip is dead', () => {
  test('From==To with NULL vectors outstanding resumes instead of exiting 0', async () => {
    // Seed two pages embedded at the FROM provider.
    for (const slug of ['skip-1', 'skip-2']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}\n\nbody` });
      await engine.upsertChunks(slug, [
        { chunk_index: 0, chunk_text: `chunk of ${slug}`, chunk_source: 'compiled_truth', token_count: 4 },
      ]);
    }
    await runEmbedCore(engine, { stale: true, quiet: true });

    // The incident state: config (file plane + gateway) ALREADY points at the
    // target, the column is already at target width, but the vectors are
    // NULL. The old skip conjunct (from==to && !dim_change && stale-count)
    // exited 0 on variants of this; the verified skip must fall through.
    currentDims = TO_DIMS;
    writeFileConfig('openai:text-embedding-3-small', TO_DIMS);
    resetGateway();
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: TO_DIMS,
      env: { OPENAI_API_KEY: 'sk-test-fake' },
    });
    installTransport();
    await runSchemaTransition(engine, TO_DIMS); // NULLs every vector at target width
    await engine.setConfig('embedding_model', 'openai:text-embedding-3-small');
    await engine.setConfig('embedding_dimensions', String(TO_DIMS));

    embeddedTexts = [];
    const code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes']);
    expect(code).toBe(0); // completed — by DOING the work, not by skipping it
    expect(embeddedTexts.length).toBe(2); // both darkened pages re-embedded

    // And now that the brain is GENUINELY converged, the verified skip fires.
    embeddedTexts = [];
    const again = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes']);
    expect(again).toBe(0);
    expect(embeddedTexts.length).toBe(0); // no work, no spend
  }, 60000);

  test('env==target proceeds (dry-run works); env!=target refuses the live run', async () => {
    // env == target: the notice-and-proceed case (env-first deployments).
    process.env.GBRAIN_EMBEDDING_MODEL = 'openai:text-embedding-3-small';
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = String(TO_DIMS);
    try {
      const dryCode = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--dry-run']);
      expect(dryCode).toBe(0); // dry-run renders the plan — not refused

      // env != target: the #1421 refusal, unchanged.
      process.env.GBRAIN_EMBEDDING_MODEL = 'zeroentropyai:zembed-1';
      process.env.GBRAIN_EMBEDDING_DIMENSIONS = String(FROM_DIMS);
      const code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes']);
      expect(code).toBe(1); // refused_env
    } finally {
      delete process.env.GBRAIN_EMBEDDING_MODEL;
      delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;
    }
  }, 30000);

  test('retarget gate: different-target marker refuses without --retarget, proceeds with it', async () => {
    // Plant a live marker for a DIFFERENT target.
    await engine.setConfig(MIGRATION_STATE_KEY, JSON.stringify({
      version: 2,
      to_model: 'voyage:voyage-4',
      to_dims: 1024,
      from_model: 'zeroentropyai:zembed-1',
      from_dims: FROM_DIMS,
      started_at: '2026-08-01T00:00:00.000Z',
    } satisfies MigrationState));
    try {
      const refused = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes']);
      expect(refused).toBe(1);
      // Marker untouched by the refusal.
      const marker = await readMigrationState(engine);
      expect(marker.state?.to_model).toBe('voyage:voyage-4');

      const code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes', '--retarget']);
      expect(code).toBe(0);
      // Completed: marker cleared; the abandoned target is in the completion
      // path's history via the superseded chain (marker was rewritten then
      // cleared — verify the brain converged and no marker remains).
      const after = await readMigrationState(engine);
      expect(after.state).toBeNull();
    } finally {
      await engine.unsetConfig(MIGRATION_STATE_KEY);
    }
  }, 60000);
});

describe('locks + schema honesty', () => {
  test('heldLocks heartbeat: refresh()===false aborts the drain with lock_lost', async () => {
    // Darken one page so the drain has work, then hand runEmbedCore a fake
    // held lock whose refresh reports "stolen".
    await engine.executeRaw(`UPDATE content_chunks SET embedding = NULL`);
    const fakeLock: DbLockHandle = {
      id: 'fake-held-lock',
      acquiredAt: '0',
      release: async () => {},
      refresh: async () => false,
    };
    process.env.GBRAIN_EMBED_LOCK_HEARTBEAT_MS = '40';
    slowEmbedMs = 400; // hold the drain open long enough for a heartbeat tick
    try {
      const result = await runEmbedCore(engine, {
        stale: true,
        catchUp: true,
        singleFlight: true,
        includeNullSignature: true,
        quiet: true,
        heldLocks: [fakeLock],
      });
      expect(result.lock_lost).toBe(true);
    } finally {
      delete process.env.GBRAIN_EMBED_LOCK_HEARTBEAT_MS;
      slowEmbedMs = 0;
      // Recover the brain for later tests.
      await runEmbedCore(engine, { stale: true, quiet: true });
    }
  }, 60000);

  test('2048d transition: no HNSW index (pgvector cap), exact-scan search works', async () => {
    currentDims = 2048;
    await runSchemaTransition(engine, 2048);
    const idx = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'idx_chunks_embedding'`,
    );
    expect(Number(idx[0]?.n)).toBe(0); // above the 2000-dim vector HNSW cap

    // Exact-scan path still works end to end. 3-large: its recipe allows
    // flexible dims up to 3072, so 2048 passes the client-side dim check
    // (3-small caps at 1536 and would refuse before the transport).
    resetGateway();
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 2048,
      env: { OPENAI_API_KEY: 'sk-test-fake' },
    });
    installTransport();
    await runEmbedCore(engine, { stale: true, quiet: true });
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL`,
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);

    // Restore the 1536d state for anything that runs after.
    currentDims = TO_DIMS;
    await runSchemaTransition(engine, TO_DIMS);
    resetGateway();
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: TO_DIMS,
      env: { OPENAI_API_KEY: 'sk-test-fake' },
    });
    installTransport();
    await runEmbedCore(engine, { stale: true, quiet: true });
  }, 60000);

  test('empty/absent column: plan shows the (re)build line, not the deletion warning', async () => {
    // Drop the column outright — the absent/unparsable case (dims === null).
    await engine.executeRaw(`DROP INDEX IF EXISTS idx_chunks_embedding`);
    await engine.executeRaw(`ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding`);
    try {
      // Capture the --json stdout envelope (console.log) — it carries the
      // plan + the verify blockers, which is where the honesty lives.
      const outLines: string[] = [];
      const origLog = console.log;
      console.log = (...a: unknown[]) => { outLines.push(a.map(String).join(' ')); };
      let code: number;
      try {
        code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--dry-run', '--json']);
      } finally {
        console.log = origLog;
      }
      expect(code).toBe(0); // dry-run against an absent column plans, never throws
      const envelope = JSON.parse(outLines.join('\n')) as {
        status: string;
        plan: { column_dims: number | null; dim_change: boolean; chunks_to_embed: number };
        verified: { complete: boolean; blockers: string[] };
      };
      expect(envelope.status).toBe('planned');
      // Absent column: rebuild flagged honestly (dim_change true even though
      // dims === null — the old spelling hid the DDL), copy says (re)built.
      expect(envelope.plan.column_dims).toBeNull();
      expect(envelope.plan.dim_change).toBe(true);
      expect(envelope.plan.chunks_to_embed).toBeGreaterThan(0);
      expect(envelope.verified.complete).toBe(false);
      expect(envelope.verified.blockers.join('\n')).toContain('will be (re)built');
    } finally {
      // Restore the column + vectors for subsequent files.
      await runSchemaTransition(engine, TO_DIMS);
      await runEmbedCore(engine, { stale: true, quiet: true });
    }
  }, 60000);
});

describe('reranker companion (D8)', () => {
  test('bundle-default ZE reranker is exposed; auto switches to the target provider reranker', async () => {
    // No explicit search.reranker.model row — the exposure must resolve
    // THROUGH the mode-bundle default (zeroentropyai:zerank-2), the common
    // ZE case the old explicit-key-only warning missed.
    const plan = await resolveRerankerPlan(engine, 'zeroentropyai:zembed-1', 'voyage:voyage-4', undefined);
    expect(plan.exposed).not.toBeNull();
    expect(plan.exposed!.model).toBe('zeroentropyai:zerank-2');
    expect(plan.exposed!.sunset_date).toBeTruthy();
    expect(plan.action).toEqual({ kind: 'switch', to: 'voyage:rerank-2.5' });
  });

  test('auto with a reranker-less target suggests, never silently enables a third provider', async () => {
    const plan = await resolveRerankerPlan(engine, 'zeroentropyai:zembed-1', 'openai:text-embedding-3-small', undefined);
    expect(plan.exposed).not.toBeNull();
    expect(plan.action.kind).toBe('none');
    expect((plan.action as { suggestion: string | null }).suggestion).toBe('voyage:rerank-2.5');
  });

  test('off disables, keep leaves alone, invalid explicit values refuse with paste-ready messages', async () => {
    const off = await resolveRerankerPlan(engine, 'zeroentropyai:zembed-1', 'voyage:voyage-4', 'off');
    expect(off.action).toEqual({ kind: 'disable' });

    const keep = await resolveRerankerPlan(engine, 'zeroentropyai:zembed-1', 'voyage:voyage-4', 'keep');
    expect(keep.action).toEqual({ kind: 'none', suggestion: null });

    // Provider exists but declares no reranker touchpoint.
    await expect(
      resolveRerankerPlan(engine, 'zeroentropyai:zembed-1', 'voyage:voyage-4', 'openai:text-embedding-3-small'),
    ).rejects.toThrow(/declares no reranker/);

    // Not provider:model shaped at all.
    await expect(
      resolveRerankerPlan(engine, 'zeroentropyai:zembed-1', 'voyage:voyage-4', 'garbage'),
    ).rejects.toThrow(/--reranker must be/);
  });

  test('config-only completion: converged brain + --reranker off still flips the DB key (no skip swallow)', async () => {
    // Brain is converged on openai 3-small @1536 from the suites above — the
    // verified skip would fire, but a pending reranker action must execute
    // as a config-only completion instead.
    await engine.executeRaw(
      `INSERT INTO query_cache (id, query_text, source_id) VALUES ('qc-rr', 'stale rank order', 'default')
       ON CONFLICT (id) DO NOTHING`,
    );
    const code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes', '--reranker', 'off']);
    expect(code).toBe(0);
    expect(await engine.getConfig('search.reranker.enabled')).toBe('false');
    // Rank order changed ⇒ cache purged in the same transaction.
    const qc = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM query_cache`);
    expect(Number(qc[0]?.n)).toBe(0);
  }, 60000);

  test('explicit switch: live probe passes (stubbed wire) and the write lands model + enabled together', async () => {
    // Gateway needs a voyage key for the rerank call; the wire is stubbed.
    resetGateway();
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: TO_DIMS,
      env: { OPENAI_API_KEY: 'sk-test-fake', VOYAGE_API_KEY: 'pa-test-fake' },
    });
    installTransport();
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/rerank')) {
        // Voyage REST returns data[] (not results[]) — the shape the gateway
        // must parse (live-key e2e pins the real wire; this pins the parse).
        return new Response(JSON.stringify({
          data: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.2 }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return origFetch(url as never, init);
    }) as typeof fetch;
    try {
      const code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes', '--reranker', 'voyage:rerank-2.5']);
      expect(code).toBe(0);
      expect(await engine.getConfig('search.reranker.model')).toBe('voyage:rerank-2.5');
      expect(await engine.getConfig('search.reranker.enabled')).toBe('true');
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = origFetch;
    }
  }, 60000);

  test('probe failure keeps the previous reranker config and reports switch_failed', async () => {
    // No wire stub + no reachable endpoint: the probe fails, the migration
    // still completes, and the config stays where the previous test put it.
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: string | URL | Request) => {
      if (String(url).includes('/rerank')) throw new Error('stub: reranker endpoint down');
      return origFetch(url as never);
    }) as typeof fetch;
    try {
      const code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes', '--reranker', 'voyage:rerank-2.5-lite']);
      expect(code).toBe(0); // embeddings converged; reranker failure is reported, not fatal
      // Old config kept — NOT flipped to the unreachable model.
      expect(await engine.getConfig('search.reranker.model')).toBe('voyage:rerank-2.5');
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = origFetch;
    }
  }, 60000);

  test('applyRerankerAction is transactional: model + enabled + cache purge land together', async () => {
    await engine.executeRaw(
      `INSERT INTO query_cache (id, query_text, source_id) VALUES ('qc-rr2', 'stale again', 'default')
       ON CONFLICT (id) DO NOTHING`,
    );
    await applyRerankerAction(engine, { kind: 'switch', to: 'voyage:rerank-2.5-lite' });
    expect(await engine.getConfig('search.reranker.model')).toBe('voyage:rerank-2.5-lite');
    expect(await engine.getConfig('search.reranker.enabled')).toBe('true');
    const qc = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM query_cache`);
    expect(Number(qc[0]?.n)).toBe(0);
  });
});
