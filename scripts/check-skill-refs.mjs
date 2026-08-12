#!/usr/bin/env bun
// check-skill-refs — three integrity gates over the skills/ markdown tree.
//
// 1. DANGLING REFS (fail): every backtick `skills/<x>/...` path, every
//    frontmatter `composes:` slug, and every `(dispatcher for: a, b)` slug in
//    RESOLVER.md must resolve to an existing file/dir. Placeholder templates
//    (`skills/X/`, `skills/<slug>/`) and skills/migrations/** are exempt —
//    migrations are historical record, placeholders are documentation idiom.
// 2. DONOR REMNANTS (fail, allowlist-ratcheted): donor-workspace path prefixes
//    must not appear outside files listed in scripts/skill-refs-allowlist.txt.
//    The allowlist is a ratchet: it may shrink, never silently grow — add a
//    line only with a review-visible commit.
// 3. CLI REFS (warn only): `gbrain <cmd>` tokens inside fenced code blocks are
//    checked against the CLI's --tools-json surface. Warnings never fail the
//    build; they exist so a skill body promising a nonexistent command is
//    visible in CI logs before a user hits it.
//
// Usage: bun scripts/check-skill-refs.mjs [--skills-dir skills/] [--allowlist scripts/skill-refs-allowlist.txt] [--no-cli-refs]

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
function argVal(flag, dflt) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const SKILLS_DIR = argVal('--skills-dir', 'skills');
const ALLOWLIST_PATH = argVal('--allowlist', 'scripts/skill-refs-allowlist.txt');
const RUN_CLI_REFS = !args.includes('--no-cli-refs');

const DONOR_PREFIXES = ['/data/brain', '/data/.openclaw', '/data/gbrain', '/data/tmp'];
const PLACEHOLDER_RE = /skills\/(X|<[^>]+>|\{[^}]+\}|\$\{[^}]+\}|\.\.\.)\/?/;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

if (!existsSync(SKILLS_DIR)) {
  console.error(`check-skill-refs: skills dir not found: ${SKILLS_DIR}`);
  process.exit(2);
}

const allowlist = new Set(
  existsSync(ALLOWLIST_PATH)
    ? readFileSync(ALLOWLIST_PATH, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
    : [],
);

const files = walk(SKILLS_DIR);
const failures = [];
const warnings = [];

for (const file of files) {
  // Path identity is always "skills/<path-under-skills-dir>", independent of cwd
  // canonicalization (macOS /var vs /private/var) or an absolute --skills-dir.
  const underSkills = relative(SKILLS_DIR, file);
  const rel = join('skills', underSkills);
  const inMigrations = underSkills.startsWith('migrations/');
  const text = readFileSync(file, 'utf8');

  // --- 2. donor remnants (skip migrations wholesale) ---
  if (!inMigrations && !allowlist.has(rel)) {
    for (const prefix of DONOR_PREFIXES) {
      if (text.includes(prefix)) {
        const line = text.split('\n').findIndex((l) => l.includes(prefix)) + 1;
        failures.push(`[donor-remnant] ${rel}:${line} — contains "${prefix}" (add to ${ALLOWLIST_PATH} only with review)`);
        break;
      }
    }
  }

  if (inMigrations) continue;

  // --- 1a. backtick skills/ path refs ---
  for (const m of text.matchAll(/`(skills\/[^`\s]+)`/g)) {
    let ref = m[1].replace(/[.,;:]+$/, '');
    if (PLACEHOLDER_RE.test(ref)) continue;
    // strip trailing anchors / line refs like skills/foo/SKILL.md:12
    ref = ref.replace(/:\d+(-\d+)?$/, '').replace(/#.*$/, '');
    if (ref.endsWith('/')) ref = ref.slice(0, -1);
    if (!existsSync(ref)) {
      const line = text.split('\n').findIndex((l) => l.includes(m[1])) + 1;
      failures.push(`[dangling-ref] ${rel}:${line} — \`${m[1]}\` does not exist`);
    }
  }

  // --- 1b. frontmatter composes: slugs ---
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const composesMatch = fm.match(/^composes:\s*(.*)$/m);
    if (composesMatch) {
      const inline = composesMatch[1].trim();
      let slugs = [];
      if (inline && inline !== '|' && !inline.startsWith('#')) {
        slugs = inline.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
      } else {
        // block-list form: lines "  - slug" following the key
        const after = fm.slice(fm.indexOf(composesMatch[0]) + composesMatch[0].length);
        for (const line of after.split('\n')) {
          const lm = line.match(/^\s+-\s+(\S+)/);
          if (lm) slugs.push(lm[1]);
          else if (line.trim() && !line.startsWith(' ')) break;
        }
      }
      for (const slug of slugs) {
        if (!existsSync(join(SKILLS_DIR, slug))) {
          failures.push(`[dangling-composes] ${rel} — composes: "${slug}" is not a skill dir under ${SKILLS_DIR}/`);
        }
      }
    }
  }
}

