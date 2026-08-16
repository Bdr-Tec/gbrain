/**
 * skillpack/harness-bridge.ts — persona-curated copy of bundled skills into
 * a harness's native skills dir (cathedral-7, the Skill Bridge).
 *
 * The bridge reuses the live scaffold seam (bundle.ts enumerateScaffoldEntries
 * + copy.ts copyArtifacts) with three deltas:
 *   - slugs resolve against the skills/manifest.json universe (6 of the 8
 *     plugin-lane additions are not in openclaw.plugin.json#skills);
 *   - targets are rooted at an arbitrary destination dir (the harness skills
 *     dir), never a workspace — paired `sources:` files are skipped (a
 *     harness skills dir cannot host src/ trees);
 *   - optional cold-pull STUB mode swaps each SKILL.md body for a pointer at
 *     the gbrain MCP `get_skill` op while shipping the shared-dep closure
 *     (32 skills reference sibling convention files; a cold body without
 *     them is broken).
 *
 * Safety posture:
 *   - frontmatter fail-loud gate BEFORE any write (a frontmatterless
 *     SKILL.md bricks Codex sessions — the reason skills/install/ was
 *     deleted);
 *   - target-side confinement (assertTargetsConfined) BEFORE any write —
 *     copy.ts's rejectSymlinks/confineRealpath guard SOURCES only;
 *   - refuse-overwrite is inherited from copyArtifacts (user owns files);
 *   - written-only ownership in bridge-state (skipped_existing is never
 *     recorded; remove/rollback can only touch files the bridge created).
 *
 * Flag-registry note: this file is scanned for skillpack's flag allowlist
 * (facadeExpansion + one-level dep walk harvests bare dash-dash tokens from
 * comments AND strings) — spell foreign (non-skillpack) CLI flags WITHOUT
 * leading dashes everywhere in this file, including the stub template.
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { dirname, join, resolve, sep } from 'path';

import { enumerateScaffoldEntries, loadBundleManifest, pathSlug, BundleError } from './bundle.ts';
import { copyArtifacts, CopyError, type CopyItem } from './copy.ts';
import { parseSkillFrontmatter } from '../skill-frontmatter.ts';
import { unifiedDiff } from './diff-text.ts';
import { parseUnifiedDiff, applyHunks } from './apply-hunks.ts';
import {
  loadBridgeState,
  saveBridgeState,
  recordBridgeWrites,
  removeBridgeSlugs,
  findBridgeEntry,
  type BridgeMode,
  type BridgeWriteRecord,
} from './bridge-state.ts';

/**
 * Bridge harness vocabulary. Deliberately its own union: bootstrap.ts's
 * `Harness` is unexported and excludes openclaw; the receipt-row type in
 * bootstrap/format.ts already owns the name HarnessTarget. Follow-up (f)
 * unifies the registries.
 */
export const BRIDGE_HARNESSES = ['claude-code', 'openclaw', 'codex', 'opencode'] as const;
export type BridgeHarness = (typeof BRIDGE_HARNESSES)[number];

export function isBridgeHarness(v: string): v is BridgeHarness {
  return (BRIDGE_HARNESSES as readonly string[]).includes(v);
}

/** First line of every stub body — the mode ground truth that survives
 *  state loss in both directions (present = stub, absent = full). */
export const STUB_MARKER = '<!-- gbrain-skill-stub v1 -->';

export type BridgeErrorCode =
  | 'frontmatter_missing'
  | 'write_failed'
  | 'target_escape'
  | 'catalog_unresolvable'
  | 'invalid_args'
  | 'not_owned';

