import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('plugin membership curation (skills = plugin ∪ exclusions, disjoint)', () => {
  const root = join(import.meta.dir, '..');
  const plugin = JSON.parse(readFileSync(join(root, 'openclaw.plugin.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(root, 'skills', 'manifest.json'), 'utf8'));
  const exclusionsDoc = JSON.parse(readFileSync(join(root, 'skills', 'plugin-exclusions.json'), 'utf8'));

  const bundled: string[] = plugin.skills.map((s: string) => s.replace(/^skills\//, ''));
  const manifestNames: string[] = manifest.skills.map((s: { name: string }) => s.name);
  const excluded = Object.keys(exclusionsDoc.exclusions);

  it('every manifest skill is either bundled or a recorded exclusion', () => {
    const covered = new Set([...bundled, ...excluded]);
    const missing = manifestNames.filter((n) => !covered.has(n));
    expect(missing).toEqual([]);
  });

  it('no skill is both bundled and excluded', () => {
    const both = bundled.filter((n) => excluded.includes(n));
    expect(both).toEqual([]);
  });

  it('every bundled skill exists in the manifest', () => {
    const orphans = bundled.filter((n) => !manifestNames.includes(n));
    expect(orphans).toEqual([]);
  });

  it('every recorded exclusion still exists in the manifest (no stale exclusions)', () => {
    const stale = excluded.filter((n) => !manifestNames.includes(n));
    expect(stale).toEqual([]);
  });

  it('plugin skills array is sorted', () => {
    expect(plugin.skills).toEqual([...plugin.skills].sort());
  });

  it('every exclusion carries a non-empty reason', () => {
    for (const [name, reason] of Object.entries(exclusionsDoc.exclusions)) {
      expect(typeof reason, `exclusion ${name}`).toBe('string');
      expect((reason as string).length).toBeGreaterThan(10);
    }
  });
});

describe('root OpenClaw plugin manifest', () => {
  it('declares the id required by OpenClaw plugin installs', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', 'openclaw.plugin.json'), 'utf8'));
    const entrySource = readFileSync(join(import.meta.dir, '..', 'src', 'openclaw-context-engine.ts'), 'utf8');
    const entryId = entrySource.match(/id:\s*'([^']+)'/)?.[1];

    expect(manifest.id).toBe(entryId);
    expect(manifest.configSchema).toBeDefined();
    expect(typeof manifest.configSchema).toBe('object');
    expect(manifest.contracts?.contextEngines).toContain('gbrain-context');
    expect(entrySource).toContain('export function register');
  });
});
