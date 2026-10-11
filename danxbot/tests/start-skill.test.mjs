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
import { bannedHits } from "../../scripts/check-general-audience.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(path.join(here, "../skills/start/SKILL.md"), "utf8");

const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(raw.replace(/\r\n/g, "\n"));
assert.ok(frontmatter, "the skill opens with a YAML frontmatter block");
const meta = loadYaml(frontmatter[1]);
const body = raw.replace(/\r\n/g, "\n").slice(frontmatter[0].length);
/** One line, single-spaced, so no assertion depends on where the prose wraps. */
const flat = (text) => text.replace(/\s+/g, " ");
const text = flat(body);

/** The text of one numbered step heading (`### 4. ...`) up to the next heading. */
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

test("the steps run in order: sign in, allow rule, origin, repo, board, plan", () => {
  const order = [
    text.indexOf("### 1. Sign in"),
    text.indexOf("### 2. Allow the plugin's own calls in auto permission mode"),
    text.indexOf("### 3. Read the repo's origin"),
    text.indexOf("### 4. Register the repo"),
    text.indexOf("### 5. Create the board"),
    text.indexOf("### 6. Start the first plan"),
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

test("step 3 normalizes ssh:// and github.com-<alias> origins and refuses every other host", () => {
  const s = step(3);
  assert.match(s, /ssh:\/\/git@github\.com\/<owner>\/<repo>\.git/);
  assert.match(s, /git@github\.com-<alias>:<owner>\/<repo>\.git/);
  assert.match(s, /rewrite an `ssh:\/\/` or\s+alias origin to `git@github\.com:<owner>\/<repo>\.git`/);
  assert.match(s, /neither `github\.com` nor an SSH config alias for it\s+\(`github\.com-<alias>`/);
  assert.match(s, /connects `github\.com` repos only/);
});

test("step 3 reads the origin URL and refuses, creating nothing, when there is none or it is not GitHub", () => {
  const s = step(3);
  assert.match(s, /git remote get-url origin/);
  assert.match(s, /no `origin` remote|no origin remote/i);
  assert.match(s, /connects `github.com` repos only/);
  assert.match(s, /stop/i);
  assert.match(s, /Nothing has been registered or created in danxbot/);
  assert.equal(s.match(/Nothing has been registered or created in danxbot/g).length, 2, "both refusal branches say what is true");
  assert.doesNotMatch(s, /Nothing has been created\./);
});

test("step 4 matches an already-registered repo by GitHub owner and repo before registering", () => {
  const s = step(4);
  assert.match(s, /GET \/api\/repos/);
  assert.match(s, /github_remote/);
  assert.match(s, /owner\/repo|owner and repo/i);
  assert.match(s, /already registered/i);
});

test("step 4 registers with {name, url}, derives a valid name and offers the suggested name on 409", () => {
  const s = step(4);
  assert.match(s, /POST \/api\/repos/);
  assert.match(s, /\{name, url\}/);
  assert.match(s, /lowercase/i);
  assert.match(s, /409/);
  assert.match(s, /suggested_name/);
  assert.match(s, /<owner>-<repo>/);
});

test("step 4 says a 409 name is unique across every team, not that another team holds it", () => {
  const s = step(4);
  assert.match(s, /unique across every team on danxbot, so it may be a repo of someone else's/);
  assert.doesNotMatch(s, /another team already holds/);
});

test("step 4 repairs a repo name the server would refuse, and falls back to <owner>-<repo>, then to asking", () => {
  const s = step(4);
  assert.match(s, /\^\[a-z0-9\]\[a-z0-9_-\]\{0,63\}\$/);
  assert.match(s, /leading `-` or `_` removed/);
  assert.match(s, /`\.github`/);
  assert.match(s, /still not valid, ask the person for a name/);
});

test("step 5 gives a repo name with fewer than two letters a prefix from the owner, then asks", () => {
  const s = step(5);
  assert.match(s, /letters only/);
  assert.match(s, /fewer than two letters/);
  assert.match(s, /owner's first letters/);
  assert.match(s, /ask the\s+person for a prefix/);
});

test("step 5 reuses a board the repo already has, else creates one with {repo, name, issue_prefix}", () => {
  const s = step(5);
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

test("step 6 starts at the plan list: it never claims the connect answer names the session's plan", () => {
  const s = step(6);
  assert.match(s, /^### 6\. Start the first plan A plan is where .*? 1\. `GET \/api\/plans`/);
  assert.doesNotMatch(s, /already on a plan/i);
  assert.doesNotMatch(flat(body.slice(body.indexOf("### 1."), body.indexOf("### 3."))), /keep that/i);
});

test("step 6 asks what to build first, creates the plan, and hands over to plan-workflow", () => {
  const s = step(6);
  assert.match(s, /what (they|you) want to build first/i);
  assert.match(s, /POST \/api\/plans/);
  assert.match(s, /`danxbot:plan-workflow`/);
  assert.match(s, /GET \/api\/plans/);
});

test("the session names its board on every card call and relearns it from its plan after a restart", () => {
  const s = step(6);
  assert.match(s, /every call that works on a card or a plan's cards names the board, the\s+`board` argument of `danxbot_api` set to the board id from step 5 \(`<repo>:<slug>`\)/);
  assert.match(s, /`POST \/api\/issues` carries it as `board` in its body/);
  assert.match(s, /After a restart or a compaction the session relearns its board from the plan it reconnects to: `GET \/api\/plans\/mine` answers the plan's `boards`, which come from the plan's cards, so that list is empty until the plan has a card\. Until then, running `\/danxbot:start` again finds the board \(step 5\)\./);
});

test("the skill writes no repo file; the only file it may change is the person's own settings, in step 2", () => {
  assert.match(text, /the one file it may change is the person's own `~\/\.claude\/settings\.json`, to add one allow rule, only with their OK \(step 2\)/);
  for (const file of [".mcp.json", ".env", "CLAUDE.md"]) {
    assert.ok(!raw.includes(file), `the skill never mentions ${file}`);
  }
});

// DX-4805: auto permission mode refuses the plugin's own background calls; the start skill adds the allow rule, with the person's OK.
const RULE = "`mcp__plugin_danxbot_danx-dashboard__*`";

test("step 2 comes before the plan hand-over and can be the whole run", () => {
  const s = step(2);
  assert.match(s, /before the plan hand-over \(step 6\), which a session may never return from/);
  assert.match(s, /When `GET \/api\/plans\/mine` already answers a\s+plan for this session, the connect flow is done and the remaining steps would change nothing:\s+stop after this step/);
});

test("step 2 checks permissions.allow, explains why in one sentence and asks before adding the rule", () => {
  const s = step(2);
  assert.match(s, /Read `~\/\.claude\/settings\.json`; a missing file counts as no settings/);
  assert.ok(s.includes(`list already holds ${RULE}`));
  assert.match(s, /refuses the plugin's own background calls, so plan events stop reaching the session/);
  assert.ok(s.includes(`Ask for their OK to add the rule ${RULE}`));
});

test("step 2 leaves a settings file that is not valid JSON, or whose allow is not a list, untouched", () => {
  const s = step(2);
  assert.match(s, /is not valid JSON, or its `permissions\.allow` is present and not a list, leave the file untouched, tell the person, and give the manual instruction/);
  assert.match(s, /Never treat such a file as empty/);
  const invalid = s.slice(s.indexOf("is not valid JSON"), s.indexOf("already allowed"));
  assert.ok(invalid.includes(`manual instruction: add ${RULE} to \`permissions.allow\` in \`~/.claude/settings.json\` yourself`), "the invalid-file paragraph restates the rule");
});

test("step 2 adds only that one entry on a clear yes, keeps every other setting, never without the yes", () => {
  const s = step(2);
  assert.match(s, /Only on a clear yes, add that one entry/);
  assert.match(s, /Keep every other setting exactly as it was, add no other rule/);
  assert.match(s, /create the `permissions\.allow` list only when it is missing/);
  assert.match(s, /Never add it without the yes/);
  assert.match(s, /on a no or no reply, change nothing/);
  assert.ok(s.includes(`manual instruction: add ${RULE} to \`permissions.allow\``));
});

test("step 2 is safe to re-run and says a session restart applies the rule", () => {
  const s = step(2);
  assert.match(s, /already allowed and change nothing/);
  assert.match(s, /a session restart applies it/);
});

test("plan-workflow's Live events bullet names /danxbot:start as the one-step way to add the rule", () => {
  const pw = flat(readFileSync(path.join(here, "../skills/plan-workflow/SKILL.md"), "utf8"));
  assert.match(pw, /Run `\/danxbot:start`: with the person's OK it adds the allow rule `mcp__plugin_danxbot_danx-dashboard__\*` in one step\. Or add that rule to `permissions\.allow` in `~\/\.claude\/settings\.json` yourself/);
});

test("running it again in a connected repo reports what is set up and goes to planning", () => {
  assert.match(text, /idempotent|run again|runs again|re-run/i);
  assert.match(text, /changes nothing/i);
});

// The publish-time scan (scripts/check-general-audience.mjs, DX-4551) applied to this skill on its own.
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
