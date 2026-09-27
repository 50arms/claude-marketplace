---
name: sub-agent-delegation
description: Dispatching work to sub-agents — brief clarity, termination contract, background-task cleanup.
---

# Sub-Agent Delegation

## The dispatch brief

A sub-agent's prompt must stand alone: include file paths, code context, the exact change and why, completely. Never rely on prior-session reasoning, card context, or "the agent will read my code" — the agent has zero memory of this conversation.

The prompt must state what the agent will produce (code, report, analysis, script).

## Termination contract

**A sub-agent must stop every background task it started before reporting done.** A task left running keeps itself and the agent registered as busy, silencing idle signals until a timeout expires.

- Every `run_in_background: true` call must be awaited and stopped before the report, or named in the report as "still running at <reason>".
- Every spawned process, container, or service must be torn down on exit, or explicitly noted.
- No task may be left for a future session or the operator to clean up.
