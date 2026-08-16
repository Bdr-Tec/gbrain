/**
 * `gbrain skillpack scaffold/reference/remove` — harness lane (cathedral-7).
 *
 * Installs persona-curated bundled skills into a harness's native skills
 * dir (claude-code today; codex/opencode behind an explicit dest until
 * their locations get observation runs; openclaw delegates to the
 * workspace scaffold).
 *
 * Flag-registry note: this file is scanned for skillpack's flag allowlist
 * (bare dash-dash tokens in comments AND strings register as flags, one
 * import level deep). Spell foreign (non-skillpack) CLI flags WITHOUT
 * leading dashes — including in stub/preflight hint text. Deliberately does
 * NOT import src/mcp/surface.ts (its comments carry serve-flag tokens that
 * would bleed into this command's allowlist); the "get_skill is not on the
 * starter surface" fact is hardcoded here and pinned by a contract test.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import type { BrainEngine } from '../../core/engine.ts';
import { loadConfig } from '../../core/config.ts';
import { VERSION } from '../../version.ts';
import { autoDetectSkillsDir } from '../../core/repo-root.ts';
import {
  claudeProjectSkillsDir,
  claudeUserSkillsDir,
} from '../../core/bootstrap/host-specs.ts';
import {
  BRIDGE_HARNESSES,
  BridgeError,
  isBridgeHarness,
  planHarnessBridge,
  applyHarnessBridge,
  runHarnessReference,
  runHarnessReferenceApply,
  removeHarnessBridge,
  verifySlugsServable,
  assertDestNotSymlink,
  type BridgeHarness,
} from '../../core/skillpack/harness-bridge.ts';
import {
  PersonaError,
  loadPersonas,
  resolvePersonaSlugs,
  validateSlugsAgainstLane,
} from '../../core/skillpack/personas.ts';
import {
  loadBridgeState,
  findBridgeEntry,
  defaultBridgeStatePath,
} from '../../core/skillpack/bridge-state.ts';
import { runScaffold, ScaffoldError } from '../../core/skillpack/scaffold.ts';
import { BundleError } from '../../core/skillpack/bundle.ts';
import { findGbrainOrDie, resolveAbs, resolveWorkspace } from './shared.ts';

const DEFAULT_PERSONA: Record<Exclude<BridgeHarness, 'openclaw'>, string> = {
  'claude-code': 'coding-agent',
  codex: 'coding-agent',
  opencode: 'coding-agent',
};

interface HarnessArgs {
  harness: BridgeHarness;
  persona: string | null;
  skills: string[];
  dest: string | null;
  scope: 'user' | 'project';
  stub: boolean;
  workspace: string | null;
  dryRun: boolean;
  json: boolean;
  all: boolean;
  applyCleanHunks: boolean;
  /** Bare (non-flag) tokens, in order — e.g. reference's <slug>. */
  positional: string[];
}

const VALUE_FLAGS = new Set(['--harness', '--persona', '--skill', '--dest', '--scope', '--workspace']);
const BOOL_FLAGS = new Set(['--stub', '--dry-run', '--json', '--all', '--apply-clean-hunks', '--help', '-h']);

function parseHarnessArgs(args: string[], cmd: string): HarnessArgs {
  let harness: string | null = null;
  let persona: string | null = null;
  const skills: string[] = [];
  let dest: string | null = null;
  let scope: 'user' | 'project' = 'user';
  let workspace: string | null = null;
  const positional: string[] = [];

  const assign = (flag: string, value: string | null): void => {
    if (value == null || value === '') {
      console.error(`Error: ${flag} needs a value.`);
      process.exit(2);
    }
    switch (flag) {
      case '--harness':
        harness = value;
        break;
      case '--persona':
        persona = value;
        break;
      case '--skill':
        skills.push(value);
        break;
      case '--dest':
        dest = value;
        break;
      case '--scope':
        if (value !== 'user' && value !== 'project') {
          console.error(`Error: --scope must be 'user' or 'project' (got ${JSON.stringify(value)}).`);
          process.exit(2);
        }
        scope = value;
        break;
      case '--workspace':
        workspace = value;
        break;
    }
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    const eq = a.indexOf('=');
    const flagName = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_FLAGS.has(flagName)) {
      if (eq > 0) assign(flagName, a.slice(eq + 1));
      else {
        assign(flagName, args[i + 1] ?? null);
        i++;
      }
    } else if (BOOL_FLAGS.has(a)) {
      // handled via args.includes below
    } else if (!a.startsWith('--')) {
      positional.push(a);
    }
    // Unknown dash-dash flags fall through to the registry validator.
  }

  if (!harness || !isBridgeHarness(harness)) {
    console.error(
      `Error: ${cmd} requires --harness <${BRIDGE_HARNESSES.join('|')}> (got ${JSON.stringify(harness)}).`,
    );
    process.exit(2);
  }
  return {
    harness,
    persona,
    skills,
    dest,
    scope,
    stub: args.includes('--stub'),
    workspace,
    dryRun: args.includes('--dry-run'),
    json: args.includes('--json'),
    all: args.includes('--all'),
    applyCleanHunks: args.includes('--apply-clean-hunks'),
    positional,
  };
}

