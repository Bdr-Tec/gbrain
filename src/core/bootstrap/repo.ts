/**
 * `gbrain bootstrap repo` — private-repo creation with a hard privacy gate
 * [G8, CX2-1, plan D6]. Library module: the CLI dispatcher wires it later.
 *
 * Invariants (G8):
 *  - Refuses ANY pre-existing `origin` remote unless the manifest says
 *    `initialized` AND this machine's receipt proves we created it (crash
 *    re-run). An initialized clone with a foreign origin is attach territory.
 *  - After create, repo privacy is verified via the GitHub API; the answer
 *    must be the literal `true`. "Couldn't verify" (rate limit / 5xx) is a
 *    typed refuse-and-re-run, NEVER treated as private or public. The first
 *    push happens only AFTER the verify passes (create runs without --push).
 *  - Idempotent re-runs key off the REMOTE URL, not the name probe — a name
 *    probe can be fooled by an unrelated repo taking the slug. A receipt
 *    missing repo_url (crash window) adopts an origin only when the authed
 *    gh user owns it; undefined is never a wildcard.
 *
 * All gh/git interaction goes through an injectable `ExecRunner` so tests use
 * a recording fake; the default spawns via Bun. Commands are argv arrays
 * (never shell strings); git commands carry `-C <workspace>` and
 * `gh repo create` uses `--source <workspace>` so the runner needs no cwd.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../config.ts';
import { realpathOrResolve } from '../path-confine.ts';
import { loadWorkspaceAllowlist, scanFiles, SCAN_ALLOW_FILENAME } from '../secret-scan.ts';
import { GITHUB_URL_PLACEHOLDER } from './assets.ts';
import {
  guardReceiptOverwrite,
  readManifest,
  readReceipt,
  writeReceipt,
  type AgentManifest,
  type InstallReceipt,
  type ManifestState,
} from './format.ts';
import { BootstrapError } from './lock.ts';

// ---------------------------------------------------------------------------
// Exec seam (shared by uninstall.ts; the dispatcher passes the real runner)
// ---------------------------------------------------------------------------

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable subprocess seam. argv[0] is the binary; never a shell string. */
export type ExecRunner = (argv: string[]) => Promise<ExecResult>;

/** Default runner: Bun.spawn, both streams piped, spawn failure → code 127. */
export const defaultRunner: ExecRunner = async (argv: string[]): Promise<ExecResult> => {
  try {
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (e) {
    // Binary not on PATH (or unspawnable) — the conventional not-found code.
    return { code: 127, stdout: '', stderr: (e as Error).message };
  }
};

// ---------------------------------------------------------------------------
// Receipt extension: the created repo URL [CX2-12 idempotency key]
// ---------------------------------------------------------------------------

/** The receipt gains the created repo URL; format.ts consumers tolerate
 * unknown fields, so this is a structural extension, not a format bump. */
export interface RepoReceipt extends InstallReceipt {
  repo_url?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** GitHub repo-name slug: lowercase, alnum runs joined by '-'. */
export function slugifyRepoName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'agent';
}

/** Parse owner/name out of an https or ssh GitHub remote URL. */
export function parseGithubRemote(url: string): { owner: string; name: string } | null {
  const m =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim()) ??
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url.trim());
  return m ? { owner: m[1], name: m[2] } : null;
}

/** Re-exported for existing consumers; the single definition lives in
 * assets.ts (shared with render.ts's DERIVED_DEFAULTS). */
export { GITHUB_URL_PLACEHOLDER };

function requireInitializedManifest(workspaceDir: string): { state: ManifestState; manifest: AgentManifest } {
  const state = readManifest(workspaceDir);
  switch (state.state) {
    case 'initialized':
      return { state, manifest: state.manifest };
    case 'template':
      throw new BootstrapError(
        'TEMPLATE_UNINITIALIZED',
        'this is an uninitialized template — run `gbrain bootstrap render` first',
      );
    case 'absent':
      throw new BootstrapError(
        'NOT_A_WORKSPACE',
        `not an agent workspace (no agent.json in ${workspaceDir}) — run \`gbrain bootstrap render\` first`,
      );
    case 'invalid':
      throw new BootstrapError('MANIFEST_INVALID', `agent.json is invalid: ${state.reason}`);
    case 'newer_format':
      throw new BootstrapError(
        'NEWER_FORMAT',
        `agent.json format_version ${state.manifest.format_version} is newer than this gbrain understands — upgrade gbrain first`,
      );
  }
}

