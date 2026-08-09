/**
 * hook.ts — `gbrain hook <event>`: the harness-side hook command
 * (agent-bootstrap plan: D5, A3, A9, G3, G4, G15, B3, B4, ENG-1, S3#2,
 * S3#7, S3#8).
 *
 * ENGINE-FREE BY CONSTRUCTION (plan D5): `gbrain serve` holds the PGLite
 * single-writer lock for its lifetime, so this command NEVER imports an
 * engine or connectEngine — config comes from `loadConfig()` only, per-turn
 * context comes from serve's resolve-IPC unix socket (requestTurnContext),
 * and everything else is plain file reads/writes. Registered in cli.ts's
 * no-engine dispatch branch (CLI_ONLY + handleCliOnly, before the
 * connectEngine terminator) and must never enter THIN_CLIENT_REFUSED
 * [ENG-2].
 *
 * FAIL-OPEN CONTRACT: a hook failure must never break the user's session.
 * Every event exits 0 (empty stdout on failure) and records a heartbeat
 * line; only a CLI usage error (unknown event) exits non-zero. The
 * `GBRAIN_HOOKS=0` env kill switch short-circuits every event.
 *
 * HEARTBEAT [S3#7, B3]: append-JSONL at
 * `<gbrain home>/integrations/hooks/heartbeat.jsonl` — counters, durations,
 * and error CODES only, never prompt/fact/slug text. Dir 0700, file capped
 * at HEARTBEAT_MAX_LINES (tail-rewrite). `readHeartbeatTail` is the
 * doctor/status read surface.
 *
 * Events:
 *   session-start  digest to stdout from FILE reads only (≤1.5s) [A3,G4,B3,B4]
 *   user-prompt    stdin hook JSON → IPC turn_context → additionalContext
 *                  JSON on stdout (≤800ms, ≤10000 chars) [ENG-1,S3#8,A9]
 *   stop           append to the per-session live buffer + 7-day GC [G15]
 *   session-end    transcript → secret-scanned corpus file, retention prune,
 *                  parser-drift detection, best-effort workspace push
 *                  [S3#2,G3,G15]
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, type GBrainConfig } from '../core/config.ts';
import {
  IPC_UNAVAILABLE,
  readIpcSecret,
  requestTurnContext,
  resolveSocketPath,
  type TurnContextResponse,
} from '../core/context/resolve-ipc.ts';
import type { WindowTurn } from '../core/context/entity-salience.ts';
import {
  confineTranscriptPath,
  parseTranscript,
  toCorpusText,
} from '../core/transcripts/claude-code-jsonl.ts';
import { CLAUDE_HOOK_OUTPUT_CAP_CHARS } from '../core/bootstrap/host-specs.ts';
import { readManifest } from '../core/bootstrap/format.ts';

// ── Tunables ────────────────────────────────────────────────────────────────

/** session-start self-deadline (plan D5). */
export const SESSION_START_DEADLINE_MS = 1500;
/** user-prompt hard self-deadline (plan D5/ENG-1). */
export const USER_PROMPT_DEADLINE_MS = 800;
/** MEMORY.md digest budget [A3]. */
export const DIGEST_MEMORY_CAP_BYTES = 3072;
/** Digest-eligible MEMORY.md sections [A3] — matched case-insensitively. */
export const DIGEST_SECTIONS = ['standing rules', 'open commitments', 'active context'];
/** Stop-buffer retention [G15]. */
export const STOP_BUFFER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Default corpus retention when `dream.synthesize.corpus_retention_days` is unset [G15]. */
export const CORPUS_RETENTION_DAYS_DEFAULT = 30;
/** Heartbeat file line cap [S3#7]. */
export const HEARTBEAT_MAX_LINES = 5000;
/** Trailing-window size for the B3 failure-rate notice. */
export const HEARTBEAT_FAILURE_WINDOW = 20;
/** user-prompt window: transcript turns fed to turn_context (plan D5: last 4). */
const USER_PROMPT_WINDOW_TURNS = 4;
/** user-prompt transcript parse budget (tail bytes — the window only needs the newest turns). */
const USER_PROMPT_TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;

