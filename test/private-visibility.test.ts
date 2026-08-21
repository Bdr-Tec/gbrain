/**
 * #4352 — page-level `visibility: private` enforcement for untrusted callers.
 *
 * Pages have persisted `frontmatter.visibility` forever, but no read path
 * enforced it: a remote/MCP caller could pull a private page through search,
 * recall's query arm, entity cards, and context_pack. Pins:
 *   - buildVisibilityClause emits the predicate only when excludePrivate
 *   - engines (PGLite here; SQL identical in postgres-engine — parity pinned
 *     by the shared buildVisibilityClause builder) filter private pages on
 *     searchKeyword / searchTitles / searchKeywordChunks when the flag is set
 *   - resolveExcludePrivatePages: trust rules + config gate + env hatch
 *   - recall (query arm) as a remote ctx hides private pages; local sees them
 *   - buildEntityCard (entity/context_pack/delta) hides private cards remotely
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildVisibilityClause } from '../src/core/search/sql-ranking.ts';
import {
  resolveExcludePrivatePages,
  __resetPrivateVisibilityCacheForTests,
  REMOTE_PRIVATE_PAGES_KEY,
} from '../src/core/search/private-visibility.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import { operationsByName } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('notes/world-page', {
    title: 'Zebra Widget World',
    type: 'concept',
    frontmatter: { visibility: 'world' },
    compiled_truth: 'zebra widget public knowledge body',
    timeline: '',
  });
  await engine.putPage('notes/private-page', {
    title: 'Zebra Widget Private',
    type: 'concept',
    frontmatter: { visibility: 'private' },
    compiled_truth: 'zebra widget secret private knowledge body',
    timeline: '',
  });
  // No visibility key at all → defaults to world (visible everywhere).
  await engine.putPage('notes/unmarked-page', {
    title: 'Zebra Widget Unmarked',
    type: 'concept',
    frontmatter: {},
    compiled_truth: 'zebra widget unmarked knowledge body',
    timeline: '',
  });
  // putPage doesn't chunk; the keyword/chunk arms search content_chunks.
  for (const [slug, body] of [
    ['notes/world-page', 'zebra widget public knowledge body'],
    ['notes/private-page', 'zebra widget secret private knowledge body'],
    ['notes/unmarked-page', 'zebra widget unmarked knowledge body'],
  ] as const) {
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' },
    ]);
  }
});

afterAll(async () => {
  await engine.disconnect();
});

describe('buildVisibilityClause (#4352)', () => {
  test('default: no private predicate (pre-fix SQL preserved byte-for-byte)', () => {
    const clause = buildVisibilityClause('p', 's');
    expect(clause).not.toContain('visibility');
    expect(clause).toContain('p.deleted_at IS NULL');
  });

  test('excludePrivate: adds the COALESCE predicate', () => {
    const clause = buildVisibilityClause('p', 's', { excludePrivate: true });
    expect(clause).toContain(`COALESCE(p.frontmatter->>'visibility', 'world') <> 'private'`);
  });
});

describe('engine search paths honor excludePrivate (#4352)', () => {
  for (const method of ['searchKeyword', 'searchTitles', 'searchKeywordChunks'] as const) {
    test(`${method}: private page hidden with flag, visible without`, async () => {
      const withFlag = await engine[method]('zebra widget', { limit: 20, excludePrivate: true });
      const withoutFlag = await engine[method]('zebra widget', { limit: 20 });
      const slugsWith = withFlag.map((r) => r.slug);
      const slugsWithout = withoutFlag.map((r) => r.slug);
      expect(slugsWith).not.toContain('notes/private-page');
      expect(slugsWith).toContain('notes/world-page');
      // Absent visibility defaults to world — still visible under the flag.
      expect(slugsWith).toContain('notes/unmarked-page');
      // Trusted path unchanged: private page still retrievable.
      expect(slugsWithout).toContain('notes/private-page');
    });
  }
});

describe('resolveExcludePrivatePages gate (#4352)', () => {
  test('trusted local (remote === false) never excludes', async () => {
    __resetPrivateVisibilityCacheForTests();
    expect(await resolveExcludePrivatePages(engine, false)).toBe(false);
  });

  test('remote/undefined excludes by default (fail-closed)', async () => {
    __resetPrivateVisibilityCacheForTests();
    expect(await resolveExcludePrivatePages(engine, true)).toBe(true);
    expect(await resolveExcludePrivatePages(engine, undefined)).toBe(true);
  });

  test('config opt-out disables enforcement', async () => {
    await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, 'visible');
    __resetPrivateVisibilityCacheForTests();
    expect(await resolveExcludePrivatePages(engine, true)).toBe(false);
    await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, '');
    __resetPrivateVisibilityCacheForTests();
    expect(await resolveExcludePrivatePages(engine, true)).toBe(true);
  });

  test('GBRAIN_REMOTE_PRIVATE_PAGES=1 env escape hatch disables enforcement', async () => {
    __resetPrivateVisibilityCacheForTests();
    process.env.GBRAIN_REMOTE_PRIVATE_PAGES = '1';
    try {
      expect(await resolveExcludePrivatePages(engine, true)).toBe(false);
    } finally {
      delete process.env.GBRAIN_REMOTE_PRIVATE_PAGES;
    }
  });
});

describe('recall query arm (#4352)', () => {
  function mkCtx(remote: boolean) {
    return {
      engine,
      config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote,
      sourceId: 'default',
    } as never;
  }

  test('remote recall with query hides private pages; local sees them', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['recall'];
    // Test env strips provider keys → keyword-only search arm.
    const remoteOut = (await op.handler(mkCtx(true), { query: 'zebra widget' })) as {
      results: Array<{ slug: string }>;
    };
    const remoteSlugs = (remoteOut.results ?? []).map((r) => r.slug);
    expect(remoteSlugs).not.toContain('notes/private-page');
    expect(remoteSlugs).toContain('notes/world-page');

    const localOut = (await op.handler(mkCtx(false), { query: 'zebra widget' })) as {
      results: Array<{ slug: string }>;
    };
    const localSlugs = (localOut.results ?? []).map((r) => r.slug);
    expect(localSlugs).toContain('notes/private-page');
  });
});

describe('entity card (#4352 — covers entity/context_pack/delta)', () => {
  test('remote card lookup cannot resolve a private page', async () => {
    __resetPrivateVisibilityCacheForTests();
    const remoteRes = await buildEntityCard(engine, 'default', 'Zebra Widget Private', { remote: true });
    expect(remoteRes.found ? remoteRes.card?.entity.slug : null).not.toBe('notes/private-page');

    const localRes = await buildEntityCard(engine, 'default', 'Zebra Widget Private', { remote: false });
    expect(localRes.found).toBe(true);
    expect(localRes.card?.entity.slug).toBe('notes/private-page');
  });
});

describe('page read ops (#4352 remediation — list_pages / get_page / fetch)', () => {
  function mkCtx(remote: boolean) {
    return {
      engine,
      config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote,
      sourceId: 'default',
    } as never;
  }

  test('list_pages: remote listing omits private pages; local enumerates them', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['list_pages'];
    const remoteRows = (await op.handler(mkCtx(true), { limit: 100 })) as Array<{ slug: string }>;
    const remoteSlugs = remoteRows.map((r) => r.slug);
    expect(remoteSlugs).not.toContain('notes/private-page');
    expect(remoteSlugs).toContain('notes/world-page');
    // Absent visibility defaults to world — still listed remotely.
    expect(remoteSlugs).toContain('notes/unmarked-page');

    const localRows = (await op.handler(mkCtx(false), { limit: 100 })) as Array<{ slug: string }>;
    expect(localRows.map((r) => r.slug)).toContain('notes/private-page');
  });

  test('get_page: remote read of a private page is page_not_found; local reads the body', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['get_page'];
    await expect(op.handler(mkCtx(true), { slug: 'notes/private-page' })).rejects.toThrow(/Page not found/);
    // No over-blocking: world pages stay readable remotely.
    const world = (await op.handler(mkCtx(true), { slug: 'notes/world-page' })) as { slug: string };
    expect(world.slug).toBe('notes/world-page');

    const local = (await op.handler(mkCtx(false), { slug: 'notes/private-page' })) as { compiled_truth: string };
    expect(local.compiled_truth).toContain('secret');
  });

  test('get_page fuzzy: remote fuzzy resolution cannot surface a private page; local can', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['get_page'];
    await expect(
      op.handler(mkCtx(true), { slug: 'notes/private-pag', fuzzy: true }),
    ).rejects.toThrow(/Page not found/);

    const local = (await op.handler(mkCtx(false), { slug: 'notes/private-pag', fuzzy: true })) as { slug: string };
    expect(local.slug).toBe('notes/private-page');
  });

  test('fetch: remote fetch of a private page is page_not_found; local returns full text', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['fetch'];
    await expect(op.handler(mkCtx(true), { id: 'notes/private-page' })).rejects.toThrow(/Page not found/);

    const local = (await op.handler(mkCtx(false), { id: 'notes/private-page' })) as { text: string };
    expect(local.text).toContain('secret');
  });

  test('config opt-out restores remote reads on all three ops', async () => {
    await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, 'visible');
    __resetPrivateVisibilityCacheForTests();
    try {
      const got = (await operationsByName['get_page'].handler(mkCtx(true), { slug: 'notes/private-page' })) as { slug: string };
      expect(got.slug).toBe('notes/private-page');
      const rows = (await operationsByName['list_pages'].handler(mkCtx(true), { limit: 100 })) as Array<{ slug: string }>;
      expect(rows.map((r) => r.slug)).toContain('notes/private-page');
      const fetched = (await operationsByName['fetch'].handler(mkCtx(true), { id: 'notes/private-page' })) as { id: string };
      expect(fetched.id).toBe('notes/private-page');
    } finally {
      await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, '');
      __resetPrivateVisibilityCacheForTests();
    }
  });
});