function isRateLimitOr5xx(stderr: string): boolean {
  return /HTTP 5\d\d|HTTP 429|rate limit/i.test(stderr);
}

/** The authenticated gh login, or null when it cannot be read/parsed. */
async function fetchAuthedLogin(runner: ExecRunner): Promise<string | null> {
  const res = await runner(['gh', 'api', 'user']);
  if (res.code !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout) as { login?: unknown };
    return typeof parsed.login === 'string' && parsed.login.length > 0 ? parsed.login : null;
  } catch {
    return null;
  }
}

/**
 * Privacy verify [G8]: `gh api repos/{owner}/{name} --jq .private` must print
 * the literal `true`. Any failure to VERIFY is VERIFY_UNAVAILABLE (refuse +
 * re-run) — never interpreted as an answer. An affirmative non-`true` answer
 * is the hard REPO_NOT_PRIVATE stop. Defense in depth: the repo owner must be
 * the authenticated gh user — a private repo someone ELSE owns is still not
 * ours to bless.
 */
async function verifyRepoPrivate(runner: ExecRunner, owner: string, name: string): Promise<void> {
  const login = await fetchAuthedLogin(runner);
  if (login === null) {
    throw new BootstrapError(
      'VERIFY_UNAVAILABLE',
      `could not read the authenticated GitHub user to verify ownership of ${owner}/${name} — check \`gh auth status\` and re-run \`gbrain bootstrap repo\`.`,
      { details: { owner, name } },
    );
  }
  if (login !== owner) {
    throw new BootstrapError(
      'ORIGIN_EXISTS',
      `${owner}/${name} is owned by ${owner}, not the authenticated GitHub user (${login}) — ` +
        'bootstrap only blesses repos it created under your own account. ' +
        'If this is a clone of an existing agent workspace, run `gbrain bootstrap attach` instead.',
      { details: { owner, name, login } },
    );
  }
  const res = await runner(['gh', 'api', `repos/${owner}/${name}`, '--jq', '.private']);
  if (res.code !== 0) {
    const reason = isRateLimitOr5xx(res.stderr) ? 'GitHub API rate limit / server error' : `gh api failed: ${res.stderr.trim() || `exit ${res.code}`}`;
    throw new BootstrapError(
      'VERIFY_UNAVAILABLE',
      `could not verify that ${owner}/${name} is private (${reason}). ` +
        'The repo may be fine — re-run `gbrain bootstrap repo` to verify. Nothing is pushed to a repo whose privacy is unverified.',
      { details: { owner, name, stderr: res.stderr } },
    );
  }
  if (res.stdout.trim() !== 'true') {
    throw new BootstrapError(
      'REPO_NOT_PRIVATE',
      `${owner}/${name} is NOT private (API said: ${res.stdout.trim() || 'empty'}). ` +
        'Make it private in the GitHub settings (or delete it) before re-running `gbrain bootstrap repo`.',
      { details: { owner, name, answer: res.stdout.trim() } },
    );
  }
}

/** Replace the GITHUB.md placeholder line with the real URL (simple string
 * replace; also fills a still-raw {{GITHUB_REPO_URL}} token defensively so a
 * later verify token-sweep can't trip on it). */
function updateGithubMd(workspaceDir: string, url: string): void {
  const path = join(workspaceDir, 'GITHUB.md');
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  const next = raw.split(GITHUB_URL_PLACEHOLDER).join(url).split('{{GITHUB_REPO_URL}}').join(url);
  if (next !== raw) writeFileSync(path, next, 'utf8');
}

/** Record the created repo URL on the machine-local receipt. Creates a minimal
 * receipt when render's is missing (crash between render and receipt write). */
