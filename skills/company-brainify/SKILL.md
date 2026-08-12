---
name: company-brainify
version: 1.0.0
description: >
  Extract a sanitized shared team/company brain from a personal brain.
  Strips internal ratings, compensation, performance assessments, retention
  and political dynamics from pages, takes, and facts across the full scan
  scope (people, companies, meetings, dailies, cross-references — not just
  people/), verifies with grep + retrieval passes, and purges sensitive git
  history behind the data-loss-gate confirmation card. Also runs as a
  report-only re-audit on an existing shared brain.
triggers:
  - "company brain"
  - "team brain"
  - "brainify"
  - "sanitize the brain"
  - "share my brain with the team"
  - "strip sensitive data from the brain"
  - "scrub employee data"
  - "audit the shared brain"
  - "make the brain safe to share"
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
  - meetings/
  - daily/
  - projects/
  - analysis/
upstream: company-brainify@fc834ee
# Brain-first in its native form: Phase-1 discovery runs through gbrain
# retrieval (query/search/takes search/recall), and every edit is grounded
# in a full read of the actual page. writes_to lists the scan scope the
# skill edits IN PLACE — it does not create new pages there, except the
# deletion-log entry under daily/ required by data-loss-gate Step 4.
brain_first: true
---

# company-brainify — Personal → Team-Brain Sanitization

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md) —
> discovery runs through the brain's own retrieval, not filesystem guesswork.
> The grep pipelines below TRIAGE; `gbrain query` finds what keyword patterns miss.
>
> **Convention:** see [conventions/test-before-bulk.md](../conventions/test-before-bulk.md) —
> sanitize 3-5 files, read the output yourself, then ramp. A bad bulk
> sanitization pass is worse than none: it looks done and isn't.
>
> **Convention:** see [conventions/regex-discipline.md](../conventions/regex-discipline.md) —
> "is this sensitive?" is a judgment call, so the model decides per file. The
> grep patterns are earned triage/verification tools, never the judge.
>
> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) —
> edits stay in the page's existing directory; the deletion log files
> date-keyed under `daily/`.

## The Problem

Personal brains accumulate everything — company knowledge, meeting notes,
internal assessments, compensation details, management strategy, candid
opinions about the people you work with. When you stand up a shared team
brain from that personal brain (see `docs/architecture/brains-and-sources.md`
for the team-mount topology), all of that has to go. The knowledge is
valuable; the sensitive metadata is a liability.

Clean working-tree files alone are NOT enough: git history still carries every
pre-sanitization version, and gbrain takes/facts carry evaluative claims
outside the page prose. This skill handles all three surfaces — pages,
takes/facts, and history.

## When to Use

- Standing up a shared company brain from a founder/exec's personal brain
- Auditing an existing shared brain for sensitive content that shouldn't be there
- Onboarding new team members to a brain repo that must be verified clean first
- Periodic hygiene pass on a shared brain that re-accumulates sensitive data

## What Gets Removed

### Always strip (non-negotiable)

| Category | Examples |
|----------|----------|
| **Internal scores/ratings** | `score:`, `rating:`, `skill:`, or any vertical-specific `*_score:` frontmatter field; any numeric rating of a person |
| **Compensation** | Salary, equity, carry, option grants, comp changes, retention packages |
| **Performance assessments** | Strengths/weaknesses sections about employees, "at risk" flags, underperformance mentions, "picking up slack" references |
| **Departure/retention** | Who's considering leaving, who was convinced to stay, departure rumors, retention conversations |
| **Management strategy** | How-to-manage-someone sections, "the hard conversation" notes, scope/title management plans |
| **Internal political dynamics** | Who doesn't like whom, who's nervous about whom, adversarial relationships, power dynamics |
| **Personal PII** | Phone numbers, personal email addresses, home addresses, family or medical details, personal legal matters, personal-life details |
| **Takes/facts** | Any take or fact referencing the above categories — performance, comp, retention, weakness, management risk |

### Always keep

