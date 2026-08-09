/**
 * bootstrap verify — the D8 check union against a hermetic in-memory PGLite
 * brain (the resolve-ipc-v2 pattern): keyless roundtrip [G1/CX-P0.5],
 * graph floor [CX2-5], magic moment via the ## Facts fence, probe cleanup
 * [G13], failure-shape checks (token sweep / byte floors / secret scan), and
 * snapshot retention [B2].
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { addSource } from '../src/core/sources-ops.ts';
import { writeManifest } from '../src/core/bootstrap/format.ts';
import { initState, setAnswer, confirm, readBackHash } from '../src/core/bootstrap/interview.ts';
import { loadQuestionBank } from '../src/core/bootstrap/assets.ts';
import { byteFloors } from '../src/core/bootstrap/render.ts';
import {
  verifyWorkspace,
  VERIFY_PROBE_SLUG,
  VERIFY_PROBE_ENTITY_SLUG,
  VERIFY_MAGIC_TOKEN,
  VERIFY_SNAPSHOTS_KEPT,
  FIRST_RUN_TOUR,
} from '../src/core/bootstrap/verify.ts';
import { listVerifyRuns } from '../src/core/bootstrap/status.ts';
import type { CapabilityReport } from '../src/core/capability.ts';

const KEYLESS: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: false },
  search: 'keyword-only',
  mode: 'keyless',
};

let engine: PGLiteEngine;
let tmpParent: string;
let home: string;
let ws: string;
let prevHome: string | undefined;

function pad(text: string, bytes: number): string {
  let out = text;
  while (Buffer.byteLength(out, 'utf8') < bytes) {
    out += '\nSubstantive identity prose rendered from real interview answers, not filler headers.';
  }
  return out;
}

beforeAll(async () => {
  tmpParent = mkdtempSync(join(tmpdir(), 'gb-verify-'));
  home = join(tmpParent, '.gbrain');
  mkdirSync(join(home, 'bootstrap'), { recursive: true });
  ws = mkdtempSync(join(tmpdir(), 'gb-verify-ws-'));
  prevHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmpParent;

  // Workspace shape: initialized manifest + interview answers (6 required,
  // confirmed) + identity files above the 6-answer byte floors + brain/.
  writeManifest(ws, {
    format_version: 1,
    initialized: true,
    agent_name: 'Verify Test Agent',
    created_by: 'test',
    created_at: new Date().toISOString(),
    source_id: 'workspace',
  });
  const bank = loadQuestionBank();
  const required = bank.interviewKeys.filter((k) => bank.questions[k]?.required === true);
  expect(initState(ws).ok).toBe(true);
  const answers: Record<string, string> = {
    AGENT_NAME: 'Testa',
    PRINCIPAL_NAME: 'Pat Example',
    AGENT_PURPOSE: 'Maintain the research corpus and draft the weekly memo without re-briefing.',
    AGENT_TOP_JOBS: '- corpus upkeep\n- weekly memo\n- meeting prep',
    PRINCIPAL_CONTEXT: 'Runs a small research group; builds internal tooling; cares about signal over noise.',
    VOICE_REGISTER: 'Direct: three options, the second one wins.',
  };
  for (const key of required) {
    const r = setAnswer(ws, key, answers[key] ?? `a real answer for ${key}`);
    if (!r.ok) throw new Error(`setAnswer(${key}) failed: ${r.message}`);
  }
  const h = readBackHash(ws);
  if (!h.ok) throw new Error(h.message);
  expect(confirm(ws, h.hash).ok).toBe(true);

  const floors = byteFloors(required.length);
  writeFileSync(join(ws, 'SOUL.md'), pad('# Soul\n\nIdentity rendered from answers.\n', floors['SOUL.md'] + 200));
  writeFileSync(join(ws, 'USER.md'), pad('# User\n\nTheir literal words are ground truth.\n', floors['USER.md'] + 100));
  mkdirSync(join(ws, 'brain'), { recursive: true });

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // The workspace source: brain/ registered with its own local_path so the
  // put_page write-through materializes committed files under brain/ [G1].
  await addSource(engine, { id: 'workspace', localPath: join(ws, 'brain'), force: true });
}, 240_000);

afterAll(async () => {
  try {
    await engine.disconnect();
  } catch {
    /* noop */
  }
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(tmpParent, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

function check(checks: Array<{ id: string; ok: boolean; warn?: boolean; detail: string }>, id: string) {
  const found = checks.filter((c) => c.id === id);
  expect(found.length).toBeGreaterThan(0);
  return found;
}

describe('verifyWorkspace — keyless pass', () => {
  test('roundtrip + graph floor + magic moment pass with ZERO api keys; probes cleaned up', async () => {
    // Snapshot-retention setup [B2]: pre-seed old snapshots so the prune path runs.
    for (let i = 0; i < VERIFY_SNAPSHOTS_KEPT; i++) {
      writeFileSync(
        join(home, 'bootstrap', `verify-2020-01-0${i + 1}T00-00-00-000Z.json`),
        JSON.stringify({ ts: `2020-01-0${i + 1}T00:00:00.000Z`, ok: true, checks: [] }),
      );
    }

    const res = await verifyWorkspace(engine, ws, {
      sourceId: 'workspace',
      gbrainHomeDir: home,
      capabilities: KEYLESS,
    });

    // Individual checks.
    expect(check(res.checks, 'doctor_green')[0].ok).toBe(true);
    expect(check(res.checks, 'token_sweep')[0].ok).toBe(true);
    expect(check(res.checks, 'byte_floors')[0].ok).toBe(true);
    expect(check(res.checks, 'secret_scan')[0].ok).toBe(true);
    expect(check(res.checks, 'deny_globs')[0].ok).toBe(true);
    expect(check(res.checks, 'repo_privacy')[0].ok).toBe(true); // local-only
    for (const c of check(res.checks, 'roundtrip')) expect(c.ok).toBe(true);
    expect(check(res.checks, 'graph_floor')[0].ok).toBe(true);
    expect(check(res.checks, 'magic_moment')[0].ok).toBe(true);
    expect(check(res.checks, 'capability_report')[0].detail).toContain('keyless');
    expect(check(res.checks, 'hooks_smoke')[0].ok).toBe(true); // not installed → not applicable
    expect(check(res.checks, 'first_run_tour')[0].ok).toBe(true);
    expect(res.ok).toBe(true);

    // The report embeds the capability block + the three scripted prompts [D3.6/A4].
    expect(res.report).toContain('keyless mode');
    for (const prompt of FIRST_RUN_TOUR) {
      expect(res.report).toContain(prompt);
    }
    expect(res.tour).toEqual([...FIRST_RUN_TOUR]);

    // Probe cleanup [G13]: pages, files, and the reconciled fact are gone.
    expect(existsSync(join(ws, 'brain', `${VERIFY_PROBE_SLUG}.md`))).toBe(false);
    expect(existsSync(join(ws, 'brain', `${VERIFY_PROBE_ENTITY_SLUG}.md`))).toBe(false);
    const facts = await engine.executeRaw<{ fact: string }>(
      `SELECT fact FROM facts WHERE source_id = $1 AND fact LIKE $2`,
      ['workspace', `%${VERIFY_MAGIC_TOKEN}%`],
    );
    expect(facts.length).toBe(0);

    // Snapshot persisted + retention holds at VERIFY_SNAPSHOTS_KEPT [B2].
    const runs = listVerifyRuns(home);
    expect(runs.length).toBeLessThanOrEqual(VERIFY_SNAPSHOTS_KEPT);
    expect(runs[0].ok).toBe(true); // newest = this run
  }, 240_000);

  test('failure shapes: unresolved token + under-floor USER.md + planted secret all surface', async () => {
    const soulPath = join(ws, 'SOUL.md');
    const userPath = join(ws, 'USER.md');
    const githubPath = join(ws, 'GITHUB.md');
    const soulOriginal = readFileSync(soulPath, 'utf8');
    const userOriginal = readFileSync(userPath, 'utf8');
    try {
      writeFileSync(githubPath, '# GitHub\n\nRepo: {{GITHUB_REPO_URL}}\n');
      writeFileSync(userPath, '# tiny\n');
      writeFileSync(soulPath, soulOriginal + '\napi dump: sk-AAAAAAAAAAAAAAAAAAAAAAAA\n');

      const res = await verifyWorkspace(engine, ws, {
        sourceId: 'workspace',
        gbrainHomeDir: home,
        capabilities: KEYLESS,
      });

      const token = check(res.checks, 'token_sweep')[0];
      expect(token.ok).toBe(false);
      expect(token.detail).toContain('GITHUB.md');
      expect(token.detail).toContain('GITHUB_REPO_URL');

      const floors = check(res.checks, 'byte_floors')[0];
      expect(floors.ok).toBe(false);
      expect(floors.detail).toContain('USER.md');

      const scan = check(res.checks, 'secret_scan')[0];
      expect(scan.ok).toBe(false);
      expect(scan.detail).toContain('openai');
      // Redaction discipline: the finding detail NEVER carries the secret value.
      expect(scan.detail).not.toContain('sk-AAAAAAAAAAAAAAAAAAAAAAAA');

      expect(res.ok).toBe(false);
    } finally {
      rmSync(githubPath, { force: true });
      writeFileSync(userPath, userOriginal);
      writeFileSync(soulPath, soulOriginal);
    }
  }, 240_000);
});
