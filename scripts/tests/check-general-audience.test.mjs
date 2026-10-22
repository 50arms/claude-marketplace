import "../../danxbot/tests/designated-test-container.mjs";
// scripts/check-general-audience.mjs — DX-4551 AC 44348: the publish-time scan that shipped plugin text
// names nothing specific to the author's own setup.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bannedHits, commentHits, foreignSourceFiles, commentOnly, FOREIGN_SOURCE_FILE, stripJsComments, stripShellComments, userFacingText, scanFiles, scanPlugin, listPluginFiles } from "../check-general-audience.mjs";

const tmpDirs = [];
/** A scratch directory removed when the file's tests finish. */
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "general-audience-"));
  tmpDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("the matcher catches each banned token and passes general text", () => {
  assert.equal(bannedHits("marketplace newms-plugins").length, 1);
  assert.equal(bannedHits("then update-claude-plugins").length, 1);
  assert.equal(bannedHits("https://danxbot.sageus.ai").length, 1);
  assert.equal(bannedHits("the gpt-manager app").length, 1);
  assert.equal(bannedHits("Flytedesk org").length, 1);
  assert.equal(bannedHits("use @danxbot/ui").length, 1);
  assert.deepEqual(bannedHits("run `claude plugin install danxbot`; card id `<card id>`; PLAN-NNN"), []);
  assert.equal(bannedHits("owner newms87 / NEWMS").length, 1);
  assert.deepEqual(bannedHits("const newMsgs = []; newMsg(x)"), [], "a code identifier is not the author's account name");
});

const PATH_KIND = "a path in the author's repo";
const ID_KIND = "an internal card, plan or plan-record id";
const NUMBER_KIND = "an internal card comment, note or problem number";

test("each source-path alternative is caught by its own single token", () => {
  for (const dir of ["src", "packages", "mcp-servers", "frontend", "docs/pages"]) {
    assert.deepEqual(bannedHits(`see ${dir}/x`), [PATH_KIND], dir);
    assert.deepEqual(commentHits(`see ${dir}/x`), [PATH_KIND], dir);
  }
  assert.deepEqual(bannedHits("a plain/path and x-src/y and the docs page"), []);
});

test("each internal-id prefix is caught by its own single token", () => {
  for (const prefix of ["DX", "PLAN", "PLN", "SG", "PBLM", "CAV", "R"]) {
    assert.deepEqual(bannedHits(`${prefix}-4556`), [ID_KIND], prefix);
    assert.deepEqual(commentHits(`${prefix}-4556`), [ID_KIND], prefix);
  }
});

test("a card comment, note or problem number is caught per word, and a short number or no number is not", () => {
  for (const word of ["comment", "note", "problem"]) {
    assert.deepEqual(commentHits(`${word} 12391`), [NUMBER_KIND], word);
    assert.deepEqual(commentHits(`${word}s 2543`), [NUMBER_KIND], word + "s");
  }
  assert.deepEqual(commentHits("comment 123, note 456 and problem 789"), [NUMBER_KIND], "three digits is the shortest number caught");
  assert.deepEqual(commentHits("comment 12, note 7 and problem 99"), [], "two digits or fewer is not a card reference");
  assert.deepEqual(commentHits("a comment about the note and problem"), []);
});

test("a source file name is foreign unless the plugin ships it, one extension at a time", () => {
  const shipped = new Set(["band.tsx", "x.ts"]);
  for (const ext of ["ts", "tsx", "mjs", "js"]) {
    assert.deepEqual(foreignSourceFiles(`see other-file.${ext}`, shipped), [`other-file.${ext}`], ext);
  }
  assert.deepEqual(foreignSourceFiles("see band.tsx and x.ts", shipped), []);
  assert.deepEqual(foreignSourceFiles("runs on Node.js, built with Next.js", shipped), [], "capitalised product names are not file names");
  assert.deepEqual(foreignSourceFiles("the user's own index.ts", shipped), ["index.ts"], "a lowercase file name the plugin does not ship fails");
  assert.deepEqual(foreignSourceFiles("see Button.tsx and AgentWorkerStatus.tsx", shipped), ["Button.tsx", "AgentWorkerStatus.tsx"], "a capitalised .tsx name is a source file");
  assert.deepEqual(foreignSourceFiles("see Foo.ts and Bar.mjs", shipped), ["Foo.ts", "Bar.mjs"], "capitalisation exempts only .js");
  assert.deepEqual(foreignSourceFiles("see a note.md and a config.json", shipped), []);
});

test("commentOnly keeps just the comments of code, and nothing for a file type with none", () => {
  const out = commentOnly("a.mjs", 'const f = "x.ts"; // y.ts\n/* z.ts */ const g = 1;');
  assert.match(out, /y\.ts/);
  assert.match(out, /z\.ts/);
  assert.doesNotMatch(out, /x\.ts/);
  assert.match(commentOnly("a.sh", 'echo "x.ts" # y.ts'), /y\.ts/);
  const withEmoji = 'const e = "\u{1F600}"; const z = "x.ts"; // fine\nconst t = "z.ts"; // w.ts';
  const emoji = commentOnly("e.mjs", withEmoji);
  assert.doesNotMatch(emoji, /x\.ts|z\.ts/, "an emoji before a string does not misalign what is blanked");
  assert.match(emoji, /fine/);
  assert.doesNotMatch(emoji, /x\.ts/, "a source name in a string after an emoji is not read as comment");
  assert.match(emoji, /w\.ts/);
  assert.equal(emoji.length, withEmoji.length);
  assert.equal(commentOnly("a.md", "x.ts"), null);
});