function recordRepoInReceipt(gbrainHomeDir: string, workspaceDir: string, manifest: AgentManifest, url: string): void {
  const existing = readReceipt(gbrainHomeDir) as RepoReceipt | null;
  const receipt: RepoReceipt = existing ?? {
    receipt_version: 1,
    workspace_dir: realpathOrResolve(workspaceDir),
    source_id: manifest.source_id,
    agent_name: manifest.agent_name,
    created_at: new Date().toISOString(),
    created_by: manifest.created_by,
    brain_created_by_bootstrap: false,
    created_paths: [],
    registrations: [],
  };
  receipt.repo_url = url;
  // writeReceipt assumes the bootstrap/ subdir exists (render creates it);
  // repo may run first after a crash, so create it defensively.
  mkdirSync(join(gbrainHomeDir, 'bootstrap'), { recursive: true });
  const guard = guardReceiptOverwrite(gbrainHomeDir); // throws on newer-format receipts
  if (guard.brokenBackupPath) {
    console.error(`WARNING: the install receipt was unreadable; backed it up to ${guard.brokenBackupPath} and wrote a fresh one.`);
  }
  writeReceipt(gbrainHomeDir, receipt);
}

// ---------------------------------------------------------------------------
// First-push content + push-target binding [FIX3, FIX4]
// ---------------------------------------------------------------------------

/** Files git would include in a commit right now (staged + untracked, minus
 * ignored), relative to the workspace — the input to the pre-commit scan. */
async function stagedAndUntrackedFiles(runner: ExecRunner, workspaceDir: string): Promise<string[]> {
  const res = await runner([
    'git', '-C', workspaceDir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z',
  ]);
  if (res.code !== 0) return [];
  return res.stdout.split('\0').filter((s) => s.length > 0);
}

/** Secret scan the given workspace-relative files; throw on any finding. This
 * is the SAME scanner bootstrap verify uses (src/core/secret-scan.ts) — the
 * first push is NEVER made without it. */
function secretScanOrThrow(workspaceDir: string, relFiles: string[]): void {
  const allowlist = loadWorkspaceAllowlist(workspaceDir);
  const findings = scanFiles(relFiles.map((f) => join(workspaceDir, f)), {
    allowlist,
    workspaceRoot: workspaceDir,
  });
  if (findings.length > 0) {
    const sample = findings.slice(0, 5).map((f) => `${f.file}:${f.line} [${f.pattern}]`).join('; ');
    throw new BootstrapError(
      'SECRET_SCAN_BLOCKED',
      `secret scan found ${findings.length} finding(s) before the first push: ${sample}` +
        `${findings.length > 5 ? '; …' : ''} — nothing was committed or pushed. ` +
        `Remove the secret(s), or allowlist a false positive in ${SCAN_ALLOW_FILENAME}, then re-run \`gbrain bootstrap repo\`.`,
      { details: { findings: findings.length } },
    );
  }
}

/**
 * Guarantee at least one commit exists so the first push has content — the
 * freshly-rendered workspace is uncommitted, so a bare `git push` would fail
 * ("src refspec ... does not match") and (on retry) the adoption path would
 * false-succeed against an empty remote. Stages everything, runs the secret
 * scan (NEVER bypassed), commits. No-op when a commit already exists and the
 * tree is clean.
 */
async function ensureWorkspaceCommit(runner: ExecRunner, workspaceDir: string): Promise<void> {
  const head = await runner(['git', '-C', workspaceDir, 'rev-parse', '--verify', 'HEAD']);
  const hasCommit = head.code === 0;
  const statusRes = await runner(['git', '-C', workspaceDir, 'status', '--porcelain']);
  const dirty = statusRes.code === 0 && statusRes.stdout.trim().length > 0;
  if (hasCommit && !dirty) return; // there is already something to push

  const add = await runner(['git', '-C', workspaceDir, 'add', '-A']);
  if (add.code !== 0) {
    throw new BootstrapError(
      'REPO_CREATE_FAILED',
      `git add failed before the first commit: ${add.stderr.trim() || `exit ${add.code}`}`,
    );
  }

  // Secret scan the staged+untracked set — do NOT bypass it [G8/D6].
  const files = await stagedAndUntrackedFiles(runner, workspaceDir);
  secretScanOrThrow(workspaceDir, files);

  const staged = await runner(['git', '-C', workspaceDir, 'diff', '--cached', '--name-only']);
  const nothingStaged = staged.code === 0 && staged.stdout.trim().length === 0;
  if (nothingStaged) {
    if (hasCommit) return; // clean commit already exists; nothing new to add
    throw new BootstrapError(
      'REPO_CREATE_FAILED',
      'the workspace has no files to commit — render identity files first (`gbrain bootstrap render`), then re-run `gbrain bootstrap repo`',
    );
  }

  const commit = await runner(['git', '-C', workspaceDir, 'commit', '-m', 'gbrain: bootstrap workspace']);
  if (commit.code !== 0 && !hasCommit) {
    throw new BootstrapError(
      'REPO_CREATE_FAILED',
      `git commit failed before the first push: ${commit.stderr.trim() || `exit ${commit.code}`}`,
    );
  }
}

