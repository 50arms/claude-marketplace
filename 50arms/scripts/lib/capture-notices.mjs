import { resolve } from "node:path";

/** What to do with the PNG next: the attach_file step, primary first, then replaces at each milestone. */
export function attachStep(outPath) {
  return [
    `next: attach it with attach_file, path ${resolve(outPath)}`,
    "  first working state: primary: true",
    "  every later milestone and at completion: replaces: <attachment_id from the previous attach reply> (never a growing list)",
  ].join("\n");
}

/** Printed when no --wait-for was given: the capture then rests on the generic readiness check only. */
export const WAIT_FOR_NOTICE =
  "notice: no --wait-for given; readiness was only 'nothing busy and some visible content'. Pass --wait-for <css selector> naming the element that proves the page is the one you mean.";

/** What to do next when a capture fails, by the stage it failed in (every outcome names its next step). */
export function failureStep(stage, { hasLogin = false, waitFor = null } = {}) {
  switch (stage) {
    case "login":
      return "next: mint a fresh single-use dev-login URL and pass it again as --login (or --login-cmd); the ticket was refused or spent.";
    case "sign-in-form":
      return "next: pass --login <fresh single-use dev-login URL> (or --login-cmd); a ticket works once, so mint a new one for each capture.";
    case "page":
      return hasLogin
        ? "next: check the page URL is right and the app is running (make launch-dashboard-host / the dev server), then re-run."
        : "next: check the page URL is right and the app is running; if the app needs sign-in, pass --login <dev-login URL>.";
    case "ready":
      return waitFor
        ? `next: check that --wait-for ${JSON.stringify(waitFor)} matches an element the app really renders, and that the app is healthy (see the page error lines, if any); then re-run.`
        : "next: the page never became ready; check the app is healthy and not stuck loading, or pass --wait-for <css selector> for the element that proves it is ready, then re-run.";
    default:
      return "next: fix the cause named above, then re-run the capture.";
  }
}
