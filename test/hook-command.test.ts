/**
 * `gbrain hook <event>` (agent-bootstrap D5, A3, A9, G3, G4, G15, B3, B4,
 * ENG-1, S3#2, S3#7, S3#8): in-process stdin→stdout contract against an
 * in-process IPC server (never a spawned serve — the hook-under-serve e2e is
 * a separate task). Fail-open everywhere, heartbeat schema allowlist, digest
 * section allowlist + cap, corpus redaction/dedup/retention, parser drift.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runHook,
  heartbeatPath,
  hookStatusPath,
  readHeartbeatTail,
  HEARTBEAT_ALLOWED_KEYS,
  HEARTBEAT_MAX_LINES,
  DIGEST_MEMORY_CAP_BYTES,
  memoryDigest,
  type HookHeartbeatEntry,
} from '../src/commands/hook.ts';
import {
  ensureIpcSecret,
  resolveSocketPath,
  startResolveIpcServer,
  type TurnContextRequest,
} from '../src/core/context/resolve-ipc.ts';
import { CLAUDE_HOOK_OUTPUT_CAP_CHARS } from '../src/core/bootstrap/host-specs.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'conversation-formats', 'claude-code.jsonl');
const ENV_KEYS = ['GBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_HOOKS'] as const;

let tmp: string;
let saved: Record<string, string | undefined>;
let servers: net.Server[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-hk-'));
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GBRAIN_HOME = tmp; // config/heartbeat/corpus all under tmp/.gbrain
});

afterEach(() => {
  for (const s of servers) {
    try { s.close(); } catch { /* noop */ }
  }
  servers = [];
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

const home = () => join(tmp, '.gbrain');

function writePgliteConfig(dataDir: string): void {
  mkdirSync(home(), { recursive: true });
  writeFileSync(join(home(), 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dataDir }));
}

function collectStdout(): { io: { write: (s: string) => void }; get: () => string } {
  let buf = '';
  return { io: { write: (s: string) => { buf += s; } }, get: () => buf };
}

async function lastHeartbeat(): Promise<HookHeartbeatEntry | undefined> {
  const tail = await readHeartbeatTail(1);
  return tail[0];
}

/** In-process v2 IPC server with a canned turn_context block. */
async function startServer(opts: {
  dataDir: string;
  blockText?: string | null;
  secretOverride?: string;
  boundSourceId?: string;
  onRequest?: (req: TurnContextRequest) => void;
}): Promise<void> {
  mkdirSync(opts.dataDir, { recursive: true });
  const secret = opts.secretOverride ?? ensureIpcSecret(opts.dataDir);
  if (opts.secretOverride) ensureIpcSecret(opts.dataDir); // client still reads the file secret
  const server = await startResolveIpcServer(
    resolveSocketPath(opts.dataDir),
    {
      resolve: async () => null,
      turn_context: async (req) => {
        opts.onRequest?.(req);
        if (opts.blockText == null) return null;
        return { text: opts.blockText, pointers: [], factsCount: 0 };
      },
    },
    { secret, ...(opts.boundSourceId ? { boundSourceId: opts.boundSourceId } : {}) },
  );
  expect(server).not.toBeNull();
  servers.push(server!);
}

// ── Dispatch + kill switch ──────────────────────────────────────────────────

describe('dispatch', () => {
  test('GBRAIN_HOOKS=0 short-circuits every event: exit 0, no output, no heartbeat', async () => {
    process.env.GBRAIN_HOOKS = '0';
    for (const event of ['session-start', 'user-prompt', 'stop', 'session-end']) {
      const out = collectStdout();
      expect(await runHook([event], { ...out.io, stdin: '{}' })).toBe(0);
      expect(out.get()).toBe('');
    }
    expect(existsSync(join(home(), 'integrations', 'hooks', 'heartbeat.jsonl'))).toBe(false);
  });

  test('unknown/missing event → usage + exit 1; --help → exit 0', async () => {
    expect(await runHook(['no-such-event'], { stdin: '' })).toBe(1);
    expect(await runHook([], { stdin: '' })).toBe(1);
    const out = collectStdout();
    expect(await runHook(['--help'], out.io)).toBe(0);
    expect(out.get()).toContain('session-start');
  });
});

