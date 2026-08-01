#!/usr/bin/env bash
# provision-scopes.sh — roster-driven gbrain provisioning for a qm deployment
# (or any multi-user agent harness with per-person + per-channel scopes).
#
# Reads a roster of channels + employees and converges the brain to it:
#   - ensures the shared agent-memory source exists (path-less: agents write
#     pages into it over MCP; `gbrain sync` skips it; if the brain host has
#     sync.repo_path configured, pages also write through to .sources/<id>/
#     on disk for git-backed durability)
#   - registers one OAuth client per employee, write-fenced via
#     bound_slug_prefixes to emp-<slug>/ plus chan-<c>/ for each channel
#     they are in, with federated reads over the memory source + any
#     read-only sources you pass
#   - re-running after roster edits rescopes existing clients IN PLACE
#     (client ids are remembered in the state file; secrets never rotate
#     unless you revoke + delete the state row)
#
# Usage:
#   provision-scopes.sh roster.tsv \
#     [--memory-source agents] [--read-sources org-wiki,handbook] \
#     [--budget-usd-per-day 5] [--state-file roster.state.tsv] \
#     [--secrets-out new-credentials.tsv] [--gbrain gbrain] [--dry-run]
#
# Roster format (one entry per line; '#' comments and blank lines ignored):
#   channel <slug>
#   employee <slug> [comma-separated channel slugs]
#
# SECURITY: --secrets-out receives client secrets for NEW registrations,
# written exactly once (gbrain never re-shows them). Deliver each row to its
# scope's sandbox (e.g. via the harness keychain or a one-time secret drop),
# then delete the file.
#
# ponytail: sequential CLI loop, one gbrain invocation per roster row — fine
# to hundreds of employees; batch via the admin API if that ever hurts.

set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }

ROSTER="${1:-}"
[ -n "$ROSTER" ] && [ -f "$ROSTER" ] || die "usage: provision-scopes.sh <roster-file> [flags] (roster not found: '$ROSTER')"
shift

GBRAIN="${GBRAIN:-gbrain}"
MEMORY_SOURCE="agents"
READ_SOURCES=""
BUDGET="5"
STATE_FILE=""
SECRETS_OUT=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --memory-source)      MEMORY_SOURCE="$2"; shift 2 ;;
    --read-sources)       READ_SOURCES="$2"; shift 2 ;;
    --budget-usd-per-day) BUDGET="$2"; shift 2 ;;
    --state-file)         STATE_FILE="$2"; shift 2 ;;
    --secrets-out)        SECRETS_OUT="$2"; shift 2 ;;
    --gbrain)             GBRAIN="$2"; shift 2 ;;
    --dry-run)            DRY_RUN=1; shift ;;
    *) die "unknown flag: $1" ;;
  esac
done

STATE_FILE="${STATE_FILE:-${ROSTER}.state.tsv}"
SECRETS_OUT="${SECRETS_OUT:-${ROSTER}.new-credentials.tsv}"

run() {
  if [ "$DRY_RUN" = 1 ]; then echo "DRY-RUN: $GBRAIN $*" >&2; return 0; fi
  # shellcheck disable=SC2086 — $GBRAIN may carry args ("bun run src/cli.ts")
  $GBRAIN "$@"
}

state_lookup() { # state_lookup <employee-slug> -> client_id or empty
  [ -f "$STATE_FILE" ] || return 0
  awk -F'\t' -v s="$1" '$1 == s { print $2; exit }' "$STATE_FILE"
}

# ── Pass 1: parse roster, collect declared channels ─────────────────────────
CHANNELS=""
EMPLOYEES=""
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"
  [ -z "${line//[[:space:]]/}" ] && continue
  # shellcheck disable=SC2086 — deliberate word split of the roster line
  set -- $line
  case "$1" in
    channel)  [ -n "${2:-}" ] || die "roster: 'channel' needs a slug"; CHANNELS="$CHANNELS $2" ;;
    employee) [ -n "${2:-}" ] || die "roster: 'employee' needs a slug"; EMPLOYEES="$EMPLOYEES $2:${3:-}" ;;
    *) die "roster: unknown entry type '$1' (expected 'channel' or 'employee')" ;;
  esac
done < "$ROSTER"

# ── Pass 2: ensure the shared memory source exists (path-less) ──────────────
if out=$(run sources add "$MEMORY_SOURCE" --name "agent memory ($MEMORY_SOURCE)" 2>&1); then
  echo "source '$MEMORY_SOURCE': created"
else
  echo "$out" | grep -q "already registered" || die "sources add failed: $out"
  echo "source '$MEMORY_SOURCE': already exists"
fi

# ── Pass 3: converge one client per employee ────────────────────────────────
FED_READ="$MEMORY_SOURCE${READ_SOURCES:+,$READ_SOURCES}"
new_secrets=0

for entry in $EMPLOYEES; do
  slug="${entry%%:*}"
  chans="${entry#*:}"

  prefixes="emp-$slug/"
  if [ -n "$chans" ]; then
    for c in ${chans//,/ }; do
      echo " $CHANNELS " | grep -q " $c " || echo "WARN: employee '$slug' references undeclared channel '$c'" >&2
      prefixes="$prefixes,chan-$c/"
    done
  fi

  client_id="$(state_lookup "$slug")"
  if [ -n "$client_id" ]; then
    run auth rescope-client "$client_id" \
      --federated-read "$FED_READ" --bound-slug-prefixes "$prefixes" >/dev/null
    echo "employee '$slug': rescoped $client_id  [write: $prefixes]"
  else
    out=$(run auth register-client "qm-emp-$slug" \
      --grant-types client_credentials --scopes "read write" \
      --source "$MEMORY_SOURCE" --federated-read "$FED_READ" \
      --bound-slug-prefixes "$prefixes" --budget-usd-per-day "$BUDGET" 2>&1) \
      || die "register-client failed for '$slug': $out"
    [ "$DRY_RUN" = 1 ] && continue
    client_id=$(echo "$out" | sed -n 's/.*Client ID:[[:space:]]*\(gbrain_cl_[^[:space:]]*\).*/\1/p' | head -1)
    secret=$(echo "$out"    | sed -n 's/.*Client Secret:[[:space:]]*\(gbrain_cs_[^[:space:]]*\).*/\1/p' | head -1)
    [ -n "$client_id" ] && [ -n "$secret" ] || die "could not parse client id/secret for '$slug' from register-client output"
    printf '%s\t%s\n' "$slug" "$client_id" >> "$STATE_FILE"
    printf '%s\t%s\t%s\n' "$slug" "$client_id" "$secret" >> "$SECRETS_OUT"
    new_secrets=$((new_secrets + 1))
    echo "employee '$slug': registered $client_id  [write: $prefixes]"
  fi
done

echo
echo "Done. State: $STATE_FILE"
if [ "$new_secrets" -gt 0 ]; then
  echo "$new_secrets NEW client secret(s) written to $SECRETS_OUT — deliver to each scope's sandbox, then DELETE the file."
fi
