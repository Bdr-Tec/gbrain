/**
 * `gbrain volunteer-hook` — one-shot harness hook entry for push-based
 * context (the harness-adapter keystone; see docs/guides/push-context.md).
 *
 *   Claude Code / Codex UserPromptSubmit hook (stdin JSON, one process/prompt)
 *        ▼
 *   parse payload → transcript tail (window + previously-injected blocks)
 *        ▼
 *   rung 1: serve resolve-IPC socket (both engines; volunteer-shaped request;
 *           NEW serve gates+logs server-side, OLD serve → client re-gates)
 *   rung 2: Postgres-only deadline-bounded direct connect (no-serve rarity).
 *           PGLite + no serve → silence (the reflex ladder deliberately has
 *           no PGLite direct rung; a live serve's lock is never contended).
 *        ▼
 *   hookSpecificOutput.additionalContext envelope on stdout
 *
 * EXIT CONTRACT: in --harness mode this command ALWAYS exits 0 with either a
 * valid envelope or empty stdout. Claude Code treats a UserPromptSubmit
 * hook's exit 2 as BLOCK-the-prompt — a brain hiccup must never block a
 * turn. Diagnostics go to stderr only (harness-debug visible; the shipped
 * recipes deliberately do NOT discard stderr).
 *
 * Dispatched in cli.ts BEFORE connectEngine() (doctor precedent) — rung 1
 * needs no engine, and an eager connect would contend with serve on PGLite.
 * Listed in STARTUP_HOOK_SKIP_COMMANDS: a per-prompt invocation must never
 * spawn a detached check-update child. Never initializes PGLite in-process.
 */

import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, isThinClient, toEngineConfig } from '../core/config.ts';
import {
  resolveSocketPathForConfig,
  resolveViaIpcRaw,
  IPC_UNAVAILABLE,
  type ResolveResponse,
} from '../core/context/resolve-ipc.ts';
import {
  parseHookPayload,
  readTranscriptTail,
  emitHookEnvelope,
  type HookPayload,
  type TranscriptTail,
} from '../core/context/hook-adapters.ts';
import {
  gateVolunteeredPointers,
  candidatesByNorm,
  volunteerContext,
  VOLUNTEER_DEFAULT_MAX_PAGES,
  VOLUNTEER_DEFAULT_MIN_CONFIDENCE,
  type VolunteeredPage,
} from '../core/context/volunteer.ts';
import { extractCandidatesFromWindow, type WindowTurn } from '../core/context/entity-salience.ts';
import { windowTurnCount, reflexEnabled } from '../core/context/reflex.ts';
import type { VolunteerChannel } from '../core/context/volunteer-events.ts';

export const VOLUNTEER_HOOK_HELP = `gbrain volunteer-hook — one-shot harness hook entry for push-based context

Invoked by a Claude Code / Codex UserPromptSubmit hook: reads the hook JSON
payload on stdin, volunteers confidence-gated brain pages for the prompt, and
prints the harness injection envelope on stdout. ALWAYS exits 0 in --harness
mode (a hook exit code must never block a prompt); every failure is silence
with a reason on stderr.

Install via the recipes (they register the hook for you):
  gbrain integrations install claude-code-reflex --target <host-repo>
  gbrain integrations install codex-reflex                     # experimental

Usage:
  gbrain volunteer-hook --harness <claude-code|codex>    # hook payload on stdin
  echo "plain text" | gbrain volunteer-hook --json       # debug: raw pages JSON

Resolution: serve resolve-IPC socket first (no engine, no lock contention);
Postgres brains fall back to a deadline-bounded direct connect when no serve
is running. PGLite with no reachable serve stays silent — run \`gbrain serve\`
(the gbrain MCP registration does this) for the IPC path.

Flags:
  --harness <claude-code|codex>   attribution channel + hook-payload mode
  --max-pages N                   max pages volunteered (default ${VOLUNTEER_DEFAULT_MAX_PAGES}, cap 5)
  --min-confidence X              confidence gate 0..1 (default ${VOLUNTEER_DEFAULT_MIN_CONFIDENCE})
  --source <id>                   source scope (else GBRAIN_SOURCE / .gbrain-source / server-side cwd resolution)
  --json                          debug output (raw gated pages); refused on hook payloads
  --help                          this text
`;

