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
setInterval(() => {
  if (fs.existsSync(gate)) lay();
}, 25);
