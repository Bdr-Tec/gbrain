/**
 * opencode-json.ts — managed `mcp.<name>` entry writer for opencode's JSONC
 * configs (see TARGETS['opencode-2026-08'] in host-specs.ts and
 * docs/mcp/OPENCODE-CLI-PIN.md for the verified format assumptions).
 *
 * Why a direct writer exists: `opencode mcp add` always targets the
 * user-global opencode.jsonc (no scope flag), cannot set file modes (the
 * harness lane's inline bearer needs 0600), and requires the binary on the
 * box — the writer covers project scope, secret hygiene, and offline/
 * pre-install registration with one code path.
 *
 * Safety invariants (codex-toml.ts analog, adapted for JSONC):
 * - ALL edits go through jsonc-parser `modify`/`applyEdits` — text splicing
 *   that preserves comments, formatting, and EOLs byte-for-byte outside the
 *   edited range. opencode's own `mcp add` preserves comments (observed);
 *   gbrain matches that bar. JSON.parse is never used on config text.
 * - Ownership is a STRUCTURAL FINGERPRINT, not a marker key (unknown keys
 *   are tolerated by opencode 1.18.18, but a future strict-schema flip must
 *   not brick the user's opencode): a local entry is ours when command[0] is
 *   gbrain-shaped AND environment.GBRAIN_SOURCE exists; source EQUALITY
 *   (not mere presence) splits `ours-same-source` from `ours-other-source`
 *   ([FIX7] parity with verifyMcpTargetsWorkspace) — callers warn before
 *   overwriting another workspace's registration. A remote entry is ours
 *   when its url matches the caller's receipt, or when its Authorization
 *   header carries the `{env:GBRAIN_REMOTE_TOKEN}` interpolation (only the
 *   connect lane writes that). Anything else under our name is FOREIGN —
 *   refuse, never guess.
 * - Read-failure classes are distinct: ENOENT → fresh file; empty/whitespace
 *   → treated as `{}`; unreadable (EACCES etc.) → refuse loudly (never
 *   clobber what cannot be read). A file that fails even JSONC parsing →
 *   refuse with a paste-by-hand snippet.
 * - Post-render validation before rename: the rendered text is re-parsed,
 *   our entry deep-asserted, and every OTHER top-level key asserted to
 *   survive; on any failure the original file is untouched.
 * - Secrets hygiene: when the entry carries an inline bearer the target is
 *   forced 0600 and the .bak is chmod'd 0600 (on re-runs it carries the
 *   PREVIOUS token). Token-free entries inherit the file's existing mode.
 * - Concurrency: callers hold acquireBootstrapLock (config-dir →
 *   opencode-dir ordering, mirroring the codex lanes in harness.ts) — the
 *   writer itself is lock-free like codex-toml.ts.
 */

import { chmodSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { atomicWriteTextFile } from './atomic-write.ts';

export const GBRAIN_REMOTE_TOKEN_ENV = 'GBRAIN_REMOTE_TOKEN';
const ENV_INTERPOLATION = `{env:${GBRAIN_REMOTE_TOKEN_ENV}}`;

// ── Entry shapes ────────────────────────────────────────────────────────────

export interface OpencodeLocalEntry {
  kind: 'local';
  name: string;
  /** argv — command[0] is PATH-resolved "gbrain" (project scope, committed-
   * file candidate) or an absolute binary path (user scope). */
  command: string[];
  environment: Record<string, string>;
}

export interface OpencodeRemoteEntry {
  kind: 'remote';
  name: string;
  url: string;
  /** 'inline' writes `Bearer <token>` (harness lane — framework-spawned
   * opencode inherits no shell profile; file forced 0600). 'env' writes the
   * `{env:GBRAIN_REMOTE_TOKEN}` interpolation (connect lane — token never
   * enters the file). */
  tokenMode: 'inline' | 'env';
  bearerToken?: string;
}

export type OpencodeMcpEntry = OpencodeLocalEntry | OpencodeRemoteEntry;

export type OpencodeEntryKind =
  | 'absent'
  | 'ours-same-source'
  | 'ours-other-source'
  | 'foreign';

export interface OpencodeEntryExpectation {
  /** GBRAIN_SOURCE the caller is registering (local entries). */
  sourceId?: string;
  /** Serve url from the caller's receipt (remote entries). */
  url?: string;
}

export interface WriteOpencodeEntryResult {
  configPath: string;
  /** True when a prior gbrain-owned entry was replaced (idempotent re-run). */
  replacedPrior: boolean;
  /** Kind of the pre-existing entry (what was there before this write). */
  priorKind: OpencodeEntryKind;
  backupPath: string | null;
  notes: string[];
}

export interface RemoveOpencodeEntryResult {
  configPath: string;
  removed: boolean;
  backupPath: string | null;
  notes: string[];
}

// ── Read + parse (failure classes are distinct) ─────────────────────────────

interface RawConfig {
  text: string;
  existed: boolean;
}

function readConfigRaw(configPath: string): RawConfig {
  if (!existsSync(configPath)) return { text: '', existed: false };
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (e) {
    throw new Error(
      `${configPath} exists but cannot be read (${(e as Error).message}) — ` +
        `refusing to touch a config that cannot be read back. Fix permissions and re-run.`,
    );
  }
  return { text, existed: true };
}

/**
 * Parse config text as JSONC (opencode's effective grammar for BOTH .json
 * and .jsonc files — OPENCODE-CLI-PIN.md §Config format). Empty/whitespace
 * text parses as `{}`. Text that fails even JSONC parsing throws with a
 * paste-by-hand snippet so the user is never stranded.
 */
export function parseOpencodeConfig(text: string, configPath: string, snippet?: string): Record<string, unknown> {
  if (text.trim() === '') return {};
  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(
      `${configPath} does not parse as JSONC (${printParseErrorCode(first.error)} at offset ${first.offset}) — ` +
        `opencode itself cannot read it either. Fix the file, or add the entry by hand:\n${snippet ?? ''}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${configPath} is valid JSONC but not an object — fix the file and re-run.`);
  }
  return parsed as Record<string, unknown>;
}

