#!/bin/bash
# gbrain push-based context hook (claude-code-reflex recipe).
# Reads the UserPromptSubmit payload on stdin, emits the injection envelope
# on stdout. `gbrain volunteer-hook` ALWAYS exits 0 in --harness mode; the
# `|| true` guards only the gbrain-not-on-PATH case (a hook exit code must
# never block a prompt). stderr is deliberately NOT discarded — Claude Code
# ignores it on exit 0 (visible in debug mode) and it is the only
# diagnostic channel when the brain is unreachable.
gbrain volunteer-hook --harness claude-code || true
