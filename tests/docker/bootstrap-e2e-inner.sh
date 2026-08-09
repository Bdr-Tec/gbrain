#!/usr/bin/env bash
# tests/docker/bootstrap-e2e-inner.sh — the networkless bootstrap flow that
# runs INSIDE the container built by tests/docker/Dockerfile [A7].
#
# Invoked by tests/docker/bootstrap-e2e.sh as:
#   docker run --rm --network none --read-only --cap-drop ALL --tmpfs /tmp ...
#     bash /app/tests/docker/bootstrap-e2e-inner.sh
#
# Flow (the cold-machine paste-in, minus the human):
#   offline guard → scripted interview → confirm → render → fake-gh repo
#   phase (local bare origin, privacy verified through the shim) →
#   ABORT_AFTER kill mid-render on a second workspace → `status` resumes →
#   re-run converges → keyless verify against a temp PGLite brain, exit 0.
#
# Everything writable lives under /tmp (the only tmpfs in the read-only
# container). No network, no gh, no provider keys — the decline-everything
# posture must still complete honestly.
#
# Local (no-docker) smoke of the SAME flow — used to validate the script's
# own plumbing when the docker daemon is unavailable:
#   S="$(mktemp -d)" && GBRAIN_E2E_SCRATCH="$S" GBRAIN_E2E_APP="$PWD" \
#     GBRAIN_E2E_ALLOW_NETWORK=1 HOME="$S/home" GBRAIN_HOME="$S/gb" \
#     bash tests/docker/bootstrap-e2e-inner.sh
set -euo pipefail

APP="${GBRAIN_E2E_APP:-/app}"
SCRATCH="${GBRAIN_E2E_SCRATCH:-/tmp}"
export HOME="${HOME:-$SCRATCH/home}"
export GBRAIN_HOME="${GBRAIN_HOME:-$SCRATCH/gb}"
export TMPDIR="${TMPDIR:-$SCRATCH}"
export GBRAIN_SKIP_STARTUP_HOOKS=1
# Keyless by construction: strip any provider keys the runner env leaked in.
unset OPENAI_API_KEY ANTHROPIC_API_KEY VOYAGE_API_KEY ZEROENTROPY_API_KEY \
      OPENROUTER_API_KEY DASHSCOPE_API_KEY GOOGLE_GENERATIVE_AI_API_KEY \
      GEMINI_API_KEY DATABASE_URL GBRAIN_DATABASE_URL GBRAIN_BRAIN_ID 2>/dev/null || true

mkdir -p "$HOME" "$GBRAIN_HOME/.gbrain" "$SCRATCH/bin"

gbrain() { bun run "$APP/src/cli.ts" "$@"; }
step() { printf '\n== %s ==\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# ── Offline guard: prove --network none is actually in effect ───────────────
# GBRAIN_E2E_ALLOW_NETWORK=1 is the LOCAL-SMOKE-ONLY bypass (see header); the
# CI/docker path never sets it, so the guard stays load-bearing there.
if [ "${GBRAIN_E2E_ALLOW_NETWORK:-0}" != "1" ]; then
  step "offline guard"
  cat > "$SCRATCH/net-probe.ts" <<'EOF'
const t = setTimeout(() => process.exit(1), 4000);
fetch('https://example.com/').then(
  () => { clearTimeout(t); process.exit(0); },  // reachable → harness misconfigured
  () => { clearTimeout(t); process.exit(1); },
);
EOF
  if bun "$SCRATCH/net-probe.ts"; then
    fail "network is reachable — run this container with --network none"
  fi
  echo "network unreachable, as required"
else
  step "offline guard BYPASSED (GBRAIN_E2E_ALLOW_NETWORK=1 — local smoke only)"
fi

# ── Fake gh shim (argv-compatible with src/core/bootstrap/repo.ts) ──────────
# `repo create` only ADDS the origin remote (the fake absorbs --push, exactly
# like the in-repo lifecycle e2e's shim) — nothing ever leaves the container.
# Privacy probes answer the literal "true" the G8 gate requires.
step "fake gh shim"
cat > "$SCRATCH/bin/gh" <<'EOF'
#!/bin/sh
case "$1" in
  --version) echo "gh version 2.40.0 (offline-fake)"; exit 0 ;;
  auth) exit 0 ;;
  api)
    case "$2" in
      user) echo '{"login":"tester","id":42}'; exit 0 ;;
      repos/*) echo "true"; exit 0 ;;
    esac
    exit 1 ;;
  repo)
    case "$2" in
      view)
        case "$*" in
          *--json*) echo "true"; exit 0 ;;
        esac
        exit 1 ;;
      create)
        name="$3"
        src=""
        prev=""
        for a in "$@"; do
          if [ "$prev" = "--source" ]; then src="$a"; fi
          prev="$a"
        done
        if [ -n "$src" ]; then
          git -C "$src" remote add origin "https://github.com/tester/$name.git" >/dev/null 2>&1 || true
        fi
        exit 0 ;;
    esac
    exit 1 ;;
esac
exit 0
EOF
chmod +x "$SCRATCH/bin/gh"
export PATH="$SCRATCH/bin:$PATH"

# ── Engine phase artifact: keyless PGLite config ─────────────────────────────
step "engine config"
cat > "$GBRAIN_HOME/.gbrain/config.json" <<EOF
{ "engine": "pglite", "database_path": "$GBRAIN_HOME/db" }
EOF

# ── Workspace + scripted interview helper ───────────────────────────────────
run_interview() {
  ws="$1"
  gbrain bootstrap interview --init --workspace "$ws" > /dev/null
  gbrain bootstrap interview --set AGENT_NAME "Lanternfish" --workspace "$ws" > /dev/null
  gbrain bootstrap interview --set PRINCIPAL_NAME "Pat Example" --workspace "$ws" > /dev/null
  gbrain bootstrap interview --set AGENT_PURPOSE "Maintain the research corpus and draft the weekly memo without re-briefing." --workspace "$ws" > /dev/null
  gbrain bootstrap interview --set AGENT_TOP_JOBS "- corpus upkeep
- weekly memo
- meeting prep" --workspace "$ws" > /dev/null
  gbrain bootstrap interview --set PRINCIPAL_CONTEXT "Runs a small research group; builds internal tooling; values signal over noise." --workspace "$ws" > /dev/null
  gbrain bootstrap interview --set VOICE_REGISTER "Direct: three options, the second one wins." --workspace "$ws" > /dev/null
  gbrain bootstrap interview --set MCP_SCOPE "project" --workspace "$ws" > /dev/null
  gbrain bootstrap interview --set HOOKS_CONSENT "no" --workspace "$ws" > /dev/null
  gbrain bootstrap interview --set PERSIST_CRON "no" --workspace "$ws" > /dev/null
  hash="$(gbrain bootstrap interview --status --workspace "$ws" | sed -n 's/.*read-back hash: \([0-9a-f][0-9a-f]*\).*/\1/p')"
  [ -n "$hash" ] || fail "no read-back hash from interview --status ($ws)"
  gbrain bootstrap interview --confirm "$hash" --workspace "$ws" > /dev/null
}

