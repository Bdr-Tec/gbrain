/**
 * bootstrap status — phase list [D5], install log [B1], runbook skew [C1],
 * support blob [B5], and the CLI reachability membership asserts (#2035
 * precedent, extended per ENG-2 for the bootstrap family).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CLI_ONLY, THIN_CLIENT_REFUSED_COMMANDS } from '../src/cli.ts';
import { VERSION } from '../src/version.ts';
import {
  BOOTSTRAP_PHASE_IDS,
  PHASES,
  appendInstallLog,
  readInstallLog,
  installLogPath,
  readRunbookStamp,
  listVerifyRuns,
  statusReport,
} from '../src/core/bootstrap/status.ts';
import { initState, setAnswer, confirm, readBackHash } from '../src/core/bootstrap/interview.ts';
import { writeManifest } from '../src/core/bootstrap/format.ts';
import { loadQuestionBank } from '../src/core/bootstrap/assets.ts';

let tmpParent: string; // GBRAIN_HOME parent (configDir appends .gbrain)
let home: string;
let ws: string;
let prevHome: string | undefined;

beforeAll(() => {
  tmpParent = mkdtempSync(join(tmpdir(), 'gb-status-'));
  home = join(tmpParent, '.gbrain');
  mkdirSync(home, { recursive: true });
  ws = mkdtempSync(join(tmpdir(), 'gb-status-ws-'));
  prevHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmpParent;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(tmpParent, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

describe('phase list is the single TS source of truth [D5]', () => {
  test('PHASES matches BOOTSTRAP_PHASE_IDS exactly, in order', () => {
    expect(PHASES.map((p) => p.id)).toEqual([...BOOTSTRAP_PHASE_IDS]);
    expect(BOOTSTRAP_PHASE_IDS).toEqual([
      'preflight', 'engine', 'interview', 'render', 'skills', 'wire', 'repo', 'verify',
    ]);
  });

  test('every phase carries a title, a resume hint, and a detector', () => {
    for (const p of PHASES) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.resume_hint.length).toBeGreaterThan(0);
      expect(typeof p.detect).toBe('function');
    }
  });
});

describe('CLI reachability membership (#2035 shape, ENG-2)', () => {
  test('bootstrap, hook, and sweep are in CLI_ONLY so dispatch reaches them', () => {
    expect(CLI_ONLY.has('bootstrap')).toBe(true);
    expect(CLI_ONLY.has('hook')).toBe(true);
    expect(CLI_ONLY.has('sweep')).toBe(true);
  });

  test('bootstrap and hook are NOT thin-client refused; sweep IS (local engine only)', () => {
    expect(THIN_CLIENT_REFUSED_COMMANDS.has('bootstrap')).toBe(false);
    expect(THIN_CLIENT_REFUSED_COMMANDS.has('hook')).toBe(false);
    expect(THIN_CLIENT_REFUSED_COMMANDS.has('sweep')).toBe(true);
  });
});

describe('install log [B1]', () => {
  test('append + read round-trip, torn lines skipped, never throws', () => {
    appendInstallLog(home, {
      ts: new Date().toISOString(),
      phase: 'render',
      outcome: 'ok',
      duration_ms: 12,
      binary_version: VERSION,
      workspace: ws,
    });
    // Torn line in the middle must not break the reader.
    writeFileSync(installLogPath(home), '{"half\n', { flag: 'a' });
    appendInstallLog(home, {
      ts: new Date().toISOString(),
      phase: 'wire',
      outcome: 'error',
      duration_ms: 5,
      binary_version: VERSION,
      harness: 'claude-code',
      workspace: ws,
    });
    const entries = readInstallLog(home);
    expect(entries.length).toBe(2);
    expect(entries[0].phase).toBe('render');
    expect(entries[1].phase).toBe('wire');
    expect(entries[1].harness).toBe('claude-code');
  });

  test('reader returns [] for a missing log', () => {
    expect(readInstallLog(join(tmpdir(), 'no-such-gbrain-home'))).toEqual([]);
  });
});

describe('runbook stamp [C1]', () => {
  test('reads the stamp comment; null when absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-runbook-'));
    expect(readRunbookStamp(dir)).toBeNull();
    writeFileSync(join(dir, 'BOOTSTRAP_FOR_AGENTS.md'), '<!-- gbrain-runbook-stamp: 0.0.1 -->\n# runbook\n');
    expect(readRunbookStamp(dir)).toBe('0.0.1');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('statusReport detection + support blob [B5]', () => {
  test('fresh workspace: engine/interview/render/verify pending, next action present', async () => {
    const report = await statusReport(ws, { gbrainHomeDir: home });
    const byId = new Map(report.phases.map((p) => [p.id, p]));
    expect(byId.get('engine')!.state).toBe('pending');
    expect(byId.get('interview')!.state).toBe('pending');
    expect(byId.get('render')!.state).toBe('pending');
    expect(byId.get('verify')!.state).toBe('pending');
    expect(report.next).toBeTruthy();
    expect(report.support.binary_version).toBe(VERSION);
    expect(report.support.engine).toBeNull();
    expect(report.support.harness_registrations).toEqual([]);
  });

  test('artifacts flip phases: config → engine done; confirmed interview → done; manifest → render done', async () => {
    // engine: config file in the sandboxed home.
    writeFileSync(join(home, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, 'brain.pglite') }));

    // interview: answer every required key, then confirm the read-back hash.
    const bank = loadQuestionBank();
    const required = bank.interviewKeys.filter((k) => bank.questions[k]?.required === true);
    expect(initState(ws).ok).toBe(true);
    for (const key of required) {
      const r = setAnswer(ws, key, `verbatim answer for ${key} with enough substance to be real`);
      expect(r.ok).toBe(true);
    }
    const h = readBackHash(ws);
    if (!h.ok) throw new Error('readBackHash failed');
    expect(confirm(ws, h.hash).ok).toBe(true);

    // render: initialized manifest.
    writeManifest(ws, {
      format_version: 1,
      initialized: true,
      agent_name: 'Testy',
      created_by: 'test',
      created_at: new Date().toISOString(),
      source_id: 'workspace',
    });

    // verify: one persisted failing snapshot → verify phase partial.
    mkdirSync(join(home, 'bootstrap'), { recursive: true });
    writeFileSync(
      join(home, 'bootstrap', 'verify-2026-01-01T00-00-00-000Z.json'),
      JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', ok: false, checks: [{ id: 'roundtrip', ok: false, detail: 'x' }] }),
    );

    const report = await statusReport(ws, { gbrainHomeDir: home });
    const byId = new Map(report.phases.map((p) => [p.id, p]));
    expect(byId.get('engine')!.state).toBe('done');
    expect(byId.get('interview')!.state).toBe('done');
    expect(byId.get('render')!.state).toBe('done');
    expect(byId.get('verify')!.state).toBe('partial');
    expect(report.support.engine).toBe('pglite');
    expect(report.support.last_verify).toEqual({
      ts: '2026-01-01T00:00:00.000Z',
      ok: false,
      checks_failed: ['roundtrip'],
    });
    // listVerifyRuns agrees with the support blob.
    const runs = listVerifyRuns(home);
    expect(runs.length).toBe(1);
    expect(runs[0].ok).toBe(false);
  });

  test('runbook skew surfaces when the stamp disagrees with the binary', async () => {
    writeFileSync(join(ws, 'BOOTSTRAP_FOR_AGENTS.md'), '<!-- gbrain-runbook-stamp: 0.0.1 -->\n');
    const report = await statusReport(ws, { gbrainHomeDir: home });
    expect(report.runbookSkew).toEqual({ runbookStamp: '0.0.1', binaryVersion: VERSION });

    // Matching stamp → no skew reported.
    writeFileSync(join(ws, 'BOOTSTRAP_FOR_AGENTS.md'), `<!-- gbrain-runbook-stamp: ${VERSION} -->\n`);
    const clean = await statusReport(ws, { gbrainHomeDir: home });
    expect(clean.runbookSkew).toBeUndefined();
  });
});
