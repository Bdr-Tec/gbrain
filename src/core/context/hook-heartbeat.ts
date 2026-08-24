/**
 * hook-heartbeat.ts — the hooks telemetry JSONL, extracted from hook.ts
 * (cathedral 5) so the serve-side checkpoint harvest can append its outcome
 * events WITHOUT importing the command module. ENGINE-FREE, pure fs.
 *
 * Contract [S3#7, B3] (unchanged from the hook.ts original): append-JSONL at
 * `<gbrain home>/integrations/hooks/heartbeat.jsonl` — counters, durations,
 * and error/status CODES only, NEVER prompt/fact/slug text. Dir 0700, file
 * capped at HEARTBEAT_MAX_LINES (tail-rewrite). `readHeartbeatTail` is the
 * doctor/status read surface. Fields are copied EXPLICITLY — the schema
 * allowlist is enforced by construction, not by trust. Never throws.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { ensureGbrainHome, resolveGbrainHome } from '../gbrain-home.ts';

/** Heartbeat file line cap [S3#7]. */
export const HEARTBEAT_MAX_LINES = 5000;

export interface HookHeartbeatEntry {
  ts: string;
  event: string;
  outcome: 'ok' | 'degraded' | 'error';
  reason?: string;
  duration_ms: number;
  turns?: number;
  bytes?: number;
  /** Secret-scan redaction COUNT at the session-end corpus write (never content) [S3#2, S3#7]. */
  redactions?: number;
  /**
   * Cathedral 5 — segment/corpus-mode status CODE for the compact and
   * session-end lanes (segment_banked / segment_dup / empty_window /
   * deadline_scan / remainder / skip_covered / …). Codes only, never
   * slugs/fact text [S3#7].
   */
  segment?: string;
  /** Cathedral 5 — checkpoint-harvest fact counters (counts only) [S3#7]. */
  inserted?: number;
  duplicate?: number;
  /**
   * Cathedral 5 — the compact hook's harvest-schedule ACK code
   * (`scheduled` / `skip_queue_full` / `skip_not_found` / `skip_bad_basename`
   * / `skip_no_session` / `skip_shutting_down` / `skip_already_queued`).
   * Without it a persistently misconfigured split corpus dir or a full queue
   * is observable nowhere. Codes only [S3#7].
   */
  flush?: string;
  /** Cathedral 5 — checkpoint-harvest verified-link COUNT (never slugs) [S3#7]. */
  links?: number;
}

/** The FULL key allowlist — CI greps the fixture against this [S3#7]. */
export const HEARTBEAT_ALLOWED_KEYS = [
  'ts', 'event', 'outcome', 'reason', 'duration_ms', 'turns', 'bytes', 'redactions',
  'segment', 'inserted', 'duplicate', 'links', 'flush',
] as const;