// ── Test seam ───────────────────────────────────────────────────────────────

/**
 * In-process I/O seam. The CLI wiring calls `runHook(args)` with none of
 * these set; tests inject stdin/stdout/cwd (and a transcript confinement
 * root) so the full stdin→stdout contract runs without subprocesses.
 * `transcriptRoot` is intentionally NOT env-configurable — the S3#8
 * confinement root must not be widenable by whatever spawned the hook.
 */
export interface HookIo {
  /** Injected stdin body; undefined → read process.stdin (non-TTY only). */
  stdin?: string;
  /** Injected stdout sink; default process.stdout.write. */
  write?: (s: string) => void;
  /** Workspace dir override; default stdin JSON `cwd` → process.cwd(). */
  cwd?: string;
  /** TEST SEAM: transcript confinement root (default ~/.claude/projects). */
  transcriptRoot?: string;
}

// ── Entry point ─────────────────────────────────────────────────────────────

const USAGE = `Usage: gbrain hook <event>

Events (wired into .claude/settings.local.json by gbrain bootstrap):
  session-start   print the greeting digest (MEMORY.md sections, last session,
                  push status, hook health) to stdout
  user-prompt     read hook JSON on stdin, request per-turn context from a
                  running 'gbrain serve' over IPC, print additionalContext JSON
  stop            append to the per-session live buffer
  session-end     ingest the session transcript into the dream corpus
                  (secret-scanned), prune old corpus files, push the workspace

Env: GBRAIN_HOOKS=0 disables all events (immediate exit 0).
All events fail open: errors exit 0 with empty stdout and a heartbeat entry at
<gbrain home>/integrations/hooks/heartbeat.jsonl.`;

/** Dispatch a hook event. Returns the process exit code (0 for every runtime path). */
export async function runHook(args: string[], io: HookIo = {}): Promise<number> {
  const event = args[0];
  if (event === '--help' || event === '-h' || event === 'help') {
    write(io, USAGE + '\n');
    return 0;
  }
  if (!event || !['session-start', 'user-prompt', 'stop', 'session-end'].includes(event)) {
    process.stderr.write(USAGE + '\n');
    return 1;
  }
  // Kill switch — before any file/socket touch, no heartbeat (the user asked
  // for silence, and a disabled hook writing telemetry would be a lie).
  if (process.env.GBRAIN_HOOKS === '0') return 0;

  switch (event) {
    case 'session-start':
      return hookSessionStart(io);
    case 'user-prompt':
      return hookUserPrompt(io);
    case 'stop':
      return hookStop(io);
    case 'session-end':
      return hookSessionEnd(io);
    default:
      return 1; // unreachable
  }
}

// ── Shared plumbing ─────────────────────────────────────────────────────────

function write(io: HookIo, s: string): void {
  if (io.write) io.write(s);
  else process.stdout.write(s);
}

const DEADLINE: unique symbol = Symbol('deadline');

function withDeadline<T>(ms: number, work: Promise<T>): Promise<T | typeof DEADLINE> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(DEADLINE), ms);
    (t as { unref?: () => void }).unref?.();
    work.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(DEADLINE); // caller treats a rejection like a timeout: fail-open
      },
    );
  });
}

/** Read stdin (or the injected seam) and JSON-parse; null on anything else. */
async function readStdinJson(io: HookIo, timeoutMs: number): Promise<Record<string, unknown> | null> {
  let raw: string;
  if (io.stdin !== undefined) {
    raw = io.stdin;
  } else {
    raw = await readProcessStdin(timeoutMs);
  }
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readProcessStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(buf);
    };
    const t = setTimeout(finish, timeoutMs);
    (t as { unref?: () => void }).unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => {
      buf += c;
      if (buf.length > 4 * 1024 * 1024) finish(); // hook payloads are small — cap defensively
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/**
 * Gbrain home resolver: prefer the S3#10 choke point (lazy import so a
 * partially-built tree still fail-opens); fall back to configDir semantics
 * (GBRAIN_HOME is a PARENT dir, `.gbrain` appended) [CX2-8].
 */
async function resolveHome(): Promise<string> {
  try {
    const mod = await import('../core/gbrain-home.ts');
    return mod.ensureGbrainHome();
  } catch {
    const override = process.env.GBRAIN_HOME?.trim();
    const home = override && isAbsolute(override) ? join(override, '.gbrain') : join(homedir(), '.gbrain');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    return home;
  }
}

function ensureDir0700(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  return dir;
}

function sanitizeSessionId(id: unknown): string {
  const s = typeof id === 'string' ? id.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120) : '';
  return s && !/^\.+$/.test(s) ? s : 'unknown';
}

