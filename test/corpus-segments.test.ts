/**
 * Cathedral 5 (WI4) — corpus-segments unit contract: content-addressed
 * idempotency, hash-keyed ledger, boundary slicing/splitting, exact-set
 * coverage (duplicate-boundary can't mask a missed one), crash-order
 * fallback, GC of orphaned sidecars + aged ledgers.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendSegmentLedger,
  bankCompactSegment,
  coverageComplete,
  decideCorpusMode,
  gcCorpusArtifacts,
  ledgerFileName,
  readSegmentLedger,
  renderSegmentText,
  segmentFileName,
  segmentHash,
  sliceBoundaryWindow,
  splitByBoundaries,
  writeSegment,
} from '../src/core/context/corpus-segments.ts';
import type { WindowTurn } from '../src/core/context/entity-salience.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gb-seg-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const t = (text: string, role: 'user' | 'assistant' = 'user'): WindowTurn => ({ role, text });

describe('content addressing + ledger', () => {
  test('same text ⇒ same name ⇒ existed=true, no rewrite; ledger append is idempotent', () => {
    const w1 = writeSegment(dir, 's', 'hello world');
    expect(w1.existed).toBe(false);
    expect(w1.file.endsWith(segmentFileName('s', segmentHash('hello world')))).toBe(true);
    const k1 = appendSegmentLedger(dir, 's', w1.hash);
    expect(k1).toBe(1);

    const w2 = writeSegment(dir, 's', 'hello world');
    expect(w2.existed).toBe(true);
    expect(w2.file).toBe(w1.file);
    expect(appendSegmentLedger(dir, 's', w2.hash)).toBe(1); // same ordinal, no dup entry
    expect(readSegmentLedger(dir, 's')).toHaveLength(1);

    const w3 = writeSegment(dir, 's', 'different content');
    expect(appendSegmentLedger(dir, 's', w3.hash)).toBe(2);
    expect(readSegmentLedger(dir, 's')).toHaveLength(2);
  });

  test('unreadable/malformed ledger reads as absent (fail-open [])', () => {
    writeFileSync(join(dir, ledgerFileName('s')), 'not json at all');
    expect(readSegmentLedger(dir, 's')).toEqual([]);
    writeFileSync(join(dir, ledgerFileName('s2')), JSON.stringify({ nope: true }));
    expect(readSegmentLedger(dir, 's2')).toEqual([]);
  });
});

describe('boundary slicing', () => {
  const turns = [t('a'), t('b'), t('c'), t('d'), t('e')];

  test('sliceBoundaryWindow: since last boundary; no boundary ⇒ all; maxTurns caps from the newest end', () => {
    expect(sliceBoundaryWindow(turns, [])).toEqual(turns);
    expect(sliceBoundaryWindow(turns, [2])).toEqual([t('c'), t('d'), t('e')]);
    expect(sliceBoundaryWindow(turns, [1, 3])).toEqual([t('d'), t('e')]);
    expect(sliceBoundaryWindow(turns, [], { maxTurns: 2 })).toEqual([t('d'), t('e')]);
  });

  test('splitByBoundaries: windows partition the pre-boundary turns; remainder is the tail', () => {
    const { windows, remainder } = splitByBoundaries(turns, [2, 4]);
    expect(windows).toEqual([[t('a'), t('b')], [t('c'), t('d')]]);
    expect(remainder).toEqual([t('e')]);
  });
});

describe('exact-set coverage', () => {
  async function bankWindow(win: WindowTurn[]): Promise<string> {
    const rendered = await renderSegmentText(win);
    expect(rendered).not.toBeNull();
    const w = writeSegment(dir, 's', rendered!.text);
    appendSegmentLedger(dir, 's', w.hash);
    return w.hash;
  }

  test('covered when every non-empty window hash is banked; remainder-only decision follows', async () => {
    const turns = [t('w1-a'), t('w1-b'), t('w2-a'), t('rem-a')];
    await bankWindow(turns.slice(0, 2)); // window 1
    await bankWindow(turns.slice(2, 3)); // window 2
    expect(await coverageComplete(dir, 's', turns, [2, 3])).toBe(true);
    const d = await decideCorpusMode(dir, 's', turns, [2, 3]);
    expect(d.mode).toBe('remainder');
    expect(d.turns).toEqual([t('rem-a')]);
  });

  test('a missed window fails coverage even when a duplicated boundary keeps the COUNT equal', async () => {
    const turns = [t('w1-a'), t('w2-a')];
    // Bank window 1 TWICE conceptually (same content = one ledger entry) plus
    // an unrelated hash so ledger COUNT (2) equals the boundary count (2) —
    // but window 2's hash is absent: exact-set must fail.
    await bankWindow(turns.slice(0, 1));
    appendSegmentLedger(dir, 's', 'deadbeef0000');
    expect(readSegmentLedger(dir, 's')).toHaveLength(2);
    expect(await coverageComplete(dir, 's', turns, [1, 2])).toBe(false);
    expect((await decideCorpusMode(dir, 's', turns, [1, 2])).mode).toBe('full_fallback');
  });

  test('empty windows are covered by construction; empty remainder ⇒ skip_covered', async () => {
    const turns = [t('w1-a')];
    await bankWindow(turns);
    // Boundary at 1 then a duplicate boundary at 1: second window is empty.
    expect(await coverageComplete(dir, 's', turns, [1, 1])).toBe(true);
    expect((await decideCorpusMode(dir, 's', turns, [1, 1])).mode).toBe('skip_covered');
  });

  test('no boundaries ⇒ mode full (today behavior); empty ledger with boundaries ⇒ full_fallback', async () => {
    const turns = [t('a')];
    expect((await decideCorpusMode(dir, 's', turns, [])).mode).toBe('full');
    expect((await decideCorpusMode(dir, 's-none', turns, [1])).mode).toBe('full_fallback');
  });
});

describe('bankCompactSegment (compact-time step)', () => {
  test('banks the since-last-boundary window; identical retry is segment_dup with the same ordinal', async () => {
    const turns = [t('old-a'), t('new-a'), t('new-b')];
    const budget = { remainingMs: () => 5000, minScanMs: 600, minWriteMs: 300 };
    const r1 = await bankCompactSegment(dir, 's', turns, [1], budget);
    expect(r1.segment).toBe('segment_banked');
    expect(r1.ordinal).toBe(1);
    expect(existsSync(join(dir, r1.flushCorpusFile!))).toBe(true);
    const body = readFileSync(join(dir, r1.flushCorpusFile!), 'utf8');
    expect(body).toContain('new-a');
    expect(body).not.toContain('old-a');

    const r2 = await bankCompactSegment(dir, 's', turns, [1], budget);
    expect(r2.segment).toBe('segment_dup');
    expect(r2.ordinal).toBe(1);
    expect(readSegmentLedger(dir, 's')).toHaveLength(1);
  });

  test('empty window ⇒ empty_window, nothing written; tight budget ⇒ deadline_scan, nothing written', async () => {
    const turns = [t('a')];
    const empty = await bankCompactSegment(dir, 's', turns, [1], { remainingMs: () => 5000, minScanMs: 600, minWriteMs: 300 });
    expect(empty.segment).toBe('empty_window');
    const tight = await bankCompactSegment(dir, 's', turns, [], { remainingMs: () => 100, minScanMs: 600, minWriteMs: 300 });
    expect(tight.segment).toBe('deadline_scan');
    expect(readdirSync(dir).filter((f) => f.endsWith('.txt'))).toEqual([]);
    expect(readSegmentLedger(dir, 's')).toEqual([]);
  });
});

describe('gcCorpusArtifacts', () => {
  test('removes orphaned sidecars (base .txt gone) and aged ledgers; keeps live pairs', () => {
    // Live pair: base + sidecar both stay.
    writeFileSync(join(dir, 'live.txt'), 'x');
    writeFileSync(join(dir, 'live.txt.ingested'), '');
    // Orphan sidecars: base missing.
    writeFileSync(join(dir, 'gone.txt.ingested'), '');
    writeFileSync(join(dir, 'gone.txt.in-progress'), '');
    // Fresh ledger stays; aged ledger goes.
    writeFileSync(join(dir, 'fresh.ledger.json'), '[]');
    writeFileSync(join(dir, 'old.ledger.json'), '[]');
    const past = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, 'old.ledger.json'), past, past);

    gcCorpusArtifacts(dir, 30 * 24 * 60 * 60 * 1000, ['.ingested', '.in-progress']);

    const names = readdirSync(dir).sort();
    expect(names).toContain('live.txt');
    expect(names).toContain('live.txt.ingested');
    expect(names).toContain('fresh.ledger.json');
    expect(names).not.toContain('gone.txt.ingested');
    expect(names).not.toContain('gone.txt.in-progress');
    expect(names).not.toContain('old.ledger.json');
  });
});
