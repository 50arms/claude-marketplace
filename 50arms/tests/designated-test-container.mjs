/**
 * DX-5648 - this repo's tests run in ONE place: Linux, inside a container started from Dockerfile.test by
 * scripts/test-in-container.mjs (`npm test`). Never on a Windows checkout, a bare WSL shell or any other host, and never the same
 * suite in two environments (operator, 2026-10-21). Every test file imports this module first, so a file run anywhere else stops
 * before a single test runs, naming the command. scripts/tests/designated-test-container.test.mjs fails the suite when a test file
 * does not import it.
 *
 * The admitting proof is a marker file Dockerfile.test writes as root. The tests run as the non-root `node` user, which cannot
 * create a root-owned file, so no process in a run can admit itself the way an environment variable could be set.
 */
import { statSync } from "node:fs";

export const TEST_CONTAINER_COMMAND = "npm test [-- <test files>]";

/** The file Dockerfile.test writes as root. */
export const TEST_ENVIRONMENT_MARKER = "/etc/claude-plugins/test-environment";

/** Why this host is not the designated test container, or null when it is. */
export function designatedTestContainerRefusal(host) {
  if (host.platform === "linux" && host.markerOwnerUid === 0) return null;
  return [
    "DX-5648: this repo's tests run only inside the designated Linux test container, never on this host.",
    `Run them with \`${TEST_CONTAINER_COMMAND}\`, which builds Dockerfile.test and runs the suite there.`,
    "A test result from anywhere else is not a test result.",
  ].join("\n");
}

/** This process's host: its platform and the owner of the test-environment marker (null when absent). */
export function readTestHost(markerPath = TEST_ENVIRONMENT_MARKER) {
  let markerOwnerUid = null;
  try {
    markerOwnerUid = statSync(markerPath).uid;
  } catch (error) {
    // A missing marker is the answer "not the test container"; any other failure to read it must stop the run, not look like one.
    if (error.code !== "ENOENT") throw error;
  }
  return { platform: process.platform, markerOwnerUid };
}

export function assertDesignatedTestContainer() {
  const refusal = designatedTestContainerRefusal(readTestHost());
  if (refusal !== null) throw new Error(refusal);
}

assertDesignatedTestContainer();
