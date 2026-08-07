/**
 * Retrieval Reflex — resolve IPC (issue #1981, D9=C).
 *
 * PGLite is single-connection: `gbrain serve` holds the one connection for its
 * lifetime, so the context engine cannot open its own and must NOT shell out to
 * a subprocess (that would force-steal the lock past the 5-min staleness window
 * and crash the brain — see plan D9 rejected option). Instead, `serve`
 * optionally listens on a local unix-domain socket and answers a NARROW request
 * — candidates in, pointers out — using the connection it already owns. Both
 * ends are gbrain code; raw SQL never crosses the wire (closes the trust hole).
 *
 * Protocol: newline-delimited JSON. One request line, one response line.
 *   req:  { candidates, priorContextText?, maxPointers?, sourceId? }
 *   resp: { ok: true, block: PointerBlock | null } | { ok: false, error }
 *
 * Local-only (unix socket on the brain's data dir, mode 0600) — no network
 * surface.
 */

import net from 'node:net';
import { existsSync, unlinkSync, statSync, chmodSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { EntityCandidate } from './entity-salience.ts';
import type { PointerBlock } from './retrieval-reflex.ts';
import type { VolunteeredPage } from './volunteer.ts';

const SOCK_NAME = '.gbrain-resolve.sock';
const CLIENT_TIMEOUT_MS = 250;
const MAX_MSG_BYTES = 256 * 1024;

/** Marker the client returns when no server is reachable (vs. a real null result). */
export const IPC_UNAVAILABLE = Symbol('ipc-unavailable');

export interface ResolveRequest {
  candidates: EntityCandidate[];
  priorContextText?: string;
  maxPointers?: number;
  sourceId?: string;
  /** v0.43 (#2095, codex D7): suppression mode — 'slug-only' under windowing. */
  suppression?: 'slug-and-title' | 'slug-only';
  /**
   * Volunteer-shaped request (harness hook adapters): when present, a NEW
   * server resolves up to the hard cap internally, applies the pure
   * confidence gate server-side, logs the GATED set at the delivery point
   * under `channel`, and responds with `volunteered`. OLD servers ignore
   * these fields and answer the plain reflex shape — the client re-derives
   * pages with the same pure gate (gate-function parity is test-pinned).
   */
  volunteer?: { maxPages?: number; minConfidence?: number; windowSize?: number };
  /** Event-attribution channel for the volunteer branch (e.g. 'claude-code'). */
  channel?: string;
  /**
   * Hook caller's working directory. The engine-free source tiers (flag/env/
   * dotfile) miss repos registered by path containment — a NEW server runs
   * full resolveSourceId(engine, sourceId ?? null, cwd) so those resolve too.
   */
  cwd?: string;
}

/** Volunteer-shaped response: the reflex block plus the server-gated pages. */
export interface ResolveVolunteerResult {
  block: PointerBlock | null;
  volunteered: VolunteeredPage[];
}

/**
 * Handler result: plain reflex requests return the block (or null); the
 * volunteer branch returns { block, volunteered } so the response can carry
 * the gated pages AND the delivery-point logger can log exactly the gated
 * set (never the pre-gate pool — logging an abandoned or gated-out pointer
 * corrupts the volunteered-vs-used precision stats).
 */
export type ResolveHandlerResult = PointerBlock | null | ResolveVolunteerResult;

export type ResolveHandler = (req: ResolveRequest) => Promise<ResolveHandlerResult>;

/** What the delivery-point logger receives: volunteer result or plain block. */
export type DeliveredResult = ResolveVolunteerResult | { block: PointerBlock; volunteered?: undefined };

/** Narrow a handler/delivered result to the volunteer shape. */
export function isVolunteerResult(r: ResolveHandlerResult | DeliveredResult): r is ResolveVolunteerResult {
  return !!r && typeof r === 'object' && 'volunteered' in r && Array.isArray((r as ResolveVolunteerResult).volunteered);
}

/** Wire response for a resolve/volunteer request. */
export interface ResolveResponse {
  ok: boolean;
  block?: PointerBlock | null;
  volunteered?: VolunteeredPage[];
  error?: string;
}

/** Canonical socket path for a PGLite data dir. */
export function resolveSocketPath(dataDir: string): string {
  return join(dataDir, SOCK_NAME);
}

/**
 * Canonical socket path for a brain identified by config, engine-uniform
 * (harness hook adapters): PGLite brains keep the in-data-dir socket
 * (existing contract, shared with the ambient reflex); Postgres brains get a
 * per-connection socket under `~/.gbrain/run/` (0700 dir) keyed by a short
 * hash of the connection URL, so a one-shot caller can reach a running
 * serve's engine instead of paying a fresh pooler handshake per prompt.
 * Returns null when the config identifies no brain.
 */
export function resolveSocketPathForConfig(cfg: { engine?: string; database_path?: string; database_url?: string } | null | undefined): string | null {
  if (!cfg) return null;
  if (cfg.engine === 'pglite' && cfg.database_path) return resolveSocketPath(cfg.database_path);
  if (cfg.database_url) {
    const h = createHash('sha256').update(cfg.database_url).digest('hex').slice(0, 12);
    return join(homedir(), '.gbrain', 'run', `resolve-${h}.sock`);
  }
  return null;
}

/** Ensure the parent dir of a run-socket exists (0700). Best-effort. */
export function ensureSocketDir(socketPath: string): void {
  try {
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  } catch {
    /* best effort */
  }
}

/** Options for resolveViaIpc / resolveViaIpcRaw. */
export interface ResolveViaIpcOpts {
  /**
   * Socket budget. Default stays 250ms for the ambient reflex (inline in a
   * turn); one-shot hook callers pass a larger slice of their own deadline
   * so a busy-but-alive serve isn't misread as absent.
   */
  timeoutMs?: number;
}

/**
 * Client: ship candidates to a running serve, get pointers back. Returns
 * IPC_UNAVAILABLE when no server is listening (caller falls through the ladder);
 * a real PointerBlock | null otherwise. Never throws — fail-soft to UNAVAILABLE.
 */
export async function resolveViaIpc(
  socketPath: string,
  req: ResolveRequest,
  opts: ResolveViaIpcOpts = {},
): Promise<PointerBlock | null | typeof IPC_UNAVAILABLE> {
  const resp = await resolveViaIpcRaw(socketPath, req, opts);
  // Preserve the original contract exactly: a non-ok response (handler threw)
  // falls through the ladder, same as a transport failure.
  if (resp === IPC_UNAVAILABLE || !resp.ok) return IPC_UNAVAILABLE;
  return resp.block ?? null;
}

/**
 * Raw-response client for volunteer-shaped requests: exposes the full wire
 * response so a hook caller can distinguish a NEW server's `volunteered`
 * field from an OLD server's plain `{ok, block}` (client re-gates the block)
 * and surface typed errors (e.g. unknown_source) instead of folding them
 * into "unavailable". A NON-ok response with an `error` is returned as-is;
 * transport failures still collapse to IPC_UNAVAILABLE.
 */
export async function resolveViaIpcRaw(
  socketPath: string,
  req: ResolveRequest,
  opts: ResolveViaIpcOpts = {},
): Promise<ResolveResponse | typeof IPC_UNAVAILABLE> {
  if (!existsSync(socketPath)) return IPC_UNAVAILABLE;
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : CLIENT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    const finish = (v: ResolveResponse | typeof IPC_UNAVAILABLE) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* noop */ }
      resolve(v);
    };
    const sock = net.createConnection(socketPath);
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => {
      sock.write(JSON.stringify(req) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_MSG_BYTES) return finish(IPC_UNAVAILABLE);
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const resp = JSON.parse(buf.slice(0, nl)) as ResolveResponse;
        if (resp && typeof resp === 'object' && typeof resp.ok === 'boolean') return finish(resp);
        return finish(IPC_UNAVAILABLE);
      } catch {
        return finish(IPC_UNAVAILABLE);
      }
    });
    // Any error (ENOENT, ECONNREFUSED, stale socket), timeout, or close before
    // a response → treat as unavailable, fall through the ladder.
    sock.on('timeout', () => finish(IPC_UNAVAILABLE));
    sock.on('error', () => finish(IPC_UNAVAILABLE));
    sock.on('close', () => finish(IPC_UNAVAILABLE));
  });
}

