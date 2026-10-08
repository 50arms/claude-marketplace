---
name: start
description: 'Connect the repo you are in to danxbot with one command, `/danxbot:start`: sign in, register the repo, create its board, then start the first plan. Run it when someone types /danxbot:start, or asks to set up, connect or get started with danxbot in this repo. Safe to run again.'
---

# Start: connect this repo to danxbot

`/danxbot:start` takes the repo this session is in from nothing to a connected plan. It
asks danxbot, through the plugin's own dashboard connection, to register the repo and
create its board, then hands over to `danxbot:plan-workflow`. It writes no file: the
repo, its board and the plan live in the dashboard.

Run again in a repo that is already set up, it reports what exists, changes nothing and
goes straight to planning (step 5). Each step below says how it recognises that its work
is already done.

Every dashboard call goes through `danxbot_api` (`method`, `path`, `query`, `body`).

## When a call is refused

A session key starts with only the permissions needed to work cards and plans. Registering
a repo and creating or listing boards need two more. A call answered `403` naming
`boards.view` or `boards.manage`: call `request_permission` once with both
`boards.view` and `boards.manage`, with the reason "danxbot start needs to look up this
repo and create its board". The plugin shows the approval link and
confirm code at once and opens nothing: the person clicks the link, so never open the URL yourself (two tabs). Wait until they say they approved it, then repeat
the call that was refused. Ask for nothing else.

## Steps

### 1. Sign in

Call `plan_connect` with no plan. If it answers `approval_required` or `approval_pending`,
show the person the confirm code and the approval URL (the plugin shows the link and code at once and opens nothing: the person clicks the link, so never open the URL yourself),
and call `plan_connect` again once they approve.

### 2. Read the repo's origin

Run `git remote get-url origin` in the repo.

- No output, or an error that there is no such remote: tell the person this folder has no
  `origin` remote, so danxbot cannot tell which repo it is, and that they can add one
  (`git remote add origin <url>`) or run `/danxbot:start` again inside a clone of their
  GitHub repo. Stop. Nothing has been created.
- A URL whose host is neither `github.com` nor an SSH config alias for it
  (`github.com-<alias>`, which people with several GitHub accounts use): tell the person
  danxbot connects `github.com` repos only. Stop. Nothing has been created.

Otherwise take its owner and repo name (`https://github.com/<owner>/<repo>.git`,
`git@github.com:<owner>/<repo>.git`, `git@github.com-<alias>:<owner>/<repo>.git` and
`ssh://git@github.com/<owner>/<repo>.git` all give `<owner>` and `<repo>`, without `.git`).
The URL you register is the `https://` or `git@github.com:` form: rewrite an `ssh://` or
alias origin to `git@github.com:<owner>/<repo>.git`, and keep the others exactly as printed.

### 3. Register the repo

First look for it. `GET /api/repos` with `query: {"fields": {"github_remote": true}}`
lists the team's registered repos. A row whose `github_remote` owner and repo equal the
origin's owner and repo (ignore case) is already registered: use its `name` and skip to
step 4.

Not listed: `POST /api/repos` with `{name, url}`.

- `name`: the repo name in lowercase, every character that is not a letter, a digit, `-`
  or `_` turned into `-`, any leading `-` or `_` removed, cut to 64 characters. It must then
  match `^[a-z0-9][a-z0-9_-]{0,63}$`. When nothing is left (the repo `.github` leaves
  `github`, but a name of only dots leaves nothing), use the owner and repo joined as
  `<owner>-<repo>` the same way; when that is still not valid, ask the person for a name.
- `url`: the URL from step 2.

`201` answers the registered repo; use its `name`. `409` means that name is already taken: a repo's name is unique across every team on
danxbot, so it may be a repo of someone else's. Tell the person, offer the
`suggested_name` in the answer (the owner and repo joined as `<owner>-<repo>`), and register
again under the name they accept or type. A second `409` asks them for another name. A
`400` carries its own message: show it.

### 4. Create the board

A board holds the repo's cards. `GET /api/boards` with `query: {"repo": "<name>"}` lists
the repo's boards. If the repo already has a board, use it (when it has several, ask which)
and skip the create.

None: `POST /api/boards` with `{repo, name, issue_prefix}`.

- `repo`: the registered name from step 3.
- `name`: the repo's name as written on GitHub.
- `issue_prefix`: two to four capital letters that start every card id on this board
  (cards read `ABC-12`), letters only. Take the initials of the repo name's words, or its
  first letters when it is one word. A name with fewer than two letters (`x`, `42`) cannot
  give one: use the owner's first letters, and when that gives fewer than two, ask the
  person for a prefix. Tell the person the prefix and change it if they prefer another.

The answer's `id` is the board id, `<repo>:<slug>`. Tell the person the repo, the board id
and the prefix, flagging each that was already there.

### 5. Start the first plan

A plan is where a goal, its design and its cards live; `danxbot:plan-workflow` is how to
work one.

1. `GET /api/plans`. When the team has open plans, offer to continue one.
2. Otherwise ask what they want to build first, in their own words. Name the plan after
   it and `POST /api/plans` with `{name}`. The answer carries the plan's id.

Then load `danxbot:plan-workflow` and follow its Start steps with that plan: name the
session, connect with `plan_connect`, and orient from the briefing. This session has no
default board: every call that works on a card or a plan's cards names the board, the
`board` argument of `danxbot_api` set to the board id from step 4 (`<repo>:<slug>`), and
`POST /api/issues` carries it as `board` in its body. After a restart or a compaction
the session relearns its board from the plan it reconnects to: `GET /api/plans/mine`
answers the plan's `boards`, which come from the plan's cards, so that list is empty until
the plan has a card. Until then, running `/danxbot:start` again finds the board (step 4).
