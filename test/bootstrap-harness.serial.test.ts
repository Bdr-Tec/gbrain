/**
 * bootstrap-harness.serial.test.ts — `gbrain bootstrap harness` (#4043)
 * orchestration contracts, against applyHarness/removeHarness/statusHarness
 * with fully injected deps (no engine, no network, no real CLIs):
 *
 *  - consent gate: non-TTY without --yes refuses BEFORE any mutation
 *  - full apply: claude argv carries --scope user + bearer; codex wiring is
 *    the managed TOML block (codex CLI never execed); permissions.allow +
 *    five hooks with the harness lane env
 *  - write-ahead receipt [F1]: pending targets exist the moment minting
 *    completes; failures are per-target and --remove consumes the receipt
 *  - mint-first rotation [C7]: the previous token is revoked BY ID only
 *    after all targets confirm + smoke passes; a wiring failure leaves it
 *  - ownership [C8]: a foreign-url registration refuses without --force;
 *    --remove skips url-mismatched registrations with a note
 *  - user-XOR-project hooks [C6]; loopback guard [F3]; --project validation
 *    [F4]; --no-capture subset [C5]; version-skew note [F7]; idempotent
 *    not-found removals [F2]; PGLite live-serve revoke deferral [C9]
 *  - statusHarness: absent-receipt json exit contract, token recovery from
 *    the codex block, revoked-token failure, serve-down failure
 *
 * Serial: dispatcher-level cases set GBRAIN_HOME.
 */

import { describe, test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyHarness,
  buildConsentBlock,
  parseClaudeMcpGetBearer,
  parseClaudeMcpGetUrl,
  parseCodexBlockBearer,
  parseHarnessArgs,
  removeHarness,
  statusHarness,
  type HarnessDeps,
  type HarnessFlags,
} from '../src/core/bootstrap/harness.ts';
import { readHarnessReceiptState, harnessReceiptPath } from '../src/core/bootstrap/format.ts';
import {
  CLAUDE_HOOK_EVENTS,
  CODEX_TOML_BLOCK_BEGIN,
  GBRAIN_HARNESS_MARKER_VALUE,
} from '../src/core/bootstrap/host-specs.ts';
import type { ExecRunner } from '../src/core/bootstrap/repo.ts';
import type { ConnectProbeResult } from '../src/core/connect-probe.ts';
import { VERSION } from '../src/version.ts';

const TOKEN_A = `gbrain_${'a'.repeat(64)}`;
const TOKEN_B = `gbrain_${'b'.repeat(64)}`;
const ID_A = '11111111-1111-1111-1111-111111111111';
const ID_B = '22222222-2222-2222-2222-222222222222';
const URL = 'http://127.0.0.1:3131/mcp';

interface Fake {
  deps: HarnessDeps;
  calls: string[][];
  revoked: string[];
  mintCalls: Array<{ name: string; scopes: string[]; sourceGrant?: string[] }>;
  out: string[];
  err: string[];
  home: string;
  userSettings: string;
  codexConfig: string;
}

