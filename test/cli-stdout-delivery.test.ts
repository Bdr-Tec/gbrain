/**
 * writeStdoutFinal delivery contract (#3423) + installStdoutPipeDelivery
 * interposer (#4383).
 *
 * process.stdout.write queues pipe writes in a native writer that only pushes
 * to the fd while the process stays alive; flushThenExit's aliveness grace is
 * fixed, so a payload larger than the 64KiB kernel pipe buffer piped to a
 * reader that drains slower than the grace lost its tail with exit 0. The
 * production shape: an agent's verify-read of a large page came back cut at
 * exactly 65,536 bytes, the tail (where the fresh edit lives) missing, and the
 * agent concluded the save never landed. writeStdoutFinal awaits Bun.write on
 * Bun.stdout, which resolves only after the fd accepted every byte, so the
 * subsequent exit cannot drop anything regardless of reader pace.
 *
 * #4383 extends the same delivery guarantee to CLI_ONLY handlers that emit
 * payloads through bare process.stdout.write (advisor --json, eval outcomes,
 * agent results, ...) AND through console.log (orphans --json, ...): the
 * interposer serializes both through one fd-1 write chain, and flushThenExit
 * drains the chain's tail before its fence + grace. Verified on this branch:
 * WITHOUT the interposer, the process.stdout.write shape below truncates at
 * exactly 65,536 bytes with exit 0 against a reader slower than the fence
 * guard + grace — and once anything initializes the process.stdout wrapper
 * (any isTTY read; the real CLI does this long before payloads print), fd 1
 * goes O_NONBLOCK and the console.log shape truncates the same way.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HELPER = join(import.meta.dir, '..', 'src', 'core', 'cli-force-exit.ts');
const PAYLOAD_BYTES = 200_001; // > 3x the 64KiB kernel pipe buffer

/**
 * Run `script` with its stdout piped into a genuinely slow reader — a kernel
 * pipe nobody reads for `sleepSeconds`. Bun.spawn's own stdout:'pipe' eagerly
 * drains into the parent, so it can never model a slow reader by itself; the
 * inner `sleep N; cat` block is what leaves the pipe undrained past the
 * 64KiB kernel buffer and past flushThenExit's guard + grace windows.
 */
