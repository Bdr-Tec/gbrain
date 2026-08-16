#!/usr/bin/env bash
# Wave security scan — the repeatable mechanical sweep for community-PR waves.
#
# Runs the high-recall checks a maintainer should apply to a batch of external
# contributions BEFORE shipping a collector branch (see docs/RELEASING.md,
# "Community PR wave process"). It is NOT a proof of safety — it is a fast net
# that surfaces the shapes worth a human look: newly-introduced outbound
# endpoints, obfuscation/eval, new process spawns, new env reads, dependency
# changes, secrets (gitleaks with the test/skills allowlist STRIPPED), and any
# change to the committed admin bundle.
#
# Usage:
#   scripts/wave-security-scan.sh <base>..<head>     # explicit range
#   scripts/wave-security-scan.sh <base> <head>      # two refs
#   scripts/wave-security-scan.sh                    # defaults to origin/master..HEAD
#   scripts/wave-security-scan.sh --json <range>     # machine-readable summary
#
# Exit code: 0 = nothing high-signal; 1 = high-signal hit(s) worth review;
#            2 = usage / environment error. Findings are advisory: exit 1 means
#            "look", not "unsafe".
#
# On-demand only (never wired into the hot CI path): gitleaks-over-history and
# the per-file diff walk are too slow for every push.

set -euo pipefail
cd "$(dirname "$0")/.."

JSON=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --json) JSON=1 ;;
    *) ARGS+=("$a") ;;
  esac
done

# --- Resolve the commit range (guard empty / non-git / bad refs) ---
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "wave-security-scan: not a git repository" >&2
  exit 2
fi

RANGE=""
if [ "${#ARGS[@]}" -eq 0 ]; then
  if git rev-parse --verify -q origin/master >/dev/null; then
    RANGE="origin/master..HEAD"
  else
    RANGE="HEAD~1..HEAD"
  fi
elif [ "${#ARGS[@]}" -eq 1 ]; then
  RANGE="${ARGS[0]}"
elif [ "${#ARGS[@]}" -eq 2 ]; then
  RANGE="${ARGS[0]}..${ARGS[1]}"
else
  echo "wave-security-scan: too many arguments" >&2
  exit 2
fi

# Normalise `a..b`; verify both endpoints resolve.
BASE="${RANGE%%..*}"
HEAD="${RANGE##*..}"
if [ "$BASE" = "$RANGE" ] || [ -z "$BASE" ] || [ -z "$HEAD" ]; then
  echo "wave-security-scan: range must be <base>..<head> (got '$RANGE')" >&2
  exit 2
fi
if ! git rev-parse --verify -q "$BASE^{commit}" >/dev/null || ! git rev-parse --verify -q "$HEAD^{commit}" >/dev/null; then
  echo "wave-security-scan: cannot resolve one end of '$RANGE'" >&2
  exit 2
fi

COMMIT_COUNT=$(git rev-list --count "$RANGE" 2>/dev/null || echo 0)
if [ "$COMMIT_COUNT" -eq 0 ]; then
  echo "wave-security-scan: empty range ($RANGE) — nothing to scan" >&2
  [ "$JSON" -eq 1 ] && echo '{"range":"'"$RANGE"'","commits":0,"findings":{},"high_signal":0}'
  exit 0
fi

# Generated / minified / vendored artifacts: excluded from the CONTENT greps
# (they trip every obfuscation heuristic and drown real signal), but admin/dist
# changes are still surfaced separately below (that is a real threat artifact).
is_scannable() {
  case "$1" in
    admin/dist/*|*/admin/dist/*) return 1 ;;
    llms.txt|llms-full.txt) return 1 ;;
    *.snapshot|*.snap|*.tar|*.tgz|*.wasm|*.png|*.jpg|*.jpeg|*.gif|*.pdf|*.ico) return 1 ;;
    bun.lock|*/bun.lock|package-lock.json|yarn.lock) return 1 ;;
    *) return 0 ;;
  esac
}

