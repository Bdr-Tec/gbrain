// Fake `jobs run-child` for worker-job-isolation.test.ts: honors the
// isolation env contract without needing a compiled gbrain binary or a
// Postgres engine. Mode via FAKE_RUN_CHILD_MODE: success | error | crash.
import { writeFileSync, renameSync } from 'node:fs';

const resultPath = process.env.GBRAIN_JOB_RESULT_PATH;
const mode = process.env.FAKE_RUN_CHILD_MODE ?? 'success';

function writeOutcome(o) {
  writeFileSync(resultPath + '.tmp', JSON.stringify(o));
  renameSync(resultPath + '.tmp', resultPath);
}

if (!resultPath) {
  process.stderr.write('[fake-run-child] missing GBRAIN_JOB_RESULT_PATH\n');
  process.exit(13);
}

if (mode === 'success') {
  writeOutcome({
    outcome: 'success',
    result: {
      fromChild: true,
      token: process.env.GBRAIN_JOB_LOCK_TOKEN ?? null,
      argv: process.argv.slice(2),
    },
  });
  process.exit(0);
}

if (mode === 'error') {
  writeOutcome({
    outcome: 'error',
    errorKind: 'generic',
    message: 'fake child handler failure',
  });
  process.exit(0);
}

// crash: no outcome file
process.exit(1);