function makeFake(opts: {
  mcpGet?: (name: string) => { code: number; stdout: string; stderr: string };
  mcpAddCode?: number;
  health?: { ok: boolean; version?: string; engine?: string };
  probeOk?: boolean;
  mintQueue?: Array<{ token: string; id: string }>;
  pgliteLive?: boolean;
} = {}): Fake {
  const dir = mkdtempSync(join(tmpdir(), 'gb-harness-'));
  const home = join(dir, '.gbrain');
  mkdirSync(home, { recursive: true });
  const userSettings = join(dir, 'claude-settings.json');
  const codexConfig = join(dir, 'codex-config.toml');
  const calls: string[][] = [];
  const revoked: string[] = [];
  const mintCalls: Array<{ name: string; scopes: string[]; sourceGrant?: string[] }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const mintQueue = opts.mintQueue ?? [{ token: TOKEN_A, id: ID_A }, { token: TOKEN_B, id: ID_B }];
  let mintIdx = 0;
  const health = opts.health ?? { ok: true, version: VERSION, engine: 'postgres' };

  const runner: ExecRunner = async (argv: string[]) => {
    calls.push(argv);
    if (argv[0] === 'claude' && argv[2] === 'get') {
      return opts.mcpGet ? opts.mcpGet(argv[3]) : { code: 1, stdout: '', stderr: 'No MCP server found' };
    }
    if (argv[0] === 'claude' && argv[2] === 'add') {
      return { code: opts.mcpAddCode ?? 0, stdout: '', stderr: opts.mcpAddCode ? 'add failed' : '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  const deps: HarnessDeps = {
    runner,
    gbrainHome: home,
    isTTY: false,
    fetchFn: (async () => {
      if (!health.ok) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ status: 'ok', version: health.version, engine: health.engine }), {
        status: 200,
      });
    }) as unknown as typeof fetch,
    probeIdentity: async (): Promise<ConnectProbeResult> =>
      (opts.probeOk ?? true)
        ? { ok: true, identity: 'brain "test" (source default)' }
        : { ok: false, reason: 'auth', message: 'HTTP 401' },
    userSettingsPath: userSettings,
    codexConfig,
    mint: async (o) => {
      mintCalls.push(o as { name: string; scopes: string[]; sourceGrant?: string[] });
      const m = mintQueue[Math.min(mintIdx++, mintQueue.length - 1)];
      return { token: m.token, id: m.id, name: 'bootstrap-harness', scopes: ['read', 'write'] };
    },
    revokeById: async (id: string) => {
      revoked.push(id);
      return true;
    },
    pgliteLiveServe: () => opts.pgliteLive ?? false,
    detectClaude: () => true,
    detectCodex: () => true,
    gbrainBin: '/opt/fake/gbrain',
    log: (l) => out.push(l),
    logError: (l) => err.push(l),
  };
  return { deps, calls, revoked, mintCalls, out, err, home, userSettings, codexConfig };
}

