# Claude Plugins Overview

Source-of-truth for the `newms-plugins` Claude Code plugin marketplace
(`github:newms87/claude-plugins`). Consumers install via the marketplace and
auto-update to whatever VERSION each plugin advertises.

## Layout

```
<plugin>/                       # one dir per plugin (currently just danxbot)
  .claude-plugin/plugin.json    # name + VERSION (the auto-update trigger)
  skills/<skill>/SKILL.md       # skill bodies
  rules/*.md                    # always-on rule files
  agents/*.md                   # subagent definitions
.claude-plugin/marketplace.json # declares every plugin dir (source of truth)
scripts/publish.sh              # bump version + commit + push
```

## How distribution works (the load-bearing fact)

The marketplace loader compares each plugin's `version` field in
`.claude-plugin/plugin.json` — NOT commit shas. A push that does not bump
the version ships **nothing**: every consumer keeps its cached version. So
every meaningful edit MUST bump the edited plugin's version. The full
edit→bump→ship flow is in `workflow.md`.

## Runtime

This repo is a **host-mode** danxbot connected repo. The worker runs on the
operator host (`make launch-worker-host BOARD=claude-plugins-main`) so it
inherits the operator's `git@github-newms87` SSH key — the credential that
pushes to `origin/main`. There is no Docker worker for this repo (a
container would lack the SSH key).
