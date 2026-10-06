// DX-4556 - `/danxbot:start` connects the repo a person is standing in: sign in, register
// the repo, create its board, then the first plan. These tests pin the skill's contract with
// the dashboard (the routes, the bodies, the order) and that its text names nothing that
// exists only in the plugin author's own setup (PLAN-34 G-4).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(path.join(here, "../skills/start/SKILL.md"), "utf8");

const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(raw.replace(/\r\n/g, "\n"));
assert.ok(frontmatter, "the skill opens with a YAML frontmatter block");
const meta = loadYaml(frontmatter[1]);
const body = raw.replace(/\r\n/g, "\n").slice(frontmatter[0].length);
/** One line, single-spaced, so no assertion depends on where the prose wraps. */
const flat = (text) => text.replace(/\s+/g, " ");
const text = flat(body);

/** The text of one numbered step heading (`### 3. ...`) up to the next heading. */
function step(n) {
  const re = new RegExp(`^### ${n}\\. .*$`, "m");
  const m = re.exec(body);
  assert.ok(m, `the skill has a step ${n}`);
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^#{2,3} /m);
  return flat(m[0] + " " + (next === -1 ? rest : rest.slice(0, next)));
}

test("the skill is `start` with a description a session can match and a size the listing keeps", () => {
  assert.equal(meta.name, "start");
  assert.equal(typeof meta.description, "string");
  assert.match(meta.description, /\/danxbot:start/);
  assert.match(meta.description, /connect/i);
  assert.ok(meta.description.length + String(meta.when_to_use ?? "").length <= 1536);
});