function flags(extra: string[] = []): HarnessFlags {
  return parseHarnessArgs(['--yes', ...extra]);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('parseHarnessArgs', () => {
  test('defaults + aliases: --local and --user-hooks are accepted no-ops', () => {
    const f = parseHarnessArgs(['--local', '--user-hooks']);
    expect(f.error).toBeUndefined();
    expect(f.harness).toBe('all');
    expect(f.tokenName).toBe('bootstrap-harness');
    expect(f.name).toBe('gbrain');
  });
  test('unknown --harness refused; bad --port refused; bad --name refused', () => {
    expect(parseHarnessArgs(['--harness', 'cursor']).error).toMatch(/unknown --harness/);
    expect(parseHarnessArgs(['--port', 'nope']).error).toMatch(/invalid --port/);
    expect(parseHarnessArgs(['--name', 'My Server']).error).toMatch(/invalid --name/);
  });
  test('--project is repeatable and resolved', () => {
    const f = parseHarnessArgs(['--project', '/a', '--project', '/b']);
    expect(f.projects).toEqual(['/a', '/b']);
  });
});

describe('consent gate', () => {
  test('non-TTY without --yes refuses BEFORE any mutation (no mint, no files)', async () => {
    const f = makeFake();
    const code = await applyHarness(parseHarnessArgs([]), f.deps);
    expect(code).toBe(2);
    expect(f.err.join('\n')).toMatch(/pass --yes/);
    expect(existsSync(f.userSettings)).toBe(false);
    expect(existsSync(f.codexConfig)).toBe(false);
    expect(readHarnessReceiptState(f.home)).toEqual({ state: 'absent' });
  });

  test('consent copy: capture is its own numbered item with the no-capture off-ramp', () => {
    const block = buildConsentBlock({
      tokenName: 'bootstrap-harness',
      tokenSupplied: false,
      scopes: ['read', 'write'],
      url: URL,
      wireClaude: true,
      wireCodex: true,
      hooks: true,
      capture: true,
      hookScope: 'user scope',
      name: 'gbrain',
      userSettingsPath: '/u/settings.json',
      codexConfig: '/u/config.toml',
    });
    expect(block).toMatch(/Session-transcript capture: every Claude Code session/);
    expect(block).toMatch(/no-capture/);
    expect(block).toMatch(/read AND write/);
    expect(block).toMatch(/five lifecycle hooks/);
  });
});

describe('full apply', () => {
  test('claude scope-user argv + permissions + five lane-tagged hooks + codex block + receipt', async () => {
    const f = makeFake();
    const code = await applyHarness(flags(), f.deps);
    expect(code).toBe(0);

    // claude mcp add with --scope user and the bearer header
    const add = f.calls.find((c) => c[0] === 'claude' && c[2] === 'add');
    expect(add).toBeDefined();
    expect(add!.join(' ')).toContain('--scope user');
    expect(add!.join(' ')).toContain(`Authorization: Bearer ${TOKEN_A}`);
    // codex CLI NEVER execed — the TOML block is the single write mechanism
    expect(f.calls.some((c) => c[0] === 'codex')).toBe(false);
    const toml = readFileSync(f.codexConfig, 'utf8');
    expect(toml).toContain(CODEX_TOML_BLOCK_BEGIN);
    expect(toml).toContain(`bearer_token = "${TOKEN_A}"`);

    const settings = readJson(f.userSettings);
    expect((settings.permissions as { allow: string[] }).allow).toEqual(['mcp__gbrain']);
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
    const cmd = ((hooks.SessionStart[0] as { hooks: Array<{ command: string }> }).hooks[0]).command;
    expect(cmd).toContain('GBRAIN_HOOK_LANE=harness');
    expect(cmd).toContain('GBRAIN_SOURCE=default');

    const state = readHarnessReceiptState(f.home);
    expect(state.state).toBe('ok');
    const receipt = (state as { receipt: { targets: Array<{ state: string }>; token: { id?: string } } }).receipt;
    expect(receipt.targets.every((t) => t.state === 'confirmed')).toBe(true);
    expect(receipt.token.id).toBe(ID_A);
    // first run: nothing to rotate
    expect(f.revoked).toEqual([]);
  });

  test('--no-capture wires the context events only [C5]', async () => {
    const f = makeFake();
    const code = await applyHarness(flags(['--no-capture', '--harness', 'claude-code']), f.deps);
    expect(code).toBe(0);
    const hooks = readJson(f.userSettings).hooks as Record<string, unknown>;
    expect(Object.keys(hooks).sort()).toEqual(['PreCompact', 'SessionStart', 'UserPromptSubmit']);
  });

  test('re-run rotates mint-first [C7]: one entry per event, previous token revoked by id AFTER confirm', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(), f.deps)).toBe(0);
    // second run: existing registration points at OUR url → remove+re-add
    const f2deps: HarnessDeps = {
      ...f.deps,
      runner: async (argv: string[]) => {
        f.calls.push(argv);
        if (argv[0] === 'claude' && argv[2] === 'get') {
          return { code: 0, stdout: `Scope: User\nType: http\nURL: ${URL}\nHeaders:\n  Authorization: Bearer ${TOKEN_A}`, stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    expect(await applyHarness(flags(), f2deps)).toBe(0);
    expect(f.revoked).toEqual([ID_A]); // previous id, only after full confirm
    const settings = readJson(f.userSettings);
    const groups = (settings.hooks as Record<string, unknown[]>).SessionStart;
    const entries = groups.flatMap((g) => ((g as { hooks?: unknown[] }).hooks ?? []) as unknown[]);
    expect(entries.length).toBe(1); // marker dedupe, not accumulation
    expect((settings.permissions as { allow: string[] }).allow).toEqual(['mcp__gbrain']);
    expect(readFileSync(f.codexConfig, 'utf8').split(CODEX_TOML_BLOCK_BEGIN).length - 1).toBe(1);
    expect(readFileSync(f.codexConfig, 'utf8')).toContain(TOKEN_B);
  });

  test('wiring failure leaves the OLD token unrevoked and the receipt retryable [C7/F1]', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(), f.deps)).toBe(0);
    const f2 = makeFake({ mcpAddCode: 1, mintQueue: [{ token: TOKEN_B, id: ID_B }] });
    // same home so the prior receipt is visible
    const deps: HarnessDeps = { ...f2.deps, gbrainHome: f.home, userSettingsPath: f.userSettings, codexConfig: f.codexConfig };
    const code = await applyHarness(flags(), deps);
    expect(code).toBe(1);
    expect(f2.revoked).toEqual([]); // old token still live
    const state = readHarnessReceiptState(f.home);
    const receipt = (state as { receipt: { targets: Array<{ state: string; kind: string }>; token: { previous_ids?: string[] } } }).receipt;
    expect(receipt.token.previous_ids).toEqual([ID_A]); // kept for the next converge [X4]
    expect(receipt.targets.some((t) => t.state === 'failed' && t.kind === 'mcp')).toBe(true);
  });

  test('ownership [C8]: foreign-url registration refuses without --force, replaces with it', async () => {
    const foreign = { code: 0, stdout: 'Scope: User\nType: http\nURL: http://127.0.0.1:9999/mcp', stderr: '' };
    const f = makeFake({ mcpGet: () => foreign });
    const code = await applyHarness(flags(['--harness', 'claude-code', '--no-hooks']), f.deps);
    expect(code).toBe(1);
    expect(f.err.join('\n')).toMatch(/points at http:\/\/127\.0\.0\.1:9999\/mcp/);
    expect(f.err.join('\n')).toMatch(/--force/);
    expect(f.calls.some((c) => c[0] === 'claude' && c[2] === 'add')).toBe(false);

    const f2 = makeFake({ mcpGet: () => foreign });
    const code2 = await applyHarness(flags(['--harness', 'claude-code', '--no-hooks', '--force']), f2.deps);
    expect(code2).toBe(0);
    expect(f2.calls.some((c) => c[0] === 'claude' && c[2] === 'remove')).toBe(true);
    expect(f2.calls.some((c) => c[0] === 'claude' && c[2] === 'add')).toBe(true);
  });

  test('user-XOR-project hooks [C6]: --project after a user-scope install refuses', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(), f.deps)).toBe(0);
    const proj = mkdtempSync(join(tmpdir(), 'gb-proj-'));
    const code = await applyHarness(flags(['--project', proj]), f.deps);
    expect(code).toBe(2);
    expect(f.err.join('\n')).toMatch(/USER-scope harness hooks.*double-fire/s);
  });

  test('loopback guard [F3]: non-loopback --url without --token refused; allowed with --token', async () => {
    const f = makeFake();
    const code = await applyHarness(flags(['--url', 'http://192.168.1.50:3131/mcp']), f.deps);
    expect(code).toBe(2);
    expect(f.err.join('\n')).toMatch(/gbrain connect/);
    const f2 = makeFake();
    const code2 = await applyHarness(
      flags(['--url', 'http://192.168.1.50:3131/mcp', '--token', TOKEN_A, '--harness', 'codex']),
      f2.deps,
    );
    expect(code2).toBe(0);
    expect(readFileSync(f2.codexConfig, 'utf8')).toContain('http://192.168.1.50:3131/mcp');
  });

  test('--project must exist [F4]', async () => {
    const f = makeFake();
    const code = await applyHarness(flags(['--project', '/definitely/not/a/dir']), f.deps);
    expect(code).toBe(2);
    expect(f.err.join('\n')).toMatch(/does not exist/);
  });

  test('health failure is a hard stop with no writes', async () => {
    const f = makeFake({ health: { ok: false } });
    const code = await applyHarness(flags(), f.deps);
    expect(code).toBe(1);
    expect(f.err.join('\n')).toMatch(/no healthy gbrain serve/);
    expect(readHarnessReceiptState(f.home)).toEqual({ state: 'absent' });
  });

  test('version-skew note [F7] when the serve predates token scoping', async () => {
    const f = makeFake({ health: { ok: true, version: '0.1.0', engine: 'pglite' } });
    const code = await applyHarness(flags(['--harness', 'codex']), f.deps);
    expect(code).toBe(0);
    expect(f.out.join('\n')).toMatch(/predates token scoping.*FULL-ACCESS/s);
  });

  test('postgres engine prints the degradation note; smoke auth-fail names the wrong-brain cause', async () => {
    const f = makeFake({ probeOk: false });
    const code = await applyHarness(flags(['--harness', 'codex']), f.deps);
    expect(code).toBe(1);
    expect(f.out.join('\n')).toMatch(/no_pglite_path.*MCP tools are the active seam/s);
    expect(f.err.join('\n')).toMatch(/GBRAIN_HOME \/ DATABASE_URL/);
  });
});

