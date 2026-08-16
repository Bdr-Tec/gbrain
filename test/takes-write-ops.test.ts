/**
 * CLI→MCP gap-closure wave — takes_add / takes_update / takes_resolve /
 * takes_supersede ops over dispatchToolCall (real PGLite engine + a temp
 * markdown repo as sync.repo_path).
 *
 * Pins the load-bearing trust + md-canonical semantics:
 *   - mirror-mandatory refusal (takes_mirror_unavailable) when sync.repo_path
 *     is unset [EV1]
 *   - holder WRITE fence: hit/miss/[] deny-all/undefined→['world'] default,
 *     threaded through dispatchToolCall (the wiring, not just the handler)
 *     [CEO-F8]
 *   - fenced rows present as not_found — same shape as a missing row [CEO-F4]
 *   - fence round-trip: md written first, DB mirrored with the reconcile
 *     primitive; fence-create-if-absent on a page's first take [CEO-F6]
 *   - resolved_by server-stamped mcp:<client> for remote callers +
 *     mcp_resolved surfacing on takes_scorecard [OV8/EV5]
 *   - immutability: resolved rows refuse update/supersede
 *   - concurrent adds serialize under the page lock: loser gets the
 *     retryable error, retry lands the next sequential row [ENG-E4/EV11]
 *   - dry_run short-circuits
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;
let repo: string;

const STDIO = { remote: true, transport: 'stdio' as const, sourceId: 'default' };
/** stdio's hardcoded default allow-list (server.ts) — world-held writes only. */
const STDIO_WORLD = { ...STDIO, takesHoldersAllowList: ['world'] };
const LOCAL = { remote: false as const, sourceId: 'default' };

function parsed(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function pageMd(slug: string): string {
  return readFileSync(join(repo, `${slug}.md`), 'utf-8');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  repo = mkdtempSync(join(tmpdir(), 'gbrain-takes-ops-repo-'));
  await engine.setConfig('sync.repo_path', repo);
  for (const slug of ['people/alice-example', 'companies/acme-example', 'notes/lockrace']) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `about ${slug}` });
    mkdirSync(join(repo, slug.split('/')[0]), { recursive: true });
    writeFileSync(join(repo, `${slug}.md`), `# ${slug}\n\nabout ${slug}\n`, 'utf-8');
  }
});

afterAll(async () => {
  await engine.disconnect();
});

describe('takes_add', () => {
  test('creates the fence on first take [CEO-F6], mirrors to DB, returns the fence row number', async () => {
    const res = await dispatchToolCall(engine, 'takes_add', {
      slug: 'people/alice-example', claim: 'Ships weekly', kind: 'take', holder: 'world', weight: 0.7,
    }, { ...STDIO_WORLD });
    expect(res.isError ?? false).toBe(false);
    const body = parsed(res);
    expect(body.row_num).toBe(1);
    expect(body.mirror_written).toBe(true);
    // md-first: the fence exists on disk with the row.
    const fence = parseTakesFence(pageMd('people/alice-example'));
    expect(fence.takes.length).toBe(1);
    expect(fence.takes[0].claim).toBe('Ships weekly');
    // DB mirror carries the same row.
    const rows = await engine.listTakes({ page_slug: 'people/alice-example', active: true });
    expect(rows.length).toBe(1);
    expect(rows[0].row_num).toBe(1);
    expect(rows[0].holder).toBe('world');
  });

  test('holder fence: outside-allow-list holder denies with machine-readable detail', async () => {
    const res = await dispatchToolCall(engine, 'takes_add', {
      slug: 'people/alice-example', claim: 'Private hunch', kind: 'hunch', holder: 'people/garry-example',
    }, { ...STDIO_WORLD });
    expect(res.isError).toBe(true);
    const body = parsed(res);
    expect(body.error).toBe('permission_denied');
    expect(body.detail).toBe('holder_not_in_allowlist');
  });

  test('empty allow-list = deny-all; missing allow-list defaults to world [CEO-F8 wiring]', async () => {
    const denyAll = await dispatchToolCall(engine, 'takes_add', {
      slug: 'people/alice-example', claim: 'x', kind: 'fact', holder: 'world',
    }, { ...STDIO, takesHoldersAllowList: [] });
    expect(parsed(denyAll).error).toBe('permission_denied');

    // No list threaded at all (remote) → the ['world'] fail-closed default.
    const defaulted = await dispatchToolCall(engine, 'takes_add', {
      slug: 'companies/acme-example', claim: 'Raised a round', kind: 'fact', holder: 'world',
    }, { ...STDIO });
    expect(parsed(defaulted).row_num).toBe(1);
    const nonWorld = await dispatchToolCall(engine, 'takes_add', {
      slug: 'companies/acme-example', claim: 'y', kind: 'fact', holder: 'brain',
    }, { ...STDIO });
    expect(parsed(nonWorld).error).toBe('permission_denied');
  });

  test('trusted local caller is unfenced', async () => {
    const res = await dispatchToolCall(engine, 'takes_add', {
      slug: 'people/alice-example', claim: 'Owner-held view', kind: 'bet', holder: 'people/garry-example', weight: 0.8,
    }, { ...LOCAL });
    expect(parsed(res).row_num).toBe(2);
  });

  test('mirror-mandatory: unset sync.repo_path refuses with takes_mirror_unavailable [EV1]', async () => {
    await engine.unsetConfig('sync.repo_path');
    try {
      const res = await dispatchToolCall(engine, 'takes_add', {
        slug: 'people/alice-example', claim: 'z', kind: 'fact', holder: 'world',
      }, { ...STDIO_WORLD });
      expect(res.isError).toBe(true);
      const body = parsed(res);
      expect(body.error).toBe('unavailable');
      expect(body.detail).toBe('takes_mirror_unavailable');
    } finally {
      await engine.setConfig('sync.repo_path', repo);
    }
  });

  test('dry_run short-circuits before any write', async () => {
    const res = await dispatchToolCall(engine, 'takes_add', {
      slug: 'people/alice-example', claim: 'dry', kind: 'fact', holder: 'world', dry_run: true,
    }, { ...STDIO_WORLD });
    expect(parsed(res).dry_run).toBe(true);
    const fence = parseTakesFence(pageMd('people/alice-example'));
    expect(fence.takes.some(t => t.claim === 'dry')).toBe(false);
  });

  test('unknown page → page_not_found', async () => {
    const res = await dispatchToolCall(engine, 'takes_add', {
      slug: 'missing/page', claim: 'x', kind: 'fact', holder: 'world',
    }, { ...STDIO_WORLD });
    expect(parsed(res).error).toBe('page_not_found');
  });
});