| Category | Examples |
|----------|----------|
| **Professional identity** | Name, role, title, work email, LinkedIn |
| **What they're building** | Current projects, product work, technical contributions |
| **Career arc** | Prior companies, education, professional background (public info) |
| **Professional beliefs** | Their views on technology, strategy, product philosophy |
| **Timeline of work** | Meeting attendance, project milestones, launches (factual, not evaluative) |
| **Skills/expertise** | Technical capabilities, domain knowledge |

## Scan Scope — Wider Than people/

Sensitive content leaks far beyond people pages. The scan scope is:

- `people/` — the primary surface (frontmatter fields, assessment sections)
- `meetings/` — transcripts and minutes with candid assessments
- `daily/` — daily notes referencing comp/performance/retention conversations
- `companies/`, `projects/`, `analysis/` — cross-references to removed content
- **Takes** — evaluative claims in page takes fences (`gbrain takes search`)
- **Facts** — hot-memory facts (`gbrain recall --grep`)
- **Back-links** — after edits, `gbrain check-backlinks check` confirms no page
  still points at removed sections

A pass that only covers `people/` will certify a brain that still leaks.

## Procedure

All paths below are relative to the brain repo root:

```bash
BRAIN="$(gbrain config get sync.repo_path)"
cd "$BRAIN"
```

### Phase 1: Identify scope (retrieval-first)

1. Retrieval discovery — hybrid search catches judgment-shaped content that no
   keyword pattern will:

   ```bash
   gbrain query "compensation, equity, or salary discussions about team members" --limit 50
   gbrain query "performance concerns, underperformance, or who is struggling" --limit 50
   gbrain query "considering leaving, retention conversations, departure rumors" --limit 50
   gbrain takes search "performance" --limit 50
   gbrain recall --grep "salary"
   ```

   Collect every returned slug into the scope list.

2. Structural discovery — people files that belong to the company, plus
   keyword hits across the wider scan scope:

   ```bash
   grep -rli 'company: *"acme-example"' people/ --include="*.md" | sort > /tmp/brainify-scope.txt
   grep -rli -E 'salary|equity|carry|retention|underperform|performance review|hard conversation' \
     meetings/ daily/ companies/ projects/ analysis/ --include="*.md" 2>/dev/null >> /tmp/brainify-scope.txt
   sort -u -o /tmp/brainify-scope.txt /tmp/brainify-scope.txt
   ```

3. Cross-reference against the company's public people page (website,
   LinkedIn) to catch files using different frontmatter conventions.

4. Count: `wc -l /tmp/brainify-scope.txt`

### Phase 2: Triage sensitivity

Prioritize by hit density (portable `grep -E`; no `\b` — BSD and GNU disagree):

```bash
while read -r f; do
  hits=$(grep -c -i -E 'carry|salary|equity|comp change|departure|considering leaving|retention|underperform|picking up slack|performance review|management risk|hard conversation|nervou|score: *[0-9]|firing|fired|pip|probation|weakness' "$f" 2>/dev/null || true)
  [ "${hits:-0}" -gt 0 ] && echo "$hits $f"
done < /tmp/brainify-scope.txt | sort -rn > /tmp/brainify-triage.txt
```

High-hit files need full judgment passes. Zero-hit files may only need
frontmatter field removal — but they still get read (regex triages, the model
judges).

### Phase 3: Sanitize (test first, then parallel)

Per test-before-bulk: do 3-5 files first, read the results, then ramp. For
large sets (50+ files), batch into groups of 10-12 and spawn parallel
subagents. Per file:

1. Read the file completely
2. Remove all content matching the "Always strip" categories
3. Frontmatter: delete rating/comp field lines entirely
4. Sections: remove entire sections (assessment weaknesses, team dynamics,
   management strategy)
5. Takes fences: remove entire rows that reference sensitive categories —
   a take like "alice-example believes charlie-example is underperforming"
   reveals both the opinion and who holds it; remove the whole take, never
   just the attribution
6. Inline mentions: surgically edit sentences/paragraphs
7. Write the cleaned file back

**Decision rule:** use `Edit` for surgical removal when only a few sections
need it. Use `Write` to rewrite the entire file only when sensitive content is
deeply interwoven throughout.

