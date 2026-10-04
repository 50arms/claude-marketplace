// DX-4321 — the server process behind fake-registry.mjs: a stand-in for the npm registry's
// `GET /<name>/latest`. It is its OWN process because most tests drive hooks with a
// synchronous spawn, which would block an in-process server and deadlock the request.
//
// Argv: <control-file> <request-log>. The control file (JSON, re-read on every request, so a
// test changes the answer between two session starts) holds `{mode, version, body}`:
//   ok         200 {"version": <version>} — the shape of the real endpoint's answer
//   body       200 with `body` verbatim (a malformed answer)
//   status-500 500
//   hang       accepts the request and never answers
// Every request's path is appended to the request log, one line, before it is answered.
import fs from "node:fs";
import http from "node:http";

const [controlFile, requestLog] = process.argv.slice(2);

const server = http.createServer((req, res) => {
  fs.appendFileSync(requestLog, `${req.url}\n`);
  const control = JSON.parse(fs.readFileSync(controlFile, "utf8"));
  switch (control.mode) {
    case "hang":
      return;
    case "status-500":
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("registry exploded");
      return;
    case "body":
      res.writeHead(200, { "content-type": "application/json" });
      res.end(control.body);
      return;
    default:
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "@thehammer/danx-dashboard-mcp", version: control.version }));
  }
});
server.listen(0, "127.0.0.1", () => process.stdout.write(`${server.address().port}\n`));
