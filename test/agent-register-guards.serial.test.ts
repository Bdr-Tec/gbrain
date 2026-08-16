/**
 * cathedral-6: the cli.ts PRE-CONNECT guard for `agent register` — a thin
 * client must be refused BEFORE connectEngine (which would otherwise build a
 * scratch PGLite and mint dead credentials into it). Subprocess-level so the
 * guard is exercised where it lives (handleCliOnly, before any engine work):
 * no database exists in the spawned HOME, so reaching the refusal at all
 * proves the guard fires pre-connect.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..');

describe('agent register pre-connect guards (cli.ts)', () => {
  test('thin client is refused with a structured JSON failure before any engine work', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-thin-'));
    const dir = join(home, '.gbrain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      remote_mcp: {
        issuer_url: 'https://brain.example.com',
        mcp_url: 'https://brain.example.com/mcp',
        oauth_client_id: 'gbrain_cl_thin',
      },
    }));
    const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home };
    delete env.GBRAIN_DATABASE_URL;
    delete env.DATABASE_URL;
    const proc = Bun.spawn([
      'bun', '--no-env-file', 'run', 'src/cli.ts',
      'agent', 'register', 'aurora',
      '--harness', 'codex',
      '--url', 'https://brain.example.com/mcp',
      '--json',
    ], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    expect(code).toBe(1);
    // Structured single-document JSON failure on stdout (notes go to stderr).
    let doc: any;
    try {
      doc = JSON.parse(stdout.trim());
    } catch {
      throw new Error(`expected a single JSON doc on stdout, got:\n${stdout}\nstderr: ${stderr}`);
    }
    expect(doc.ok).toBe(false);
    expect(doc.reason).toBe('thin_client');
    expect(doc.message).toContain('HOST brain');
  }, 30_000);
});