describe('--remove', () => {
  test('full remove: ours-by-url removed, token revoked by id, receipt consumed; foreign entries survive', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(), f.deps)).toBe(0);
    // seed a foreign allow entry AFTER apply — must survive removal
    const s = readJson(f.userSettings);
    (s.permissions as { allow: string[] }).allow.push('Bash(ls:*)');
    writeFileSync(f.userSettings, JSON.stringify(s, null, 2));

    const removeDeps: HarnessDeps = {
      ...f.deps,
      runner: async (argv: string[]) => {
        f.calls.push(argv);
        if (argv[0] === 'claude' && argv[2] === 'get') {
          return { code: 0, stdout: `Type: http\nURL: ${URL}`, stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const code = await removeHarness(parseHarnessArgs(['--remove', '--yes']), removeDeps);
    expect(code).toBe(0);
    expect(f.revoked).toContain(ID_A);
    expect(readHarnessReceiptState(f.home)).toEqual({ state: 'absent' });
    const after = readJson(f.userSettings);
    expect((after.permissions as { allow: string[] }).allow).toEqual(['Bash(ls:*)']);
    expect(after.hooks).toBeUndefined();
    expect(readFileSync(f.codexConfig, 'utf8')).toBe('');
  });

  test('not-found counts as removed [F2]; url-mismatch skipped with a note [C8]', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(['--harness', 'claude-code', '--no-hooks']), f.deps)).toBe(0);
    const removeDeps: HarnessDeps = {
      ...f.deps,
      runner: async (argv: string[]) => {
        if (argv[0] === 'claude' && argv[2] === 'get') {
          return { code: 0, stdout: 'Type: http\nURL: http://127.0.0.1:7777/mcp', stderr: '' };
        }
        if (argv[0] === 'claude' && argv[2] === 'remove') throw new Error('must not remove a foreign registration');
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const code = await removeHarness(parseHarnessArgs(['--remove', '--yes']), removeDeps);
    expect(code).toBe(0);
    expect(f.out.join('\n')).toMatch(/owned by another install/);
  });

  test('PGLite live serve defers the revoke [C9]: host wiring removed, receipt keeps the token remainder', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(), f.deps)).toBe(0);
    const removeDeps: HarnessDeps = {
      ...f.deps,
      pgliteLiveServe: () => true,
      runner: async (argv: string[]) => {
        if (argv[0] === 'claude' && argv[2] === 'get') return { code: 0, stdout: `URL: ${URL}`, stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const code = await removeHarness(parseHarnessArgs(['--remove', '--yes']), removeDeps);
    expect(code).toBe(1);
    expect(f.revoked).toEqual([]);
    expect(f.err.join('\n')).toMatch(/token\(s\) NOT revoked/);
    const state = readHarnessReceiptState(f.home);
    expect(state.state).toBe('ok');
    expect((state as { receipt: { targets: unknown[] } }).receipt.targets).toEqual([]);
  });

  test('absent receipt is a calm exit 0', async () => {
    const f = makeFake();
    expect(await removeHarness(parseHarnessArgs(['--remove']), f.deps)).toBe(0);
    expect(f.out.join('\n')).toMatch(/nothing harness-installed/);
  });
});