// ── user-prompt [ENG-1, S3#8, A9] ───────────────────────────────────────────

describe('user-prompt', () => {
  test('fail-open on missing config: exit 0, empty stdout, degraded heartbeat', async () => {
    const out = collectStdout();
    expect(await runHook(['user-prompt'], { ...out.io, stdin: JSON.stringify({ prompt: 'hello' }) })).toBe(0);
    expect(out.get()).toBe('');
    const hb = await lastHeartbeat();
    expect(hb?.event).toBe('user-prompt');
    expect(hb?.outcome).toBe('degraded');
    expect(hb?.reason).toBe('no_pglite_path');
  });

  test('no stdin → degraded no_stdin, exit 0 empty', async () => {
    const out = collectStdout();
    expect(await runHook(['user-prompt'], { ...out.io, stdin: '' })).toBe(0);
    expect(out.get()).toBe('');
    expect((await lastHeartbeat())?.reason).toBe('no_stdin');
  });

  test('pull-mode when no serve has minted a secret: no_serve', async () => {
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    writePgliteConfig(dataDir);
    const out = collectStdout();
    await runHook(['user-prompt'], { ...out.io, stdin: JSON.stringify({ prompt: 'hi' }) });
    expect(out.get()).toBe('');
    expect((await lastHeartbeat())?.reason).toBe('no_serve');
  });

  test('happy path: additionalContext JSON contract, ≤10000 chars [ENG-1]', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    await startServer({ dataDir, blockText: 'CTX: alice-example runs widget-co' });
    const out = collectStdout();
    expect(
      await runHook(['user-prompt'], {
        ...out.io,
        stdin: JSON.stringify({ prompt: 'what does alice-example do?', session_id: 's-1' }),
      }),
    ).toBe(0);
    const payload = out.get().trim();
    expect(payload.length).toBeGreaterThan(0);
    expect(payload.length).toBeLessThanOrEqual(CLAUDE_HOOK_OUTPUT_CAP_CHARS);
    const parsed = JSON.parse(payload);
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'CTX: alice-example runs widget-co',
      },
    });
    const hb = await lastHeartbeat();
    expect(hb?.outcome).toBe('ok');
    expect(hb?.turns).toBe(1);
  });

  test('window = last 4 transcript turns + the current prompt', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    let seen: TurnContextRequest | null = null;
    await startServer({ dataDir, blockText: 'ok', onRequest: (r) => { seen = r; } });
    // Confinement seam: fixture copied under a fake projects root.
    const projRoot = join(tmp, 'projects');
    mkdirSync(join(projRoot, 'p1'), { recursive: true });
    const transcript = join(projRoot, 'p1', 'sess.jsonl');
    copyFileSync(FIXTURE, transcript);
    const out = collectStdout();
    await runHook(['user-prompt'], {
      ...out.io,
      stdin: JSON.stringify({ prompt: 'and now?', transcript_path: transcript, session_id: 's-2' }),
      transcriptRoot: projRoot,
    });
    expect(seen).not.toBeNull();
    const win = seen!.window;
    expect(win).toHaveLength(5); // fixture has 5 turns → slice(-4) + prompt
    expect(win[win.length - 1]).toEqual({ role: 'user', text: 'and now?' });
    expect(win.map((t) => t.text).join(' ')).not.toContain('SIDECHAIN-ONLY-TEXT');
    expect((await lastHeartbeat())?.turns).toBe(5);
  });

  test('confinement rejection aborts: heartbeat + exit 0 empty [S3#8]', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    const outside = join(tmp, 'outside.jsonl');
    writeFileSync(outside, '{}\n');
    const out = collectStdout();
    expect(
      await runHook(['user-prompt'], {
        ...out.io,
        stdin: JSON.stringify({ prompt: 'x', transcript_path: outside }),
        transcriptRoot: join(tmp, 'projects-root'),
      }),
    ).toBe(0);
    expect(out.get()).toBe('');
    expect((await lastHeartbeat())?.reason).toBe('transcript_outside_projects_dir');
  });

  test('unauthorized (server holds a different secret) degrades cleanly', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    await startServer({ dataDir, blockText: 'x', secretOverride: 'not-the-file-secret' });
    const out = collectStdout();
    await runHook(['user-prompt'], { ...out.io, stdin: JSON.stringify({ prompt: 'hi' }) });
    expect(out.get()).toBe('');
    expect((await lastHeartbeat())?.reason).toBe('unauthorized');
  });

  test('source_mismatch when GBRAIN_SOURCE differs from the bound source [CX2-10]', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    await startServer({ dataDir, blockText: 'x', boundSourceId: 'other-source' });
    process.env.GBRAIN_SOURCE = 'mine';
    const out = collectStdout();
    await runHook(['user-prompt'], { ...out.io, stdin: JSON.stringify({ prompt: 'hi' }) });
    expect(out.get()).toBe('');
    expect((await lastHeartbeat())?.reason).toBe('source_mismatch');
  });

  test('stale (v1) serve without the protocol echo degrades LOUDLY [A9]', async () => {
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    writePgliteConfig(dataDir);
    ensureIpcSecret(dataDir);
    // Raw v1-shaped server: answers everything as a resolve response.
    const server = net.createServer((conn) => {
      conn.on('data', () => conn.write(JSON.stringify({ ok: true, block: null }) + '\n'));
    });
    await new Promise<void>((r) => server.listen(resolveSocketPath(dataDir), r));
    servers.push(server);
    const out = collectStdout();
    await runHook(['user-prompt'], { ...out.io, stdin: JSON.stringify({ prompt: 'hi' }) });
    expect(out.get()).toBe('');
    expect((await lastHeartbeat())?.reason).toBe('stale_serve');
  });

  test('oversized block is trimmed under the 10000-char stdout cap [ENG-1]', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    await startServer({ dataDir, blockText: 'line of context\n'.repeat(700) }); // ~11K raw, ~12K escaped
    const out = collectStdout();
    await runHook(['user-prompt'], { ...out.io, stdin: JSON.stringify({ prompt: 'hi' }) });
    const payload = out.get().trim();
    expect(payload.length).toBeGreaterThan(0);
    expect(payload.length).toBeLessThanOrEqual(CLAUDE_HOOK_OUTPUT_CAP_CHARS);
    expect(JSON.parse(payload).hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  });
});

