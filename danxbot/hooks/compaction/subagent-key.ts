// DX-5328: the one canonical key for a sub-agent is its transcript file's basename, `agent-<id>` (the key the dashboard's ledger, the compaction handshake's `agents` map
// and the activity reports all use). Claude Code names a sub-agent by the BARE `<id>` everywhere it hands one to this plugin (a hook's `agent_id`, a `session.compact` /
// `turn.step` event's `agentId`, `$.agent.list()` ids, and the target of `$.session.send`). Each place that receives a bare id converts it once, here; each place that
// hands one back converts the other way. Neither direction accepts the other form: a wrong-form id is a bug, so it throws instead of passing through.
export const SUBAGENT_PREFIX = 'agent-'

export function subagentKey(bareId: string): string {
  if (bareId === '' || bareId.startsWith(SUBAGENT_PREFIX)) throw new Error(`expected a bare sub-agent id, got ${JSON.stringify(bareId)}`)
  return `${SUBAGENT_PREFIX}${bareId}`
}

export function bareSubagentId(key: string): string {
  if (!key.startsWith(SUBAGENT_PREFIX) || key.length === SUBAGENT_PREFIX.length) throw new Error(`expected an ${SUBAGENT_PREFIX}<id> sub-agent key, got ${JSON.stringify(key)}`)
  return key.slice(SUBAGENT_PREFIX.length)
}