// ── Ownership fingerprint ───────────────────────────────────────────────────

function isGbrainShapedCommand(command: unknown): boolean {
  if (!Array.isArray(command) || command.length === 0) return false;
  const head = command[0];
  if (typeof head !== 'string') return false;
  if (head === 'gbrain') return true; // PATH-resolved (project scope)
  if (/[\\/]gbrain$/.test(head)) return true; // absolute binary path
  // bun-run wrapper shim lane: `bun run <...>/src/cli.ts` / a *.ts cli path.
  if (head === 'bun' || head.endsWith('/bun')) {
    return command.some((a) => typeof a === 'string' && /gbrain|src[\\/]cli\.ts$/.test(a));
  }
  // staged shim named gbrain-<suffix> (e.g. gbrain-shim from stageBinDir) —
  // hyphen-anchored so a foreign /opt/bin/gbrainy is NOT ours.
  return /[\\/]gbrain-[^\\/]*$/.test(head);
}

/**
 * Classify the `mcp.<name>` entry in parsed config. The arbiter every lane
 * consults before writing or removing (codexBlockOwnsName analog).
 */
export function opencodeEntryKind(
  parsed: Record<string, unknown>,
  name: string,
  expect: OpencodeEntryExpectation = {},
): OpencodeEntryKind {
  const mcp = parsed.mcp;
  if (typeof mcp !== 'object' || mcp === null) return 'absent';
  const entry = (mcp as Record<string, unknown>)[name];
  if (entry === undefined) return 'absent';
  if (typeof entry !== 'object' || entry === null) return 'foreign';
  const e = entry as Record<string, unknown>;

  if (e.type === 'local') {
    if (!isGbrainShapedCommand(e.command)) return 'foreign';
    const env = e.environment;
    const src =
      typeof env === 'object' && env !== null
        ? (env as Record<string, unknown>).GBRAIN_SOURCE
        : undefined;
    if (typeof src !== 'string' || src === '') return 'foreign';
    if (expect.sourceId === undefined) return 'ours-same-source';
    return src === expect.sourceId ? 'ours-same-source' : 'ours-other-source';
  }

  if (e.type === 'remote') {
    if (expect.url !== undefined && e.url === expect.url) return 'ours-same-source';
    const headers = e.headers;
    const auth =
      typeof headers === 'object' && headers !== null
        ? (headers as Record<string, unknown>).Authorization
        : undefined;
    if (typeof auth === 'string' && auth.includes(ENV_INTERPOLATION)) {
      // Only the gbrain connect lane writes the {env:GBRAIN_REMOTE_TOKEN}
      // interpolation — unambiguously ours even without a receipt url.
      return expect.url === undefined ? 'ours-same-source' : 'ours-other-source';
    }
    return 'foreign';
  }

  return 'foreign';
}

// ── Rendering ───────────────────────────────────────────────────────────────

