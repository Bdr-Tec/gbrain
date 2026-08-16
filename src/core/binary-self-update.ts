/**
 * Real atomic self-update for the compiled-`binary` install method
 * (v0.42 self-upgrading-gbrain wave, eng-review Finding 2 — "make the atomic
 * swap claim true for the one method we own").
 *
 * `bun` / `bun-link` / `clawhub` delegate their swap to those package managers.
 * The compiled standalone binary is the only method gbrain itself writes, so
 * it's the only place we can (and now do) guarantee atomicity:
 *
 *   resolve published asset → download to a temp sibling of the live binary →
 *   fsync + chmod +x → `--version` smoke test → renameSync over the live path.
 *
 * rename(2) over a running binary is safe on darwin/linux (the running process
 * keeps the old inode; the next exec picks up the new file). Every failure
 * (no asset / fetch / download / integrity / smoke / rename) leaves the OLD
 * binary untouched — there is no half-written-binary brick path. Windows can't
 * rename over a running .exe, and no Windows/`darwin-x64`/`linux-arm64` asset is
 * published, so those degrade to notify-only via `resolvePlatformAsset`
 * returning null.
 *
 * Integrity (D7a, done): before the downloaded binary is ever executed, its
 * SHA-256 is verified against the SLSA build-provenance attestation
 * `attest-build-provenance` publishes for every release
 * (`.github/workflows/release.yml`). The attestation is fetched from the GitHub
 * REST API (`/repos/OWNER/REPO/attestations/sha256:<digest>`) — a DIFFERENT
 * origin than the `objects.githubusercontent.com` CDN that serves the bytes —
 * and we check that (a) an attested subject's digest equals the locally-computed
 * digest and (b) the attestation's builder id is THIS repo's release workflow.
 * The verify is dependency-free (node:crypto + fetch + base64 + JSON only, all
 * Bun built-ins that survive `bun build --compile`; the `sigstore` npm package
 * does NOT bundle under `--compile`, so it is deliberately not used). Honest
 * guarantee: this is GitHub-account trust + origin separation + a signed
 * digest/identity match — it does NOT independently validate the Fulcio cert
 * chain or Rekor inclusion (that needs the trusted-root material sigstore-js
 * loads from disk). An unverified binary is NEVER chmod-exec'd or renamed over
 * the live path; integrity failure is fail-closed.
 *
 * Published asset matrix mirrors `.github/workflows/release.yml`:
 *   darwin-arm64 → gbrain-darwin-arm64
 *   linux-x64    → gbrain-linux-x64
 */

