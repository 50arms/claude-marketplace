# danxbot, the 50 Arms Claude Code plugin

Skills, worker agents, hooks and a plan band for working with a danxbot dashboard from Claude Code.

## Install

```
claude plugin marketplace add 50arms/claude-marketplace
claude plugin install danxbot@50arms
```

Then, in the repo you want to connect, run `/danxbot:start` inside Claude Code.

## Repair a damaged install

Hooks check every shipped file against `integrity-manifest.json` before they run, and restore a damaged file from the marketplace copy when that copy is intact. If one reports a corrupt install it could not restore:

```
claude plugin uninstall danxbot@50arms --keep-data
claude plugin install danxbot@50arms
```

then restart the session. A reinstall forgets a custom dashboard address; add `--config dashboard_url=<address>` to the install if you had set one.
