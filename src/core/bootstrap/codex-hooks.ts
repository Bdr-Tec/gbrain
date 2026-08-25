/**
 * codex-hooks.ts — the codex `hooks.json` writer (SessionEnd capture lane).
 *
 * SPEC TARGET (verified): codex-cli 0.147.0, observation run 2026-08-25
 * (live captures + openai/codex source at tag rust-v0.147.0). The facts this
 * writer is built on, none of them guesses:
 *
 *  - File: $CODEX_HOME/hooks.json. TOP-LEVEL DENY-UNKNOWN-FIELDS: any extra
 *    top-level key makes codex skip the WHOLE file with only a stderr
 *    warning — so ownership rides the one legal metadata slot
 *    (`description`) plus a command-substring token, never a `_gbrain` key.
 *  - Schema: {description?, hooks: {SessionEnd: [{matcher?, hooks:
 *    [{type:'command', command:<shell string via $SHELL -lc>, timeout:<sec>,
 *    async?, …}]}]}} — PascalCase event names.
 *  - TRUST GATE (fail-closed, SILENT): a user-layer hook runs ONLY when
 *    $CODEX_HOME/config.toml carries
 *    [hooks.state."<abs hooks.json path>:session_end:<group>:<handler>"]
 *    trusted_hash = "sha256:" + sha256hex(compact canonical JSON, keys
 *    sorted recursively, of the normalized identity {event_name, matcher?,
 *    hooks:[{type, command, timeout, async, …}]}, None fields omitted).
 *    Without it the hook is listed and NEVER EXECUTED, with zero warnings in
 *    `codex exec` output. So this writer writes TWO files, and any command
 *    edit re-hashes.
 *  - SessionEnd handlers are hard-killed at 3s — the command captures stdin
 *    to a temp file and detaches a grandchild (`nohup … &`) that runs the
 *    real `gbrain hook session-end --harness codex`, so ingest time never
 *    races the kill.
 *  - Deliberately NO GBRAIN_SOURCE in the command [OV2]: hooks.json is
 *    user-global; a baked source would stamp every codex session on the
 *    machine with the last-bootstrapped repo. session-end resolves everything
 *    from the payload (cwd/transcript_path/session_id) at runtime — and it
 *    reads no GBRAIN_SOURCE at all, so the ambient-env tier [EV4] cannot
 *    misattribute this lane either.
 *  - Index sensitivity (documented residual): the trust key embeds our
 *    group's index in the SessionEnd array. We always strip-ours-then-APPEND
 *    (so writing never shifts a FOREIGN group's index and never breaks the
 *    user's own trust entries); if the user later reorders/removes their own
 *    groups, OUR entry can go stale — the hook then silently stops, which is
 *    exactly what doctor's codex-wired-but-zero-receipts rung exists to name.
 *  - Version sensitivity: all of this is pinned to 0.147.0 with no upstream
 *    stability promise — re-run the observation gate on codex version bumps.
 */

import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HostSpecTarget } from './host-specs.ts';
import { codexConfigPath, codexHooksPath } from './host-specs.ts';

export const CODEX_HOOKS_SPEC_TARGET: HostSpecTarget = {
  id: 'codex-hooks-2026-08',
  status: 'verified',
  verifiedAt: '2026-08-25',
  references: [
    'codex-cli 0.147.0 observation run 2026-08-25 (live SessionEnd payload + trust-gate captures)',
    'openai/codex tag rust-v0.147.0: hooks/discovery.rs, hooks/fingerprint.rs, config_rules.rs',
  ],
  note:
    'hooks.json is top-level deny-unknown-fields (description is the one legal metadata slot); ' +
    'user-layer hooks are trust-gated via [hooks.state."<path>:session_end:<g>:<h>"].trusted_hash ' +
    'in config.toml (silent non-execution without it); SessionEnd budget 3s hard-kill; payload ' +
    '{session_id, transcript_path, cwd, hook_event_name, reason:"other" always}; fires on normal/' +
    'API-error exit + SIGINT, never SIGKILL; rollout flushed before the hook.',
};

/** Substring that marks a SessionEnd handler as gbrain-owned (the command
 * string is the only marker surface deny-unknown-fields leaves us). */
export const CODEX_HOOK_OWNERSHIP_TOKEN = 'hook session-end --harness codex';

const GBRAIN_DESCRIPTION =
  'gbrain session-end capture — the SessionEnd entry whose command mentions "gbrain" is managed by `gbrain bootstrap` (re-runs rewrite it; `gbrain bootstrap remove` deletes it)';

const TRUST_BLOCK_BEGIN = '# --- gbrain:codex-hooks-trust (managed block — do not edit; gbrain bootstrap rewrites it) ---';
const TRUST_BLOCK_END = '# --- /gbrain:codex-hooks-trust ---';

/** SessionEnd is hard-clamped to 3s by codex; declare exactly that. */
const SESSION_END_TIMEOUT_SEC = 3;

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_.:/@=-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * The SessionEnd command: capture stdin, detach a grandchild, exit within the
 * 3s budget. `sh -c '…' <bin>` passes the gbrain binary as $0, so the inner
 * single-quoted script needs no nested quoting of the path.
 */
