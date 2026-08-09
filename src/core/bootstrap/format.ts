/**
 * Agent workspace format — the `agent.json` manifest and the machine-local
 * install receipt.
 *
 * `agent.json` is the ladder contract (docs/designs/AGENT_BOOTSTRAP_DESIGN.md):
 * any consumer (the desktop bootstrap, a hosted mount) validates a workspace
 * against this manifest. `format_version: 1` is PROVISIONAL — consumers must
 * tolerate unknown fields; a breaking layout change bumps the version with a
 * migration note.
 *
 * Two identity artifacts, deliberately distinct [CX2-1, CX2-12]:
 *  - `agent.json` travels IN the repo. `initialized: false` marks a template
 *    clone that has never been bootstrapped; `bootstrap render` flips it true
 *    atomically. Presence alone can NEVER discriminate a template clone from a
 *    machine-two clone — the sentinel does.
 *  - The install receipt lives OUTSIDE the repo (under the gbrain home) and
 *    proves that THIS MACHINE ran bootstrap. Uninstall is keyed to the receipt,
 *    never to the repo manifest, because template/attach clones inherit the
 *    manifest but not the receipt.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FORMAT_VERSION = 1;
export const AGENT_MANIFEST_FILENAME = 'agent.json';

/** Directories a format-v1 workspace carries (validated by `bootstrap verify`). */
export const WORKSPACE_CONTENT_DIRS = ['brain', 'memory', 'skills', 'state'] as const;

/** Identity files rendered from the interview (see templates/bootstrap/). */
export const WORKSPACE_IDENTITY_FILES = [
  'SOUL.md',
  'USER.md',
  'MEMORY.md',
  'AGENTS.md',
  'CLAUDE.md',
  'HEARTBEAT.md',
  'ACCESS_POLICY.md',
  'GITHUB.md',
] as const;

export interface AgentManifest {
  format_version: number;
  /** false in the published template repo; render flips it true atomically. */
  initialized: boolean;
  agent_name: string;
  /** gbrain version that created/last-rendered this workspace. */
  created_by: string;
  /** ISO date of first successful render. Canonical placeholder in templates [CX2-14]. */
  created_at: string;
  /** Source id this workspace's brain/ dir registers as. */
  source_id: string;
  /** Registered entry surfaces (informational). */
  surfaces?: string[];
  /** Tolerated, preserved, round-tripped: unknown fields from newer writers. */
  [key: string]: unknown;
}

/** Canonical placeholder values used by the template-repo generator so two
 * independent renders are byte-identical [CX2-14]. */
export const TEMPLATE_PLACEHOLDER_MANIFEST: AgentManifest = {
  format_version: FORMAT_VERSION,
  initialized: false,
  agent_name: '{{AGENT_NAME}}',
  created_by: 'template',
  created_at: '1970-01-01T00:00:00.000Z',
  source_id: 'workspace',
};

export type ManifestState =
  | { state: 'absent' }
  | { state: 'invalid'; reason: string }
  | { state: 'template'; manifest: AgentManifest }
  | { state: 'initialized'; manifest: AgentManifest }
  | { state: 'newer_format'; manifest: AgentManifest };

export function manifestPath(workspaceDir: string): string {
  return join(workspaceDir, AGENT_MANIFEST_FILENAME);
}

/**
 * Read + classify a workspace manifest. Never throws: the callers (attach,
 * render, uninstall, verify) branch on the state and must produce
 * agent-readable errors, not stack traces.
 */
export function readManifest(workspaceDir: string): ManifestState {
  const path = manifestPath(workspaceDir);
  if (!existsSync(path)) return { state: 'absent' };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { state: 'invalid', reason: `unreadable: ${(e as Error).message}` };
  }
  if (raw.includes('<<<<<<<') || raw.includes('>>>>>>>')) {
    return { state: 'invalid', reason: 'contains git conflict markers — resolve the merge in agent.json first' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { state: 'invalid', reason: `not valid JSON: ${(e as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { state: 'invalid', reason: 'manifest must be a JSON object' };
  }
  const m = parsed as Record<string, unknown>;
  if (typeof m.format_version !== 'number') {
    return { state: 'invalid', reason: 'missing numeric format_version' };
  }
  const manifest = m as unknown as AgentManifest;
  if (manifest.format_version > FORMAT_VERSION) {
    return { state: 'newer_format', manifest };
  }
  if (manifest.initialized !== true) {
    return { state: 'template', manifest };
  }
  return { state: 'initialized', manifest };
}

/** Atomic write (tmp + rename) — a killed bootstrap never leaves a torn manifest. */
export function writeManifest(workspaceDir: string, manifest: AgentManifest): void {
  const path = manifestPath(workspaceDir);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Machine-local install receipt [CX2-12]
// ---------------------------------------------------------------------------

export interface InstallReceipt {
  receipt_version: 1;
  workspace_dir: string;
  source_id: string;
  agent_name: string;
  created_at: string;
  created_by: string;
  /** True when bootstrap ran `gbrain init` itself (vs adopting a pre-existing
   * brain). Uninstall may only offer --delete-brain when this is true [G2]. */
  brain_created_by_bootstrap: boolean;
  /** Absolute paths bootstrap created OUTSIDE the workspace (hook wiring,
   * corpus dir, …). Uninstall removes exactly these, nothing else. */
  created_paths: string[];
  /** Host registrations bootstrap performed (for marker-keyed removal). */
  registrations: Array<{ host: 'claude-code' | 'codex'; scope: string; detail?: string }>;
}

export function receiptPath(gbrainHomeDir: string): string {
  return join(gbrainHomeDir, 'bootstrap', 'receipt.json');
}

export function readReceipt(gbrainHomeDir: string): InstallReceipt | null {
  const path = receiptPath(gbrainHomeDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as InstallReceipt;
    return parsed.receipt_version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function writeReceipt(gbrainHomeDir: string, receipt: InstallReceipt): void {
  const path = receiptPath(gbrainHomeDir);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}
