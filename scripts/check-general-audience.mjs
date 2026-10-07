#!/usr/bin/env node
//
// check-general-audience.mjs — DX-4551 (AC 44348).
//
// A plugin's text reaches every user who installs it: skills, agent bodies, hook text, the strings
// its scripts print, and the mantra. None of it may name something only its author's own setup
// has: a personal GitHub account or marketplace name, a shell alias, the author's domain or other
// products, an internal card/plan id, or a path in the author's own repo. This scan fails the
// publish (scripts/publish.sh runs it before any bump) when any shipped file does.
//
// WHAT IS SCANNED. Exactly the files the integrity manifest hashes (`listPluginFiles`: tests and
// node_modules are not shipped, so test files that hold the banned tokens as matcher proof are
// exempt by construction), except `.claude-plugin/plugin.json`, the manifest, whose
// `dashboard_url` default is the product's own public address. Markdown and JSON are scanned
// whole; code (.mjs .js .ts .tsx .sh) is scanned with its comments stripped, because a comment
// is read only by a maintainer and never reaches a user. A file type the scan does not know throws
// (binary assets are an explicit list), so a new type can never ship unscanned.
//
// COMMENT STRIPPING is a small state machine, not a parser. It follows strings, template
// literals and regex literals so a `//` inside one is not taken for a comment. Its one blind
// spot is JSX text (plain words between tags): an apostrophe there is not a string, and a `//`
// there reads as a comment start, which can hide the rest of that line from the scan.
//
// USAGE  node scripts/check-general-audience.mjs [plugin ...]   (default: every marketplace plugin)

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Directories under a plugin that are never part of the runtime install a hook depends on. */
const EXCLUDED_TOP_DIRS = new Set(["tests", "node_modules"]);

/** The plugin's shipped files, as paths relative to the plugin dir, with `/` separators, sorted. */
export function listPluginFiles(repoRoot, plugin) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", plugin], {
    cwd: repoRoot,
    maxBuffer: 16 * 1024 * 1024,
  }).toString("utf8");
  return out
    .split("\0")
    .filter((p) => p !== "")
    .map((p) => p.slice(plugin.length + 1))
    .filter((rel) => rel !== "integrity-manifest.json" && !EXCLUDED_TOP_DIRS.has(rel.split("/")[0]));
}

/** Each token names something only the author's setup has. */
export const BANNED = [
  { name: "a personal GitHub account or marketplace name", pattern: /(?<![a-z])newms(?![a-z])/i },
  { name: "a personal shell alias", pattern: /update-claude-plugins/i },
  { name: "the author's own domain", pattern: /sageus/i },
  { name: "another of the author's products", pattern: /gpt-manager/i },
  { name: "another of the author's organizations", pattern: /flytedesk/i },
  { name: "the author's own UI library", pattern: /@danxbot\/ui/i },
  { name: "a path in the author's repo", pattern: /(?<![\w.-])(?:src|packages)\/[\w.-]/ },
  { name: "an internal card, plan or plan-record id", pattern: /\b(?:DX|PLAN|PLN|SG|R)-\d+/ },
];

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
  for (const rel of relFiles) {
    const text = userFacingText(rel, fs.readFileSync(path.join(pluginDir, rel), "utf8"));
    if (text === null) continue;
    text.split("\n").forEach((line, idx) => {
      for (const what of bannedHits(line)) violations.push({ file: rel, line: idx + 1, what });
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
