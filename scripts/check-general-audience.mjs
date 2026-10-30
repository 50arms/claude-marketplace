#!/usr/bin/env node
//
// check-general-audience.mjs — DX-4551 (AC 44348).
//
// A plugin's text reaches every user who installs it: skills, agent bodies, hook text
// and the strings its scripts print. None of it may name something only its author's own setup
// has: a personal GitHub account or marketplace name, a shell alias, the author's domain or other
// products, an internal card/plan id, or a path in the author's own repo. This scan fails the
// publish (scripts/publish.sh runs it before any bump) when any shipped file does.
//
// WHAT IS SCANNED. Every file the plugin ships (`listPluginFiles`: tests and node_modules are not
// shipped, so test files that hold the banned tokens as matcher proof are exempt by construction),
// except `.claude-plugin/plugin.json`, the plugin manifest, whose `dashboard_url` default is the
// product's own public address. Markdown and JSON are scanned whole; code (.mjs .js .ts .tsx .sh)
// is scanned with its comments stripped for the author-setup tokens (a comment is read by a maintainer, not shown
// to a user), but its comments are still scanned for internal card ids and source paths: anyone who installs the
// plugin can open its files, and cannot see our cards or our source. A file type the scan does not know throws (binary assets are an explicit list),
// so a new type can never ship unscanned.
//
// COMMENT STRIPPING is a small state machine, not a parser. It follows strings, template
// literals and regex literals so a `//` inside one is not taken for a comment. Its one blind
// spot is JSX text (plain words between tags): an apostrophe there is not a string, and a `//`
// there reads as a comment start, which can hide the rest of that line from the scan.
//
// SOURCE FILES IN COMMENTS. Any file name ending .ts .tsx or .mjs (any case), or .js (starting lowercase), that a comment names must be a file
// the plugin ships. A user's own file names, such as `index.ts`, are meant to fail too: describe them in words. Only capitalised
// product names ending .js (Node.js, Next.js) are not file names and pass; Button.tsx does not.
//
// USAGE node scripts/check-general-audience.mjs [plugin ...]   (default: every marketplace plugin)

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Top-level directories of a plugin that are never shipped to a user: its tests and installed dependencies. */
const EXCLUDED_TOP_DIRS = new Set(["tests", "node_modules"]);

/**
 * The plugin's shipped files, as paths relative to the plugin dir, with `/` separators, sorted: what `git add <plugin>/`
 * would commit (tracked plus untracked-not-ignored), minus the excluded top-level directories and any tracked file deleted
 * from the working tree.
 */
export function listPluginFiles(repoRoot, plugin) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", plugin], {
    cwd: repoRoot,
    maxBuffer: 16 * 1024 * 1024,
  }).toString("utf8");
  return out
    .split("\0")
    .filter((p) => p !== "")
    .map((p) => p.slice(plugin.length + 1))
    .filter((rel) => !EXCLUDED_TOP_DIRS.has(rel.split("/")[0]))
    .filter((rel) => fs.existsSync(path.join(repoRoot, plugin, rel)))
    .sort();
}

/** Each token names something only the author's setup has. */
export const BANNED = [
  { name: "a personal GitHub account or marketplace name", pattern: /(?<![a-z])newms(?![a-z])/i },
  { name: "a personal shell alias", pattern: /update-claude-plugins/i },
  { name: "the author's own domain", pattern: /sageus/i },
  { name: "another of the author's products", pattern: /gpt-manager/i },
  { name: "another of the author's organizations", pattern: /flytedesk/i },
  { name: "the author's own UI library", pattern: /@danxbot\/ui/i },
  // `comments: true` kinds also apply inside code comments. A comment is read by anyone who opens the installed plugin, so it may
  // name none of our cards, card comments or source paths; it states the reason itself. (The other kinds are about text a user is shown.)
  { name: "a path in the author's repo", pattern: /(?<![\w.-])(?:src|packages|mcp-servers|frontend|docs\/pages)\/[\w.-]/, comments: true },
  { name: "an internal card, plan or plan-record id", pattern: /\b(?:DX|PLAN|PLN|SG|PBLM|CAV|CP|R)-\d+/, comments: true },
  { name: "an internal card comment, note or problem number", pattern: /\b(?:comment|note|problem)s? #?\d{3,}\b/i, comments: true },
];

/** Names of the comment-applicable banned things `text` mentions (one entry per kind). */
export const commentHits = (text) => BANNED.filter((b) => b.comments).flatMap(({ name, pattern }) => (pattern.test(text) ? [name] : []));

// Product names are capitalised and end in .js (Node.js, Next.js), so only a .js name starting lowercase counts; a .ts .tsx or .mjs name
// counts whatever its case (Button.tsx is a source file, not a product).
const SOURCE_FILE_NAME = /\b(?:[a-z][\w.-]*\.js|[A-Za-z][\w.-]*\.(?:tsx|ts|mjs))\b/g;
export const FOREIGN_SOURCE_FILE = "a source file the plugin does not ship";

/** Source file names `commentText` mentions that are not in `shippedBasenames`: a comment may name the plugin's own files, never outside sources. */
export const foreignSourceFiles = (commentText, shippedBasenames) =>
  (commentText.match(SOURCE_FILE_NAME) ?? []).filter((name) => !shippedBasenames.has(name));

/** `raw` keeping only its comments (everything else blanked to spaces, newlines kept), or null for a file type with no comments to read. */
export function commentOnly(rel, raw) {
  const ext = path.extname(rel).toLowerCase();
  const stripped = JS_LIKE.has(ext) ? stripJsComments(raw) : ext === ".sh" ? stripShellComments(raw) : null;
  if (stripped === null) return null;
  // By UTF-16 unit, like `stripped` (the strippers keep every unit in place), so an emoji earlier in the file cannot shift the comparison.
  let out = "";
  for (let i = 0; i < raw.length; i++) out += raw[i] === "\n" || stripped[i] !== raw[i] ? raw[i] : " ";
  return out;
}

/** Names of the banned things `text` mentions (one entry per kind). */
export const bannedHits = (text) => BANNED.flatMap(({ name, pattern }) => (pattern.test(text) ? [name] : []));

/** Manifest files that are scanned as data, not as a user-facing text surface. */
const NOT_SCANNED = new Set([".claude-plugin/plugin.json"]);
const WHOLE_TEXT = new Set([".md", ".json"]);
const JS_LIKE = new Set([".mjs", ".js", ".ts", ".tsx"]);

const blank = (s) => s.replace(/[^\n]/g, " ");

/** `src` with every comment replaced by spaces (newlines kept, so line numbers hold). */
export function stripJsComments(src) {
  let out = "";
  let i = 0;
  let prevSignificant = "";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      // A JS string never spans lines, so a stray apostrophe in JSX text recovers at the newline.
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      prevSignificant = c;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== "`") j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      prevSignificant = c;
      continue;
    }
    if (c === "/" && (prevSignificant === "" || "(,=:[!&|?{};".includes(prevSignificant))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n" && (inClass || src[j] !== "/")) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      prevSignificant = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out;
}

