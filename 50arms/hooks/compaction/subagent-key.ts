// the one canonical key for a sub-agent is its transcript file's basename, `agent-<id>` (the key the dashboard's ledger, the compaction handshake's `agents` map
// and the activity reports all use). Claude Code names a sub-agent by the BARE `<id>` in the events it hands this plugin (a hook's `agent_id`, a `session.compact` /
// `turn.step` event's `agentId`), and that bare id is converted once, here. A wrong-form id is a bug, so it throws instead of passing through.
export const SUBAGENT_PREFIX = 'agent-'

export function subagentKey(bareId: string): string {
  if (bareId === '' || bareId.startsWith(SUBAGENT_PREFIX)) throw new Error(`expected a bare sub-agent id, got ${JSON.stringify(bareId)}`)
  return `${SUBAGENT_PREFIX}${bareId}`
}
