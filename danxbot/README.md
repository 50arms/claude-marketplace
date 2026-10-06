# danxbot, the 50 Arms Claude Code plugin

Skills, worker agents, hooks and a plan band for working with a danxbot dashboard from Claude Code.

## Install

```
claude plugin marketplace add 50arms/claude-marketplace
claude plugin install danxbot@50arms
```

Then, in the repo you want to connect, run `/danxbot:start` inside Claude Code.

## Repair a damaged install

Hooks check every shipped file against `integrity-manifest.json` before they run. If one reports a corrupt install:

```
claude plugin uninstall danxbot@50arms --keep-data
claude plugin install danxbot@50arms
```

then restart the session.