test("the steps run in order: sign in, origin, repo, board, plan", () => {
  const order = [
    text.indexOf("### 1. Sign in"),
    text.indexOf("### 2. Read the repo's origin"),
    text.indexOf("### 3. Register the repo"),
    text.indexOf("### 4. Create the board"),
    text.indexOf("### 5. Start the first plan"),
  ];
  assert.ok(order.every((i) => i > -1), `every step heading is present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "the headings appear in step order");
});

test("step 1 signs in with plan_connect and no plan, showing the approval link and code", () => {
  const s = step(1);
  assert.match(s, /`plan_connect`/);
  assert.match(s, /no plan/i);
  assert.match(s, /approval_required|approval_pending/);
  assert.match(s, /confirm code/i);
  assert.match(s, /approval URL|approval link/i);
});

test("step 2 normalizes ssh:// and github.com-<alias> origins and refuses every other host", () => {
  const s = step(2);
  assert.match(s, /ssh:\/\/git@github\.com\/<owner>\/<repo>\.git/);
  assert.match(s, /git@github\.com-<alias>:<owner>\/<repo>\.git/);
  assert.match(s, /rewrite an `ssh:\/\/` or\s+alias origin to `git@github\.com:<owner>\/<repo>\.git`/);
  assert.match(s, /neither `github\.com` nor an SSH config alias for it\s+\(`github\.com-<alias>`/);
  assert.match(s, /connects `github\.com` repos only/);
});

test("step 2 reads the origin URL and refuses, creating nothing, when there is none or it is not GitHub", () => {
  const s = step(2);
  assert.match(s, /git remote get-url origin/);
  assert.match(s, /no `origin` remote|no origin remote/i);
  assert.match(s, /connects `github.com` repos only/);
  assert.match(s, /stop/i);
  assert.match(s, /nothing (has been )?(created|registered)/i);
});

test("step 3 matches an already-registered repo by GitHub owner and repo before registering", () => {
  const s = step(3);
  assert.match(s, /GET \/api\/repos/);
  assert.match(s, /github_remote/);
  assert.match(s, /owner\/repo|owner and repo/i);
  assert.match(s, /already registered/i);
});

test("step 3 registers with {name, url}, derives a valid name and offers the suggested name on 409", () => {
  const s = step(3);
  assert.match(s, /POST \/api\/repos/);
  assert.match(s, /\{name, url\}/);
  assert.match(s, /lowercase/i);
  assert.match(s, /409/);
  assert.match(s, /suggested_name/);
  assert.match(s, /<owner>-<repo>/);
});

test("step 3 says a 409 name is unique across every team, not that another team holds it", () => {
  const s = step(3);
  assert.match(s, /unique across every team on danxbot, so it may be a repo of someone else's/);
  assert.doesNotMatch(s, /another team already holds/);
});

test("step 3 repairs a repo name the server would refuse, and falls back to <owner>-<repo>, then to asking", () => {
  const s = step(3);
  assert.match(s, /\^\[a-z0-9\]\[a-z0-9_-\]\{0,63\}\$/);
  assert.match(s, /leading `-` or `_` removed/);
  assert.match(s, /`\.github`/);
  assert.match(s, /still not valid, ask the person for a name/);
});

test("step 4 gives a repo name with fewer than two letters a prefix from the owner, then asks", () => {
  const s = step(4);
  assert.match(s, /letters only/);
  assert.match(s, /fewer than two letters/);
  assert.match(s, /owner's first letters/);
  assert.match(s, /ask the\s+person for a prefix/);
});

test("step 4 reuses a board the repo already has, else creates one with {repo, name, issue_prefix}", () => {
  const s = step(4);
  assert.match(s, /GET \/api\/boards` with `query: \{"repo"/);
  assert.match(s, /already has a board/i);
  assert.match(s, /POST \/api\/boards/);
  assert.match(s, /\{repo, name, issue_prefix\}/);
  assert.match(s, /two to four capital letters/i);
});

test("a refusal naming boards.view or boards.manage goes through ONE request_permission naming both keys", () => {
  const section = flat(body.slice(body.indexOf("## When a call is refused"), body.indexOf("## Steps")));
  assert.match(section, /`403` naming `boards\.view` or `boards\.manage`/);
  assert.match(section, /call `request_permission` once with both `boards\.view` and `boards\.manage`/);
  assert.match(section, /Ask for nothing else/);
  assert.equal((section.match(/request_permission/g) ?? []).length, 1);
});

test("step 5 starts at the plan list: it never claims the connect answer names the session's plan", () => {
  const s = step(5);
  assert.match(s, /^### 5\. Start the first plan A plan is where .*? 1\. `GET \/api\/plans`/);
  assert.doesNotMatch(s, /already on a plan/i);
  assert.doesNotMatch(flat(body.slice(body.indexOf("### 1."), body.indexOf("### 2."))), /keep that/i);
});

test("step 5 asks what to build first, creates the plan, and hands over to plan-workflow", () => {
  const s = step(5);
  assert.match(s, /what (they|you) want to build first/i);
  assert.match(s, /POST \/api\/plans/);
  assert.match(s, /`danxbot:plan-workflow`/);
  assert.match(s, /GET \/api\/plans/);
});

test("the session names its board on every card call and relearns it from its plan after a restart", () => {
  const s = step(5);
  assert.match(s, /every call that works on a card or a plan's cards names the board, the\s+`board` argument of `danxbot_api` set to the board id from step 4 \(`<repo>:<slug>`\)/);
  assert.match(s, /`POST \/api\/issues` carries it as `board` in its body/);
  assert.match(s, /After a restart or a compaction the session relearns its board from the plan it reconnects to: `GET \/api\/plans\/mine` answers the plan's `boards`, which come from the plan's cards, so that list is empty until the plan has a card\. Until then, running `\/danxbot:start` again finds the board \(step 4\)\./);
});

test("the skill writes no file and names no file for a repo to carry the connection", () => {
  assert.match(text, /It writes no file/);
  for (const file of [".mcp.json", "settings.json", ".env", "CLAUDE.md"]) {
    assert.ok(!raw.includes(file), `the skill never mentions ${file}`);
  }
});

test("running it again in a connected repo reports what is set up and goes to planning", () => {
  assert.match(text, /idempotent|run again|runs again|re-run/i);
  assert.match(text, /changes nothing/i);
});

// The scan the dashboard keeps for the text it sends into a session (DX-4550), applied to the
// text the plugin sends into one. Each token names something only the author's setup has.
const BANNED = [
  { name: "a personal GitHub account or marketplace name", pattern: /newms/i },
  { name: "a personal shell alias", pattern: /update-claude-plugins/i },
  { name: "the author's own domain", pattern: /sageus/i },
  { name: "another of the author's products", pattern: /gpt-manager/i },
  { name: "another of the author's organizations", pattern: /flytedesk/i },
  { name: "the author's own UI library", pattern: /@danxbot\/ui/i },
  { name: "a path in the author's repo", pattern: /(?<![\w.-])(?:src|packages)\/[\w.-]/ },
  { name: "an internal card, plan or plan-record id", pattern: /\b(?:DX|PLAN|PLN|SG|R)-\d+/ },
];
const bannedHits = (s) => BANNED.flatMap(({ name, pattern }) => (pattern.test(s) ? [name] : []));

test("the skill's text names nothing specific to the author's own setup", () => {
  assert.deepEqual(bannedHits(raw), []);
});

test("the scan matcher catches each banned token and passes general text", () => {
  assert.equal(bannedHits("marketplace newms-plugins").length, 1);
  assert.equal(bannedHits("then update-claude-plugins").length, 1);
  assert.equal(bannedHits("https://danxbot.sageus.ai").length, 1);
  assert.equal(bannedHits("the gpt-manager app").length, 1);
  assert.equal(bannedHits("Flytedesk org").length, 1);
  assert.equal(bannedHits("use @danxbot/ui").length, 1);
  assert.equal(bannedHits("see `src/issues/x.ts`").length, 1);
  assert.equal(bannedHits("see DX-4556").length, 1);
  assert.equal(bannedHits("SG-1020 first").length, 1);
  assert.deepEqual(bannedHits("GET /api/repos then POST /api/boards for your own repo"), []);
});