export function buildCodexSessionEndCommand(gbrainBin: string): string {
  return (
    't="$(mktemp)"; cat >"$t"; GBRAIN_PAYLOAD="$t" nohup sh -c ' +
    `'"$0" ${CODEX_HOOK_OWNERSHIP_TOKEN} <"$GBRAIN_PAYLOAD"; rm -f "$GBRAIN_PAYLOAD"' ` +
    `${shellQuote(gbrainBin)} >/dev/null 2>&1 &`
  );
}

/** Compact JSON with recursively-sorted keys — codex's canonical form. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The trust hash for OUR SessionEnd handler shape (matcher/None fields omitted). */
export function codexTrustHash(command: string): string {
  const identity = {
    event_name: 'session_end',
    hooks: [{ type: 'command', command, timeout: SESSION_END_TIMEOUT_SEC, async: false }],
  };
  return 'sha256:' + createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex');
}

interface HooksJson {
  description?: string;
  hooks?: Record<string, Array<{ matcher?: unknown; hooks?: Array<{ type?: unknown; command?: unknown; [k: string]: unknown }> }>>;
  [k: string]: unknown;
}

function isOurGroup(group: { hooks?: Array<{ command?: unknown }> }): boolean {
  return (group.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(CODEX_HOOK_OWNERSHIP_TOKEN));
}

export interface WriteCodexHooksResult {
  ok: boolean;
  hooksPath: string;
  configPath: string;
  trustKey?: string;
  replacedPrior?: boolean;
  reason?: 'hooks_json_unparseable' | 'foreign_trust_entry' | 'config_toml_unreadable';
  notes: string[];
}

/**
 * Write (or rewrite) gbrain's SessionEnd entry + its trust-state entry.
 * Fail-closed: a hooks.json that exists but does not parse is NEVER touched
 * (codex itself would skip it; overwriting could destroy the user's own
 * hooks), and a foreign [hooks.state] entry for our exact key outside our
 * managed block is a refusal, not an overwrite.
 */