// ── session-start [A3, B3, B4, G3] ──────────────────────────────────────────

describe('session-start', () => {
  test('digest respects the section allowlist [A3]', async () => {
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      join(ws, 'MEMORY.md'),
      [
        '# Memory',
        '## Standing rules',
        '- always verify before claiming done',
        '## Security boundary',
        'NEVER-IN-DIGEST: this section stays out of injected context',
        '## Open commitments',
        '- ship the follow-up to charlie-example',
        '## Active context',
        '- migrating widget-co notes',
        '## Scratch',
        'SCRATCH-NOT-ELIGIBLE',
      ].join('\n'),
    );
    const out = collectStdout();
    expect(await runHook(['session-start'], { ...out.io, stdin: '', cwd: ws })).toBe(0);
    const text = out.get();
    expect(text).toContain('always verify before claiming done');
    expect(text).toContain('charlie-example');
    expect(text).toContain('migrating widget-co notes');
    expect(text).not.toContain('NEVER-IN-DIGEST');
    expect(text).not.toContain('SCRATCH-NOT-ELIGIBLE');
    expect((await lastHeartbeat())?.outcome).toBe('ok');
  });

  test('digest capped at 3KB [A3]', () => {
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    const memPath = join(ws, 'MEMORY.md');
    writeFileSync(memPath, '## Standing rules\n' + 'a very long standing rule line\n'.repeat(400));
    const digest = memoryDigest(memPath);
    expect(digest).not.toBeNull();
    expect(Buffer.byteLength(digest!, 'utf8')).toBeLessThanOrEqual(DIGEST_MEMORY_CAP_BYTES + 4);
  });

  test('missing MEMORY.md: fail-open, exit 0, heartbeat ok', async () => {
    const ws = join(tmp, 'empty-ws');
    mkdirSync(ws, { recursive: true });
    const out = collectStdout();
    expect(await runHook(['session-start'], { ...out.io, stdin: '', cwd: ws })).toBe(0);
    expect((await lastHeartbeat())?.outcome).toBe('ok');
  });

  test('B3 visible degradation: >50% trailing errors → doctor notice', async () => {
    const hbPath = await heartbeatPath();
    const lines: string[] = [];
    for (let i = 0; i < 15; i++) {
      lines.push(JSON.stringify({ ts: new Date().toISOString(), event: 'user-prompt', outcome: 'error', reason: 'exception:Error', duration_ms: 5 }));
    }
    for (let i = 0; i < 3; i++) {
      lines.push(JSON.stringify({ ts: new Date().toISOString(), event: 'user-prompt', outcome: 'ok', duration_ms: 5 }));
    }
    writeFileSync(hbPath, lines.join('\n') + '\n');
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    const out = collectStdout();
    await runHook(['session-start'], { ...out.io, stdin: '', cwd: ws });
    expect(out.get()).toContain('run gbrain doctor');
  });

  test('degraded-only history does NOT trigger the notice (designed fallbacks)', async () => {
    const hbPath = await heartbeatPath();
    const lines = Array.from({ length: 20 }, () =>
      JSON.stringify({ ts: new Date().toISOString(), event: 'user-prompt', outcome: 'degraded', reason: 'no_serve', duration_ms: 3 }));
    writeFileSync(hbPath, lines.join('\n') + '\n');
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    const out = collectStdout();
    await runHook(['session-start'], { ...out.io, stdin: '', cwd: ws });
    expect(out.get()).not.toContain('run gbrain doctor');
  });

  test('last-session line + stale push-status surfaced [B4]', async () => {
    const liveDir = join(home(), 'transcripts', 'live');
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(join(liveDir, 'prev.txt'), JSON.stringify({ ts: '2026-08-07T09:00:00Z', session_id: 'prev', exchange: 'wrapped up the acme-example memo' }) + '\n');
    const bootDir = join(home(), 'bootstrap');
    mkdirSync(bootDir, { recursive: true });
    writeFileSync(join(bootDir, 'push-status.json'), JSON.stringify({ ts: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(), ok: true }));
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    const out = collectStdout();
    await runHook(['session-start'], { ...out.io, stdin: '', cwd: ws });
    const text = out.get();
    expect(text).toContain('Last session activity');
    expect(text).toContain('acme-example memo');
    expect(text).toContain('>48h ago');
  });

  test('parser-drift status file surfaced at session start [G3]', async () => {
    const statusPath = await hookStatusPath();
    writeFileSync(statusPath, JSON.stringify({ ts: new Date().toISOString(), error: 'parser_drift', bytes: 1234 }));
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    const out = collectStdout();
    await runHook(['session-start'], { ...out.io, stdin: '', cwd: ws });
    expect(out.get()).toContain('Hook alert: parser_drift');
  });
});

