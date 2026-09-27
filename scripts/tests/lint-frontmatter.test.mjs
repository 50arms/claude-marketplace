// scripts/lint-frontmatter.js — frontmatter validity lint for SKILL.md /
// agent .md files. DX-2986. Run with `npm test` (node --test).
//
// Fixtures are built into a fresh os.tmpdir() directory per test, never
// committed to the repo — a "deliberately broken" .md file living in the
// repo tree would itself need to dodge this lint (and every other repo
// convention) forever, for no benefit over generating it at test time.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { lintRepo } = require("../lint-frontmatter.js");

function makeFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lint-frontmatter-test-"));
}

function writeSkill(root, name, frontmatterBody) {
  const dir = path.join(root, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\n${frontmatterBody}\n---\n\n# ${name}\n`,
  );
}

function writeAgent(root, name, frontmatterBody) {
  const dir = path.join(root, "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\n${frontmatterBody}\n---\n\n# ${name}\n`,
  );
}

describe("lintRepo — valid fixture", () => {
  test("a well-formed SKILL.md and agent .md both pass", () => {
    const root = makeFixtureDir();
    writeSkill(root, "good-skill", "name: good-skill\ndescription: A perfectly normal description.");
    writeAgent(root, "good-agent", "name: good-agent\ndescription: A perfectly normal agent description.");

    const { files, errors } = lintRepo(root);

    assert.equal(files.length, 2);
    assert.deepEqual(errors, []);
  });
});

describe("lintRepo — unescaped single quote inside a single-quoted scalar", () => {
  test("fails and names the file", () => {
    const root = makeFixtureDir();
    writeSkill(root, "bad-quote", "name: bad-quote\ndescription: 'this has an unescaped 'quote' inside it'");

    const { errors } = lintRepo(root);

    assert.equal(errors.length, 1);
    assert.match(errors[0], /^skills\/bad-quote\/SKILL\.md:/);
    assert.match(errors[0], /not valid YAML/);
  });
});

describe("lintRepo — missing description key", () => {
  test("fails and names the file", () => {
    const root = makeFixtureDir();
    writeAgent(root, "no-desc", "name: no-desc");

    const { errors } = lintRepo(root);

    assert.equal(errors.length, 1);
    assert.match(errors[0], /^agents\/no-desc\.md:/);
    assert.match(errors[0], /missing required "description" key/);
  });
});

describe("lintRepo — no frontmatter block at all", () => {
  test("fails and names the file", () => {
    const root = makeFixtureDir();
    const dir = path.join(root, "skills", "no-frontmatter");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "# no-frontmatter\n\nJust a body, no --- block.\n");

    const { errors } = lintRepo(root);

    assert.equal(errors.length, 1);
    assert.match(errors[0], /^skills\/no-frontmatter\/SKILL\.md:/);
    assert.match(errors[0], /no frontmatter block found/);
  });
});

describe("lintRepo — missing name key", () => {
  test("fails and names the file", () => {
    const root = makeFixtureDir();
    writeSkill(root, "no-name", "description: has a description but no name");

    const { errors } = lintRepo(root);

    assert.equal(errors.length, 1);
    assert.match(errors[0], /^skills\/no-name\/SKILL\.md:/);
    assert.match(errors[0], /missing required "name" key/);
  });
});

describe("lintRepo — description + when_to_use under the 1,536-char cap", () => {
  test("passes at exactly the cap and comfortably under it", () => {
    const root = makeFixtureDir();
    const description = "d".repeat(800);
    const whenToUse = "w".repeat(736); // 800 + 736 = 1536, exactly the cap
    writeSkill(
      root,
      "at-cap",
      `name: at-cap\ndescription: "${description}"\nwhen_to_use: "${whenToUse}"`,
    );

    const { errors } = lintRepo(root);

    assert.deepEqual(errors, []);
  });
});

describe("lintRepo — description + when_to_use over the 1,536-char cap", () => {
  test("fails and names the file with the actual combined length", () => {
    const root = makeFixtureDir();
    const description = "d".repeat(800);
    const whenToUse = "w".repeat(737); // 800 + 737 = 1537, one over the cap
    writeSkill(
      root,
      "over-cap",
      `name: over-cap\ndescription: "${description}"\nwhen_to_use: "${whenToUse}"`,
    );

    const { errors } = lintRepo(root);

    assert.equal(errors.length, 1);
    assert.match(errors[0], /^skills\/over-cap\/SKILL\.md:/);
    assert.match(errors[0], /description \+ when_to_use is 1537 characters/);
    assert.match(errors[0], /exceeds the 1536-character skill-listing limit/);
  });

  test("description alone (no when_to_use) is also measured against the cap", () => {
    const root = makeFixtureDir();
    const description = "d".repeat(1537);
    writeSkill(root, "long-description-only", `name: long-description-only\ndescription: "${description}"`);

    const { errors } = lintRepo(root);

    assert.equal(errors.length, 1);
    assert.match(errors[0], /^skills\/long-description-only\/SKILL\.md:/);
    assert.match(errors[0], /description \+ when_to_use is 1537 characters/);
  });

  test("an agent .md file is NOT subject to the cap (agents have no when_to_use)", () => {
    const root = makeFixtureDir();
    const description = "d".repeat(2000);
    writeAgent(root, "long-agent", `name: long-agent\ndescription: "${description}"`);

    const { errors } = lintRepo(root);

    assert.deepEqual(errors, []);
  });
});

describe("lintRepo — ignores non-skill/agent markdown", () => {
  test("a stray README.md under the fixture root is not linted", () => {
    const root = makeFixtureDir();
    fs.writeFileSync(path.join(root, "README.md"), "# not a skill or agent\n");
    writeSkill(root, "good-skill", "name: good-skill\ndescription: fine.");

    const { files, errors } = lintRepo(root);

    assert.equal(files.length, 1);
    assert.deepEqual(errors, []);
  });
});
