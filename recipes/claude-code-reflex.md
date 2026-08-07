---
id: claude-code-reflex
name: Claude Code Reflex (push-based context hook)
version: 0.1.0
description: Makes Claude Code sessions volunteer brain pages at prompt time — a UserPromptSubmit hook pipes each prompt through `gbrain volunteer-hook`, which injects confidence-gated page pointers as additional context. Pairs with the retrieval-reflex policy skill.
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

# Claude Code Reflex: the brain volunteers pages while you type

The ambient Retrieval Reflex only runs inside plugin hosts with a gbrain
context engine. A plain Claude Code session never volunteers brain context at
prompt time — multi-hour sessions can pass without a single retrieval call.
This recipe closes that gap with a `UserPromptSubmit` hook: every prompt is
piped through `gbrain volunteer-hook`, which extracts salient entities,
resolves them against the brain (through a running `gbrain serve`'s local
socket — no lock contention, no second connection), and injects a compact,
confidence-gated pointer block as additional context.

Cross-turn dedupe is automatic: the hook reads its OWN previous injections
back out of the session transcript (structured `hook_additional_context`
attachments), so a page is pointed at once per session, not once per mention.

The hook **always exits 0** — a brain hiccup is silence on stderr, never a
blocked prompt. On PGLite brains it requires a reachable `gbrain serve`
(your gbrain MCP registration IS one); Postgres brains also have a direct
fallback when no serve is running.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Run these steps on behalf of the user.

1. Copy the hook script + policy skill into the host repo:
   `gbrain integrations install claude-code-reflex --target <host-repo>`
2. Register the hook in the host repo's **`.claude/settings.local.json`**
   (create the file if absent; default to `settings.local.json`, NOT the
   checked-in `settings.json` — a shared registration would impose a
   per-prompt `gbrain` invocation on every collaborator; teams that want it
   shared can move the block to `settings.json` deliberately). MERGE this
   into the existing JSON — never overwrite other hooks:

   ```json
   {
     "hooks": {
       "UserPromptSubmit": [
         {
           "hooks": [
             {
               "type": "command",
               "command": ".claude/hooks/gbrain-volunteer-hook.sh",
               "timeout": 5
             }
           ]
         }
       ]
     }
   }
   ```

3. Tell the user to **restart their Claude Code session** — hooks are
   snapshotted at session start; a mid-session registration is a no-op until
   restart.
4. Verify after the restart: send a prompt naming an entity that has a brain
   page, confirm the pointer block appears, then check
   `gbrain volunteer-context --stats` for a `claude-code` channel row and
   `gbrain doctor` for the `volunteer_channels` adapter line.

Registration is UserPromptSubmit ONLY in v1. The command's parser also
accepts PostToolUse payloads for power users who register it by hand, but
PostToolUse fires dozens of times per turn (one process spawn each) — it
stays unregistered until per-channel stats justify it (see TODOS.md).

Uninstall: remove the hook block from `.claude/settings.local.json` and
delete `.claude/hooks/gbrain-volunteer-hook.sh`.

## What gets installed

- `.claude/hooks/gbrain-volunteer-hook.sh` (0755) — the one-liner hook
  script. It does NOT discard stderr: on exit 0 Claude Code ignores hook
  stderr (it surfaces in debug mode), and those lines are the only
  diagnostics when the brain is unreachable.
- `skills/claude-code-reflex/SKILL.md` — the policy half: what the agent
  should DO when a volunteered pointer block appears.
