/**
 * CLI→MCP gap-closure wave [OV6] — per-subcommand thin-client routing for the
 * commands whose reads/writes gained MCP ops: takes (list/search/scorecard/
 * calibration + the write verbs), search (modes/stats/tune, read-only forms),
 * jobs stats, cache stats, and quarantine list. The salience/anomalies/
 * graph-query precedent, engine-free: each routable subcommand maps onto its
 * op over callRemoteTool; everything else returns false so the caller falls
 * through to refuseThinClient's pinpoint hint.
 *
 * Config-MUTATING forms stay host-side by design: `search modes --reset` and
 * `search tune --apply` (CDX-21), `cache clear|prune`, `quarantine scan|clear`,
 * `takes extract|revisit`.
 */

import type { GBrainConfig } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

async function call(cfg: GBrainConfig, tool: string, args: Record<string, unknown>): Promise<unknown> {
  return unpackToolResult(await callRemoteTool(cfg, tool, args));
}

function printJson(result: unknown): void {
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Route a thin-client invocation to its MCP op. Returns true when handled
 * (output printed); false when the subcommand is host-bound and the caller
 * should refuse with the hint. Remote op errors propagate (the mcp-client
 * error surface already names the op + reason).
 */
export async function routeThinClientCommand(
  cfg: GBrainConfig,
  command: string,
  args: string[],
): Promise<boolean> {
  const sub = args[0];
  const rest = args.slice(1);

  if (command === 'takes') {
    switch (sub) {
      case 'list': {
        const slug = rest[0] && !rest[0].startsWith('-') ? rest[0] : undefined;
        printJson(await call(cfg, 'takes_list', {
          ...(slug ? { page_slug: slug } : {}),
          ...(flagValue(rest, '--who') ? { holder: flagValue(rest, '--who') } : {}),
          ...(flagValue(rest, '--kind') ? { kind: flagValue(rest, '--kind') } : {}),
        }));
        return true;
      }
      case 'search': {
        if (!rest[0]) return false;
        printJson(await call(cfg, 'takes_search', { query: rest[0], ...(num(flagValue(rest, '--limit')) !== undefined ? { limit: num(flagValue(rest, '--limit')) } : {}) }));
        return true;
      }
      case 'scorecard': {
        const holder = rest[0] && !rest[0].startsWith('--') ? rest[0] : flagValue(rest, '--holder');
        printJson(await call(cfg, 'takes_scorecard', { ...(holder ? { holder } : {}) }));
        return true;
      }
      case 'calibration': {
        printJson(await call(cfg, 'takes_calibration', { ...(flagValue(rest, '--holder') ? { holder: flagValue(rest, '--holder') } : {}) }));
        return true;
      }
      case 'add': {
        const slug = rest[0];
        if (!slug) return false;
        const res = await call(cfg, 'takes_add', {
          slug,
          claim: flagValue(rest, '--claim'),
          kind: flagValue(rest, '--kind'),
          holder: flagValue(rest, '--who'),
          ...(num(flagValue(rest, '--weight')) !== undefined ? { weight: num(flagValue(rest, '--weight')) } : {}),
          ...(flagValue(rest, '--source') ? { source: flagValue(rest, '--source') } : {}),
          ...(flagValue(rest, '--since') ? { since: flagValue(rest, '--since') } : {}),
        }) as { row_num: number };
        console.log(`Added take #${res.row_num} to ${slug}. (routed to the brain host)`);
        return true;
      }
      case 'update': {
        const slug = rest[0];
        const row = num(flagValue(rest, '--row'));
        if (!slug || row === undefined) return false;
        await call(cfg, 'takes_update', {
          slug, row_num: row,
          ...(num(flagValue(rest, '--weight')) !== undefined ? { weight: num(flagValue(rest, '--weight')) } : {}),
          ...(flagValue(rest, '--source') ? { source: flagValue(rest, '--source') } : {}),
          ...(flagValue(rest, '--since') ? { since: flagValue(rest, '--since') } : {}),
        });
        console.log(`Updated take #${row} on ${slug}. (routed to the brain host)`);
        return true;
      }
      case 'resolve': {
        const slug = rest[0];
        const row = num(flagValue(rest, '--row'));
        const quality = flagValue(rest, '--quality');
        if (!slug || row === undefined || !quality) return false;
        const res = await call(cfg, 'takes_resolve', {
          slug, row_num: row, quality,
          ...(flagValue(rest, '--evidence') ? { evidence: flagValue(rest, '--evidence') } : {}),
          ...(num(flagValue(rest, '--value')) !== undefined ? { value: num(flagValue(rest, '--value')) } : {}),
          ...(flagValue(rest, '--unit') ? { unit: flagValue(rest, '--unit') } : {}),
        }) as { resolved_by: string };
        console.log(`Resolved take #${row} on ${slug}: quality=${quality} (as ${res.resolved_by}).`);
        return true;
      }
      case 'supersede': {
        const slug = rest[0];
        const row = num(flagValue(rest, '--row'));
        if (!slug || row === undefined) return false;
        const res = await call(cfg, 'takes_supersede', {
          slug, row_num: row, claim: flagValue(rest, '--claim'),
          ...(flagValue(rest, '--kind') ? { kind: flagValue(rest, '--kind') } : {}),
          ...(flagValue(rest, '--who') ? { holder: flagValue(rest, '--who') } : {}),
          ...(num(flagValue(rest, '--weight')) !== undefined ? { weight: num(flagValue(rest, '--weight')) } : {}),
        }) as { old_row: number; new_row: number };
        console.log(`Superseded #${res.old_row} → new #${res.new_row} on ${slug}. (routed to the brain host)`);
        return true;
      }
      default:
        return false; // extract / revisit / unknown — host-bound, refuse with hint
    }
  }

  if (command === 'search') {
    if (sub === 'modes' && !rest.includes('--reset') && !rest.includes('--source')) {
      printJson(await call(cfg, 'search_modes', {}));
      return true;
    }
    if (sub === 'stats') {
      printJson(await call(cfg, 'search_stats', { ...(num(flagValue(rest, '--days')) !== undefined ? { days: num(flagValue(rest, '--days')) } : {}) }));
      return true;
    }
    if (sub === 'tune' && !rest.includes('--apply')) {
      printJson(await call(cfg, 'search_tune', {}));
      return true;
    }
    return false; // modes --reset / tune --apply / diagnose — host-side config or live probe
  }

  if (command === 'jobs' && sub === 'stats') {
    printJson(await call(cfg, 'get_job_stats', { ...(flagValue(rest, '--queue') ? { queue: flagValue(rest, '--queue') } : {}) }));
    return true;
  }

  if (command === 'cache' && sub === 'stats') {
    printJson(await call(cfg, 'cache_stats', {}));
    return true;
  }

  if (command === 'quarantine' && sub === 'list') {
    printJson(await call(cfg, 'quarantine_list', { ...(rest.includes('--include-flagged') ? { include_flagged: true } : {}) }));
    return true;
  }

  return false;
}
