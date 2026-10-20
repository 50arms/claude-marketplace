import { readOrigin } from './load'

// DX-4982: the origin a link to the model's own plan is built on while every read of the plugin's own is refused (no load answered `dashboard_url`).
// In order: what the load knows (`loadView` already falls back to the origin kept in $.store, and keeps it on every answered load), then
// `DANXBOT_DASHBOARD_URL` (the user's shell or a repo's settings, the same override the MCP launcher honours), then the plugin's configured `dashboard_url` option (the engine passes
// it to `register(on, options)`; the hooks' process never gets the MCP child's `DANXBOT_PLUGIN_DASHBOARD_URL`). null when none is a valid http(s)
// origin: a link is never built on a null one.
export function blockedOrigin(known: { loaded: string | null; env: unknown; option: unknown }): string | null {
  return known.loaded ?? readOrigin(known.env) ?? readOrigin(known.option)
}

// The `dashboard_url` option as the engine passes it to `register(on, options)`: a string, else nothing.
export function optionDashboardUrl(options: unknown): string | undefined {
  const url = (options as { dashboard_url?: unknown } | null | undefined)?.dashboard_url
  return typeof url === 'string' ? url : undefined
}
