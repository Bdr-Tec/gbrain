/**
 * Pins the #3485 fix in place.
 *
 * The vulnerability was never that the guard logic was wrong — it was that
 * the guard was only *reachable* from `setupDB()`, so the 17 test files that
 * build a PostgresEngine straight from `process.env.DATABASE_URL` never ran
 * it. The fix is a `bunfig.toml` preload, and a preload is exactly the kind
 * of thing a future refactor drops without noticing, because nothing imports
 * it. Hence this test: it asserts the wiring, not the logic.
 *
 * `test/e2e/db-guard.test.ts` covers the guard's behavior.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');

describe('#3485: DATABASE_URL guard is enforced process-wide', () => {
  test('bunfig.toml preloads the db guard', () => {
    const bunfig = readFileSync(resolve(REPO_ROOT, 'bunfig.toml'), 'utf-8');
    // Tolerant of formatting (single-line or multi-line array), strict about presence.
    expect(bunfig).toContain('./test/helpers/db-guard-preload.ts');
  });

  test('the preload actually calls the guard', () => {
    const preload = readFileSync(resolve(REPO_ROOT, 'test/helpers/db-guard-preload.ts'), 'utf-8');
    expect(preload).toContain('assertSafeE2eDatabaseUrl');
    // Must be conditional on DATABASE_URL — an unconditional call would break
    // every no-DB run.
    expect(preload).toContain('process.env.DATABASE_URL');
  });

  test('the guard still rejects a production-shaped database name', () => {
    // Sanity: if this ever stops throwing, the preload is a no-op and the
    // wiring assertions above are worthless.
    expect(() =>
      assertSafeE2eDatabaseUrl('postgresql://u:p@db.example.com:5432/gbrain', {}),
    ).toThrow(/does not look like a test database/);
  });

  test('and accepts the CI/.env.testing convention', () => {
    expect(() =>
      assertSafeE2eDatabaseUrl('postgresql://postgres:postgres@localhost:5433/gbrain_test', {}),
    ).not.toThrow();
  });

  test('this very process passed the guard', () => {
    // If DATABASE_URL is set at all, the preload ran before this file loaded
    // and did not throw — otherwise the process would have aborted. Assert the
    // invariant explicitly so the guarantee is visible in test output.
    if (process.env.DATABASE_URL) {
      expect(() => assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!, process.env)).not.toThrow();
    }
  });
});
