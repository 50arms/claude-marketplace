---
name: fix-agent-behavior
description: 'Load when the operator corrects how you work, before saving the correction anywhere. Diagnose the wrong action, then fix it by briefly refining an existing rule/skill/hook/MCP description, expanding documentation, or escalating — never a memory file or a new skill.'
---

# Diagnose, Then Fix (Never Add a Skill)

Triggered when the operator flags something done wrong. Pause your own other work; leave
running agents alone.

## 1. Explain first (read-only)

- **What:** one line, the wrong action.
- **Why:** one or two lines, the reasoning that produced it.

No code edits, no investigation in the project codebase yet.

## 2. Resolve with the ladder, in order

1. **Missing context** (agent didn't know a needed fact) → expand the documentation
   agents reference. Never a rule or skill change.
2. **No rule exists for this behaviour** → add it briefly to the existing skill, rule,
   hook, MCP server instructions or route spec text that owns the subject. Read every
   related item first so nothing is duplicated.
3. **The rule exists and was still broken** → sharpen it with one concise, generalised
   example, only if the rule is genuinely ambiguous. Never a bullet list of cases. A
   clear rule that was broken anyway is usually a model limit, not a text gap: tell the
   operator so (a higher effort or more capable model follows it more reliably) and
   add nothing.
4. **Text can't fix it** → say so and escalate to the operator with a proposed system
   change (a route reminder, the janitor, or code) instead of more prose.

**Never create a new skill.** A persisting bad behaviour is cheaper than another skill
nobody needed — that habit is what bloated this plugin set before.

## 3. Locate the target and edit it

Fix the surface that actually produced the behaviour — a loaded skill body, an injected
description/frontmatter, a hook, the MCP server instructions, or a route's spec or
reminder text. If the failure came from a description/frontmatter, fix that, not just the
body.

Resolve the plugin source checkout (never `~/.claude/plugins/cache/`, read-only) by
remote, not by guessing a path: check `~/.claude/plugins/known_marketplaces.json` first,
then search sibling repos by `git remote get-url origin`. Use what you find; never clone
a second copy.

- Reaches every project, machine, dispatched context → plugin source.
- This machine only, or the operator's own preference (what needs no ask, what is
  operator-only) → `~/.claude/CLAUDE.md`, never a plugin or a repo.
- One repo only → that repo's `.claude/CLAUDE.md` or `.claude/rules/`.
- Never a memory file (it reaches one project on one machine; no dispatched worker, other
  repo or other machine reads it): a correction already saved as one moves to its home above
  and the memory is deleted.

Apply the edit yourself (`Edit`/`Write`). A plugin edit isn't done until published: bump
the version and push (`scripts/publish.sh` if present) — publishing is standing,
pre-authorized, never needs approval. Published = done: NEVER test, verify, or file AC or
problems about a published plugin reaching or loading in a new session — that is the Claude
Code harness's job, it works, and it is not ours.

## 4. End state

Every run ends in exactly one of two states — say which:
- **Resolved:** name the file and the brief edit (or doc expansion) made and published.
- **Escalated:** name the proposed system change and ask the operator to confirm it.
