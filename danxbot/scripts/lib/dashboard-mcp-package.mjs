#!/usr/bin/env node
// The ONE pin of `@thehammer/danx-dashboard-mcp` for every npx call this plugin
// makes (DX-3392 problem 1763): the plan event bridge, background-work-report and
// event-hook.sh all run this exact version. `npx -y` never re-checks the registry once
// a version is cached, so an unpinned spec would keep serving whatever this machine
// cached first. Set it to the version the danxbot release publishes.
//
// CLI mode prints the spec with no newline, for bash: `$(node .../dashboard-mcp-package.mjs)`.

import { fileURLToPath } from "node:url";

export const DASHBOARD_MCP_PACKAGE = "@thehammer/danx-dashboard-mcp@0.1.172";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(DASHBOARD_MCP_PACKAGE);
}