**Facts:** expire sensitive facts with `gbrain forget <fact-id>` (find them via
`gbrain recall --grep`). Note `forget` is an audit-preserving expiry, not a
hard delete — expired facts stay reachable via `--include-expired`. This is
moot when the team brain is built fresh from the sanitized repo (the personal
DB never transfers); when auditing an existing shared brain in place, treat
lingering expired facts as a residual and prefer rebuilding the shared brain
from the sanitized repo.

After edits, `gbrain sync` re-imports the changed pages so the DB matches the
markdown, and `gbrain check-backlinks check` catches pages still pointing at
removed content.

### Phase 4: Verify

Re-run the Phase 2 triage — the count of flagged files should drop to
(near-)zero. Then targeted greps:

```bash
# Rating fields remaining in frontmatter
grep -rn -E '^[a-z_]*(score|rating|skill)[a-z_]*: *[0-9]' people/ --include="*.md"

# Phone numbers
grep -rn -E '\+1[0-9]{10}|\([0-9]{3}\) [0-9]{3}-[0-9]{4}' people/ --include="*.md"

# Comp keywords (full scan scope, not just people/)
grep -rin -E 'carry|comp change|equity|salary' people/ meetings/ daily/ companies/ projects/ analysis/ --include="*.md" 2>/dev/null

# Management/performance
grep -rin -E 'considering leaving|departure rumor|underperform|picking up slack|hard conversation' people/ meetings/ daily/ companies/ projects/ analysis/ --include="*.md" 2>/dev/null
```

False positives (e.g. "carry the torch") are fine — manually confirm each
remaining hit rather than tightening the pattern (regex-discipline).

Then the strongest check — the retrieval the team will actually use. Against
the sanitized brain/source (scope with `--source <team-source-id>` when the
shared source is mounted alongside personal content):

```bash
gbrain query "what is alice-example's compensation" --limit 10
gbrain query "who is underperforming or at risk of leaving" --limit 10
gbrain takes search "weakness" --limit 20
```

Every one of these must come back empty or with only keep-category content.

### Phase 5: Commit and purge history — GATED

Clean files aren't enough if the repo has history: old commits still contain
the sensitive versions.

**Step 0 — preferred alternative (non-destructive).** When standing up a NEW
team repo, skip history rewriting entirely: export the sanitized tree into a
fresh repo with fresh history. The personal repo keeps its full history,
untouched.

```bash
rsync -a --exclude '.git' ./ /tmp/team-brain-export/
cd /tmp/team-brain-export
git init -b main
git add -A && git commit -m "Initial import — sanitized team brain"
git remote add origin <TEAM_REPO_URL>
git push -u origin main
```

Only when a shared repo ALREADY exists with sensitive history in it do you
need the purge below.

**Step 1 — mirror-clone backup.** This is the recoverability line on the
confirmation card; verify it exists before presenting the card.

```bash
git clone --mirror . "/tmp/brain-history-backup-$(date +%Y%m%d).git"
```

**Step 2 — STOP. Present the [data-loss-gate](../data-loss-gate/SKILL.md)
confirmation card and wait.** History rewrite + force-push is the most
destructive operation in this skill: it permanently discards every prior
version of the purged paths from the remote. Never run it without the card
answered. Pre-filled for this operation:

```
⚠️ DATA DELETION — Confirmation Required

What: rewrite git history to remove all prior versions of [purged paths]
      from [brain repo], then force-push to [remote/branch]
Count: [N commits rewritten; M files with history purged]
Size: [repo size before → expected after]
Location: [repo path; remote URL; branch]

Why: prior commits contain pre-sanitization versions of pages that were
     just cleaned — team access to the repo means team access to history

Recoverable?
- [x] Mirror-clone backup at /tmp/brain-history-backup-<date>.git
      (verified: exists, `git -C <backup> log` works)
- [ ] NOT recoverable from the rewritten remote — old SHAs become unreachable

What we'd lose:
- all pre-sanitization history for the purged paths (edit trail, blame,
  old versions)
- every existing clone breaks — all collaborators must re-clone

Alternative to deletion:
- fresh-history export to a NEW team repo (Step 0) — personal repo untouched

Proceed? (yes/no)
```

