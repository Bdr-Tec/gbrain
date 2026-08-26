# The monthly backup-coverage check

gbrain verifies, once a month, that your brain content and skill files are
backed up to a git remote — and warns you through whatever harness you
actually use when they aren't. The question it answers: **"if this disk died
right now, could I recreate my agent?"**

## What is covered

| Asset | How it's checked | Warn condition |
|---|---|---|
| Source repos (every non-archived source with a `local_path`) | local git probes: `git remote get-url origin`, `rev-list --count`, `status --porcelain` — deduped by git root, capped at 500 roots/run | no `origin` remote (`no_remote`) |
| Bootstrap workspace (skills/, memory/, brain/, identity) | file plane: the install receipt's `repo_url` + the per-root push-status files | receipt without `repo_url` → warn; a failing background push → flagged row only (the push-failure banner owns that alarm) |
| DB-only brain (pages exist, nothing git-backed) | page count + absence of any git-backed asset | warn on PGLite (total loss on disk failure); info on managed Postgres (DB survives, but isn't the git system of record) |
| `db_only` storage-tier pages | `gbrain.yml` per source | info row — dump with `gbrain export --dir <backup-dir>` to somewhere OUTSIDE the gitignored dirs (`--restore-only` is the wrong direction for a backup) |
| Harness-native skill dirs (e.g. the agent's installed skills) | skillpack bridge state | info only — these are installed COPIES; the originals live in repos |

Only `no_remote` flips the overall verdict to **warn**. Push *staleness* of an
existing remote stays with the existing channels (`bootstrap_push_health`, the
push-failure banner).

**Not covered (v1, by design):** the DB file itself (`~/.gbrain` is
deliberately gitignored — the repo is the system of record and the DB rebuilds
via `gbrain sync`); mounted brains; pure-HTTP thin-client installs (no local
CLI on the brain host — nothing there can probe git); network reachability of
the remote (`--probe` is a filed follow-up; "has origin" doesn't prove "can
push").

## Where the warning reaches you

One compute, one cached verdict (`~/.gbrain/backup-status.json`), five render
channels — all bounded by the shared nag budget:

1. **Claude Code banner** (`gbrain hook user-prompt` → `systemMessage`, shown
   directly to you; a pending push-failure banner outranks it).
2. **Claude Code session-start digest** (model-visible note).
3. **MCP tool responses** (one aggregate extra content block per serve
   process — counts only, never paths; reaches Codex, OpenClaw, and
   plugin-only installs).
4. **CLI stderr** on most `gbrain <cmd>` invocations (serve/hook/jobs/call and
   the check's own surfaces are excluded; `--quiet` and
   `GBRAIN_SKIP_STARTUP_HOOKS` silence it). The machine marker
   `BACKUP_LOCAL_ONLY <n>` prints on non-TTY stderr for agents, plus a one-line
   human sentence.
5. **OpenClaw context engine** (one ⚠ line, read-only against the budget).

Nag budget: at most one impression per 24h across channels, at most 3 per
channel per month, at most 3 recorded impressions per month TOTAL. Fixing the
repo (or a new month) re-arms it; ignoring it goes quiet until next month.

## Commands

```
gbrain backup status [--json]   # verdict + per-asset table + fix commands + recovery statement
gbrain backup check  [--json]   # force a recompute now
```

Exit codes: 0 ok / 1 warn / 2 usage error. `status` answers from the cache when it's ok,
recomputes when it's warn or stale, and falls back to the cached verdict with
a note when a running `gbrain serve` holds the PGLite lock (the serve process
refreshes the verdict itself within a day). The `--json` payload includes a
structured `recovery` field.

When does the compute actually run? On any of: `gbrain backup check`, a stale
cache at `backup status`/doctor/advisor time, `gbrain sync` completion, the
serve process (stdio only) when the cache is stale or a warn verdict is >24h
old, and a detached spawn from the session-end hook. Automatic triggers
self-throttle to once per `backup.check_interval_days`. The monthly recompute
can add a few seconds to one local advisor/doctor run (the 500-root probe cap
bounds it).

## Config + kill switches

```
gbrain config set backup.check_enabled false        # off (file plane)
gbrain config set backup.check_interval_days 30     # default 30, min 1
GBRAIN_BACKUP_CHECK=0                               # env kill switch (everything)
GBRAIN_BACKUP_CHECK_DAYS=<n>                        # env interval override (wins over config; min 1)
```

Disabling silences compute AND every render channel, including a stale warn
cache. `GBRAIN_HOOKS=0` already silences the hook channels;
`GBRAIN_SKIP_STARTUP_HOOKS` silences the CLI rail.

## State files (machine-owned, under `~/.gbrain/`)

- `backup-status.json` — the cached verdict. Written only by a successful
  probed compute; deleted automatically when a fix lands (`bootstrap repo`,
  `sources harden`, `sources push` success). A compute that couldn't read the
  brain database returns a `degraded: true` verdict (shown as "verdict is
  partial (not cached)" in `backup status`, and as a `degraded` field in
  `--json`) — it is never persisted and never replaces a probed cache.
- `backup-nag-state.json` — the bounded-nag ledger (per-channel counts, the
  24h dampener, the monthly global cap, the spawn debounce).

Both are fail-open: corrupt or missing files never break a session.

## Privacy

Remote/MCP surfaces render **aggregate counts only** — never a local path or
source id. Full per-asset detail (which repo, which fix) is local-only:
`gbrain backup status` on the brain host.

## Fix recipes

- Workspace with no repo: `gbrain bootstrap repo` (creates a private repo,
  verifies privacy, pushes).
- A source repo with no remote:
  `git remote add origin git@github.com:you/your-brain-repo.git && git push -u origin main`,
  then `gbrain sources harden <source-id>` for auto-push durability.
- Unpushed workspace work: `gbrain sources push --path <workspace>`.
- db_only pages: `gbrain export --dir <backup-dir>` (store the dump outside
  the gitignored dirs — another disk, another repo, anywhere durable).

## Recovery drill (prove the answer is real)

An unverified recovery path is as fake as an unverified backup. Once a
quarter, on a scratch machine or empty directory:

1. `git clone git@github.com:you/your-brain-repo.git && cd your-brain-repo`
2. `gbrain bootstrap attach` — the body travels; identity, memory, and skills
   come back from the repo.
3. Re-add any extra sources: `gbrain sources add <id> --path ../your-wiki`
   (or `--url` for managed clones).
4. `gbrain sync && gbrain embed` — the brain database rebuilds from the repos.
5. `gbrain doctor` — green means the agent is recreated.

If any step fails, that's the gap the monthly check exists to catch — fix it
while the original disk still works.
