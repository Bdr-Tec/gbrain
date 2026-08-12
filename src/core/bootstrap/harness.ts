/**
 * harness.ts — `gbrain bootstrap harness` (#4043): default brain wiring for
 * agent-framework-driven coding (a downstream framework spawning Claude Code
 * `claude -p` / codex exec on a box that already hosts a brain + a running
 * `gbrain serve --http`).
 *
 * What it wires, per harness:
 * - Claude Code: user-scope HTTP MCP registration (`claude mcp add --scope
 *   user -t http … -H "Authorization: Bearer …"`), `mcp__<name>` into
 *   user-scope permissions.allow (headless pre-approval), and the lifecycle
 *   hooks (user scope by default, or per --project dir) — NO agent.json
 *   required anywhere.
 * - Codex: one managed `[mcp_servers.<name>]` TOML block with the inline
 *   bearer token (codex-toml.ts — `codex mcp add` cannot express it).
 *
 * Contracts folded from the CEO review + outside voice (letters reference the
 * plan file):
 * - [C7] Mint-first rotation: mint → wire → smoke → only then revoke the
 *   PREVIOUS receipt's token BY ID. A wiring failure leaves the old token
 *   fully working; revoke-by-name never happens.
 * - [F1] Write-ahead receipt: harness.json persists at mint time with every
 *   planned target `pending`, flipping per-target as wiring lands — a crash
 *   at any step leaves a receipt --remove can consume.
 * - [C8] Ownership: an existing registration pointing at a DIFFERENT url is
 *   another brain's wiring — refuse without --force; --remove verifies url
 *   match before removing and skips (with a note) otherwise.
 * - [C6] User-scope and --project hook wiring are mutually exclusive; the
 *   writers additionally refuse same-file different-marker double-wiring.
 * - [C5] Session-transcript capture is its own consent item; --no-capture
 *   wires the context events only (SessionStart/UserPromptSubmit/PreCompact).
 * - [F3] Non-loopback --url is refused unless --token supplies the remote
 *   credential (remote brains are `gbrain connect`'s charter).
 * - [F7] Version-skew honesty: a serve older than the CLI verifies scoped
 *   tokens through pre-scopes code (full access) until restarted — say so.
 * - [C9] --remove is engine-free-first: host removals always run; the token
 *   revoke defers with a typed message under a live PGLite serve.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { VERSION } from '../../version.ts';
import { loadConfig, toEngineConfig } from '../config.ts';
import { createEngine } from '../engine-factory.ts';
import { probeBrainIdentity, type ConnectProbeResult } from '../connect-probe.ts';
import {
  buildClaudeMcpAddArgv,
  isLoopbackHostname,
  isValidName,
  normalizeMcpUrl,
  redactToken,
  validateToken,
} from '../mcp-registration.ts';
import { mintLegacyToken, revokeLegacyTokenById, type MintedLegacyToken } from '../token-mint.ts';
import { sqlQueryForEngine } from '../sql-query.ts';
import { BootstrapError } from './lock.ts';
import { probeLivePgliteHolder } from './uninstall.ts';
import type { ExecRunner } from './repo.ts';
import {
  deleteHarnessReceipt,
  guardHarnessReceiptOverwrite,
  harnessReceiptPath,
  readHarnessReceiptState,
  writeHarnessReceipt,
  type HarnessReceipt,
  type HarnessTarget,
} from './format.ts';
import {
  removeCodexHttpServerBlock,
  writeCodexHttpServerBlock,
} from './codex-toml.ts';
import {
  addPermissionsAllowEntry,
  claudeSettingsPath,
  removeClaudeHooksAt,
  removePermissionsAllowEntry,
  writeClaudeHooksAt,
  type ClaudeHookEnv,
} from './hooks.ts';
import {
  CLAUDE_HOOK_EVENTS,
  GBRAIN_HARNESS_MARKER_VALUE,
  claudeUserSettingsPath,
  codexConfigPath,
  mcpPermissionEntry,
  type ClaudeHookEvent,
} from './host-specs.ts';

// ── Flags ───────────────────────────────────────────────────────────────────

export type HarnessSelector = 'claude-code' | 'codex' | 'all';

export interface HarnessFlags {
  harness: HarnessSelector;
  url?: string;
  port?: number;
  source?: string;
  tokenName: string;
  token?: string;
  name: string;
  projects: string[];
  noHooks: boolean;
  noCapture: boolean;
  force: boolean;
  remove: boolean;
  status: boolean;
  yes: boolean;
  json: boolean;
  gbrainBin?: string;
  error?: string;
}

/** Pure flag parser (unit-tested). `--local` is a documented no-op alias. */
export function parseHarnessArgs(rest: string[]): HarnessFlags {
  const out: HarnessFlags = {
    harness: 'all',
    tokenName: 'bootstrap-harness',
    name: 'gbrain',
    projects: [],
    noHooks: false,
    noCapture: false,
    force: false,
    remove: false,
    status: false,
    yes: false,
    json: false,
  };
  const value = (flag: string): string | undefined => {
    const i = rest.indexOf(flag);
    if (i < 0) return undefined;
    const v = rest[i + 1];
    return v !== undefined && !v.startsWith('--') ? v : undefined;
  };
  const h = value('--harness');
  if (h !== undefined) {
    if (h !== 'claude-code' && h !== 'codex' && h !== 'all') {
      out.error = `unknown --harness '${h}' — pass claude-code, codex, or all`;
      return out;
    }
    out.harness = h;
  }
  const url = value('--url');
  if (url !== undefined) out.url = url;
  const port = value('--port');
  if (port !== undefined) {
    const n = Number(port);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
      out.error = `invalid --port '${port}'`;
      return out;
    }
    out.port = n;
  }
  const source = value('--source');
  if (source !== undefined) out.source = source;
  out.tokenName = value('--token-name') ?? out.tokenName;
  const token = value('--token');
  if (token !== undefined) out.token = token;
  const name = value('--name');
  if (name !== undefined) {
    if (!isValidName(name)) {
      out.error = `invalid --name '${name}' (lowercase identifier)`;
      return out;
    }
    out.name = name;
  }
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--project' && rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) {
      out.projects.push(resolve(rest[i + 1]));
    }
  }
  out.noHooks = rest.includes('--no-hooks');
  out.noCapture = rest.includes('--no-capture');
  out.force = rest.includes('--force');
  out.remove = rest.includes('--remove');
  out.status = rest.includes('--status');
  out.yes = rest.includes('--yes');
  out.json = rest.includes('--json');
  const bin = value('--gbrain-bin');
  if (bin !== undefined) out.gbrainBin = bin;
  // --user-hooks and --local are accepted, documented no-ops (script clarity).
  return out;
}

