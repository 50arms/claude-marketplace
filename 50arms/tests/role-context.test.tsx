import "./run-tests-with-npm-test.generated"
// CP-76 (PLAN-116 G-8): a signed-in session's role (served by GET /api/plan-sessions/me/role) reaches the model as hook context, not as a file to read: on sign-in,
// at a start, resume and compaction, and at a connect to a plan or a card, once each time; a connect to other work replaces the earlier role.
import { describe, expect } from 'claude-code/testing'

import { roleBlock, roleFailureLine, roleHash, roleOf, roleOwedOnConnect } from '../hooks/context/role'
import { test, EVENT_TEXT, SURFACES, answerPlanConnect, dashboard, firstPrompt, forceRefresh, startSession } from './plan-kit'

const ORCHESTRATOR = { profile: 'orchestrator', text: 'ORCHESTRATOR WORKFLOW: plan the work.' }
const WORK = { profile: 'work', text: 'WORK WORKFLOW: build the card.' }
const CONNECT = 'mcp__plugin_50arms_platform__session_connect'
const API = 'mcp__plugin_50arms_platform__50arms_api'
const PICKUP = { tool: API, method: 'POST', path: '/api/issues/DX-9/transition', body: { action: 'pickup', manual: true } } as any
// the first context entry of a tool result is the time stamp
const told = (r: any): string[] => (r.context ?? []).slice(1)
const joined = (r: { context: string[] }) => r.context.join('\n')

describe('the role text (pure)', () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, body }) as any

  test('a {profile, text} roleInstruction is the role; null is none', () => {
    expect(roleOf(ok({ roleInstruction: WORK }))).toEqual({ kind: 'role', role: WORK })
    expect(roleOf(ok({ roleInstruction: null }))).toEqual({ kind: 'nothing' })
  })

  test('any other shape, and a refusal, is a failure naming why, never none', () => {
    for (const bad of [undefined, 'text', { profile: 'work' }, { profile: '', text: 'x' }, { profile: 'work', text: '' }, { profile: 'work', path: '/tmp/x.md' }]) {
      expect(roleOf(ok({ roleInstruction: bad })).kind).toBe('failed')
    }
    expect(roleOf({ ok: false, status: 500, body: { error: 'boom' } } as any).kind).toBe('failed')
  })

  test('the block names the profile and says it replaces an earlier role only when told so', () => {
    expect(roleBlock(WORK, false)).toBe(`Your role from 50 Arms is the "work" profile, the workflow you work by.\n${WORK.text}`)
    expect(roleBlock(WORK, true)).toContain('It replaces any role text given earlier in this conversation.')
  })

  test('a connect owes a role the conversation does not hold, or that differs', () => {
    const told = { profile: 'work', hash: roleHash(WORK.text) }
    expect(roleOwedOnConnect(null, WORK)).toBe(true)
    expect(roleOwedOnConnect(told, WORK)).toBe(false)
    expect(roleOwedOnConnect(told, ORCHESTRATOR)).toBe(true)
    expect(roleOwedOnConnect(told, { profile: 'work', text: 'changed' })).toBe(true)
  })
})

