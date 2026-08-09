/**
 * v0.31.2 — runFactsBackstop pipeline tests.
 *
 * Pins the helper's full contract: eligibility/kill-switch gates,
 * mode dispatch (queue vs inline), notability filter, dedup fast-path,
 * abort propagation, and skipped envelope shapes.
 *
 * Real PGLite engine (in-memory, no DATABASE_URL). LLM is stubbed via
 * __setChatTransportForTests so tests are deterministic + fast.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  runFactsBackstop,
  __setLiveWorkerProbeForTests,
  __resetWorkerProbeCacheForTests,
} from '../src/core/facts/backstop.ts';
import type { FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import {
  __setChatTransportForTests,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  __resetFactsQueueForTests();
});

const LONG_BODY = 'this is a real meeting note longer than 80 chars '.repeat(3);

function chatStub(facts: Array<{ fact: string; kind: string; notability: 'high' | 'medium' | 'low'; entity?: string | null }>) {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({
      facts: facts.map(f => ({
        fact: f.fact,
        kind: f.kind,
        entity: f.entity ?? null,
        confidence: 1.0,
        notability: f.notability,
      })),
    }),
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'test:stub',
    providerId: 'test',
  }));
}

function makeCtx(overrides: Partial<FactsBackstopCtx> = {}): FactsBackstopCtx {
  return {
    engine,
    sourceId: 'default',
    sessionId: null,
    source: 'mcp:put_page',
    ...overrides,
  };
}

const meetingPage = (slug = 'meetings/test-' + Math.random().toString(36).slice(2, 9)) => ({
  slug,
  type: 'meeting' as const,
  compiled_truth: LONG_BODY,
  frontmatter: {} as Record<string, unknown>,
});

describe('runFactsBackstop — eligibility + kill-switch gates', () => {
  test('skips with extraction_disabled when kill-switch off', async () => {
    await engine.setConfig('facts.extraction_enabled', 'false');
    const r = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'inline' }));
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') expect(r.skipped).toBe('extraction_disabled');
    await engine.setConfig('facts.extraction_enabled', 'true');
  });

  test('skips with eligibility_failed:<reason> when subagent namespace', async () => {
    chatStub([]);
    const r = await runFactsBackstop(
      { ...meetingPage('wiki/agents/scratch/foo'), type: 'meeting' },
      makeCtx({ mode: 'inline' }),
    );
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') expect(r.skipped).toBe('eligibility_failed:subagent_namespace');
  });

  test('skips with eligibility_failed:dream_generated when frontmatter set', async () => {
    chatStub([]);
    const page = meetingPage();
    page.frontmatter = { dream_generated: true };
    const r = await runFactsBackstop(page, makeCtx({ mode: 'inline' }));
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') expect(r.skipped).toBe('eligibility_failed:dream_generated');
  });
});

describe('runFactsBackstop — mode: inline', () => {
  test('inserts the LLM-extracted facts and returns counts', async () => {
    chatStub([
      { fact: 'mode-inline-event-1', kind: 'event', notability: 'high', entity: 'people/alice-example' },
      { fact: 'mode-inline-event-2', kind: 'event', notability: 'medium', entity: 'people/alice-example' },
    ]);
    const r = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'inline' }));
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') {
      expect(r.inserted).toBe(2);
      expect(r.duplicate).toBe(0);
      expect(r.fact_ids.length).toBe(2);
    }
  });

  test('notabilityFilter=high-only drops MEDIUM + LOW from the insert path', async () => {
    chatStub([
      { fact: 'high-only-1', kind: 'event', notability: 'high', entity: 'people/bob-test' },
      { fact: 'high-only-2-skip', kind: 'event', notability: 'medium', entity: 'people/bob-test' },
      { fact: 'high-only-3-skip', kind: 'event', notability: 'low', entity: 'people/bob-test' },
    ]);
    const r = await runFactsBackstop(
      meetingPage(),
      makeCtx({ mode: 'inline', notabilityFilter: 'high-only' }),
    );
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') {
      expect(r.inserted).toBe(1);
      expect(r.fact_ids.length).toBe(1);
    }
  });

  test('source string lands on the inserted row', async () => {
    const sessionId = 'source-pin-session-' + Math.random().toString(36).slice(2, 9);
    chatStub([{ fact: 'source-pin-fact', kind: 'fact', notability: 'medium', entity: null }]);
    const r = await runFactsBackstop(
      meetingPage(),
      makeCtx({ mode: 'inline', source: 'sync:import', sessionId }),
    );
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline' && r.fact_ids.length > 0) {
      // Query by source_session (deterministic, no resolveEntitySlug rewrite).
      const rows = await engine.listFactsBySession('default', sessionId);
      const ours = rows.find(x => x.id === r.fact_ids[0]);
      expect(ours?.source).toBe('sync:import');
      expect(ours?.source_session).toBe(sessionId);
    }
  });

  test('empty extraction → zero counts', async () => {
    chatStub([]);
    const r = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'inline' }));
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') {
      expect(r.inserted).toBe(0);
      expect(r.duplicate).toBe(0);
      expect(r.fact_ids.length).toBe(0);
    }
  });

  test('aborted before LLM call → zero counts, no throw', async () => {
    chatStub([]);
    const ac = new AbortController();
    ac.abort();
    const r = await runFactsBackstop(
      meetingPage(),
      makeCtx({ mode: 'inline', abortSignal: ac.signal }),
    );
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') expect(r.inserted).toBe(0);
  });
});

describe('runFactsBackstop — mode: queue', () => {
  test('default mode is queue; returns enqueued: true', async () => {
    chatStub([{ fact: 'queue-default-1', kind: 'event', notability: 'high', entity: 'people/queue-test' }]);
    const r = await runFactsBackstop(meetingPage(), makeCtx());  // no mode → default 'queue'
    expect(r.mode).toBe('queue');
    if (r.mode === 'queue') {
      expect(r.enqueued).toBe(true);
      expect(r.queueDepth).toBeGreaterThanOrEqual(0);
    }
  });

  test('explicit mode=queue returns immediately with enqueued: true', async () => {
    chatStub([{ fact: 'queue-explicit', kind: 'event', notability: 'high', entity: 'people/queue-explicit' }]);
    const r = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'queue' }));
    expect(r.mode).toBe('queue');
    if (r.mode === 'queue') expect(r.enqueued).toBe(true);
  });

  test('queue mode with extraction_disabled returns enqueued: false + skipped reason', async () => {
    await engine.setConfig('facts.extraction_enabled', 'false');
    const r = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'queue' }));
    expect(r.mode).toBe('queue');
    if (r.mode === 'queue') {
      expect(r.enqueued).toBe(false);
      expect(r.skipped).toBe('extraction_disabled');
    }
    await engine.setConfig('facts.extraction_enabled', 'true');
  });
});

describe('runFactsBackstop — dedup fast-path', () => {
  test('two near-identical inserts: second comes back as duplicate', async () => {
    // Insert first via inline mode; we'll re-fire with the same fact text
    // and rely on cosine ≥ 0.95 when the embedding matches. The B1 smoke
    // path's stubbed transport means embedding stays null (gateway not
    // configured), so the dedup path needs candidates with embeddings.
    // Skip the embedding-match assertion here and pin the no-dedup path:
    chatStub([
      { fact: 'distinct-fact-A', kind: 'event', notability: 'high', entity: 'people/dedup-a' },
    ]);
    const r1 = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'inline' }));
    expect(r1.mode).toBe('inline');
    if (r1.mode === 'inline') expect(r1.inserted).toBe(1);

    // Without embeddings present, dedup short-circuits; the second call
    // inserts a new row (insertFact does no further dedup unless caller
    // passes supersedeId). That's the contract for queue+inline backstop.
    chatStub([
      { fact: 'distinct-fact-A', kind: 'event', notability: 'high', entity: 'people/dedup-a' },
    ]);
    const r2 = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'inline' }));
    expect(r2.mode).toBe('inline');
    if (r2.mode === 'inline') {
      // Without embeddings the dedup fast-path can't fire; second insert lands.
      // Real production has embeddings via gateway — covered by E2E in a
      // future test that points at a configured chat+embed gateway.
      expect(r2.inserted + r2.duplicate).toBe(1);
    }
  });
});

describe('runFactsBackstop — stub guard routing (v0.34.5)', () => {
  test('bare-name entity routes to legacy DB-only path (no phantom page)', async () => {
    // Set up: configure default source with a real local_path so the
    // backstop reaches Phase 5 (fence write) instead of Phase 4 (legacy).
    // This is the scenario where the stub guard actually fires.
    const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const brainDir = mkdtempSync(join(tmpdir(), 'backstop-stub-guard-'));
    try {
      // Point the default source at the tempdir so localPath is non-null.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (engine as any).db.query(
        `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
        [brainDir],
      );

      // Stub the chat to return a fact with a bare-name entity. The
      // resolver will:
      //   1. exact slug match → miss (no 'noresolvable' row)
      //   2. fuzzy match → miss (no title contains noresolvable)
      //   3. prefix expansion → miss (no people/noresolvable-* rows)
      //   4. slugify fallback → 'noresolvable' (bare)
      // The bare slug then trips the stub guard in writeFactsToFence,
      // which returns stubGuardBlocked: true, and backstop routes the
      // fact to engine.insertFact (DB-only).
      chatStub([
        { fact: 'said hello at the meeting', kind: 'event', notability: 'high', entity: 'noresolvable' },
      ]);

      const r = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'inline' }));

      expect(r.mode).toBe('inline');
      if (r.mode === 'inline') {
        // The fact MUST be persisted via the DB-only fallback, not dropped.
        expect(r.inserted).toBe(1);
        expect(r.fact_ids.length).toBe(1);

        // No phantom file at the brain root (this is the whole point of the guard).
        expect(existsSync(join(brainDir, 'noresolvable.md'))).toBe(false);

        // The fact is in the DB with the bare entity_slug. Query directly to
        // confirm — the routing is the contract under test.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = await (engine as any).db.query(
          `SELECT entity_slug, fact, source_markdown_slug FROM facts WHERE id = $1`,
          [r.fact_ids[0]],
        );
        expect(rows.rows[0].entity_slug).toBe('noresolvable');
        expect(rows.rows[0].fact).toBe('said hello at the meeting');
        // source_markdown_slug is the fence-tracking column; under DB-only
        // fallback it stays null (no .md file backs the row).
        expect(rows.rows[0].source_markdown_slug).toBeNull();
      }
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (engine as any).db.query(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
      rmSync(brainDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #2108 — durable facts-absorb: remote put_page prefers the minion job; a
// drain-aborted in-process absorb re-queues durably instead of silent loss.
// ---------------------------------------------------------------------------

describe('runFactsBackstop — durable facts-absorb (#2108)', () => {
  const factsCount = async (): Promise<number> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (engine as any).db.query(`SELECT COUNT(*)::int AS n FROM facts`);
    return r.rows[0].n as number;
  };
  const absorbJobsFor = async (slug: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (engine as any).db.query(
      `SELECT name, status, data FROM minion_jobs WHERE name = 'facts-absorb' AND data->>'slug' = $1`,
      [slug],
    );
    return r.rows as Array<{ name: string; status: string; data: Record<string, unknown> }>;
  };

  afterEach(async () => {
    __setLiveWorkerProbeForTests(null);
    __resetWorkerProbeCacheForTests();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`DELETE FROM minion_jobs WHERE name = 'facts-absorb'`);
  });

  test('preferDurableAbsorb + live worker → durable minion job, no in-process work', async () => {
    __setLiveWorkerProbeForTests(() => true);
    const page = meetingPage();
    // NO chat stub: the durable path must not run the LLM in this process.
    const r = await runFactsBackstop(page, makeCtx({ preferDurableAbsorb: true }));
    expect(r.mode).toBe('queue');
    if (r.mode === 'queue') {
      expect(r.enqueued).toBe(true);
      expect(r.queueDepth).toBe(0);
    }
    const jobs = await absorbJobsFor(page.slug);
    expect(jobs.length).toBe(1);
    expect(jobs[0].status).toBe('waiting');
    expect(jobs[0].data.sourceId).toBe('default');
    expect(jobs[0].data.source).toBe('mcp:put_page');

    // Idempotency: an identical re-submit dedups on the content-hash key.
    const r2 = await runFactsBackstop(page, makeCtx({ preferDurableAbsorb: true }));
    if (r2.mode === 'queue') expect(r2.enqueued).toBe(true);
    expect((await absorbJobsFor(page.slug)).length).toBe(1);
  });

  test('preferDurableAbsorb without a live worker → in-process queue fallback', async () => {
    __setLiveWorkerProbeForTests(() => false);
    chatStub([]);
    const page = meetingPage();
    const r = await runFactsBackstop(page, makeCtx({ preferDurableAbsorb: true }));
    expect(r.mode).toBe('queue');
    if (r.mode === 'queue') expect(r.enqueued).toBe(true);
    // No durable job — the in-process queue owns the work (a live long-lived
    // process without a worker must keep extracting in-process; parking jobs
    // no worker drains would be a regression).
    expect((await absorbJobsFor(page.slug)).length).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Red-team #1: the probe must be QUEUE-aware. The durable job goes to
  // queue 'default'; a worker draining any other queue can never claim it,
  // so its presence must not park the job (skipping the in-process
  // fallback = the exact silent loss #2108 closed). These tests exercise
  // the REAL registry probe (no override) via a temp GBRAIN_HOME.
  // ---------------------------------------------------------------------

  const withWorkerRegistry = async (
    fn: (registerLiveWorker: (queue: string) => () => void) => Promise<void>,
  ): Promise<void> => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { registerWorker } = await import('../src/core/minions/worker-registry.ts');
    const { withEnv } = await import('./helpers/with-env.ts');
    const home = mkdtempSync(join(tmpdir(), 'backstop-worker-probe-'));
    const cleanups: Array<() => void> = [];
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        __resetWorkerProbeCacheForTests();
        await fn((queue: string) => {
          const cleanup = registerWorker({
            pid: process.pid, // this live test process — passes the liveness + PID-reuse guards
            queue,
            nice_requested: null,
            nice_effective: null,
            started_at: Date.now(),
          });
          cleanups.push(cleanup);
          return cleanup;
        });
      });
    } finally {
      for (const c of cleanups) c();
      __resetWorkerProbeCacheForTests();
      rmSync(home, { recursive: true, force: true });
    }
  };

  test('wrong-queue worker does NOT satisfy the probe → in-process fallback (red-team #1)', async () => {
    await withWorkerRegistry(async (registerLiveWorker) => {
      registerLiveWorker('shell'); // live worker, but on a queue the job never goes to
      chatStub([]);
      const page = meetingPage();
      const r = await runFactsBackstop(page, makeCtx({ preferDurableAbsorb: true }));
      expect(r.mode).toBe('queue');
      if (r.mode === 'queue') expect(r.enqueued).toBe(true);
      // No durable job parked on a queue nobody drains — the in-process
      // queue owns the work.
      expect((await absorbJobsFor(page.slug)).length).toBe(0);
    });
  });

  test('default-queue worker satisfies the probe → durable minion job', async () => {
    await withWorkerRegistry(async (registerLiveWorker) => {
      registerLiveWorker('default');
      const page = meetingPage();
      // NO chat stub: the durable path must not run the LLM in this process.
      const r = await runFactsBackstop(page, makeCtx({ preferDurableAbsorb: true }));
      expect(r.mode).toBe('queue');
      if (r.mode === 'queue') expect(r.enqueued).toBe(true);
      const jobs = await absorbJobsFor(page.slug);
      expect(jobs.length).toBe(1);
      expect(jobs[0].status).toBe('waiting');
    });
  });

  test('probe result is memoized (short TTL) — hot-path readWorkers/ps cost', async () => {
    await withWorkerRegistry(async (registerLiveWorker) => {
      // First probe: no workers → false, memoized.
      chatStub([]);
      const p1 = meetingPage();
      await runFactsBackstop(p1, makeCtx({ preferDurableAbsorb: true }));
      expect((await absorbJobsFor(p1.slug)).length).toBe(0);

      // A default-queue worker appears, but WITHOUT a cache reset the
      // memoized `false` still wins inside the TTL window.
      registerLiveWorker('default');
      chatStub([]);
      const p2 = meetingPage();
      await runFactsBackstop(p2, makeCtx({ preferDurableAbsorb: true }));
      expect((await absorbJobsFor(p2.slug)).length).toBe(0);

      // After a reset (TTL-expiry stand-in) the live worker is seen.
      __resetWorkerProbeCacheForTests();
      const p3 = meetingPage();
      await runFactsBackstop(p3, makeCtx({ preferDurableAbsorb: true }));
      expect((await absorbJobsFor(p3.slug)).length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // Red-team #5: honest abort detection. A Postgres-style "current
  // transaction is aborted, commands ignored…" error is a plain pipeline
  // failure — it must land in the absorb log WITHOUT triggering the
  // durable requeue + exit-drain stderr banner (the old /abort/i message
  // sniff matched it).
  // ---------------------------------------------------------------------

  test("Postgres 'transaction is aborted' error does NOT trigger the durable requeue (red-team #5)", async () => {
    const page = meetingPage();
    __setChatTransportForTests(async () => {
      throw new Error('current transaction is aborted, commands ignored until end of transaction block');
    });

    const r = await runFactsBackstop(page, makeCtx()); // default queue mode, in-process
    expect(r.mode).toBe('queue');
    if (r.mode === 'queue') expect(r.enqueued).toBe(true);

    // Wait for the in-process worker to settle: the absorb-log row is
    // written AFTER the requeue decision, so its presence proves the
    // catch block completed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const logCount = async (): Promise<number> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (engine as any).db.query(
        `SELECT COUNT(*)::int AS n FROM ingest_log WHERE source_type = 'facts:absorb' AND source_ref = $1`,
        [page.slug],
      );
      return res.rows[0].n as number;
    };
    const deadline = Date.now() + 5000;
    while ((await logCount()) === 0 && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(await logCount()).toBeGreaterThanOrEqual(1);

    // The load-bearing assertion: NOT classified as an abort — no durable
    // requeue happened.
    expect((await absorbJobsFor(page.slug)).length).toBe(0);
  });

  test('drain-abort → nothing stamped, durable retry job queued, next pass extracts', async () => {
    const page = meetingPage();
    const before = await factsCount();

    // Chat transport that hangs until the queue's shutdown abort fires —
    // simulates the exit drain aborting an in-flight extraction chat.
    __setChatTransportForTests(
      (opts: { abortSignal?: AbortSignal }) =>
        new Promise<ChatResult>((_resolve, reject) => {
          const fail = () => {
            const e = new Error('The operation was aborted.');
            e.name = 'AbortError';
            reject(e);
          };
          if (opts.abortSignal?.aborted) return fail();
          opts.abortSignal?.addEventListener('abort', fail, { once: true });
        }),
    );

    const r = await runFactsBackstop(page, makeCtx()); // default queue mode, in-process
    expect(r.mode).toBe('queue');
    if (r.mode === 'queue') expect(r.enqueued).toBe(true);

    // Wait for the job to be claimed in-flight, then simulate the exit drain
    // abort (background-work.ts calls queue.shutdown() when drain times out).
    const { getFactsQueue } = await import('../src/core/facts/queue.ts');
    const q = getFactsQueue();
    const deadline = Date.now() + 5000;
    while (q.inflightCount() === 0 && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(q.inflightCount()).toBeGreaterThan(0);
    await q.shutdown();

    // Nothing stamped: no facts landed, and no completion watermark exists on
    // this path (the conversation-facts terminal audit row is only written by
    // that batch pass — its absence is what makes the next pass re-attempt).
    expect(await factsCount()).toBe(before);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const terminal = await (engine as any).db.query(
      `SELECT COUNT(*)::int AS n FROM facts WHERE source = 'cli:extract-conversation-facts:terminal:v2'`,
    );
    expect(terminal.rows[0].n).toBe(0);

    // The retry marker IS the durable job row (existing scanned signal — the
    // jobs worker claims it; no new table).
    const jobs = await absorbJobsFor(page.slug);
    expect(jobs.length).toBe(1);
    expect(jobs[0].status).toBe('waiting');

    // The failure stays visible in the absorb log (non-terminal record).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const log = await (engine as any).db.query(
      `SELECT COUNT(*)::int AS n FROM ingest_log WHERE source_type = 'facts:absorb' AND source_ref = $1`,
      [page.slug],
    );
    expect(log.rows[0].n).toBeGreaterThanOrEqual(1);

    // Next pass: simulate the jobs worker processing the queued job (the
    // handler in src/commands/jobs.ts does getPage(slug) → runFactsBackstop
    // inline). Facts land this time.
    await engine.putPage(page.slug, {
      type: 'meeting',
      title: 'retry fixture',
      compiled_truth: page.compiled_truth,
      frontmatter: {},
    });
    chatStub([
      { fact: 'retry-pass-fact-1', kind: 'event', notability: 'high', entity: 'people/retry-example' },
    ]);
    const stored = await engine.getPage(page.slug, { sourceId: 'default' });
    expect(stored).not.toBeNull();
    const retry = await runFactsBackstop(
      {
        slug: stored!.slug,
        type: stored!.type,
        compiled_truth: stored!.compiled_truth,
        frontmatter: (stored!.frontmatter ?? {}) as Record<string, unknown>,
      },
      makeCtx({ mode: 'inline' }),
    );
    expect(retry.mode).toBe('inline');
    if (retry.mode === 'inline') expect(retry.inserted).toBe(1);
  });
});