export class BridgeError extends Error {
  constructor(
    message: string,
    public code: BridgeErrorCode,
    public offendingPath?: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Map a scaffold entry's workspace-rooted rel path (`skills/<slug>/...` or
 * `skills/conventions/...`) to the harness dest. Strips the `skills/`
 * prefix and joins under destDir — never dirname() arithmetic, so a custom
 * dest that isn't literally named "skills" still roots correctly.
 */
export function bridgeTargetPath(destDir: string, relWorkspaceTarget: string): string {
  return join(destDir, relWorkspaceTarget.replace(/^skills\//, ''));
}

export interface BridgePlanItem {
  /** Absolute source path in the gbrain tree. */
  source: string;
  /** Absolute target path under destDir. */
  target: string;
  /** Target path relative to destDir (the bridge-state ledger key). */
  relTarget: string;
  /** Owning slug; null for shared-dep files. */
  slug: string | null;
  sharedDep: boolean;
  isSkillMd: boolean;
  /** Rendered stub content (stub mode, SKILL.md items only). */
  content?: string;
}

export interface BridgePlan {
  destDir: string;
  mode: BridgeMode;
  slugs: string[];
  items: BridgePlanItem[];
  /** Paired `sources:` files skipped (a harness dir has no src/ tree). */
  pairedSourcesSkipped: number;
  /** Slugs whose EXISTING SKILL.md is in the other mode (file marker is
   *  ground truth). Never silently converted; remedy = remove + re-run. */
  modeConflicts: string[];
  /** Aux (non-SKILL.md skill files) skipped in stub mode. */
  auxSkippedForStub: number;
}

export interface PlanHarnessBridgeOptions {
  gbrainRoot: string;
  destDir: string;
  slugs: readonly string[];
  mode: BridgeMode;
}

/**
 * Enumerate + gate. Throws BridgeError('frontmatter_missing') naming every
 * offending SKILL.md BEFORE anything would be written; reports (does not
 * throw on) mode conflicts so the caller can decide.
 */
export function planHarnessBridge(opts: PlanHarnessBridgeOptions): BridgePlan {
  if (opts.slugs.length === 0) {
    throw new BridgeError('no skills selected (empty persona resolution?)', 'invalid_args');
  }
  const manifest = loadBundleManifest(opts.gbrainRoot);
  const entries = enumerateScaffoldEntries({
    gbrainRoot: opts.gbrainRoot,
    skillSlugs: opts.slugs,
    universe: 'manifest',
    manifest,
  });

  const items: BridgePlanItem[] = [];
  let pairedSourcesSkipped = 0;
  let auxSkippedForStub = 0;
  const frontmatterViolations: string[] = [];
  const modeConflictSlugs = new Set<string>();

  for (const entry of entries) {
    if (entry.pairedSource) {
      pairedSourcesSkipped++;
      continue;
    }
    const rel = entry.relWorkspaceTarget.replace(/^skills\//, '');
    const slug = entry.sharedDep ? null : pathSlug(join('skills', rel.split(sep)[0] ?? rel.split('/')[0]));
    const isSkillMd = !entry.sharedDep && /(^|[\\/])SKILL\.md$/.test(rel);

    // Stub mode ships shared deps (dependency closure) but skips aux skill
    // files — get_skill serves only the SKILL.md body, so aux files would
    // be orphans the stub never references.
    if (opts.mode === 'stub' && !entry.sharedDep && !isSkillMd) {
      auxSkippedForStub++;
      continue;
    }

    const target = bridgeTargetPath(opts.destDir, entry.relWorkspaceTarget);
    const item: BridgePlanItem = {
      source: entry.source,
      target,
      relTarget: rel,
      slug,
      sharedDep: entry.sharedDep,
      isSkillMd,
    };

    if (isSkillMd) {
      const sourceContent = readFileSync(entry.source, 'utf-8');
      const fm = parseSkillFrontmatter(sourceContent);
      if (!fm || !fm.name) {
        // A frontmatterless SKILL.md makes Codex error at session start —
        // fail loud before ANY write rather than brick the harness.
        frontmatterViolations.push(entry.source);
      } else if (opts.mode === 'stub') {
        item.content = renderSkillStub(sourceContent, slug ?? fm.name);
      }
      // Mode conflict: judge the EXISTING file, not state (survives state
      // loss in both directions — marker present = stub, absent = full).
      if (existsSync(target) && slug) {
        const existing = readFileSync(target, 'utf-8');
        const fileMode: BridgeMode = existing.includes(STUB_MARKER) ? 'stub' : 'full';
        if (fileMode !== opts.mode) modeConflictSlugs.add(slug);
      }
    }
    items.push(item);
  }

  if (frontmatterViolations.length > 0) {
    throw new BridgeError(
      `refusing to install: SKILL.md missing parseable frontmatter with a name (would brick harness discovery): ${frontmatterViolations.join(', ')}`,
      'frontmatter_missing',
    );
  }

  return {
    destDir: opts.destDir,
    mode: opts.mode,
    slugs: [...opts.slugs],
    items,
    pairedSourcesSkipped,
    modeConflicts: [...modeConflictSlugs].sort(),
    auxSkippedForStub,
  };
}

/**
 * Render a cold-pull stub for one skill. The source SKILL.md's frontmatter
 * block is preserved VERBATIM (name / description / triggers are the warm
 * discovery contract); the body becomes a pointer at the gbrain MCP
 * `get_skill` op. The fallback text is honest about reachability: on stdio
 * servers a per-client surface cannot be persisted, and `request_tools`
 * never widens past the operator's ceiling.
 */
export function renderSkillStub(sourceContent: string, slug: string): string {
  const fmMatch = sourceContent.replace(/\r\n/g, '\n').match(/^---\n[\s\S]*?\n---/);
  if (!fmMatch) {
    throw new BridgeError(
      `cannot render stub for '${slug}': SKILL.md has no frontmatter block`,
      'frontmatter_missing',
    );
  }
  const body =
    `${STUB_MARKER}\n\n` +
    `This is a cold-pull stub installed by \`gbrain skillpack scaffold\`. The full\n` +
    `skill body is served by your gbrain brain, so it is always current.\n\n` +
    `To use this skill: call the gbrain MCP tool \`get_skill\` with\n` +
    `\`{"name": "${slug}"}\`, read the returned instructions, and follow them\n` +
    `exactly.\n\n` +
    `If \`get_skill\` is not in your tool list, the gbrain MCP server's surface is\n` +
    `too narrow for skill serving — ask the operator to run \`gbrain serve\` with\n` +
    `surface \`full\` (HTTP clients may try the \`request_tools\` tool; stdio\n` +
    `servers cannot persist a wider surface, and no client can exceed the\n` +
    `operator's ceiling). Local CLI fallback that always works:\n` +
    `\`gbrain skill ${slug}\`.\n`;
  return `${fmMatch[0]}\n\n${body}`;
}

/**
 * Target-side confinement [CEO-F3/CX5]: every planned target must resolve
 * inside destDir, judged on the REAL filesystem — the deepest existing
 * ancestor of each target is realpath'd and prefix-checked against the
 * realpath of destDir, so both `..` traversal and symlinked-parent escapes
 * are rejected BEFORE any write. copy.ts's own confinement gates guard
 * sources only; this is the mirror for targets.
 */
export function assertTargetsConfined(destDir: string, targets: readonly string[]): void {
  const logicalRoot = resolve(destDir);
  if (!existsSync(logicalRoot)) {
    // Nothing exists yet — logical containment is the only judgeable check;
    // apply creates destDir first, then re-asserts with realpath.
    for (const t of targets) {
      const logical = resolve(t);
      if (logical !== logicalRoot && !logical.startsWith(logicalRoot + sep)) {
        throw new BridgeError(
          `${t}: escapes the install destination (${destDir})`,
          'target_escape',
          t,
        );
      }
    }
    return;
  }
  const realRoot = realpathSync(logicalRoot);
  for (const t of targets) {
    const logical = resolve(t);
    if (logical !== logicalRoot && !logical.startsWith(logicalRoot + sep)) {
      throw new BridgeError(`${t}: escapes the install destination (${destDir})`, 'target_escape', t);
    }
    // Deepest existing ancestor, realpath'd: catches a symlinked parent dir
    // pointing outside the dest.
    let probe = dirname(logical);
    while (!existsSync(probe)) {
      const up = dirname(probe);
      if (up === probe) break;
      probe = up;
    }
    let realProbe: string;
    try {
      realProbe = realpathSync(probe);
    } catch {
      continue;
    }
    if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) {
      throw new BridgeError(
        `${t}: an existing parent directory resolves outside the install destination (${realProbe})`,
        'target_escape',
        t,
      );
    }
  }
}

export interface ApplyHarnessBridgeOptions {
  harness: string;
  scope?: 'user' | 'project';
  persona: string | null;
  gbrainVersion: string;
  dryRun?: boolean;
  statePath?: string;
  nowIso: string;
}

export interface BridgeFileResult {
  target: string;
  relTarget: string;
  slug: string | null;
  sharedDep: boolean;
  outcome: 'wrote_new' | 'skipped_existing';
}

export interface BridgeApplyResult {
  dryRun: boolean;
  destDir: string;
  mode: BridgeMode;
  files: BridgeFileResult[];
  summary: {
    wroteNew: number;
    skippedExisting: number;
    pairedSourcesSkipped: number;
    auxSkippedForStub: number;
    modeConflicts: string[];
  };
}

/**
 * Execute a plan: confinement gate → copy (refuse-overwrite) → bridge-state
 * upsert with install-time sha256 per written file. All fs failures wrap as
 * typed BridgeError('write_failed') with the offending path.
 */
export function applyHarnessBridge(plan: BridgePlan, opts: ApplyHarnessBridgeOptions): BridgeApplyResult {
  const dryRun = opts.dryRun ?? false;
  assertTargetsConfined(plan.destDir, plan.items.map(i => i.target));

  const copyItems: CopyItem[] = plan.items.map(i => ({
    source: i.source,
    target: i.target,
    ...(i.content != null ? { content: i.content } : {}),
  }));

  let copyResult;
  try {
    copyResult = copyArtifacts(copyItems, { dryRun });
  } catch (err) {
    if (err instanceof CopyError) throw err; // already typed + path-bearing
    throw new BridgeError(
      `write failed under ${plan.destDir}: ${(err as Error).message}`,
      'write_failed',
      plan.destDir,
    );
  }

  const files: BridgeFileResult[] = copyResult.files.map((f, i) => ({
    target: f.target,
    relTarget: plan.items[i].relTarget,
    slug: plan.items[i].slug,
    sharedDep: plan.items[i].sharedDep,
    outcome: f.outcome,
  }));

  // Written-only ownership: hash exactly what landed, keyed per slug.
  if (!dryRun) {
    const perSlug = new Map<string, Record<string, string>>();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.outcome !== 'wrote_new' || f.slug === null) continue;
      const item = plan.items[i];
      const content = item.content != null ? Buffer.from(item.content) : readFileSync(item.source);
      const bySlug = perSlug.get(f.slug) ?? {};
      bySlug[f.relTarget] = sha256Hex(content);
      perSlug.set(f.slug, bySlug);
    }
    if (perSlug.size > 0) {
      const writes: BridgeWriteRecord[] = [...perSlug.entries()].map(([slug, fileMap]) => ({
        slug,
        mode: plan.mode,
        files: fileMap,
      }));
      const state = loadBridgeState({ statePath: opts.statePath });
      const next = recordBridgeWrites(
        state,
        {
          harness: opts.harness,
          dest: plan.destDir,
          scope: opts.scope,
          persona: opts.persona,
          mode: plan.mode,
          gbrainVersion: opts.gbrainVersion,
          nowIso: opts.nowIso,
        },
        writes,
      );
      saveBridgeState(next, { statePath: opts.statePath });
    }
  }

  return {
    dryRun,
    destDir: plan.destDir,
    mode: plan.mode,
    files,
    summary: {
      wroteNew: files.filter(f => f.outcome === 'wrote_new').length,
      skippedExisting: files.filter(f => f.outcome === 'skipped_existing').length,
      pairedSourcesSkipped: plan.pairedSourcesSkipped,
      auxSkippedForStub: plan.auxSkippedForStub,
      modeConflicts: plan.modeConflicts,
    },
  };
}

/**
 * Stub-preflight leg [CX2]: verify every requested slug is servable from
 * the skills dir the MCP server would resolve. Returns the missing slugs
 * (empty = all servable). The publish-gate and surface checks live in the
 * CLI layer (core must not import src/mcp).
 */
export function verifySlugsServable(skillsDir: string, slugs: readonly string[]): string[] {
  return slugs.filter(slug => !existsSync(join(skillsDir, slug, 'SKILL.md')));
}

export type HarnessRefStatus = 'identical' | 'differs' | 'missing';
export type HarnessRefDiffersKind = 'local_edit' | 'upstream_drift' | 'unknown';

export interface HarnessRefFile {
  target: string;
  relTarget: string;
  slug: string | null;
  sharedDep: boolean;
  status: HarnessRefStatus;
  /** Mode the comparison judged this file in (existing-file marker wins). */
  mode: BridgeMode;
  /** Present when status='differs' and the install-time hash is known. */
  differsKind?: HarnessRefDiffersKind;
  unifiedDiff?: string;
}

export interface HarnessRefResult {
  destDir: string;
  files: HarnessRefFile[];
  summary: { identical: number; differs: number; missing: number };
}

export interface HarnessReferenceOptions {
  gbrainRoot: string;
  destDir: string;
  slugs: readonly string[];
  harness: string;
  statePath?: string;
}

/**
 * The harness diff lens. Expected content per file is mode-aware: an
 * existing SKILL.md whose body carries the stub marker is compared against
 * the RENDERED stub (a fresh stub reads identical); everything else is
 * compared against current source bytes. With the install-time hash from
 * bridge-state, `differs` splits three-way [OV3]: the file still matching
 * what we wrote = upstream_drift; anything else = local_edit.
 */
export function runHarnessReference(opts: HarnessReferenceOptions): HarnessRefResult {
  const manifest = loadBundleManifest(opts.gbrainRoot);
  const entries = enumerateScaffoldEntries({
    gbrainRoot: opts.gbrainRoot,
    skillSlugs: opts.slugs,
    universe: 'manifest',
    manifest,
  });
  const state = loadBridgeState({ statePath: opts.statePath });
  const stateEntry = findBridgeEntry(state, { harness: opts.harness, dest: opts.destDir });

  const files: HarnessRefFile[] = [];
  for (const entry of entries) {
    if (entry.pairedSource) continue;
    const rel = entry.relWorkspaceTarget.replace(/^skills\//, '');
    const slug = entry.sharedDep ? null : pathSlug(join('skills', rel.split(sep)[0] ?? rel.split('/')[0]));
    const isSkillMd = !entry.sharedDep && /(^|[\\/])SKILL\.md$/.test(rel);
    const target = bridgeTargetPath(opts.destDir, entry.relWorkspaceTarget);
    const stateMode: BridgeMode = (slug && stateEntry?.written[slug]?.mode) || 'full';

    if (!existsSync(target)) {
      // Aux files are expected-absent for stub installs — not "missing".
      if (stateMode === 'stub' && !entry.sharedDep && !isSkillMd) continue;
      files.push({ target, relTarget: rel, slug, sharedDep: entry.sharedDep, status: 'missing', mode: stateMode });
      continue;
    }

    const actual = readFileSync(target, 'utf-8');
    const sourceContent = readFileSync(entry.source, 'utf-8');
    const fileMode: BridgeMode = isSkillMd && actual.includes(STUB_MARKER) ? 'stub' : 'full';
    const expected = fileMode === 'stub' && isSkillMd && slug ? renderSkillStub(sourceContent, slug) : sourceContent;

    if (actual === expected) {
      files.push({ target, relTarget: rel, slug, sharedDep: entry.sharedDep, status: 'identical', mode: fileMode });
      continue;
    }
    const installedHash = slug ? stateEntry?.written[slug]?.files[rel] : undefined;
    const differsKind: HarnessRefDiffersKind = installedHash
      ? sha256Hex(actual) === installedHash
        ? 'upstream_drift'
        : 'local_edit'
      : 'unknown';
    files.push({
      target,
      relTarget: rel,
      slug,
      sharedDep: entry.sharedDep,
      status: 'differs',
      mode: fileMode,
      differsKind,
      unifiedDiff: unifiedDiff(actual, expected, { oldPath: `local/${rel}`, newPath: `gbrain/${rel}` }),
    });
  }

  return {
    destDir: opts.destDir,
    files,
    summary: {
      identical: files.filter(f => f.status === 'identical').length,
      differs: files.filter(f => f.status === 'differs').length,
      missing: files.filter(f => f.status === 'missing').length,
    },
  };
}

export interface HarnessRefApplyFile {
  target: string;
  relTarget: string;
  status: 'applied' | 'partial' | 'refused_stub' | 'identical' | 'missing';
  hunksApplied: number;
  hunksConflicted: number;
  conflicts: string[];
}

export interface HarnessRefApplyResult {
  dryRun: boolean;
  files: HarnessRefApplyFile[];
  summary: { totalHunksApplied: number; totalHunksConflicted: number; refusedStub: number };
}

/**
 * `--apply-clean-hunks` for a harness install [CX10]. Full-mode files only:
 * stub-marked files are refused (stubs are regenerated by a re-run, never
 * merged). Clean hunks land; conflicts are reported and left in place.
 */
export function runHarnessReferenceApply(
  opts: HarnessReferenceOptions & { dryRun?: boolean },
): HarnessRefApplyResult {
  const dryRun = opts.dryRun ?? false;
  const ref = runHarnessReference(opts);
  const files: HarnessRefApplyFile[] = [];
  let totalApplied = 0;
  let totalConflicted = 0;
  let refusedStub = 0;

  for (const f of ref.files) {
    if (f.status === 'identical' || f.status === 'missing') {
      files.push({
        target: f.target,
        relTarget: f.relTarget,
        status: f.status,
        hunksApplied: 0,
        hunksConflicted: 0,
        conflicts: [],
      });
      continue;
    }
    if (f.mode === 'stub') {
      refusedStub++;
      files.push({
        target: f.target,
        relTarget: f.relTarget,
        status: 'refused_stub',
        hunksApplied: 0,
        hunksConflicted: 0,
        conflicts: ['stub-mode file: stubs are regenerated by re-running the scaffold, never merged'],
      });
      continue;
    }
    const actual = readFileSync(f.target, 'utf-8');
    const diffText = f.unifiedDiff ?? '';
    const parsed = parseUnifiedDiff(diffText);
    const res = applyHunks(actual, parsed);
    if (!dryRun && res.applied > 0) {
      try {
        writeFileSync(f.target, res.text);
      } catch (err) {
        throw new BridgeError(
          `write failed for ${f.target}: ${(err as Error).message}`,
          'write_failed',
          f.target,
        );
      }
    }
    totalApplied += res.applied;
    totalConflicted += res.conflicted;
    files.push({
      target: f.target,
      relTarget: f.relTarget,
      status: res.conflicted > 0 ? 'partial' : 'applied',
      hunksApplied: res.applied,
      hunksConflicted: res.conflicted,
      conflicts: res.outcomes.filter(o => o.status !== 'applied').map(o => `hunk ${o.hunk}: ${o.status}`),
    });
  }

  return {
    dryRun,
    files,
    summary: { totalHunksApplied: totalApplied, totalHunksConflicted: totalConflicted, refusedStub },
  };
}

export interface BridgeRemoveResult {
  dryRun: boolean;
  removedFiles: string[];
  prunedDirs: string[];
  /** Slugs requested but not owned by the bridge (nothing to remove). */
  notOwned: string[];
}

/**
 * Remove state-owned files for the given slugs (or every owned slug when
 * slugs is null) [OV4]. NEVER touches files outside the written ledger —
 * pre-existing user files were never recorded, and skipped_existing was
 * never ours. Empty slug dirs are pruned afterwards.
 */
export function removeHarnessBridge(opts: {
  harness: string;
  destDir: string;
  slugs: readonly string[] | null;
  dryRun?: boolean;
  statePath?: string;
  nowIso: string;
}): BridgeRemoveResult {
  const dryRun = opts.dryRun ?? false;
  const state = loadBridgeState({ statePath: opts.statePath });
  const entry = findBridgeEntry(state, { harness: opts.harness, dest: opts.destDir });
  const owned = entry ? Object.keys(entry.written) : [];
  const requested = opts.slugs === null ? owned : [...opts.slugs];
  const notOwned = requested.filter(s => !owned.includes(s));
  const toRemove = requested.filter(s => owned.includes(s));

  const removedFiles: string[] = [];
  const prunedDirs = new Set<string>();
  for (const slug of toRemove) {
    const rec = entry!.written[slug];
    for (const rel of Object.keys(rec.files)) {
      const abs = join(opts.destDir, rel);
      // Confinement on the way out too — the ledger is machine-owned but a
      // hand-edited relpath must not escape the dest.
      const logical = resolve(abs);
      if (logical !== resolve(opts.destDir) && !logical.startsWith(resolve(opts.destDir) + sep)) {
        throw new BridgeError(`${abs}: ledger path escapes the install destination`, 'target_escape', abs);
      }
      if (!existsSync(abs)) continue;
      if (!dryRun) {
        try {
          rmSync(abs);
        } catch (err) {
          throw new BridgeError(
            `remove failed for ${abs}: ${(err as Error).message}`,
            'write_failed',
            abs,
          );
        }
      }
      removedFiles.push(abs);
      prunedDirs.add(dirname(abs));
    }
  }

  // Prune emptied dirs (bottom-up, only within dest).
  const pruned: string[] = [];
  if (!dryRun) {
    const candidates = [...prunedDirs].sort((a, b) => b.length - a.length);
    for (const dir of candidates) {
      try {
        if (existsSync(dir) && readdirSync(dir).length === 0 && dir !== resolve(opts.destDir)) {
          rmdirSync(dir);
          pruned.push(dir);
        }
      } catch {
        // best-effort prune
      }
    }
  }

  if (!dryRun && toRemove.length > 0) {
    const next = removeBridgeSlugs(
      state,
      { harness: opts.harness, dest: opts.destDir, nowIso: opts.nowIso },
      toRemove,
    );
    saveBridgeState(next, { statePath: opts.statePath });
  }

  return { dryRun, removedFiles, prunedDirs: pruned, notOwned };
}

/** Guard against a caller passing a symlink AS the dest dir itself. */
export function assertDestNotSymlink(destDir: string): void {
  if (!existsSync(destDir)) return;
  const stat = lstatSync(destDir);
  if (stat.isSymbolicLink()) {
    throw new BridgeError(
      `${destDir}: the install destination is a symlink — refusing (pass the resolved directory)`,
      'target_escape',
      destDir,
    );
  }
}

/** Re-exported for the CLI's confinement error taxonomy. */
export { BundleError };