// ── stop [G15] ──────────────────────────────────────────────────────────────

describe('stop', () => {
  test('appends to the per-session buffer (sanitized id) and GCs stale buffers', async () => {
    const liveDir = join(home(), 'transcripts', 'live');
    mkdirSync(liveDir, { recursive: true });
    const stale = join(liveDir, 'stale.txt');
    writeFileSync(stale, 'old\n');
    const old = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    utimesSync(stale, old, old);

    expect(
      await runHook(['stop'], {
        stdin: JSON.stringify({ session_id: 'abc/../def', last_assistant_message: 'the widget-co answer' }),
      }),
    ).toBe(0);
    const files = readdirSync(liveDir);
    expect(files).toContain('abc-..-def.txt'); // '/' sanitized, no traversal possible
    expect(files).not.toContain('stale.txt');
    const body = readFileSync(join(liveDir, 'abc-..-def.txt'), 'utf8');
    expect(body).toContain('the widget-co answer');
    expect((await lastHeartbeat())?.outcome).toBe('ok');
  });
});

// ── session-end [S3#2, G3, G15, A6] ─────────────────────────────────────────

function seedTranscript(dir: string, name: string, lines: string[]): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

const userLine = (text: string) =>
  JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });
const assistantLine = (text: string) =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] } });

