#!/bin/bash
# gbrain push-based context hook (codex-reflex recipe, EXPERIMENTAL).
# Same contract as the claude-code variant: envelope on stdout, ALWAYS exit 0
# (`|| true` guards only gbrain-not-on-PATH), stderr kept as the diagnostic
# channel. Payload keys are parsed defensively — worst case is silence.
gbrain volunteer-hook --harness codex || true