function entryValue(entry: OpencodeMcpEntry): Record<string, unknown> {
  if (entry.kind === 'local') {
    return {
      type: 'local',
      command: entry.command,
      environment: entry.environment,
      enabled: true,
    };
  }
  const token =
    entry.tokenMode === 'inline'
      ? `Bearer ${entry.bearerToken ?? ''}`
      : `Bearer ${ENV_INTERPOLATION}`;
  return {
    type: 'remote',
    url: entry.url,
    headers: { Authorization: token },
    enabled: true,
  };
}

/** Copy-pasteable snippet for the refusal paths (the user is never stranded). */
export function opencodeEntrySnippet(entry: OpencodeMcpEntry): string {
  return JSON.stringify({ mcp: { [entry.name]: entryValue(entry) } }, null, 2);
}

function assertEntryName(name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(
      `MCP server name "${name}" is not a simple key ([A-Za-z0-9_-]+) — pick a simpler --name`,
    );
  }
}

function entryCarriesSecret(entry: OpencodeMcpEntry): boolean {
  return entry.kind === 'remote' && entry.tokenMode === 'inline';
}

// No explicit eol: jsonc-parser detects and preserves the file's own EOLs
// (verified: a CRLF config keeps CRLF through modify/applyEdits).
const FORMATTING = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

// ── Write ───────────────────────────────────────────────────────────────────

/**
 * Idempotently write the managed `mcp.<name>` entry via a comment-preserving
 * surgical edit. Refuses foreign entries; replaces ours-same-source silently;
 * replaces ours-other-source only when `allowReplaceOtherSource` (callers
 * warn first). Validates the render before the atomic swap.
 */
export function writeOpencodeMcpEntry(
  configPath: string,
  entry: OpencodeMcpEntry,
  opts: { expect?: OpencodeEntryExpectation; allowReplaceOtherSource?: boolean } = {},
): WriteOpencodeEntryResult {
  assertEntryName(entry.name);
  if (entry.kind === 'remote' && entry.tokenMode === 'inline' && !entry.bearerToken) {
    throw new Error('inline token mode requires a bearerToken');
  }
  const notes: string[] = [];
  const snippet = opencodeEntrySnippet(entry);

  const { text, existed } = readConfigRaw(configPath);
  const parsed = parseOpencodeConfig(text, configPath, snippet);

  const priorKind = opencodeEntryKind(parsed, entry.name, opts.expect);
  if (priorKind === 'foreign') {
    throw new Error(
      `mcp.${entry.name} in ${configPath} is not a gbrain-managed entry — refusing to overwrite it. ` +
        `Remove it (or pick another --name) and re-run.`,
    );
  }
  if (priorKind === 'ours-other-source' && !opts.allowReplaceOtherSource) {
    throw new Error(
      `mcp.${entry.name} in ${configPath} belongs to a DIFFERENT gbrain workspace ` +
        `(GBRAIN_SOURCE mismatch) — re-run with the overwrite confirmation to reroute it, or pick another --name.`,
    );
  }
  if (priorKind === 'ours-other-source') {
    notes.push(`replaced a gbrain registration that pointed at a different workspace (source mismatch).`);
  }

  const baseText = text.trim() === '' ? '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' : text;
  const edits = modify(baseText, ['mcp', entry.name], entryValue(entry), FORMATTING);
  const nextText = applyEdits(baseText, edits);

  // Post-render validation: parse + deep-assert our entry + assert every
  // OTHER top-level key survives. Any failure leaves the original untouched.
  const rendered = parseOpencodeConfig(nextText, configPath, snippet);
  const renderedMcp = rendered.mcp as Record<string, unknown> | undefined;
  const ours = renderedMcp?.[entry.name];
  if (JSON.stringify(ours) !== JSON.stringify(entryValue(entry))) {
    throw new Error(
      `post-render validation failed: mcp.${entry.name} did not round-trip — original file left untouched.`,
    );
  }
  for (const key of Object.keys(parsed)) {
    if (key === 'mcp') continue;
    if (JSON.stringify(rendered[key]) !== JSON.stringify(parsed[key])) {
      throw new Error(
        `post-render validation failed: top-level key "${key}" changed — original file left untouched.`,
      );
    }
  }
  if (typeof parsed.mcp === 'object' && parsed.mcp !== null) {
    for (const key of Object.keys(parsed.mcp as Record<string, unknown>)) {
      if (key === entry.name) continue;
      const before = (parsed.mcp as Record<string, unknown>)[key];
      const after = renderedMcp?.[key];
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Error(
          `post-render validation failed: mcp.${key} (not ours) changed — original file left untouched.`,
        );
      }
    }
  }

  const secret = entryCarriesSecret(entry);
  let backupPath: string | null = null;
  if (existed) {
    backupPath = `${configPath}.bak`;
    copyFileSync(configPath, backupPath);
    if (secret) chmodSync(backupPath, 0o600); // re-runs: .bak carries the previous token
  }
  atomicWriteTextFile(configPath, nextText, secret ? { forceMode: 0o600 } : { freshMode: 0o644 });
  if (secret && existed) {
    notes.push(`${configPath} tightened to 0600 — it now carries a bearer token.`);
  }

  return {
    configPath,
    replacedPrior: priorKind !== 'absent',
    priorKind,
    backupPath,
    notes,
  };
}

