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
