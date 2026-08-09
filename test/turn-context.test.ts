/**
 * Turn-context assembly tests (agent-bootstrap plan: S3#1 visibility fence,
 * ENG-1 8KB budget, ENG-11 hot-memory cache reuse, CX-P1.2 subordinate
 * envelope, CX2-11 typed session identity + two-session cache isolation).
 *
 * Hermetic in-memory PGLite; engine-agnostic assembly (no engine-specific SQL
 * in the module under test).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  assembleTurnContext,
  TURN_CONTEXT_ENVELOPE,
  TURN_CONTEXT_DEFAULT_MAX_BYTES,
} from '../src/core/context/turn-context.ts';
import {
  getBrainHotMemoryMeta,
  bumpHotMemoryCache,
  __resetHotMemoryCacheForTests,
} from '../src/core/facts/meta-hook.ts';
import { buildOperationContext } from '../src/mcp/dispatch.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  __resetHotMemoryCacheForTests();
  await engine.executeRaw('DELETE FROM page_aliases').catch(() => {});
  await engine.executeRaw('DELETE FROM facts').catch(() => {});
  await engine.executeRaw('DELETE FROM pages').catch(() => {});
});

async function seedPage(slug: string, title: string, body: string) {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES ($1, 'default', 'person', $2, $3, '')`,
    [slug, title, body],
  );
}

async function seedFact(fact: string, visibility: 'private' | 'world', opts: { session?: string; entity?: string } = {}) {
  await engine.insertFact(
    {
      fact,
      kind: 'fact',
      entity_slug: opts.entity ?? 'people/alice-example',
      source: 'test',
      visibility,
      source_session: opts.session ?? null,
    },
    { source_id: 'default' },
  );
}

describe('assembleTurnContext', () => {
  test('envelope first, pointers + world facts in; private facts NEVER [CX-P1.2, S3#1]', async () => {
    await seedPage('people/alice-example', 'Alice Example', 'Alice Example is a founder at acme-example.');
    await seedFact('WORLD-FACT alice prefers async updates', 'world');
    await seedFact('PRIVATE-FACT sensitive valuation note', 'private');

    const r = await assembleTurnContext(engine, {
      sourceId: 'default',
      window: [{ role: 'user', text: 'catching up with Alice Example tomorrow' }],
    });

    expect(r.text.startsWith(TURN_CONTEXT_ENVELOPE)).toBe(true);
    expect(r.pointers.length).toBe(1);
    expect(r.pointers[0].slug).toBe('people/alice-example');
    expect(r.text).toContain('people/alice-example');
    expect(r.text).toContain('WORLD-FACT');
    expect(r.text).not.toContain('PRIVATE-FACT');
    expect(r.text).not.toContain('sensitive valuation note');
    expect(r.factsCount).toBe(1);
    expect(r.degradedReason).toBeUndefined();
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(TURN_CONTEXT_DEFAULT_MAX_BYTES);
  });

  test('volunteer section dedupes against reflex pointers (slug appears once)', async () => {
    await seedPage('people/alice-example', 'Alice Example', 'Alice Example founder profile.');
    const r = await assembleTurnContext(engine, {
      sourceId: 'default',
      window: [
        { role: 'user', text: 'Alice Example pinged me' },
        { role: 'assistant', text: 'noted — Alice Example wants a follow-up' },
      ],
    });
    const hits = r.text.split('`people/alice-example`').length - 1;
    expect(hits).toBe(1);
  });

  test('budget trims facts BEFORE pointers, lowest confidence first [ENG-1]', async () => {
    await seedPage('people/alice-example', 'Alice Example', 'Alice Example founder profile.');
    for (let i = 0; i < 8; i++) {
      await seedFact(`WORLD-FACT-${i} ${'detail '.repeat(20)}`, 'world');
    }
    const maxBytes = 500;
    const r = await assembleTurnContext(engine, {
      sourceId: 'default',
      window: [{ role: 'user', text: 'sync with Alice Example' }],
      maxBytes,
    });
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(maxBytes);
    expect(r.degradedReason).toBe('budget_trimmed');
    // The pointer survives — facts absorb the trim first.
    expect(r.pointers.length).toBe(1);
    expect(r.text).toContain('people/alice-example');
    expect(r.factsCount).toBeLessThan(8);
  });

  test('absurdly small budget → empty text rather than a broken envelope', async () => {
    await seedPage('people/alice-example', 'Alice Example', 'Alice Example founder profile.');
    const r = await assembleTurnContext(engine, {
      sourceId: 'default',
      window: [{ role: 'user', text: 'ping Alice Example' }],
      maxBytes: 10,
    });
    expect(r.text).toBe('');
    expect(r.degradedReason).toBe('budget_trimmed');
  });

  test('empty window still serves the hot-memory digest (session-start case)', async () => {
    await seedFact('WORLD-FACT standup moved to 9am', 'world');
    const r = await assembleTurnContext(engine, { sourceId: 'default', window: [] });
    expect(r.pointers.length).toBe(0);
    expect(r.factsCount).toBe(1);
    expect(r.text).toContain('WORLD-FACT standup moved to 9am');
    expect(r.text.startsWith(TURN_CONTEXT_ENVELOPE)).toBe(true);
  });

  test('nothing to inject → empty text, zero counts, no degradation', async () => {
    const r = await assembleTurnContext(engine, {
      sourceId: 'default',
      window: [{ role: 'user', text: 'no entities here, just vibes' }],
    });
    expect(r.text).toBe('');
    expect(r.pointers.length).toBe(0);
    expect(r.factsCount).toBe(0);
    expect(r.degradedReason).toBeUndefined();
  });
});

describe('session cache isolation [CX2-11]', () => {
  function metaCtx(sessionId?: string): OperationContext {
    return {
      engine,
      config: {} as GBrainConfig,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: true,
      sourceId: 'default',
      sessionId,
      takesHoldersAllowList: ['world'],
    };
  }

  test('two sessions on one source cache DIFFERENT fact sets per session key', async () => {
    await seedFact('SESSION-A-FACT prefers morning meetings', 'world', { session: 'sess-a' });
    await seedFact('SESSION-B-FACT prefers evening meetings', 'world', { session: 'sess-b' });

    const a = await getBrainHotMemoryMeta('get_stats', metaCtx('sess-a'));
    const b = await getBrainHotMemoryMeta('get_stats', metaCtx('sess-b'));
    const aFacts = (a!.brain_hot_memory as { facts: Array<{ fact: string }> }).facts.map((f) => f.fact);
    const bFacts = (b!.brain_hot_memory as { facts: Array<{ fact: string }> }).facts.map((f) => f.fact);
    expect(aFacts).toContain('SESSION-A-FACT prefers morning meetings');
    expect(aFacts).not.toContain('SESSION-B-FACT prefers evening meetings');
    expect(bFacts).toContain('SESSION-B-FACT prefers evening meetings');
    expect(bFacts).not.toContain('SESSION-A-FACT prefers morning meetings');
    expect((a!.brain_hot_memory as { session_id: string }).session_id).toBe('sess-a');
    expect((b!.brain_hot_memory as { session_id: string }).session_id).toBe('sess-b');
  });

  test('cache entries are per-session: bumping one session leaves the other cached', async () => {
    await seedFact('SESSION-A-FACT original', 'world', { session: 'sess-a' });
    await seedFact('SESSION-B-FACT original', 'world', { session: 'sess-b' });

    // Prime both cache entries.
    await getBrainHotMemoryMeta('get_stats', metaCtx('sess-a'));
    await getBrainHotMemoryMeta('get_stats', metaCtx('sess-b'));

    // New session-A fact is invisible until session A's entry is bumped.
    await seedFact('SESSION-A-FACT fresher', 'world', { session: 'sess-a' });
    const cachedA = await getBrainHotMemoryMeta('get_stats', metaCtx('sess-a'));
    const cachedAFacts = (cachedA!.brain_hot_memory as { facts: Array<{ fact: string }> }).facts.map((f) => f.fact);
    expect(cachedAFacts).not.toContain('SESSION-A-FACT fresher'); // still cached

    bumpHotMemoryCache('default', 'sess-a');
    const freshA = await getBrainHotMemoryMeta('get_stats', metaCtx('sess-a'));
    const freshAFacts = (freshA!.brain_hot_memory as { facts: Array<{ fact: string }> }).facts.map((f) => f.fact);
    expect(freshAFacts).toContain('SESSION-A-FACT fresher');

    // Session B's cached entry was untouched by the session-A bump.
    const stillB = await getBrainHotMemoryMeta('get_stats', metaCtx('sess-b'));
    const stillBFacts = (stillB!.brain_hot_memory as { facts: Array<{ fact: string }> }).facts.map((f) => f.fact);
    expect(stillBFacts).toEqual(['SESSION-B-FACT original']);
  });
});

describe('dispatch typed session identity [CX2-11]', () => {
  const fakeEngine = {} as unknown as BrainEngine;

  test('_meta.session_id inside tool arguments lands on ctx.sessionId', () => {
    const ctx = buildOperationContext(fakeEngine, { _meta: { session_id: 'topic-42' } }, { remote: true, sourceId: 'default' });
    expect(ctx.sessionId).toBe('topic-42');
  });

  test('session id is clamped to 256 chars', () => {
    const long = 'x'.repeat(300);
    const ctx = buildOperationContext(fakeEngine, { _meta: { session_id: long } }, { remote: true, sourceId: 'default' });
    expect(ctx.sessionId!.length).toBe(256);
    const viaOpts = buildOperationContext(fakeEngine, {}, { remote: true, sourceId: 'default', sessionId: long });
    expect(viaOpts.sessionId!.length).toBe(256);
  });

  test('transport-resolved opts.sessionId wins over arguments-level _meta', () => {
    const ctx = buildOperationContext(
      fakeEngine,
      { _meta: { session_id: 'from-args' } },
      { remote: true, sourceId: 'default', sessionId: 'from-transport' },
    );
    expect(ctx.sessionId).toBe('from-transport');
  });

  test('non-string / absent _meta.session_id → undefined (never a crash)', () => {
    expect(buildOperationContext(fakeEngine, {}, { sourceId: 'default' }).sessionId).toBeUndefined();
    expect(buildOperationContext(fakeEngine, { _meta: { session_id: 42 } }, { sourceId: 'default' }).sessionId).toBeUndefined();
    expect(buildOperationContext(fakeEngine, { _meta: 'nope' }, { sourceId: 'default' }).sessionId).toBeUndefined();
    expect(buildOperationContext(fakeEngine, { _meta: { session_id: '' } }, { sourceId: 'default' }).sessionId).toBeUndefined();
  });
});
