---
name: claude-code-reflex
version: 0.1.0
description: What to do when the brain volunteers a page pointer at prompt time (push-based context via the UserPromptSubmit hook).
triggers:
  - "Brain pages mentioned this turn"
mutating: false
writes_pages: false
writes_to: []
tools: [get_page, query, graph, backlinks]
---

# Claude Code Reflex — act on volunteered pointers

A `## Brain pages mentioned this turn` block in your context means the brain
volunteered pages for entities in the user's prompt (confidence-gated,
deduped per session). The pointer is an INDEX ENTRY, not the page.

- Before asserting any non-trivial detail about a pointed-at entity, open the
  page: `get_page` with the slug from the pointer line.
- The one-line synopsis is orientation only — never quote it as if you read
  the page.
- No block this turn does NOT mean the brain knows nothing: pull-side
  retrieval (`query`, `search`) still applies per the retrieval-reflex skill.
- Duplicate suppression is per-session: a page volunteered earlier in this
  session won't re-fire — scroll up before claiming you never saw it.