/** Resolve the install dest for a bridge harness (never openclaw). */
function resolveDest(a: HarnessArgs): string {
  if (a.dest) return resolveAbs(a.dest);
  if (a.harness === 'claude-code') {
    if (a.scope === 'project') {
      const ws = a.workspace ? resolveAbs(a.workspace) : process.cwd();
      return claudeProjectSkillsDir(ws);
    }
    return claudeUserSkillsDir();
  }
  // codex / opencode: no attested native skills dir yet — an explicit dest
  // is required until the observation-run follow-up lands a verified default.
  console.error(
    `Error: ${a.harness} has no attested native skills dir yet — pass --dest <dir>.\n` +
      `(The plugin lane already serves ${a.harness === 'codex' ? 'codex' : 'this harness'} skills; ` +
      `a direct-copy default ships after an observation run — see the TODOS.md follow-up.)`,
  );
  process.exit(2);
}

/** Resolve the slug set: explicit picks (lane-validated) beat persona. */
function resolveSlugs(gbrainRoot: string, a: HarnessArgs): { slugs: string[]; persona: string | null } {
  if (a.skills.length > 0) {
    validateSlugsAgainstLane(gbrainRoot, a.skills);
    return { slugs: [...new Set(a.skills)].sort(), persona: null };
  }
  const persona =
    a.persona ?? (a.harness === 'openclaw' ? 'all' : DEFAULT_PERSONA[a.harness as Exclude<BridgeHarness, 'openclaw'>]);
  return { slugs: resolvePersonaSlugs(gbrainRoot, persona), persona };
}

/**
 * Best-effort engine open for the dual-plane config reads. `gbrain config
 * set` writes the DB plane, so a file-only read would tell users to run the
 * exact command they already ran. Any failure degrades to the file plane.
 */
async function withBestEffortEngine<T>(fn: (engine: BrainEngine | null) => Promise<T>): Promise<T> {
  const config = loadConfig();
  let engine: BrainEngine | null = null;
  if (config) {
    try {
      const { createEngine } = await import('../../core/engine-factory.ts');
      const { toEngineConfig } = await import('../../core/config.ts');
      const { connectWithRetry } = await import('../../core/db.ts');
      engine = await createEngine(toEngineConfig(config));
      await connectWithRetry(engine, toEngineConfig(config), { noRetry: true });
    } catch {
      engine = null;
    }
  }
  try {
    return await fn(engine);
  } finally {
    try {
      await engine?.disconnect();
    } catch {}
  }
}

async function dualPlaneConfig(engine: BrainEngine | null, key: string): Promise<string | undefined> {
  if (engine) {
    try {
      const v = await engine.getConfig(key);
      if (v != null) return v;
    } catch {}
  }
  return undefined;
}

/**
 * Stub preflight [D3B]: three checks, all fail-loud where they can be.
 *   1. mcp.publish_skills must be true (DB plane wins, file plane fallback) —
 *      a stub pointing at a gated op is a dead pointer.
 *   2. Every requested slug must be servable from the skills dir the MCP
 *      server would resolve (mcp.skills_dir override, else auto-detect).
 *   3. Best-effort surface warn: get_skill is only exposed on the full MCP
 *      surface (it is NOT in the starter set, and the plugin lanes serve
 *      starter; a contract test pins this fact). This check reads LOCAL
 *      config only — it cannot see a plugin manifest's hard-coded surface
 *      or a remote server's ceiling.
 */
