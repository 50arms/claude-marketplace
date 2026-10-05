// DX-4538: the generic full-resolution capture tool every session's agents use (the plugin ships it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAPTURE_DEFAULTS, parseCaptureArgs } from "../scripts/lib/capture-args.mjs";
import { PROFILE_PREFIX, findBrowser, requireNode } from "../scripts/lib/cdp-browser.mjs";

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

const only = (...present) => (p) => present.includes(p);

test("findBrowser: CHROME_PATH wins, a missing one is refused, none installed fails loudly", () => {
  assert.equal(findBrowser({ env: { CHROME_PATH: "/x/chrome" }, exists: () => true }), "/x/chrome");
  assert.throws(() => findBrowser({ env: { CHROME_PATH: "/x/chrome" }, exists: () => false }), /does not exist/);
  assert.throws(() => findBrowser({ env: {}, exists: () => false, platform: "linux", home: "/h" }), /no Chrome or Edge found/);
});

test("findBrowser: Linux searches PATH, macOS also searches ~/Applications", () => {
  const env = { PATH: ["/a/bin", "/b/bin"].join(path.delimiter) };
  const chromium = path.join("/b/bin", "chromium");
  assert.equal(findBrowser({ env, platform: "linux", home: "/h", exists: only(chromium) }), chromium);
  const mine = path.join("/h", "Applications", "Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.equal(findBrowser({ env: {}, platform: "darwin", home: "/h", exists: only(mine) }), mine);
});

test("findBrowser: Windows reads Program Files, and WSL says why a Windows browser is not used", () => {
  const edge = path.win32.join("C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe");
  assert.equal(
    findBrowser({ env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" }, platform: "win32", exists: only(edge) }),
    edge,
  );
  assert.throws(
    () => findBrowser({ env: { WSL_DISTRO_NAME: "Ubuntu", PATH: "" }, platform: "linux", home: "/h", exists: () => false }),
    /Windows browser cannot be driven: install Chromium in WSL/,
  );
});

test("requireNode refuses a Node older than 22 with a clear message", () => {
  assert.throws(() => requireNode("20.11.0"), /needs Node 22 or newer \(this is 20\.11\.0\)/);
  assert.doesNotThrow(() => requireNode("22.0.0"));
});

// The browser-driving half needs a real Chromium-family browser; a machine without one cannot run it.
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

const html = (res, body, status = 200) => void res.writeHead(status, { "content-type": "text/html" }).end(body);
const PAGES = {
  "/": (res) => html(res, `<h1 id="ready">hello</h1>`),
  "/missing": (res) => html(res, "nope", 404),
  "/bare": (res) => html(res, "<p>x</p>"),
  // A 404 top frame must fail even though its iframe answered 200 ...
  "/top404-iframe200": (res) => html(res, `<iframe src="/"></iframe>`, 404),
  // ... and a 200 page must succeed though its iframe answered 404.
  "/top200-iframe404": (res) => html(res, `<h1 id="ready">ok</h1><iframe src="/missing"></iframe>`),
  // The app never mounted: an empty mount root, and the same with a script that threw while loading.
  "/img": (res) =>
    html(res, `<img width="20" height="20" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">`),
  "/blank": (res) => html(res, `<div id="root"></div>`),
  "/throws": (res) =>
    html(res, `<div id="root"></div><script>throw new Error("boom-during-load")</script>`),
  "/signin": (res) => html(res, `<input type="password">`),
  "/login": (res) => html(res, "signed in"),
  "/busy": (res) => html(res, `<h1 id="ready">r</h1><div aria-busy="true"></div>`),
};

async function withServer(fn) {
  const server = http.createServer((req, res) => (PAGES[new URL(req.url, "http://x").pathname] ?? PAGES["/missing"])(res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(path.join(tmpdir(), "capture-test-"));
  const tmp = path.join(dir, "tmp");
  mkdirSync(tmp);
  // Async, never spawnSync: the page is served from this process's own event loop. TEMP/TMPDIR point at a
  // directory of this test's own, so "the profile is gone" is an exact assertion.
  const run = (argv, env = {}) =>
    new Promise((resolve) => {
      const started = Date.now();
      execFile(
        process.execPath,
        [SCRIPT, ...argv],
        { encoding: "utf8", timeout: 60_000, env: { ...process.env, TEMP: tmp, TMPDIR: tmp, ...env } },
        (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr, ms: Date.now() - started }),
      );
    });
  try {
    await fn({ base, dir, tmp, run, leftovers: () => readdirSync(tmp).filter((n) => n.startsWith(PROFILE_PREFIX)) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
}

test("a capture is full device resolution, exits promptly, and leaves no profile behind", { skip: !browser }, () =>
  withServer(async ({ base, dir, run, leftovers }) => {
    const out = path.join(dir, "ok.png");
    const ok = await run([`${base}/`, out, "--width", "600", "--height", "300", "--dpr", "2", "--wait-for", "#ready"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(pngSize(out), [1200, 600]);
    assert.ok(ok.ms < 10_000, `exited in ${ok.ms}ms: the 15s readiness timeout must not hold the process`);
    assert.deepEqual(leftovers(), []);
  }));

test("a top-frame 404 fails even with a 200 iframe; a 200 page succeeds with a 404 iframe", { skip: !browser }, () =>
  withServer(async ({ base, dir, run }) => {
    const bad = await run([`${base}/top404-iframe200`, path.join(dir, "a.png")]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /answered 404/);
    const good = await run([`${base}/top200-iframe404`, path.join(dir, "b.png"), "--wait-for", "#ready"]);
    assert.equal(good.status, 0, good.stderr);
  }));

test("a page that never becomes ready, a still-busy page and a bad selector each fail loudly", { skip: !browser }, () =>
  withServer(async ({ base, dir, run, leftovers }) => {
    const never = await run([`${base}/bare`, path.join(dir, "n.png"), "--wait-for", "#ready"]);
    assert.equal(never.status, 1);
    assert.match(never.stderr, /timed out after \d+ms waiting for #ready to appear/);
    // --wait-for does not exempt the page from the busy wait.
    const busy = await run([`${base}/busy`, path.join(dir, "b.png"), "--wait-for", "#ready"]);
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /waiting for no \[aria-busy="true"\] element/);
    const bad = await run([`${base}/`, path.join(dir, "s.png"), "--wait-for", "<<"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /page script failed: .*not a valid selector/);
    assert.deepEqual(leftovers(), []);
  }));

test("a blank page and a page that throws during load fail by default; the thrown error is named", { skip: !browser }, () =>
  withServer(async ({ base, dir, run, leftovers }) => {
    const blank = await run([`${base}/blank`, path.join(dir, "bl.png")]);
    assert.equal(blank.status, 1);
    assert.match(blank.stderr, /timed out after \d+ms waiting for the page to render visible content/);
    assert.ok(!blank.stderr.includes("uncaught page error"), "nothing threw, so none is claimed");
    const throws = await run([`${base}/throws`, path.join(dir, "th.png")]);
    assert.equal(throws.status, 1);
    assert.match(throws.stderr, /render visible content/);
    assert.match(throws.stderr, /uncaught page error\(s\) during load:\nError: boom-during-load/);
    assert.deepEqual(leftovers(), []);
  }));

test("a page with only an image or only text renders by default", { skip: !browser }, () =>
  withServer(async ({ base, dir, run }) => {
    const text = await run([`${base}/bare`, path.join(dir, "t.png")]);
    assert.equal(text.status, 0, text.stderr);
    const img = await run([`${base}/img`, path.join(dir, "i.png")]);
    assert.equal(img.status, 0, img.stderr);
  }));

test("--login: the sign-in form is refused, and the login URL's secret is never printed", { skip: !browser }, () =>
  withServer(async ({ base, dir, run }) => {
    const form = await run([`${base}/signin`, path.join(dir, "f.png"), "--login", `${base}/login?ticket=SECRET123`]);
    assert.equal(form.status, 1);
    assert.match(form.stderr, /shows the sign-in form/);
    assert.ok(!(form.stdout + form.stderr).includes("SECRET123"));
    const spent = await run([`${base}/`, path.join(dir, "g.png"), "--login", `${base}/missing?ticket=SECRET123`]);
    assert.equal(spent.status, 1);
    assert.match(spent.stderr, /the --login visit answered 404/);
    assert.ok(!(spent.stdout + spent.stderr).includes("SECRET123"));
  }));

test("a launch that fails reports the browser's stderr and removes the profile", () =>
  withServer(async ({ base, dir, run, leftovers }) => {
    // node itself is the "browser": it rejects --headless=new and exits, with a message on stderr.
    const r = await run([`${base}/`, path.join(dir, "x.png")], { CHROME_PATH: process.execPath });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /exited \d+ before it was ready/);
    assert.match(r.stderr, /browser stderr \(tail\):\n.*bad option/);
    assert.deepEqual(leftovers(), []);
  }));

test("a browser that cannot be started at all fails fast, profile removed", { skip: process.platform === "win32" }, () =>
  withServer(async ({ base, dir, run, leftovers }) => {
    const notExecutable = path.join(dir, "not-a-browser");
    writeFileSync(notExecutable, "");
    chmodSync(notExecutable, 0o644);
    const r = await run([`${base}/`, path.join(dir, "x.png")], { CHROME_PATH: notExecutable });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not start/);
    assert.deepEqual(leftovers(), []);
  }));

// Windows has no SIGTERM delivery to a handler, so the signal path can only be exercised on POSIX.
test("SIGTERM kills the browser and removes the profile", { skip: process.platform === "win32" }, () =>
  withServer(async ({ base, dir, tmp, leftovers }) => {
    const fake = path.join(dir, "fake-browser");
    writeFileSync(fake, "#!/bin/sh\nexec sleep 60\n");
    chmodSync(fake, 0o755);
    const child = execFile(process.execPath, [SCRIPT, `${base}/`, path.join(dir, "s.png")], {
      env: { ...process.env, TEMP: tmp, TMPDIR: tmp, CHROME_PATH: fake },
    });
    const code = new Promise((resolve) => child.once("exit", (c) => resolve(c)));
    while (leftovers().length === 0) await new Promise((r) => setTimeout(r, 50));
    child.kill("SIGTERM");
    assert.equal(await code, 143);
    assert.deepEqual(leftovers(), []);
  }));

test("issue-workflow's Show the work clause names the shipped tool, and the example flags parse", () => {
  const skill = readFileSync(path.join(here, "../skills/issue-workflow/SKILL.md"), "utf8").replace(/\s+/g, " ");
  assert.match(skill, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/capture-screenshot\.mjs/);
  assert.ok(skill.includes(`--width ${width} --height ${height} --dpr ${dpr}`));
  const phone = skill.match(/phone `(--width \d+ --height \d+ --dpr \d+)/)?.[1];
  assert.ok(phone, "the phone example is documented");
  assert.equal(parseCaptureArgs(["u", "p.png", ...phone.split(" ")]).isMobile, true);
});