Per data-loss-gate: require a typed **"yes"** or **"do it"** — "ok", "sure",
"go ahead" are not consent. If the user asks a question, answer and re-present
the card. This gate is a routing convention, not a runtime enforcement —
nothing in gbrain mechanically blocks `git filter-repo` — which is exactly why
the agent following this skill must not skip it.

**Step 3 — purge (only after the explicit typed yes).** Requires
`git filter-repo` (not bundled with git; install separately).

```bash
# Back up the clean working tree of every purged path
mkdir -p /tmp/brainify-clean
for d in people meetings; do   # one entry per purged directory
  mkdir -p "/tmp/brainify-clean/$d" && cp -r "$d/." "/tmp/brainify-clean/$d/"
done

# Rewrite history: one --path per purged directory
rm -rf .git/filter-repo
git filter-repo --invert-paths --path people/ --path meetings/ --force

# Restore clean files and re-commit as a single new commit
for d in people meetings; do
  mkdir -p "$d" && cp -r "/tmp/brainify-clean/$d/." "$d/"
done
git remote add origin <REPO_URL>   # filter-repo removes remotes
git add people/ meetings/
git commit -m "Re-add sanitized directories"

git push --force origin main
```

**Step 4 — log it.** Per data-loss-gate, append the deletion to
`daily/notes/YYYY-MM-DD.md` under `## Data Deletions`: timestamp, purged
paths, commit counts, and the mirror-clone backup path as the recovery line.

**After the force push:**

- All existing clones must re-clone
- Hosting providers may cache unreachable commits for a time (on the order of
  months); for immediate removal use the provider's sensitive-data removal
  process. For private/internal repos, the SHA being unreachable from any ref
  is usually sufficient
- The sync cursor may reference a rewritten-away SHA; if the next
  `gbrain sync` errors or falls back to a full rescan, that is the cursor
  recovering — run `gbrain doctor` if it doesn't settle
- If the repo carries push hooks or auto-hardening wiring, re-verify remotes
  and hooks survived the rewrite before handing the repo to the team

### Phase 6: Ongoing hygiene — periodic re-audit

Sensitive data re-accumulates through meeting-transcript ingestion (candid
assessments), enrichment pipelines pulling internal data, and manual writes
during candid conversations. One clean pass is a snapshot, not a state.

**Recommendation:** schedule a monthly re-audit (weekly for high-ingest
brains) that re-runs Phases 1, 2, and 4 in report-only mode — scan and flag,
no edits — and surfaces new hits for human review before they reach the
shared repo. Wire it per
[conventions/cron-via-minions.md](../conventions/cron-via-minions.md): the
cron slot submits a background job (`gbrain jobs submit`), scheduling
guidance in `skills/cron-scheduler/SKILL.md`, job-lane routing in
`skills/minion-orchestrator/SKILL.md`. The report-only run writes its
findings summary; a human (or a gated follow-up run) does the removal.

## Scaling Notes

- **< 20 files:** process sequentially in one pass
- **20-50 files:** 2-3 parallel subagents
- **50-150 files:** 8-12 parallel subagents, batches of 10-15
- **150+ files:** scripted pattern removal for the rote cases only
  (frontmatter fields, phone numbers — machine-emitted shapes, per
  regex-discipline) + subagents for everything needing judgment

## Edge Cases

- **Founders vs. employees:** founder/exec pages often carry the most
  sensitive content (board dynamics, investor relationships, assessments of
  their own team). These need the most careful review.
- **Meeting notes:** meeting pages referencing employee performance need the
  same treatment as people pages — they are in scope, not an afterthought.
- **Cross-references:** after sanitizing people pages, check that no other
  page (meetings, companies, dailies) still references the removed content;
  `gbrain check-backlinks check` plus a grep for the removed section titles.
- **Takes with attribution:** a take like "the user believes
  charlie-example is underperforming" reveals both the opinion and who holds
  it. Remove the entire take, not just the attribution.
- **Aliases and nicknames:** grep for the person's short name and initials,
  not just the slug — candid content rarely uses full names.

## Dedup (sharp boundaries)

