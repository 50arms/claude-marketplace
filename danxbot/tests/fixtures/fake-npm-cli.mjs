// DX-5314: a stand-in for npm's CLI, run by the real detached refresh process through DASHBOARD_MCP_NPM_CLI. `npm install --prefix <stage> ... <spec>`:
// it lays down the package's entry point under <stage>, as a real install does. When FAKE_NPM_GATE names a file, it waits until that file exists first, so a
// test decides when the install may finish (after the launcher that started the refresh has exited).
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const stage = args[args.indexOf("--prefix") + 1];
const gate = process.env.FAKE_NPM_GATE;

function lay() {
  const bin = path.join(stage, "node_modules", "@thehammer", "danx-dashboard-mcp", "dist", "index.js");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `installed ${args.at(-1)}`);
  process.exit(0);
}

if (!gate) lay();
// A test that fails before it opens the gate must not leave this process polling forever: the wait is bounded and ends non-zero.
const deadline = Date.now() + 60_000;
setInterval(() => {
  if (fs.existsSync(gate)) lay();
  if (Date.now() > deadline) {
    process.stderr.write(`fake npm: ${gate} never appeared
`);
    process.exit(1);
  }
}, 25);
