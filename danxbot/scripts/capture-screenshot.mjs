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
import { findBrowser, launchPage, poll, requireNode } from "./lib/cdp-browser.mjs";

/**
 * Navigates and resolves once the main frame's load event fired. `what` names the visit in every error:
 * a sign-in URL carries a secret, so no URL is ever put in a message for it.
 */
async function visit(session, mainFrameId, url, what, timeoutMs) {
  let status = null;
  let loaded = false;
  const stop = session.on((method, p) => {
    // Only the top frame's Document answers for the page (an iframe's status says nothing about it);
    // the last one before load is the page itself, redirects precede it.
    if (method === "Network.responseReceived" && p.type === "Document" && p.frameId === mainFrameId) {
      status = p.response.status;
    }
    if (method === "Page.loadEventFired") loaded = true;
  });
  try {
    const nav = await session.send("Page.navigate", { url });
    if (nav.errorText) throw new Error(`${what} failed: ${nav.errorText}`);
    await poll(`${what} to finish loading`, timeoutMs, () => loaded);
  } finally {
    stop();
  }
  if (status === null || status < 200 || status >= 300) {
    throw new Error(`${what} answered ${status ?? "no response"}`);
  }
}

async function evaluate(session, expression) {
  const r = await session.send("Runtime.evaluate", { expression, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(`page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result.value;
}

const present = (selector) => `!!document.querySelector(${JSON.stringify(selector)})`;

async function main() {
  requireNode();
  const args = parseCaptureArgs(process.argv.slice(2));
  const timeout = CAPTURE_DEFAULTS.readyTimeoutMs;
  const { session, close } = await launchPage(findBrowser(), timeout);
  try {
    await session.send("Page.enable");
    await session.send("Network.enable");
    const { frameTree } = await session.send("Page.getFrameTree");
    const mainFrameId = frameTree.frame.id;
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: args.width,
      height: args.height,
      deviceScaleFactor: args.dpr,
      mobile: args.isMobile,
    });
    // The single-use sign-in URL signs this throwaway profile in before the real page loads.
    if (args.login) await visit(session, mainFrameId, args.login, "the --login visit", timeout);
    await visit(session, mainFrameId, args.url, `GET ${args.url}`, timeout);
    // A spent --login ticket leaves the sign-in form up: say so now, before the readiness wait times out.
    if (args.login && (await evaluate(session, present(SIGN_IN_FORM_SELECTOR)))) {
      throw new Error("the page shows the sign-in form: the --login ticket did not sign this capture in");
    }
    // Apps that hold an open stream never go network-idle: wait on readiness signals instead, bounded.
    // The app's own selector first, then nothing on screen may still be loading.
    if (args.waitFor) await poll(`${args.waitFor} to appear`, timeout, () => evaluate(session, present(args.waitFor)));
    await poll(`no ${BUSY_SELECTOR} element`, timeout, () => evaluate(session, `!${present(BUSY_SELECTOR)}`));
    const shot = await session.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(args.out, Buffer.from(shot.data, "base64"));
    console.log(`${args.out} (${args.width}x${args.height} @${args.dpr}x)`);
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(process.exitCode || 1);
});