/** Reason strings must be CODES [S3#7] — clamp anything message-shaped. */
function reasonCode(reason: string): string {
  return /^[A-Za-z0-9_.:-]{1,48}$/.test(reason) ? reason : 'server_error';
}

function errorCode(e: unknown): string {
  const name = e instanceof Error ? e.constructor.name : typeof e;
  return reasonCode(`exception:${name}`);
}

// ── Heartbeat [S3#7, B3] ────────────────────────────────────────────────────

export interface HookHeartbeatEntry {
  ts: string;
  event: string;
  outcome: 'ok' | 'degraded' | 'error';
  reason?: string;
  duration_ms: number;
  turns?: number;
  bytes?: number;
}

/** The FULL key allowlist — CI greps the fixture against this [S3#7]. */
export const HEARTBEAT_ALLOWED_KEYS = [
  'ts', 'event', 'outcome', 'reason', 'duration_ms', 'turns', 'bytes',
] as const;

async function hooksTelemetryDir(): Promise<string> {
  const home = await resolveHome();
  ensureDir0700(join(home, 'integrations'));
  return ensureDir0700(join(home, 'integrations', 'hooks'));
}

/** Heartbeat JSONL path (exported for doctor/status/tests). */
export async function heartbeatPath(): Promise<string> {
  return join(await hooksTelemetryDir(), 'heartbeat.jsonl');
}

/** Status file the session-end parser-drift check writes [G3]. */
export async function hookStatusPath(): Promise<string> {
  return join(await hooksTelemetryDir(), 'status.json');
}

/**
 * Append a heartbeat entry, capping the file at HEARTBEAT_MAX_LINES (tail
 * rewrite, atomic). Fields are copied EXPLICITLY — the schema allowlist is
 * enforced by construction, not by trust. Never throws.
 */
async function writeHeartbeat(entry: HookHeartbeatEntry): Promise<void> {
  try {
    const p = await heartbeatPath();
    const line = JSON.stringify({
      ts: entry.ts,
      event: entry.event,
      outcome: entry.outcome,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      duration_ms: entry.duration_ms,
      ...(entry.turns !== undefined ? { turns: entry.turns } : {}),
      ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
    });
    let existing = '';
    try {
      existing = readFileSync(p, 'utf8');
    } catch {
      /* first write */
    }
    const lines = existing.split('\n').filter((l) => l.trim().length > 0);
    lines.push(line);
    const kept = lines.length > HEARTBEAT_MAX_LINES ? lines.slice(-HEARTBEAT_MAX_LINES) : lines;
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, kept.join('\n') + '\n', { mode: 0o600 });
    renameSync(tmp, p);
  } catch {
    /* telemetry never breaks a hook */
  }
}

