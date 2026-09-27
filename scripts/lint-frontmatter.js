#!/usr/bin/env node
//
// Lint the YAML frontmatter of every skill (skills/*/SKILL.md) and agent
// (agents/*.md) file in the repo. Shared by every plugin's publish flow —
// this is the ONE implementation, invoked once against the whole repo
// rather than duplicated per plugin.
//
// Checks, per file:
//   1. Frontmatter block (--- ... ---) exists and parses as real YAML
//      (js-yaml — not a regex approximation).
//   2. `name` and `description` keys are present (non-empty strings).
//   3. SKILL.md only (DX-2979): `description` + `when_to_use` combined
//      length must not exceed 1,536 characters — the Claude Code
//      skill-listing limit. Exceeding it truncates the listing entry
//      rather than failing loud, so this is enforced here instead.
//      `when_to_use` is optional; a file without it is measured on
//      `description` alone.
//
// Exit 0 = every file clean. Exit 1 = at least one failure, each printed
// as "<path>: <error>" so the failing file and reason are both visible
// without re-running anything.
//
// Usage: node scripts/lint-frontmatter.js [repoRoot]

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// DX-2979 — Claude Code's skill-listing entry truncates (doesn't error)
// once description + when_to_use exceeds this many characters.
const MAX_DESCRIPTION_LENGTH = 1536;

function findTargetFiles(root) {
  const targets = [];
  const skip = new Set(["node_modules", ".git"]);

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      const isSkill = /(^|\/)skills\/[^/]+\/SKILL\.md$/.test(rel);
      const isAgent = /(^|\/)agents\/[^/]+\.md$/.test(rel);
      if (isSkill || isAgent) targets.push(full);
    }
  }

  walk(root);
  return targets.sort();
}

function extractFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) return null;
  return match[1];
}

// root: used only to render a friendly relative path in the error message.
function lintFile(filePath, root) {
  const rel = path.relative(root, filePath).split(path.sep).join("/");
  const content = fs.readFileSync(filePath, "utf8");

  const raw = extractFrontmatter(content);
  if (raw === null) {
    return `${rel}: no frontmatter block found (expected --- ... --- at top of file)`;
  }

  let doc;
  try {
    doc = yaml.load(raw);
  } catch (e) {
    return `${rel}: frontmatter is not valid YAML — ${e.message}`;
  }

  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return `${rel}: frontmatter did not parse to a YAML mapping`;
  }

  if (typeof doc.name !== "string" || doc.name.trim() === "") {
    return `${rel}: frontmatter missing required "name" key`;
  }

  if (typeof doc.description !== "string" || doc.description.trim() === "") {
    return `${rel}: frontmatter missing required "description" key`;
  }

  const isSkill = /(^|\/)skills\/[^/]+\/SKILL\.md$/.test(rel);
  if (isSkill) {
    const whenToUse = typeof doc.when_to_use === "string" ? doc.when_to_use : "";
    const combinedLength = doc.description.length + whenToUse.length;
    if (combinedLength > MAX_DESCRIPTION_LENGTH) {
      return `${rel}: description + when_to_use is ${combinedLength} characters, exceeds the ${MAX_DESCRIPTION_LENGTH}-character skill-listing limit`;
    }
  }

  return null;
}

// Lints every skill/agent file found under root. Returns the list of
// error strings (empty = clean) — never throws, never exits.
function lintRepo(root) {
  const files = findTargetFiles(root);
  const errors = [];
  for (const file of files) {
    const error = lintFile(file, root);
    if (error) errors.push(error);
  }
  return { files, errors };
}

function main() {
  const repoRoot = path.resolve(process.argv[2] || path.join(__dirname, ".."));
  const { files, errors } = lintRepo(repoRoot);

  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    console.error(`\nfrontmatter lint: ${errors.length} error(s) across ${files.length} file(s) checked.`);
    process.exit(1);
  }

  console.log(`frontmatter lint: ${files.length} file(s) checked, all clean.`);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { findTargetFiles, extractFrontmatter, lintFile, lintRepo };
