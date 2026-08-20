/**
 * #1856 — add_timeline_entry write-through on FS/git-canonical brains.
 *
 * Pre-fix, the op wrote ONLY the timeline_entries table: on a brain where
 * markdown on disk is the committable source of truth (`sync.repo_path` set),
 * every manual entry stranded — invisible to git and `gbrain get`, and
 * silently lost on any FS→DB rebuild. These tests pin the fix: the entry
 * reaches the canonical markdown through the same write-through seam pages
 * and facts use (resolvePageWriteTarget → writePageThrough), the stored DB
 * tuple matches what sync's FS extractor re-derives from the rendered bullet
 * (no duplicate on reconcile), and DB-only brains keep the exact pre-fix
 * behavior.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { operations } from '../src/core/operations.ts';
import type { Operation, OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { writePageThrough, _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import {
  renderTimelineEntry,
  spliceTimelineBlock,
  writeTimelineEntryThrough,
} from '../src/core/timeline-write-through.ts';
import { extractTimelineFromContent } from '../src/commands/extract.ts';

const addTimelineEntryOp = operations.find((o) => o.name === 'add_timeline_entry') as Operation;
if (!addTimelineEntryOp) throw new Error('add_timeline_entry op missing');

let engine: PGLiteEngine;
let tmpRoot: string;
let brainDir: string;

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
  resetGateway();
  _resetWriteThroughCacheForTest();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-timeline-wt-'));
  brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

async function seedPage(slug: string, body?: string): Promise<string> {
  const content = body ?? `---\ntitle: T\ntype: note\n---\n\n# Body ${slug}\n`;
  await importFromContent(engine, slug, content, {
    noEmbed: true,
    sourceId: 'default',
    sourcePath: `${slug}.md`,
  });
  const wt = await writePageThrough(engine, slug, { sourceId: 'default' });
  return wt.path ?? path.join(brainDir, `${slug}.md`);
}

async function timelineRowCount(slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM timeline_entries te
      JOIN pages p ON p.id = te.page_id
     WHERE p.slug = $1 AND p.source_id = 'default'`,
    [slug],
  );
  return Number(rows[0]?.n ?? 0);
}

describe('add_timeline_entry on an FS-canonical brain (#1856)', () => {
  test('entry reaches the canonical markdown AND the DB', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'notes/acme-example';
    const filePath = await seedPage(slug);

    const res = await addTimelineEntryOp.handler(makeCtx(), {
      slug,
      date: '2026-07-15',
      summary: 'Manual milestone added via timeline-add',
      source: 'meetings/2026-07-15',
    }) as { status: string; write_through?: { written?: boolean; path?: string } };

    expect(res.status).toBe('ok');
    expect(res.write_through?.written).toBe(true);
    expect(res.write_through?.path).toBe(filePath);

    // THE #1856 assertion: the canonical markdown on disk carries the entry.
    const disk = fs.readFileSync(filePath, 'utf8');
    expect(disk).toContain('- **2026-07-15** | meetings/2026-07-15 — Manual milestone added via timeline-add');

    // DB row exists too, with the tuple the FS extractor recovers.
    const timeline = await engine.getTimeline(slug, { sourceId: 'default' });
    expect(timeline.length).toBe(1);
    expect(timeline[0].summary).toBe('Manual milestone added via timeline-add');
    expect(timeline[0].source).toBe('meetings/2026-07-15');

    // The page row's timeline text gained the bullet (`gbrain get` shows it).
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page?.timeline ?? '').toContain('Manual milestone added via timeline-add');
  });

  test('FS→DB rebuild recovers the entry from the file (the P0 loss mode)', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'notes/rebuild-example';
    const filePath = await seedPage(slug);

    await addTimelineEntryOp.handler(makeCtx(), {
      slug,
      date: '2026-07-15',
      summary: 'Survives the rebuild',
      source: 'meetings/2026-07-15',
    });
    const before = await engine.getTimeline(slug, { sourceId: 'default' });
    expect(before.length).toBe(1);

    // Simulate a wiped-DB rebuild: drop derived rows, re-import the canonical
    // file, re-run the FS extractor over its content.
    await engine.executeRaw(
      `DELETE FROM timeline_entries WHERE page_id IN
         (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default')`,
      [slug],
    );
    const disk = fs.readFileSync(filePath, 'utf8');
    await importFromContent(engine, slug, disk, {
      noEmbed: true,
      sourceId: 'default',
      sourcePath: `${slug}.md`,
    });
    const extracted = extractTimelineFromContent(disk, slug);
    expect(extracted.length).toBe(1);
    await engine.addTimelineEntriesBatch(
      extracted.map((e) => ({ ...e, source_id: 'default' })),
    );

    const after = await engine.getTimeline(slug, { sourceId: 'default' });
    expect(after.length).toBe(1);
    expect(after[0].summary).toBe('Survives the rebuild');
    expect(after[0].source).toBe('meetings/2026-07-15');
  });

  test('sync re-extraction of the written file dedups (tuple convergence)', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'notes/dedup-example';
    const filePath = await seedPage(slug);

    // Summary contains a whitespace-flanked em-dash AND a hyphenated word —
    // exactly the shapes #1856 Bug 1 fragmented. The source-first bullet
    // render keeps them intact.
    await addTimelineEntryOp.handler(makeCtx(), {
      slug,
      date: '2026-03-09',
      summary: 'Earliest instance — predating the media-release anchor.',
      source: 'email',
    });
    expect(await timelineRowCount(slug)).toBe(1);

    // What incremental sync does with the changed file: re-extract + batch
    // insert. Must conflict-no-op against the row the op already stored.
    const disk = fs.readFileSync(filePath, 'utf8');
    const extracted = extractTimelineFromContent(disk, slug);
    expect(extracted.length).toBe(1);
    expect(extracted[0].summary).toBe('Earliest instance — predating the media-release anchor.');
    expect(extracted[0].source).toBe('email');
    await engine.addTimelineEntriesBatch(
      extracted.map((e) => ({ ...e, source_id: 'default' })),
    );
    expect(await timelineRowCount(slug)).toBe(1);
  });

  test('no source given → provenance defaults to a round-trippable label', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'notes/no-source-example';
    const filePath = await seedPage(slug);

    await addTimelineEntryOp.handler(makeCtx(), {
      slug,
      date: '2026-07-15',
      summary: 'No provenance given',
    });

    const timeline = await engine.getTimeline(slug, { sourceId: 'default' });
    expect(timeline.length).toBe(1);
    expect(timeline[0].summary).toBe('No provenance given');
    // Never '' on the FS path: a source-less bullet cannot round-trip
    // (the extractor assigns 'markdown' / splits summary-first bullets).
    expect(timeline[0].source).toBe('manual');

    const disk = fs.readFileSync(filePath, 'utf8');
    const extracted = extractTimelineFromContent(disk, slug);
    expect(extracted.length).toBe(1);
    expect(extracted[0].summary).toBe('No provenance given');
    expect(extracted[0].source).toBe('manual');
    await engine.addTimelineEntriesBatch(extracted.map((e) => ({ ...e, source_id: 'default' })));
    expect(await timelineRowCount(slug)).toBe(1);
  });

  test('detail rides along as indented lines and stays in the DB row', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'notes/detail-example';
    const filePath = await seedPage(slug);

    await addTimelineEntryOp.handler(makeCtx(), {
      slug,
      date: '2026-07-15',
      summary: 'Milestone with detail',
      source: 'meetings/2026-07-15',
      detail: 'Longer free-text detail behind the summary.',
    });

    const disk = fs.readFileSync(filePath, 'utf8');
    expect(disk).toContain('  Longer free-text detail behind the summary.');
    const timeline = await engine.getTimeline(slug, { sourceId: 'default' });
    expect(timeline.length).toBe(1);
    expect(timeline[0].detail).toBe('Longer free-text detail behind the summary.');
    // The block still re-extracts to exactly one entry.
    expect(extractTimelineFromContent(disk, slug).length).toBe(1);
  });

  test('new entry splices date-ordered into an existing timeline section', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'notes/ordered-example';
    const body = [
      '---', 'title: T', 'type: note', '---', '',
      '# Body', '',
      '<!-- timeline -->', '',
      '## Timeline', '',
      '- **2026-07-01** | kickoff — Project kicked off.',
      '- **2026-07-20** | email — Draft went to review.', '',
    ].join('\n');
    const filePath = await seedPage(slug, body);

    await addTimelineEntryOp.handler(makeCtx(), {
      slug,
      date: '2026-07-15',
      summary: 'Mid-window milestone',
      source: 'manual',
    });

    const disk = fs.readFileSync(filePath, 'utf8');
    const kickoff = disk.indexOf('2026-07-01');
    const mid = disk.indexOf('- **2026-07-15** | manual — Mid-window milestone');
    const review = disk.indexOf('2026-07-20** | email');
    expect(mid).toBeGreaterThan(kickoff);
    expect(review).toBeGreaterThan(mid);

    // Pre-existing bullets are untouched; the file re-extracts to 3 entries.
    expect(extractTimelineFromContent(disk, slug).length).toBe(3);
  });

  test('subagent sandbox stays DB-only even when a repo target resolves', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'wiki/agents/7/notes';
    const filePath = await seedPage(slug);
    const beforeDisk = fs.readFileSync(filePath, 'utf8');

    const res = await addTimelineEntryOp.handler(
      makeCtx({ viaSubagent: true, subagentId: 7 }),
      { slug, date: '2026-07-15', summary: 'Sandboxed entry' },
    ) as { write_through?: { written?: boolean; skipped?: string } };

    expect(res.write_through?.written).toBe(false);
    expect(res.write_through?.skipped).toBe('subagent_sandbox');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(beforeDisk);
    const timeline = await engine.getTimeline(slug, { sourceId: 'default' });
    expect(timeline.length).toBe(1);
    expect(timeline[0].source).toBe(''); // legacy tuple, unchanged
  });
});

describe('add_timeline_entry on a DB-only brain (unchanged pre-#1856 path)', () => {
  test('no sync.repo_path → legacy tuple, no file writes', async () => {
    const slug = 'notes/db-only-example';
    await importFromContent(engine, slug, `---\ntitle: T\ntype: note\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'default',
    });

    const res = await addTimelineEntryOp.handler(makeCtx(), {
      slug,
      date: '2026-07-15',
      summary: 'DB-only entry',
    }) as { status: string; write_through?: { written?: boolean; skipped?: string } };

    expect(res.status).toBe('ok');
    expect(res.write_through?.written).toBe(false);
    expect(res.write_through?.skipped).toBe('no_repo_configured');
    const timeline = await engine.getTimeline(slug, { sourceId: 'default' });
    expect(timeline.length).toBe(1);
    expect(timeline[0].source).toBe(''); // raw legacy tuple preserved
    expect(fs.readdirSync(brainDir)).toEqual([]); // nothing written to disk
  });

  test('sync.write_through=false → DB-only by operator choice', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    await engine.setConfig('sync.write_through', 'false');
    _resetWriteThroughCacheForTest();
    const slug = 'notes/wt-off-example';
    await importFromContent(engine, slug, `---\ntitle: T\ntype: note\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'default',
    });

    const res = await addTimelineEntryOp.handler(makeCtx(), {
      slug,
      date: '2026-07-15',
      summary: 'Opted-out entry',
    }) as { write_through?: { written?: boolean; skipped?: string } };

    expect(res.write_through?.written).toBe(false);
    expect(res.write_through?.skipped).toBe('disabled_by_config');
    expect((await engine.getTimeline(slug, { sourceId: 'default' }))[0].source).toBe('');
    expect(fs.readdirSync(brainDir)).toEqual([]);
  });

  test('missing page still raises the canonical page-not-found error', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const p = addTimelineEntryOp.handler(makeCtx(), {
      slug: 'notes/does-not-exist',
      date: '2026-07-15',
      summary: 'Orphan entry',
    });
    await expect(p).rejects.toThrow(/not found/);
  });
});

describe('writeTimelineEntryThrough helper', () => {
  test('returns handled:false with skipped reason when no repo is configured', async () => {
    const slug = 'notes/helper-skip';
    await importFromContent(engine, slug, `---\ntitle: T\ntype: note\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'default',
    });
    const out = await writeTimelineEntryThrough(engine, slug, 'default', {
      date: '2026-07-15',
      summary: 'x',
    });
    expect(out.handled).toBe(false);
    expect(out.skipped).toBe('no_repo_configured');
  });

  test('never throws — engine failure surfaces as handled:false + error', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'notes/helper-throw';
    await seedPage(slug);
    const broken = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'addTimelineEntry') {
          return async () => { throw new Error('boom'); };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as unknown as PGLiteEngine;
    const out = await writeTimelineEntryThrough(broken, slug, 'default', {
      date: '2026-07-15',
      summary: 'x',
    });
    expect(out.handled).toBe(false);
    expect(out.error).toContain('boom');
  });
});

describe('renderTimelineEntry / spliceTimelineBlock units', () => {
  test('renders a source-first bullet whose extraction round-trips exactly', () => {
    const r = renderTimelineEntry(
      { date: '2026-03-09', summary: 'YouGov delivered results. [Source: email, 2026-03-09]', source: 'email' },
      'notes/x',
    );
    expect(r).not.toBeNull();
    expect(r!.canonical).toEqual({
      date: '2026-03-09',
      source: 'email',
      summary: 'YouGov delivered results. [Source: email, 2026-03-09]',
    });
  });

  test('collapses multi-line summaries onto the bullet line', () => {
    const r = renderTimelineEntry({ date: '2026-01-01', summary: 'line one\nline two', source: 's' }, 'notes/x');
    expect(r).not.toBeNull();
    expect(r!.block).toBe('- **2026-01-01** | s — line one line two');
  });

  test('whitespace-only summary is not renderable', () => {
    expect(renderTimelineEntry({ date: '2026-01-01', summary: '   ' }, 'notes/x')).toBeNull();
  });

  test('detail carrying its own citation is kept out of the block (would double-extract)', () => {
    const r = renderTimelineEntry(
      { date: '2026-01-01', summary: 'S', source: 's', detail: 'See [Source: email, 2026-02-02] thread' },
      'notes/x',
    );
    expect(r).not.toBeNull();
    expect(r!.block).toBe('- **2026-01-01** | s — S');
  });

  test('splice into empty timeline creates the heading', () => {
    expect(spliceTimelineBlock('', '2026-01-01', '- **2026-01-01** | s — S'))
      .toBe('## Timeline\n\n- **2026-01-01** | s — S');
  });

  test('splice preserves a descending list order', () => {
    const text = [
      '## Timeline', '',
      '- **2026-07-20** | email — Later.',
      '- **2026-07-01** | kickoff — Earlier.',
    ].join('\n');
    const out = spliceTimelineBlock(text, '2026-07-15', '- **2026-07-15** | manual — Mid.');
    const lines = out.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toEqual([
      '- **2026-07-20** | email — Later.',
      '- **2026-07-15** | manual — Mid.',
      '- **2026-07-01** | kickoff — Earlier.',
    ]);
  });
});