/** Last `n` heartbeat entries (oldest → newest). Doctor/status read surface. */
export async function readHeartbeatTail(n: number): Promise<HookHeartbeatEntry[]> {
  try {
    const p = await heartbeatPath();
    const raw = readFileSync(p, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const out: HookHeartbeatEntry[] = [];
    for (const line of lines.slice(-Math.max(0, n))) {
      try {
        out.push(JSON.parse(line) as HookHeartbeatEntry);
      } catch {
        /* torn line — skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ── session-start [A3, G4, B3, B4] ──────────────────────────────────────────

async function hookSessionStart(io: HookIo): Promise<number> {
  const t0 = Date.now();
  let outcome: HookHeartbeatEntry['outcome'] = 'ok';
  let reason: string | undefined;
  const out: string[] = [];

  try {
    const j = await readStdinJson(io, 250);
    const ws = io.cwd ?? (typeof j?.cwd === 'string' ? (j.cwd as string) : process.cwd());

    const work = (async () => {
      // 1. MEMORY.md digest — allowlisted sections only, ≤3KB [A3].
      const digest = memoryDigest(join(ws, 'MEMORY.md'));
      if (digest) out.push(digest);

      // 2. Last-session line from the stop-buffer dir [G15 consumer].
      const last = await lastSessionLine();
      if (last) out.push(last);

      // 3. Push staleness [B4].
      const pushNote = await pushStatusNote();
      if (pushNote) out.push(pushNote);

      // 4. Visible degradation [B3] + parser-drift status file [G3].
      const failNote = await hookFailureNotice();
      if (failNote) out.push(failNote);
      const statusNote = await statusFileNotice();
      if (statusNote) out.push(statusNote);

      // 5. Dirty-tree recovery push [G4] — bootstrap workspaces ONLY (the
      //    initialized agent.json manifest is the gate; `gbrain hook
      //    session-start` run in an arbitrary repo must never commit it).
      const dirty = await dirtyTreePush(ws);
      if (dirty) {
        if (dirty.note) out.push(dirty.note);
        if (dirty.degradedReason && outcome === 'ok') {
          outcome = 'degraded';
          reason = dirty.degradedReason;
        }
      }
    })();

    const res = await withDeadline(SESSION_START_DEADLINE_MS, work);
    if (res === DEADLINE && outcome === 'ok') {
      outcome = 'degraded';
      reason = 'deadline';
    }
    // Print whatever accumulated before the deadline — a partial digest
    // beats an empty one (the deadline bounds latency, not usefulness).
    const text = out.filter(Boolean).join('\n\n');
    if (text) write(io, text + '\n');
  } catch (e) {
    outcome = 'error';
    reason = errorCode(e); // fail-open: empty stdout, exit 0
  }
  await writeHeartbeat({
    ts: new Date().toISOString(),
    event: 'session-start',
    outcome,
    ...(reason ? { reason } : {}),
    duration_ms: Date.now() - t0,
  });
  return 0;
}

/**
 * Extract the digest-eligible sections from MEMORY.md [A3]. Only headings in
 * DIGEST_SECTIONS qualify — the template's security-boundary note and every
 * other section stay out of injected context. Capped at
 * DIGEST_MEMORY_CAP_BYTES.
 */
export function memoryDigest(memoryPath: string): string | null {
  let raw: string;
  try {
    const st = statSync(memoryPath);
    if (!st.isFile() || st.size > 512 * 1024) return null; // malformed/huge — skip
    raw = readFileSync(memoryPath, 'utf8');
  } catch {
    return null;
  }
  const picked: string[] = [];
  let inSection = false;
  for (const line of raw.split('\n')) {
    const h = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (h) {
      inSection = DIGEST_SECTIONS.includes(h[2].trim().toLowerCase());
      if (inSection) picked.push(line);
      continue;
    }
    if (inSection) picked.push(line);
  }
  const body = picked.join('\n').trim();
  if (!body) return null;
  let text = `From MEMORY.md:\n${body}`;
  if (Buffer.byteLength(text, 'utf8') > DIGEST_MEMORY_CAP_BYTES) {
    const cut = Buffer.from(text, 'utf8').subarray(0, DIGEST_MEMORY_CAP_BYTES - 2).toString('utf8');
    text = cut.replace(/�+$/, '') + '…';
  }
  return text;
}

async function liveBufferDir(): Promise<string> {
  const home = await resolveHome();
  ensureDir0700(join(home, 'transcripts'));
  return ensureDir0700(join(home, 'transcripts', 'live'));
}

async function lastSessionLine(): Promise<string | null> {
  try {
    const dir = await liveBufferDir();
    let newest: { path: string; mtime: number } | null = null;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.txt')) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (!newest || st.mtimeMs > newest.mtime) newest = { path: p, mtime: st.mtimeMs };
    }
    if (!newest) return null;
    const lines = readFileSync(newest.path, 'utf8').split('\n').filter((l) => l.trim());
    const last = lines[lines.length - 1];
    if (!last) return null;
    try {
      const e = JSON.parse(last) as { ts?: string; exchange?: string };
      const snippet = typeof e.exchange === 'string' ? ` — ${e.exchange.slice(0, 200)}` : '';
      return `Last session activity: ${e.ts ?? 'unknown time'}${snippet}`;
    } catch {
      return `Last session activity: ${last.slice(0, 200)}`;
    }
  } catch {
    return null;
  }
}

const PUSH_STALE_MS = 48 * 60 * 60 * 1000;

async function pushStatusNote(): Promise<string | null> {
  try {
    const home = await resolveHome();
    const p = join(home, 'bootstrap', 'push-status.json');
    if (!existsSync(p)) return null;
    const s = JSON.parse(readFileSync(p, 'utf8')) as { ts?: string; ok?: boolean; reason?: string };
    if (s.ok === false) {
      return `Workspace push is FAILING (since ${s.ts ?? 'unknown'}): ${s.reason ?? 'unknown reason'} — run gbrain doctor`;
    }
    const t = s.ts ? Date.parse(s.ts) : NaN;
    if (Number.isFinite(t) && Date.now() - t > PUSH_STALE_MS) {
      return `Workspace push: last success ${s.ts} (>48h ago) — recent work may be unpushed [B4]`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * [B3] Visible degradation: when >50% of the trailing-20 heartbeat entries
 * are hard errors, say so in the digest. Degraded entries (pull-mode
 * no_serve, stale_serve, …) are DESIGNED fallbacks and don't count — the
 * notice is for broken, not for absent.
 */
async function hookFailureNotice(): Promise<string | null> {
  const tail = await readHeartbeatTail(HEARTBEAT_FAILURE_WINDOW);
  if (tail.length === 0) return null;
  const failures = tail.filter((e) => e.outcome === 'error').length;
  if (failures / tail.length > 0.5) {
    return 'brain context unavailable for recent turns — run gbrain doctor';
  }
  return null;
}

const STATUS_NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function statusFileNotice(): Promise<string | null> {
  try {
    const p = await hookStatusPath();
    if (!existsSync(p)) return null;
    const s = JSON.parse(readFileSync(p, 'utf8')) as { ts?: string; error?: string };
    const t = s.ts ? Date.parse(s.ts) : NaN;
    if (!Number.isFinite(t) || Date.now() - t > STATUS_NOTICE_MAX_AGE_MS) return null;
    return `Hook alert: ${s.error ?? 'unknown'} (${s.ts}) — transcript ingestion may be broken; run gbrain doctor`;
  } catch {
    return null;
  }
}

function tryExec(bin: string, args: string[], timeoutMs = 3000): string | null {
  try {
    return execFileSync(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * [G4] Crashed-session recovery: dirty tree or unpushed commits at session
 * start → attempt a workspace push (lazy import; swallow-and-heartbeat when
 * the module is absent or the push fails). GATED on an `initialized`
 * agent.json manifest at the repo root so this can never commit an
 * arbitrary repo the hook happens to run in.
 */
async function dirtyTreePush(
  ws: string,
): Promise<{ note?: string; degradedReason?: string } | null> {
  try {
    const root = tryExec('git', ['-C', ws, 'rev-parse', '--show-toplevel']);
    if (!root) return null;
    const manifest = readManifest(root);
    if (manifest.state !== 'initialized') return null; // not a bootstrap workspace
    const dirty = (tryExec('git', ['-C', root, 'status', '--porcelain']) ?? '') !== '';
    const aheadRaw = tryExec('git', ['-C', root, 'rev-list', '--count', '@{u}..HEAD']);
    const ahead = aheadRaw !== null ? parseInt(aheadRaw, 10) || 0 : 0;
    if (!dirty && ahead === 0) return null;
    try {
      const mod = await import('../core/workspace-push.ts');
      const res = await mod.workspacePush({ dir: root });
      if (res.ok && res.status === 'pushed') {
        return { note: 'Recovered work from a previous session: workspace committed and pushed.' };
      }
      return {
        note: `Unpushed work from a previous session detected; push attempt: ${res.status} — run gbrain doctor if this persists`,
        degradedReason: reasonCode(`push_${res.status}`),
      };
    } catch {
      return {
        note: 'Unpushed work from a previous session detected; automatic push unavailable — run gbrain doctor',
        degradedReason: 'push_unavailable',
      };
    }
  } catch {
    return null;
  }
}

// ── user-prompt [ENG-1, S3#8, A9] ───────────────────────────────────────────

interface UserPromptOutcome {
  outcome: HookHeartbeatEntry['outcome'];
  reason?: string;
  turns?: number;
}

async function hookUserPrompt(io: HookIo): Promise<number> {
  const t0 = Date.now();
  let expired = false;
  const guardedWrite = (s: string) => {
    if (!expired) write(io, s);
  };

  const work = (async (): Promise<UserPromptOutcome> => {
    const j = await readStdinJson(io, 300);
    if (!j) return { outcome: 'degraded', reason: 'no_stdin' };

    // S3#8: transcript_path is untrusted input. A present-but-unconfined
    // path aborts the event (heartbeat + empty stdout), never "best effort".
    let turns: WindowTurn[] = [];
    if (j.transcript_path !== undefined && j.transcript_path !== null) {
      const conf = confineTranscriptPath(j.transcript_path, {
        ...(io.transcriptRoot ? { root: io.transcriptRoot } : {}),
      });
      if (!conf.ok) return { outcome: 'degraded', reason: `transcript_${conf.reason}` };
      try {
        const parsed = parseTranscript(conf.path, { maxBytes: USER_PROMPT_TRANSCRIPT_MAX_BYTES });
        turns = parsed.turns.slice(-USER_PROMPT_WINDOW_TURNS);
      } catch {
        turns = []; // unreadable-mid-flight — the prompt alone still works
      }
    }
    const prompt = typeof j.prompt === 'string' ? j.prompt : '';
    if (prompt.trim()) turns = [...turns, { role: 'user', text: prompt }];
    if (turns.length === 0) return { outcome: 'ok', reason: 'empty_window' };

    const cfg = loadConfig();
    if (!cfg?.database_path) {
      // No config, or a Postgres brain (no PGLite data dir → no IPC socket).
      // ENGINE-FREE means no direct-engine fallback here; pull-mode covers it.
      return { outcome: 'degraded', reason: 'no_pglite_path' };
    }
    const socketPath = resolveSocketPath(cfg.database_path);
    const secret = readIpcSecret(cfg.database_path);
    if (!secret) return { outcome: 'degraded', reason: 'no_serve' };

    const sessionId = typeof j.session_id === 'string' ? j.session_id : undefined;
    const sourceId = process.env.GBRAIN_SOURCE || undefined;
    const res = await requestTurnContext(socketPath, {
      secret,
      window: turns,
      ...(sessionId ? { sessionId } : {}),
      ...(sourceId ? { sourceId } : {}),
    });
    if (res === IPC_UNAVAILABLE) {
      return { outcome: 'degraded', reason: 'ipc_unavailable', turns: turns.length };
    }
    if ('degraded' in res && res.degraded === 'stale_serve') {
      // [A9] Protocol echo missing → v1 serve answered; degrade LOUDLY.
      return { outcome: 'degraded', reason: 'stale_serve', turns: turns.length };
    }
    const resp = res as TurnContextResponse;
    if (!resp.ok) {
      return { outcome: 'degraded', reason: reasonCode(resp.error ?? 'server_error'), turns: turns.length };
    }
    const text = resp.block?.text ?? '';
    if (!text) return { outcome: 'ok', reason: 'empty_block', turns: turns.length };

    // [ENG-1] The 10000-char harness cap applies to the WHOLE stdout payload;
    // the block is budgeted ≤8KB server-side, but JSON escaping inflates, so
    // trim defensively rather than letting the harness divert-and-drop.
    let blockText = text;
    let payload = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: blockText },
    });
    while (payload.length > CLAUDE_HOOK_OUTPUT_CAP_CHARS && blockText.length > 0) {
      blockText = blockText.slice(0, Math.max(0, blockText.length - (payload.length - CLAUDE_HOOK_OUTPUT_CAP_CHARS) - 16));
      payload = JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: blockText },
      });
    }
    if (blockText.length === 0) return { outcome: 'degraded', reason: 'over_cap', turns: turns.length };
    guardedWrite(payload + '\n');
    return { outcome: 'ok', turns: turns.length };
  })();

  let result: UserPromptOutcome;
  try {
    const raced = await withDeadline(USER_PROMPT_DEADLINE_MS, work);
    if (raced === DEADLINE) {
      expired = true; // late writes are suppressed — a post-deadline block must not appear
      result = { outcome: 'degraded', reason: 'deadline' };
    } else {
      result = raced;
    }
  } catch (e) {
    expired = true;
    result = { outcome: 'error', reason: errorCode(e) };
  }
  await writeHeartbeat({
    ts: new Date().toISOString(),
    event: 'user-prompt',
    outcome: result.outcome,
    ...(result.reason ? { reason: result.reason } : {}),
    duration_ms: Date.now() - t0,
    ...(result.turns !== undefined ? { turns: result.turns } : {}),
  });
  return 0;
}

// ── stop [G15] ──────────────────────────────────────────────────────────────

async function hookStop(io: HookIo): Promise<number> {
  const t0 = Date.now();
  let outcome: HookHeartbeatEntry['outcome'] = 'ok';
  let reason: string | undefined;
  try {
    const j = await readStdinJson(io, 300);
    const sessionId = sanitizeSessionId(j?.session_id);
    const dir = await liveBufferDir();
    const exchange = firstString(j, ['last_assistant_message', 'lastAssistantMessage', 'prompt']);
    const entry = {
      ts: new Date().toISOString(),
      session_id: sessionId,
      ...(exchange ? { exchange: exchange.slice(0, 400) } : {}),
    };
    appendFileSync(join(dir, `${sessionId}.txt`), JSON.stringify(entry) + '\n', { mode: 0o600 });
    gcOldFiles(dir, STOP_BUFFER_RETENTION_MS);
  } catch (e) {
    outcome = 'error';
    reason = errorCode(e);
  }
  await writeHeartbeat({
    ts: new Date().toISOString(),
    event: 'stop',
    outcome,
    ...(reason ? { reason } : {}),
    duration_ms: Date.now() - t0,
  });
  return 0;
}

function firstString(j: Record<string, unknown> | null, keys: string[]): string | null {
  if (!j) return null;
  for (const k of keys) {
    const v = j[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function gcOldFiles(dir: string, maxAgeMs: number): void {
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.txt')) continue;
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
      } catch {
        /* per-file best effort */
      }
    }
  } catch {
    /* GC never breaks the hook */
  }
}

// ── session-end [S3#2, G3, G15] ─────────────────────────────────────────────

async function corpusDir(cfg: GBrainConfig | null): Promise<string> {
  const configured = cfg?.dream?.synthesize?.session_corpus_dir;
  if (configured && isAbsolute(configured)) return ensureDir0700(configured);
  const home = await resolveHome();
  ensureDir0700(join(home, 'transcripts'));
  return ensureDir0700(join(home, 'transcripts', 'corpus'));
}

function corpusRetentionDays(cfg: GBrainConfig | null): number {
  // Key is plan-defined [G15] but not yet in the GBrainConfig type (config.ts
  // is another lane's file) — read tolerantly.
  const synth = cfg?.dream?.synthesize as Record<string, unknown> | undefined;
  const v = synth?.corpus_retention_days;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : CORPUS_RETENTION_DAYS_DEFAULT;
}

async function hookSessionEnd(io: HookIo): Promise<number> {
  const t0 = Date.now();
  let outcome: HookHeartbeatEntry['outcome'] = 'ok';
  let reason: string | undefined;
  let turnsN: number | undefined;
  let bytesN: number | undefined;
  const degrade = (r: string) => {
    if (outcome === 'ok') {
      outcome = 'degraded';
      reason = r;
    }
  };

  let sessionId = 'unknown';
  let ws: string | undefined;
  try {
    const j = await readStdinJson(io, 500);
    sessionId = sanitizeSessionId(j?.session_id);
    ws = io.cwd ?? (typeof j?.cwd === 'string' ? (j.cwd as string) : process.cwd());
    const cfg = loadConfig();

    const conf = confineTranscriptPath(j?.transcript_path, {
      ...(io.transcriptRoot ? { root: io.transcriptRoot } : {}),
    });
    if (!conf.ok) {
      degrade(`transcript_${conf.reason}`);
    } else {
      const parsed = parseTranscript(conf.path);
      turnsN = parsed.turns.length;
      bytesN = parsed.bytesRead;
      if (bytesN > 0 && turnsN === 0) {
        // [G3] LOUD: the host format drifted under us — heartbeat error +
        // status file surfaced at the next session-start.
        outcome = 'error';
        reason = 'parser_drift';
        try {
          const p = await hookStatusPath();
          writeFileSync(
            p,
            JSON.stringify({ ts: new Date().toISOString(), error: 'parser_drift', bytes: bytesN }, null, 2) + '\n',
            { mode: 0o600 },
          );
        } catch {
          /* status telemetry best-effort */
        }
      } else if (turnsN > 0) {
        // [S3#2] Secret-scan AT WRITE TIME. Scanner absent → still write
        // (the corpus is 0700-local), but say so in the heartbeat.
        let text = toCorpusText(parsed.turns);
        try {
          const scan = await import('../core/secret-scan.ts');
          text = scan.redactFindings(text).text;
        } catch {
          degrade('scan_unavailable');
        }
        const dir = await corpusDir(cfg);
        // Session-id-keyed filename: a resumed session OVERWRITES its own
        // corpus file — dedup by construction [A6].
        writeFileSync(join(dir, `${sessionId}.txt`), text, { mode: 0o600 });
        gcOldFiles(dir, corpusRetentionDays(cfg) * 24 * 60 * 60 * 1000); // [G15]
      }
    }
  } catch (e) {
    outcome = 'error';
    reason = errorCode(e);
  }

  // Best-effort workspace push (the no-daemon persistence backstop, plan D6)
  // — same initialized-manifest gate as session-start [G4].
  try {
    if (ws) await dirtyTreePushUnconditional(ws);
  } catch {
    /* best effort */
  }

  // GC this session's stop buffer [G15].
  try {
    const dir = await liveBufferDir();
    rmSync(join(dir, `${sessionId}.txt`), { force: true });
  } catch {
    /* best effort */
  }

  await writeHeartbeat({
    ts: new Date().toISOString(),
    event: 'session-end',
    outcome,
    ...(reason ? { reason } : {}),
    duration_ms: Date.now() - t0,
    ...(turnsN !== undefined ? { turns: turnsN } : {}),
    ...(bytesN !== undefined ? { bytes: bytesN } : {}),
  });
  return 0;
}

/**
 * SessionEnd push: fires on clean trees too (workspacePush pushes even with
 * no new commit — a prior failure may have left local ahead). Same
 * bootstrap-workspace manifest gate as [G4].
 */
async function dirtyTreePushUnconditional(ws: string): Promise<void> {
  const root = tryExec('git', ['-C', ws, 'rev-parse', '--show-toplevel']);
  if (!root) return;
  const manifest = readManifest(root);
  if (manifest.state !== 'initialized') return;
  try {
    const mod = await import('../core/workspace-push.ts');
    await mod.workspacePush({ dir: root });
  } catch {
    /* absent module / push failure — the 15-min cron or next session covers it */
  }
}
