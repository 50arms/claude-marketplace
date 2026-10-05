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
import { PageErrors, redactUrls } from "./lib/page-errors.mjs";
import { PAGE_RENDERS_CONTENT } from "./lib/page-programs.mjs";
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
  const loadTimeout = CAPTURE_DEFAULTS.loadTimeoutMs;
  const { session, close } = await launchPage(findBrowser(), loadTimeout);
  // DX-4539: uncaught page errors, kept to name the cause when the page never renders or never becomes ready.
  const pageErrors = new PageErrors();
  session.on((method, p) => {
    if (method === "Runtime.exceptionThrown") pageErrors.record(p.exceptionDetails);
  });
  try {
    await session.send("Page.enable");
    await session.send("Network.enable");
    await session.send("Runtime.enable");
    const { frameTree } = await session.send("Page.getFrameTree");
    const mainFrameId = frameTree.frame.id;
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: args.width,
      height: args.height,
      deviceScaleFactor: args.dpr,
      mobile: args.isMobile,
    });
    // The single-use sign-in URL signs this throwaway profile in before the real page loads.
    if (args.login) await visit(session, mainFrameId, args.login, "the --login visit", loadTimeout);
    await visit(session, mainFrameId, args.url, `GET ${args.url}`, loadTimeout);
    // A spent --login ticket leaves the sign-in form up: say so now, before the readiness wait times out.
    if (args.login && (await evaluate(session, present(SIGN_IN_FORM_SELECTOR)))) {
      throw new Error("the page shows the sign-in form: the --login ticket did not sign this capture in");
    }
    // Apps that hold an open stream never go network-idle: wait on readiness signals instead, bounded.
    // The app's own selector first, then nothing on screen may still be loading.
    const ready = args.readyTimeoutMs;
    if (args.waitFor) await poll(`${args.waitFor} to appear`, ready, () => evaluate(session, present(args.waitFor)));
    await poll(`no ${BUSY_SELECTOR} element`, ready, () => evaluate(session, `!${present(BUSY_SELECTOR)}`));
    // Without --wait-for (the escape hatch for unusual pages): an app that threw while loading never mounts and
    // shows no busy element, so a blank page must not count as ready.
    if (!args.waitFor) await poll("the page to render visible content", ready, () => evaluate(session, PAGE_RENDERS_CONTENT));
    const shot = await session.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(args.out, Buffer.from(shot.data, "base64"));
    console.log(`${args.out} (${args.width}x${args.height} @${args.dpr}x)`);
    // The capture stands (text may be on screen); the cause of a half-broken page is still worth naming.
    if (pageErrors.size > 0) console.warn(`warning: uncaught page error(s) during load:
${pageErrors.format()}`);
  } catch (e) {
    if (pageErrors.size === 0) throw e;
    throw new Error(`${e.message}\nuncaught page error(s) during load:\n${pageErrors.format()}`);
  } finally {
    await close();
  }
}

main().catch((e) => {
  // No URL reaches the output with a query or fragment: a page URL or a stack frame can carry a credential.
  console.error(redactUrls(e instanceof Error ? e.message : e));
  process.exit(process.exitCode || 1);
});
