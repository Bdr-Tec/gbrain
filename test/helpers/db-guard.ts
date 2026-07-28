/**
 * The DATABASE_URL production guard — single source of truth.
 *
 * Lives here rather than in `test/e2e/helpers.ts` (#3485) because the guard
 * is needed by files that never import those helpers. `assertSafeE2eDatabaseUrl`
 * used to be reachable only from `setupDB()`, so the 17 test files that build
 * a `PostgresEngine` straight from `process.env.DATABASE_URL` never ran it —
 * and several of them issue `TRUNCATE ... CASCADE`, unscoped `DELETE FROM
 * pages`, `DROP TABLE`, and `ALTER TABLE ... DROP COLUMN`. `gbrain init`
 * writes DATABASE_URL into `~/.gbrain/.env`, so a developer with a real brain
 * in their environment was one `bun test` away from losing it.
 *
 * Enforcement is `test/helpers/db-guard-preload.ts`, wired into
 * `bunfig.toml`'s `preload`, which calls this once before any test file
 * loads. That is deliberately the same mechanism #2823 used to stop tests
 * leaking into the operator's real `~/.gbrain/audit/`: a process-wide
 * precondition beats a per-file ritual nobody remembers to perform.
 *
 * Pure — makes no connection — so it is cheap to call redundantly and safe
 * to unit test.
 */

/**
 * Refuse to proceed unless the database name identifies itself as a test
 * database ("test" as a word segment, e.g. `gbrain_test` — the
 * CI/.env.testing.example convention), or the operator explicitly opts the
 * exact name in via `GBRAIN_E2E_ALLOW_DB`.
 *
 * @param url   the DATABASE_URL to vet
 * @param env   env source, injectable for tests
 * @param what  what would happen if we proceeded, for the error message
 */
export function assertSafeE2eDatabaseUrl(
  url: string,
  env: Record<string, string | undefined> = process.env,
  what = 'setupDB() would TRUNCATE every data table in it',
): void {
  let dbName: string;
  try {
    dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error(`E2E guard: DATABASE_URL is not a parseable URL; refusing to run destructive setup.`);
  }
  if (!dbName) {
    throw new Error(`E2E guard: DATABASE_URL has no database name; refusing to run destructive setup.`);
  }
  if (/(^|[_-])test([_-]|$)/i.test(dbName)) return;
  if (env.GBRAIN_E2E_ALLOW_DB && env.GBRAIN_E2E_ALLOW_DB === dbName) return;
  throw new Error(
    `E2E guard: database "${dbName}" does not look like a test database ` +
    `(expected "test" as a name segment, e.g. gbrain_test). ${what}. ` +
    `If this is intentional, set GBRAIN_E2E_ALLOW_DB=${dbName} to opt in explicitly.`,
  );
}