describe('takes_update + holder row fence', () => {
  test('updates mutable fields md-first and mirrors', async () => {
    const res = await dispatchToolCall(engine, 'takes_update', {
      slug: 'people/alice-example', row_num: 1, weight: 0.9, source: 'quarterly report',
    }, { ...STDIO_WORLD });
    expect(res.isError ?? false).toBe(false);
    const fence = parseTakesFence(pageMd('people/alice-example'));
    const row = fence.takes.find(t => t.rowNum === 1);
    expect(row?.weight).toBe(0.9);
    expect(row?.source).toBe('quarterly report');
    const db = (await engine.listTakes({ page_slug: 'people/alice-example', active: true })).find(t => t.row_num === 1);
    expect(Number(db?.weight)).toBe(0.9);
  });

  test('[CEO-F4] fenced row and missing row share the not_found shape (no existence leak)', async () => {
    // Row 2 is holder people/garry-example — outside the world allow-list.
    const fenced = await dispatchToolCall(engine, 'takes_update', {
      slug: 'people/alice-example', row_num: 2, weight: 0.1,
    }, { ...STDIO_WORLD });
    const missing = await dispatchToolCall(engine, 'takes_update', {
      slug: 'people/alice-example', row_num: 99, weight: 0.1,
    }, { ...STDIO_WORLD });
    const fencedBody = parsed(fenced);
    const missingBody = parsed(missing);
    expect(fencedBody.error).toBe('not_found');
    expect(missingBody.error).toBe('not_found');
    // Same shape: identical keys, and messages differing only by row number.
    expect(Object.keys(fencedBody).sort()).toEqual(Object.keys(missingBody).sort());
    expect(fencedBody.message.replace('#2', '#N')).toBe(missingBody.message.replace('#99', '#N'));
  });

  test('zero mutable fields → invalid_params', async () => {
    const res = await dispatchToolCall(engine, 'takes_update', {
      slug: 'people/alice-example', row_num: 1,
    }, { ...STDIO_WORLD });
    expect(parsed(res).error).toBe('invalid_params');
  });
});