describe('session-end', () => {
  test('corpus write redacts a planted secret at write time [S3#2]', async () => {
    const projRoot = join(tmp, 'projects');
    const planted = 'sk-' + 'FAKEfakeFAKEfake1234567890';
    const transcript = seedTranscript(join(projRoot, 'p1'), 's.jsonl', [
      userLine(`my key is ${planted} — keep it safe`),
      assistantLine('I will not repeat that.'),
    ]);
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    expect(
      await runHook(['session-end'], {
        stdin: JSON.stringify({ session_id: 'sess-red', transcript_path: transcript, cwd: ws }),
        transcriptRoot: projRoot,
      }),
    ).toBe(0);
    const corpus = join(home(), 'transcripts', 'corpus', 'sess-red.txt');
    expect(existsSync(corpus)).toBe(true);
    const body = readFileSync(corpus, 'utf8');
    expect(body).not.toContain(planted);
    expect(body).toContain('<REDACTED:openai>');
    expect(body).toContain('I will not repeat that.');
    const hb = await lastHeartbeat();
    expect(hb?.outcome).toBe('ok');
    expect(hb?.turns).toBe(2);
    expect(hb?.bytes).toBeGreaterThan(0);
  });

  test('session-id-keyed dedup: resumed session overwrites its corpus file [A6]', async () => {
    const projRoot = join(tmp, 'projects');
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    const t1 = seedTranscript(join(projRoot, 'p1'), 'a.jsonl', [userLine('first pass content')]);
    await runHook(['session-end'], {
      stdin: JSON.stringify({ session_id: 'sess-dup', transcript_path: t1, cwd: ws }),
      transcriptRoot: projRoot,
    });
    const t2 = seedTranscript(join(projRoot, 'p1'), 'a.jsonl', [userLine('first pass content'), assistantLine('resumed pass content')]);
    await runHook(['session-end'], {
      stdin: JSON.stringify({ session_id: 'sess-dup', transcript_path: t2, cwd: ws }),
      transcriptRoot: projRoot,
    });
    const corpusDir = join(home(), 'transcripts', 'corpus');
    const files = readdirSync(corpusDir).filter((f) => f.startsWith('sess-dup'));
    expect(files).toEqual(['sess-dup.txt']);
    expect(readFileSync(join(corpusDir, 'sess-dup.txt'), 'utf8')).toContain('resumed pass content');
  });

  test('retention prune: corpus files past the default 30d window are removed [G15]', async () => {
    const corpusDir = join(home(), 'transcripts', 'corpus');
    mkdirSync(corpusDir, { recursive: true });
    const oldFile = join(corpusDir, 'ancient.txt');
    writeFileSync(oldFile, 'old corpus\n');
    const old = (Date.now() - 40 * 24 * 3600 * 1000) / 1000;
    utimesSync(oldFile, old, old);
    const freshFile = join(corpusDir, 'fresh.txt');
    writeFileSync(freshFile, 'fresh corpus\n');

    const projRoot = join(tmp, 'projects');
    const transcript = seedTranscript(join(projRoot, 'p1'), 's.jsonl', [userLine('hello')]);
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    await runHook(['session-end'], {
      stdin: JSON.stringify({ session_id: 'sess-ret', transcript_path: transcript, cwd: ws }),
      transcriptRoot: projRoot,
    });
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
  });

  test('bytes>0 && turns==0 → parser_drift heartbeat error + status file [G3]', async () => {
    const projRoot = join(tmp, 'projects');
    const transcript = seedTranscript(join(projRoot, 'p1'), 'drift.jsonl', [
      JSON.stringify({ type: 'summary', summary: 'format changed under us' }),
      JSON.stringify({ type: 'summary', summary: 'no user/assistant lines at all' }),
    ]);
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    await runHook(['session-end'], {
      stdin: JSON.stringify({ session_id: 'sess-drift', transcript_path: transcript, cwd: ws }),
      transcriptRoot: projRoot,
    });
    const hb = await lastHeartbeat();
    expect(hb?.outcome).toBe('error');
    expect(hb?.reason).toBe('parser_drift');
    expect(hb?.bytes).toBeGreaterThan(0);
    expect(hb?.turns).toBe(0);
    const status = JSON.parse(readFileSync(await hookStatusPath(), 'utf8'));
    expect(status.error).toBe('parser_drift');
    // No corpus file for a drift session.
    expect(existsSync(join(home(), 'transcripts', 'corpus', 'sess-drift.txt'))).toBe(false);
  });

  test('confinement rejection: degraded heartbeat, no corpus write [S3#8]', async () => {
    const outside = join(tmp, 'outside.jsonl');
    writeFileSync(outside, userLine('outside content') + '\n');
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    await runHook(['session-end'], {
      stdin: JSON.stringify({ session_id: 'sess-out', transcript_path: outside, cwd: ws }),
      transcriptRoot: join(tmp, 'projects'),
    });
    expect((await lastHeartbeat())?.reason).toBe('transcript_outside_projects_dir');
    expect(existsSync(join(home(), 'transcripts', 'corpus', 'sess-out.txt'))).toBe(false);
  });

  test('GCs this session\'s stop buffer [G15]', async () => {
    const liveDir = join(home(), 'transcripts', 'live');
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(join(liveDir, 'sess-gc.txt'), '{"ts":"x"}\n');
    const projRoot = join(tmp, 'projects');
    const transcript = seedTranscript(join(projRoot, 'p1'), 's.jsonl', [userLine('bye')]);
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    await runHook(['session-end'], {
      stdin: JSON.stringify({ session_id: 'sess-gc', transcript_path: transcript, cwd: ws }),
      transcriptRoot: projRoot,
    });
    expect(existsSync(join(liveDir, 'sess-gc.txt'))).toBe(false);
  });
});

