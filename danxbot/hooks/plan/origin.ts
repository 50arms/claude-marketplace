import { readOrigin } from './load'

// DX-4982: the origin a link to the model's own plan is built on while every read of the plugin's own is refused (no load answered `dashboard_url`).
// In order: what a load or the view knows (a load already falls back to the origin kept in $.store), then `DANXBOT_DASHBOARD_URL` (the user's
// shell or a repo's settings, the same override the MCP launcher honours), then the plugin's configured `dashboard_url` option (the engine passes
// it to `register(on, options)`; the hooks' process never gets the MCP child's `DANXBOT_PLUGIN_DASHBOARD_URL`). null when none is a valid http(s)
// origin: a link is never built on a null one.
export function blockedOrigin(known: { loaded: string | null; view: string | null; env: unknown; option: unknown }): string | null {
  return known.loaded ?? known.view ?? readOrigin(known.env) ?? readOrigin(known.option)
}