async function stubPreflight(gbrainRoot: string, slugs: readonly string[]): Promise<void> {
  await withBestEffortEngine(async engine => {
    const config = loadConfig();

    // (1) publish gate — fail closed.
    const dbPublish = await dualPlaneConfig(engine, 'mcp.publish_skills');
    const publish = dbPublish != null ? dbPublish === 'true' : config?.mcp?.publish_skills === true;
    if (!publish) {
      console.error(
        'Error: stub mode requires skill publishing to be ON — the stubs point agents at the\n' +
          'gbrain MCP get_skill op, which is gated by mcp.publish_skills (currently off).\n' +
          'Enable it first: gbrain config set mcp.publish_skills true',
      );
      process.exit(2);
    }

    // (2) catalog resolvability — fail closed.
    const dbSkillsDir = await dualPlaneConfig(engine, 'mcp.skills_dir');
    const configuredDir = dbSkillsDir ?? config?.mcp?.skills_dir;
    const serverDir = configuredDir ? resolveAbs(configuredDir) : autoDetectSkillsDir().dir;
    if (!serverDir || !existsSync(serverDir)) {
      console.error(
        'Error: stub mode could not resolve the skills dir the MCP server would serve\n' +
          'get_skill from (no mcp.skills_dir configured and auto-detection found nothing).\n' +
          'Point the server at a skills tree: gbrain config set mcp.skills_dir <path>',
      );
      process.exit(2);
    }
    const missing = verifySlugsServable(serverDir, slugs);
    if (missing.length > 0) {
      console.error(
        `Error: stub mode would install pointers at skills the MCP server cannot serve\n` +
          `from ${serverDir}: ${missing.join(', ')}.\n` +
          'A stub for an unservable skill is a dead pointer. Fix the server skills dir\n' +
          '(gbrain config set mcp.skills_dir <path>) or drop those skills.',
      );
      process.exit(2);
    }

    // (3) surface warn — best-effort, local config only.
    const dbSurface = await dualPlaneConfig(engine, 'mcp_surface');
    const surface = dbSurface ?? (config as { mcp_surface?: string } | null)?.mcp_surface;
    if (surface === 'starter' || surface === 'verbs') {
      console.error(
        `warn: your configured MCP surface is '${surface}', which does not expose get_skill\n` +
          '      (skills ops are full-surface only). The stubs will be dead pointers on that\n' +
          '      server until it restarts with surface full. Note this check reads local\n' +
          '      config only — plugin-lane servers hard-code the starter surface.',
      );
    }
  });
}

// ---------------------------------------------------------------------------
// scaffold --harness
// ---------------------------------------------------------------------------

