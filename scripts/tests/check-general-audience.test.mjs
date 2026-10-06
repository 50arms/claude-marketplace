// scripts/check-general-audience.mjs — DX-4551 AC 44348: the publish-time scan that shipped plugin text
// names nothing specific to the author's own setup.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bannedHits, stripJsComments, stripShellComments, userFacingText, scanFiles, scanPlugin } from "../check-general-audience.mjs";
import { listPluginFiles } from "../write-integrity-manifest.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("the matcher catches each banned token and passes general text", () => {
  assert.equal(bannedHits("marketplace newms-plugins").length, 1);
  assert.equal(bannedHits("then update-claude-plugins").length, 1);
  assert.equal(bannedHits("https://danxbot.sageus.ai").length, 1);
  assert.equal(bannedHits("the gpt-manager app").length, 1);
  assert.equal(bannedHits("Flytedesk org").length, 1);
  assert.equal(bannedHits("use @danxbot/ui").length, 1);
  assert.equal(bannedHits("see `src/issues/x.ts`").length, 1);
  assert.equal(bannedHits("see DX-4556").length, 1);
  assert.equal(bannedHits("PLAN-17 Closed beta").length, 1);
  assert.deepEqual(bannedHits("run `claude plugin install danxbot`; card id `<card id>`; PLAN-NNN"), []);
  assert.equal(bannedHits("owner newms87 / NEWMS").length, 1);
  assert.deepEqual(bannedHits("const newMsgs = []; newMsg(x)"), [], "a code identifier is not the author's account name");
});

test("JS comments are stripped, strings, templates and regexes holding // or /* are not, line numbers hold", () => {
  const src = [
    'const a = "DX-1 in a string"; // DX-2 in a comment',
    "/* DX-3",
    "   DX-4 */ const b = `https://x/DX-5 ${a}`;",
    "const re = /DX-6\/\/x/; {/* DX-7 */}",
    "const c = 'don\'t DX-8';",
  ].join("\n");
  const out = stripJsComments(src);
  assert.equal(out.split("\n").length, src.split("\n").length);
  const left = out.match(/DX-\d/g);
  assert.deepEqual(left, ["DX-1", "DX-5", "DX-6", "DX-8"]);
});

test("a stray apostrophe in JSX text does not swallow the rest of the file", () => {
  const out = stripJsComments("<b>don't</b>\nconst s = 'DX-9';\n");
  assert.match(out, /DX-9/);
});

test("shell comments are stripped, a # inside quotes or glued to a word is not", () => {
  const out = stripShellComments(['# DX-1 note', 'echo "DX-2 # not a comment" # DX-3', "echo a#DX-4", "  # DX-5"].join("\n"));
  assert.deepEqual(out.match(/DX-\d/g), ["DX-2", "DX-4"]);
});

test("each file type is read the way a user meets it; plugin.json and binary assets are skipped, any unknown type throws", () => {
  assert.equal(userFacingText("skills/x/SKILL.md", "DX-1 // not a comment"), "DX-1 // not a comment");
  assert.equal(userFacingText("hooks/hooks.json", '{"a":"DX-1"}'), '{"a":"DX-1"}');
  assert.equal(userFacingText("scripts/a.mjs", "x // DX-1").includes("DX-1"), false);
  assert.equal(userFacingText("scripts/a.sh", "x # DX-1").includes("DX-1"), false);
  assert.equal(userFacingText(".claude-plugin/plugin.json", "sageus"), null);
  assert.equal(userFacingText("assets/a.png", "DX-1"), null, "a listed binary asset carries no text");
  for (const unknown of ["skills/x/notes.txt", "skills/x/t.yaml", "references/page.html", "scripts/a.cjs", "LICENSE"]) {
    assert.throws(() => userFacingText(unknown, "newms"), /neither reads nor lists as binary/, `${unknown} must not ship unscanned`);
  }
});

test("scanFiles reports file, line and what for each hit in a scanned surface, and nothing for a comment", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "general-audience-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, "skills"));
  fs.writeFileSync(path.join(dir, "scripts", "a.mjs"), '// DX-1 only a comment\nconsole.log("run update-claude-plugins");\n');
  fs.writeFileSync(path.join(dir, "skills", "S.md"), "fine\nsee PLAN-17\n");
  const hits = scanFiles(dir, ["scripts/a.mjs", "skills/S.md"]);
  assert.deepEqual(hits, [
    { file: "scripts/a.mjs", line: 2, what: "a personal shell alias" },
    { file: "skills/S.md", line: 2, what: "an internal card, plan or plan-record id" },
  ]);
});

test("the shipped danxbot plugin passes, test files that hold the tokens as matcher proof are not shipped, and the start skill is scanned", () => {
  assert.deepEqual(scanPlugin(REPO_ROOT, "danxbot"), []);
  const shipped = listPluginFiles(REPO_ROOT, "danxbot");
  assert.ok(!shipped.includes("tests/start-skill.test.mjs"));
  assert.ok(shipped.includes("skills/start/SKILL.md"));
  assert.ok(shipped.includes("scripts/launch.mjs") && shipped.includes("hooks/hooks.json") && shipped.includes("mantra.md"));
});

test("the scan reads real code: launch.mjs keeps its printed text after stripping, and the text keeps its length", () => {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "danxbot", "scripts", "launch.mjs"), "utf8");
  const text = userFacingText("scripts/launch.mjs", raw);
  assert.match(text, /INTEGRITY FAILURE/);
  assert.match(text, /claude plugin install danxbot/);
  assert.ok(text.length === raw.length);
});