/** Overall in-process budget (reflex precedent, reflex.ts). */
export const HOOK_DEADLINE_MS = 1500;
/** Rung-1 socket budget — a generous slice of the deadline (vs the ambient
 * reflex's 250ms): a busy-but-alive serve must not be misread as absent. */
export const HOOK_IPC_TIMEOUT_MS = 1000;

export interface VolunteerHookDeps {
  /** Raw stdin (tests inject; CLI reads process.stdin). */
  stdin: string;
  write?: (s: string) => void;
  warn?: (s: string) => void;
  loadConfigFn?: typeof loadConfig;
  resolveViaIpcRawFn?: typeof resolveViaIpcRaw;
  readTranscriptTailFn?: typeof readTranscriptTail;
  /** Rung 2 (Postgres only). Tests inject; CLI builds a real engine. */
  connectDirect?: () => Promise<BrainEngine | null>;
  deadlineMs?: number;
  cwd?: string;
}

function numFlag(args: string[], flag: string): number | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

function strFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** Engine-free source derivation (tiers 1-3) — reuses the hardened resolver
 * (#418 dotfile trust); a throw (malformed --source/env) degrades to
 * "omit + stderr" so the server resolves via cwd instead of blocking. */
async function deriveSourceId(explicit: string | undefined, cwd: string, warn: (s: string) => void): Promise<string | undefined> {
  try {
    const { resolveSourceIdEngineFree } = await import('../core/source-resolver.ts');
    return resolveSourceIdEngineFree(explicit ?? null, cwd) ?? undefined;
  } catch (e) {
    warn(`[volunteer-hook] source derivation failed (${(e as Error).message}) — deferring to server-side resolution`);
    return undefined;
  }
}

/**
 * Core flow, dependency-injected for tests. Returns the stdout payload ('' =
 * silence). NEVER throws — every failure path returns '' after a stderr line.
 */
export async function runVolunteerHook(args: string[], deps: VolunteerHookDeps): Promise<string> {
  const write = deps.write ?? ((s: string) => process.stdout.write(s));
  const warn = deps.warn ?? ((s: string) => process.stderr.write(s + '\n'));
  const loadCfg = deps.loadConfigFn ?? loadConfig;
  const ipcRaw = deps.resolveViaIpcRawFn ?? resolveViaIpcRaw;
  const readTail = deps.readTranscriptTailFn ?? readTranscriptTail;
  const deadlineMs = deps.deadlineMs ?? HOOK_DEADLINE_MS;

  const work = async (): Promise<string> => {
    const json = args.includes('--json');
    const harness = strFlag(args, '--harness');
    if (harness && harness !== 'claude-code' && harness !== 'codex') {
      warn(`[volunteer-hook] unknown --harness "${harness}" (expected claude-code|codex) — staying silent`);
      return '';
    }
    if (!harness && !json) {
      warn('[volunteer-hook] --harness <claude-code|codex> required (or --json for debug) — staying silent');
      return '';
    }

    // Parse stdin. Hook payload preferred; --json debug mode also accepts
    // plain text as a single user turn (like `gbrain volunteer-context`).
    const payload: HookPayload | null = parseHookPayload(deps.stdin);
    if (json && payload) {
      // A --json flag inside a real hook registration would inject raw JSON
      // into the prompt as context on exit 0 — refuse it loudly.
      warn('[volunteer-hook] --json refused on hook payloads (debug flag left in a hook registration?) — staying silent');
      return '';
    }
    let turns: WindowTurn[];
    let priorContextText: string | undefined;
    let sessionId: string | null = null;
    let payloadCwd: string | null = null;
    if (payload) {
      sessionId = payload.sessionId;
      payloadCwd = payload.cwd;
      // Window + dedupe from the transcript tail (fail-open to prompt-only).
      let tail: TranscriptTail | null = null;
      if (payload.transcriptPath) {
        tail = readTail(payload.transcriptPath, { maxTurns: windowTurnCount(safeLoad(loadCfg, warn)) });
        if (!tail) warn('[volunteer-hook] transcript tail unreadable/refused — prompt-only window, no cross-turn dedupe this turn');
      }
      turns = tail ? [...tail.turns] : [];
      // The current prompt may or may not already be in the tail — append it
      // as the newest user turn unless it is literally the last turn.
      const last = turns[turns.length - 1];
      if (!last || last.text !== payload.text.trim()) {
        turns.push({ role: 'user', text: payload.text.trim() });
      }
      // Cross-turn dedupe input: ONLY previously-injected blocks (structured
      // hook_additional_context attachments) — never the raw tail (T0/OV2-8).
      if (tail && tail.injectedBlocks.length) {
        priorContextText = tail.injectedBlocks.join('\n\n');
      }
    } else if (json && deps.stdin.trim()) {
      turns = [{ role: 'user', text: deps.stdin.trim() }];
    } else {
      warn('[volunteer-hook] stdin is not a recognized hook payload — staying silent');
      return '';
    }

    const cfg = safeLoad(loadCfg, warn);
    if (!cfg) {
      warn('[volunteer-hook] no gbrain config found — staying silent');
      return '';
    }
    if (isThinClient(cfg)) {
      warn('[volunteer-hook] thin-client install (remote brain, no local engine or serve socket) — push context over the remote path is a filed follow-up; staying silent');
      return '';
    }
    if (!reflexEnabled(cfg)) {
      warn('[volunteer-hook] retrieval_reflex disabled in config — staying silent');
      return '';
    }

    const candidates = extractCandidatesFromWindow(turns);
    if (!candidates.length) return ''; // nothing to volunteer — the common fast path

    const maxPages = numFlag(args, '--max-pages') ?? VOLUNTEER_DEFAULT_MAX_PAGES;
    const minConfidence = numFlag(args, '--min-confidence') ?? VOLUNTEER_DEFAULT_MIN_CONFIDENCE;
    const channel: VolunteerChannel = harness === 'codex' ? 'codex' : 'claude-code';
    const cwd = payloadCwd ?? deps.cwd ?? process.cwd();
    const sourceId = await deriveSourceId(strFlag(args, '--source'), cwd, warn);

    let pages: VolunteeredPage[] = [];

    // ── rung 1: serve resolve-IPC (both engines; no local engine needed) ──
    const sock = resolveSocketPathForConfig(cfg);
    let rung1Answered = false;
    if (sock) {
      const resp = await ipcRaw(
        sock,
        {
          candidates,
          priorContextText,
          suppression: 'slug-only',
          // Bounds an OLD server's pre-gate response (and its over-logging);
          // a NEW server ignores this for volunteer requests and resolves
          // the full pool internally before gating.
          maxPointers: maxPages,
          ...(sourceId ? { sourceId } : {}),
          cwd,
          channel,
          volunteer: { maxPages, minConfidence, windowSize: turns.length },
        },
        { timeoutMs: HOOK_IPC_TIMEOUT_MS },
      );
      if (resp !== IPC_UNAVAILABLE) {
        const r = resp as ResolveResponse;
        if (!r.ok) {
          warn(`[volunteer-hook] serve refused the request: ${r.error ?? 'unknown error'} — staying silent`);
          return '';
        }
        rung1Answered = true;
        if (Array.isArray(r.volunteered)) {
          // NEW serve: server-gated, server-logged. Use verbatim.
          pages = r.volunteered;
        } else if (r.block) {
          // OLD serve: plain reflex shape — apply the SAME pure gate
          // client-side (gate-function parity is test-pinned). Events were
          // logged server-side as 'reflex' (attribution-only degradation,
          // clears when serve restarts on the new build).
          pages = gateVolunteeredPointers(r.block, candidatesByNorm(candidates), {
            maxPages,
            minConfidence,
            windowSize: turns.length,
          });
        }
      }
    }

    // ── rung 2: Postgres-only deadline-bounded direct connect ──
    if (!rung1Answered) {
      const engineCfg = toEngineConfig(cfg);
      if (engineCfg.engine !== 'postgres') {
        warn('[volunteer-hook] no serve socket reachable and the PGLite engine has no safe direct rung — run `gbrain serve` (MCP registration) for the IPC path; staying silent');
        return '';
      }
      let engine: BrainEngine | null = null;
      try {
        engine = deps.connectDirect
          ? await deps.connectDirect()
          : await (async () => {
              const { createEngine } = await import('../core/engine-factory.ts');
              return createEngine(engineCfg);
            })();
        if (!engine) {
          warn('[volunteer-hook] direct connect unavailable — staying silent');
          return '';
        }
        const { resolveSourceId } = await import('../core/source-resolver.ts');
        const resolved = await resolveSourceId(engine, sourceId ?? null, cwd);
        pages = await volunteerContext(engine, turns, {
          sourceIds: [resolved],
          priorContext: priorContextText,
          maxPages,
          minConfidence,
        });
        if (pages.length) {
          const { logVolunteerEventsFireAndForget, volunteerEventRowsFrom, awaitPendingVolunteerEventWrites } =
            await import('../core/context/volunteer-events.ts');
          logVolunteerEventsFireAndForget(engine, volunteerEventRowsFrom(pages, { channel, session_id: sessionId }));
          await awaitPendingVolunteerEventWrites(500); // bank before the process exits
        }
      } catch (e) {
        warn(`[volunteer-hook] direct rung failed (${(e as Error).message}) — staying silent`);
        return '';
      } finally {
        try { await engine?.disconnect?.(); } catch { /* teardown is best-effort */ }
      }
    }

    if (!pages.length) return '';

    if (json) {
      return JSON.stringify({ pages, count: pages.length, window_turns: turns.length }) + '\n';
    }
    const { formatVolunteeredPage } = await import('../core/context/volunteer.ts');
    const blockText = [
      '## Brain pages mentioned this turn',
      ...pages.map((p) => `- ${formatVolunteeredPage(p).split('\n').join('\n  ')}`),
    ].join('\n');
    return emitHookEnvelope(payload?.event ?? 'UserPromptSubmit', blockText) + '\n';
  };

  try {
    const out = await Promise.race([
      work(),
      new Promise<string>((res) =>
        setTimeout(() => {
          warn(`[volunteer-hook] deadline (${deadlineMs}ms) exceeded — staying silent`);
          res('');
        }, deadlineMs),
      ),
    ]);
    if (out) {
      try { write(out); } catch { /* EPIPE — harness died; nothing to do */ }
    }
    return out;
  } catch (e) {
    // Top-level catch: NOTHING escapes — a hook must never block a prompt.
    warn(`[volunteer-hook] unexpected error (${(e as Error)?.message ?? e}) — staying silent`);
    return '';
  }
}

function safeLoad(loadCfg: typeof loadConfig, warn: (s: string) => void): ReturnType<typeof loadConfig> {
  try {
    return loadCfg();
  } catch (e) {
    warn(`[volunteer-hook] config load failed (${(e as Error).message})`);
    return null;
  }
}

/** CLI entry: reads stdin, runs the core, always resolves (exit 0). */
export async function runVolunteerHookCli(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(VOLUNTEER_HOOK_HELP);
    return;
  }
  let stdin = '';
  try {
    if (!process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      stdin = Buffer.concat(chunks).toString('utf8');
    }
  } catch { /* no stdin — handled below as unusable payload */ }
  if (!stdin.trim()) {
    // Bare interactive invocation: print help instead of hanging silent.
    process.stdout.write(VOLUNTEER_HOOK_HELP);
    return;
  }
  await runVolunteerHook(args, { stdin });
}