async function runViaSlowReader(
  script: string,
  sleepSeconds: number,
): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn({
    cmd: ['sh', '-c', `"${process.execPath}" "${script}" | { sleep ${sleepSeconds}; cat; }`],
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { out, code };
}

describe('writeStdoutFinal (#3423)', () => {
  test('a 200KB payload survives a slow pipe reader and an immediate process.exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-stdout-delivery-'));
    const script = join(dir, 'emit.ts');
    writeFileSync(
      script,
      `import { writeStdoutFinal } from ${JSON.stringify(HELPER)};\n` +
        `await writeStdoutFinal('x'.repeat(${PAYLOAD_BYTES}));\n` +
        `process.exit(0);\n`,
    );
    try {
      const proc = Bun.spawn({ cmd: [process.execPath, script], stdout: 'pipe', stderr: 'inherit' });
      // Slow reader: leave the pipe undrained past the kernel buffer AND the
      // exit grace. Queued-write behavior truncated here at exactly 65,536
      // bytes with exit 0; awaited delivery blocks the child until we drain.
      await new Promise((r) => setTimeout(r, 700));
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      expect(out.length).toBe(PAYLOAD_BYTES);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test('a reader that closes early does not crash the writer (EPIPE swallowed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-stdout-epipe-'));
    const script = join(dir, 'emit.ts');
    writeFileSync(
      script,
      `import { writeStdoutFinal } from ${JSON.stringify(HELPER)};\n` +
        `await writeStdoutFinal('x'.repeat(${PAYLOAD_BYTES}));\n` +
        `process.exit(0);\n`,
    );
    try {
      const proc = Bun.spawn({ cmd: [process.execPath, script], stdout: 'pipe', stderr: 'inherit' });
      // Close our end after the first chunk arrives — the child must still
      // exit 0 (the operation succeeded; delivery to a gone reader is moot).
      const reader = proc.stdout.getReader();
      await reader.read();
      await reader.cancel();
      const code = await proc.exited;
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('installStdoutPipeDelivery (#4383)', () => {
  test('interposed: a 200KB process.stdout.write payload (CLI_ONLY shape) survives a reader slower than fence guard + grace', async () => {
    // The reproducible truncation class on this branch: CLI_ONLY handlers
    // (advisor --json, eval-brainbench, eval-compare, agent results) emit via
    // bare process.stdout.write; against a reader that drains slower than
    // flushThenExit's 2s fence guard + 250ms grace, the queued native writer
    // lost everything past 65,536 bytes with exit 0. Interposed, the write
    // serializes through the awaited Bun.write chain and cannot truncate.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-stdout-interpose-'));
    const script = join(dir, 'emit.ts');
    writeFileSync(
      script,
      `import { installStdoutPipeDelivery, flushThenExit } from ${JSON.stringify(HELPER)};\n` +
        `installStdoutPipeDelivery();\n` +
        `process.stdout.write('x'.repeat(${PAYLOAD_BYTES - 1}) + '\\n');\n` +
        `flushThenExit(0);\n`,
    );
    try {
      // 2.6s > FLUSH_GUARD_MS (2s) + FLUSH_GRACE_PIPE_MS (250ms): outlasts
      // every aliveness window the pre-fix exit seam offered.
      const { out, code } = await runViaSlowReader(script, 2.6);
      expect(out.length).toBe(PAYLOAD_BYTES);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test('interposed: a CLI_ONLY-shaped console.log --json payload survives a slow reader', async () => {
    // The area's named shape (`orphans --json` console.logs its whole result).
    // Bun's console.log does NOT route through process.stdout.write — and once
    // the process.stdout wrapper is initialized (which installing the
    // interposer, or ANY isTTY read in the real CLI, does), fd 1 goes
    // O_NONBLOCK and console.log's own writer EAGAINs the payload into a
    // queue that exit discards: this exact test truncated mid-string before
    // the interposer learned to reroute console.log through the chain.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-stdout-consolelog-'));
    const script = join(dir, 'emit.ts');
    writeFileSync(
      script,
      `import { installStdoutPipeDelivery, flushThenExit } from ${JSON.stringify(HELPER)};\n` +
        `installStdoutPipeDelivery();\n` +
        `const result = { total_orphans: 1, orphans: [{ slug: 'notes/example', reason: 'x'.repeat(${PAYLOAD_BYTES}) }] };\n` +
        `console.log(JSON.stringify(result, null, 2));\n` +
        `flushThenExit(0);\n`,
    );
    try {
      const { out, code } = await runViaSlowReader(script, 2.6);
      const parsed = JSON.parse(out);
      expect(parsed.orphans[0].reason.length).toBe(PAYLOAD_BYTES);
      expect(out.endsWith('}\n')).toBe(true);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test('interposed: a reader that closes early does not hang or crash (EPIPE swallowed)', async () => {
    // `gbrain <cmd> --json | head -c 1000`: head closes the pipe after 1000
    // bytes. The interposed blocking write gets EPIPE mid-payload; it must be
    // swallowed (partial delivery to a gone reader is not an op failure) and
    // the chain's tail must still settle so flushThenExit reaches its fence —
    // exit 0, promptly, no hang. PIPESTATUS[0] surfaces the child's own code.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-stdout-interpose-epipe-'));
    const script = join(dir, 'emit.ts');
    writeFileSync(
      script,
      `import { installStdoutPipeDelivery, flushThenExit } from ${JSON.stringify(HELPER)};\n` +
        `installStdoutPipeDelivery();\n` +
        `process.stdout.write('x'.repeat(4_000_000));\n` +
        `flushThenExit(0);\n`,
    );
    try {
      const t0 = Date.now();
      const proc = Bun.spawn({
        cmd: [
          'bash',
          '-c',
          `"${process.execPath}" "${script}" | head -c 1000 > /dev/null; echo "\${PIPESTATUS[0]}"`,
        ],
        stdout: 'pipe',
        stderr: 'inherit',
      });
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      expect(out.trim()).toBe('0'); // the CLI child exited 0 despite EPIPE
      expect(code).toBe(0);
      expect(Date.now() - t0).toBeLessThan(10_000); // no hang on a gone reader
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test('interposed: ordering preserved across chained writes and the writeStdoutFinal tail join', async () => {
    // Three 90KB blocks — two via interposed process.stdout.write, the third
    // via writeStdoutFinal (which joins the SAME tail) — must arrive in call
    // order, byte-exact, through a slow reader. A second, unserialized writer
    // would interleave or reorder the blocks.
    const BLOCK = 90_000;
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-stdout-interpose-order-'));
    const script = join(dir, 'emit.ts');
    writeFileSync(
      script,
      `import { installStdoutPipeDelivery, writeStdoutFinal, flushThenExit } from ${JSON.stringify(HELPER)};\n` +
        `installStdoutPipeDelivery();\n` +
        `process.stdout.write('A'.repeat(${BLOCK}));\n` +
        `process.stdout.write('B'.repeat(${BLOCK}));\n` +
        `await writeStdoutFinal('C'.repeat(${BLOCK}) + '\\n');\n` +
        `flushThenExit(0);\n`,
    );
    try {
      const { out, code } = await runViaSlowReader(script, 1);
      expect(out).toBe('A'.repeat(BLOCK) + 'B'.repeat(BLOCK) + 'C'.repeat(BLOCK) + '\n');
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test('interposed: multi-console.log help text survives an immediate raw process.exit (sync fast path)', async () => {
    // The regression the chain must NOT introduce: hundreds of help/usage
    // sites `console.log(...)` several lines and then call process.exit(1)
    // synchronously — no microtask ever runs, so a chain that defers delivery
    // would strand every line after the first. The chain's fast path delivers
    // synchronously inside each call while the chain is idle and the pipe has
    // room, so all lines must arrive even though the exit seam never runs.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-stdout-interpose-usage-'));
    const script = join(dir, 'emit.ts');
    writeFileSync(
      script,
      `import { installStdoutPipeDelivery } from ${JSON.stringify(HELPER)};\n` +
        `installStdoutPipeDelivery();\n` +
        `console.log('Usage: gbrain frob [options]');\n` +
        `console.log('');\n` +
        `console.log('  --json   emit JSON');\n` +
        `console.log('  --help   this text');\n` +
        `process.exit(7);\n`,
    );
    try {
      const proc = Bun.spawn({ cmd: [process.execPath, script], stdout: 'pipe', stderr: 'inherit' });
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      expect(out).toBe('Usage: gbrain frob [options]\n\n  --json   emit JSON\n  --help   this text\n');
      expect(code).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
