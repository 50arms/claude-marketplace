// DX-5648: the one definition of "a plugin whose hooks/hooks.json declares a non-empty modules array" (native function hooks).
// Used by scripts/publish.sh, scripts/test-container-entry.sh and scripts/tests/designated-test-container.test.mjs.
// CLI: `node scripts/lib/plugins-with-modules.mjs [repoRoot]` prints one plugin directory per line.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The plugin directories (relative to repoRoot, in marketplace order) whose hooks.json declares at least one module. */
export function pluginsWithModules(repoRoot) {
  const marketplace = JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
  return marketplace.plugins
    .map((p) => p.source.replace(/^\.\//, ""))
    .filter((dir) => {
      const hooks = path.join(repoRoot, dir, "hooks", "hooks.json");
      if (!fs.existsSync(hooks)) return false;
      const modules = JSON.parse(fs.readFileSync(hooks, "utf8")).modules;
      return Array.isArray(modules) && modules.length > 0;
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const dir of pluginsWithModules(path.resolve(process.argv[2] ?? "."))) console.log(dir);
}
