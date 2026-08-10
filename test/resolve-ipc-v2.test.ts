/**
 * IPC v2 — discriminated-union protocol tests (agent-bootstrap plan:
 * ENG-3 back-compat, S3#6 secret gating, CX2-10 source binding, A9
 * stale-serve detection, G11 request clamping, S3#1 visibility fence).
 *
 * In-process unix-socket servers only (no subprocess spawns); hermetic
 * in-memory PGLite for the assembly happy path.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, beforeEach } from 'bun:test';
import net from 'node:net';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  resolveSocketPath,
  startResolveIpcServer,
  resolveViaIpc,
  requestTurnContext,
  ensureIpcSecret,
  readIpcSecret,
  ipcSecretPath,
  IPC_UNAVAILABLE,
  type TurnContextResponse,
  type TurnContextRequest,
} from '../src/core/context/resolve-ipc.ts';
import type { PointerBlock } from '../src/core/context/retrieval-reflex.ts';
import { assembleTurnContext, TURN_CONTEXT_ENVELOPE, type TurnContextResult } from '../src/core/context/turn-context.ts';
import { __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import type { WindowTurn } from '../src/core/context/entity-salience.ts';

let engine: PGLiteEngine;

const servers: Array<{ close: () => void }> = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) { try { s.close(); } catch { /* noop */ } }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rr-ipc-v2-'));
  dirs.push(d);
  return d;
}

const stubBlock = { text: '', pointers: [], factsCount: 0 };

/** Raw one-line request → parsed one-line response (protocol-shape probes). */
function rawRequest(sock: string, line: string, timeoutMs = 1000): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    const done = (v: unknown) => {
      if (settled) return;
      settled = true;
      try { c.destroy(); } catch { /* noop */ }
      resolve(v);
    };
    const c = net.createConnection(sock);
    c.setTimeout(timeoutMs);
    c.on('connect', () => c.write(line + '\n'));
    c.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        try { done(JSON.parse(buf.slice(0, nl))); } catch { done(null); }
      }
    });
    c.on('timeout', () => done(null));
    c.on('error', () => done(null));
  });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  __resetHotMemoryCacheForTests();
  await engine.executeRaw('DELETE FROM page_aliases').catch(() => {});
  await engine.executeRaw('DELETE FROM facts').catch(() => {});
  await engine.executeRaw('DELETE FROM pages').catch(() => {});
});