describe('--status', () => {
  test('absent receipt: human exit 0, --json exit 2 (cron contract)', async () => {
    const f = makeFake();
    expect(await statusHarness(parseHarnessArgs(['--status']), f.deps)).toBe(0);
    expect(await statusHarness(parseHarnessArgs(['--status', '--json']), f.deps)).toBe(2);
  });

  test('green path: token recovered from the codex block, identity verified, exit 0', async () => {
    const f = makeFake({ mcpGet: () => ({ code: 1, stdout: '', stderr: 'nope' }) });
    expect(await applyHarness(flags(), f.deps)).toBe(0);
    const code = await statusHarness(parseHarnessArgs(['--status']), f.deps);
    expect(code).toBe(0);
    expect(f.out.join('\n')).toMatch(/token: OK .*codex config block/);
    expect(f.out.join('\n')).toMatch(/degraded on Postgres/);
  });

  test('revoked-under-a-green-receipt: token verify fails → exit 1', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(), f.deps)).toBe(0);
    const statusDeps: HarnessDeps = {
      ...f.deps,
      probeIdentity: async () => ({ ok: false, reason: 'auth', message: 'HTTP 401' }),
    };
    const code = await statusHarness(parseHarnessArgs(['--status']), statusDeps);
    expect(code).toBe(1);
    expect(f.out.join('\n')).toMatch(/token: FAILED \(auth\)/);
  });

  test('serve down → exit 1 with honest token line', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(), f.deps)).toBe(0);
    const statusDeps: HarnessDeps = {
      ...f.deps,
      fetchFn: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    };
    const code = await statusHarness(parseHarnessArgs(['--status']), statusDeps);
    expect(code).toBe(1);
    expect(f.out.join('\n')).toMatch(/serve: UNREACHABLE/);
    expect(f.out.join('\n')).toMatch(/not verified \(serve unreachable\)/);
  });
});

