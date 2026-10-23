/**
 * CP-2: the `docker run` arguments for a test container. Two properties close every leak:
 *  - `--rm`: the Docker daemon removes the container when it stops, whatever happens to the runner (a killed Node process runs no
 *    exit handler).
 *  - `-i` with the source archive on stdin: the container is created and started in ONE call, and its bootstrap unpacks the archive
 *    into /app before the entry script runs. There is no created-but-not-started container (the window a separate `docker create`,
 *    `docker cp`, `docker start` leaves open), so nothing exists that `--rm` would not remove.
 */
export const APP = "/app";

export function containerRunArgs(name, image, testFiles) {
  return [
    "run", "--rm", "-i", "--name", name, "--label", "claude-plugins.test-container=1", image,
    "bash", "-c", `tar -x -C ${APP} && exec bash scripts/test-container-entry.sh "$@"`, "test-container-bootstrap", ...testFiles,
  ];
}