export async function cmdScaffoldHarness(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'gbrain skillpack scaffold --harness <claude-code|openclaw|codex|opencode>\n' +
        '    [--persona <name>|all] [--skill <slug>]... [--dest PATH] [--scope user|project]\n' +
        '    [--stub] [--workspace PATH] [--dry-run] [--json]\n\n' +
        'Install a persona-curated set of bundled skills into a harness\'s native\n' +
        'skills dir. Additive; never overwrites your files (local edits win).\n\n' +
        '  --persona      Named curation from skills/plugin-lanes.json#personas,\n' +
        '                 or `all` for the full plugin lane. Defaults: claude-code/\n' +
        '                 codex/opencode → coding-agent; openclaw → all.\n' +
        '  --skill        Explicit slug picks (repeatable; overrides --persona).\n' +
        '  --dest         Install dir override. Required for codex/opencode (no\n' +
        '                 attested native skills dir yet).\n' +
        '  --scope        claude-code only: user (default) → the user-level skills\n' +
        '                 dir; project → <workspace>/.claude/skills.\n' +
        '  --stub         Cold-pull mode: install pointer SKILL.md files that fetch\n' +
        '                 the body via the gbrain MCP get_skill op (preflight-gated).\n' +
        '  --dry-run      Plan + report; no writes.\n',
    );
    process.exit(0);
  }
  const a = parseHarnessArgs(args, 'scaffold --harness');
  const gbrainRoot = findGbrainOrDie();

  try {
    // openclaw: the workspace scaffold IS the native install — delegate with
    // persona filtering. Stub mode is refused (openclaw users are the brain
    // host; the full bodies live next to the brain anyway).
    if (a.harness === 'openclaw') {
      if (a.stub) {
        console.error('Error: --stub is not supported for openclaw (the workspace hosts the brain — full bodies are the native shape).');
        process.exit(2);
      }
      if (a.dest) {
        console.error('Error: openclaw installs into a workspace, not a dest dir. Use --workspace PATH.');
        process.exit(2);
      }
      const targetWorkspace = resolveWorkspace({ workspace: a.workspace });
      const { slugs, persona } = resolveSlugs(gbrainRoot, a);
      const useFullBundle = a.skills.length === 0 && (a.persona === null || a.persona === 'all');
      const result = runScaffold({
        gbrainRoot,
        targetWorkspace,
        skillSlug: null,
        // Full bundle (openclaw's default, today's behavior) enumerates the
        // openclaw universe directly; persona/skill picks filter it.
        ...(useFullBundle ? {} : { skillSlugs: slugs }),
        dryRun: a.dryRun,
      });
      if (a.json) {
        console.log(
          JSON.stringify(
            { ok: true, harness: a.harness, persona: useFullBundle ? 'all' : persona, dryRun: result.dryRun, summary: result.summary },
            null,
            2,
          ),
        );
      } else {
        console.log(
          `${a.dryRun ? 'scaffold --harness openclaw (dry-run)' : 'scaffold --harness openclaw'}: ` +
            `${result.summary.wroteNew} wrote, ${result.summary.skippedExisting} skipped, ${result.summary.pairedSourcesWritten} paired source(s)`,
        );
      }
      process.exit(0);
    }

    const dest = resolveDest(a);
    assertDestNotSymlink(dest);
    const { slugs, persona } = resolveSlugs(gbrainRoot, a);
    const mode = a.stub ? 'stub' : 'full';

    if (a.stub) await stubPreflight(gbrainRoot, slugs);

    const plan = planHarnessBridge({ gbrainRoot, destDir: dest, slugs, mode });
    const result = applyHarnessBridge(plan, {
      harness: a.harness,
      scope: a.harness === 'claude-code' ? a.scope : undefined,
      persona,
      gbrainVersion: VERSION,
      dryRun: a.dryRun,
      nowIso: new Date().toISOString(),
    });

    // Coexistence: these same skills may also load from the gbrain plugin
    // snapshot (marketplace install) — duplicate names in one session.
    const coexistence = {
      plugin_lane_overlap: slugs,
      skipped_existing: result.summary.skippedExisting,
    };

    if (a.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            harness: a.harness,
            dest,
            persona,
            mode,
            dryRun: result.dryRun,
            summary: result.summary,
            coexistence,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        `${a.dryRun ? `scaffold --harness ${a.harness} (dry-run)` : `scaffold --harness ${a.harness}`}: ` +
          `${result.summary.wroteNew} wrote, ${result.summary.skippedExisting} skipped → ${dest}\n` +
          `persona: ${persona ?? '(explicit picks)'} | mode: ${mode}` +
          (result.summary.pairedSourcesSkipped > 0
            ? ` | ${result.summary.pairedSourcesSkipped} paired source(s) skipped (no src tree in a harness dir)`
            : '') +
          (result.summary.auxSkippedForStub > 0 ? ` | ${result.summary.auxSkippedForStub} aux file(s) stub-skipped` : ''),
      );
      if (result.summary.modeConflicts.length > 0) {
        console.log(
          `\nmode_conflict (${result.summary.modeConflicts.length}): ${result.summary.modeConflicts.join(', ')}\n` +
            `  These skills are already installed in the other mode (the file marker is\n` +
            `  ground truth). Never silently converted — remove them first, then re-run:\n` +
            `  gbrain skillpack remove --harness ${a.harness}${a.dest ? ' --dest <dir>' : ''} --skill <slug>`,
        );
      }
      // Bridge harnesses only reach here (openclaw returned above): the same
      // names may also load from the marketplace plugin snapshot.
      console.log(
        `\nNote: these skill names may also load from the gbrain plugin snapshot if the\n` +
          `marketplace plugin is installed — duplicate names coexist in one session;\n` +
          `prefer one lane per machine.`,
      );
      if (!a.dryRun && result.summary.wroteNew > 0) {
        console.log(`\nUpdate lens: gbrain skillpack reference --harness ${a.harness} | remove: gbrain skillpack remove --harness ${a.harness}`);
      }
    }
    process.exit(0);
  } catch (err) {
    exitTyped('scaffold --harness', err);
  }
}

