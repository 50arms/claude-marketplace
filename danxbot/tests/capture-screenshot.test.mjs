// DX-4538: the generic full-resolution capture tool every session's agents use (the plugin ships it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAPTURE_DEFAULTS, parseCaptureArgs } from "../scripts/lib/capture-args.mjs";
import { findBrowser } from "../scripts/lib/cdp-browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "../scripts/capture-screenshot.mjs");
const { width, height, dpr, mobileBelowWidth } = CAPTURE_DEFAULTS;

test("defaults to the desktop capture", () => {
  assert.deepEqual(parseCaptureArgs(["http://x/", "a.png"]), {
    url: "http://x/", out: "a.png", login: null, waitFor: null, width, height, dpr, isMobile: false,
  });
});

test("phone flags set the size and mobile emulation; the threshold is exclusive", () => {
  const phone = parseCaptureArgs(["u", "p.png", "--width", "390", "--height", "844", "--dpr", "3"]);
  assert.equal(phone.isMobile, true);
  assert.deepEqual([phone.width, phone.height, phone.dpr], [390, 844, 3]);
  assert.equal(parseCaptureArgs(["u", "p.png", "--width", String(mobileBelowWidth - 1)]).isMobile, true);
  assert.equal(parseCaptureArgs(["u", "p.png", "--width", String(mobileBelowWidth)]).isMobile, false);
});

test("flags are kept apart from the positionals wherever they appear", () => {
  for (const argv of [
    ["--login", "http://l/", "u", "o.png"],
    ["u", "--login", "http://l/", "o.png"],
    ["u", "o.png", "--login", "http://l/"],
  ]) {
    const r = parseCaptureArgs(argv);
    assert.deepEqual([r.url, r.out, r.login], ["u", "o.png", "http://l/"]);
  }
  assert.equal(parseCaptureArgs(["u", "o.png", "--wait-for", "#ready"]).waitFor, "#ready");
});

for (const [argv, message] of [
  [[], /need exactly/],
  [["u", "o.png", "extra"], /need exactly/],
  [["u", "o.jpg"], /must end in \.png/],
  [["u", "o.png", "--width", "abc"], /--width must be a positive number/],
  [["u", "o.png", "--dpr", "0"], /--dpr must be a positive number/],
  [["u", "o.png", "--login"], /--login needs a value/],
  [["u", "o.png", "--login", "--width", "390"], /--login needs a value, got "--width"/],
  [["u", "o.png", "--scale", "1"], /unknown flag --scale/],
]) {
  test(`refuses ${JSON.stringify(argv)}`, () => assert.throws(() => parseCaptureArgs(argv), message));
}

test("findBrowser honours CHROME_PATH, refuses a missing one, and fails loudly with none installed", () => {
  assert.equal(findBrowser({ CHROME_PATH: "/x/chrome" }, () => true), "/x/chrome");
  assert.throws(() => findBrowser({ CHROME_PATH: "/x/chrome" }, () => false), /does not exist/);
  assert.throws(() => findBrowser({}, () => false), /no Chrome or Edge found/);
});

// The end-to-end half needs a real Chromium-family browser; a machine without one cannot run it.
let browser = null;
try {
  browser = findBrowser();
} catch {
  /* skipped below */
}

function pngSize(file) {
  const b = readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test("captures a real page at full device resolution and fails loudly on a bad one", { skip: !browser }, async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/missing") return void res.writeHead(404).end("nope");
    if (req.url === "/never") return void res.writeHead(200, { "content-type": "text/html" }).end("<p>x</p>");
    res.writeHead(200, { "content-type": "text/html" }).end(`<h1 id="ready">hello</h1>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(path.join(tmpdir(), "capture-test-"));
  // Async, never spawnSync: the page is served from this process's own event loop.
  const run = (...argv) =>
    new Promise((resolve) =>
      execFile(process.execPath, [SCRIPT, ...argv], { encoding: "utf8", timeout: 60_000 }, (err, stdout, stderr) =>
        resolve({ status: err ? err.code : 0, stdout, stderr }),
      ),
    );
  try {
    const out = path.join(dir, "ok.png");
    const ok = await run(`${base}/`, out, "--width", "600", "--height", "300", "--dpr", "2", "--wait-for", "#ready");
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(pngSize(out), [1200, 600]);

    const missing = await run(`${base}/missing`, path.join(dir, "m.png"));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /answered 404/);

    const never = await run(`${base}/never`, path.join(dir, "n.png"), "--wait-for", "#ready");
    assert.equal(never.status, 1);
    assert.match(never.stderr, /timed out after \d+ms waiting for #ready/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

test("issue-workflow's Show the work clause names the shipped tool, and the example flags parse", () => {
  const skill = readFileSync(path.join(here, "../skills/issue-workflow/SKILL.md"), "utf8").replace(/\s+/g, " ");
  assert.match(skill, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/capture-screenshot\.mjs/);
  assert.ok(readFileSync(SCRIPT, "utf8").length > 0);
  assert.ok(skill.includes(`--width ${width} --height ${height} --dpr ${dpr}`));
  const phone = skill.match(/phone `(--width \d+ --height \d+ --dpr \d+)/)?.[1];
  assert.ok(phone, "the phone example is documented");
  assert.equal(parseCaptureArgs(["u", "p.png", ...phone.split(" ")]).isMobile, true);
});
