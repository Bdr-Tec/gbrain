/**
 * Harness hook adapters — pure parsing/extraction for `gbrain volunteer-hook`.
 *
 *   harness (Claude Code / Codex) UserPromptSubmit hook
 *        │ stdin JSON {session_id, transcript_path, cwd, hook_event_name, prompt}
 *        ▼
 *   parseHookPayload ──▶ readTranscriptTail ──▶ parseTranscriptTail
 *        │                    (confined IO)          (pure)
 *        │                                    ├─ turns[]           → extraction window
 *        │                                    └─ injectedBlocks[]  → priorContextText
 *        ▼                                        (cross-turn dedupe: ONLY what we
 *   emitHookEnvelope                               previously injected — structured
 *   {hookSpecificOutput:{additionalContext}}       attachment lines, never raw tail
 *                                                  substring matching)
 *
 * T0 evidence (2026-08-07, claude CLI 2.1.224): a UserPromptSubmit hook's
 * additionalContext is recorded in the session transcript as
 *   {"type":"attachment","attachment":{"type":"hook_additional_context",
 *    "content":[...], "hookName":"UserPromptSubmit", ...}}
 * and `transcript_path` is stable across turns — so turn N+1's tail contains
 * turn N's injection. Dedupe selects those lines STRUCTURALLY (no substring
 * heuristics → no over-suppression from tool payloads in the tail).
 *
 * Trust boundary: hook stdin is UNTRUSTED. session_id is length-clamped and
 * never used in a filesystem path; transcript_path is confined to a real
 * `.jsonl` file under $HOME (realpath — a symlink escaping $HOME is refused)
 * with a size-capped tail read. Every failure returns null — the caller's
 * contract is silence, never a blocked prompt.
 */

import { openSync, readSync, closeSync, fstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { sep } from 'node:path';
import type { WindowTurn } from './entity-salience.ts';

export const SUPPORTED_HOOK_EVENTS = ['UserPromptSubmit', 'PostToolUse'] as const;
export type SupportedHookEvent = (typeof SUPPORTED_HOOK_EVENTS)[number];

export interface HookPayload {
  event: SupportedHookEvent;
  /** The turn text to extract entities from (prompt / tool response). */
  text: string;
  /** Length-clamped (256) caller-supplied attribution id; never a path. */
  sessionId: string | null;
  transcriptPath: string | null;
  cwd: string | null;
}

const SESSION_ID_MAX = 256;

/**
 * Parse an untrusted harness hook payload. Accepts the Claude Code shape
 * (codex-cli 0.136.0 embeds the same event names + wire schema); text keys
 * are read defensively (`prompt` / `user_prompt` / `text`, and PostToolUse's
 * `tool_response`). Returns null for anything unusable — unknown event,
 * non-JSON, empty text — the caller stays silent.
 */
export function parseHookPayload(raw: string): HookPayload | null {
  if (!raw || !raw.trim()) return null;
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const event = obj.hook_event_name;
  if (event !== 'UserPromptSubmit' && event !== 'PostToolUse') return null;

  let text: string | null = null;
  if (event === 'UserPromptSubmit') {
    for (const k of ['prompt', 'user_prompt', 'text']) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) { text = v; break; }
    }
  } else {
    const v = obj.tool_response;
    if (typeof v === 'string' && v.trim()) text = v;
    else if (v && typeof v === 'object') {
      try { text = JSON.stringify(v); } catch { text = null; }
    }
  }
  if (!text || !text.trim()) return null;

  const sessionId = typeof obj.session_id === 'string' && obj.session_id.trim()
    ? obj.session_id.slice(0, SESSION_ID_MAX)
    : null;
  const transcriptPath = typeof obj.transcript_path === 'string' && obj.transcript_path.trim()
    ? obj.transcript_path
    : null;
  const cwd = typeof obj.cwd === 'string' && obj.cwd.trim() ? obj.cwd : null;

  return { event, text, sessionId, transcriptPath, cwd };
}

export interface TranscriptTail {
  /** Oldest→newest conversation turns recovered from the tail. */
  turns: WindowTurn[];
  /** Previously-injected hook context blocks (structured attachment lines). */
  injectedBlocks: string[];
}

export const TRANSCRIPT_TAIL_MAX_BYTES = 64 * 1024;

/**
 * PURE tail parser: newline-delimited transcript JSON in, turns + injected
 * blocks out. Tolerates a leading partial line (tail reads cut mid-line) and
 * skips malformed lines individually — one bad line never drops the rest.
 */
export function parseTranscriptTail(tailText: string, maxTurns: number): TranscriptTail {
  const turns: WindowTurn[] = [];
  const injectedBlocks: string[] = [];
  for (const line of tailText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue; // partial/garbled line — skip, keep the rest
    }
    const type = entry.type;
    if (type === 'attachment') {
      const att = entry.attachment as Record<string, unknown> | undefined;
      if (att && att.type === 'hook_additional_context' && Array.isArray(att.content)) {
        const text = (att.content as unknown[]).filter((c) => typeof c === 'string').join('\n');
        if (text.trim()) injectedBlocks.push(text);
      }
      continue;
    }
    if (type === 'user') {
      // User PROMPTS have string content; tool results have array content —
      // only prompts are conversation turns (T0-verified shape).
      const msg = entry.message as Record<string, unknown> | undefined;
      if (msg && msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
        turns.push({ role: 'user', text: msg.content.trim() });
      }
      continue;
    }
    if (type === 'assistant') {
      const msg = entry.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      if (msg && msg.role === 'assistant' && Array.isArray(content)) {
        const text = (content as Array<Record<string, unknown>>)
          .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text as string)
          .join('\n')
          .trim();
        if (text) turns.push({ role: 'assistant', text });
      }
    }
  }
  return {
    turns: maxTurns > 0 ? turns.slice(-maxTurns) : turns,
    injectedBlocks,
  };
}

/**
 * Confined tail read of a harness transcript. Refuses anything that is not a
 * real `.jsonl` file whose REAL path (symlinks resolved) lives under the
 * CURRENT $HOME — homedir() is read per call, never cached at module load,
 * so test HOME redirection (withEnv) works. Returns null on ANY failure.
 */
export function readTranscriptTail(
  path: string,
  opts: { maxBytes?: number; maxTurns?: number } = {},
): TranscriptTail | null {
  const maxBytes = opts.maxBytes ?? TRANSCRIPT_TAIL_MAX_BYTES;
  const maxTurns = opts.maxTurns ?? 4;
  try {
    if (!path.endsWith('.jsonl')) return null;
    const real = realpathSync(path);
    if (!real.endsWith('.jsonl')) return null;
    // $HOME read per call, env-first: withEnv test redirection works, and a
    // module-load cache would freeze the boundary for the process lifetime.
    const home = realpathSync(process.env.HOME || homedir());
    if (real !== home && !real.startsWith(home + sep)) return null;

    const fd = openSync(real, 'r');
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return null;
      const size = st.size;
      const readLen = Math.min(size, maxBytes);
      const buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, size - readLen);
      let text = buf.toString('utf8');
      if (readLen < size) {
        // Tail cut mid-line: drop the leading partial line.
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
      }
      return parseTranscriptTail(text, maxTurns);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * The harness injection envelope. Exact shape both Claude Code and
 * codex-cli 0.136.0 consume: stdout JSON with
 * hookSpecificOutput.additionalContext (exit 0).
 */
export function emitHookEnvelope(event: SupportedHookEvent, text: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: text,
    },
  });
}