describe('takes_resolve', () => {
  test('remote resolution is server-stamped mcp:<client> and ignores resolved_by [OV8]', async () => {
    const res = await dispatchToolCall(engine, 'takes_resolve', {
      slug: 'people/alice-example', row_num: 1, quality: 'correct',
      evidence: 'shipped 12 weeks straight', resolved_by: 'people/spoofed-owner',
    }, { ...STDIO_WORLD });
    expect(res.isError ?? false).toBe(false);
    const body = parsed(res);
    expect(body.resolved_by).toBe('mcp:stdio');
    const db = (await engine.listTakes({ page_slug: 'people/alice-example', active: true })).find(t => t.row_num === 1);
    expect(db?.resolved_quality).toBe('correct');
    expect(db?.resolved_by).toBe('mcp:stdio');
    // Markdown mirror carries the resolution too (13-col fence).
    expect(pageMd('people/alice-example')).toContain('mcp:stdio');
  });

  test('mcp_resolved surfaces on takes_scorecard [EV5]', async () => {
    const card = parsed(await dispatchToolCall(engine, 'takes_scorecard', {}, { ...STDIO_WORLD }));
    expect(card.mcp_resolved).toBeGreaterThanOrEqual(1);
  });

  test('resolved rows are immutable: update and supersede refuse, re-resolve refuses', async () => {
    for (const [op, args] of [
      ['takes_update', { slug: 'people/alice-example', row_num: 1, weight: 0.2 }],
      ['takes_supersede', { slug: 'people/alice-example', row_num: 1, claim: 'replacement' }],
      ['takes_resolve', { slug: 'people/alice-example', row_num: 1, quality: 'incorrect' }],
    ] as const) {
      const res = await dispatchToolCall(engine, op, args as Record<string, unknown>, { ...STDIO_WORLD });
      expect(parsed(res).error).toBe('invalid_params');
    }
  });
});

describe('takes_supersede', () => {
  test('inherits kind/holder from the fence row, strikes old, appends next row, mirrors both', async () => {
    const add = parsed(await dispatchToolCall(engine, 'takes_add', {
      slug: 'companies/acme-example', claim: 'Old thesis', kind: 'take', holder: 'world', weight: 0.6,
    }, { ...STDIO_WORLD }));
    const res = parsed(await dispatchToolCall(engine, 'takes_supersede', {
      slug: 'companies/acme-example', row_num: add.row_num, claim: 'New thesis',
    }, { ...STDIO_WORLD }));
    expect(res.old_row).toBe(add.row_num);
    expect(res.new_row).toBeGreaterThan(add.row_num);
    const fence = parseTakesFence(pageMd('companies/acme-example'));
    const oldRow = fence.takes.find(t => t.rowNum === res.old_row);
    const newRow = fence.takes.find(t => t.rowNum === res.new_row);
    expect(oldRow?.active).toBe(false);
    expect(newRow?.active).toBe(true);
    expect(newRow?.kind).toBe('take');       // inherited
    expect(newRow?.holder).toBe('world');    // inherited
    expect(newRow?.weight).toBeCloseTo(0.5); // 0.6 - 0.1 decay
    // DB mirror: old row carries the supersession pointer.
    const db = await engine.listTakes({ page_slug: 'companies/acme-example', active: false });
    const dbOld = db.find(t => t.row_num === res.old_row);
    expect(dbOld?.superseded_by).toBe(res.new_row);
  });

  test('an explicit override holder must clear the fence too', async () => {
    const add = parsed(await dispatchToolCall(engine, 'takes_add', {
      slug: 'companies/acme-example', claim: 'World view', kind: 'take', holder: 'world',
    }, { ...STDIO_WORLD }));
    const res = await dispatchToolCall(engine, 'takes_supersede', {
      slug: 'companies/acme-example', row_num: add.row_num, claim: 'Now private', holder: 'brain',
    }, { ...STDIO_WORLD });
    expect(parsed(res).error).toBe('permission_denied');
  });
});

describe('concurrency [ENG-E4/EV11]', () => {
  test('concurrent adds to one page: both eventually land with sequential rows, no silent overwrite', async () => {
    const call = () => dispatchToolCall(engine, 'takes_add', {
      slug: 'notes/lockrace', claim: `claim-${Math.random()}`, kind: 'fact', holder: 'world',
    }, { ...STDIO_WORLD });
    const [a, b] = await Promise.all([call(), call()]);
    const bodies = [parsed(a), parsed(b)];
    const oks = bodies.filter(x => typeof x.row_num === 'number');
    const errs = bodies.filter(x => x.error);
    // The 2s lock timeout usually lets both serialize; a loser (if any) is
    // the retryable shape and its retry lands the next row.
    for (const e of errs) {
      expect(e.error).toBe('unavailable');
      expect(e.detail).toBe('retryable');
      const retry = parsed(await call());
      oks.push(retry);
    }
    const rows = oks.map(x => x.row_num).sort((x, y) => x - y);
    expect(new Set(rows).size).toBe(rows.length); // sequential, never overwritten
    const fence = parseTakesFence(pageMd('notes/lockrace'));
    expect(fence.takes.length).toBe(rows.length);
  });
});
