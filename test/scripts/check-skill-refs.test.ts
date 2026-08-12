import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'check-skill-refs.mjs');

function runOn(setup: (dir: string) => void, allowlist = ''): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'skill-refs-'));
  try {
    const skills = join(dir, 'skills');
    mkdirSync(skills, { recursive: true });
    setup(skills);
    const allowPath = join(dir, 'allow.txt');
    writeFileSync(allowPath, allowlist);
    const res = spawnSync('bun', [SCRIPT, '--skills-dir', skills, '--allowlist', allowPath, '--no-cli-refs'], {
      encoding: 'utf8',
      cwd: dir,
    });
    return { code: res.status ?? -1, out: `${res.stdout}\n${res.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-skill-refs', () => {
  test('passes on a clean tree with resolving refs and placeholders', () => {
    const { code, out } = runOn((skills) => {
      mkdirSync(join(skills, 'alpha'));
      mkdirSync(join(skills, 'beta'));
      writeFileSync(join(skills, 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nSee `skills/beta/SKILL.md` and the template `skills/<slug>/SKILL.md` and `skills/{name}/SKILL.md`.\n');
      writeFileSync(join(skills, 'beta', 'SKILL.md'), '---\nname: beta\n---\nbody\n');
    });
    expect(out).toContain('OK');
    expect(code).toBe(0);
  });

  test('fails on a dangling backtick skills/ path', () => {
    const { code, out } = runOn((skills) => {
      mkdirSync(join(skills, 'alpha'));
      writeFileSync(join(skills, 'alpha', 'SKILL.md'), 'Read `skills/ghost/SKILL.md` for details.\n');
    });
    expect(code).toBe(1);
    expect(out).toContain('dangling-ref');
  });

  test('fails on a composes: slug that is not a skill dir', () => {
    const { code, out } = runOn((skills) => {
      mkdirSync(join(skills, 'alpha'));
      writeFileSync(join(skills, 'alpha', 'SKILL.md'), '---\nname: alpha\ncomposes: ghost-skill, alpha\n---\nbody\n');
    });
    expect(code).toBe(1);
    expect(out).toContain('dangling-composes');
    expect(out).toContain('ghost-skill');
  });

  test('fails on a dangling dispatcher slug in RESOLVER.md', () => {
    const { code, out } = runOn((skills) => {
      mkdirSync(join(skills, 'alpha'));
      writeFileSync(join(skills, 'alpha', 'SKILL.md'), 'body\n');
      writeFileSync(join(skills, 'RESOLVER.md'), '| "do things" (dispatcher for: alpha, ghost) | `skills/alpha/SKILL.md` |\n');
    });
    expect(code).toBe(1);
    expect(out).toContain('dangling-dispatcher');
    expect(out).toContain('ghost');
  });

  test('fails on a donor path outside the allowlist, passes when allowlisted', () => {
    // Assemble the banned prefix at runtime so this test file itself passes
    // the repo-wide privacy check (which bans the literal in source files).
    const bannedPath = ['/data', 'brain', 'notes.md'].join('/');
    const setup = (skills: string) => {
      mkdirSync(join(skills, 'alpha'));
      writeFileSync(join(skills, 'alpha', 'SKILL.md'), `Writes go to ${bannedPath}\n`);
    };
    const fail = runOn(setup);
    expect(fail.code).toBe(1);
    expect(fail.out).toContain('donor-remnant');
    const pass = runOn(setup, 'skills/alpha/SKILL.md\n');
    expect(pass.code).toBe(0);
  });

  test('exempts skills/migrations wholesale', () => {
    const { code } = runOn((skills) => {
      mkdirSync(join(skills, 'migrations'));
      writeFileSync(join(skills, 'migrations', 'v0.1.0.md'), `Old world: ${['/data', 'brain'].join('/')} and \`skills/long-gone/SKILL.md\`\n`);
      mkdirSync(join(skills, 'alpha'));
      writeFileSync(join(skills, 'alpha', 'SKILL.md'), 'clean body\n');
    });
    expect(code).toBe(0);
  });
});