// --- 1c. RESOLVER.md dispatcher clauses ---
const resolverPath = join(SKILLS_DIR, 'RESOLVER.md');
if (existsSync(resolverPath)) {
  const rtext = readFileSync(resolverPath, 'utf8');
  for (const m of rtext.matchAll(/\(dispatcher for:\s*([^)]+)\)/g)) {
    for (const slug of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const cleaned = slug.replace(/`/g, '');
      if (!/^[a-z0-9-]+$/.test(cleaned)) continue; // prose, not a slug
      if (!existsSync(join(SKILLS_DIR, cleaned))) {
        failures.push(`[dangling-dispatcher] ${SKILLS_DIR}/RESOLVER.md — dispatcher slug "${cleaned}" is not a skill dir`);
      }
    }
  }
}

// --- 3. CLI refs (warn-only) ---
if (RUN_CLI_REFS) {
  let known = null;
  try {
    const raw = execSync('bun src/cli.ts --tools-json 2>/dev/null', { encoding: 'utf8', timeout: 30_000 });
    const parsed = JSON.parse(raw.slice(raw.indexOf('[') >= 0 && raw.indexOf('[') < (raw.indexOf('{') + 1 || Infinity) ? raw.indexOf('[') : raw.indexOf('{')));
    const list = Array.isArray(parsed) ? parsed : parsed.tools || [];
    known = new Set();
    for (const t of list) {
      const n = (t.cliHints && t.cliHints.name) || t.cli_name || t.name;
      if (n) known.add(String(n).replaceAll('_', '-'));
      for (const a of (t.cliHints && t.cliHints.aliases) || []) known.add(String(a));
    }
  } catch {
    warnings.push('[cli-refs] could not load --tools-json; skipping CLI-ref check');
  }
  if (known && known.size > 0) {
    // top-level commands defined directly in src/cli.ts (not ops): derive from source
    try {
      const cliSrc = readFileSync('src/cli.ts', 'utf8');
      for (const m of cliSrc.matchAll(/(?:command === |case )'([a-z][a-z0-9-]*)'/g)) known.add(m[1]);
    } catch {}
    for (const file of files) {
      if (file.includes('/migrations/')) continue;
      const rel = relative('.', file);
      const text = readFileSync(file, 'utf8');
      for (const block of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
        for (const cmd of block[1].matchAll(/(?:^|[|&;(]\s*)gbrain\s+([a-z][a-z0-9-]*)/gm)) {
          if (!known.has(cmd[1])) warnings.push(`[cli-refs] ${rel} — \`gbrain ${cmd[1]}\` not found in CLI surface (warn-only)`);
        }
      }
    }
  }
}

for (const w of warnings) console.error(`WARN ${w}`);
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.error(`check-skill-refs: ${failures.length} failure(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`check-skill-refs: OK (${files.length} files scanned, ${warnings.length} warning(s))`);