TMP=$(mktemp -d /tmp/wave-scan.XXXXXX)
trap 'rm -rf "$TMP"' EXIT

# --- Build the added-line corpus (content-scannable files only) ---
: > "$TMP/added.txt"
git diff --no-color --unified=0 "$RANGE" -- . 2>/dev/null | awk '
  /^\+\+\+ /{ f=$0; sub(/^\+\+\+ b\//,"",f); next }
  /^\+/ && !/^\+\+\+/ { line=$0; sub(/^\+/,"",line); print f"\t"line }
' > "$TMP/added_all.txt" || true
while IFS=$'\t' read -r f rest; do
  [ -z "$f" ] && continue
  if is_scannable "$f"; then printf '%s\t%s\n' "$f" "$rest" >> "$TMP/added.txt"; fi
done < "$TMP/added_all.txt"

# Python does the regex work (BSD grep/ugrep differ; python is portable).
python3 - "$TMP/added.txt" "$TMP" <<'PY'
import re, sys, json
added = sys.argv[1]; tmp = sys.argv[2]
rows = []
for line in open(added, encoding='utf-8', errors='replace').read().splitlines():
    p = line.split('\t', 1)
    if len(p) == 2:
        rows.append(p)

CODE_EXT = ('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sh', '.bash')
def is_code(f):
    return f.endswith(CODE_EXT)
def is_test(f):
    return f.startswith('test/') or '/test/' in f or f.startswith('skills/')

# Code-shaped checks fire on CODE FILES only (obfuscation/eval in a .md is prose,
# not a payload). ALARM checks (exit 1) are the low-false-positive ones:
# obfuscation/eval in code. The rest are INFORMATIONAL context for the reviewer.
checks = {
  'obfuscation': (True, lambda f, c: is_code(f) and bool(re.search(
        r'\beval\s*\(|new\s+Function\s*\(|\batob\s*\(|Buffer\.from\([^)]*[\'"]base64|String\.fromCharCode|(\\x[0-9a-fA-F]{2}){4,}|[A-Za-z0-9+/]{120,}={0,2}', c))),
  'outbound_url': (False, lambda f, c: bool(re.search(r'https?://|wss?://', c))
        and not re.search(r'localhost|127\.0\.0\.1|0\.0\.0\.0|example\.(com|org|net|test|invalid)|\.example\b|schema|xmlns|w3\.org|json-schema|spdx|in-toto\.io|slsa\.dev|sigstore|githubusercontent|github\.com/garrytan/gbrain', c)),
  'new_spawn_exec': (False, lambda f, c: is_code(f) and bool(re.search(r'child_process|execSync|\bexecFileSync|\bspawnSync|\bspawn\s*\(|Bun\.spawn|shell\s*:\s*true', c)) and f.startswith(('src/', 'scripts/'))),
  'new_env_read': (False, lambda f, c: is_code(f) and bool(re.search(r'(?:process|Bun)\.env[.\[]', c)) and f.startswith('src/')),
}
results = {k: [] for k in checks}
for f, c in rows:
    for k, (_alarm, pred) in checks.items():
        try:
            if pred(f, c):
                results[k].append((f, c.strip()[:160]))
        except re.error:
            pass

# alarm_total drives exit 1; informational checks are printed but never fail.
summary = {}
alarm_total = 0
for k, hits in results.items():
    alarm = checks[k][0]
    summary[k] = {'total': len(hits), 'alarm': alarm, 'sample': hits[:8]}
    if alarm:
        alarm_total += len(hits)

json.dump({'checks': summary, 'alarm': alarm_total}, open(tmp + '/checks.json', 'w'))
PY

# --- Dependency diff ---
DEP_CHANGED=0
if ! git diff --quiet "$RANGE" -- package.json bun.lock 2>/dev/null; then DEP_CHANGED=1; fi

# --- Admin bundle change (WS1 threat artifact — always flag for manual review) ---
ADMIN_DIST_CHANGED=0
if git diff --name-only "$RANGE" -- 'admin/dist' 2>/dev/null | grep -q .; then ADMIN_DIST_CHANGED=1; fi

# --- gitleaks with the test/skills allowlist STRIPPED (temp config; never edits repo .gitleaks.toml) ---
GITLEAKS_HITS="n/a"
if command -v gitleaks >/dev/null 2>&1; then
  # extend useDefault = gitleaks' built-in rules WITHOUT the repo .gitleaks.toml
  # (which allowlists test/ + skills/) — the whole point is to see the blind spot.
  printf '[extend]\nuseDefault = true\n' > "$TMP/gitleaks.toml"
  if gitleaks git --no-banner -c "$TMP/gitleaks.toml" --log-opts="$RANGE" --report-format json --report-path "$TMP/leaks.json" >/dev/null 2>&1; then
    GITLEAKS_HITS=0
  else
    GITLEAKS_HITS=$(python3 -c "import json;print(len(json.load(open('$TMP/leaks.json'))))" 2>/dev/null || echo "?")
  fi
fi

# --- Report ---
ALARM=$(python3 -c "import json;print(json.load(open('$TMP/checks.json'))['alarm'])")
LEAK_SIGNAL=0
if [ "$GITLEAKS_HITS" != "n/a" ] && [ "$GITLEAKS_HITS" != "0" ] && [ "$GITLEAKS_HITS" != "?" ]; then LEAK_SIGNAL=$GITLEAKS_HITS; fi

if [ "$JSON" -eq 1 ]; then
  python3 - "$TMP/checks.json" "$RANGE" "$COMMIT_COUNT" "$DEP_CHANGED" "$ADMIN_DIST_CHANGED" "$GITLEAKS_HITS" <<'PY'
import json, sys
checks = json.load(open(sys.argv[1]))
out = {
  'range': sys.argv[2], 'commits': int(sys.argv[3]),
  'checks': checks['checks'], 'alarm': checks['alarm'],
  'dependency_changed': sys.argv[4] == '1',
  'admin_dist_changed': sys.argv[5] == '1',
  'gitleaks_hits': sys.argv[6],
}
print(json.dumps(out))
PY
else
  echo "wave-security-scan  range=$RANGE  commits=$COMMIT_COUNT"
  echo "  (ALARM = exit 1, worth review before ship; other rows are context)"
  echo "-------------------------------------------------------------"
  python3 - "$TMP/checks.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))['checks']
labels = {'obfuscation':'obfuscation / eval (code)','outbound_url':'new outbound URLs/hosts','new_spawn_exec':'new spawn/exec (src/scripts)','new_env_read':'new env reads (src)'}
for k, lab in labels.items():
    s = c[k]
    tag = 'ALARM' if s['alarm'] else 'info '
    flag = '  <-- REVIEW' if (s['alarm'] and s['total']) else ''
    print(f"  [{tag}] {lab:30} count={s['total']}{flag}")
    for f, snip in s['sample'][:4]:
        print(f"          {f}: {snip[:100]}")
PY
  echo "  [info ] dependency change (package.json/bun.lock): $([ "$DEP_CHANGED" = 1 ] && echo YES || echo no)"
  echo "  [ALARM] admin/dist change (bundle-backdoor artifact):  $([ "$ADMIN_DIST_CHANGED" = 1 ] && echo 'YES <-- REVIEW' || echo no)"
  echo "  [ALARM] gitleaks (test/skills allowlist stripped):     $GITLEAKS_HITS"
  echo "-------------------------------------------------------------"
fi

if [ "$ALARM" -gt 0 ] || [ "$LEAK_SIGNAL" -gt 0 ] || [ "$ADMIN_DIST_CHANGED" = 1 ]; then
  exit 1
fi
exit 0
