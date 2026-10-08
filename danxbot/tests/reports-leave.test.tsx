// DX-4235 (comment 12426): before the session leaves its plan or moves to another, every close the reports owe (a running sub-agent's
// finish, an open background shell's end) is posted first: after the leave the dashboard takes no report from the session, and a row left
// running is the stuck-row bug of comment 10065. Every leave the module takes part in: the pane's Disconnect, its Switch plan + Connect,
// and the model's plan_connect leave or move. Bounded so a dead dashboard never holds the leave; a failure is one toast.
import { describe, expect, test } from 'claude-code/testing'

import { toolName } from '../hooks/plan/config'
import { LEAVE_CLOSE_DEADLINE_MS, agentRow, shellRow } from '../hooks/reports/activity'
import { SURFACES, activityRows, answerReportEvents, dashboard, startSession } from './plan-kit'

const PANE = { component: 'Pane', requestId: 'danx-plan', props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' } } as any
const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
const BACKGROUNDED = { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, text: 'Command running in background with ID: b1' }
const CLOSE = 'report POST /api/plan-sessions/me/activity'
const finishes = (d: any) => activityRows(d).filter(r => r.finishedAt !== null)

for (const surface of SURFACES) {
  describe(`the closes owed before a leave on ${surface}`, () => {
    // A connected session with a running sub-agent and an open background shell. `planConnect` answers the model's own plan_connect
    // (the engine has none of its own in a test) and records where it came in the sequence.
    // `refuse`: the model's plan_connect answers a refusal (`ok: false`) and the session stays where it is.
    async function working($: any, on: any, options: Parameters<typeof dashboard>[1] = {}, refuse = { model: false }) {
      answerReportEvents(on)
      on('tool.call', { tool: 'Bash' }, () => BACKGROUNDED as any)
      const d = dashboard(on, options)
      on('tool.call', { tool: toolName('plan_connect') }, (_$: any, e: any) => {
        d.sequence.push('tool plan_connect')
        if (refuse.model) return { result: {}, text: JSON.stringify({ ok: false, status: 409, body: { error: 'plan_mismatch' } }), isError: false } as any
        if (e.disconnect === true) d.world.planId = null
        else if (typeof e.plan_id === 'number') d.world.planId = e.plan_id
        return { result: {}, text: JSON.stringify({ ok: true, status: 200, body: { session: { plan_id: d.world.planId } } }), isError: false } as any
      })
      await startSession($, d, surface)
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
      await $.tool.call({ tool: 'Bash', command: 'sleep 99', run_in_background: true } as any)
      await d.clock.settle()
      d.sequence.length = 0
      return d
    }
    const pane = ($: any) => $.ui.mount({ plugin: 'danxbot', surface, ...PANE })

    test("the pane's Disconnect posts both closes, in one call, before the leave; nothing is owed after it", async ($, on) => {
      const d = await working($, on)
      const at = d.clock.now()
      await (await pane($)).press({ key: 'disconnect' })
      await d.clock.settle()
      expect(d.sequence).toEqual([CLOSE, 'tool plan_connect'])
      expect(finishes(d)).toEqual([agentRow('agent-a1', null, at, at), shellRow('b1', at, at)])
      await $.turn.complete({ ...TURN, agentId: 'a1' })
      await d.clock.settle()
      expect(finishes(d)).toHaveLength(2)
    })

    test("the pane's Switch plan + Connect to another plan posts the closes before the move", async ($, on) => {
      const d = await working($, on)
      const p = await pane($)
      await p.press({ key: 'switch' })
      await p.select({ key: 'plan-pick', value: '24' })
      await p.press({ key: 'connect' })
      await d.clock.settle()
      expect(d.sequence.slice(0, 2)).toEqual([CLOSE, 'tool plan_connect'])
      expect(finishes(d).map(r => r.activityId)).toEqual(['agent-a1', 'b1'])
    })

    test("the model's plan_connect leave, and its move to another plan, post the closes before the call; a call to the same plan closes nothing", async ($, on) => {
      const d = await working($, on)
      await $.tool.call({ tool: toolName('plan_connect'), plan_id: 23 } as any)
      await d.clock.settle()
      expect(d.sequence).toEqual(['tool plan_connect'])
      await $.tool.call({ tool: toolName('plan_connect'), plan_id: 24 } as any)
      await d.clock.settle()
      expect(d.sequence.slice(1, 3)).toEqual([CLOSE, 'tool plan_connect'])
      expect(finishes(d).map(r => r.activityId)).toEqual(['agent-a1', 'b1'])
    })

    test("the model's plan_connect disconnect posts the closes before the call", async ($, on) => {
      const d = await working($, on)
      await $.tool.call({ tool: toolName('plan_connect'), plan_id: 23, disconnect: true } as any)
      await d.clock.settle()
      expect(d.sequence.slice(0, 2)).toEqual([CLOSE, 'tool plan_connect'])
      expect(finishes(d).map(r => r.activityId)).toEqual(['agent-a1', 'b1'])
    })

    test("a leave the dashboard refuses after the closes went out: one toast says they read as finished; nothing is posted twice", async ($, on) => {
      const d = await working($, on, { disconnect: 'notFound' })
      await (await pane($)).press({ key: 'disconnect' })
      await d.clock.settle()
      expect(d.toasts).toContain("danxbot: leaving PLAN-23 did not happen, but its 2 running activities were already reported finished: the dashboard keeps them finished while they run")
      await $.turn.complete({ ...TURN, agentId: 'a1' })
      await $.classic.Stop({ stop_hook_active: true, background_tasks: [] } as any)
      await d.clock.settle()
      expect(finishes(d).map(r => r.activityId)).toEqual(['agent-a1', 'b1'])
    })

    test('a leave that fails after its closes also failed: the closes are owed again, and each goes out once, later', async ($, on) => {
      const d = await working($, on, { disconnect: 'rejected' })
      d.world.reportReplies['POST /api/plan-sessions/me/activity'] = { status: 500, body: { error: 'activity boom' } }
      await (await pane($)).press({ key: 'disconnect' })
      await d.clock.settle()
      d.world.reportReplies['POST /api/plan-sessions/me/activity'] = {}
      const before = finishes(d).length
      await $.turn.complete({ ...TURN, agentId: 'a1' })
      await $.classic.Stop({ stop_hook_active: true, background_tasks: [] } as any)
      await d.clock.settle()
      expect(finishes(d).slice(before).map(r => r.activityId)).toEqual(['agent-a1', 'b1'])
      await $.turn.complete({ ...TURN, agentId: 'a1' })
      await $.classic.Stop({ stop_hook_active: true, background_tasks: [] } as any)
      await d.clock.settle()
      expect(finishes(d).slice(before)).toHaveLength(2)
    })

    test("the model's plan_connect leave the dashboard refuses: the same toast, and nothing more is posted", async ($, on) => {
      const d = await working($, on, {}, { model: true })
      await $.tool.call({ tool: toolName('plan_connect'), plan_id: 23, disconnect: true } as any)
      await d.clock.settle()
      expect(d.toasts).toContain("danxbot: leaving the plan did not happen, but its 2 running activities were already reported finished: the dashboard keeps them finished while they run")
      await $.turn.complete({ ...TURN, agentId: 'a1' })
      await d.clock.settle()
      expect(finishes(d)).toHaveLength(2)
    })

    for (const args of [{ plan_id: 23, disconnect: true }, { plan_id: 24 }]) {
      test(`a sub-agent's end racing the model's plan_connect ${JSON.stringify(args)} is not posted twice: the memory is cleared before the closes go out`, async ($, on) => {
        const d = await working($, on)
        d.world.reportReplies['POST /api/plan-sessions/me/activity'] = { delayMs: 1_000 }
        const leaving = $.tool.call({ tool: toolName('plan_connect'), ...args } as any)
        await d.clock.settle()
        await $.turn.complete({ ...TURN, agentId: 'a1' })
        await d.clock.advance(1_000)
        await leaving
        await d.clock.settle()
        expect(finishes(d).filter(r => r.activityId === 'agent-a1')).toHaveLength(1)
      })
    }

    test('a leave with nothing owed posts nothing', async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await (await pane($)).press({ key: 'disconnect' })
      await d.clock.settle()
      expect(d.reports).toEqual([])
    })

    test('a close the dashboard refuses is one toast naming what may stay running, and the leave goes on', async ($, on) => {
      const d = await working($, on)
      d.world.reportReplies['POST /api/plan-sessions/me/activity'] = { status: 500, body: { error: 'activity boom' } }
      await (await pane($)).press({ key: 'disconnect' })
      await d.clock.settle()
      expect(d.sequence).toEqual([CLOSE, 'tool plan_connect'])
      expect(d.toasts.filter(t => t.startsWith('danxbot could not close'))).toEqual([
        'danxbot could not close 2 running activities before leaving PLAN-23 (500: activity boom): the dashboard may show them running',
      ])
      expect(d.toasts).toContain('Disconnected from PLAN-23')
    })

    test('a dashboard that does not answer within the deadline never holds the leave: one toast, then the leave', async ($, on) => {
      const d = await working($, on)
      d.world.reportReplies['POST /api/plan-sessions/me/activity'] = { delayMs: LEAVE_CLOSE_DEADLINE_MS * 10 }
      const leaving = (await pane($)).press({ key: 'disconnect' })
      await d.clock.advance(LEAVE_CLOSE_DEADLINE_MS)
      await leaving
      expect(d.sequence).toEqual([CLOSE, 'tool plan_connect'])
      expect(d.toasts.filter(t => t.startsWith('danxbot could not close'))).toEqual([
        `danxbot could not close 2 running activities before leaving PLAN-23 (timeout: no answer within ${LEAVE_CLOSE_DEADLINE_MS / 1000} s): the dashboard may show them running`,
      ])
      expect(d.toasts).toContain('Disconnected from PLAN-23')
    })
  })
}
