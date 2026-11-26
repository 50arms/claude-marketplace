import type { AgentSpawnInput, AgentSpawnResult } from 'claude-code'

import { errText } from './load'
import { isSignedOut } from './mcp'
import { PACING_READ_DEADLINE_MS } from './pacing-line'
import type { PacingEnv } from './pacing-line'

// A sub-agent sent to fix a Bug must have a brief citing the Evidence record whose verdict reproduced the failure.
// 50 Arms judges it (POST /api/issues/spawn-check): it reads the card ids and `EV-<n>` refs out of the brief, so a brief naming no Bug card is
// answered `allowed` and passes untouched. The plugin only asks and refuses with the server's own reasons. A check that cannot be answered after
// BUG_CHECK_ATTEMPTS bounded tries REFUSES loudly naming the failure (RULE-21); a signed-out session or a server not connected is left to the slot claim after it, which refuses the same cases loudly.
// It runs INSIDE the pacing guard's `next`, after the slot claim, so a refusal gives the claimed slot back and a server that has not connected is left to the claim's own wait.

export const SPAWN_CHECK_PATH = '/api/issues/spawn-check'
export const BUG_CHECK_ATTEMPTS = 3

type Verdict = { allowed: true } | { allowed: false; reason: string } | { failed: string }

function parseCheck(body: any): Verdict {
  if (body === null || typeof body !== 'object' || typeof body.allowed !== 'boolean' || !Array.isArray(body.refusals)) return { failed: 'the spawn check answer is malformed' }
  if (body.allowed) return { allowed: true }
  const reasons = body.refusals.map((r: any) => (typeof r?.message === 'string' ? r.message : `${r?.card_id ?? 'a Bug card'}: ${r?.reason ?? 'refused'}`))
  return { allowed: false, reason: reasons.length > 0 ? reasons.join(' ') : 'the spawn check refused without a reason' }
}

async function checkOnce(env: PacingEnv, brief: string): Promise<Verdict | 'unchecked'> {
  const r = await env.within(PACING_READ_DEADLINE_MS, env.call('POST', SPAWN_CHECK_PATH, { brief }), () => null)
  if (r === null) return { failed: `the spawn check took longer than its ${PACING_READ_DEADLINE_MS} ms deadline` }
  // a server that has not connected: the spawn's own slot claim waits for it and refuses loudly when it never does, so nothing goes unchecked
  if (r.unreachable || isSignedOut(r)) return 'unchecked'
  if (!r.ok) return { failed: r.status === 0 ? errText(r) : `the spawn check answered ${r.status}` }
  return parseCheck(r.body)
}

export function bugEvidenceGuard(env: PacingEnv) {
  return async (e: AgentSpawnInput, next: (e: AgentSpawnInput) => Promise<AgentSpawnResult>): Promise<AgentSpawnResult> => {
    // a spawn with no brief text names no card
    if (typeof e.prompt !== 'string' || e.prompt.trim() === '') return next(e)
    let failure = ''
    for (let attempt = 0; attempt < BUG_CHECK_ATTEMPTS; attempt++) {
      let v: Verdict | 'unchecked'
      try {
        v = await checkOnce(env, e.prompt)
      } catch (err) {
        v = { failed: err instanceof Error ? err.message : String(err) }
      }
      if (v === 'unchecked' || ('allowed' in v && v.allowed)) return next(e)
      if ('allowed' in v) return { deny: `A sub-agent that fixes a Bug must cite the Evidence record (EV-<n>) whose verdict reproduced the failure. ${v.reason}` }
      failure = v.failed
    }
    env.toast(`The Bug-evidence check could not be made, so the spawn was refused: ${failure}`.slice(0, 260))
    return { deny: `The spawn could not be checked for Bug evidence (${failure}) after ${BUG_CHECK_ATTEMPTS} tries, so it is refused. Try the spawn again shortly.` }
  }
}
