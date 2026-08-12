/**
 * `gbrain volunteer-hook` — the one-shot harness hook entry.
 *
 * Exit-0/silence contract, IPC-first ladder (new-serve verbatim vs old-serve
 * client-gate), transcript-derived dedupe input, thin-client/PGLite refusals,
 * deadline, and the structural pins (STARTUP_HOOK_SKIP_COMMANDS membership is
 * a SOURCE GREP because maybeEmitUpdateMarker no-ops under NODE_ENV=test —
 * a runtime test would pass vacuously).
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVolunteerHook, HOOK_IPC_TIMEOUT_MS, type VolunteerHookDeps } from '../src/commands/volunteer-hook.ts';
import { IPC_UNAVAILABLE, type ResolveRequest, type ResolveResponse } from '../src/core/context/resolve-ipc.ts';
import {
  gateVolunteeredPointers,
  candidatesByNorm,
  type VolunteeredPage,
} from '../src/core/context/volunteer.ts';
import { extractCandidatesFromWindow } from '../src/core/context/entity-salience.ts';
import type { PointerBlock } from '../src/core/context/retrieval-reflex.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

const PGLITE_CFG = { engine: 'pglite', database_path: '/tmp/fake-brain.pglite' } as unknown as GBrainConfig;
const PG_CFG = { engine: 'postgres', database_url: 'postgres://u:p@host:5432/db' } as unknown as GBrainConfig;

const BLOCK: PointerBlock = {
  pointers: [
    { display: 'Acme Example', slug: 'companies/acme-example', source_id: 'default', synopsis: 'a company', arm: 'alias', confidence: 0.9 },
    { display: 'Widget Co', slug: 'companies/widget-co', source_id: 'default', synopsis: 'another', arm: 'slug-suffix', confidence: 0.6 },
  ],
  text: 'BLOCK',
};
const GATED: VolunteeredPage[] = [
  { slug: 'companies/acme-example', source_id: 'default', display: 'Acme Example', confidence: 0.9, arm: 'alias', rationale: 'alias match "Acme Example"', synopsis: 'a company' },
];

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'sess-1',
    transcript_path: null,
    cwd: '/tmp/host-repo',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'What is new with Acme Example?',
    ...overrides,
  });
}

function deps(overrides: Partial<VolunteerHookDeps> & { stdin: string }): { d: VolunteerHookDeps; errs: string[]; outs: string[] } {
  const errs: string[] = [];
  const outs: string[] = [];
  const d: VolunteerHookDeps = {
    write: (s) => outs.push(s),
    warn: (s) => errs.push(s),
    loadConfigFn: (() => PGLITE_CFG) as VolunteerHookDeps['loadConfigFn'],
    resolveViaIpcRawFn: (async () => ({ ok: true, block: BLOCK, volunteered: GATED })) as unknown as VolunteerHookDeps['resolveViaIpcRawFn'],
    ...overrides,
  };
  return { d, errs, outs };
}

const HARNESS = ['--harness', 'claude-code'];

describe('volunteer-hook silence contract', () => {
  test('junk stdin → empty output, never throws', async () => {
    const { d, errs } = deps({ stdin: 'total garbage {{{' });
    const out = await runVolunteerHook(HARNESS, d);
    expect(out).toBe('');
    expect(errs.join('\n')).toContain('not a recognized hook payload');
  });

  test('missing --harness (and no --json) → silence with hint', async () => {
    const { d, errs } = deps({ stdin: payload() });
    expect(await runVolunteerHook([], d)).toBe('');
    expect(errs.join('\n')).toContain('--harness');
  });

  test('unknown --harness value → silence', async () => {
    const { d, errs } = deps({ stdin: payload() });
    expect(await runVolunteerHook(['--harness', 'vim'], d)).toBe('');
    expect(errs.join('\n')).toContain('unknown --harness');
  });

  test('--json refused on hook payloads (debug flag left in a registration)', async () => {
    const { d, errs } = deps({ stdin: payload() });
    expect(await runVolunteerHook(['--json'], d)).toBe('');
    expect(errs.join('\n')).toContain('--json refused');
  });

  test('zero candidates (smalltalk) → silence before any I/O', async () => {
    let ipcCalled = false;
    const { d } = deps({
      stdin: payload({ prompt: 'good morning, how are you today?' }),
      resolveViaIpcRawFn: (async () => { ipcCalled = true; return IPC_UNAVAILABLE; }) as unknown as VolunteerHookDeps['resolveViaIpcRawFn'],
    });
    expect(await runVolunteerHook(HARNESS, d)).toBe('');
    expect(ipcCalled).toBe(false);
  });

  test('thin-client install → silence with named limitation', async () => {
    const { d, errs } = deps({
      stdin: payload(),
      loadConfigFn: (() => ({ remote_mcp: { mcp_url: 'https://brain.example' } }) as unknown as GBrainConfig) as VolunteerHookDeps['loadConfigFn'],
    });
    expect(await runVolunteerHook(HARNESS, d)).toBe('');
    expect(errs.join('\n')).toContain('thin-client');
  });

  test('unexpected throw anywhere → caught, silence', async () => {
    const { d, errs } = deps({
      stdin: payload(),
      loadConfigFn: (() => { throw new Error('config exploded'); }) as VolunteerHookDeps['loadConfigFn'],
    });
    expect(await runVolunteerHook(HARNESS, d)).toBe('');
    expect(errs.join('\n')).toContain('config');
  });

  test('deadline exceeded → silence (slow IPC never blocks the prompt)', async () => {
    const { d, errs } = deps({
      stdin: payload(),
      deadlineMs: 100,
      resolveViaIpcRawFn: (async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { ok: true, block: BLOCK, volunteered: GATED };
      }) as unknown as VolunteerHookDeps['resolveViaIpcRawFn'],
    });
    const out = await runVolunteerHook(HARNESS, d);
    expect(out).toBe('');
    expect(errs.join('\n')).toContain('deadline');
  });
});

describe('volunteer-hook ladder', () => {
  test('NEW serve: volunteered used verbatim; envelope emitted with the block header', async () => {
    let req: ResolveRequest | null = null;
    const { d, outs } = deps({
      stdin: payload(),
      resolveViaIpcRawFn: (async (_sock: string, r: ResolveRequest) => {
        req = r;
        return { ok: true, block: BLOCK, volunteered: GATED } as ResolveResponse;
      }) as unknown as VolunteerHookDeps['resolveViaIpcRawFn'],
    });
    const out = await runVolunteerHook(HARNESS, d);
    expect(out).toContain('hookSpecificOutput');
    const env = JSON.parse(out);
    expect(env.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(env.hookSpecificOutput.additionalContext).toContain('## Brain pages mentioned this turn');
    expect(env.hookSpecificOutput.additionalContext).toContain('companies/acme-example');
    expect(outs.join('')).toBe(out); // written to stdout
    // request shape: volunteer fields + channel + cwd + old-serve bound
    expect(req!.volunteer!.maxPages).toBe(3);
    expect(req!.maxPointers).toBe(3);
    expect(req!.channel).toBe('claude-code');
    expect(req!.cwd).toBe('/tmp/host-repo');
    expect(req!.suppression).toBe('slug-only');
  });

  test('OLD serve (no volunteered field): client applies the SAME pure gate — gate-function parity pin', async () => {
    const { d } = deps({
      stdin: payload(),
      resolveViaIpcRawFn: (async () => ({ ok: true, block: BLOCK }) as ResolveResponse) as unknown as VolunteerHookDeps['resolveViaIpcRawFn'],
    });
    const out = await runVolunteerHook(HARNESS, d);
    // Client-side gate result must equal the gate run directly on the same
    // block + candidates (server helper ≡ client call). NOT end-to-end path
    // parity: an old serve resolves a smaller pre-gate pool (maxPointers
    // bound), which can legitimately return fewer pages than a new serve.
    const turns = [{ role: 'user' as const, text: 'What is new with Acme Example?' }];
    const candidates = extractCandidatesFromWindow(turns);
    const expected = gateVolunteeredPointers(BLOCK, candidatesByNorm(candidates), {
      maxPages: 3,
      minConfidence: 0.7,
      windowSize: turns.length,
    });
    expect(expected.map((p) => p.slug)).toEqual(['companies/acme-example']); // slug-suffix 0.6 gated out
    const env = JSON.parse(out);
    expect(env.hookSpecificOutput.additionalContext).toContain('companies/acme-example');
    expect(env.hookSpecificOutput.additionalContext).not.toContain('companies/widget-co');
  });

  test('typed server error (unknown_source) → silence with the error on stderr', async () => {
    const { d, errs } = deps({
      stdin: payload(),
      resolveViaIpcRawFn: (async () => ({ ok: false, error: 'unknown_source: no source named "typo"' }) as ResolveResponse) as unknown as VolunteerHookDeps['resolveViaIpcRawFn'],
    });
    expect(await runVolunteerHook(HARNESS, d)).toBe('');
    expect(errs.join('\n')).toContain('unknown_source');
  });

  test('PGLite + IPC unavailable → silence, direct connect NEVER attempted', async () => {
    let connected = false;
    const { d, errs } = deps({
      stdin: payload(),
      resolveViaIpcRawFn: (async () => IPC_UNAVAILABLE) as unknown as VolunteerHookDeps['resolveViaIpcRawFn'],
      connectDirect: async () => { connected = true; return null; },
    });
    expect(await runVolunteerHook(HARNESS, d)).toBe('');
    expect(connected).toBe(false);
    expect(errs.join('\n')).toContain('no safe direct rung');
  });

  test('Postgres + IPC unavailable → rung 2 attempts the direct connect (deps-injected)', async () => {
    let connected = false;
    const { d, errs } = deps({
      stdin: payload(),
      loadConfigFn: (() => PG_CFG) as VolunteerHookDeps['loadConfigFn'],
      resolveViaIpcRawFn: (async () => IPC_UNAVAILABLE) as unknown as VolunteerHookDeps['resolveViaIpcRawFn'],
      connectDirect: async () => { connected = true; return null; },
    });
    expect(await runVolunteerHook(HARNESS, d)).toBe('');
    expect(connected).toBe(true);
    expect(errs.join('\n')).toContain('direct connect unavailable');
  });
});

describe('volunteer-hook transcript-derived dedupe (T0 mechanism)', () => {
  test('priorContextText = ONLY previously-injected blocks; window includes tail turns + current prompt', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'vh-home-'));
    const tp = join(fakeHome, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'earlier turn about Widget Co' } }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['## Brain pages mentioned this turn\n- **Acme Example** → `companies/acme-example` — synopsis'] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'noted' }] } }),
    ];
    writeFileSync(tp, lines.join('\n') + '\n');
    let req: ResolveRequest | null = null;
    const { d } = deps({
      stdin: payload({ transcript_path: tp }),
      resolveViaIpcRawFn: (async (_s: string, r: ResolveRequest) => {
        req = r;
        return { ok: true, block: null, volunteered: [] } as ResolveResponse;
      }) as unknown as VolunteerHookDeps['resolveViaIpcRawFn'],
    });
    await withEnv({ HOME: fakeHome }, async () => {
      await runVolunteerHook(HARNESS, d);
    });
    // Dedupe input is the injected block ONLY — the user's raw "Widget Co"
    // mention must NOT be suppression input (over-suppression pin).
    expect(req!.priorContextText).toContain('companies/acme-example');
    expect(req!.priorContextText).not.toContain('Widget Co');
    // Window: tail turns + the current prompt appended as newest user turn.
    expect(req!.volunteer!.windowSize).toBe(3);
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test('unreadable transcript → prompt-only window, no dedupe input, still proceeds', async () => {
    let req: ResolveRequest | null = null;
    const { d, errs } = deps({
      stdin: payload({ transcript_path: '/nonexistent/nope.jsonl' }),
      resolveViaIpcRawFn: (async (_s: string, r: ResolveRequest) => {
        req = r;
        return { ok: true, block: null, volunteered: [] } as ResolveResponse;
      }) as unknown as VolunteerHookDeps['resolveViaIpcRawFn'],
    });
    await runVolunteerHook(HARNESS, d);
    expect(req!.priorContextText).toBeUndefined();
    expect(req!.volunteer!.windowSize).toBe(1);
    expect(errs.join('\n')).toContain('transcript tail unreadable');
  });
});

describe('volunteer-hook --json debug mode', () => {
  test('plain-text stdin → raw pages JSON (no envelope)', async () => {
    const { d } = deps({
      stdin: 'checking on Acme Example today',
      resolveViaIpcRawFn: (async () => ({ ok: true, block: BLOCK, volunteered: GATED }) as ResolveResponse) as unknown as VolunteerHookDeps['resolveViaIpcRawFn'],
    });
    const out = await runVolunteerHook(['--json'], d);
    const parsed = JSON.parse(out);
    expect(parsed.count).toBe(1);
    expect(parsed.pages[0].slug).toBe('companies/acme-example');
    expect(out).not.toContain('hookSpecificOutput');
  });
});

describe('structural pins (source greps — runtime paths are test-blind)', () => {
  const cliSrc = readFileSync(join(import.meta.dir, '..', 'src', 'cli.ts'), 'utf8');

  test('volunteer-hook ∈ STARTUP_HOOK_SKIP_COMMANDS (maybeEmitUpdateMarker no-ops under NODE_ENV=test — only this grep guards it)', () => {
    const m = cliSrc.match(/const STARTUP_HOOK_SKIP_COMMANDS = new Set\(\[[\s\S]*?\]\)/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain("'volunteer-hook'");
  });

  test('volunteer-hook ∈ CLI_ONLY and CLI_ONLY_SELF_HELP (the #2035 undispatchable/help-eaten class)', () => {
    // Lazy match to end-of-statement: the set body carries comments that may
    // themselves contain brackets (e.g. plan tags like [CX2-5]).
    const cliOnly = cliSrc.match(/export const CLI_ONLY = new Set\(\[[\s\S]*?\]\);/);
    expect(cliOnly).not.toBeNull();
    expect(cliOnly![0]).toContain("'volunteer-hook'");
    const selfHelp = cliSrc.match(/const CLI_ONLY_SELF_HELP = new Set\(\[[\s\S]*?\]\);/);
    expect(selfHelp![0]).toContain("'volunteer-hook'");
  });

  test('volunteer-hook dispatches BEFORE connectEngine (pre-connect early dispatch)', () => {
    const dispatchIdx = cliSrc.indexOf("if (command === 'volunteer-hook')");
    const connectIdx = cliSrc.indexOf('// All remaining CLI-only commands need a DB connection');
    expect(dispatchIdx).toBeGreaterThan(0);
    expect(connectIdx).toBeGreaterThan(0);
    expect(dispatchIdx).toBeLessThan(connectIdx);
  });

  test('hook command never constructs a PGLite engine in-process (rung 2 is Postgres-only)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'volunteer-hook.ts'), 'utf8');
    expect(src).not.toContain('PGlite.create');
    expect(src).not.toContain("from '../core/pglite-engine.ts'");
    expect(src).toContain("engineCfg.engine !== 'postgres'");
  });
});