export function writeCodexHooks(opts: {
  gbrainBin: string;
  hooksPath?: string;
  configPath?: string;
}): WriteCodexHooksResult {
  const hooksPath = opts.hooksPath ?? codexHooksPath();
  const configPath = opts.configPath ?? codexConfigPath();
  const notes: string[] = [];

  // 1. hooks.json — parse (fail-closed), strip ours, append ours LAST.
  let doc: HooksJson = {};
  let existed = false;
  if (existsSync(hooksPath)) {
    existed = true;
    try {
      doc = JSON.parse(readFileSync(hooksPath, 'utf8')) as HooksJson;
      if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new Error('not an object');
    } catch {
      return { ok: false, hooksPath, configPath, reason: 'hooks_json_unparseable', notes: [`${hooksPath} exists but does not parse as a JSON object — fix or remove it (codex skips it too), then re-run.`] };
    }
  }
  const hooks = (doc.hooks && typeof doc.hooks === 'object' && !Array.isArray(doc.hooks) ? doc.hooks : {}) as NonNullable<HooksJson['hooks']>;
  const sessionEnd = Array.isArray(hooks.SessionEnd) ? hooks.SessionEnd : [];
  const foreign = sessionEnd.filter((g) => !isOurGroup(g));
  const replacedPrior = foreign.length !== sessionEnd.length;
  const command = buildCodexSessionEndCommand(opts.gbrainBin);
  const ourGroup = { hooks: [{ type: 'command', command, timeout: SESSION_END_TIMEOUT_SEC }] };
  const nextSessionEnd = [...foreign, ourGroup];
  const ourGroupIndex = nextSessionEnd.length - 1;
  const nextDoc: HooksJson = {
    ...doc,
    ...(doc.description === undefined ? { description: GBRAIN_DESCRIPTION } : {}),
    hooks: { ...hooks, SessionEnd: nextSessionEnd },
  };

  // 2. config.toml trust entry — OUR entries live inside the managed marker
  //    block; everything outside survives byte-for-byte.
  const trustKey = `${hooksPath}:session_end:${ourGroupIndex}:0`;
  let configText = '';
  if (existsSync(configPath)) {
    try {
      configText = readFileSync(configPath, 'utf8');
    } catch {
      return { ok: false, hooksPath, configPath, reason: 'config_toml_unreadable', notes: [`${configPath} exists but is unreadable — fix permissions and re-run.`] };
    }
  }
  const crlf = configText.includes('\r\n');
  const lines = configText.replace(/\r\n/g, '\n').split('\n');
  const begin = lines.indexOf(TRUST_BLOCK_BEGIN);
  const end = lines.indexOf(TRUST_BLOCK_END);
  const remainder = begin >= 0 && end > begin ? [...lines.slice(0, begin), ...lines.slice(end + 1)] : [...lines];
  // Foreign-ownership guard: our exact table header outside our block would
  // become a duplicate-table hard parse error that bricks codex entirely.
  const header = `[hooks.state.${JSON.stringify(trustKey)}]`;
  if (remainder.some((l) => l.trim() === header)) {
    return {
      ok: false, hooksPath, configPath, reason: 'foreign_trust_entry',
      notes: [`${configPath} already defines ${header} outside the gbrain-managed block — refusing to double-define it (a hard TOML parse error). Remove that entry and re-run.`],
    };
  }
  while (remainder.length > 0 && remainder[remainder.length - 1]!.trim() === '') remainder.pop();
  const block = [
    TRUST_BLOCK_BEGIN,
    `${header}`,
    `trusted_hash = ${JSON.stringify(codexTrustHash(command))}`,
    TRUST_BLOCK_END,
  ];
  const nextConfig = [...(remainder.length ? [...remainder, ''] : []), ...block, ''].join('\n');

  // 3. Write both, hooks.json first (a trust entry for a missing file is
  //    inert; a hooks file without trust is silently skipped — either partial
  //    state is safe, this order just minimizes the skipped window).
  mkdirSync(dirname(hooksPath), { recursive: true });
  mkdirSync(dirname(configPath), { recursive: true });
  if (existed) {
    copyFileSync(hooksPath, `${hooksPath}.bak`);
    chmodSync(`${hooksPath}.bak`, 0o600);
  }
  const tmpHooks = `${hooksPath}.tmp-${process.pid}`;
  writeFileSync(tmpHooks, JSON.stringify(nextDoc, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmpHooks, hooksPath);

  if (configText) {
    // DISTINCT suffix: config.toml.bak is the MCP block writer's rollback
    // anchor (harness lane [X5] restores it on a failed smoke) — reusing it
    // here would clobber that anchor and make the rollback restore THIS
    // write's post-state instead of the pre-run config.
    copyFileSync(configPath, `${configPath}.hooks.bak`);
    chmodSync(`${configPath}.hooks.bak`, statSync(configPath).mode & 0o777);
  }
  const tmpCfg = `${configPath}.tmp-${process.pid}`;
  writeFileSync(tmpCfg, crlf ? nextConfig.replace(/\n/g, '\r\n') : nextConfig, { mode: 0o600 });
  renameSync(tmpCfg, configPath);

  if (foreign.length > 0) notes.push(`${foreign.length} foreign SessionEnd group(s) preserved; gbrain's entry appended last so their trust-state indexes never shift.`);
  return { ok: true, hooksPath, configPath, trustKey, replacedPrior, notes };
}

export interface RemoveCodexHooksResult {
  hooksPath: string;
  configPath: string;
  removed: boolean;
  notes: string[];
}

/** Strip gbrain's SessionEnd entry + managed trust block. Foreign content
 * survives byte-for-byte; an unparseable hooks.json is left untouched. */
export function removeCodexHooks(opts: { hooksPath?: string; configPath?: string } = {}): RemoveCodexHooksResult {
  const hooksPath = opts.hooksPath ?? codexHooksPath();
  const configPath = opts.configPath ?? codexConfigPath();
  const notes: string[] = [];
  let removed = false;

  if (existsSync(hooksPath)) {
    try {
      const doc = JSON.parse(readFileSync(hooksPath, 'utf8')) as HooksJson;
      const hooks = (doc.hooks ?? {}) as NonNullable<HooksJson['hooks']>;
      const sessionEnd = Array.isArray(hooks.SessionEnd) ? hooks.SessionEnd : [];
      const foreign = sessionEnd.filter((g) => !isOurGroup(g));
      if (foreign.length !== sessionEnd.length) {
        removed = true;
        if (foreign.length > 0) hooks.SessionEnd = foreign;
        else delete hooks.SessionEnd;
        const tmp = `${hooksPath}.tmp-${process.pid}`;
        writeFileSync(tmp, JSON.stringify({ ...doc, hooks }, null, 2) + '\n', { mode: 0o600 });
        renameSync(tmp, hooksPath);
      }
    } catch {
      notes.push(`${hooksPath} does not parse — left untouched (nothing gbrain wrote survives a hand-mangled file; remove it manually).`);
    }
  }

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf8');
    const crlf = raw.includes('\r\n');
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const begin = lines.indexOf(TRUST_BLOCK_BEGIN);
    const end = lines.indexOf(TRUST_BLOCK_END);
    if (begin >= 0 && end > begin) {
      removed = true;
      const remainder = [...lines.slice(0, begin), ...lines.slice(end + 1)];
      while (remainder.length > 0 && remainder[remainder.length - 1]!.trim() === '') remainder.pop();
      const next = remainder.length ? remainder.join('\n') + '\n' : '';
      const tmp = `${configPath}.tmp-${process.pid}`;
      writeFileSync(tmp, crlf ? next.replace(/\n/g, '\r\n') : next, { mode: statSync(configPath).mode & 0o777 });
      renameSync(tmp, configPath);
    }
  }
  return { hooksPath, configPath, removed, notes };
}
