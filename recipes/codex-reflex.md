---
id: codex-reflex
name: Codex Reflex (push-based context hook) — EXPERIMENTAL
version: 0.1.0
description: Makes Codex CLI sessions volunteer brain pages at prompt time — a UserPromptSubmit hook in ~/.codex/hooks.json pipes each prompt through `gbrain volunteer-hook --harness codex`. Experimental — config shape verified against codex-cli 0.136.0; the injection round-trip has not yet been observed end-to-end.
category: reflex
install_kind: copy-into-host-repo
requires: []
secrets: []
health_checks:
  - type: command
    argv: [gbrain, doctor, --json]
    label: Per-channel volunteer visibility (see volunteer_channels)
setup_time: 3 min
cost_estimate: "$0 — zero-LLM deterministic push; one gbrain process per prompt"
---

# Codex Reflex (EXPERIMENTAL): push-based context for Codex CLI

Same mechanism as `claude-code-reflex`, targeting the Codex CLI:
`~/.codex/hooks.json` uses the identical hook configuration shape, and the
codex-cli binary (verified against 0.136.0) embeds the same
`UserPromptSubmit` event name and `hookSpecificOutput.additionalContext`
wire schema. Input payload keys are parsed defensively; worst case is
silence, never breakage.

**Why experimental:** only the config-file shape and embedded schema strings
have been verified — a full prompt → hook → injected-context round-trip has
not been observed on codex-cli yet. The ground-truth verification is the
per-channel feedback loop: after installing, `gbrain volunteer-context
--stats` grows a `codex` channel row when the hook actually fires, and
`gbrain doctor`'s `volunteer_channels` check lists the adapter. If the
channel stays quiet while you prompt about entities with brain pages, the
payload shape likely drifted — file an issue with `codex --version`.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Run these steps on behalf of the user.

1. Copy the hook script + policy skill into the host repo:
   `gbrain integrations install codex-reflex --target <host-repo>`
2. Register the hook in the USER-LEVEL `~/.codex/hooks.json` (Codex hook
   config is user-level, not per-repo). MERGE into the existing JSON — never
   overwrite other hooks (e.g. an existing SessionStart entry):

   ```json
   {
     "hooks": {
       "UserPromptSubmit": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "<host-repo>/.claude/hooks/gbrain-volunteer-hook-codex.sh"
             }
           ]
         }
       ]
     }
   }
   ```

   Substitute `<host-repo>` with the ABSOLUTE path — `~/.codex/hooks.json`
   is user-level, so relative paths do not resolve against the repo.
3. Note: Codex prompts for hook trust on first run — the user must accept.
4. Restart the Codex session (hooks are read at session start), then verify:
   prompt about an entity with a brain page and check
   `gbrain volunteer-context --stats` for a `codex` channel row.

Uninstall: remove the block from `~/.codex/hooks.json` and delete the script.

## What gets installed

- `.claude/hooks/gbrain-volunteer-hook-codex.sh` (0755) — the hook script
  (`--harness codex`; stderr kept for diagnostics). Lives next to the
  claude-code variant so one host repo can carry both.
- `skills/codex-reflex/SKILL.md` — the pointer-block policy skill.
