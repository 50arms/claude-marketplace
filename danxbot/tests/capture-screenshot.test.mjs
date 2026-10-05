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
import { MAX_PAGE_ERRORS, PageErrors, describeException, redactUrls } from "../scripts/lib/page-errors.mjs";
import { PROFILE_PREFIX, findBrowser, requireNode } from "../scripts/lib/cdp-browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "../scripts/capture-screenshot.mjs");
const { width, height, dpr, mobileBelowWidth } = CAPTURE_DEFAULTS;

test("defaults to the desktop capture", () => {
  assert.deepEqual(parseCaptureArgs(["http://x/", "a.png"]), {
    url: "http://x/", out: "a.png", login: null, waitFor: null, width, height, dpr, isMobile: false, readyTimeoutMs: CAPTURE_DEFAULTS.readyTimeoutMs,
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
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const SVG_IMAGE = "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2720%27 height=%2720%27%3E%3Crect width=%2720%27 height=%2720%27/%3E%3C/svg%3E";
const PAGES = {
  "/": (res) => html(res, `<h1 id="ready">hello</h1>`),
  "/missing": (res) => html(res, "nope", 404),
  "/bare": (res) => html(res, "<p>x</p>"),
  // A 404 top frame must fail even though its iframe answered 200 ...
  "/top404-iframe200": (res) => html(res, `<iframe src="/"></iframe>`, 404),
  // ... and a 200 page must succeed though its iframe answered 404.
  "/top200-iframe404": (res) => html(res, `<h1 id="ready">ok</h1><iframe src="/missing"></iframe>`),
  "/signin": (res) => html(res, `<input type="password">`),
  "/login": (res) => html(res, "signed in"),
  "/busy": (res) => html(res, `<h1 id="ready">r</h1><div aria-busy="true"></div>`),
  // Script URLs and page URLs carry a secret in the query; neither may be printed.
  "/err.js": (res) => res.writeHead(200, { "content-type": "text/javascript" }).end(`throw new Error("bad " + location.href);`),
  "/err": (res) => html(res, `<div id="root"></div><script src="/err.js?token=SECRET"></script>`),
  "/throw-string": (res) => html(res, `<div id="root"></div><script>throw "plain string"</script>`),
  "/throw-many": (res) =>
    html(res, `<div id="root"></div><script>for (let i = 0; i < ${MAX_PAGE_ERRORS + 3}; i++) setTimeout(() => { throw new Error("e" + i) })</script>`),
  // The app never mounted: an empty mount root, and the same with a script that threw while loading.
  "/blank": (res) => html(res, `<div id="root"></div>`),
  "/throws": (res) => html(res, `<div id="root"></div><script>throw new Error("boom-during-load")</script>`),
  // A static splash stays visible although the app threw: text is on screen, so this captures (with a warning).
  "/splash-throws": (res) => html(res, `<p>Loading...</p><script>throw new Error("boom-after-splash")</script>`),
  "/svg-document": (res) =>
    res.writeHead(200, { "content-type": "image/svg+xml" }).end(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="60" height="60"/></svg>`),
  "/frameset": (res) => html(res, `<frameset><frame src="/"></frameset>`),
};
// Pages whose content a person would see: each must capture.
const RENDERS = {
  "/r/text": `<p>hello</p>`,
  "/r/image": `<img width="20" height="20" src="${SVG_IMAGE}">`,
  "/r/canvas": `<canvas width="50" height="50"></canvas>`,
  "/r/svg": `<svg width="50" height="50"><rect width="40" height="40"/></svg>`,
  "/r/iframe": `<iframe width="100" height="50" srcdoc="<p>inner</p>"></iframe>`,
  "/r/video-poster": `<video width="100" height="60" poster="${GIF}"></video>`,
  "/r/background-image": `<div style="width:50px;height:50px;background-image:url(${GIF})"></div>`,
  "/r/shadow-root": `<div id="host"></div><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<p>in the shadow</p>"</script>`,
  "/r/control": `<button>go</button>`,
};
// Pages with nothing to see: each must fail the default readiness check.
const BLANKS = {
  "/b/whitespace": `<div id="root">   \n\t </div>`,
  "/b/hidden-only": `<p style="opacity:0">a</p><p style="display:none">b</p><p style="visibility:hidden">c</p>`,
  "/b/one-pixel-image": `<img width="1" height="1" src="${GIF}">`,
  "/b/zero-size-image": `<img width="0" height="0" src="${GIF}">`,
  "/b/empty-video": `<video width="100" height="60"></video>`,
  "/b/empty-iframe": `<iframe width="100" height="50" src="about:blank"></iframe>`,
  "/b/hidden-shadow-root": `<div id="host"></div><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<p style='opacity:0'>x</p>"</script>`,
};
for (const [route, body] of Object.entries({ ...RENDERS, ...BLANKS })) PAGES[route] = (res) => html(res, body);

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
      execFile(
        process.execPath,
        [SCRIPT, ...argv],
        { encoding: "utf8", timeout: 60_000, env: { ...process.env, TEMP: tmp, TMPDIR: tmp, ...env } },
        (err, stdout, stderr) => resolve({ status: err ? err.code : 0, killed: err?.killed ?? false, stdout, stderr }),
      );
    });
  try {
    await fn({ base, dir, tmp, run, leftovers: () => readdirSync(tmp).filter((n) => n.startsWith(PROFILE_PREFIX)) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
}

// Readiness waits after load are bounded by --ready-timeout, so a failure-path test does not wait out the default.
const FAST = ["--ready-timeout", "1500"];

test("a capture is full device resolution, exits by itself, and leaves no profile behind", { skip: !browser }, () =>
  withServer(async ({ base, dir, run, leftovers }) => {
    const out = path.join(dir, "ok.png");
    const ok = await run([`${base}/`, out, "--width", "600", "--height", "300", "--dpr", "2", "--wait-for", "#ready"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.killed, false, "the process ended on its own, not by the harness's kill timeout");
    assert.deepEqual(pngSize(out), [1200, 600]);
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
    const never = await run([`${base}/bare`, path.join(dir, "n.png"), "--wait-for", "#ready", ...FAST]);
    assert.equal(never.status, 1);
    assert.match(never.stderr, /timed out after 1500ms waiting for #ready to appear/);
    // --wait-for does not exempt the page from the busy wait.
    const busy = await run([`${base}/busy`, path.join(dir, "b.png"), "--wait-for", "#ready", ...FAST]);
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /waiting for no \[aria-busy="true"\] element/);
    const bad = await run([`${base}/`, path.join(dir, "s.png"), "--wait-for", "<<"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /page script failed: .*not a valid selector/);
    assert.deepEqual(leftovers(), []);
  }));

test("concurrent captures do not trip over each other's profiles", { skip: !browser }, () =>
  withServer(async ({ base, dir, run }) => {
    const runs = await Promise.all([1, 2, 3, 4].map((n) => run([`${base}/r/text`, path.join(dir, `c${n}.png`)])));
    runs.forEach((r, n) => assert.equal(r.status, 0, `capture ${n + 1}: ${r.stderr}`));
  }));

test("pages with something to see capture by default", { skip: !browser }, () =>
  withServer(async ({ base, dir, run }) => {
    for (const route of [...Object.keys(RENDERS), "/svg-document", "/frameset"]) {
      const r = await run([`${base}${route}`, path.join(dir, "r.png"), ...FAST]);
      assert.equal(r.status, 0, `${route}: ${r.stderr}`);
    }
  }));

test("pages with nothing to see fail by default, naming the missing content", { skip: !browser }, () =>
  withServer(async ({ base, dir, run, leftovers }) => {
    for (const route of ["/blank", ...Object.keys(BLANKS)]) {
      const r = await run([`${base}${route}`, path.join(dir, "b.png"), ...FAST]);
      assert.equal(r.status, 1, route);
      assert.match(r.stderr, /timed out after 1500ms waiting for the page to render visible content/, route);
      assert.ok(!r.stderr.includes("uncaught page error"), `${route}: nothing threw, so none is claimed`);
    }
    assert.deepEqual(leftovers(), []);
  }));

test("--wait-for replaces the visible-content wait: a blank page it is satisfied by captures", { skip: !browser }, () =>
  withServer(async ({ base, dir, run }) => {
    const r = await run([`${base}/blank`, path.join(dir, "w.png"), "--wait-for", "#root", ...FAST]);
    assert.equal(r.status, 0, r.stderr);
  }));

test("a page that throws during load fails when blank, naming the error; a visible splash still captures with a warning", { skip: !browser }, () =>
  withServer(async ({ base, dir, run, leftovers }) => {
    const throws = await run([`${base}/throws`, path.join(dir, "th.png"), ...FAST]);
    assert.equal(throws.status, 1);
    assert.match(throws.stderr, /render visible content/);
    assert.match(throws.stderr, /uncaught page error\(s\) during load:\nError: boom-during-load/);
    const splash = await run([`${base}/splash-throws`, path.join(dir, "sp.png"), ...FAST]);
    assert.equal(splash.status, 0, splash.stderr);
    assert.match(splash.stderr, /warning: uncaught page error\(s\) during load:\nError: boom-after-splash/);
    assert.deepEqual(leftovers(), []);
  }));

test("a thrown string is printed, the list is capped, and no query string or fragment is ever printed", { skip: !browser }, () =>
  withServer(async ({ base, dir, run }) => {
    const str = await run([`${base}/throw-string`, path.join(dir, "s.png"), ...FAST]);
    assert.match(str.stderr, /Uncaught "plain string"/);
    const many = await run([`${base}/throw-many`, path.join(dir, "m.png"), ...FAST]);
    assert.ok(many.stderr.includes("(+3 more)"), many.stderr);
    // The secret is in the page URL, in the script's URL (so in the stack frame) and, via location.href, in the message.
    const err = await run([`${base}/err?token=SECRET#SECRET`, path.join(dir, "e.png"), ...FAST]);
    assert.equal(err.status, 1);
    assert.match(err.stderr, /bad http:\/\/127\.0\.0\.1:\d+\/err\n/);
    assert.ok(!(err.stdout + err.stderr).includes("SECRET"), err.stderr);
  }));

test("page errors: URLs lose query and fragment, thrown values are described, the list is capped", () => {
  assert.equal(redactUrls("at http://h:1/a.js?token=S:1:7 and (https://x/y#frag) ok"), "at http://h:1/a.js and (https://x/y) ok");
  assert.equal(describeException({ text: "Uncaught", exception: { type: "string", value: "boom" } }), 'Uncaught "boom"');
  assert.equal(describeException({ text: "Uncaught", exception: { type: "object", description: "Error: x\n at http://h/a?k=S:1:1" } }), "Error: x\n at http://h/a");
  assert.equal(describeException({ text: "Uncaught SyntaxError: bad" }), "Uncaught SyntaxError: bad");
  const errors = new PageErrors();
  for (let i = 0; i < MAX_PAGE_ERRORS + 2; i++) errors.record({ text: `e${i}` });
  errors.record({ text: "e0" });
  assert.equal(errors.size, MAX_PAGE_ERRORS + 2);
  assert.equal(errors.format().split("\n").length, MAX_PAGE_ERRORS + 1);
  assert.match(errors.format(), /\(\+2 more\)$/);
});

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
