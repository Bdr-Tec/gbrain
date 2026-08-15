/**
 * transcripts-ingest e2e (PGLite) — cathedral-4.
 *
 * Pins the import lane end-to-end against a real embedded engine:
 * cross-harness round-trip, dry-run zero-writes, idempotent re-runs,
 * redaction-before-write, part splitting under the embed-skip threshold,
 * the DANGEROUS TRANSITIONS (split→shrink stale-part deletion), since/limit
 * clean-scan semantics, and the putRawData zero-row parity fix.
 *
 * R3/R4: engine in beforeAll, disconnect in afterAll; state reset per test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { runTranscriptsIngest } from '../../src/core/transcripts/ingest.ts';
import { MESSAGE_CHAR_CAP } from '../../src/core/transcripts/render.ts';

const CODEX_FIXTURE = join(import.meta.dir, '..', 'fixtures', 'transcripts', 'codex-rollout.jsonl');
const AGENT_FIXTURE = join(import.meta.dir, '..', 'fixtures', 'transcripts', 'agent-session.jsonl');

let engine: PGLiteEngine;
let tmp: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  tmp = mkdtempSync(join(tmpdir(), 'gb-ingest-e2e-'));
});

const NO_PATTERNS = { userPatternsPath: '/nonexistent-patterns.txt' };

function baseOpts(paths: string[], extra: Record<string, unknown> = {}) {
  return { paths, sourceId: 'default', ...NO_PATTERNS, ...extra };
}

/** Synthetic openclaw-format session with N large messages. */
function writeBigAgentSession(dir: string, id: string, messageCount: number): string {
  const lines: string[] = [
    JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-08-10T08:00:00.000Z', cwd: '/tmp' }),
  ];
  const filler = 'lorem widget fact '.repeat(Math.ceil((MESSAGE_CHAR_CAP - 100) / 18));
  for (let i = 0; i < messageCount; i++) {
    lines.push(
      JSON.stringify({
        type: 'message',
        id: `m-${i}`,
        timestamp: `2026-08-10T08:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
        message: {
          role: i % 2 === 0 ? 'user' : 'assistant',
          timestamp: `2026-08-10T08:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
          content: [{ type: 'text', text: `marker-${i} ${filler}` }],
        },
      }),
    );
  }
  const p = join(dir, `${id}.jsonl`);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('cross-harness round-trip', () => {
  test('codex + openclaw fixtures land as conversation pages in one source', async () => {
    const r = await runTranscriptsIngest(engine, baseOpts([CODEX_FIXTURE, AGENT_FIXTURE]));
    expect(r.sessionsImported).toBe(2);
    expect(r.pages.imported).toBe(2);
    expect(r.cleanScan).toBe(true);
    expect(r.erroredFiles).toBe(0);

    const codexPage = await engine.getPage('conversations/sessions/2026-08-02-codex-codexfix', {
      sourceId: 'default',
    });
    expect(codexPage).not.toBeNull();
    expect(codexPage!.type).toBe('conversation');
    expect(codexPage!.compiled_truth).toContain('fund-a led the widget-co seed');
    expect(codexPage!.compiled_truth).not.toContain('PREAMBLE-ONLY-TEXT');

    const agentPage = await engine.getPage('conversations/sessions/2026-08-03-openclaw-agentfix', {
      sourceId: 'default',
    });
    expect(agentPage).not.toBeNull();
    expect(agentPage!.compiled_truth).toContain('acme-seed memo');
    // Cross-harness continuity substrate: both sessions in ONE brain source.
    const fm = agentPage!.frontmatter as Record<string, any>;
    expect(fm.transcript_import.harness).toBe('openclaw');
    expect(fm.transcript_import.session_id).toBe('agent-fixture-session-1');
    expect(fm.date).toBe('2026-08-03');

    // Session metadata rode putRawData onto the base page.
    const raw = await engine.getRawData(agentPage!.slug, undefined, { sourceId: 'default' });
    expect(raw.length).toBeGreaterThan(0);
    expect((raw[0].data as Record<string, unknown>).session_id).toBe('agent-fixture-session-1');
  });
});

describe('dry-run', () => {
  test('writes NOTHING — no pages, no raw data — and never advances watermarks', async () => {
    const r = await runTranscriptsIngest(engine, baseOpts([CODEX_FIXTURE], { dryRun: true }));
    expect(r.pages.planned).toBe(1);
    expect(r.pages.imported).toBe(0);
    expect(r.cleanScan).toBe(false); // dry-runs must not advance the watermark
    const pages = await engine.listPages({ type: 'conversation', sourceId: 'default', limit: 10 });
    expect(pages).toHaveLength(0);
  });
});

describe('idempotency', () => {
  test('second run hash-skips every page; slugsTouched still includes them (facts re-runs)', async () => {
    const r1 = await runTranscriptsIngest(engine, baseOpts([CODEX_FIXTURE, AGENT_FIXTURE]));
    expect(r1.pages.imported).toBe(2);
    const r2 = await runTranscriptsIngest(engine, baseOpts([CODEX_FIXTURE, AGENT_FIXTURE]));
    expect(r2.pages.imported).toBe(0);
    expect(r2.pages.skipped).toBe(2);
    // The facts lane must see hash-skipped slugs too (CX14).
    expect(r2.slugsTouched.sort()).toEqual(r1.slugsTouched.sort());
    expect(r2.cleanScan).toBe(true);
  });
});

