/**
 * #2544 — runAutoLink's existence check is a targeted probe, not getAllSlugs.
 *
 * Pre-fix, EVERY put_page with auto-link enabled materialized the whole
 * brain's slug set (getAllSlugs = full pages scan) just to validate a
 * handful of candidate link targets. The check now probes exactly the
 * candidate target/from slugs (`slug = ANY($1) AND source_id = $2`, the
 * proven oneshot pattern) and skips the query when there are no candidates.
 *
 * These tests pin the BEHAVIOR through put_page: resolvable references
 * still create links, references to nonexistent pages are still dropped
 * (FK-churn guard), link-free pages still reconcile to zero, and source
 * scoping still confines resolution to the write's source.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway(); // no embedding provider → put_page runs noEmbed
});

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

const putPage = operations.find((o) => o.name === 'put_page')!;

type PutResult = {
  status: string;
  auto_links?: { created: number; removed: number; errors: number } | { error: string } | { skipped: string };
};

async function put(slug: string, body: string, ctx = makeCtx()): Promise<PutResult> {
  return (await putPage.handler(ctx, {
    slug,
    content: `---\ntitle: ${slug}\n---\n\n${body}`,
  })) as PutResult;
}

describe('#2544 — auto-link behavior through put_page (targeted probe)', () => {
  test('a reference to an existing page still creates the link', async () => {
    await put('people/alice-example', 'A person page.');
    const result = await put('meetings/2026-04-03', 'Discussed roadmap with people/alice-example today.');
    expect(result.status).toBe('created_or_updated');
    const links = result.auto_links as { created: number };
    expect(links.created).toBeGreaterThanOrEqual(1);
    const rows = await engine.getLinks('meetings/2026-04-03', { sourceId: 'default' });
    expect(rows.some((l) => l.to_slug === 'people/alice-example')).toBe(true);
  });

  test('a reference to a nonexistent page is still dropped (no FK churn)', async () => {
    const result = await put('meetings/2026-04-04', 'Mentioned people/ghost-nobody in passing.');
    const links = result.auto_links as { created: number; errors: number };
    expect(links.created).toBe(0);
    expect(links.errors).toBe(0);
    const rows = await engine.getLinks('meetings/2026-04-04', { sourceId: 'default' });
    expect(rows).toHaveLength(0);
  });

  test('a link-free page reconciles to zero without error (probe skipped)', async () => {
    const result = await put('inbox/plain-note', 'No references here at all.');
    const links = result.auto_links as { created: number; removed: number; errors: number };
    expect(links.created).toBe(0);
    expect(links.errors).toBe(0);
  });

  test('resolution stays scoped to the write source', async () => {
    // Target exists ONLY in 'default'. A write into source-b must not link to it.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ('source-b', 'source-b', '/fake/source-b', '{}'::jsonb, NOW())
       ON CONFLICT (id) DO NOTHING`,
    );
    await put('people/alice-example', 'A person page in default.');
    const result = await put(
      'meetings/cross-source',
      'Mentions people/alice-example which lives in another source.',
      makeCtx({ sourceId: 'source-b' }),
    );
    const links = result.auto_links as { created: number };
    expect(links.created).toBe(0);
    const rows = await engine.getLinks('meetings/cross-source', { sourceId: 'source-b' });
    expect(rows).toHaveLength(0);
  });

  test('stale-link removal still works (reconciliation unaffected)', async () => {
    await put('people/alice-example', 'A person page.');
    await put('meetings/removal-check', 'With people/alice-example.');
    const before = await engine.getLinks('meetings/removal-check', { sourceId: 'default' });
    expect(before.some((l) => l.to_slug === 'people/alice-example')).toBe(true);
    // Rewrite without the reference: the edge must be reconciled away.
    const result = await put('meetings/removal-check', 'Reference removed entirely, new content.');
    const links = result.auto_links as { removed: number };
    expect(links.removed).toBeGreaterThanOrEqual(1);
    const after = await engine.getLinks('meetings/removal-check', { sourceId: 'default' });
    expect(after.some((l) => l.to_slug === 'people/alice-example')).toBe(false);
  });
});
