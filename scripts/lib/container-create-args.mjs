/**
 * CP-2: the `docker create` arguments for a test container. `--rm` makes the Docker daemon remove the container when it stops, so a
 * runner that is killed (SIGKILL, a Windows process-tree kill) and never runs its exit handler still leaves nothing behind.
 */
export function containerCreateArgs(name, image, testFiles) {
  return ["create", "--rm", "--name", name, "--label", "claude-plugins.test-container=1", image, "bash", "scripts/test-container-entry.sh", ...testFiles];
}