// ---------------------------------------------------------------------------
// reference --harness
// ---------------------------------------------------------------------------

export async function cmdReferenceHarness(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'gbrain skillpack reference --harness <h> [<slug>] [--dest PATH] [--apply-clean-hunks] [--dry-run] [--json]\n\n' +
        'Diff a harness install against gbrain\'s current bundle. Stub installs\n' +
        'diff against the RENDERED stub (a fresh stub reads identical). With the\n' +
        'install-time hash ledger, differs splits into local_edit vs\n' +
        'upstream_drift. --apply-clean-hunks lands non-conflicting hunks on\n' +
        'full-mode files only (stubs are regenerated by re-running scaffold).',
    );
    process.exit(0);
  }
  const a = parseHarnessArgs(args, 'reference --harness');
  if (a.harness === 'openclaw') {
    console.error('Error: openclaw installs are workspace scaffolds — use `gbrain skillpack reference <name>` (no harness flag).');
    process.exit(2);
  }
  const gbrainRoot = findGbrainOrDie();
  const dest = resolveDest(a);
  const positional = a.positional[0] ?? null;

  try {
    const state = loadBridgeState();
    const entry = findBridgeEntry(state, { harness: a.harness, dest });
    const slugs = positional
      ? [positional]
      : a.skills.length > 0
        ? a.skills
        : entry && Object.keys(entry.written).length > 0
          ? Object.keys(entry.written).sort()
          : resolveSlugs(gbrainRoot, a).slugs;

    if (a.applyCleanHunks) {
      if (!positional && a.skills.length === 0) {
        console.error('Error: --apply-clean-hunks needs a single skill (apply one at a time).');
        process.exit(2);
      }
      const result = runHarnessReferenceApply({ gbrainRoot, destDir: dest, slugs, harness: a.harness, dryRun: a.dryRun });
      if (a.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(
          `reference --harness --apply-clean-hunks: ${result.summary.totalHunksApplied} hunk(s) applied, ` +
            `${result.summary.totalHunksConflicted} conflict(s), ${result.summary.refusedStub} stub file(s) refused`,
        );
        for (const f of result.files) {
          if (f.status === 'identical' || f.status === 'missing') continue;
          console.log(`  ${f.status.padEnd(12)} ${f.relTarget}`);
          for (const c of f.conflicts) console.log(`    ${c}`);
        }
      }
      process.exit(0);
    }

    const result = runHarnessReference({ gbrainRoot, destDir: dest, slugs, harness: a.harness });
    if (a.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(
        `reference --harness ${a.harness} (${dest}): identical:${result.summary.identical} differs:${result.summary.differs} missing:${result.summary.missing}`,
      );
      for (const f of result.files) {
        if (f.status === 'identical') continue;
        const kind = f.differsKind ? ` [${f.differsKind}]` : '';
        console.log(`\n  ${f.status.padEnd(10)}${kind} ${f.relTarget}`);
        if (f.unifiedDiff) console.log(f.unifiedDiff);
      }
      if (result.summary.differs > 0) {
        console.log(
          '\n  local_edit → your change; keep it (gbrain is reference, not law).\n' +
            '  upstream_drift → gbrain moved; `gbrain skillpack reference --harness ' + a.harness + ' <slug> --apply-clean-hunks` to align.',
        );
      }
    }
    process.exit(0);
  } catch (err) {
    exitTyped('reference --harness', err);
  }
}

// ---------------------------------------------------------------------------
// remove (harness lane only — the v0.33 workspace `uninstall` stays removed)
// ---------------------------------------------------------------------------