import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * The attestation's builder id must start with this prefix — it binds the
 * provenance to THIS repo's release workflow, so a valid attestation for some
 * OTHER artifact (or a fork's workflow) can't be replayed. The `@<ref>` suffix
 * (e.g. `@refs/heads/master`) is intentionally not pinned: a future
 * tag-triggered release would carry a different ref but the same workflow
 * identity. Mirrors `expectedAssetName`'s coupling to release.yml.
 */
const EXPECTED_BUILDER_ID_PREFIX =
  'https://github.com/garrytan/gbrain/.github/workflows/release.yml@';

/** Base for the GitHub attestation REST endpoint (per-subject-digest lookup). */
const ATTESTATION_API_BASE =
  'https://api.github.com/repos/garrytan/gbrain/attestations/sha256:';

export interface ReleaseAsset {
  name: string;
  url: string;
}

export type BinarySelfUpdateReason =
  | 'unsupported_platform'
  | 'fetch_failed'
  | 'no_asset'
  | 'download_failed'
  | 'integrity_unavailable'
  | 'integrity_failed'
  | 'smoke_failed'
  | 'replace_failed';

/** One attested subject: an artifact name + its SHA-256 (hex, no `sha256:` prefix). */
export interface AttestedSubject {
  name: string;
  sha256: string;
}

/** A parsed build-provenance attestation: the subjects it covers + its builder id. */
export interface ParsedAttestation {
  subjects: AttestedSubject[];
  builderId: string;
}

export interface BinarySelfUpdateResult {
  ok: boolean;
  reason?: BinarySelfUpdateReason;
  error?: string;
  /** Asset name resolved (when applicable). */
  asset?: string;
}

/** The release asset basename gbrain publishes for this platform/arch, or null
 * when no asset is published (degrade to notify-only). */
export function expectedAssetName(platform: NodeJS.Platform, arch: NodeJS.Architecture): string | null {
  if (platform === 'darwin' && arch === 'arm64') return 'gbrain-darwin-arm64';
  if (platform === 'linux' && arch === 'x64') return 'gbrain-linux-x64';
  return null;
}

/** Pick the download URL for this platform/arch from a release's asset list. */
export function resolvePlatformAsset(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | null {
  const name = expectedAssetName(platform, arch);
  if (!name) return null;
  const match = assets.find((a) => a.name === name);
  return match?.url ?? null;
}

export interface BinarySelfUpdateDeps {
  /** Fetch the latest release's tag + asset list. Default hits the GitHub API. */
  fetchRelease?: () => Promise<{ tag: string; assets: ReleaseAsset[] } | null>;
  /** Download `url` to `destPath`. Default streams the HTTP body to disk. */
  download?: (url: string, destPath: string) => Promise<void>;
  /** Smoke-test the staged binary; returns true if `<path> --version` looks like gbrain. */
  smoke?: (stagedPath: string) => boolean;
  /** SHA-256 (hex) of the file at `path`. Default reads the file with node:crypto. */
  computeDigest?: (path: string) => string;
  /**
   * Fetch + parse the build-provenance attestations for `digest` (hex, no
   * prefix). Returns the parsed attestations, or null when none are available
   * (missing / network / rate-limited) — null maps to `integrity_unavailable`,
   * NOT `integrity_failed`. Default hits the GitHub attestation REST API.
   * Injected in tests so the real digest/identity verify logic is exercised
   * against crafted attestation data (the network is the only mocked seam).
   */
  fetchAttestation?: (digest: string) => Promise<ParsedAttestation[] | null>;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}

async function defaultFetchRelease(): Promise<{ tag: string; assets: ReleaseAsset[] } | null> {
  try {
    const res = await fetch('https://api.github.com/repos/garrytan/gbrain/releases/latest', {
      headers: { 'User-Agent': 'gbrain-self-upgrade' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const assets: ReleaseAsset[] = Array.isArray(data.assets)
      ? data.assets.map((a: any) => ({ name: String(a.name ?? ''), url: String(a.browser_download_url ?? '') }))
      : [];
    return { tag: String(data.tag_name ?? ''), assets };
  } catch {
    return null;
  }
}

async function defaultDownload(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'gbrain-self-upgrade' },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('downloaded asset is empty');
  writeFileSync(destPath, buf);
  // fsync so a crash between write and rename can't leave a torn file.
  const fd = openSync(destPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function defaultSmoke(stagedPath: string): boolean {
  try {
    const out = execFileSync(stagedPath, ['--version'], { encoding: 'utf-8', timeout: 10_000 });
    return /gbrain\s/i.test(out);
  } catch {
    return false;
  }
}

export function defaultComputeDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Decode one GitHub attestation `bundle` into `{subjects, builderId}`.
 * The DSSE payload is a base64-encoded in-toto Statement:
 *   { subject: [{name, digest:{sha256}}], predicate:{ runDetails:{ builder:{id} } } }
 * Returns null when the bundle is malformed (missing/undecodable payload).
 */
export function parseAttestationBundle(bundle: any): ParsedAttestation | null {
  try {
    const payloadB64 = bundle?.dsseEnvelope?.payload;
    if (typeof payloadB64 !== 'string' || payloadB64.length === 0) return null;
    const stmt = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    const subjects: AttestedSubject[] = Array.isArray(stmt?.subject)
      ? stmt.subject
          .map((s: any) => ({ name: String(s?.name ?? ''), sha256: String(s?.digest?.sha256 ?? '') }))
          .filter((s: AttestedSubject) => s.sha256.length > 0)
      : [];
    const builderId = String(stmt?.predicate?.runDetails?.builder?.id ?? '');
    if (subjects.length === 0 || builderId.length === 0) return null;
    return { subjects, builderId };
  } catch {
    return null;
  }
}

async function defaultFetchAttestation(digest: string): Promise<ParsedAttestation[] | null> {
  try {
    const res = await fetch(`${ATTESTATION_API_BASE}${digest}`, {
      headers: { 'User-Agent': 'gbrain-self-upgrade', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    });
    // 404 (no attestation), 403 (unauthenticated rate limit, 60/hr), any non-2xx
    // → treat as "unavailable" (caller fails closed), never as "verified".
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const raw = Array.isArray(data?.attestations) ? data.attestations : [];
    const parsed = raw
      .map((a: any) => parseAttestationBundle(a?.bundle))
      .filter((p: ParsedAttestation | null): p is ParsedAttestation => p !== null);
    // Distinguish "endpoint reachable but no usable attestation" (null →
    // unavailable) from "reachable with data" (return the list, possibly empty
    // only if all bundles were malformed, which we also treat as unavailable).
    return parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Verify the staged binary against its build-provenance attestation. Returns a
 * reason on failure (fail-closed), or null on success.
 *   - digest can't be computed        → integrity_unavailable
 *   - no attestation available        → integrity_unavailable
 *   - attestation exists but does not
 *     cover this (name, digest) under
 *     our release-workflow builder id  → integrity_failed
 */
export async function verifyIntegrity(
  stagedPath: string,
  assetName: string,
  computeDigest: (path: string) => string,
  fetchAttestation: (digest: string) => Promise<ParsedAttestation[] | null>,
): Promise<BinarySelfUpdateReason | null> {
  let digest: string;
  try {
    digest = computeDigest(stagedPath);
  } catch {
    return 'integrity_unavailable';
  }
  if (!/^[0-9a-f]{64}$/.test(digest)) return 'integrity_unavailable';

  const attestations = await fetchAttestation(digest);
  if (!attestations || attestations.length === 0) return 'integrity_unavailable';

  // A match requires: an attestation from OUR release workflow that names this
  // asset with exactly this digest. Digest-match alone is insufficient — the
  // builder id binds the provenance to a trusted producer.
  const verified = attestations.some(
    (att) =>
      att.builderId.startsWith(EXPECTED_BUILDER_ID_PREFIX) &&
      att.subjects.some((s) => s.name === assetName && s.sha256 === digest),
  );
  return verified ? null : 'integrity_failed';
}

let _tmpCounter = 0;

/**
 * Perform a real atomic self-update of the binary at `targetPath` (defaults to
 * the running binary, `process.execPath`). Returns a tagged result; never
 * throws. On any failure the original binary is left untouched.
 */
export async function runBinarySelfUpdate(
  targetPath: string = process.execPath,
  deps: BinarySelfUpdateDeps = {},
): Promise<BinarySelfUpdateResult> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const fetchRelease = deps.fetchRelease ?? defaultFetchRelease;
  const download = deps.download ?? defaultDownload;
  const smoke = deps.smoke ?? defaultSmoke;
  const computeDigest = deps.computeDigest ?? defaultComputeDigest;
  const fetchAttestation = deps.fetchAttestation ?? defaultFetchAttestation;

  const assetName = expectedAssetName(platform, arch);
  if (!assetName) {
    return { ok: false, reason: 'unsupported_platform' };
  }

  const release = await fetchRelease();
  if (!release) {
    return { ok: false, reason: 'fetch_failed', asset: assetName };
  }

  const url = resolvePlatformAsset(release.assets, platform, arch);
  if (!url) {
    return { ok: false, reason: 'no_asset', asset: assetName };
  }

  // Stage in a temp sibling so the rename is same-filesystem (atomic).
  const staged = join(dirname(targetPath), `.${assetName}.tmp.${process.pid}.${_tmpCounter++}`);
  try {
    await download(url, staged);
  } catch (e) {
    safeUnlink(staged);
    return { ok: false, reason: 'download_failed', error: errMsg(e), asset: assetName };
  }

  // Integrity BEFORE chmod/exec: never make an unverified binary executable and
  // never run its `--version` smoke test. Fail-closed on unavailable or mismatch.
  const integrityFailure = await verifyIntegrity(staged, assetName, computeDigest, fetchAttestation);
  if (integrityFailure) {
    safeUnlink(staged);
    return { ok: false, reason: integrityFailure, asset: assetName };
  }

  try {
    chmodSync(staged, 0o755);
  } catch (e) {
    safeUnlink(staged);
    return { ok: false, reason: 'download_failed', error: errMsg(e), asset: assetName };
  }

  if (!smoke(staged)) {
    safeUnlink(staged);
    return { ok: false, reason: 'smoke_failed', asset: assetName };
  }

  try {
    renameSync(staged, targetPath); // atomic on same fs; old binary intact if this throws
  } catch (e) {
    safeUnlink(staged);
    return { ok: false, reason: 'replace_failed', error: errMsg(e), asset: assetName };
  }

  return { ok: true, asset: assetName };
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
