import "./run-tests-with-npm-test.generated"
import { describe, expect } from 'claude-code/testing'

import { BUG_CHECK_ATTEMPTS, SPAWN_CHECK_PATH, bugEvidenceGuard } from '../hooks/plan/bug-evidence-guard'
import type { PacingEnv } from '../hooks/plan/pacing-line'
import { test } from './plan-kit'

const env = (call: (m: string, p: string, b?: any) => Promise<unknown>, toasts: string[] = []): PacingEnv => ({
  now: () => Promise.resolve(0), within: (_ms, work) => work, call: call as PacingEnv['call'], reading: () => Promise.resolve(null), signedIn: () => Promise.resolve(true),
  sleep: () => Promise.resolve(), toast: t => void toasts.push(t), agentModel: () => Promise.resolve(null),
})
const spawn = { prompt: 'work DX-1', subagentType: 'x', description: 'd', tool_use_id: 't', fork: false, parentModel: 'opus', background: false } as any
const run = async (en: PacingEnv) => {
  let started = false
  const r = await bugEvidenceGuard(en)(spawn, async () => { started = true; return { model: 'm', agentId: 'a' } as any })
  return { r, started }
}

describe('bugEvidenceGuard (CP-161)', () => {
  test('a refused check refuses the spawn with the server reason', async () => {
    const { r, started } = await run(env(async () => ({ ok: true, status: 200, body: { allowed: false, refusals: [{ card_id: 'DX-1', reason: 'no_evidence_cited', message: 'DX-1 cites no Evidence record.' }] } })))
    expect(started).toBe(false)
    expect(r.deny).toMatch(/DX-1 cites no Evidence record\./)
  })
  test('an allowed check (and a brief with no Bug card) starts the spawn untouched', async () => {
    let path = ''
    const { started } = await run(env(async (_m, p) => { path = p; return { ok: true, status: 200, body: { allowed: true, refusals: [] } } }))
    expect(started).toBe(true)
    expect(path).toBe(SPAWN_CHECK_PATH)
  })
  test('an unanswerable check is retried within the bound, then refuses loudly', async () => {
    let calls = 0
    const toasts: string[] = []
    const { r, started } = await run(env(async () => { calls++; return { ok: false, status: 500, body: {} } }, toasts))
    expect(calls).toBe(BUG_CHECK_ATTEMPTS)
    expect(started).toBe(false)
    expect(r.deny).toMatch(/answered 500/)
    expect(toasts).toHaveLength(1)
  })
  test('a retry that succeeds starts the spawn', async () => {
    let calls = 0
    const { started } = await run(env(async () => (++calls === 1 ? { ok: false, status: 502, body: {} } : { ok: true, status: 200, body: { allowed: true, refusals: [] } })))
    expect(started).toBe(true)
  })
})
