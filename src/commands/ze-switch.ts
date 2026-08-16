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

// Retired forward-switch flags — parsed only so the generated
// CLI_FLAG_REGISTRY row keeps accepting them and old scripts reach the
// refusal message naming the migration instead of dying pre-dispatch with an
// unknown-flag error (cli.ts validates against the row BEFORE dispatch; the
// row is generated from these quoted literals, and safety flags like
// '--dry-run' need consumption evidence to survive regeneration).
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

Retired flags — still parsed so old scripts get the refusal above instead of
an unknown-flag error: ${RETIRED_FLAGS.join(' ')}

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

export async function runZeSwitch(args: string[], engine: BrainEngine | null): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const json = args.includes('--json');

  if (args.includes('--undo')) {
    // Read the pre-switch snapshot the old forward path stored. A missing or
    // corrupt snapshot degrades to the plain refusal (there is nothing to
    // redirect to); `redirected` is reserved for snapshot-present.
    let snapshot: ZeSwitchSnapshot | null = null;
    if (engine) {
      const raw = await engine.getConfig(KEY_PREVIOUS_SNAPSHOT);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as ZeSwitchSnapshot;
          if (parsed && parsed.embedding_model && parsed.embedding_dimensions) {
            snapshot = parsed;
          }
        } catch {
          snapshot = null;
        }
      }
    }

    if (snapshot) {
      // Fold the pre-switch reranker into the same run: `--reranker` takes a
      // model id or `off`; omitted means the migration's own default.
      const rerankerArg = snapshot.search_reranker_model
        ? ` --reranker ${snapshot.search_reranker_model}`
        : snapshot.search_reranker_enabled === false
          ? ' --reranker off'
          : '';
      const base = `gbrain migrate embeddings --to ${snapshot.embedding_model} --dim ${snapshot.embedding_dimensions}${rerankerArg}`;
      const undoCommand = `${base} --dry-run`;
      const message =
        `ze-switch no longer undoes in place (the retired action wrote config the runtime does not read).\n` +
        `To return this brain to its pre-switch provider, run:\n` +
        `  ${undoCommand}   # cost preview\n` +
        `  ${base}`;
      if (json) {
        console.log(
          JSON.stringify({ status: 'redirected', reason: 'provider_sunset', undo_command: undoCommand, message }),
        );
      } else {
        console.error(message);
      }
      process.exit(1);
    }

    const env = refusalEnvelope('No prior switch snapshot recorded — nothing to undo.');
    if (json) {
      console.log(JSON.stringify(env));
    } else {
      console.error(env.message);
    }
    process.exit(1);
  }

  // Every other invocation — bare, --dry-run, --resume, --non-interactive,
  // --force, any combination — refuses.
  const env = refusalEnvelope();
  if (json) {
    console.log(JSON.stringify(env));
  } else {
    console.error(env.message);
  }
  process.exit(1);
}