// ── heartbeat [S3#7] ────────────────────────────────────────────────────────

describe('heartbeat', () => {
  test('schema allowlist: every key on every line is allowlisted, never text payloads', async () => {
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    await runHook(['session-start'], { stdin: '', cwd: ws, write: () => {} });
    await runHook(['user-prompt'], { stdin: JSON.stringify({ prompt: 'secret prompt text' }), write: () => {} });
    await runHook(['stop'], { stdin: JSON.stringify({ session_id: 's', prompt: 'secret prompt text' }) });
    const raw = readFileSync(await heartbeatPath(), 'utf8');
    const allowed = new Set<string>(HEARTBEAT_ALLOWED_KEYS);
    const lines = raw.split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(3);
    for (const line of lines) {
      for (const key of Object.keys(JSON.parse(line))) {
        expect(allowed.has(key)).toBe(true);
      }
    }
    // The prompt text itself never lands in telemetry.
    expect(raw).not.toContain('secret prompt text');
  });

  test('file capped at HEARTBEAT_MAX_LINES with tail rewrite', async () => {
    const p = await heartbeatPath();
    const seed = JSON.stringify({ ts: 't', event: 'stop', outcome: 'ok', duration_ms: 1 });
    writeFileSync(p, Array.from({ length: HEARTBEAT_MAX_LINES + 100 }, () => seed).join('\n') + '\n');
    await runHook(['stop'], { stdin: JSON.stringify({ session_id: 'cap' }) });
    const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(HEARTBEAT_MAX_LINES);
    // The newest entry survived the cap.
    expect(JSON.parse(lines[lines.length - 1]).event).toBe('stop');
  });

  test('readHeartbeatTail returns the last n entries oldest→newest', async () => {
    const p = await heartbeatPath();
    const mk = (i: number) => JSON.stringify({ ts: `t${i}`, event: 'stop', outcome: 'ok', duration_ms: i });
    writeFileSync(p, [mk(1), mk(2), mk(3), mk(4)].join('\n') + '\n');
    const tail = await readHeartbeatTail(2);
    expect(tail.map((e) => e.duration_ms)).toEqual([3, 4]);
  });
});
