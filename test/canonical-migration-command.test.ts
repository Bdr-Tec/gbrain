/**
 * ONE canonical migration command everywhere (D5). Before this, five warning
 * surfaces printed five different commands — including an unsubstituted
 * `<provider:model>` placeholder and a `--dim 1280` that Voyage rejects
 * (valid widths: 256/512/1024/2048).
 *
 *   1. Renderer contract: always `--dim 1024` on the Voyage line; keep-width
 *      OpenAI alternative only when the current width allows it (<= 1536);
 *      rebuild note only when the width actually changes.
 *   2. Source sweep: every `--to voyage:voyage-4` literal in src/ carries
 *      `--dim 1024` on the same line; no `<provider:model>` placeholder
 *      command survives anywhere in src/.
 *   3. Every sunset-warning surface consumes the renderer.
 *
 * The docs/skills sweep (same pairing rule over *.md) lives with the docs
 * wave commit — see the docs assertions appended there.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { renderCanonicalMigrationCommands } from '../src/core/ai/defaults.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.generated.ts')) out.push(p);
  }
  return out;
}

const SRC = join(import.meta.dir, '..', 'src');

describe('canonical migration command (single home: ai/defaults.ts)', () => {
  test('renderer contract', () => {
    const bare = renderCanonicalMigrationCommands();
    expect(bare.recommended).toBe('gbrain migrate embeddings --to voyage:voyage-4 --dim 1024');
    expect(bare.recommendedDryRun).toBe('gbrain migrate embeddings --to voyage:voyage-4 --dim 1024 --dry-run');
    expect(bare.openaiAlternative).toBeNull();
    expect(bare.note).toBeNull();

    const legacy = renderCanonicalMigrationCommands({ colDims: 1280 });
    expect(legacy.recommendedDryRun).toContain('--dim 1024');
    expect(legacy.note).toContain('256/512/1024/2048');
    expect(legacy.openaiAlternative).toBe('gbrain migrate embeddings --to openai:text-embedding-3-small --dim 1280 --dry-run');

    const already = renderCanonicalMigrationCommands({ colDims: 1024 });
    expect(already.note).toBeNull();

    const wide = renderCanonicalMigrationCommands({ colDims: 3072 });
    expect(wide.openaiAlternative).toBeNull(); // 3-small caps at 1536
    expect(wide.note).toContain('3072');
  });

  test('src sweep: every voyage migrate command carries --dim 1024; no placeholder commands', () => {
    const offenders: string[] = [];
    const placeholders: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf-8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (line.includes('--to voyage:voyage-4') && !line.includes('--dim 1024')) {
          // Allow pure prose ABOUT the flag pairing; command strings must pair.
          if (line.includes('migrate embeddings')) offenders.push(`${file}:${i + 1}`);
        }
        // The stage-1 booby-trap shape: an unsubstituted placeholder RECOMMENDED
        // with a concrete width (`--to <provider:model> --dim 1280`). Generic
        // usage/help syntax (`--to <provider:model> [--dim N]`) is legitimate.
        if (/migrate embeddings --to <provider:model>.*--dim \d/.test(line)) {
          placeholders.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
    expect(placeholders).toEqual([]);
  });

  test('every sunset-warning surface consumes the renderer', () => {
    const consumers = [
      'src/core/ai/gateway.ts',
      'src/commands/init.ts',
      'src/core/advisor/collect-setup-smells.ts',
      'src/commands/upgrade.ts',
      'src/core/ze-exposure.ts',
      'src/commands/doctor.ts',
      'src/commands/ze-switch.ts',
    ];
    for (const rel of consumers) {
      const text = readFileSync(join(import.meta.dir, '..', rel), 'utf-8');
      expect(text.includes('renderCanonicalMigrationCommands')).toBe(true);
    }
  });
});