describe('outside-voice hardening (X-batch)', () => {
  const ID_C = '33333333-3333-3333-3333-333333333333';
  const TOKEN_C = `gbrain_${'c'.repeat(64)}`;

  test('[X1] explicit --harness codex FORCES wiring with zero detection signals', async () => {
    const f = makeFake();
    const deps: HarnessDeps = { ...f.deps, detectCodex: () => false, detectClaude: () => false };
    const code = await applyHarness(flags(['--harness', 'codex']), deps);
    expect(code).toBe(0);
    expect(readFileSync(f.codexConfig, 'utf8')).toContain(CODEX_TOML_BLOCK_BEGIN);
  });

  test('[X2] --source reaches the mint as a scalar write-floor grant; absent → federation default', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(['--harness', 'codex', '--source', 'wiki']), f.deps)).toBe(0);
    expect(f.mintCalls[0].sourceGrant).toEqual(['wiki']);
    const f2 = makeFake();
    expect(await applyHarness(flags(['--harness', 'codex']), f2.deps)).toBe(0);
    expect(f2.mintCalls[0].sourceGrant).toBeUndefined();
  });

  test('[X3] --no-capture RE-RUN unwires the capture events it previously wired', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(['--harness', 'claude-code']), f.deps)).toBe(0);
    expect(Object.keys(readJson(f.userSettings).hooks as object).length).toBe(5);
    expect(await applyHarness(flags(['--harness', 'claude-code', '--no-capture']), f.deps)).toBe(0);
    const hooks = readJson(f.userSettings).hooks as Record<string, unknown>;
    expect(Object.keys(hooks).sort()).toEqual(['PreCompact', 'SessionStart', 'UserPromptSubmit']);
  });

  test('[X3] a changed --project set unwires the dropped dir and the receipt stays honest', async () => {
    const projA = mkdtempSync(join(tmpdir(), 'gb-proj-a-'));
    const projB = mkdtempSync(join(tmpdir(), 'gb-proj-b-'));
    const f = makeFake();
    expect(await applyHarness(flags(['--harness', 'claude-code', '--project', projA]), f.deps)).toBe(0);
    const settingsA = join(projA, '.claude', 'settings.local.json');
    expect(readFileSync(settingsA, 'utf8')).toContain(GBRAIN_HARNESS_MARKER_VALUE);
    expect(await applyHarness(flags(['--harness', 'claude-code', '--project', projB]), f.deps)).toBe(0);
    // A unwired; B wired; receipt records only B
    expect(readFileSync(settingsA, 'utf8')).not.toContain(GBRAIN_HARNESS_MARKER_VALUE);
    expect(readFileSync(join(projB, '.claude', 'settings.local.json'), 'utf8')).toContain(GBRAIN_HARNESS_MARKER_VALUE);
    const state = readHarnessReceiptState(f.home);
    const targets = (state as { receipt: { targets: Array<{ kind: string; scope: string }> } }).receipt.targets;
    expect(targets.filter((t) => t.kind === 'hooks').map((t) => t.scope)).toEqual([projB]);
  });

  test('[X4] a failed rotation accumulates unrevoked ids; the next converge revokes them ALL', async () => {
    const f = makeFake({ mintQueue: [{ token: TOKEN_A, id: ID_A }, { token: TOKEN_B, id: ID_B }, { token: TOKEN_C, id: ID_C }] });
    expect(await applyHarness(flags(['--harness', 'codex']), f.deps)).toBe(0); // mints A
    // run 2 fails post-mint (codex config made unwritable via foreign damage)
    writeFileSync(f.codexConfig, `${CODEX_TOML_BLOCK_BEGIN}\ndamaged`); // one marker only → writer refuses
    expect(await applyHarness(flags(['--harness', 'codex']), f.deps)).toBe(1); // mints B, wiring fails
    expect(f.revoked).toEqual([]);
    // repair the config, run 3 converges: A AND B both revoked
    writeFileSync(f.codexConfig, '');
    expect(await applyHarness(flags(['--harness', 'codex']), f.deps)).toBe(0); // mints C
    expect([...f.revoked].sort()).toEqual([ID_A, ID_B].sort());
    const state = readHarnessReceiptState(f.home);
    expect((state as { receipt: { token: { previous_ids?: string[] } } }).receipt.token.previous_ids).toBeUndefined();
  });

  test('[X5] claude add-failure restores the previous registration (old clients stay connected)', async () => {
    // the OLD registration carries TOKEN_B; the fresh mint is TOKEN_A —
    // fail the new-token add, succeed the restore of the old one.
    const oursGet = {
      code: 0,
      stdout: `Scope: User\nType: http\nURL: ${URL}\nHeaders:\n  Authorization: Bearer ${TOKEN_B}`,
      stderr: '',
    };
    const f = makeFake({ mcpGet: () => oursGet });
    const deps: HarnessDeps = {
      ...f.deps,
      runner: async (argv: string[]) => {
        f.calls.push(argv);
        if (argv[0] === 'claude' && argv[2] === 'get') return oursGet;
        if (argv[0] === 'claude' && argv[2] === 'add' && argv.join(' ').includes(`Bearer ${TOKEN_A}`)) {
          return { code: 1, stdout: '', stderr: 'add failed' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const code = await applyHarness(flags(['--harness', 'claude-code', '--no-hooks']), deps);
    expect(code).toBe(1);
    const adds = f.calls.filter((c) => c[0] === 'claude' && c[2] === 'add');
    expect(adds.length).toBe(2); // failed new add + restore of the old registration
    expect(adds[1].join(' ')).toContain(`Bearer ${TOKEN_B}`);
    expect(f.out.join('\n')).toMatch(/previous MCP registration restored/);
  });

  test('[X5] smoke failure rolls the codex block back to the pre-run config', async () => {
    const f = makeFake();
    writeFileSync(f.codexConfig, 'model = "o5"\n');
    expect(await applyHarness(flags(['--harness', 'codex']), f.deps)).toBe(0); // block with TOKEN_A
    const preRun = readFileSync(f.codexConfig, 'utf8');
    const f2deps: HarnessDeps = {
      ...f.deps,
      probeIdentity: async () => ({ ok: false, reason: 'unreachable', message: 'boom' }),
    };
    expect(await applyHarness(flags(['--harness', 'codex']), f2deps)).toBe(1); // mints B, smoke fails
    expect(readFileSync(f.codexConfig, 'utf8')).toBe(preRun); // TOKEN_A block restored
    expect(f.revoked).toEqual([]); // nothing revoked — old token still live AND still wired
  });

  test('[X6] a mint crash leaves a write-ahead receipt (pending targets, no token id)', async () => {
    const f = makeFake();
    const deps: HarnessDeps = {
      ...f.deps,
      mint: async () => {
        throw new Error('simulated crash mid-mint');
      },
    };
    await expect(applyHarness(flags(['--harness', 'codex']), deps)).rejects.toThrow(/simulated crash/);
    const state = readHarnessReceiptState(f.home);
    expect(state.state).toBe('ok');
    const receipt = (state as { receipt: { targets: Array<{ state: string }>; token: { id?: string } } }).receipt;
    expect(receipt.token.id).toBeUndefined();
    expect(receipt.targets.every((t) => t.state === 'pending')).toBe(true);
  });

  test('[X7] consent reach matches the actual wiring (codex-only, no-hooks)', () => {
    const block = buildConsentBlock({
      tokenName: 'bootstrap-harness',
      tokenSupplied: true,
      scopes: ['read', 'write'],
      url: URL,
      wireClaude: false,
      wireCodex: true,
      hooks: false,
      capture: true,
      hookScope: 'user scope',
      name: 'gbrain',
      userSettingsPath: '/u/settings.json',
      codexConfig: '/u/config.toml',
    });
    expect(block).toMatch(/EVERY Codex session/);
    expect(block).not.toMatch(/EVERY Claude Code and Codex session/);
    expect(block).toMatch(/No hooks are wired by this invocation/);
    expect(block).toMatch(/written ONLY into the host registrations/);
    expect(block).not.toMatch(/never stored/);
  });

  test('[X8] a pre-existing permissions.allow entry is recorded as such and SURVIVES --remove', async () => {
    const f = makeFake();
    mkdirSync(join(f.userSettings, '..'), { recursive: true });
    writeFileSync(f.userSettings, JSON.stringify({ permissions: { allow: ['mcp__gbrain'] } }));
    expect(await applyHarness(flags(['--harness', 'claude-code', '--no-hooks']), f.deps)).toBe(0);
    const state = readHarnessReceiptState(f.home);
    const perm = (state as { receipt: { targets: Array<{ kind: string; mechanism?: string }> } }).receipt.targets.find(
      (t) => t.kind === 'permission',
    );
    expect(perm?.mechanism).toBe('pre-existing');
    const removeDeps: HarnessDeps = {
      ...f.deps,
      runner: async (argv: string[]) => {
        if (argv[0] === 'claude' && argv[2] === 'get') return { code: 0, stdout: `URL: ${URL}`, stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    expect(await removeHarness(parseHarnessArgs(['--remove', '--yes']), removeDeps)).toBe(0);
    expect((readJson(f.userSettings).permissions as { allow: string[] }).allow).toEqual(['mcp__gbrain']);
    expect(f.out.join('\n')).toMatch(/predates the harness install — left in place/);
  });

  test('[X10] a narrowed --surface serve (unknown-tool tool_error) is verified, not broken', async () => {
    const f = makeFake();
    const deps: HarnessDeps = {
      ...f.deps,
      probeIdentity: async () => ({ ok: false, reason: 'tool_error', message: 'Unknown tool: get_brain_identity' }),
    };
    expect(await applyHarness(flags(['--harness', 'codex']), deps)).toBe(0);
    expect(f.out.join('\n')).toMatch(/narrowed --surface.*Counted as verified/s);
    expect(await statusHarness(parseHarnessArgs(['--status']), deps)).toBe(0);
    expect(f.out.join('\n')).toMatch(/token: OK .*narrowed --surface/);
  });

  test('[X13] registrar mode (non-loopback url + token) wires MCP only — no hooks', async () => {
    const f = makeFake();
    const code = await applyHarness(
      flags(['--url', 'http://192.168.1.50:3131/mcp', '--token', TOKEN_A]),
      f.deps,
    );
    expect(code).toBe(0);
    expect(f.out.join('\n')).toMatch(/registrar mode.*hooks are NOT wired/s);
    expect(readJson(f.userSettings).hooks).toBeUndefined();
    // the discarded-warning fix: http-bearer warning surfaces
    expect(f.err.join('\n')).toMatch(/unencrypted/);
  });

  test('[X14] conflicting or value-less invocations fail closed', () => {
    expect(parseHarnessArgs(['--url', 'http://h/mcp', '--port', '3131']).error).toMatch(/not both/);
    expect(parseHarnessArgs(['--status', '--remove']).error).toMatch(/not both/);
    expect(parseHarnessArgs(['--token']).error).toMatch(/requires a value/);
    expect(parseHarnessArgs(['--url', '--yes']).error).toMatch(/requires a value/);
  });
});

describe('parse helpers', () => {
  test('parseClaudeMcpGetUrl + parseClaudeMcpGetBearer read the live-verified shape', () => {
    const out = 'gbrain:\n  Scope: User config\n  Type: http\n  URL: http://127.0.0.1:3131/mcp\n  Headers:\n    Authorization: Bearer gbrain_abc123\n';
    expect(parseClaudeMcpGetUrl(out)).toEqual({ found: true, url: 'http://127.0.0.1:3131/mcp' });
    expect(parseClaudeMcpGetBearer(out)).toBe('gbrain_abc123');
    expect(parseClaudeMcpGetUrl('nothing here')).toEqual({ found: false });
  });

  test('parseCodexBlockBearer reads only OUR managed block', () => {
    const ours = [
      '[mcp_servers.other]',
      'bearer_token = "not_ours"',
      CODEX_TOML_BLOCK_BEGIN,
      '[mcp_servers.gbrain]',
      'url = "http://127.0.0.1:3131/mcp"',
      `bearer_token = "${TOKEN_A}"`,
      `# gbrain:${GBRAIN_HARNESS_MARKER_VALUE} end`,
      '',
    ].join('\n');
    expect(parseCodexBlockBearer(ours)).toBe(TOKEN_A);
    expect(parseCodexBlockBearer('[mcp_servers.x]\nbearer_token = "y"\n')).toBeNull();
  });
});
