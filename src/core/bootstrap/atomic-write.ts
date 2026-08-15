/**
 * atomic-write.ts — the ONE atomic config-file writer for bootstrap host
 * surfaces (rule-of-three extraction: hooks.ts settings JSON, codex-toml.ts
 * TOML text, opencode-json.ts JSONC text all swap through here).
 *
 * Semantics, hardened for shared user-scope targets [C10 / X11]:
 * - The SYMLINK TARGET is resolved first so a dotfile-manager-linked config
 *   survives as a link (a bare rename would replace the link with a regular
 *   file).
 * - tmp file uses a random suffix and inherits the EXISTING file's mode; a
 *   fresh file takes `freshMode` (caller's convention — secret-bearing
 *   targets pass 0o600). `forceMode` overrides both (codex-toml forces 0600
 *   because the file carries a bearer token regardless of its prior mode).
 * - chmod after write because writeFileSync's mode applies only on create.
 *
 * EOL and serialization stay caller-side: hooks.ts stringifies JSON,
 * codex-toml converts to CRLF when the original was CRLF, opencode-json
 * preserves EOLs naturally via jsonc-parser text splicing.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export function atomicWriteTextFile(
  path: string,
  text: string,
  opts?: { freshMode?: number; forceMode?: number },
): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(target), { recursive: true });
  let mode: number | undefined;
  if (opts?.forceMode !== undefined) {
    mode = opts.forceMode;
  } else {
    try {
      mode = statSync(target).mode & 0o777;
    } catch {
      mode = opts?.freshMode;
    }
  }
  const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, text, { encoding: 'utf8', ...(mode !== undefined ? { mode } : {}) });
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, target);
}