test("every comment style is scanned for each comment-applicable kind, and a string is not a comment", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.writeFileSync(path.join(dir, "scripts", "own.mjs"), "// fine\n");
  const cases = [
    ["a.mjs", "// DX-1\n", ID_KIND],
    ["b.mjs", "/* DX-1 */\n", ID_KIND],
    ["c.mjs", "/*\n * see src/x\n */\n", PATH_KIND],
    ["d.sh", "echo hi # DX-1\n", ID_KIND],
    ["e.sh", "# see packages/x\n", PATH_KIND],
    ["f.mjs", "// the comment 12391 says\n", NUMBER_KIND],
    ["g.sh", "# problem 2543\n", NUMBER_KIND],
    ["h.mjs", "// see outside.ts\n", FOREIGN_SOURCE_FILE],
    ["i.sh", "# see outside.js\n", FOREIGN_SOURCE_FILE],
    ["j.mjs", "/* see outside.tsx */\n", FOREIGN_SOURCE_FILE],
    ["l.mjs", "// see own.mjs and Node.js\n", null],
    ["m.mjs", 'const e = "\u{1F600}"; // outside.ts\n', FOREIGN_SOURCE_FILE],
  ];
  for (const [name, body] of cases) fs.writeFileSync(path.join(dir, "scripts", name), body);
  const hits = scanFiles(dir, ["scripts/own.mjs", ...cases.map(([n]) => "scripts/" + n)]);
  for (const [name, , what] of cases) {
    assert.deepEqual(hits.filter((h) => h.file === "scripts/" + name).map((h) => h.what), what === null ? [] : [what], name);
  }
  assert.equal(hits.filter((h) => h.file === "scripts/own.mjs").length, 0);
  fs.writeFileSync(path.join(dir, "scripts", "k.mjs"), 'const s = "outside.ts";\n');
  assert.deepEqual(scanFiles(dir, ["scripts/k.mjs"]), []);
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

test("scanFiles reports file, line and what for each hit in a scanned surface, and a comment only for a card id or source path", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, "skills"));
  fs.writeFileSync(path.join(dir, "scripts", "a.mjs"), '// DX-1 a card id in a comment\n// update-claude-plugins in a comment\n// see src/agent/x.ts\nconsole.log("run update-claude-plugins");\n');
  fs.writeFileSync(path.join(dir, "skills", "S.md"), "fine\nsee PLAN-17\n");
  const hits = scanFiles(dir, ["scripts/a.mjs", "skills/S.md"]);
  assert.deepEqual(hits, [
    { file: "scripts/a.mjs", line: 1, what: "an internal card, plan or plan-record id" },
    { file: "scripts/a.mjs", line: 3, what: "a path in the author's repo" },
    { file: "scripts/a.mjs", line: 3, what: "a source file the plugin does not ship" },
    { file: "scripts/a.mjs", line: 4, what: "a personal shell alias" },
    { file: "skills/S.md", line: 2, what: "an internal card, plan or plan-record id" },
  ]);
});

test("the shipped danxbot plugin passes, test files that hold the tokens as matcher proof are not shipped, and the start skill is scanned", () => {
  assert.deepEqual(scanPlugin(REPO_ROOT, "danxbot"), []);
  const shipped = listPluginFiles(REPO_ROOT, "danxbot");
  assert.ok(!shipped.includes("tests/start-skill.test.mjs"));
  assert.ok(shipped.includes("skills/start/SKILL.md"));
  assert.ok(shipped.includes("hooks/hooks.json") && shipped.includes("hooks/register.tsx") && shipped.includes("mantra.md"));
  assert.ok(shipped.includes("scripts/capture-screenshot.mjs"));
});

test("the scan reads real code: capture-screenshot.mjs keeps its printed text after stripping, drops its comments, and keeps its length", () => {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "danxbot", "scripts", "capture-screenshot.mjs"), "utf8");
  const text = userFacingText("scripts/capture-screenshot.mjs", raw);
  assert.match(text, /console\.log\(`\$\{args\.out\}/);
  assert.match(raw, /\/\/ usage {2}node/);
  assert.doesNotMatch(text, /\/\/ usage {2}node/);
  assert.equal(text.length, raw.length);
});

test("listPluginFiles lists the plugin's tracked and untracked-not-ignored files only, sorted, minus tests, node_modules and deleted files", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "general-audience-list-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const put = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), text);
    };
    put("p/scripts/a.mjs", "a\n");
    put("p/scripts/lib/b.mjs", "b\n");
    put("p/hooks/hooks.json", "{}\n");
    put("p/gone.md", "tracked, then deleted from the working tree\n");
    put("p/tests/a.test.mjs", "test\n");
    put("p/node_modules/x/index.js", "x\n");
    put("p/ignored.log", "ignored\n");
    put(".gitignore", "*.log\n");
    put("other/c.mjs", "c\n");
    execFileSync("git", ["add", "p/scripts/a.mjs", "p/gone.md"], { cwd: repo });
    fs.rmSync(path.join(repo, "p", "gone.md"));
    assert.deepEqual(listPluginFiles(repo, "p"), ["hooks/hooks.json", "scripts/a.mjs", "scripts/lib/b.mjs"]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