/** Gbrain home resolver: the S3#10 choke point (create-or-resolve, fail-open). */
async function resolveHome(): Promise<string> {
  try {
    return ensureGbrainHome();
  } catch {
    return resolveGbrainHome();
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

export async function hooksTelemetryDir(): Promise<string> {
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
 * Compaction trigger: only read the file back when its byte size could hold
 * more than ~2x HEARTBEAT_MAX_LINES entries. 40B is below any real entry's
 * size (the ISO ts alone is 24 chars), so this check can never UNDER-trigger.
 */
const HEARTBEAT_COMPACT_CHECK_BYTES = 2 * HEARTBEAT_MAX_LINES * 40;

/**
 * Append a heartbeat entry with a single O_APPEND write (no read-modify-write
 * per event — readers already tolerate torn lines). Compaction (tail-trim to
 * HEARTBEAT_MAX_LINES via tmp+rename) runs only when a cheap size/line-count
 * check says the file exceeds ~2x the cap. Never throws.
 */
export async function writeHeartbeat(
  entry: HookHeartbeatEntry,
  opts?: {
    /**
     * Skip the tail-trim compaction. The trim is read→tmp→rename with no
     * lock; a LONG-LIVED high-frequency writer (the serve harvest pump)
     * trimming concurrently with short-lived hook appends would silently
     * drop the other process's O_APPEND lines. Serve passes trim:false so
     * only short-lived hooks trim (the pre-existing narrow race window).
     */
    trim?: boolean;
  },
): Promise<void> {
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
      ...(entry.redactions !== undefined ? { redactions: entry.redactions } : {}),
      ...(entry.segment !== undefined ? { segment: entry.segment } : {}),
      ...(entry.inserted !== undefined ? { inserted: entry.inserted } : {}),
      ...(entry.duplicate !== undefined ? { duplicate: entry.duplicate } : {}),
      ...(entry.links !== undefined ? { links: entry.links } : {}),
      ...(entry.flush !== undefined ? { flush: entry.flush } : {}),
    });
    appendFileSync(p, line + '\n', { mode: 0o600 });
    if (opts?.trim === false) return;
    let size = 0;
    try {
      size = statSync(p).size;
    } catch {
      /* just appended — best effort */
    }
    if (size > HEARTBEAT_COMPACT_CHECK_BYTES) {
      const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().length > 0);
      if (lines.length > 2 * HEARTBEAT_MAX_LINES) {
        const tmp = `${p}.tmp-${process.pid}`;
        writeFileSync(tmp, lines.slice(-HEARTBEAT_MAX_LINES).join('\n') + '\n', { mode: 0o600 });
        renameSync(tmp, p);
      }
    }
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

// ── Session receipts (memorable integration) ────────────────────────────────
//
// Folded in here rather than given its own module: it shares this file's
// directory, its 0700/0600 permissions, its tail-rewrite compaction and its
// never-throw contract, and it is written from the same session-end path.
// Redaction is NOT reimplemented — the caller runs the corpus text and the
// tool calls through the one existing secret-scan pass in core/secret-scan.ts
// before anything reaches these functions.
//
// Nothing here runs unless the operator has turned the integration on; see
// the single `memorableAllowed` gate in commands/hook.ts.

export const SESSION_RECEIPTS_MAX_LINES = 2000;

export interface SessionReceiptEntry {
  ts: string;
  session_id: string;
  harness: 'claude-code' | 'codex' | 'opencode';
  corpus_path: string;
  content_hash: string;
  turn_count: number;
  workspace_root: string;
  /**
   * Secret-scanned JSON array of {name, input} for every tool_use block in
   * the parsed window (see ToolCallRecord in claude-code-jsonl.ts) — the
   * actual command/arguments, not the placeholder-only rendering the corpus
   * text itself carries. '[]' when scanning failed or nothing ran.
   */
  tool_calls_json: string;
  /** false when the secret-scan import failed and the corpus was written unscanned — see hook.ts's scan_unavailable degrade. */
  secret_scan_ok: boolean;
}

export async function sessionReceiptsPath(): Promise<string> {
  return join(await hooksTelemetryDir(), 'session-receipts.jsonl');
}

const RECEIPTS_COMPACT_CHECK_BYTES = 2 * SESSION_RECEIPTS_MAX_LINES * 80;

/** Append one receipt line. Never throws — a receipt-write failure must never break session-end. */
export async function appendSessionReceipt(entry: Omit<SessionReceiptEntry, 'ts'>): Promise<void> {
  try {
    const p = await sessionReceiptsPath();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(p, line + '\n', { mode: 0o600 });
    let size = 0;
    try {
      size = statSync(p).size;
    } catch {
      /* just appended — best effort */
    }
    if (size > RECEIPTS_COMPACT_CHECK_BYTES) {
      const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().length > 0);
      if (lines.length > 2 * SESSION_RECEIPTS_MAX_LINES) {
        const tmp = `${p}.tmp-${process.pid}`;
        writeFileSync(tmp, lines.slice(-SESSION_RECEIPTS_MAX_LINES).join('\n') + '\n', { mode: 0o600 });
        renameSync(tmp, p);
      }
    }
  } catch {
    /* a receipt is an optional signal — never break the hook it describes */
  }
}

/** Last `n` receipt entries (oldest → newest). Callers should take the newest per session_id. */
export async function readSessionReceiptsTail(n: number): Promise<SessionReceiptEntry[]> {
  try {
    const p = await sessionReceiptsPath();
    const raw = readFileSync(p, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const out: SessionReceiptEntry[] = [];
    for (const line of lines.slice(-Math.max(0, n))) {
      try {
        out.push(JSON.parse(line) as SessionReceiptEntry);
      } catch {
        /* torn line — skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Resolve the `memorable` CLI on PATH ourselves before spawning it.
 *
 * spawn() reports a missing executable as an ASYNC 'error' event, which lands
 * after this hook has already written its heartbeat and exited — so an
 * enabled-but-not-installed integration looks exactly like a working one that
 * had nothing to do. Checking first is what makes that state visible in
 * `gbrain doctor` (heartbeat reason `memorable_cli_missing`) instead of
 * silently doing nothing. Honors MEMORABLE_BIN for installs outside PATH.
 */
export function resolveMemorableBin(): string | null {
  const explicit = process.env.MEMORABLE_BIN;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        const candidate = join(dir, 'memorable' + ext);
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* not here — next candidate */ }
    }
  }
  return null;
}
