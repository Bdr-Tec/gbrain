# Checkpoint compaction + compiled views

Compaction is the worst moment in a long-lived agent's life: the harness
summarizes the window and the un-extracted detail dies with it. Cathedral 5
makes the brain the durable side of that boundary, in two halves:

1. **Checkpoint compaction** — at the compaction boundary the raw
   pre-compaction window is banked to disk *synchronously* (secret-scanned,
   content-addressed), facts are harvested from it *promptly and
   asynchronously* inside serve, and the post-compaction context carries
   `brain://slug` links the agent re-pulls on demand.
2. **Compiled views** — `gbrain compile-context` regenerates warm-file
   fragments (CLAUDE.md @import fragment, AGENTS.md managed block, OpenClaw
   workspace file) from brain pages: deterministic, token-budgeted,
   sensitivity-scanned, byte-stable under an unchanged brain.

## The durability contract (read this before filing a "links are late" bug)

The boundary guarantee is **bytes durable at the boundary; facts moments
after; links at the next boundary**:

- `gbrain hook compact` (PreCompact, bootstrap-installed) writes the
  since-last-boundary window to `<corpus>/<session>.seg-<hash12>.txt` INSIDE
  its 3s deadline — before any IPC. A hook crash after this point loses
  nothing: the maintenance sweep's corpus pass extracts every `.txt` segment.
- Serve's checkpoint harvest (fire-and-forget from the same IPC round trip
  that banks standing entities) runs the facts pipeline over the segment,
  verifies each candidate link with a source-scoped page read (a link that
  resolves to nothing is never banked), and banks a manifest into
  `session_context_state.checkpoint_manifest`.
- The post-compaction SessionStart (`source=compact`) pack renders the banked
  links as a `## Compaction checkpoints` section. Links that miss the
  immediate pack (harvest still running) surface on the next session start.
  Link-delivery guarantees differ by lane: the harvest FIFO is
  receipt-guaranteed (a failed manifest publish keeps the receipt and
  retries without re-extracting); the sweep backstop and the OpenClaw
  direct-Postgres rung publish links best-effort (facts are always
  at-least-once — re-extracting a whole segment to retry a link append is
  the worse trade). The facts themselves are recallable the moment any lane
  commits them, regardless of link delivery.

## The three extraction lanes and the dedup contract

The same session text is reachable by three lanes. The contract keeps the
happy path exactly-once and every failure path at-least-once (never loss):

| Lane | Trigger | What it extracts |
|---|---|---|
| Checkpoint harvest | PreCompact IPC flush (serve FIFO, cap 8, 60s abort) | the boundary segment |
| Session-end corpus + sweep pass 3 | SessionEnd hook + serve sweep | the post-last-boundary REMAINDER when segment coverage holds; the FULL transcript otherwise |
| `gbrain transcripts ingest --facts` | manual | whatever the operator points it at (operator's explicit choice) |

Coverage is decided by **exact-set hashes**, not counts: session-end
recomputes every boundary window's redacted hash from its own full parse and
requires each in the per-session ledger (`<session>.ledger.json`). A missed
compaction, a deadline'd segment write, or an unreadable ledger all fall back
to the full-transcript write; fact-level dedup absorbs the overlap. Degraded
configs with a chat key but no embedding provider may insert duplicate fence
rows on that fallback (the 0.95 dedup arm needs embeddings) — segmentation
makes this the exception path.

## Harness wirings

- **Claude Code** — zero setup beyond `gbrain bootstrap` (the PreCompact +
  SessionStart hooks are already installed; existing installs pick the
  checkpoint behavior up on upgrade with no re-install). Prompt link
  delivery needs PGLite + a live serve (the IPC flush lane); on a Postgres
  brain the hook still banks the segment and the next sweep pass extracts
  it and publishes the links — delayed to sweep cadence, not lost.
- **OpenClaw** — engine-internal: `compact()` runs the checkpoint step before
  delegating (spool-first; serve IPC on PGLite, direct connection on
  Postgres) and `assemble()` injects the checkpoint block from the banked
  manifest. No hooks, no recipe.
- **Codex / opencode** — not wired in this release. The pull protocol
  (`gbrain context-pack` after compaction, per `docs/guides/ambient-recall.md`)
  is the supported path; a native codex hook lane is a filed follow-up.

## Operational runbook — reason vocabulary

Hook + harvest telemetry rides the hooks heartbeat JSONL
(`<gbrain home>/integrations/hooks/heartbeat.jsonl`; surfaced by doctor and
`readHeartbeatTail`). Counts and codes only — never content.

- `compact` events carry a `segment` code: `segment_banked` / `segment_dup`
  (idempotent retry) / `empty_window` / `deadline_scan` (budget too tight to
  scan — a window is NEVER written unscanned) / `deadline_write` /
  `scan_unavailable` — plus a `flush` code echoing serve's schedule ack:
  `scheduled` / `skip_queue_full` / `skip_not_found` / `skip_bad_basename` /
  `skip_no_session` / `skip_shutting_down` / `skip_already_queued` (absent
  when the IPC round trip never happened).
- `session-end` events carry the corpus mode: `remainder` / `skip_covered` /
  `full_fallback`.
- `checkpoint-harvest` events (serve-side pump outcomes) carry
  `inserted`/`duplicate`/`links` counters and skip reasons: `keyless` /
  `extraction_disabled` / `already_ingested` / `claimed_elsewhere` /
  `aborted` (retryable — nothing was written) / `manifest_failed` (receipt
  kept; the retry re-publishes without re-extracting).

**Single-corpus-dir invariant:** the hook resolves the corpus dir from file
config while serve resolves it from DB config. Keep
`dream.synthesize.session_corpus_dir` consistent (or unset on both) — a split
resolves as a typed `not_found` skip on the flush and the sweep extracts from
wherever the hook actually wrote.

**Remote thin clients:** link re-pull over remote MCP sees world-grade fences
(private-visibility facts are stripped by `get_page`'s trust boundary). The
trusted-local lane (CLI, hooks, IPC) sees the full fence.

## Compiled views

```bash
gbrain compile-context --target claude-code --budget 3000   # .claude/gbrain-context.md
gbrain compile-context --target codex                        # AGENTS.md managed block (also serves opencode)
gbrain compile-context --target openclaw                     # .gbrain/compiled-context.md
gbrain compile-context --target claude-code --check          # exit 1 when the committed file is stale
```

Deterministic by construction: selection anchors recency decay to the newest
`updated_at` among candidates (never wall-clock), ordering is a total order,
and an unchanged brain produces identical bytes across runs and days. The
budget caps the WHOLE file. Content that trips the sensitivity scan (secrets,
PII shapes, operator blocklist/pattern file) drops that page's entry — always
reported, never silent — and `.gbrain-scan-allow` fingerprints un-drop
reviewed false positives uniformly across every detector family. Engine read
errors abort the run without writing; only scan hits drop entries. Pin a page
into every compile with the `compile-context` tag.
