#!/usr/bin/env bash
# scripts/run-serial-tests.sh — run *.serial.test.ts files with --max-concurrency=1.
#
# Serial files are tests that share file-wide state (top-level mock.module,
# module-level singletons that intentionally cross test cases) and would race
# under intra-file concurrency. Discovered via filename suffix; no annotation
# inside the file is needed.
#
# Excluded by run-unit-shard.sh and run-unit-parallel.sh's parallel pass.
# Invoked separately by run-unit-parallel.sh after the parallel pass succeeds.

set -euo pipefail

cd "$(dirname "$0")/.."

# Use while-read for portability to macOS bash 3.2 (no mapfile).
files=()
while IFS= read -r f; do
  files+=("$f")
done < <(find test -name '*.serial.test.ts' -not -path 'test/e2e/*' | sort)

if [ "${#files[@]}" -eq 0 ]; then
  echo "[serial-tests] no *.serial.test.ts files found"
  exit 0
fi

# --dry-run-list mirrors run-unit-shard.sh for inline checks/tests.
if [ "${1:-}" = "--dry-run-list" ]; then
  printf '%s\n' "${files[@]}"
  exit 0
fi

echo "[serial-tests] running ${#files[@]} file(s), one bun process per file"

# Each serial file gets its OWN bun process. `--max-concurrency=1` was not
# enough: files in the same process share the module registry, so a top-level
# `mock.module(...)` in one file leaks into the next file's imports
# (eval-takes-quality-runner mocks gateway.ts and the next file fails on
# `import { resetGateway }` because the mock factory didn't export it).
# Per-file processes give true isolation; cost is ~100ms startup × N files.
fail_count=0
failed_files=()
idx=0
for f in "${files[@]}"; do
  idx=$((idx + 1))
  # COVERAGE_DIR (opt-in): each serial file runs in its OWN bun process, so
  # each process needs its OWN coverage dir — a second bun process reusing a
  # coverage dir OVERWRITES lcov.info. Empty/unset COVERAGE_DIR leaves the
  # exec line byte-identical to the pre-coverage behavior.
  COVERAGE_ARGS=()
  if [ -n "${COVERAGE_DIR:-}" ]; then
    COVERAGE_ARGS=(--coverage --coverage-reporter=lcov --coverage-dir="$COVERAGE_DIR/serial-$idx")
  fi
  if ! bun test --max-concurrency=1 --timeout=60000 ${COVERAGE_ARGS[@]+"${COVERAGE_ARGS[@]}"} "$f"; then
    fail_count=$((fail_count + 1))
    failed_files+=("$f")
  fi
done

# Lane manifest: written ONLY on a fully green run (complete:true means the
# lcov data represents every serial file). Failure exit codes below are
# preserved unchanged.
if [ -n "${COVERAGE_DIR:-}" ] && [ "$fail_count" -eq 0 ]; then
  LCOV_COUNT=$(find "$COVERAGE_DIR" -name 'lcov.info' 2>/dev/null | grep -c '^' || true)
  printf '{"lane":"serial","sha":"%s","lcovCount":%s,"complete":true}\n' \
    "$(git rev-parse HEAD)" "${LCOV_COUNT:-0}" > "$COVERAGE_DIR/lane-manifest.json"
fi

if [ "$fail_count" -gt 0 ]; then
  echo "" >&2
  echo "[serial-tests] $fail_count file(s) failed:" >&2
  for f in "${failed_files[@]}"; do
    echo "  - $f" >&2
  done
  exit 1
fi
echo "[serial-tests] all ${#files[@]} file(s) passed"
