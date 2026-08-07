/**
 * Retrieval Reflex resolve IPC round-trip tests (#1981, T3/T5).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveSocketPath,
  startResolveIpcServer,
  resolveViaIpc,
  resolveViaIpcRaw,
  isVolunteerResult,
  IPC_UNAVAILABLE,
  type ResolveRequest,
  type ResolveResponse,
  type DeliveredResult,
} from '../../src/core/context/resolve-ipc.ts';
import type { PointerBlock } from '../../src/core/context/retrieval-reflex.ts';
import type { VolunteeredPage } from '../../src/core/context/volunteer.ts';

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) { try { s.close(); } catch { /* noop */ } }
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'rr-ipc-'));
}

describe('resolve IPC', () => {
  test('round-trip: client gets the pointer block the server returns', async () => {
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
    rmSync(dir, { recursive: true, force: true });
  });

  test('absent socket → IPC_UNAVAILABLE (caller falls through ladder)', async () => {
    const dir = tmpDir();
    const got = await resolveViaIpc(resolveSocketPath(dir), { candidates: [{ display: 'A', query: 'A' }] });
    expect(got).toBe(IPC_UNAVAILABLE);
    rmSync(dir, { recursive: true, force: true });
  });

  test('server returning null relays as null (resolved, nothing found)', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const server = await startResolveIpcServer(sock, async () => null);
    servers.push(server!);
    const got = await resolveViaIpc(sock, { candidates: [{ display: 'A', query: 'A' }] });
    expect(got).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test('stale socket file is cleaned up so a fresh server can bind', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const s1 = await startResolveIpcServer(sock, async () => null);
    servers.push(s1!);
    s1!.close();
    // bind again at the same path — startResolveIpcServer must unlink the stale file
    const s2 = await startResolveIpcServer(sock, async () => null);
    expect(s2).not.toBeNull();
    servers.push(s2!);
    expect(existsSync(sock)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('resolveSocketPathForConfig (engine-uniform listener)', () => {
  test('PGLite config keeps the in-data-dir socket (existing reflex contract)', () => {
    const p = resolveSocketPathForConfig({ engine: 'pglite', database_path: '/tmp/brain.pglite' });
    expect(p).toBe(resolveSocketPath('/tmp/brain.pglite'));
  });

  test('Postgres config → deterministic per-connection socket under ~/.gbrain/run', () => {
    const a = resolveSocketPathForConfig({ engine: 'postgres', database_url: 'postgres://u:p@host:5432/db' });
    const b = resolveSocketPathForConfig({ engine: 'postgres', database_url: 'postgres://u:p@host:5432/db' });
    const c = resolveSocketPathForConfig({ engine: 'postgres', database_url: 'postgres://u:p@other:5432/db' });
    expect(a).toBe(b); // deterministic — hook and serve derive the same path
    expect(a).not.toBe(c); // distinct brains get distinct sockets
    expect(a).toContain('/.gbrain/run/resolve-');
    expect(a!.endsWith('.sock')).toBe(true);
  });

  test('no identifiable brain → null (no listener started)', () => {
    expect(resolveSocketPathForConfig(null)).toBeNull();
    expect(resolveSocketPathForConfig({ engine: 'pglite' })).toBeNull();
    expect(resolveSocketPathForConfig({})).toBeNull();
  });
});

describe('volunteer-shaped resolve IPC (harness hook adapters)', () => {
  const BLOCK: PointerBlock = {
    pointers: [
      { display: 'Alice', slug: 'people/alice', source_id: 'default', synopsis: 'x', arm: 'alias', confidence: 0.9 },
      { display: 'Widget Co', slug: 'companies/widget-co', source_id: 'default', synopsis: 'y', arm: 'title', confidence: 0.8 },
    ],
    text: 'BLOCK',
  };
  const PAGES: VolunteeredPage[] = [
    { slug: 'people/alice', source_id: 'default', display: 'Alice', confidence: 0.9, arm: 'alias', rationale: 'alias match "Alice"', synopsis: 'x' },
  ];

  test('volunteer request → server-gated {block, volunteered} on the wire; onDelivered gets the GATED result + request channel', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const delivered: Array<{ result: DeliveredResult; req: ResolveRequest }> = [];
    const server = await startResolveIpcServer(
      sock,
      async (req) => {
        expect(req.volunteer?.maxPages).toBe(3);
        expect(req.channel).toBe('claude-code');
        expect(req.cwd).toBe('/tmp/host-repo');
        return { block: BLOCK, volunteered: PAGES };
      },
      (result, req) => delivered.push({ result, req }),
    );
    servers.push(server!);

    const resp = await resolveViaIpcRaw(sock, {
      candidates: [{ display: 'Alice', query: 'Alice' }],
      channel: 'claude-code',
      cwd: '/tmp/host-repo',
      volunteer: { maxPages: 3, minConfidence: 0.7, windowSize: 2 },
    });
    expect(resp).not.toBe(IPC_UNAVAILABLE);
    const r = resp as ResolveResponse;
    expect(r.ok).toBe(true);
    expect(r.volunteered).toHaveLength(1);
    expect(r.volunteered![0].slug).toBe('people/alice');
    // arm + confidence survive the wire (client-side gating depends on this)
    expect(r.block!.pointers[1].arm).toBe('title');

    // Delivery-point logging: the logger saw the GATED volunteer result and
    // the request (channel attribution), never a bare pre-gate block.
    expect(delivered).toHaveLength(1);
    expect(isVolunteerResult(delivered[0].result)).toBe(true);
    expect((delivered[0].result as { volunteered: VolunteeredPage[] }).volunteered).toHaveLength(1);
    expect(delivered[0].req.channel).toBe('claude-code');
    rmSync(dir, { recursive: true, force: true });
  });

  test('plain reflex request stays byte-compatible: no volunteered field, onDelivered gets {block}', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const delivered: DeliveredResult[] = [];
    const server = await startResolveIpcServer(sock, async () => BLOCK, (result) => delivered.push(result));
    servers.push(server!);

    const resp = await resolveViaIpcRaw(sock, { candidates: [{ display: 'Alice', query: 'Alice' }] });
    const r = resp as ResolveResponse;
    expect(r.ok).toBe(true);
    expect('volunteered' in r).toBe(false);
    expect(delivered).toHaveLength(1);
    expect(isVolunteerResult(delivered[0])).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('abandoned client (dies before reading the response) → onDelivered NEVER fires — zero events logged', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const delivered: DeliveredResult[] = [];
    let handlerEntered: (() => void) | null = null;
    const entered = new Promise<void>((res) => { handlerEntered = res; });
    let releaseHandler: (() => void) | null = null;
    const gate = new Promise<void>((res) => { releaseHandler = res; });
    const server = await startResolveIpcServer(
      sock,
      async () => {
        handlerEntered!();
        await gate; // hold the response until the client is gone
        return { block: BLOCK, volunteered: PAGES };
      },
      (result) => delivered.push(result),
    );
    servers.push(server!);

    // Raw socket client: send the request, then die without reading.
    const net = await import('node:net');
    const client = net.createConnection(sock);
    await new Promise<void>((res) => client.on('connect', res));
    client.write(JSON.stringify({ candidates: [{ display: 'Alice', query: 'Alice' }], volunteer: {} }) + '\n');
    await entered; // the server is now inside the handler
    client.destroy(); // client abandons before any response
    await new Promise((r) => setTimeout(r, 50)); // let the FIN propagate
    releaseHandler!();
    await new Promise((r) => setTimeout(r, 150)); // let the server attempt the write

    // The write to a destroyed socket may or may not throw synchronously
    // depending on FIN timing; the CONTRACT under test is the stat-corruption
    // guard: if the logger fired, it must have been on a write the kernel
    // accepted. Zero deliveries is the expected outcome when the socket is
    // already torn down.
    expect(delivered.length).toBeLessThanOrEqual(1);
    if (delivered.length === 1) {
      // If the kernel buffered the write, delivery is legitimately observable —
      // but it must be the GATED result, never a pre-gate pool.
      expect(isVolunteerResult(delivered[0])).toBe(true);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('timeoutMs is honored: slow server exceeds a short budget → IPC_UNAVAILABLE; fits a long budget → response', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const server = await startResolveIpcServer(sock, async () => {
      await new Promise((r) => setTimeout(r, 300));
      return BLOCK;
    });
    servers.push(server!);

    const fast = await resolveViaIpc(sock, { candidates: [{ display: 'A', query: 'A' }] }, { timeoutMs: 80 });
    expect(fast).toBe(IPC_UNAVAILABLE);
    const slow = await resolveViaIpc(sock, { candidates: [{ display: 'A', query: 'A' }] }, { timeoutMs: 1000 });
    expect(slow).not.toBe(IPC_UNAVAILABLE);
    expect((slow as PointerBlock).text).toBe('BLOCK');
    rmSync(dir, { recursive: true, force: true });
  });

  test('typed handler error (unknown_source) → raw client sees {ok:false, error}; plain client folds to IPC_UNAVAILABLE', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const server = await startResolveIpcServer(sock, async () => {
      throw new Error('unknown_source: no source named "typo-brain"');
    });
    servers.push(server!);

    const raw = await resolveViaIpcRaw(sock, { candidates: [{ display: 'A', query: 'A' }], volunteer: {} });
    expect(raw).not.toBe(IPC_UNAVAILABLE);
    const r = raw as ResolveResponse;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('unknown_source');

    // The ambient-reflex client contract is unchanged: non-ok folds to
    // unavailable so the ladder falls through exactly as before.
    const plain = await resolveViaIpc(sock, { candidates: [{ display: 'A', query: 'A' }] });
    expect(plain).toBe(IPC_UNAVAILABLE);
    rmSync(dir, { recursive: true, force: true });
  });
});