/**
 * Server: start a resolve listener on `socketPath`. Cleans up a stale socket
 * left by a dead owner first. Returns the net.Server (caller closes on
 * shutdown). Errors are swallowed (best-effort feature) — returns null if the
 * socket can't be bound.
 */
export async function startResolveIpcServer(
  socketPath: string,
  handler: ResolveHandler,
  /**
   * v0.43 (#2095, red-team): fired ONLY after the response was successfully
   * written to the client — the accept-side seam for feedback logging. A
   * block the client never received (timeout, dead socket) was never
   * injected into a prompt and must not count as "volunteered". For
   * volunteer-shaped results the logger receives the GATED result (never the
   * pre-gate pool) plus the request, so it can attribute to req.channel.
   */
  onDelivered?: (result: DeliveredResult, req: ResolveRequest) => void,
): Promise<net.Server | null> {
  // Remove a stale socket file if present (a previous serve that didn't clean up).
  cleanupStaleSocket(socketPath);

  return new Promise((resolve) => {
    const server = net.createServer((conn) => {
      let buf = '';
      conn.setEncoding('utf8');
      conn.on('data', async (chunk: string) => {
        buf += chunk;
        if (buf.length > MAX_MSG_BYTES) { conn.destroy(); return; }
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        let resp: string;
        let delivered: { result: DeliveredResult; req: ResolveRequest } | null = null;
        try {
          const req = JSON.parse(line) as ResolveRequest;
          const result = await handler(req);
          if (isVolunteerResult(result)) {
            resp = JSON.stringify({ ok: true, block: result.block, volunteered: result.volunteered });
            if (result.block || result.volunteered.length) delivered = { result, req };
          } else {
            resp = JSON.stringify({ ok: true, block: result });
            if (result) delivered = { result: { block: result }, req };
          }
        } catch (e) {
          resp = JSON.stringify({ ok: false, error: (e as Error).message });
        }
        try {
          conn.write(resp + '\n');
          // Write accepted — the client (250ms budget) may still have hung
          // up, but this is the closest observable delivery point.
          if (delivered && onDelivered) {
            try { onDelivered(delivered.result, delivered.req); } catch { /* telemetry only */ }
          }
        } catch { /* client gone — do NOT log undelivered pointers */ }
        conn.end();
      });
      conn.on('error', () => { try { conn.destroy(); } catch { /* noop */ } });
    });
    server.on('error', () => resolve(null));
    server.listen(socketPath, () => {
      try { chmodSync(socketPath, 0o600); } catch { /* best effort */ }
      resolve(server);
    });
  });
}

/** Remove a socket file whose owning process is gone (or any leftover file). */
export function cleanupStaleSocket(socketPath: string): void {
  try {
    if (existsSync(socketPath)) {
      // A unix socket shows up as a socket file; unlink unconditionally — if a
      // live server holds it, listen() below would fail and we return null.
      const st = statSync(socketPath);
      if (st.isSocket() || st.isFIFO() || st.isFile()) unlinkSync(socketPath);
    }
  } catch {
    /* best effort */
  }
}