for (const surface of SURFACES) {
  describe(`the role as hook context on ${surface}`, () => {
    async function started($: any, on: any, options: Parameters<typeof dashboard>[1] = {}, before: (d: any) => void = () => {}) {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.SubagentStart', () => ({}) as any)
      const d = dashboard(on, options)
      before(d)
      await startSession($, d, surface)
      d.roleReads.length = 0
      return d
    }

    for (const [source, event] of [['startup', 'session_start'], ['resume', 'session_resume'], ['compact', 'after_compaction']] as const) {
      test(`a connected session's ${source} is told the ${event} text, then its role, once`, async ($, on) => {
        const d = await started($, on)
        d.world.role = ORCHESTRATOR
        const r = await firstPrompt($, source)
        const told = joined(r)
        expect(told).toContain(EVENT_TEXT(event))
        expect(told).toContain(roleBlock(ORCHESTRATOR, false))
        expect(told.indexOf(EVENT_TEXT(event))).toBeLessThan(told.indexOf(ORCHESTRATOR.text))
        expect(d.roleReads).toHaveLength(1)
        expect(joined({ context: (await $.prompt.submit({ text: 'again' })).context ?? [] })).not.toContain(ORCHESTRATOR.text)
      })
    }

    test('a compaction tells the role again, though the conversation was told it before', async ($, on) => {
      const d = await started($, on)
      d.world.role = ORCHESTRATOR
      expect(joined(await firstPrompt($, 'startup'))).toContain(ORCHESTRATOR.text)
      expect(joined(await firstPrompt($, 'compact'))).toContain(roleBlock(ORCHESTRATOR, false))
    })

    test('a session on neither a plan nor a card has no role: its start is told the event text alone', async ($, on) => {
      const d = await started($, on)
      d.world.role = null
      const r = await firstPrompt($, 'startup')
      expect(r.startLines).toEqual([EVENT_TEXT('session_start')])
    })

    test('a signed-in session on a held card (no plan) is told its work role at start', async ($, on) => {
      const d = await started($, on, { connected: false })
      Object.assign(d.world, { agent: { id: 6, name: 'Tendai', avatar_url: null }, card: { id: 'DX-77', title: 'One-off fix' }, role: WORK })
      const r = await firstPrompt($, 'startup')
      expect(r.startLines).toEqual([`${EVENT_TEXT('session_start')}\n${roleBlock(WORK, false)}`])
    })

    test('a role read that failed is one line naming why, beside the event text', async ($, on) => {
      const d = await started($, on)
      d.world.role = { status: 500 }
      const told = joined(await firstPrompt($, 'startup'))
      expect(told).toContain("Could not load this session's role from 50 Arms")
      expect(told).toContain(EVENT_TEXT('session_start'))
    })

    test('a role that is not {profile, text} (a file path, say) is a failure line, never told as text', async ($, on) => {
      const d = await started($, on)
      d.world.role = { raw: { profile: 'work', path: '/tmp/danx-role/work-1.md', instruction: 'Read this file' } }
      expect(joined(await firstPrompt($, 'startup'))).toContain(roleFailureLine('bad_response: the dashboard answered a roleInstruction that is not {profile, text}'))
    })

    test('a sub-agent is told no role: it takes the sub_agent_start text alone', async ($, on) => {
      const d = await started($, on)
      d.world.role = ORCHESTRATOR
      const r = await $.classic.SubagentStart({ agent_id: 'a1', agent_type: '50arms:worker-sonnet-high' })
      await d.clock.settle()
      expect(r.additionalContext).toEqual([EVENT_TEXT('sub_agent_start')])
      expect(d.roleReads).toEqual([])
    })

    describe('a connect', () => {
      test("to a plan hands the plan's role as context on the connect's own result; the same role is not told twice, another plan's replaces it", async ($, on) => {
        const d = await started($, on, { connected: false }, d => answerPlanConnect(on, d))
        d.world.role = ORCHESTRATOR
        const first: any = await $.tool.call({ tool: CONNECT, target: 'PLAN-23' } as any)
        await d.clock.settle()
        expect(told(first)).toEqual([roleBlock(ORCHESTRATOR, false)])
        const again: any = await $.tool.call({ tool: CONNECT, target: 'PLAN-23' } as any)
        expect(told(again)).toEqual([])
        d.world.role = { profile: 'orchestrator', text: 'ORCHESTRATOR WORKFLOW for another plan.' }
        const moved: any = await $.tool.call({ tool: CONNECT, target: 'PLAN-24' } as any)
        expect(told(moved)).toEqual([roleBlock(d.world.role as any, true)])
      })

      test('to a card, then to a plan, replaces the work role with the orchestrator one', async ($, on) => {
        const d = await started($, on, { connected: false }, d => {
          on('tool.call', { tool: CONNECT }, (_$: any, e: any, next: any) => {
            if (e.target === 'DX-9') return { result: {}, text: JSON.stringify({ ok: true, status: 200, body: { session: { planId: null, cardId: 'DX-9' } } }), isError: false } as any
            return next(e)
          })
          answerPlanConnect(on, d)
        })
        d.world.role = WORK
        const card: any = await $.tool.call({ tool: CONNECT, target: 'DX-9' } as any)
        expect(told(card)).toEqual([roleBlock(WORK, false)])
        d.world.role = ORCHESTRATOR
        const plan: any = await $.tool.call({ tool: CONNECT, target: 'PLAN-23' } as any)
        expect(told(plan)).toEqual([roleBlock(ORCHESTRATOR, true)])
      })

      test('a refused connect hands no role and reads none', async ($, on) => {
        const d = await started($, on, { connected: false }, () => on('tool.call', { tool: CONNECT }, () => ({ result: {}, text: JSON.stringify({ ok: false, status: 409, body: { error: 'card_on_plan' } }), isError: false }) as any))
        d.world.role = ORCHESTRATOR
        const refused: any = await $.tool.call({ tool: CONNECT, target: 'DX-9' } as any)
        expect(told(refused)).toEqual([])
        expect(d.roleReads).toEqual([])
      })

      test('a manual pickup that connected the session hands the card role; one that did not connect hands none', async ($, on) => {
        let connected = false
        const d = await started($, on, { connected: false }, () => on('tool.call', { tool: API }, () => ({ result: {}, text: JSON.stringify({ ok: true, status: 200, body: { issue: { id: 'DX-9' }, connectedByPickup: connected, session: { cardId: 'DX-9' } } }), isError: false }) as any))
        d.world.role = WORK
        const plain: any = await $.tool.call(PICKUP)
        expect(told(plain)).toEqual([])
        connected = true
        const picked: any = await $.tool.call(PICKUP)
        await d.clock.settle()
        expect(told(picked)).toEqual([roleBlock(WORK, false)])
      })
    })

    test('the mantra owed after a sign-in arrives with the role, once', async ($, on) => {
      const d = await started($, on, { signedOut: 'lapsed' })
      d.world.role = ORCHESTRATOR
      await firstPrompt($, 'startup')
      d.world.signedOut = null
      await forceRefresh($, d)
      const told = joined({ context: (await $.prompt.submit({ text: 'next' })).context ?? [] })
      expect(told).toContain(roleBlock(ORCHESTRATOR, false))
      expect(joined({ context: (await $.prompt.submit({ text: 'next' })).context ?? [] })).not.toContain(ORCHESTRATOR.text)
    })
  })
}