/** `src` (shell) with whole-line and trailing ` # ...` comments replaced by spaces. */
export function stripShellComments(src) {
  return src
    .split("\n")
    .map((line) => {
      if (/^\s*#/.test(line)) return blank(line);
      let quote = "";
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === "\\" && quote === '"') i++;
          else if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "#" && i > 0 && /\s/.test(line[i - 1])) return line.slice(0, i) + blank(line.slice(i));
      }
      return line;
    })
    .join("\n");
}

/**
 * Extensions of files that carry no text a user reads (images, fonts, archives). Every other extension must be one
 * the scan understands: a new file type throws, so adding one forces a decision instead of shipping unscanned.
 */
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".woff", ".woff2", ".ttf", ".otf", ".zip", ".gz", ".wasm"]);

/** The text of `rel` a user can be shown, or null for a file that is not scanned (the manifest, a binary asset). Throws on an unknown file type. */
export function userFacingText(rel, raw) {
  if (NOT_SCANNED.has(rel)) return null;
  const ext = path.extname(rel).toLowerCase();
  if (WHOLE_TEXT.has(ext)) return raw;
  if (JS_LIKE.has(ext)) return stripJsComments(raw);
  if (ext === ".sh") return stripShellComments(raw);
  if (BINARY_EXTENSIONS.has(ext)) return null;
  throw new Error(`check-general-audience: ${rel} has file type "${ext}", which the scan neither reads nor lists as binary. Teach scripts/check-general-audience.mjs how to read it (or list it as binary) before shipping it.`);
}

/** Violations `{file, line, what}` over `relFiles` of `pluginDir`. */
export function scanFiles(pluginDir, relFiles) {
  const violations = [];
  const shippedBasenames = new Set(relFiles.map((rel) => path.basename(rel)));
  for (const rel of relFiles) {
    const source = fs.readFileSync(path.join(pluginDir, rel), "utf8");
    const text = userFacingText(rel, source);
    if (text === null) continue;
    const rawLines = source.split("\n");
    const comments = (commentOnly(rel, source) ?? "").split("\n");
    text.split("\n").forEach((line, idx) => {
      const what = new Set([...bannedHits(line), ...commentHits(rawLines[idx])]);
      if (foreignSourceFiles(comments[idx] ?? "", shippedBasenames).length > 0) what.add(FOREIGN_SOURCE_FILE);
      for (const w of what) violations.push({ file: rel, line: idx + 1, what: w });
    });
  }
  return violations;
}

export function scanPlugin(repoRoot, plugin) {
  return scanFiles(path.join(repoRoot, plugin), listPluginFiles(repoRoot, plugin));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let plugins = process.argv.slice(2);
  if (plugins.length === 0) {
    const marketplace = JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
    plugins = marketplace.plugins.map((p) => p.source.replace(/^\.\//, ""));
  }
  let failed = 0;
  for (const plugin of plugins) {
    for (const v of scanPlugin(repoRoot, plugin)) {
      failed++;
      console.error(`${plugin}/${v.file}:${v.line}: ${v.what}`);
    }
  }
  if (failed > 0) {
    console.error(`General-audience scan failed: ${failed} line(s) name something specific to the author's own setup. Reword them for any user.`);
    process.exit(1);
  }
  console.log(`General-audience scan passed: ${plugins.join(", ")}.`);
}
