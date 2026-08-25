/**
 * codex-hooks writer — hooks.json + the config.toml trust-state entry, the
 * two-file write the 0.147.0 trust gate demands (a hooks entry without its
 * trusted_hash is listed and silently never executed).
 *
 * The load-bearing properties: fail-closed on an unparseable hooks.json,
 * strip-ours-then-APPEND so foreign groups' trust indexes never shift,
 * idempotent re-runs, foreign trust entries preserved byte-for-byte outside
 * the managed block, refusal on a foreign definition of our exact table key,
 * and clean removal of exactly what we wrote.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCodexSessionEndCommand,
  codexTrustHash,
  removeCodexHooks,
  writeCodexHooks,
} from '../src/core/bootstrap/codex-hooks.ts';

let dir: string;
let hooksPath: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gb-cdx-hooks-'));
  mkdirSync(dir, { recursive: true });
  hooksPath = join(dir, 'hooks.json');
  configPath = join(dir, 'config.toml');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BIN = '/usr/local/bin/gbrain';

function readHooks(): { description?: string; hooks?: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>> } {
  return JSON.parse(readFileSync(hooksPath, 'utf8'));
}

describe('writeCodexHooks', () => {
  test('fresh write: hooks.json created with description + our entry; trust entry with the recipe hash', () => {
    const res = writeCodexHooks({ gbrainBin: BIN, hooksPath, configPath });
    expect(res.ok).toBe(true);
    expect(res.trustKey).toBe(`${hooksPath}:session_end:0:0`);

    const doc = readHooks();
    expect(doc.description).toContain('gbrain');
    const groups = doc.hooks!.SessionEnd!;
    expect(groups).toHaveLength(1);
    const handler = groups[0]!.hooks[0]!;
    expect(handler.command).toContain('hook session-end --harness codex');
    // The 3s hard-kill posture: stdin captured, grandchild detached.
    expect(handler.command).toContain('mktemp');
    expect(handler.command).toContain('nohup');
    expect(handler.timeout).toBe(3);
    // No baked source — runtime payload resolution only [OV2].
    expect(handler.command).not.toContain('GBRAIN_SOURCE');

    const cfg = readFileSync(configPath, 'utf8');
    expect(cfg).toContain(`[hooks.state.${JSON.stringify(res.trustKey)}]`);
    expect(cfg).toContain(`trusted_hash = ${JSON.stringify(codexTrustHash(handler.command))}`);
    expect(codexTrustHash(handler.command)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('idempotent: a re-run replaces our entry (one group, one trust block), never accumulates', () => {
    writeCodexHooks({ gbrainBin: BIN, hooksPath, configPath });
    const res2 = writeCodexHooks({ gbrainBin: BIN, hooksPath, configPath });
    expect(res2.ok).toBe(true);
    expect(res2.replacedPrior).toBe(true);
    expect(readHooks().hooks!.SessionEnd!).toHaveLength(1);
    const cfg = readFileSync(configPath, 'utf8');
    expect(cfg.match(/gbrain:codex-hooks-trust \(managed/g)).toHaveLength(1);
    expect(cfg.match(/trusted_hash/g)).toHaveLength(1);
  });

  test('foreign SessionEnd groups keep their positions (ours appends LAST, key index shifts to match)', () => {
    const foreign = { description: 'mine', hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'my-own-tool --flag', timeout: 2 }] }] } };
    writeFileSync(hooksPath, JSON.stringify(foreign));
    writeFileSync(configPath, `[hooks.state."${hooksPath}:session_end:0:0"]\ntrusted_hash = "sha256:user-owned"\n`);

    const res = writeCodexHooks({ gbrainBin: BIN, hooksPath, configPath });
    expect(res.ok).toBe(true);
    expect(res.trustKey).toBe(`${hooksPath}:session_end:1:0`); // AFTER the foreign group
    const doc = readHooks();
    expect(doc.description).toBe('mine'); // never clobber a user description
    expect(doc.hooks!.SessionEnd![0]!.hooks[0]!.command).toBe('my-own-tool --flag');
    expect(doc.hooks!.SessionEnd![1]!.hooks[0]!.command).toContain('gbrain');
    const cfg = readFileSync(configPath, 'utf8');
    // The user's own trust entry survives byte-for-byte outside our block.
    expect(cfg).toContain('sha256:user-owned');
    expect(cfg).toContain(`:session_end:1:0`);
  });

  test('fail-closed: an unparseable hooks.json is never touched', () => {
    writeFileSync(hooksPath, '{definitely not json');
    const res = writeCodexHooks({ gbrainBin: BIN, hooksPath, configPath });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('hooks_json_unparseable');
    expect(readFileSync(hooksPath, 'utf8')).toBe('{definitely not json');
    expect(existsSync(configPath)).toBe(false); // trust entry not written either
  });

  test('refusal: our exact table key already defined outside the managed block (double-define bricks codex)', () => {
    writeFileSync(configPath, `[hooks.state."${hooksPath}:session_end:0:0"]\ntrusted_hash = "sha256:foreign"\n`);
    const res = writeCodexHooks({ gbrainBin: BIN, hooksPath, configPath });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('foreign_trust_entry');
    expect(readFileSync(configPath, 'utf8')).toContain('sha256:foreign');
    expect(existsSync(hooksPath)).toBe(false);
  });

  test('foreign config.toml content outside the block survives byte-for-byte across write + rewrite', () => {
    const userCfg = '# my codex config\nmodel = "gpt-5.6-sol"\n\n[mcp_servers.other]\nurl = "http://x"\n';
    writeFileSync(configPath, userCfg);
    writeCodexHooks({ gbrainBin: BIN, hooksPath, configPath });
    writeCodexHooks({ gbrainBin: BIN, hooksPath, configPath });
    const cfg = readFileSync(configPath, 'utf8');
    expect(cfg.startsWith('# my codex config\nmodel = "gpt-5.6-sol"')).toBe(true);
    expect(cfg).toContain('[mcp_servers.other]');
  });
});

describe('removeCodexHooks', () => {
  test('removes exactly ours: foreign groups + foreign trust entries survive; our block goes', () => {
    const foreign = { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'my-own-tool', timeout: 2 }] }] } };
    writeFileSync(hooksPath, JSON.stringify(foreign));
    writeFileSync(configPath, '[hooks.state."x:session_end:0:0"]\ntrusted_hash = "sha256:user-owned"\n');
    writeCodexHooks({ gbrainBin: BIN, hooksPath, configPath });

    const res = removeCodexHooks({ hooksPath, configPath });
    expect(res.removed).toBe(true);
    const doc = readHooks();
    expect(doc.hooks!.SessionEnd!).toHaveLength(1);
    expect(doc.hooks!.SessionEnd![0]!.hooks[0]!.command).toBe('my-own-tool');
    const cfg = readFileSync(configPath, 'utf8');
    expect(cfg).toContain('sha256:user-owned');
    expect(cfg).not.toContain('gbrain:codex-hooks-trust');
    expect(cfg).not.toContain('gbrain');
  });

  test('absent files and unparseable hooks.json are calm non-destructive no-ops', () => {
    expect(removeCodexHooks({ hooksPath, configPath }).removed).toBe(false);
    writeFileSync(hooksPath, '{broken');
    const res = removeCodexHooks({ hooksPath, configPath });
    expect(res.removed).toBe(false);
    expect(readFileSync(hooksPath, 'utf8')).toBe('{broken');
    expect(res.notes.join(' ')).toContain('left untouched');
  });
});

describe('buildCodexSessionEndCommand', () => {
  test('a path needing quoting stays intact through the $0 seam', () => {
    const cmd = buildCodexSessionEndCommand("/opt/my tools/gbrain");
    expect(cmd).toContain("'/opt/my tools/gbrain'");
    expect(cmd).toContain('"$0" hook session-end --harness codex');
  });
});
