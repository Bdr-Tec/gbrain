#!/usr/bin/env node
/**
 * Thin CLI shim for the embedding-default eval harness.
 *
 * Spawns the TypeScript runner via `bun` because the runner imports gbrain's
 * gateway + metric implementations from `src/` directly. Same pattern as
 * evals/functional-area-resolver/harness.mjs — this file exists so users can
 * run `node harness.mjs` without remembering the bun incantation.
 *
 * Exits 2 with a clear message if `bun` isn't on PATH or this isn't a gbrain
 * checkout: the harness is a maintainer-side tool, not a portable one.
 */

import { spawnSync, execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runnerPath = resolve(__dirname, 'harness-runner.ts');
const gatewayPath = resolve(__dirname, '..', '..', 'src', 'core', 'ai', 'gateway.ts');

function fail(message, code = 2) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

try {
  execFileSync('which', ['bun'], { stdio: 'ignore' });
} catch {
  fail(
    'harness.mjs: `bun` is not on PATH.\n' +
    'This harness is a gbrain-maintainer-side tool — run it from a gbrain\n' +
    'repo checkout with `bun` installed (https://bun.sh).',
  );
}

if (!existsSync(gatewayPath)) {
  fail(
    `harness.mjs: cannot find gbrain gateway at ${gatewayPath}.\n` +
    'Run this from a gbrain repo checkout, not from an installed skillpack.',
  );
}

if (!existsSync(runnerPath)) fail(`harness.mjs: runner missing at ${runnerPath}`);

const result = spawnSync('bun', ['run', runnerPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: __dirname,
});

process.exit(result.status ?? 1);