/** The current branch, defaulting to 'main' (a pre-first-commit HEAD reports
 * 'HEAD' / errors). */
async function currentBranch(runner: ExecRunner, workspaceDir: string): Promise<string> {
  const res = await runner(['git', '-C', workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const b = res.code === 0 ? res.stdout.trim() : '';
  return b && b !== 'HEAD' ? b : 'main';
}

/**
 * [FIX4/G8] Bind the just-verified privacy result to the ACTUAL push target.
 * A concurrent `git remote set-url origin …` between verify and push could
 * redirect content elsewhere; re-read origin and refuse unless it still parses
 * to the owner/name we verified private.
 */
async function assertOriginMatches(
  runner: ExecRunner,
  workspaceDir: string,
  owner: string,
  name: string,
): Promise<void> {
  const res = await runner(['git', '-C', workspaceDir, 'remote', 'get-url', 'origin']);
  const url = res.code === 0 ? res.stdout.trim() : '';
  const parsed = url ? parseGithubRemote(url) : null;
  if (!parsed || parsed.owner !== owner || parsed.name !== name) {
    throw new BootstrapError(
      'ORIGIN_EXISTS',
      `origin now resolves to ${url || '(unset)'}, not the verified-private ${owner}/${name} — refusing to push. ` +
        'The remote changed after the privacy verification; restore it (git remote set-url origin <the created repo>) ' +
        'and re-run `gbrain bootstrap repo`.',
      { details: { expected: `${owner}/${name}`, actual: url } },
    );
  }
}

/**
 * [FIX3] The adoption/idempotent path must not report reused-success against an
 * empty remote (a prior run that created the repo + set origin but whose push
 * failed). Lightweight `ls-remote` check: if the branch is already on the
 * remote, the workspace is genuinely pushed; otherwise complete the push
 * (scan-gated, bound to the verified origin [FIX4]).
 */
async function ensureRemoteHasWorkspace(
  runner: ExecRunner,
  workspaceDir: string,
  owner: string,
  name: string,
): Promise<void> {
  const branch = await currentBranch(runner, workspaceDir);
  const ls = await runner(['git', '-C', workspaceDir, 'ls-remote', '--heads', 'origin', branch]);
  const remoteHasBranch = ls.code === 0 && ls.stdout.trim().length > 0;
  if (remoteHasBranch) return; // genuinely pushed — reused success is honest

  await ensureWorkspaceCommit(runner, workspaceDir);
  const pushBranch = await currentBranch(runner, workspaceDir);
  await assertOriginMatches(runner, workspaceDir, owner, name);
  const push = await runner(['git', '-C', workspaceDir, 'push', '-u', 'origin', pushBranch]);
  if (push.code !== 0) {
    throw new BootstrapError(
      'REPO_CREATE_FAILED',
      `completing the deferred first push to ${owner}/${name} failed: ${push.stderr.trim() || `exit ${push.code}`} — ` +
        'the repo exists and is private; commit your work and re-run `gbrain bootstrap repo`',
      { details: { branch: pushBranch, stderr: push.stderr } },
    );
  }
}

// ---------------------------------------------------------------------------
// createPrivateRepo
// ---------------------------------------------------------------------------

export interface CreatePrivateRepoOptions {
  runner?: ExecRunner;
  /** The gbrain home holding the install receipt (default: configDir()). */
  gbrainHomeDir?: string;
}

export interface CreatePrivateRepoResult {
  url: string;
  name: string;
  /** True when a pre-existing origin created by a prior run was adopted
   * (idempotent re-run) instead of creating a new repo. */
  reused: boolean;
}

/**
 * Create (or idempotently re-verify) the dedicated private GitHub repo for an
 * initialized agent workspace. See module header for the G8 invariants.
 */
export async function createPrivateRepo(
  workspaceDir: string,
  opts: CreatePrivateRepoOptions = {},
): Promise<CreatePrivateRepoResult> {
  const runner = opts.runner ?? defaultRunner;
  const gbrainHomeDir = opts.gbrainHomeDir ?? configDir();

  // Gate 1: gh on PATH. Exit-code-2 semantics — the human installs gh.
  const ghVersion = await runner(['gh', '--version']);
  if (ghVersion.code !== 0) {
    throw new BootstrapError(
      'GH_MISSING',
      '`gh` (GitHub CLI) is not available on PATH — install it (https://cli.github.com), then re-run `gbrain bootstrap repo`',
      { exitCode: 2 },
    );
  }

  // Gate 2: authenticated. Exit-code-2 — the human runs `gh auth login`.
  const ghAuth = await runner(['gh', 'auth', 'status']);
  if (ghAuth.code !== 0) {
    throw new BootstrapError(
      'GH_AUTH',
      'GitHub CLI is not authenticated — run `gh auth login`, then re-run `gbrain bootstrap repo`',
      { exitCode: 2, details: { stderr: ghAuth.stderr } },
    );
  }

  // Gate 3: manifest must say initialized (render ran) [CX2-1].
  const { manifest } = requireInitializedManifest(workspaceDir);

  // Gate 4: pre-existing origin [G8]. The ONLY acceptable origin is one a
  // prior run on THIS machine created (receipt-keyed, matched by remote URL).
  const originRes = await runner(['git', '-C', workspaceDir, 'remote', 'get-url', 'origin']);
  if (originRes.code === 0 && originRes.stdout.trim()) {
    const originUrl = originRes.stdout.trim();
    const receipt = readReceipt(gbrainHomeDir) as RepoReceipt | null;
    const sameWorkspace =
      receipt !== null && realpathOrResolve(receipt.workspace_dir) === realpathOrResolve(workspaceDir);
    // Adoption requires an EXACT repo_url match. A receipt without a recorded
    // repo_url (crash between create and record) may adopt ONLY when the
    // authenticated gh user owns the origin — undefined is never a wildcard.
    let adoptable = sameWorkspace && receipt.repo_url === originUrl;
    if (!adoptable && sameWorkspace && receipt.repo_url === undefined) {
      const parsedOrigin = parseGithubRemote(originUrl);
      if (parsedOrigin) {
        const login = await fetchAuthedLogin(runner);
        adoptable = login !== null && login === parsedOrigin.owner;
      }
    }
    if (!adoptable) {
      throw new BootstrapError(
        'ORIGIN_EXISTS',
        `this workspace already has an \`origin\` remote (${originUrl}) that bootstrap did not create. ` +
          '`gbrain bootstrap repo` always creates a dedicated private repo. ' +
          'If this is a clone of an existing agent workspace, run `gbrain bootstrap attach` instead.',
        { details: { origin: originUrl } },
      );
    }
    // Idempotent re-run: adopt our own origin, re-verify privacy, re-record.
    const parsed = parseGithubRemote(originUrl);
    if (!parsed) {
      throw new BootstrapError(
        'ORIGIN_EXISTS',
        `the recorded bootstrap origin (${originUrl}) is not a GitHub remote — cannot verify privacy; fix the remote or remove it and re-run`,
        { details: { origin: originUrl } },
      );
    }
    await verifyRepoPrivate(runner, parsed.owner, parsed.name);
    updateGithubMd(workspaceDir, originUrl);
    recordRepoInReceipt(gbrainHomeDir, workspaceDir, manifest, originUrl);
    // [FIX3] Don't report reused-success on an empty remote — a prior run may
    // have created the repo + set origin but failed to push. Verify the remote
    // actually has our branch; complete the (scan-gated) push if it doesn't.
    await ensureRemoteHasWorkspace(runner, workspaceDir, parsed.owner, parsed.name);
    return { url: originUrl, name: parsed.name, reused: true };
  }

  // Ensure a git repo exists (main branch on fresh init).
  const gitDir = await runner(['git', '-C', workspaceDir, 'rev-parse', '--git-dir']);
  if (gitDir.code !== 0) {
    const init = await runner(['git', '-C', workspaceDir, 'init', '-b', 'main']);
    if (init.code !== 0) {
      throw new BootstrapError('REPO_CREATE_FAILED', `git init failed: ${init.stderr.trim() || `exit ${init.code}`}`);
    }
  }

  // Repo-local identity from the authed gh user (never global git config).
  const userRes = await runner(['gh', 'api', 'user']);
  if (userRes.code !== 0) {
    throw new BootstrapError(
      'GH_AUTH',
      `could not read the authenticated GitHub user (gh api user failed: ${userRes.stderr.trim() || `exit ${userRes.code}`}) — check \`gh auth status\``,
      { exitCode: 2 },
    );
  }
  let login: string;
  let userId: number | string;
  try {
    const parsed = JSON.parse(userRes.stdout) as { login?: unknown; id?: unknown };
    if (typeof parsed.login !== 'string' || parsed.login.length === 0) throw new Error('missing login');
    login = parsed.login;
    userId = typeof parsed.id === 'number' || typeof parsed.id === 'string' ? parsed.id : 0;
  } catch (e) {
    throw new BootstrapError('GH_AUTH', `unexpected \`gh api user\` output (${(e as Error).message})`, { exitCode: 2 });
  }
  await runner(['git', '-C', workspaceDir, 'config', 'user.name', login]);
  await runner(['git', '-C', workspaceDir, 'config', 'user.email', `${userId}+${login}@users.noreply.github.com`]);

  // Name: slug(agent_name)-workspace, probed for availability, suffix -2..-100.
  // The probe is best-effort convenience; `gh repo create` remains the
  // authority (a probe fooled by rate limiting surfaces as a loud create
  // failure, never a silent wrong-repo adoption — idempotency keys off the
  // remote URL, not this probe) [G8].
  const base = `${slugifyRepoName(manifest.agent_name)}-workspace`;
  let name: string | null = null;
  for (let i = 1; i <= 100; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const probe = await runner(['gh', 'repo', 'view', `${login}/${candidate}`]);
    if (probe.code !== 0) {
      name = candidate;
      break;
    }
  }
  if (name === null) {
    throw new BootstrapError(
      'REPO_CREATE_FAILED',
      `could not find a free repo name after 100 candidates (base: ${base}) — delete stale ${base}-* repos or rename the agent`,
    );
  }

  // Create: private, sourced from the workspace. Deliberately WITHOUT --push:
  // nothing leaves this machine until the privacy bit is verified [G8].
  const create = await runner(['gh', 'repo', 'create', name, '--private', '--source', workspaceDir]);
  if (create.code !== 0) {
    throw new BootstrapError(
      'REPO_CREATE_FAILED',
      `gh repo create failed: ${create.stderr.trim() || `exit ${create.code}`}`,
      { details: { name, stderr: create.stderr } },
    );
  }

  // The remote URL is the durable identity (idempotency key). Prefer what git
  // actually recorded; fall back to the constructed URL.
  const postOrigin = await runner(['git', '-C', workspaceDir, 'remote', 'get-url', 'origin']);
  const url = postOrigin.code === 0 && postOrigin.stdout.trim() ? postOrigin.stdout.trim() : `https://github.com/${login}/${name}`;

  // PRIVACY VERIFY [G8] — the hard gate, BEFORE the first push. Must be the
  // literal `true`; only then does any workspace content leave this machine.
  await verifyRepoPrivate(runner, login, name);

  // [FIX3] Ensure the first push has content: a freshly-rendered workspace is
  // uncommitted, so stage + secret-scan + commit before pushing (create →
  // verify → commit → push; the scan is never bypassed).
  await ensureWorkspaceCommit(runner, workspaceDir);

  const branch = await currentBranch(runner, workspaceDir);
  // [FIX4] Bind the verified privacy result to the actual push target.
  await assertOriginMatches(runner, workspaceDir, login, name);
  const push = await runner(['git', '-C', workspaceDir, 'push', '-u', 'origin', branch]);
  if (push.code !== 0) {
    throw new BootstrapError(
      'REPO_CREATE_FAILED',
      `git push to the verified-private repo failed: ${push.stderr.trim() || `exit ${push.code}`} — the repo exists and is private; commit your work and re-run \`gbrain bootstrap repo\``,
      { details: { name, branch, stderr: push.stderr } },
    );
  }

  updateGithubMd(workspaceDir, url);
  recordRepoInReceipt(gbrainHomeDir, workspaceDir, manifest, url);
  return { url, name, reused: false };
}
