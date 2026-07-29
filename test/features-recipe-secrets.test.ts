/**
 * Drift guard for `RECIPE_META` in src/commands/features.ts.
 *
 * `runFeatures` recommends "Set Up Integrations" for any recipe whose declared
 * secrets are absent from the environment. If a secret NAME in RECIPE_META does
 * not match what the recipe's own frontmatter tells the user to set, that recipe
 * is reported as unconfigured forever, no matter how the user actually sets it up.
 *
 * That had drifted on 4 of 7 entries (GOOGLE_CALENDAR_API_KEY, GMAIL_APP_PASSWORD,
 * CIRCLEBACK_API_KEY, OAUTH_CLIENT_SECRET were all names that appear nowhere in
 * the repo). Nothing caught it because the only prior test asserted that
 * `runFeatures` is defined.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { RECIPE_META } from '../src/commands/features.ts';

const REPO_ROOT = join(import.meta.dir, '..');
const recipePath = (id: string) => join(REPO_ROOT, 'recipes', `${id}.md`);

describe('RECIPE_META integrity', () => {
  test('every entry points at a recipe file that exists', () => {
    for (const entry of RECIPE_META) {
      expect(existsSync(recipePath(entry.id))).toBe(true);
    }
  });

  test('every declared secret name appears in its recipe', () => {
    const drift: string[] = [];
    for (const entry of RECIPE_META) {
      const body = readFileSync(recipePath(entry.id), 'utf-8');
      for (const secret of entry.secrets) {
        if (!body.includes(secret)) drift.push(`${entry.id} -> ${secret}`);
      }
    }
    // A drifted name makes `gbrain features` nag about a configured recipe forever.
    expect(drift).toEqual([]);
  });

  test('every entry declares at least one secret', () => {
    for (const entry of RECIPE_META) {
      expect(entry.secrets.length).toBeGreaterThan(0);
    }
  });

  test('secret names look like env vars (SCREAMING_SNAKE_CASE)', () => {
    for (const entry of RECIPE_META) {
      for (const secret of entry.secrets) {
        expect(secret).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });
});

describe('configured-detection semantics', () => {
  // The gate is ANY-of, not all-of: recipes whose auth is an `any_of` health
  // check (ClawVisor OR direct OAuth) must count as configured once one path is
  // present. `every` is what made them permanently unconfigured.
  const isUnconfigured = (secrets: readonly string[], env: Record<string, string>) =>
    !secrets.some((s) => env[s]);

  test('one present secret is enough for an alternative-auth recipe', () => {
    const calendar = RECIPE_META.find((r) => r.id === 'calendar-to-brain')!;
    expect(isUnconfigured(calendar.secrets, { CLAWVISOR_AGENT_TOKEN: 'x' })).toBe(false);
    expect(isUnconfigured(calendar.secrets, { GOOGLE_CLIENT_ID: 'x' })).toBe(false);
  });

  test('no present secret still reports unconfigured', () => {
    const calendar = RECIPE_META.find((r) => r.id === 'calendar-to-brain')!;
    expect(isUnconfigured(calendar.secrets, {})).toBe(true);
  });

  test('an all-of gate would have reported a configured recipe as unconfigured', () => {
    // Regression pin for the actual bug: under `every`, a ClawVisor-only user
    // (the recommended path) never satisfies GOOGLE_CLIENT_ID.
    const calendar = RECIPE_META.find((r) => r.id === 'calendar-to-brain')!;
    const env = { CLAWVISOR_AGENT_TOKEN: 'x' };
    expect(calendar.secrets.every((s) => env[s as keyof typeof env])).toBe(false);
    expect(calendar.secrets.some((s) => env[s as keyof typeof env])).toBe(true);
  });
});