async function seedPage(slug: string, title: string, body: string) {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES ($1, 'default', 'person', $2, $3, '')`,
    [slug, title, body],
  );
}

describe('IPC v2 back-compat [ENG-3]', () => {
  test('legacy positional server signature still works (v1 server, v1 client)', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const block: PointerBlock = {
      pointers: [{ display: 'Alice', slug: 'people/alice', source_id: 'default', synopsis: 'x', arm: 'alias', confidence: 0.9 }],
      text: 'BLOCK',
    };
    const server = await startResolveIpcServer(sock, async (req) => {
      expect(req.candidates[0].query).toBe('Alice');
      return block;
    });
    expect(server).not.toBeNull();
    servers.push(server!);
    const got = await resolveViaIpc(sock, { candidates: [{ display: 'Alice', query: 'Alice' }] });
    expect(got).not.toBe(IPC_UNAVAILABLE);
    expect((got as PointerBlock).text).toBe('BLOCK');
  });

  test('v1 client (no kind) against v2 handler-map server routes to resolve', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    let resolveCalls = 0;
    const server = await startResolveIpcServer(
      sock,
      {
        resolve: async () => { resolveCalls += 1; return null; },
        turn_context: async () => stubBlock,
      },
      { secret: ensureIpcSecret(dir), boundSourceId: 'default' },
    );
    servers.push(server!);
    const got = await resolveViaIpc(sock, { candidates: [{ display: 'A', query: 'A' }] });
    expect(got).toBeNull(); // resolved, nothing found — NOT unavailable
    expect(resolveCalls).toBe(1);
  });

  test('unknown kind → ok:false unknown_kind', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const server = await startResolveIpcServer(sock, { resolve: async () => null });
    servers.push(server!);
    const resp = await rawRequest(sock, JSON.stringify({ kind: 'bogus' })) as { ok: boolean; error?: string };
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain('unknown_kind');
  });
});

describe('turn_context over a real socket', () => {
  test('happy path: pointers + world facts assembled; private facts NEVER cross [S3#1]', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const secret = ensureIpcSecret(dir);

    await seedPage('people/alice-example', 'Alice Example', 'Alice Example is a founder at acme-example.');
    await engine.insertFact(
      { fact: 'WORLD-FACT alice-example prefers async updates', kind: 'fact', entity_slug: 'people/alice-example', source: 'test', visibility: 'world' },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'PRIVATE-FACT secret diligence detail', kind: 'fact', entity_slug: 'people/alice-example', source: 'test', visibility: 'private' },
      { source_id: 'default' },
    );

    const server = await startResolveIpcServer(
      sock,
      {
        resolve: async () => null,
        turn_context: (req) =>
          assembleTurnContext(engine, {
            sourceId: 'default',
            window: req.window ?? [],
            priorContextText: req.priorContextText,
            sessionId: req.sessionId,
            maxBytes: req.maxBytes,
          }),
      },
      { secret, boundSourceId: 'default' },
    );
    expect(server).not.toBeNull();
    servers.push(server!);

    const resp = await requestTurnContext(sock, {
      secret,
      window: [{ role: 'user', text: 'met Alice Example today about the round' }],
    });
    expect(resp).not.toBe(IPC_UNAVAILABLE);
    const r = resp as TurnContextResponse;
    expect(r.ok).toBe(true);
    expect(r.protocol).toBe(2);
    expect(r.block).not.toBeNull();
    expect(r.block!.text.startsWith(TURN_CONTEXT_ENVELOPE)).toBe(true);
    expect(r.block!.text).toContain('people/alice-example');
    expect(r.block!.text).toContain('WORLD-FACT');
    // The load-bearing S3#1 assertion: a private fact never crosses the IPC boundary.
    expect(r.block!.text).not.toContain('PRIVATE-FACT');
    expect(r.block!.text).not.toContain('secret diligence detail');
    expect(r.block!.factsCount).toBe(1);
  });

  test('secret mismatch rejected as unauthorized [S3#6]', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const secret = ensureIpcSecret(dir);
    const server = await startResolveIpcServer(
      sock,
      { resolve: async () => null, turn_context: async () => stubBlock },
      { secret, boundSourceId: 'default' },
    );
    servers.push(server!);
    const resp = await requestTurnContext(sock, { secret: 'wrong-secret', window: [] });
    const r = resp as TurnContextResponse;
    expect(r.ok).toBe(false);
    expect(r.protocol).toBe(2);
    expect(r.error).toBe('unauthorized');
  });

  test('no secret configured → fail closed unauthorized (never open service)', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const server = await startResolveIpcServer(
      sock,
      { resolve: async () => null, turn_context: async () => stubBlock },
      { boundSourceId: 'default' }, // secret missing
    );
    servers.push(server!);
    const resp = await requestTurnContext(sock, { secret: 'anything', window: [] });
    expect((resp as TurnContextResponse).ok).toBe(false);
    expect((resp as TurnContextResponse).error).toBe('unauthorized');
  });

  test('cross-source request rejected [CX2-10]', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const secret = ensureIpcSecret(dir);
    const server = await startResolveIpcServer(
      sock,
      { resolve: async () => null, turn_context: async () => stubBlock },
      { secret, boundSourceId: 'default' },
    );
    servers.push(server!);
    const resp = await requestTurnContext(sock, { secret, window: [], sourceId: 'other-team-brain' });
    const r = resp as TurnContextResponse;
    expect(r.ok).toBe(false);
    expect(r.error).toBe('source_mismatch');
    // Matching source claim passes.
    const okResp = await requestTurnContext(sock, { secret, window: [], sourceId: 'default' });
    expect((okResp as TurnContextResponse).ok).toBe(true);
  });

  test('server without a turn_context handler → unsupported_kind (with protocol echo)', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const server = await startResolveIpcServer(sock, { resolve: async () => null });
    servers.push(server!);
    const resp = await requestTurnContext(sock, { secret: 'x', window: [] });
    const r = resp as TurnContextResponse;
    expect(r.ok).toBe(false);
    expect(r.protocol).toBe(2); // echo present — this is a v2 server, not a stale serve
    expect(r.error).toBe('unsupported_kind');
  });

  test('request protocol !== 2 → unsupported_protocol', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const secret = ensureIpcSecret(dir);
    const server = await startResolveIpcServer(
      sock,
      { resolve: async () => null, turn_context: async () => stubBlock },
      { secret, boundSourceId: 'default' },
    );
    servers.push(server!);
    const req: Omit<TurnContextRequest, 'protocol'> & { protocol: number } = {
      kind: 'turn_context', protocol: 1, secret, window: [],
    };
    const resp = await rawRequest(sock, JSON.stringify(req)) as { ok: boolean; error?: string };
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('unsupported_protocol');
  });
});

describe('stale-serve detection [A9]', () => {
  test('response without protocol echo → typed { degraded: stale_serve }', async () => {
    const dir = tmpDir();
    const sock = join(dir, '.gbrain-resolve.sock');
    // Simulate a v1 server: answers EVERY request in the v1 resolve shape.
    const v1 = net.createServer((conn) => {
      conn.on('data', () => {
        conn.write(JSON.stringify({ ok: true, block: null }) + '\n');
        conn.end();
      });
    });
    await new Promise<void>((r) => v1.listen(sock, () => r()));
    servers.push(v1);
    const resp = await requestTurnContext(sock, { secret: 'irrelevant', window: [] });
    expect(resp).toEqual({ degraded: 'stale_serve' });
  });

  test('absent socket → IPC_UNAVAILABLE (fail-soft, mirrors resolve client)', async () => {
    const dir = tmpDir();
    const resp = await requestTurnContext(resolveSocketPath(dir), { secret: 'x', window: [] });
    expect(resp).toBe(IPC_UNAVAILABLE);
  });
});

describe('request clamping [G11]', () => {
  test('oversized window is trimmed oldest-first below the 256KB cap', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const secret = ensureIpcSecret(dir);
    let received: WindowTurn[] = [];
    const server = await startResolveIpcServer(
      sock,
      {
        resolve: async () => null,
        turn_context: async (req) => { received = req.window; return stubBlock; },
      },
      { secret, boundSourceId: 'default' },
    );
    servers.push(server!);

    const turns: WindowTurn[] = [];
    for (let i = 0; i < 600; i++) {
      turns.push({ role: 'user', text: `turn-${i} ${'x'.repeat(1000)}` });
    }
    const resp = await requestTurnContext(sock, { secret, window: turns }, { timeoutMs: 5000 });
    const r = resp as TurnContextResponse;
    expect(r.ok).toBe(true);
    expect(received.length).toBeGreaterThan(0);
    expect(received.length).toBeLessThan(600);
    // Oldest-first trim: the NEWEST turn always survives.
    expect(received[received.length - 1].text.startsWith('turn-599 ')).toBe(true);
    expect(received[0].text.startsWith('turn-0 ')).toBe(false);
  });
});

describe('socket + secret hardening [S3#6]', () => {
  test('socket is 0600, secret file 0600, parent dir 0700', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const secret = ensureIpcSecret(dir);
    expect(secret).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes as hex
    const server = await startResolveIpcServer(
      sock,
      { resolve: async () => null, turn_context: async () => stubBlock },
      { secret, boundSourceId: 'default' },
    );
    servers.push(server!);
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect(statSync(ipcSecretPath(dir)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test('ensureIpcSecret is stable across calls; readIpcSecret round-trips', async () => {
    const dir = tmpDir();
    const s1 = ensureIpcSecret(dir);
    const s2 = ensureIpcSecret(dir);
    expect(s2).toBe(s1);
    expect(readIpcSecret(dir)).toBe(s1);
    expect(existsSync(ipcSecretPath(dir))).toBe(true);
  });

  test('readIpcSecret → null when no server has created it', () => {
    const dir = tmpDir();
    expect(readIpcSecret(dir)).toBeNull();
  });
});

describe('server self-budget [G11]', () => {
  test('handler slower than the 400ms budget degrades to server_budget', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const secret = ensureIpcSecret(dir);
    const server = await startResolveIpcServer(
      sock,
      {
        resolve: async () => null,
        turn_context: () => new Promise<TurnContextResult>((r) => setTimeout(() => r(stubBlock), 2000)),
      },
      { secret, boundSourceId: 'default' },
    );
    servers.push(server!);
    // Wide client timeout on purpose: the SERVER's own 400ms budget is what's
    // under test, and a tight client timeout flakes under CI load (the client
    // giving up would return IPC_UNAVAILABLE, not the degraded response).
    const resp = await requestTurnContext(sock, { secret, window: [] }, { timeoutMs: 10000 });
    const r = resp as TurnContextResponse;
    expect(r.ok).toBe(true);
    expect(r.protocol).toBe(2);
    expect(r.block).toBeNull();
    expect(r.degradedReason).toBe('server_budget');
  });
});

describe('resolve kind honors boundSourceId [CX2-10]', () => {
  test('bound server rejects a cross-source resolve request; handler never runs', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    let resolveCalls = 0;
    const server = await startResolveIpcServer(
      sock,
      { resolve: async () => { resolveCalls += 1; return null; } },
      { boundSourceId: 'default' },
    );
    servers.push(server!);
    const resp = await rawRequest(
      sock,
      JSON.stringify({ candidates: [{ display: 'A', query: 'A' }], sourceId: 'other-team-brain' }),
    ) as { ok: boolean; error?: string };
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('source_mismatch');
    expect(resolveCalls).toBe(0);
  });

  test('bound server accepts the matching source claim and absent sourceId', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    let resolveCalls = 0;
    const server = await startResolveIpcServer(
      sock,
      { resolve: async () => { resolveCalls += 1; return null; } },
      { boundSourceId: 'default' },
    );
    servers.push(server!);
    const matching = await resolveViaIpc(sock, {
      candidates: [{ display: 'A', query: 'A' }],
      sourceId: 'default',
    });
    expect(matching).toBeNull(); // resolved (nothing found), NOT rejected
    const absent = await resolveViaIpc(sock, { candidates: [{ display: 'A', query: 'A' }] });
    expect(absent).toBeNull();
    expect(resolveCalls).toBe(2);
  });

  test('unbound legacy server passes a caller sourceId through unchanged', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    let seenSourceId: string | undefined;
    const server = await startResolveIpcServer(sock, async (req) => {
      seenSourceId = req.sourceId;
      return null;
    });
    servers.push(server!);
    const got = await resolveViaIpc(sock, {
      candidates: [{ display: 'A', query: 'A' }],
      sourceId: 'any-source-at-all',
    });
    expect(got).toBeNull(); // served, not rejected — legacy behavior intact
    expect(seenSourceId).toBe('any-source-at-all');
  });
});
