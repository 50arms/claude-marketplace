---
name: 50arms-ready
description: 'Put this session on its repo''s ready list so 50 Arms can hand it work, the same as the person typing /50arms-ready. Load it yourself whenever the person is planning or working with 50 Arms, and by default when unsure; ask the person when it is truly unclear; stay off only when the work is unrelated to 50 Arms. Pass `off` to leave the list.'
---

# 50arms-ready: join the ready list

A session on the ready list waits for work from its team's 50 Arms board for this folder's
repo, takes the next job, and after each job clears its conversation and rejoins the list by
itself. Loading this skill does the same as the person typing `/50arms-ready`: the plugin signs
the session in if needed and puts it on the list. Nothing else is needed from you.

## When to load it

Decide this yourself, without waiting to be told. Lean towards yes.

- The person is planning, building, reviewing or asking about work that lives in 50 Arms (a
  plan, a card, a board, a gate, the plugin): load the skill.
- You cannot tell: load the skill. When that would surprise the person, ask one short question
  first and do what they answer.
- The work is unrelated to 50 Arms (a chat about something else, a one-off question): stay off
  the list and load nothing.
- The person left the list on purpose (`/50arms-ready off`, or a Stop): stay off.

A session that restarted and is off the list is asked once to make this call; make it then, and
do not mention the prompt to the person unless you need to ask them.

## What to do

1. Load this skill (no arguments) to join. The session is on the list once the line the plugin
   adds says so.
2. Tell the person in one line that the session is on the ready list. Do not explain the loop.
3. Load it with the argument `off` to leave the list when the person asks to.

If the plugin reports it could not join (no git origin, a repo that is not connected, no
team agent free), pass its words on to the person as they are.
