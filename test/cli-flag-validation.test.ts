/**
 * #2185 — strict unknown-flag validation.
 *
 * The repro that filed the issue: `gbrain init --migrate-only --dry-run`
 * applied REAL migrations — no handler consults --dry-run, and the ad-hoc
 * `args.includes()` flag style silently ignores anything it doesn't look for.
 * The pre-dispatch validator in src/cli.ts fails loud instead.
 *
 * Four guard classes:
 *   1. sweep — every CLI_ONLY command (minus documented exemptions) and every
 *      op command rejects a nonsense flag via the pure validator.
 *   2. acceptance — real flags and passthrough forms stay accepted.
 *   3. drift — every CLI_ONLY member has a registry entry.
 *   4. freshness — the committed generated registry matches a fresh
 *      generator run (same doctrine as the llms-bundle freshness test).
 * Plus subprocess smokes for the end-to-end error surface.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import {
  validateCommandFlags,
  findUnknownFlag,
  findUnknownOpFlag,
  CLI_ONLY,
} from '../src/cli.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { operations, operationsByName } from '../src/core/operations.ts';
import { buildFlagRegistry } from '../scripts/generate-flag-registry.ts';

const BOGUS = '--definitely-not-a-real-flag-xyz';
const EXEMPT = new Set(['call', 'config']); // jobs is exempt only for `submit`

describe('#2185 sweep — every command rejects a nonsense flag', () => {
  test('every CLI_ONLY command rejects the bogus flag (validator lane)', () => {
    const accepted: string[] = [];
    for (const command of CLI_ONLY) {
      if (EXEMPT.has(command)) continue;
      const verdict = validateCommandFlags(command, [BOGUS]);
      if (verdict !== BOGUS) accepted.push(command);
    }
    expect(accepted).toEqual([]);
  });

  test('every op command rejects the bogus flag (op lane)', () => {
    const accepted: string[] = [];
    for (const op of operations) {
      if (!op.cliHints) continue;
      const verdict = findUnknownOpFlag(op, [BOGUS]);
      if (verdict !== BOGUS) accepted.push(op.name);
    }
    expect(accepted).toEqual([]);
  });

  test('the literal #2185 repro is rejected: init --migrate-only --dry-run', () => {
    expect(validateCommandFlags('init', ['--migrate-only', '--dry-run'])).toBe('--dry-run');
    // And --migrate-only alone stays legal.
    expect(validateCommandFlags('init', ['--migrate-only'])).toBeNull();
  });
});

describe('#2185 acceptance — real usage stays legal', () => {
  test('op flags from the contract are accepted, including values starting with --', () => {
    const search = operationsByName.search;
    expect(findUnknownOpFlag(search, ['needle', '--limit', '5'])).toBeNull();
    // A VALUE that begins with -- is consumed as the value, not validated.
    expect(findUnknownOpFlag(search, ['--query', '--weird-looking-value'])).toBeNull();
    // Inline = form.
    expect(findUnknownOpFlag(search, ['needle', '--limit=5'])).toBeNull();
    // CLI-local formatter flags.
    expect(findUnknownOpFlag(search, ['needle', '--json', '--explain'])).toBeNull();
  });

  test('--no-<flag> negation of a known boolean op param is legal', () => {
    const withBool = operations.find(o =>
      o.cliHints && Object.values(o.params).some(p => p.type === 'boolean'));
    expect(withBool).toBeDefined();
    const boolKey = Object.entries(withBool!.params).find(([, p]) => p.type === 'boolean')![0];
    const flag = `--no-${boolKey.replace(/_/g, '-')}`;
    expect(findUnknownOpFlag(withBool!, [flag])).toBeNull();
  });

  test('everything after a literal -- is passthrough, never validated', () => {
    expect(findUnknownFlag(['--', BOGUS], new Set(['--help']))).toBeNull();
    expect(validateCommandFlags('agent', ['run', '--', BOGUS])).toBeNull();
    expect(findUnknownOpFlag(operationsByName.search, ['--', BOGUS])).toBeNull();
  });

  test('exempt commands accept arbitrary flags by contract', () => {
    expect(validateCommandFlags('call', ['some_op', BOGUS])).toBeNull();
    expect(validateCommandFlags('config', ['set', 'k', BOGUS])).toBeNull();
    expect(validateCommandFlags('jobs', ['submit', 'shell', BOGUS])).toBeNull();
    // ...but non-submit jobs subcommands are validated.
    expect(validateCommandFlags('jobs', ['list', BOGUS])).toBe(BOGUS);
  });

  test('registry-listed CLI_ONLY flags are accepted', () => {
    expect(validateCommandFlags('serve', ['--http', '--port', '4444'])).toBeNull();
    expect(validateCommandFlags('serve', ['--print-admin-token'])).toBeNull();
    expect(validateCommandFlags('embed', ['--stale', '--pace'])).toBeNull();
    expect(validateCommandFlags('sync', ['--full'])).toBeNull();
  });
});

describe('#2185 drift + freshness guards', () => {
  test('every CLI_ONLY member has a registry entry (drift guard)', () => {
    const missing = [...CLI_ONLY].filter(c => !CLI_FLAG_REGISTRY[c]);
    expect(missing).toEqual([]);
  });

  test('committed registry matches a fresh generator run (freshness guard)', () => {
    const fresh = buildFlagRegistry();
    const freshKeys = Object.keys(fresh).sort();
    const committedKeys = Object.keys(CLI_FLAG_REGISTRY).sort();
    expect(committedKeys).toEqual(freshKeys);
    const stale = freshKeys.filter(
      key => JSON.stringify([...CLI_FLAG_REGISTRY[key]]) !== JSON.stringify(fresh[key]),
    );
    // Any listed command means: run `bun run build:flag-registry` and commit.
    expect(stale).toEqual([]);
  });
});

describe('#2185 subprocess smokes — end-to-end error surface', () => {
  const run = (args: string[]) =>
    spawnSync('bun', ['src/cli.ts', ...args], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
    });

  test('init --migrate-only --dry-run fails loud BEFORE any engine work', () => {
    const r = run(['init', '--migrate-only', '--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown flag --dry-run for 'gbrain init'");
    // Pre-engine: no migration output may appear.
    expect(r.stderr).not.toContain('migration');
  });

  test('typo on an op command fails loud with the command named', () => {
    const r = run(['search', 'needle', '--jsno']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown flag --jsno for 'gbrain search'");
  });

  test('--help still short-circuits before validation', () => {
    const r = run(['init', '--help']);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('Unknown flag');
  });
});