export async function cmdRemove(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(
      'gbrain skillpack remove --harness <h> [--dest PATH] [--skill <slug>]... [--dry-run] [--json]\n\n' +
        'Remove files the harness bridge WROTE (the bridge-state ledger) — never\n' +
        'your own files: pre-existing and locally-created files were never\n' +
        'recorded as owned. Without --skill, removes every owned skill for the\n' +
        '(harness, dest). Shared convention files stay (other skills use them).\n\n' +
        'This is NOT the removed-in-v0.33 workspace uninstall: workspace scaffolds\n' +
        'are user-owned outright (delete their directories yourself).',
    );
    process.exit(args.length === 0 ? 2 : 0);
  }
  const a = parseHarnessArgs(args, 'remove');
  if (a.harness === 'openclaw') {
    console.error(
      'Error: openclaw installs are user-owned workspace scaffolds — remove skill\n' +
        'directories yourself (the files are yours).',
    );
    process.exit(2);
  }
  const dest = resolveDest(a);
  try {
    const result = removeHarnessBridge({
      harness: a.harness,
      destDir: dest,
      slugs: a.skills.length > 0 ? a.skills : null,
      dryRun: a.dryRun,
      nowIso: new Date().toISOString(),
    });
    if (a.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(
        `${a.dryRun ? 'remove (dry-run)' : 'remove'}: ${result.removedFiles.length} owned file(s) removed, ` +
          `${result.prunedDirs.length} empty dir(s) pruned` +
          (result.notOwned.length > 0 ? ` — not owned (untouched): ${result.notOwned.join(', ')}` : ''),
      );
    }
    process.exit(0);
  } catch (err) {
    exitTyped('remove', err);
  }
}

// ---------------------------------------------------------------------------
// status — installed-bridges section (called by the façade's cmdStatus)
// ---------------------------------------------------------------------------

export interface BridgesStatusEntry {
  harness: string;
  dest: string;
  persona: string | null;
  mode: string;
  slugs: number;
  identical: number;
  differs: number;
  missing: number;
}

/**
 * Render the installed-bridges section for `skillpack status`. Per-slug
 * currency comes from the harness reference lens (expected content), NOT
 * skills.lock hashes — lock hashes can never match stubs and cannot
 * separate upstream drift from local edits.
 */
export function collectBridgesStatus(gbrainRoot: string): BridgesStatusEntry[] {
  const state = loadBridgeState();
  const out: BridgesStatusEntry[] = [];
  for (const entry of state.entries) {
    const slugs = Object.keys(entry.written).sort();
    let identical = 0;
    let differs = 0;
    let missing = 0;
    try {
      const ref = runHarnessReference({
        gbrainRoot,
        destDir: entry.dest,
        slugs,
        harness: entry.harness,
      });
      identical = ref.summary.identical;
      differs = ref.summary.differs;
      missing = ref.summary.missing;
    } catch {
      // Lens failure (moved dest, deleted skills) → report zeros; the entry
      // row itself still surfaces the install.
    }
    out.push({
      harness: entry.harness,
      dest: entry.dest,
      persona: entry.last_persona,
      mode: entry.last_mode,
      slugs: slugs.length,
      identical,
      differs,
      missing,
    });
  }
  return out;
}

export function printBridgesStatus(gbrainRoot: string): void {
  const entries = collectBridgesStatus(gbrainRoot);
  if (entries.length === 0) return;
  console.log('\nHarness bridges (gbrain skillpack scaffold with a harness):');
  for (const e of entries) {
    console.log(
      `  ${e.harness.padEnd(12)} ${e.dest}\n` +
        `    persona:${e.persona ?? '(picks)'} mode:${e.mode} skills:${e.slugs} — identical:${e.identical} differs:${e.differs} missing:${e.missing}`,
    );
  }
}

// ---------------------------------------------------------------------------

function exitTyped(cmd: string, err: unknown): never {
  if (
    err instanceof BridgeError ||
    err instanceof PersonaError ||
    err instanceof BundleError ||
    err instanceof ScaffoldError
  ) {
    console.error(`skillpack ${cmd}: ${(err as Error).message}`);
    process.exit(2);
  }
  throw err;
}

/** Exposed for the contract test: the stub/preflight text hardcodes that
 *  get_skill is absent from the starter MCP surface. If STARTER_OPS ever
 *  gains get_skill, the pinned test fails and this copy must update. */
export const HARDCODED_SURFACE_FACT = 'get_skill is full-surface only (not in the starter op set)';

// Re-exported so tests can drive the state path used by status.
export { defaultBridgeStatePath, loadPersonas };
