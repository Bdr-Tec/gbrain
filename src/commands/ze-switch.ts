/**
 * `gbrain ze-switch` — RETIRED refusal/redirect shim.
 *
 * ZeroEntropy's hosted API shuts down on ZEROENTROPY_SUNSET_DATE. Every
 * invocation refuses or redirects; nothing here mutates the brain:
 *
 *   gbrain ze-switch --help           Truthful usage (exit 0, engine-free)
 *   gbrain ze-switch --undo [--json]  Print the exact migration command that
 *                                     returns this brain to its pre-switch
 *                                     provider (from the stored snapshot).
 *                                     Guidance only — exit 1, nothing changes.
 *   anything else                     Refusal naming the canonical migration.
 *
 * Why the legacy actions are gone: the forward switch/resume have been
 * sunset-refused since v0.46.3, and the undo ACTION wrote DB-plane config
 * (engine.setConfig) that the post-v0.37 file-plane-canonical embed pipeline
 * never reads — it could rebuild the schema (dropping every vector) while the
 * runtime kept resolving the old model. Printing the verified, resumable
 * `gbrain migrate embeddings` command is strictly safer than acting.
 *
 * The whole command is deleted in the v0.47 September removal release.
 */

import type { BrainEngine } from '../core/engine.ts';
import {
  ZEROENTROPY_SUNSET_DATE,
  renderCanonicalMigrationCommands,
} from '../core/ai/defaults.ts';

/** Config row written by the pre-v0.46.3 forward switch (the literal matches
 *  KEY_PREVIOUS_SNAPSHOT in retrieval-upgrade-planner.ts; kept local so the
 *  shim does not drag the retired planner module into its import graph). */
const KEY_PREVIOUS_SNAPSHOT = 'ze_switch_previous_snapshot';

interface ZeSwitchSnapshot {
  embedding_model: string;
  embedding_dimensions: number;
  search_reranker_enabled?: boolean;
  search_reranker_model?: string | null;
}

// Retired forward-switch flags — kept as quoted literals ONLY so the
// generated CLI_FLAG_REGISTRY row keeps accepting them and old scripts reach
// the refusal message naming the migration instead of dying pre-dispatch
// with an unknown-flag error (cli.ts validates against the row BEFORE
// dispatch; the row is generated from these literals, and safety flags like
// '--dry-run' need quoted consumption evidence to survive regeneration).
// The shim never consults them — every non-help/undo invocation refuses.
const RETIRED_FLAGS = [
  '--dry-run',
  '--resume',
  '--force',
  '--non-interactive',
  '--yes',
  '--ignore-missing-key',
  '--ignore-env-override',
  '--confirm-reembed',
];

function printHelp() {
  const cmds = renderCanonicalMigrationCommands();
  process.stdout.write(`Usage: gbrain ze-switch [--undo] [--json]

RETIRED — ZeroEntropy shuts down its hosted API on ${ZEROENTROPY_SUNSET_DATE}.
Switching a brain ONTO ZeroEntropy is refused (exit 1, reason
provider_sunset), and the legacy dry-run/resume/undo ACTIONS no longer run.
Every invocation refuses or redirects; nothing changes your brain.

Flags:
  --undo     Print the exact migration command that returns this brain to its
             pre-switch provider (read from the stored switch snapshot). No
             changes are made; run the printed command yourself. Exit 1.
  --json     Machine-readable envelope on stdout.
  --help     This help. Exit 0.

To LEAVE ZeroEntropy (the maintained path):
  ${cmds.recommendedDryRun}   # cost preview
  ${cmds.recommended}
  Playbook: skills/migrations/v0.46.3.0.md

Retired flags — still accepted so old scripts get the refusal above instead
of an unknown-flag error: ${RETIRED_FLAGS.join(' ')}

This command is deleted in the September (v0.47) removal release.
`);
}

function refusalEnvelope(extraMessage?: string): {
  status: 'refused';
  reason: 'provider_sunset';
  migrate: string;
  message: string;
} {
  const cmds = renderCanonicalMigrationCommands();
  const message =
    (extraMessage ? `${extraMessage}\n` : '') +
    `ze-switch is retired: ZeroEntropy shuts down its hosted API on ${ZEROENTROPY_SUNSET_DATE}.\n` +
    `To LEAVE ZeroEntropy: ${cmds.recommendedDryRun}\n` +
    `Playbook: skills/migrations/v0.46.3.0.md\n` +
    `To see the command that returns this brain to its pre-switch provider: gbrain ze-switch --undo`;
  return { status: 'refused', reason: 'provider_sunset', migrate: cmds.recommendedDryRun, message };
}

