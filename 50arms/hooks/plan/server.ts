import { DASHBOARD_SERVERS, serverToolName } from './config'

// Which dashboard MCP server a call that must reach "the" server goes to (the two names are DASHBOARD_SERVERS in config.ts). The session's own tool
// list says: the first name in that order (the plugin's own wins over a second one) that lists the `danxbot_api` tool. Reading the list is
// `liveServer` in register.tsx: the engine follows `$` only into a function of that file.

// The server the tool names show, or null when none of them lists `danxbot_api`.
export function serverOf(toolNames: readonly string[]): string | null {
  return DASHBOARD_SERVERS.find(server => toolNames.includes(serverToolName(server, 'danxbot_api'))) ?? null
}
