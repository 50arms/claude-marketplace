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
repo and create its board". Show the person its confirm code and approval URL, open the
URL in your browser when you have one, wait until they say they approved it, then repeat
the call that was refused. Ask for nothing else.

## Steps

### 1. Sign in

Call `plan_connect` with no plan. If it answers `approval_required` or `approval_pending`,
show the person the confirm code and the approval URL (open it in your browser when you
have one), and call `plan_connect` again once they approve. Signed in, the answer says
which plan, if any, this session is already on; keep that for step 5.

### 2. Read the repo's origin

Run `git remote get-url origin` in the repo.

- No output, or an error that there is no such remote: tell the person this folder has no
  `origin` remote, so danxbot cannot tell which repo it is, and that they can add one
  (`git remote add origin <url>`) or run `/danxbot:start` again inside a clone of their
  GitHub repo. Stop. Nothing has been created.
- A URL that is not GitHub (its host is neither `github.com` nor an SSH alias that starts
  `github.com-`): tell the person danxbot connects GitHub repos only. Stop. Nothing has
  been created.

Otherwise keep the URL exactly as printed, and its owner and repo name
(`https://github.com/<owner>/<repo>.git` and `git@github.com:<owner>/<repo>.git` both
give `<owner>` and `<repo>`, without `.git`).

### 3. Register the repo

First look for it. `GET /api/repos` with `query: {"fields": {"github_remote": true}}`
lists the team's registered repos. A row whose `github_remote` owner and repo equal the
origin's owner and repo (ignore case) is already registered: use its `name` and skip to
step 4.

Not listed: `POST /api/repos` with `{name, url}`.

- `name`: the repo name in lowercase, every character that is not a letter, a digit, `-`
  or `_` turned into `-`, starting with a letter or digit, at most 64 characters.
- `url`: the origin URL from step 2.

`201` answers the registered repo; use its `name`. `409` means another team already holds
that name (a repo's name is unique across danxbot): tell the person, offer the
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
  (cards read `ABC-12`). Take the initials of the repo name's words, or its first letters
  when it is one word. Tell the person the prefix and change it if they prefer another.

The answer's `id` is the board id, `<repo>:<slug>`. Tell the person the repo, the board id
and the prefix, flagging each that was already there.

### 5. Start the first plan

A plan is where a goal, its design and its cards live; `danxbot:plan-workflow` is how to
work one.

1. Step 1 said the session is already on a plan: tell the person which, and continue it
   with `danxbot:plan-workflow`. Nothing more to create.
2. Otherwise `GET /api/plans`. When the team has open plans, offer to continue one.
3. Otherwise ask what they want to build first, in their own words. Name the plan after
   it and `POST /api/plans` with `{name}`. The answer carries the plan's id.

Then load `danxbot:plan-workflow` and follow its Start steps with that plan: name the
session, connect with `plan_connect`, and orient from the briefing. This session has no
default board: every call that works on a card or a plan's cards names the board, the
`board` argument of `danxbot_api` set to the board id from step 4 (`<repo>:<slug>`), and
`POST /api/issues` carries it as `board` in its body.