// ── Deps (injectable for the serial suite) ──────────────────────────────────

export interface ServeHealth {
  ok: boolean;
  engine?: string;
  version?: string;
  detail?: string;
}

export interface HarnessDeps {
  runner: ExecRunner;
  gbrainHome: string;
  isTTY?: boolean;
  prompt?: (q: string) => Promise<string>;
  fetchFn?: typeof fetch;
  probeIdentity?: (url: string, token: string) => Promise<ConnectProbeResult>;
  /** Resolved user-scope settings path (tests point at a temp HOME). */
  userSettingsPath?: string;
  /** Resolved codex config path (tests point at a temp CODEX_HOME). */
  codexConfig?: string;
  /** Engine-backed mint; tests inject a fake. */
  mint?: (opts: {
    name: string;
    scopes: string[];
    sourceGrant?: string[];
  }) => Promise<MintedLegacyToken>;
  revokeById?: (id: string) => Promise<boolean>;
  /** Live-PGLite-serve pre-probe for the revoke lane [C9]. */
  pgliteLiveServe?: () => boolean;
  detectClaude?: () => boolean;
  detectCodex?: () => boolean;
  gbrainBin?: string | null;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

function resolveDeps(deps: HarnessDeps): Required<Omit<HarnessDeps, 'gbrainBin'>> & { gbrainBin: string | null } {
  return {
    runner: deps.runner,
    gbrainHome: deps.gbrainHome,
    isTTY: deps.isTTY ?? process.stdout.isTTY === true,
    prompt: deps.prompt ?? (async () => 'n'),
    fetchFn: deps.fetchFn ?? fetch,
    probeIdentity: deps.probeIdentity ?? ((url, token) => probeBrainIdentity(url, token)),
    userSettingsPath: deps.userSettingsPath ?? claudeUserSettingsPath(),
    codexConfig: deps.codexConfig ?? codexConfigPath(),
    mint: deps.mint ?? defaultMint,
    revokeById: deps.revokeById ?? defaultRevokeById,
    pgliteLiveServe: deps.pgliteLiveServe ?? defaultPgliteLiveServe,
    detectClaude: deps.detectClaude ?? (() => whichSafe('claude') !== null),
    detectCodex:
      deps.detectCodex ??
      (() => whichSafe('codex') !== null || existsSync(deps.codexConfig ?? codexConfigPath())),
    gbrainBin: deps.gbrainBin !== undefined ? deps.gbrainBin : null,
    log: deps.log ?? ((l) => console.log(l)),
    logError: deps.logError ?? ((l) => console.error(l)),
  };
}

function whichSafe(bin: string): string | null {
  try {
    return Bun.which(bin);
  } catch {
    return null;
  }
}

/** Production mint: open the configured engine just long enough to insert. */
async function defaultMint(opts: { name: string; scopes: string[]; sourceGrant?: string[] }): Promise<MintedLegacyToken> {
  const cfg = loadConfig();
  if (!cfg) {
    throw new Error('no brain configured — run `gbrain init` first (the harness wires an EXISTING brain).');
  }
  const engineConfig = toEngineConfig(cfg);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  try {
    let sourceGrant = opts.sourceGrant;
    if (!sourceGrant) {
      // [C2] Mirror the stdio lane's federation: no explicit --source →
      // reads span the federated=true sources, write floor 'default'.
      try {
        const { localFederatedSourceIds } = await import('../source-resolver.ts');
        sourceGrant = await localFederatedSourceIds(engine, 'default', 'seed_default');
      } catch {
        sourceGrant = undefined; // historical default floor
      }
    }
    return await mintLegacyToken(engine, {
      name: opts.name,
      takesHolders: ['world'],
      scopes: opts.scopes,
      ...(sourceGrant && sourceGrant.length > 0 ? { sourceGrant } : {}),
    });
  } finally {
    await engine.disconnect();
  }
}

async function defaultRevokeById(id: string): Promise<boolean> {
  const cfg = loadConfig();
  if (!cfg) throw new Error('no brain configured');
  const engineConfig = toEngineConfig(cfg);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  try {
    return await revokeLegacyTokenById(sqlQueryForEngine(engine), id);
  } finally {
    await engine.disconnect();
  }
}

/** A live PGLite serve holds the single-writer lock — engine opens will fail. */
function defaultPgliteLiveServe(): boolean {
  const cfg = loadConfig();
  if (!cfg?.database_path) return false;
  return probeLivePgliteHolder(cfg.database_path) !== null;
}

// ── Serve probe ─────────────────────────────────────────────────────────────

export async function probeServeHealth(
  mcpUrl: string,
  fetchFn: typeof fetch,
  timeoutMs = 3000,
): Promise<ServeHealth> {
  const base = mcpUrl.replace(/\/mcp$/, '');
  try {
    const res = await fetchFn(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, detail: `GET ${base}/health → ${res.status}` };
    const body = (await res.json()) as { status?: string; version?: string; engine?: string };
    if (body.status !== 'ok') return { ok: false, detail: `health status: ${body.status ?? 'unknown'}` };
    return { ok: true, version: body.version, engine: body.engine };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

// ── Consent copy [C5 / #4029 register] ──────────────────────────────────────

export function buildConsentBlock(p: {
  tokenName: string;
  tokenSupplied: boolean;
  scopes: string[];
  url: string;
  wireClaude: boolean;
  wireCodex: boolean;
  hooks: boolean;
  capture: boolean;
  hookScope: string;
  name: string;
  userSettingsPath: string;
  codexConfig: string;
}): string {
  const lines: string[] = [
    'gbrain bootstrap harness — wire framework-spawned coding sessions to this brain',
    '',
    'Will do, on this machine:',
  ];
  let n = 1;
  lines.push(
    p.tokenSupplied
      ? `  ${n++}. Use the supplied bearer token (never stored; not revoked by --remove).`
      : `  ${n++}. Mint bearer token '${p.tokenName}' (scopes: ${p.scopes.join('+')}; sees takes marked 'world'; ` +
          `reads span this brain's federated sources). Any prior harness token is revoked ` +
          `only after the new one is wired and verified.`,
  );
  if (p.wireClaude) {
    lines.push(
      `  ${n++}. Claude Code (user scope): register MCP server '${p.name}' -> ${p.url}, and ` +
        `pre-approve its tools for headless runs (permissions.allow entry 'mcp__${p.name}' in ${p.userSettingsPath}).`,
    );
    if (p.hooks) {
      lines.push(
        `  ${n++}. Wire the five lifecycle hooks (SessionStart/UserPromptSubmit/Stop/SessionEnd/PreCompact) in ${p.hookScope}.`,
      );
      lines.push(
        p.capture
          ? `  ${n++}. Session-transcript capture: every Claude Code session's transcript on this machine is ` +
              `secret-scanned and captured into the brain's corpus (Stop/SessionEnd hooks). Opt out of just ` +
              `this with the no-capture flag.`
          : `  ${n++}. Session-transcript capture: OFF (no-capture) — context injection only.`,
      );
    }
  }
  if (p.wireCodex) {
    lines.push(
      `  ${n++}. Codex (user-global): write [mcp_servers.${p.name}] with the bearer token INLINE into ` +
        `${p.codexConfig} (0600) — framework-spawned codex inherits no shell env, so an env-var token would not reach it.`,
    );
  }
  lines.push(
    '',
    'Reach, plainly: EVERY Claude Code and Codex session on this machine — any repo, any',
    'framework-spawned agent — can read AND write this brain through these tools.',
    'Hooks run in every Claude Code session; auto-commit/push lanes stay inert outside',
    'gbrain agent workspaces. Off-ramps: GBRAIN_HOOKS=0 (runtime),',
    '`gbrain bootstrap harness --remove`, `gbrain auth revoke --id <id>` (see auth list),',
    `\`claude mcp remove ${p.name} --scope user\` / edit the codex config.`,
  );
  return lines.join('\n');
}

// ── Apply ───────────────────────────────────────────────────────────────────

interface ClaudeMcpGetInfo {
  found: boolean;
  url?: string;
}

/** Parse `claude mcp get <name>` output for the registered URL (redact-safe). */
export function parseClaudeMcpGetUrl(out: string): ClaudeMcpGetInfo {
  const m = out.match(/^\s*URL:\s*(\S+)\s*$/m);
  if (!m) return { found: /Scope:|Type:/.test(out) };
  return { found: true, url: m[1] };
}

export async function applyHarness(flags: HarnessFlags, rawDeps: HarnessDeps): Promise<number> {
  const d = resolveDeps(rawDeps);

  // 1. Validate inputs + detect harnesses.
  for (const dir of flags.projects) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      d.logError(`--project directory does not exist: ${dir}`);
      return 2;
    }
  }
  if (flags.token !== undefined) {
    const v = validateToken(flags.token);
    if (!v.ok) {
      d.logError(`--token: ${v.error}`);
      return 2;
    }
  }
  const wireClaude = (flags.harness === 'all' || flags.harness === 'claude-code') && d.detectClaude();
  const wireCodex = (flags.harness === 'all' || flags.harness === 'codex') && d.detectCodex();
  if (flags.harness === 'claude-code' && !wireClaude) {
    d.logError('claude CLI not found on PATH — the user-scope MCP registration needs it (it owns ~/.claude.json).');
    return 2;
  }
  if (flags.harness === 'codex' && !wireCodex) {
    d.logError('codex not detected (no codex binary on PATH and no codex config dir) — nothing to wire.');
    return 2;
  }
  if (!wireClaude && !wireCodex) {
    d.logError(
      'no harness detected on this box (claude CLI not on PATH; no codex install) — ' +
        'pass --harness claude-code|codex explicitly if detection is wrong.',
    );
    return 2;
  }

  // 2. Serve health + loopback guard [F3].
  const norm = normalizeMcpUrl(flags.url ?? `http://127.0.0.1:${flags.port ?? 3131}/mcp`);
  if (!norm.ok) {
    d.logError(norm.error);
    return 2;
  }
  const url = norm.url;
  const hostname = new URL(url).hostname;
  if (flags.url !== undefined && !isLoopbackHostname(hostname) && flags.token === undefined) {
    d.logError(
      `--url points at a non-loopback host (${hostname}) but the token would be minted in the LOCAL brain — ` +
        'those are different databases. For a remote brain use `gbrain connect --install`; ' +
        'to use harness mode as a pure registrar for a LAN serve, pass --token <bearer> from that brain.',
    );
    return 2;
  }
  const health = await probeServeHealth(url, d.fetchFn);
  if (!health.ok) {
    d.logError(
      `no healthy gbrain serve at ${url} (${health.detail ?? 'unreachable'}) — ` +
        'start `gbrain serve --http` on this box first (or pass --url/--port).',
    );
    return 1;
  }

  // 3. Consent (connect --install shape; never the interview/A8 ledger).
  const hookScope = flags.projects.length > 0 ? `${flags.projects.length} project dir(s)` : 'user scope';
  const consent = buildConsentBlock({
    tokenName: flags.tokenName,
    tokenSupplied: flags.token !== undefined,
    scopes: ['read', 'write'],
    url,
    wireClaude,
    wireCodex,
    hooks: wireClaude && !flags.noHooks,
    capture: !flags.noCapture,
    hookScope,
    name: flags.name,
    userSettingsPath: d.userSettingsPath,
    codexConfig: d.codexConfig,
  });
  d.log(consent);
  if (!flags.yes) {
    if (!d.isTTY) {
      d.logError('\nnon-interactive shell: pass --yes to confirm the wiring above.');
      return 2;
    }
    const answer = (await d.prompt('\nProceed? (y/N) ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      d.log('aborted — nothing written.');
      return 1;
    }
  }

  // Prior receipt: carries the previous minted token for post-wire rotation
  // [C7], and the prior hook-scope for the user-XOR-project exclusivity check
  // [C6].
  const priorState = readHarnessReceiptState(d.gbrainHome);
  const prior = priorState.state === 'ok' ? priorState.receipt : null;
  if (prior) {
    const priorProjectHooks = prior.targets.some(
      (t) => t.kind === 'hooks' && t.scope !== 'user' && t.state !== 'failed',
    );
    const priorUserHooks = prior.targets.some(
      (t) => t.kind === 'hooks' && t.scope === 'user' && t.state !== 'failed',
    );
    if (flags.projects.length > 0 && priorUserHooks) {
      d.logError(
        'this box already carries USER-scope harness hooks; --project would double-fire every event ' +
          '(Claude Code merges the scopes). Run `gbrain bootstrap harness --remove` first, then re-apply with --project.',
      );
      return 2;
    }
    if (flags.projects.length === 0 && !flags.noHooks && priorProjectHooks) {
      d.logError(
        'this box already carries PROJECT-scope harness hooks; user-scope wiring would double-fire every event. ' +
          'Run `gbrain bootstrap harness --remove` first, or re-apply with the same --project list.',
      );
      return 2;
    }
  }

  // 4. Token — mint-first, no revocation yet [C7].
  let token: string;
  let tokenRecord: HarnessReceipt['token'];
  if (flags.token !== undefined) {
    token = flags.token;
    tokenRecord = { name: flags.tokenName, minted: false };
  } else {
    let minted: MintedLegacyToken;
    try {
      minted = await d.mint({ name: flags.tokenName, scopes: ['read', 'write'] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/already open through `gbrain serve`|LiveServeLockError/i.test(msg) || d.pgliteLiveServe()) {
        throw new BootstrapError(
          'LIVE_SERVE',
          'a live `gbrain serve` holds this PGLite brain, so the harness cannot mint a token — either ' +
            'pre-mint one while the serve is stopped (`gbrain auth create bootstrap-harness --scopes read,write`) ' +
            'and re-run with --token <value>, or stop the serve, re-run this command, and restart it. ' +
            '(Postgres brains mint fine while the serve runs.)',
        );
      }
      throw e;
    }
    token = minted.token;
    tokenRecord = {
      name: minted.name,
      id: minted.id,
      minted: true,
      ...(prior?.token.minted && prior.token.id ? { previous_id: prior.token.id } : {}),
    };
  }

  // 4b. Write-ahead receipt [F1]: all planned targets pending.
  const guard = guardHarnessReceiptOverwrite(d.gbrainHome);
  if (guard.brokenBackupPath) {
    d.logError(`WARNING: the harness receipt was unreadable; backed it up to ${guard.brokenBackupPath}.`);
  }
  const targets: HarnessTarget[] = [];
  if (wireClaude) {
    targets.push({ host: 'claude-code', kind: 'mcp', state: 'pending', scope: 'user', name: flags.name, mechanism: 'claude-cli' });
    targets.push({
      host: 'claude-code',
      kind: 'permission',
      state: 'pending',
      scope: 'user',
      path: d.userSettingsPath,
      entry: mcpPermissionEntry(flags.name),
    });
    if (!flags.noHooks) {
      if (flags.projects.length > 0) {
        for (const dir of flags.projects) {
          targets.push({
            host: 'claude-code',
            kind: 'hooks',
            state: 'pending',
            scope: dir,
            path: claudeSettingsPath(dir),
            marker: GBRAIN_HARNESS_MARKER_VALUE,
          });
        }
      } else {
        targets.push({
          host: 'claude-code',
          kind: 'hooks',
          state: 'pending',
          scope: 'user',
          path: d.userSettingsPath,
          marker: GBRAIN_HARNESS_MARKER_VALUE,
        });
      }
    }
  }
  if (wireCodex) {
    targets.push({
      host: 'codex',
      kind: 'mcp',
      state: 'pending',
      scope: 'user',
      path: d.codexConfig,
      name: flags.name,
      mechanism: 'toml-block',
    });
  }
  const receipt: HarnessReceipt = {
    harness_receipt_version: 1,
    created_at: new Date().toISOString(),
    created_by: `gbrain@${VERSION}`,
    url,
    ...(health.engine ? { engine: health.engine } : {}),
    ...(health.version ? { serve_version: health.version } : {}),
    source_id: flags.source ?? 'default',
    token: tokenRecord,
    targets,
  };
  writeHarnessReceipt(d.gbrainHome, receipt);
  const save = () => writeHarnessReceipt(d.gbrainHome, receipt);

  const confirm = (t: HarnessTarget) => {
    t.state = 'confirmed';
    save();
  };
  const failTarget = (t: HarnessTarget, err: string) => {
    t.state = 'failed';
    t.error = err;
    save();
    d.logError(`FAILED (${t.host}/${t.kind}${t.scope !== 'user' ? ` ${t.scope}` : ''}): ${err}`);
  };

  // 5. Claude Code wiring.
  const hookEvents: ClaudeHookEvent[] = flags.noCapture
    ? ([...CLAUDE_HOOK_EVENTS].filter((e) => e !== 'Stop' && e !== 'SessionEnd') as ClaudeHookEvent[])
    : [...CLAUDE_HOOK_EVENTS];
  for (const t of targets) {
    if (t.host !== 'claude-code') continue;
    try {
      if (t.kind === 'mcp') {
        // [C8] Ownership: an existing registration at a DIFFERENT url is
        // another brain's wiring.
        const get = await d.runner(['claude', 'mcp', 'get', flags.name]);
        if (get.code === 0) {
          const info = parseClaudeMcpGetUrl(`${get.stdout}\n${get.stderr}`);
          if (info.found && info.url && info.url !== url && !flags.force) {
            failTarget(
              t,
              `an existing '${flags.name}' registration points at ${info.url}, not ${url} — ` +
                'another brain owns it; pass --force to replace, or --name <other>.',
            );
            continue;
          }
          if (info.found) {
            await d.runner(['claude', 'mcp', 'remove', flags.name, '--scope', 'user']);
          }
        }
        const add = await d.runner([
          'claude',
          ...buildClaudeMcpAddArgv({ name: flags.name, url, headerToken: token, scope: 'user' }),
        ]);
        if (add.code !== 0) {
          failTarget(t, redactToken(add.stderr.trim() || `exit ${add.code}`, token));
          continue;
        }
        confirm(t);
        d.log(`MCP registered with Claude Code (user scope) -> ${url}`);
      } else if (t.kind === 'permission') {
        const r = addPermissionsAllowEntry(t.path!, t.entry!);
        for (const note of r.notes) d.logError(note);
        confirm(t);
        d.log(`headless pre-approval: '${t.entry}' in permissions.allow (${t.path})`);
      } else {
        const settingsPath = t.scope === 'user' ? d.userSettingsPath : t.path!;
        const env: ClaudeHookEnv = {
          GBRAIN_SOURCE: flags.source ?? 'default',
          GBRAIN_HOOK_LANE: 'harness',
        };
        const bin = flags.gbrainBin ?? d.gbrainBin;
        if (!bin) {
          failTarget(t, 'cannot resolve an absolute gbrain binary path — pass --gbrain-bin <abs path>');
          continue;
        }
        const r = writeClaudeHooksAt(settingsPath, {
          gbrainBin: bin,
          env,
          events: hookEvents,
          marker: GBRAIN_HARNESS_MARKER_VALUE,
          onBrokenJson: t.scope === 'user' ? 'abort' : 'relocate',
          backupStrategy: 'timestamped',
          refuseOnForeignGbrainMarker: true,
        });
        for (const note of r.notes) d.logError(note);
        confirm(t);
        d.log(
          `hooks wired (${r.installed.length} event(s)${flags.noCapture ? ', capture off' : ''}) in ${r.settingsPath}`,
        );
      }
    } catch (e) {
      failTarget(t, e instanceof Error ? e.message : String(e));
    }
  }

  // 6. Codex wiring — the managed TOML block is the single write mechanism.
  for (const t of targets) {
    if (t.host !== 'codex') continue;
    try {
      const r = writeCodexHttpServerBlock(t.path!, { name: flags.name, url, bearerToken: token });
      for (const note of r.notes) d.logError(note);
      confirm(t);
      d.log(
        `Codex wired: [mcp_servers.${flags.name}] with inline bearer token in ${t.path} (0600). ` +
          'Codex has a hook system as of 0.147.0, but gbrain does not wire codex hooks yet — ' +
          'per-turn context on codex is MCP tools + the pull protocol.',
      );
    } catch (e) {
      failTarget(t, e instanceof Error ? e.message : String(e));
    }
  }

  // 7. Smoke [C3-enriched message].
  const smoke = await d.probeIdentity(url, token);
  if (smoke.ok) {
    d.log(`smoke test: ${smoke.identity}`);
  } else {
    d.logError(
      redactToken(
        `smoke test FAILED (${smoke.reason}): ${smoke.message}` +
          (smoke.reason === 'auth' && flags.token === undefined
            ? ' — a fresh-minted token failing auth against a live loopback serve means the serve is NOT ' +
              'backed by this brain; check the serve process’s GBRAIN_HOME / DATABASE_URL.'
            : ''),
        token,
      ),
    );
  }

  // 8. Rotation completion [C7]: only after all targets confirmed + smoke ok.
  const allConfirmed = targets.every((t) => t.state === 'confirmed');
  if (allConfirmed && smoke.ok && receipt.token.previous_id) {
    try {
      const revoked = await d.revokeById(receipt.token.previous_id);
      d.log(
        revoked
          ? `previous harness token revoked (id ${receipt.token.previous_id}).`
          : `previous harness token was already revoked (id ${receipt.token.previous_id}).`,
      );
      delete receipt.token.previous_id;
      save();
    } catch (e) {
      d.logError(
        `could not revoke the previous harness token (${e instanceof Error ? e.message : String(e)}) — ` +
          `revoke it manually: gbrain auth revoke --id ${receipt.token.previous_id} (kept on the receipt).`,
      );
    }
  } else if (receipt.token.previous_id) {
    d.logError(
      'previous harness token NOT revoked (wiring incomplete or smoke failed) — old clients keep working; ' +
        're-run `gbrain bootstrap harness` to converge.',
    );
  }

  // 9. Degradation + skew honesty.
  if (health.engine === 'postgres') {
    d.log(
      '\nNote: this brain runs on Postgres — per-turn hook injection is degraded (no_pglite_path: the hook IPC ' +
        'socket is PGLite-only today). MCP tools are the active seam: sessions search/read/write the brain on ' +
        'demand; the hooks are pre-wired and light up when the engine-uniform listener lands (tracked in TODOS.md).',
    );
  }
  if (health.version && flags.token === undefined && isServeOlderThanScopes(health.version)) {
    d.log(
      `\nNote: serve v${health.version} predates token scoping — this token verifies as FULL-ACCESS until you ` +
        'restart `gbrain serve` on this binary version.',
    );
  }

  if (flags.json) {
    d.log(
      JSON.stringify(
        {
          schema_version: 1,
          url,
          engine: health.engine ?? null,
          serve_version: health.version ?? null,
          token_name: receipt.token.name,
          token_redacted: true,
          targets: receipt.targets,
          degraded_per_turn: health.engine === 'postgres',
          smoke_ok: smoke.ok,
          receipt_path: harnessReceiptPath(d.gbrainHome),
        },
        null,
        2,
      ),
    );
  }
  return allConfirmed && smoke.ok ? 0 : 1;
}

/** The scopes-honoring release: any serve older verifies scoped tokens as full access. */
export function isServeOlderThanScopes(serveVersion: string): boolean {
  // The feature ships in the SAME release as this code — compare against the
  // CLI's own version: an older serve is by definition pre-scopes.
  const parse = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(serveVersion);
  const b = parse(VERSION);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

// ── Remove [C9/F2/C8] ───────────────────────────────────────────────────────

export async function removeHarness(flags: HarnessFlags, rawDeps: HarnessDeps): Promise<number> {
  const d = resolveDeps(rawDeps);
  const state = readHarnessReceiptState(d.gbrainHome);
  if (state.state === 'absent') {
    d.log('nothing harness-installed on this machine (no harness receipt).');
    return 0;
  }
  if (state.state === 'newer') {
    d.logError('the harness receipt was written by a newer gbrain — upgrade gbrain before removing.');
    return 1;
  }
  if (state.state === 'invalid') {
    d.logError(
      `the harness receipt at ${harnessReceiptPath(d.gbrainHome)} is unreadable — fix or delete it, then ` +
        'remove any stragglers by hand (claude mcp remove / the codex config block / hook entries).',
    );
    return 1;
  }
  const receipt = state.receipt;
  const save = () => writeHarnessReceipt(d.gbrainHome, receipt);
  let anyFailed = false;

  // Phase 1 — host removals (engine-free).
  const remaining: HarnessTarget[] = [];
  for (const t of receipt.targets) {
    try {
      if (t.host === 'claude-code' && t.kind === 'mcp') {
        // [C8] Only remove what points at OUR url.
        const get = await d.runner(['claude', 'mcp', 'get', t.name ?? 'gbrain']);
        if (get.code !== 0 || !parseClaudeMcpGetUrl(`${get.stdout}\n${get.stderr}`).found) {
          d.log(`MCP '${t.name}' already gone — counted as removed.`); // [F2]
          continue;
        }
        const info = parseClaudeMcpGetUrl(`${get.stdout}\n${get.stderr}`);
        if (info.url && info.url !== receipt.url) {
          d.log(
            `MCP '${t.name}' now points at ${info.url} (not ours) — owned by another install; skipping, ` +
              'cleared from the receipt.',
          );
          continue;
        }
        const rm = await d.runner(['claude', 'mcp', 'remove', t.name ?? 'gbrain', '--scope', t.scope]);
        if (rm.code !== 0 && !/not found|No MCP server/i.test(rm.stdout + rm.stderr)) {
          throw new Error(rm.stderr.trim() || `exit ${rm.code}`);
        }
        d.log(`MCP '${t.name}' removed from Claude Code (${t.scope} scope).`);
      } else if (t.host === 'claude-code' && t.kind === 'permission') {
        const r = removePermissionsAllowEntry(t.path!, t.entry!);
        if (r.notes.some((n) => n.startsWith('WARNING'))) throw new Error(r.notes.join('; '));
        d.log(
          r.removed && r.removed > 0
            ? `permissions.allow entry '${t.entry}' removed.`
            : `permissions.allow entry '${t.entry}' already gone — counted as removed.`,
        );
      } else if (t.host === 'claude-code' && t.kind === 'hooks') {
        const settingsPath = t.scope === 'user' ? (t.path ?? d.userSettingsPath) : t.path!;
        const r = removeClaudeHooksAt(settingsPath, t.marker ?? GBRAIN_HARNESS_MARKER_VALUE);
        if (r.notes.some((n) => n.startsWith('WARNING'))) throw new Error(r.notes.join('; '));
        d.log(
          r.removed > 0
            ? `${r.removed} harness hook entr${r.removed === 1 ? 'y' : 'ies'} removed from ${settingsPath}.`
            : `no harness hook entries in ${settingsPath} — counted as removed.`,
        );
      } else if (t.host === 'codex') {
        const r = removeCodexHttpServerBlock(t.path ?? d.codexConfig, t.name ?? 'gbrain');
        d.log(
          r.removed
            ? `Codex managed block removed from ${t.path ?? d.codexConfig}.`
            : `no managed block in ${t.path ?? d.codexConfig} — counted as removed.`,
        );
      }
    } catch (e) {
      anyFailed = true;
      t.state = 'failed';
      t.error = e instanceof Error ? e.message : String(e);
      remaining.push(t);
      d.logError(`could not remove ${t.host}/${t.kind}: ${t.error}`);
    }
  }
  receipt.targets = remaining;
  save();

  // Phase 2 — revoke the minted token BY ID [C7]; deferred under a live
  // PGLite serve [C9].
  let tokenDone = !receipt.token.minted || !receipt.token.id;
  if (!tokenDone) {
    if (d.pgliteLiveServe()) {
      d.logError(
        'a live `gbrain serve` holds this PGLite brain — token NOT revoked. Host wiring is removed; ' +
          `stop the serve and re-run \`gbrain bootstrap harness --remove\`, or run ` +
          `\`gbrain auth revoke --id ${receipt.token.id}\`.`,
      );
    } else {
      try {
        await d.revokeById(receipt.token.id!);
        d.log(`harness token revoked (id ${receipt.token.id}).`);
        tokenDone = true;
      } catch (e) {
        d.logError(
          `token revoke failed (${e instanceof Error ? e.message : String(e)}) — ` +
            `run \`gbrain auth revoke --id ${receipt.token.id}\` manually.`,
        );
      }
    }
  } else if (!receipt.token.minted) {
    d.log('token was supplied via --token — not revoked (not ours to revoke).');
  }

  if (remaining.length === 0 && tokenDone) {
    deleteHarnessReceipt(d.gbrainHome);
    d.log('harness wiring fully removed; receipt consumed.');
    return 0;
  }
  save();
  d.logError('some removals are pending — the receipt keeps exactly the unfinished parts (re-run to retry).');
  return 1;
}

// ── Status (read-only; no lockstep with apply — probes the live truth) ─────

/** Parse the bearer token back out of `claude mcp get` output (live-verified
 * shape: `Authorization: Bearer <tok>` under a Headers: section). NEVER echo
 * the raw output anywhere — redactToken everything user-visible. */
export function parseClaudeMcpGetBearer(out: string): string | null {
  const m = out.match(/Authorization:\s*Bearer\s+(\S+)/);
  return m ? m[1] : null;
}

/** Parse the bearer token out of OUR managed codex block. */
export function parseCodexBlockBearer(configText: string): string | null {
  const norm = configText.replace(/\r\n/g, '\n');
  const begin = norm.indexOf(`# gbrain:${GBRAIN_HARNESS_MARKER_VALUE} begin`);
  const end = norm.indexOf(`# gbrain:${GBRAIN_HARNESS_MARKER_VALUE} end`);
  if (begin < 0 || end < 0 || end < begin) return null;
  const block = norm.slice(begin, end);
  const m = block.match(/^bearer_token\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/m);
  if (!m) return null;
  return m[1].replace(/\\(.)/g, '$1');
}

/** `bootstrap harness --status [--json]` — one screen of live health. */
export async function statusHarness(flags: HarnessFlags, rawDeps: HarnessDeps): Promise<number> {
  const d = resolveDeps(rawDeps);
  const state = readHarnessReceiptState(d.gbrainHome);
  if (state.state === 'absent') {
    if (flags.json) {
      d.log(JSON.stringify({ schema_version: 1, installed: false }, null, 2));
      return 2; // cron contract: absence is distinguishable under --json
    }
    d.log('no harness install on this machine (no harness receipt).');
    return 0;
  }
  if (state.state !== 'ok') {
    d.logError(`harness receipt unreadable (${state.state}) — see ${harnessReceiptPath(d.gbrainHome)}`);
    return 1;
  }
  const receipt = state.receipt;

  const health = await probeServeHealth(receipt.url, d.fetchFn);
  const serveLine = health.ok
    ? `serve: OK at ${receipt.url} (engine ${health.engine ?? '?'}, v${health.version ?? '?'})`
    : `serve: UNREACHABLE at ${receipt.url} (${health.detail ?? 'no response'})`;

  // Token liveness — the receipt stores no plaintext by design [F1]; recover
  // from the host registration or degrade honestly.
  let token: string | null = null;
  let tokenSource = '';
  const claudeMcp = receipt.targets.find((t) => t.host === 'claude-code' && t.kind === 'mcp');
  if (claudeMcp) {
    try {
      const get = await d.runner(['claude', 'mcp', 'get', claudeMcp.name ?? 'gbrain']);
      if (get.code === 0) {
        token = parseClaudeMcpGetBearer(`${get.stdout}\n${get.stderr}`);
        if (token) tokenSource = 'claude registration';
      }
    } catch {
      /* degrade */
    }
  }
  if (!token) {
    const codexMcp = receipt.targets.find((t) => t.host === 'codex' && t.kind === 'mcp');
    if (codexMcp?.path && existsSync(codexMcp.path)) {
      try {
        token = parseCodexBlockBearer(readFileSync(codexMcp.path, 'utf8'));
        if (token) tokenSource = 'codex config block';
      } catch {
        /* degrade */
      }
    }
  }

  let tokenLine: string;
  let tokenVerified: boolean | 'unavailable' = 'unavailable';
  if (!health.ok) {
    tokenLine = 'token: not verified (serve unreachable)';
  } else if (token) {
    const smoke = await d.probeIdentity(receipt.url, token);
    tokenVerified = smoke.ok;
    tokenLine = smoke.ok
      ? `token: OK ('${receipt.token.name}' via ${tokenSource} — ${smoke.identity})`
      : `token: FAILED (${smoke.reason}) — ${redactToken(smoke.message, token)}. ` +
        'Someone may have revoked it; re-run `gbrain bootstrap harness` to rotate.';
  } else {
    tokenLine = `token: verify unavailable (no registration to recover the bearer from) — honest degrade, not a failure.`;
  }

  const skew =
    health.ok && health.version && isServeOlderThanScopes(health.version)
      ? `serve v${health.version} predates token scoping — the token verifies as FULL-ACCESS until the serve restarts on this version.`
      : null;

  const degraded = (health.engine ?? receipt.engine) === 'postgres';

  if (flags.json) {
    d.log(
      JSON.stringify(
        {
          schema_version: 1,
          installed: true,
          url: receipt.url,
          serve_ok: health.ok,
          engine: health.engine ?? receipt.engine ?? null,
          serve_version: health.version ?? null,
          version_skew: skew !== null,
          token_name: receipt.token.name,
          token_verified: tokenVerified,
          degraded_per_turn: degraded,
          targets: receipt.targets,
          pending_previous_token: receipt.token.previous_id ?? null,
          receipt_path: harnessReceiptPath(d.gbrainHome),
        },
        null,
        2,
      ),
    );
  } else {
    d.log(serveLine);
    d.log(tokenLine);
    for (const t of receipt.targets) {
      d.log(`  ${t.host}/${t.kind} (${t.scope}): ${t.state}${t.error ? ` — ${t.error}` : ''}`);
    }
    if (receipt.token.previous_id) {
      d.log(`  pending: previous token ${receipt.token.previous_id} awaits revocation (re-run to converge).`);
    }
    if (degraded) {
      d.log('per-turn injection: degraded on Postgres (MCP tools are the active seam).');
    }
    if (skew) d.log(`note: ${skew}`);
  }
  return health.ok && tokenVerified !== false ? 0 : 1;
}

// ── Home preflight ──────────────────────────────────────────────────────────

/** Ensure the gbrain home exists before locking in it (the bootstrap lock's
 * missing-dir message says "workspace directory", which would mislead here). */
export function ensureHarnessHome(home: string): void {
  mkdirSync(join(home, 'bootstrap'), { recursive: true });
}

/** True when the codex config carries OUR managed block for `name` — the
 * stdio lane (runHooks) must not fight the harness lane for the same server
 * name (one owner per name; `codex mcp remove` drops comments). */
export function codexBlockOwnsName(configPath: string, name: string): boolean {
  if (!existsSync(configPath)) return false;
  try {
    const text = readFileSync(configPath, 'utf8').replace(/\r\n/g, '\n');
    if (!text.includes(`# gbrain:${GBRAIN_HARNESS_MARKER_VALUE} begin`)) return false;
    return text.includes(`[mcp_servers.${name}]`);
  } catch {
    return false;
  }
}