// ── Remove ──────────────────────────────────────────────────────────────────

/**
 * Remove the managed entry (fingerprint-keyed; everything else survives
 * byte-for-byte). Absent file / absent entry are calm no-ops. Foreign
 * entries refuse — removal never deletes what gbrain does not own.
 */
export function removeOpencodeMcpEntry(
  configPath: string,
  name: string,
  expect: OpencodeEntryExpectation = {},
): RemoveOpencodeEntryResult {
  assertEntryName(name);
  const notes: string[] = [];
  if (!existsSync(configPath)) {
    return { configPath, removed: false, backupPath: null, notes: ['no opencode config — nothing to remove'] };
  }
  const { text } = readConfigRaw(configPath);
  const parsed = parseOpencodeConfig(text, configPath);

  const kind = opencodeEntryKind(parsed, name, expect);
  if (kind === 'absent') {
    return { configPath, removed: false, backupPath: null, notes: ['no gbrain-managed entry — nothing to remove'] };
  }
  if (kind === 'foreign') {
    throw new Error(
      `mcp.${name} in ${configPath} is not a gbrain-managed entry — refusing to remove it.`,
    );
  }
  if (kind === 'ours-other-source') {
    notes.push('removed a gbrain registration that pointed at a different workspace (source mismatch).');
  }

  const edits = modify(text, ['mcp', name], undefined, FORMATTING);
  const nextText = applyEdits(text, edits);
  parseOpencodeConfig(nextText, configPath); // never leave opencode unreadable

  const backupPath = `${configPath}.bak`;
  copyFileSync(configPath, backupPath);
  atomicWriteTextFile(configPath, nextText);
  return { configPath, removed: true, backupPath, notes };
}

/**
 * True when `mcp.<name>` exists as a REMOTE-type entry (regardless of
 * ownership). The workspace stdio lane consults this before writing a local
 * entry into the user-global config: a remote entry under our name is either
 * the harness lane's (bootstrap harness) or foreign — either way the stdio
 * lane must not fight it (the codexBlockOwnsName analog, #4043 ownership
 * rule). Best-effort: unreadable/unparseable configs return false (the write
 * path re-checks with full refusal semantics).
 */
export function opencodeRemoteEntryExists(configPath: string, name: string): boolean {
  try {
    const { text, existed } = readConfigRaw(configPath);
    if (!existed) return false;
    const parsed = parseOpencodeConfig(text, configPath);
    const mcp = parsed.mcp;
    if (typeof mcp !== 'object' || mcp === null) return false;
    const entry = (mcp as Record<string, unknown>)[name];
    return typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).type === 'remote';
  } catch {
    return false;
  }
}

// ── Status/recovery helpers ─────────────────────────────────────────────────

/**
 * Recover the inline bearer from OUR remote entry (harness `--status` token
 * liveness — the receipt never stores the token). Returns null when the file
 * or entry is absent, foreign, env-mode, or unreadable as JSONC.
 */
export function parseOpencodeEntryBearer(configPath: string, name: string, expectUrl?: string): string | null {
  try {
    const { text, existed } = readConfigRaw(configPath);
    if (!existed) return null;
    const parsed = parseOpencodeConfig(text, configPath);
    const kind = opencodeEntryKind(parsed, name, { url: expectUrl });
    if (kind !== 'ours-same-source') return null;
    const entry = (parsed.mcp as Record<string, unknown>)[name] as Record<string, unknown>;
    if (entry.type !== 'remote') return null;
    const auth = (entry.headers as Record<string, unknown> | undefined)?.Authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
    const token = auth.slice('Bearer '.length);
    if (token.includes('{env:')) return null; // env-interpolated — no inline token to recover
    return token || null;
  } catch {
    return null;
  }
}
