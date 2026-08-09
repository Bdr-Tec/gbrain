/**
 * Repo-path hygiene (incident 2026-07-02).
 *
 * Invariant: a repo path is resolved to an absolute path exactly once, at
 * arg ingress; storage (config `sync.repo_path`, `sources.local_path`,
 * generated daemon wrapper scripts) never holds a relative path; a relative
 * value read back from storage is a hard error, never silently resolved
 * against cwd.
 *
 * Why: `sync.repo_path` persisted as "." made a later bare `gbrain sync`
 * from an unrelated project directory import THAT tree as the brain source
 * and reconcile every real brain page as "source file removed" — dropping
 * the links/timeline graph rows. Files survive in git; db-only rows don't.
 */
import { isAbsolute, resolve } from 'path';

/**
 * Resolve a user-typed --repo/--path argument against cwd at parse time.
 * Typing a relative path interactively stays legal — the shell's cwd is the
 * user's stated intent at that moment. What must never happen is persisting
 * the relative form.
 */
export function resolveRepoArg(p: string): string {
  return resolve(p);
}

/**
 * Remediation hint for `sources.local_path` rows: the per-source sync repoint
 * (matches the `sync --all` relative-path skip message shape).
 */
export function sourceLocalPathRemediation(sourceId: string): string {
  return `Fix it once with an absolute path: gbrain sync --source ${sourceId} --repo <absolute-path>.`;
}

/**
 * Remediation hint for minion job payloads: a queued row can't be edited in
 * place — the only fix is a fresh submission.
 */
export const JOB_PAYLOAD_REMEDIATION =
  'Cancel this job and resubmit it with an absolute path.';

/**
 * Guard for repo paths read back from storage. Refuses to resolve a relative
 * value against the current cwd — that is exactly the wrong-tree footgun:
 * whichever directory the next bare invocation happens to run from becomes
 * the sync source.
 *
 * `remediation` lets the caller name the fix command that matches WHERE the
 * bad value is stored (sources.local_path → per-source sync repoint; job
 * payload → resubmit; default → the config-anchor sync --repo / config set
 * pair). Optional for backward compatibility.
 */
export function requireAbsoluteStoredPath(
  value: string,
  storageDesc: string,
  remediation?: string,
): string {
  if (isAbsolute(value)) return value;
  const fix = remediation ??
    'Fix it once with an absolute path: gbrain sync --repo <absolute-path> ' +
    '(or: gbrain config set sync.repo_path <absolute-path>).';
  throw new Error(
    `${storageDesc} holds a relative path "${value}". Refusing to resolve it against ` +
    `the current directory — a bare invocation from the wrong cwd would sync the wrong ` +
    `tree. ${fix}`,
  );
}