describe('redaction before write', () => {
  test('planted secret never reaches the page; redaction counted', async () => {
    const p = join(tmp, 'secret-session.jsonl');
    writeFileSync(
      p,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'secret-session-01', timestamp: '2026-08-09T10:00:00.000Z' }),
        JSON.stringify({
          type: 'message',
          id: 'm-1',
          timestamp: '2026-08-09T10:00:01.000Z',
          message: {
            role: 'user',
            timestamp: '2026-08-09T10:00:01.000Z',
            content: [{ type: 'text', text: 'the deploy key is AKIAABCDEFGHIJKLMNOP keep it safe' }],
          },
        }),
      ].join('\n') + '\n',
    );
    const r = await runTranscriptsIngest(engine, baseOpts([p]));
    expect(r.sessionsImported).toBe(1);
    expect(r.redactions).toBeGreaterThanOrEqual(1);
    const page = await engine.getPage(r.slugsTouched[0], { sourceId: 'default' });
    expect(page).not.toBeNull();
    expect(page!.compiled_truth).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(page!.compiled_truth).toContain('<REDACTED:');
  });
});

describe('part splitting + dangerous transitions', () => {
  test('big session splits under the embed-skip threshold and every part is a real page', async () => {
    const p = writeBigAgentSession(tmp, 'bigsession-0001', 150);
    const r = await runTranscriptsIngest(engine, baseOpts([p]));
    expect(r.sessionsImported).toBe(1);
    expect(r.pages.imported).toBeGreaterThan(1);
    const base = 'conversations/sessions/2026-08-10-openclaw-bigsessi';
    const p1 = await engine.getPage(base, { sourceId: 'default' });
    const p2 = await engine.getPage(`${base}-p2`, { sourceId: 'default' });
    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    // Split pages must stay embeddable: no embed_skip marker on any part.
    for (const page of [p1!, p2!]) {
      const fm = page.frontmatter as Record<string, any>;
      expect(fm.embed_skip).toBeUndefined();
      expect(fm.transcript_import.of).toBe(r.pages.imported);
    }
    // Unique per-part identity (a shared id would dedup-skip parts 2..N).
    expect((p1!.frontmatter as any).id).not.toBe((p2!.frontmatter as any).id);
  });

  test('split → shrink deletes stale higher parts (reconciliation)', async () => {
    const big = writeBigAgentSession(tmp, 'shrinksession-01', 150);
    const r1 = await runTranscriptsIngest(engine, baseOpts([big]));
    const parts = r1.pages.imported;
    expect(parts).toBeGreaterThan(1);
    // Same session id, now tiny: re-render to ONE part.
    const small = writeBigAgentSession(join(tmp), 'shrinksession-01', 2);
    const r2 = await runTranscriptsIngest(engine, baseOpts([small]));
    expect(r2.sessionsImported).toBe(1);
    expect(r2.partsDeleted).toBe(parts - 1);
    const base = 'conversations/sessions/2026-08-10-openclaw-shrinkse';
    expect(await engine.getPage(base, { sourceId: 'default' })).not.toBeNull();
    expect(await engine.getPage(`${base}-p2`, { sourceId: 'default' })).toBeNull();
  });
});

describe('since/limit clean-scan semantics', () => {
  test('sinceIso filters old sessions; limit truncation breaks cleanScan', async () => {
    // Both fixtures are older than the since bound → filtered, clean scan.
    const rSince = await runTranscriptsIngest(
      engine,
      baseOpts([CODEX_FIXTURE, AGENT_FIXTURE], { sinceIso: '2027-01-01T00:00:00.000Z' }),
    );
    expect(rSince.sessionsFiltered).toBe(2);
    expect(rSince.sessionsImported).toBe(0);
    expect(rSince.cleanScan).toBe(true);
    expect(rSince.maxSessionTs > '2026-08-01').toBe(true);

    // limit=1 over two files → truncated, NOT a clean scan (watermark frozen).
    const rLimit = await runTranscriptsIngest(engine, baseOpts([CODEX_FIXTURE, AGENT_FIXTURE], { limit: 1 }));
    expect(rLimit.sessionsImported).toBe(1);
    expect(rLimit.cleanScan).toBe(false);

    // Kill/rerun convergence: the follow-up full run completes the rest.
    const rFull = await runTranscriptsIngest(engine, baseOpts([CODEX_FIXTURE, AGENT_FIXTURE]));
    expect(rFull.sessionsImported).toBe(2);
    expect(rFull.pages.imported + rFull.pages.skipped).toBe(2);
  });
});

describe('error taxonomy', () => {
  test('unknown-format file is a per-file error; the run continues', async () => {
    const junk = join(tmp, 'junk.jsonl');
    writeFileSync(junk, '{"unrelated":true}\n');
    const r = await runTranscriptsIngest(engine, baseOpts([junk, CODEX_FIXTURE]));
    expect(r.erroredFiles).toBe(1);
    expect(r.sessionsImported).toBe(1);
    expect(r.cleanScan).toBe(false);
  });

  test('zero-session file raises the drift signal', async () => {
    const empty = join(tmp, 'empty.jsonl');
    writeFileSync(
      empty,
      JSON.stringify({ type: 'session', version: 3, id: 'empty-session-1', timestamp: '2026-08-09T10:00:00.000Z' }) + '\n',
    );
    const r = await runTranscriptsIngest(engine, baseOpts([empty], { format: 'openclaw' }));
    expect(r.driftFiles).toBe(1);
    expect(r.sessionsImported).toBe(0);
  });
});

describe('putRawData zero-row parity (PGLite)', () => {
  test('missing page throws instead of silently no-opping', async () => {
    await expect(
      engine.putRawData('conversations/sessions/never-imported', 'transcript:codex', { a: 1 }, { sourceId: 'default' }),
    ).rejects.toThrow(/not found/);
    await expect(
      engine.putRawData('conversations/sessions/never-imported-2', 'transcript:codex', { a: 1 }),
    ).rejects.toThrow(/not found/);
  });
});
