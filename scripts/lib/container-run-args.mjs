/**
 * CP-2: the `docker run` arguments for a test container. Two properties close every leak:
 *  - `--rm`: the Docker daemon removes the container when it stops, whatever happens to the runner (a killed Node process runs no
 *    exit handler).
 *  - `-i` with the source archive on stdin: the container is created and started in ONE call, and its bootstrap unpacks the archive
 *    into /app before the entry script runs. There is no created-but-not-started container (the window a separate `docker create`,
 *    `docker cp`, `docker start` leaves open), so nothing exists that `--rm` would not remove.
 */
export const APP = "/app";

/**
 * CP-3: danxbot's owner record (src/docker-ownership/labels.ts, DX-5841), the same labels danxbot's own scripts/test-in-container.sh stamps.
 * Without them the dev machine's `make sweep-docker` flags a running test container as UNOWNED; with them it removes the container once
 * it has been stopped 60 minutes. `danxbot.session` is attribution only. The image is not labelled: a container inherits its image's
 * labels, so a session label there would misattribute later runs (danxbot's runner leaves its image unlabelled for the same reason).
 */
export function ownerLabelArgs(env) {
  const labels = ["danxbot.kind=test-run", "danxbot.release=idle:60"];
  if (env.CLAUDE_CODE_SESSION_ID) labels.push(`danxbot.session=${env.CLAUDE_CODE_SESSION_ID}`);
  return labels.flatMap((label) => ["--label", label]);
}

export function containerRunArgs(name, image, testFiles, env = process.env) {
  return [
    "run", "--rm", "-i", "--name", name, "--label", "claude-plugins.test-container=1", ...ownerLabelArgs(env), image,
    "bash", "-c", `tar -x -C ${APP} && exec bash scripts/test-container-entry.sh "$@"`, "test-container-bootstrap", ...testFiles,
  ];
}
