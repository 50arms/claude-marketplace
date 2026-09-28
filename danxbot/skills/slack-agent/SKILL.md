---
name: slack-agent
description: 'Slack-worker dispatch contract: danxbot_slack_reply required for questions, forbidden for tasks; danxbot_complete always; emoji reaction + card-view update for tasks.'
audience: worker
---

# Slack Agent Dispatch — Replying to Slack Threads

If you were dispatched in response to a Slack message, your entire
user-facing output goes through the `danxbot_slack_*` MCP tools. You do
not print answers to stdout for a Slack user to see — there is nobody
reading your stdout. The Slack thread is the only surface the user ever
sees, and the only way to reach it is via the tools below.

Slack reply budget is **≤12 lines**. Lead with the answer, not the
investigation narrative.

**Slack does NOT render GFM/markdown tables.** A `| col | col |` pipe
table posts as literal unreadable pipes — never emit one. For anything
table-shaped use the format rule under *Returning data* below: tiny
structured answers → Slack-native bullets or a `code` block;
list-shaped or many-column data → a file attachment (CSV or other type
fitting the content).

## Editing code in this dispatch → read issue-refs first

If this dispatch touches code, the issue-ref comment convention applies exactly as for any agent — load `danxbot:issue-workflow` (Mechanics → "Issue-ref comments") for the grep pattern and comment format before editing.

## Required tool calls

Split by dispatch type:

### Questions — User wants information back

1. **`danxbot_slack_reply`** — REQUIRED. Call after you have finished
   investigating and have a final answer. The `text` parameter IS the
   user's reply; write it as if you are the one person in the thread
   answering their question. Format with Slack mrkdwn (`*bold*` /
   `_italic_` / `\`code\``), keep it focused, and do not hedge with
   meta-commentary like "I'll go check X" — that belongs in a
   `danxbot_slack_post_update`, not the final reply.

2. **`danxbot_complete`** — REQUIRED. Call immediately after
   `danxbot_slack_reply`, with `status: "complete"` and a short
   `summary` (one sentence, for the dispatches dashboard — NOT for the
   Slack user). Never exit without calling this.

### Tasks — Act on a card / do something (do not reply)

1. **`danxbot_slack_reply`** — FORBIDDEN for successful tasks. The 🧠→✅
   reaction (stamped by the listener when `danxbot_complete` exits with
   `status: "complete"`) and the in-place card-view re-render are the
   confirmation. The user sees the card update, not a prose reply.

2. **`danxbot_complete`** — REQUIRED. Always call with `status:
   "complete"` after the task finishes successfully. Never exit without
   calling this.

3. **Failed task** — the ONE task exception that posts a reply. If the
   task fails, post exactly ONE short prose line explaining the failure
   via `danxbot_slack_reply`, then call `danxbot_complete` with `status:
   "failed"` and the failure reason. Coordinate with the listener's own
   failure line (which fires when the dispatch exits non-completed) so
   the two do not duplicate.

## Created or identified a card for this thread → LINK it (MANDATORY)

If this dispatch **creates** an issue card (via
`mcp__danx-dashboard__issue_create`) OR identifies the ONE existing card
this thread is about, you MUST bind the thread to that card:

> `mcp__danxbot__link_thread_to_issue({ issue_id: "<card id>" })`

