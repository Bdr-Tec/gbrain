/**
 * Pre-test setup: vet `DATABASE_URL` ONCE, before any test file loads, and
 * refuse to run the suite at all when it points at something that isn't
 * name-shaped like a test database.
 *
 * Why this exists (#3485): `assertSafeE2eDatabaseUrl` was reachable only
 * from `setupDB()` in `test/e2e/helpers.ts`. 17 test files build a
 * `PostgresEngine` directly from `process.env.DATABASE_URL` and never call
 * it, so for those files the check simply never executed. Several then run
 * genuinely destructive SQL against whatever answered:
 *
 *   test/e2e/postgres-bootstrap.test.ts         TRUNCATE ... CASCADE,
 *                                               DROP TABLE sources CASCADE,
 *                                               ALTER TABLE pages DROP COLUMN
 *   test/phantom-redirect-engine-parity.test.ts TRUNCATE facts, DELETE FROM pages
 *   test/e2e/multimodal-postgres.test.ts        unscoped DELETE from 3 tables
 *   test/e2e/embedding-column-postgres.test.ts  unscoped DELETE FROM content_chunks
 *   ... plus the eval-capture / eval-contradictions / facts-fence /
 *       mcp-budget files, and every file that calls initSchema() and so
 *       applies migrations to a brain that never asked for them.
 *
 * Two things made this sharper than a latent hazard. `gbrain init` writes
 * DATABASE_URL into `~/.gbrain/.env`, so a developer's real brain is a
 * plausible value. And `test/phantom-redirect-engine-parity.test.ts` sits in
 * `test/`, not `test/e2e/` — `scripts/test-shard.sh`'s collection excludes
 * `test/e2e/*` and `*.serial.test.ts` but not top-level `test/*`, so a plain
 * `bun test` picks it up with none of the E2E ritual.
 *
 * Fix shape: a process-wide precondition instead of a per-file call. This
 * covers all 17 files, needs no edit to any of them, and — the reason it is
 * the right seam — automatically covers the next file someone writes. A
 * per-file `assertSafeE2eDatabaseUrl()` line is exactly the ritual that was
 * already being skipped. Same mechanism #2823 used for `GBRAIN_AUDIT_DIR`.
 *
 * No DATABASE_URL means no risk and no-op: the DB-backed suites all skip
 * themselves in that case.
 *
 * Imported by `bunfig.toml` via
 * `preload = [..., "./test/helpers/db-guard-preload.ts"]`.
 */
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';

if (process.env.DATABASE_URL) {
  // Throwing from a preload aborts the whole `bun test` process, which is the
  // intent — a wrong DATABASE_URL is not something to warn about and proceed
  // past, because the first beforeAll that runs may already have destroyed data.
  assertSafeE2eDatabaseUrl(
    process.env.DATABASE_URL,
    process.env,
    'the DB-backed test files TRUNCATE, DELETE, DROP TABLE and apply migrations against it',
  );
  if (process.env.GBRAIN_DEBUG_PRELOAD === '1') {
    console.error('[db-guard-preload] DATABASE_URL accepted');
  }
}