step "workspace + interview + confirm"
WS="$SCRATCH/ws"
mkdir -p "$WS/brain"
git init -q -b main "$WS"
git -C "$WS" config user.email test@example.com
git -C "$WS" config user.name Test
run_interview "$WS"

# ── Render ───────────────────────────────────────────────────────────────────
step "render"
gbrain bootstrap render --workspace "$WS"
[ -f "$WS/SOUL.md" ] || fail "SOUL.md not rendered"
[ -f "$WS/AGENTS.md" ] || fail "AGENTS.md not rendered"
grep -Fq "Per-message gates" "$WS/AGENTS.md" || fail "AGENTS.md missing template content"
grep -Fq "Lanternfish" "$WS/SOUL.md" || fail "SOUL.md missing interview answer"
grep -Fq '"initialized": true' "$WS/agent.json" || fail "agent.json not flipped to initialized"

# ── Repo phase through the fake gh (offline: local bare origin) ─────────────
step "repo (fake gh)"
gbrain bootstrap repo --workspace "$WS"
origin="$(git -C "$WS" remote get-url origin)"
[ -n "$origin" ] || fail "no origin after repo phase"
grep -Fq "$origin" "$WS/GITHUB.md" || fail "GITHUB.md not refreshed with the repo URL"

# ── ABORT_AFTER kill mid-render on a second workspace → status resumes ──────
step "ABORT_AFTER kill + status resume"
WS2="$SCRATCH/ws2"
mkdir -p "$WS2/brain"
run_interview "$WS2"
set +e
GBRAIN_BOOTSTRAP_ABORT_AFTER=render gbrain bootstrap render --workspace "$WS2"
rc=$?
set -e
[ "$rc" -eq 130 ] || fail "expected exit 130 from the injected abort, got $rc"
# The artifacts landed before the abort, so status resumes render as done.
status_out="$(gbrain bootstrap status --workspace "$WS2")"
printf '%s\n' "$status_out" | grep -Fq "[done   ] render" || fail "status did not resume render as done after the abort"
# Re-run converges (idempotent render, exit 0).
gbrain bootstrap render --workspace "$WS2" > /dev/null

# ── Keyless verify against a temp PGLite brain ───────────────────────────────
step "sources add + keyless verify"
gbrain sources add workspace --path "$WS/brain" --force
gbrain bootstrap verify --workspace "$WS" --json > "$SCRATCH/verify.json"
grep -Fq '"ok": true' "$SCRATCH/verify.json" || fail "verify did not pass"
grep -Fq '"mode": "keyless"' "$SCRATCH/verify.json" || fail "capability report is not keyless"
grep -Fq 'smoke not applicable' "$SCRATCH/verify.json" || fail "hooks_smoke degradation not named"

echo
echo "PASS: offline bootstrap e2e (interview -> render -> repo -> abort/resume -> keyless verify)"