**Call order is fixed:** `danxbot_slack_reply` (your "Created SO-1 …"
confirmation — this first reply becomes the card-view *message #1*) →
**`link_thread_to_issue`** → `danxbot_complete`. The link slots BETWEEN
reply and complete; it is part of the terminal sequence, not optional
cleanup.

**Why it is mandatory.** The link is what registers the Slack **mirror**:
once bound, every future update to the card (status moves, new comments,
edits) re-renders this thread's card-view message — the card *syncs back
to Slack*. Skip the call and the card still exists and still mirrors to
Trello (that side is automatic, server-side), but the Slack thread is
orphaned: the user sees your one reply and nothing ever again. Creating
a card from a thread without linking it is an incomplete dispatch.

**Rules:**
- **One thread ↔ one card, immutable 1:1.** Link the single primary card
  the thread is about. Thread + channel are implicit from the dispatch —
  you pass ONLY `issue_id`, never a thread/channel.
- A **409** means the thread (or that card) is already linked — that is
  fine, treat it as already-done and proceed to `danxbot_complete`. Never
  try to re-link.
- Created several cards in one thread (e.g. an epic + phases)? Link the
  **one** the thread is primarily tracking (usually the parent/epic, or
  the single card the user asked for).

## Intermediate updates — use sparingly (default: zero for tasks)

**`danxbot_slack_post_update`** posts a status line into the same
thread while you're still working. Use it ONLY for updates the user
cares about:

- "Reading the campaign schema now" — yes (questions)
- "Found the failing test — it's a stale fixture" — yes (questions)
- "Running Read on src/foo.ts" — NO, the user doesn't care
- Any progress-bar-style spam — NO

**For questions:** a good dispatch has zero to two intermediate updates.

**For tasks:** zero intermediate updates is the norm. Post nothing while
working — the action is the answer. Do not post updates for every file
edit or step. If you catch yourself posting, stop — noise erodes trust
and the user will mute the bot.

The canonical pattern is: post one update when you've identified the
investigation plan (questions only), finish the work silently, post the
final `danxbot_slack_reply` (questions only), and `danxbot_complete`.

## Thread scope is automatic

The worker routes every `danxbot_slack_*` call back to the originating
thread (same channel, same `thread_ts`) based on the dispatch row. You
do not pick a thread. You do not pick a channel. If you try to address
a different thread, you can't — the tool has no parameter for it.

## Data questions — query prod read-only by DEFAULT

For a data/lookup question ("what is / how many / show me"), fetch the
rows yourself before you reply. **Which database** you query is decided
by one rule:

| DB | When | Mode |
|---|---|---|
| `prod_db_*` MCP tools | Production data questions — **the default** | read-only |
| local dev DB (repo-native Bash) | You need to **mutate** data to answer — a sandbox experiment, when production data is NOT needed | read-write |

**Production is the default.** Almost every Slack data question ("what
is the status of order X", "how many active suppliers") is answered
against **production** data, read-only, via the `prod_db_*` MCP tools:

- `prod_db_list_tables` — list the tables.
- `prod_db_describe_table` — inspect a table's columns.
- `prod_db_query` — run ONE read-only `SELECT` (SELECT-only,
  single-statement, against a GRANT-SELECT-only replica).

These tools return rows **directly in the tool response** — there is no
file redirect for MCP output — so keep every result set narrow **at the
query**: ask for exactly the rows/columns you need (`LIMIT`, `COUNT(*)`,
specific columns), never a wide `SELECT *` that burns your context.

**`prod_db_*` tools absent → local-only repo.** If your tool list has no
`prod_db_*` tools, this repo has no production DB wired in — local is all
you have, so use the local path below.

**DB unreachable → respond, don't fix.** If the database you need is not
reachable (`prod_db_*` errors out, or the local container is down), reply
**promptly** via `danxbot_slack_reply` that the DB is currently
unavailable, and stop. You do **NOT** diagnose, restart containers, or
repair the system — that is not your job inside a Slack conversation.
DB-up is the assumed normal; a momentary outage is the operator's
concern, not yours to chase down.

### Local dev DB — the mutate-sandbox case (rare)

Reach for the local dev DB ONLY when answering the question requires
**mutating** data — a sandbox experiment where you set up local state,
run code/commands, observe the effect, and production data is not
needed (plus the tool-presence fallback above: a local-only repo with no
`prod_db_*` tools). Your cwd is the connected repo's **full checkout**,
with its own containers and DB, so you query it the way a developer on
that repo would, via Bash.

> **CRITICAL — token conservation (HARD RULE): query/command output ALWAYS goes to a `/tmp/` file, NEVER inline into the tool response.** Every DB query — and any command that could emit more than a few lines — MUST redirect output to a file you name: `… > /tmp/q.json 2>&1`, or the client's own sink (`mysql -e "…" > /tmp/out.tsv`, `psql -o /tmp/r.txt`, `\o /tmp/r.txt`, `COPY … TO '/tmp/x.csv'`). Then read that file ONLY if you actually need a value, and read the **narrowest slice** (`grep`/`head`/a specific key) — never the whole dump. Letting raw rows land in the Bash tool result silently burns thousands of tokens of your context for zero benefit; it is the single most expensive mistake in a dispatch. There is **no "just a quick SELECT" exception** — pipe it to a file. If you only need a count or one field, ask the query for exactly that (`COUNT(*)`, one column) instead of selecting rows you will discard. Same discipline for reading files you wrote: slice, don't slurp.

There is no danxbot DB wrapper tool for this path — three general shapes
(the **exact** compose file, service/container names, and DB engine are
repo-specific — the connected repo's `tools.md`, loaded into your
context, names them; use those, not the placeholders below):

- `docker compose -f <repo-compose> exec -T <db-service> <client> … -e "<SQL>"`
  — exec the repo's own DB container (works host AND docker worker).
- `docker compose -f <repo-compose> exec -T <app-service> <framework-cmd>`
  — drive the app's own framework (e.g. Laravel `php artisan tinker`).
- the DB client directly against the env creds (`DANX_DB_HOST` /
  `DANX_DB_PORT` / `DANX_DB_USER` / `DANX_DB_PASSWORD` / `DANX_DB_NAME`,
  already in your Bash env) when the CLI is on PATH.

Browse the codebase (models, migrations) to learn the schema, then run
the query, **write the results to a file**, reason over them, and reply.
**Always defer to the connected repo's `tools.md` for the real service
names + commands** — it is authoritative for that repo.

**Returning data — NEVER dump raw rows or a GFM pipe-table inline.**
Slack renders neither; both post as unreadable literal text. This is
the single format rule — pick by size and content:

- **Tiny structured answer** (≤ 10 rows AND few columns) → Slack-native
  **bullets** or a fenced **`code` block** in `danxbot_slack_reply({text})`.
  Never a `| … |` pipe table.
- **> 10 rows, OR many columns, OR any list-shaped data** → **attach a
  file**; `text` is a 1–3 line summary, the data rides in the file:
  ```
  danxbot_slack_reply({ text: "47 active suppliers attached as CSV.", files: ["/tmp/suppliers.csv"] })
  ```
  CSV is the default attachment for tabular data; use a different type
  when it fits the content better (e.g. `.json` for nested shapes,
  `.md`/`.txt` for prose, `.sql` for a schema dump).
- **Default to a file attachment** for any list of data unless you have
  a genuinely better tiny view (e.g. a 3-row rollup). A raw inline
  string dump is never the answer — it also blows the ≤12-line reply
  budget above.

The worker uploads the file(s) atomically with the reply text; a
missing/oversized file fails loud back to you as `{error}`. For a prose
answer with no list, just use `danxbot_slack_reply({text})`.

**Build the CSV with a real serializer — never hand-join with commas.**
`awk '{print $1","$2}'` / `sed` / `tr '\t' ','` produce BROKEN CSV: real
values contain commas/quotes (`"Adams, Jaskolski and Howell"`) and a
naive join shifts every column. The DB client's output is tab-separated,
so pipe it through a tool that quotes per RFC 4180 — Python's `csv`
module is always available:

```
… mysql -e "SELECT …" | python3 -c 'import sys,csv; w=csv.writer(sys.stdout); [w.writerow(r.split("\t")) for r in sys.stdin.read().split("\n") if r]' > /tmp/out.csv
```

(or the app framework's CSV writer, e.g. PHP `fputcsv`, which reads
native values — prefer it for fields that may hold tabs/newlines). The
connected repo's `tools.md` has the exact recipe for that repo.

## This is the ONLY path to the user

No direct `chat.postMessage`, no Bash-to-curl escape hatch, no "reply in
stdout and danxbot will forward it" — the `danxbot_slack_*` MCP tools
are the only surface the Slack user ever sees. (Querying the DB is via
the `prod_db_*` tools or, for the local sandbox, plain Bash — those
parts work outside the Slack tools.)
