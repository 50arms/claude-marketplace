#!/usr/bin/env node
// DX-4538: full-resolution PNG evidence for a card, from any repo. A browser-pane screenshot is a
// downscaled 800px-wide JPEG (region zoom is unsupported), so it is for your own viewing only;
// attach THIS capture instead. Drives the machine's own Chrome/Edge over the DevTools Protocol with
// no dependencies (the plugin ships no node_modules). Fails loudly (non-zero) rather than capturing
// a page that is not the one asked for.
//
// usage  node "${CLAUDE_PLUGIN_ROOT}/scripts/capture-screenshot.mjs" <url> <out.png>
//          [--login <single-use sign-in url>] [--wait-for <css selector>]
//          [--width 1440] [--height 900] [--dpr 2]      (phone: --width 390 --height 844 --dpr 3)
import { writeFileSync } from "node:fs";
import { BUSY_SELECTOR, CAPTURE_DEFAULTS, SIGN_IN_FORM_SELECTOR, parseCaptureArgs } from "./lib/capture-args.mjs";
import { findBrowser, launchPage } from "./lib/cdp-browser.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Navigates and resolves once the load event fired; rejects on a non-2xx main-document response. */
async function visit(session, url, timeoutMs) {
  let status = null;
  let documentUrl = null;
  let loaded;
  const done = new Promise((resolve) => (loaded = resolve));
  session.on((method, p) => {
    // The last Document response before load is the one the page rendered (redirects precede it).
    if (method === "Network.responseReceived" && p.type === "Document") {
      status = p.response.status;
      documentUrl = p.response.url;
    }
    if (method === "Page.loadEventFired") loaded();
  });
  const nav = await session.send("Page.navigate", { url });
  if (nav.errorText) throw new Error(`GET ${url} failed: ${nav.errorText}`);
  await Promise.race([
    done,
    sleep(timeoutMs).then(() => {
      throw new Error(`GET ${url} did not finish loading within ${timeoutMs}ms`);
    }),
  ]);
  if (status === null || status < 200 || status >= 300) {
    throw new Error(`GET ${documentUrl ?? url} answered ${status ?? "no response"}`);
  }
}

async function evaluate(session, expression) {
  const r = await session.send("Runtime.evaluate", { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.text}`);
  return r.result.value;
}

async function waitUntil(session, what, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!(await evaluate(session, expression))) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(100);
  }
}

async function main() {
  const args = parseCaptureArgs(process.argv.slice(2));
  const timeout = CAPTURE_DEFAULTS.readyTimeoutMs;
  const { session, close } = await launchPage(findBrowser(), timeout);
  try {
    await session.send("Page.enable");
    await session.send("Network.enable");
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: args.width,
      height: args.height,
      deviceScaleFactor: args.dpr,
      mobile: args.isMobile,
    });
    // The single-use sign-in URL signs this throwaway profile in before the real page loads.
    if (args.login) await visit(session, args.login, timeout);
    await visit(session, args.url, timeout);
    // A spent --login ticket leaves the sign-in form up: say so now, before the readiness wait times out.
    if (args.login && (await evaluate(session, `!!document.querySelector(${JSON.stringify(SIGN_IN_FORM_SELECTOR)})`))) {
      throw new Error("the page shows the sign-in form: the --login ticket did not sign this capture in");
    }
    // Apps that hold an open stream never go network-idle: wait on a readiness signal instead, bounded.
    if (args.waitFor) {
      await waitUntil(session, args.waitFor, `!!document.querySelector(${JSON.stringify(args.waitFor)})`, timeout);
    } else {
      await waitUntil(session, `no ${BUSY_SELECTOR} element`, `!document.querySelector(${JSON.stringify(BUSY_SELECTOR)})`, timeout);
    }
    const shot = await session.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(args.out, Buffer.from(shot.data, "base64"));
    console.log(`${args.out} (${args.width}x${args.height} @${args.dpr}x)`);
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