- **[data-loss-gate](../data-loss-gate/SKILL.md)** — supplies the
  confirmation-card mechanics and the explicit-yes discipline; company-brainify's
  Phase 5 is a specialized caller of it (pre-filled card, mirror-clone backup
  as the recoverability line). A standalone "delete/purge/clean up X" intent
  routes to data-loss-gate; the personal→team sanitization WORKFLOW routes here.
- **[publish](../publish/SKILL.md)** — outbound sharing of ONE page as
  encrypted self-contained HTML. company-brainify is whole-brain inbound team
  access. "Share this page" → publish; "share my brain with the team" → here.
- **[maintain](../maintain/SKILL.md)** — structural health (orphans,
  backlinks, stale pages). maintain checks whether the brain is HEALTHY;
  company-brainify checks whether it is SAFE TO SHARE. "Check brain health"
  routes to maintain.
- **[frontmatter-guard](../frontmatter-guard/SKILL.md)** — validates
  frontmatter SHAPE. company-brainify strips sensitive frontmatter FIELDS;
  run frontmatter-guard after a large pass to confirm what remains still
  parses.

## Contract

This skill guarantees:

- The history purge (Phase 5 Steps 3+) never executes before (a) a
  mirror-clone backup exists and is verified, (b) the data-loss-gate
  confirmation card is presented, and (c) the user answers with an explicit
  typed "yes"/"do it". This is a routing convention the agent must follow —
  nothing in the runtime mechanically blocks a skipped gate, which is why
  skipping it is the cardinal violation of this skill.
- The scan covers the full scope (people, meetings, dailies, companies,
  projects, analysis, takes, facts, back-links), never `people/` alone.
- Every strip decision is a per-file model judgment grounded in a full read;
  grep output is triage and verification only.
- A verification pass (Phase 4 greps + retrieval checks) runs before any
  commit is pushed to the shared repo.
- Confirmed purges are logged to `daily/notes/YYYY-MM-DD.md` under
  `## Data Deletions` with the backup path as the recovery line.
- Routing matches the canonical triggers in the frontmatter.
- Output written under the directories listed in `writes_to:` (edits in
  place, plus the daily/ deletion log).
- Privacy contract preserved: no real names, no fork-specific filesystem path
  literals, no upstream-fork references.

The full behavior contract is documented in the body sections above; this
section exists for the conformance test.

## Output Format

Three artifacts:

1. **The sanitization report** (every run, including report-only re-audits):

```markdown
## Brainify Report — YYYY-MM-DD

- Scope: [N files scanned across people/, meetings/, daily/, ...]
- Flagged: [M files with hits] (triage list attached)
- Edited: [K files sanitized; T takes removed; F facts expired]
- Verification: [grep residuals: 0 confirmed-sensitive; retrieval checks: clean]
- History: [not purged | fresh-export | purged after confirmed gate — backup at <path>]
- Next re-audit: [date / cron slot]
```

2. **The confirmation card** (Phase 5 only) — the exact fenced card above,
   presented before any history rewrite; the turn stops until the user answers.
3. **The deletion log entry** (Phase 5, post-purge only) — appended to
   `daily/notes/YYYY-MM-DD.md` per data-loss-gate Step 4.

## Anti-Patterns

- ❌ Scanning only `people/` — meetings, dailies, and cross-references leak
  the same content
- ❌ Sanitizing working-tree files and calling it done — history still carries
  every sensitive version
- ❌ Running `git filter-repo` / force-push without the mirror-clone backup
  and the typed confirmation — the card comes BEFORE the rewrite, always
- ❌ Treating grep as the sensitivity judge — patterns triage, the model
  reads and decides (regex-discipline)
- ❌ Removing the attribution but keeping the take — the claim itself is the
  leak; remove the whole row
- ❌ Bulk-editing 150 files without a 3-5 file test first (test-before-bulk)
- ❌ Tightening grep patterns to eliminate false positives — confirm the hits
  manually instead; a "clean" scan from an over-fitted pattern is a false
  certificate
- ❌ One clean pass with no re-audit — ingestion and enrichment re-accumulate
  sensitive content; schedule Phase 6