/** cli.ts SELF_HELP_WITHOUT_ENGINE adapter: that record's handlers take
 *  (engine, args); runZeSwitch takes (args, engine). Help never touches the
 *  engine, so null is safe here. */
export function runZeSwitchSelfHelp(_engine: never, args: string[]): Promise<void> {
  return runZeSwitch(args, null);
}

/** Emit the envelope (stdout JSON or stderr message) and exit 1. */
function emitAndExit(payload: { message: string } & Record<string, unknown>, json: boolean): never {
  if (json) {
    console.log(JSON.stringify(payload));
  } else {
    console.error(payload.message);
  }
  process.exit(1);
}

/** Model ids and reranker ids are `provider:model` tokens — nothing else. The
 *  snapshot row is data-plane content (writable via config set / direct DB /
 *  a mounted brain), and its fields land verbatim in a command the user or a
 *  downstream agent is told to RUN — so validate before interpolating, and
 *  degrade to the plain refusal on anything suspicious. */
const MODEL_ID_RE = /^[A-Za-z0-9._:-]+$/;

function parseSnapshot(raw: string): ZeSwitchSnapshot | null {
  try {
    const p = JSON.parse(raw) as ZeSwitchSnapshot;
    if (
      p &&
      typeof p.embedding_model === 'string' &&
      MODEL_ID_RE.test(p.embedding_model) &&
      Number.isInteger(p.embedding_dimensions) &&
      p.embedding_dimensions > 0 &&
      (p.search_reranker_model == null ||
        (typeof p.search_reranker_model === 'string' && MODEL_ID_RE.test(p.search_reranker_model)))
    ) {
      return p;
    }
  } catch {
    /* corrupt JSON degrades to the refusal below */
  }
  return null;
}

export async function runZeSwitch(args: string[], engine: BrainEngine | null): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const json = args.includes('--json');

  if (args.includes('--undo')) {
    // Read the pre-switch snapshot the old forward path stored. A missing,
    // corrupt, invalid-shape, or unreadable snapshot degrades to the plain
    // refusal (there is nothing to redirect to); `redirected` is reserved
    // for a validated snapshot.
    let snapshot: ZeSwitchSnapshot | null = null;
    if (engine) {
      try {
        const raw = await engine.getConfig(KEY_PREVIOUS_SNAPSHOT);
        if (raw) snapshot = parseSnapshot(raw);
      } catch {
        snapshot = null;
      }
    }

    if (snapshot) {
      // Fold the pre-switch reranker into the same run: `--reranker` takes a
      // model id or `off`; omitted means the migration's own default.
      // enabled===false WINS over a lingering model id — the pre-switch brain
      // had reranking off, and `migrate embeddings --reranker <model>` would
      // re-enable it (the retired undo restored `enabled` independently).
      const rerankerArg =
        snapshot.search_reranker_enabled === false
          ? ' --reranker off'
          : snapshot.search_reranker_model
            ? ` --reranker ${snapshot.search_reranker_model}`
            : '';
      const base = `gbrain migrate embeddings --to ${snapshot.embedding_model} --dim ${snapshot.embedding_dimensions}${rerankerArg}`;
      const undoCommand = `${base} --dry-run`;
      const message =
        `ze-switch no longer undoes in place (the retired action wrote config the runtime does not read).\n` +
        `To return this brain to its pre-switch provider, run:\n` +
        `  ${undoCommand}   # cost preview\n` +
        `  ${base}`;
      emitAndExit({ status: 'redirected', reason: 'provider_sunset', undo_command: undoCommand, message }, json);
    }

    emitAndExit(refusalEnvelope('No prior switch snapshot recorded — nothing to undo.'), json);
  }

  // Every other invocation — bare, --dry-run, --resume, --non-interactive,
  // --force, any combination — refuses.
  emitAndExit(refusalEnvelope(), json);
}
