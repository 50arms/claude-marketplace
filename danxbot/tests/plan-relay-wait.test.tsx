// DX-4233: the wait loop itself: the arguments of a call, the empty answer of a wait that timed out, the guard against a server that
// answers an empty list at once, the cursor's key following the session id, and a run that ends while it is delivering.
import { describe, expect, test } from 'claude-code/testing'

import { waitArgs } from '../hooks/relay/answer'
import { CURSOR_KEEP, CURSOR_PREFIX, MIN_ROUND_MS, WAIT_MS } from '../hooks/relay/config'
import { toolName } from '../hooks/plan/config'
import { CLOCK_START, SURFACES, answerPlanConnect, dashboard, forceRefresh, startSession, toldModel } from './plan-kit'

const KEY = `${CURSOR_PREFIX}sess-own`
const answer = (body: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false } })
const empty = () => answer({ events: [] })

describe('the arguments of one call', () => {
  test('the plan, the cursor, the wait and the transcript path when one is known', () => {
    expect(waitArgs(23, 'c5', 'C:\\p\\sess.jsonl')).toEqual({ plan_id: 23, cursor: 'c5', timeout_ms: WAIT_MS, transcript_path: 'C:\\p\\sess.jsonl' })
  })

  test('no transcript path: no transcript_path key at all; a first call has a null cursor', () => {
    const args = waitArgs(23, null, null)
    expect(args).toEqual({ plan_id: 23, cursor: null, timeout_ms: WAIT_MS })
    expect('transcript_path' in args).toBe(false)
  })

  test('an opaque cursor goes as it is', () => {
    expect(waitArgs(23, 'opaque/7=', null).cursor).toBe('opaque/7=')
  })
})

for (const surface of SURFACES) {
  describe(`the wait loop on ${surface}`, () => {
    test('a wait that times out answers an empty list; the next call follows at once with the same cursor, and nothing is told', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.holdMs = 'timeout_ms'
      d.stored.set(KEY, { planId: 23, cursor: 'c7', at: 1 })
      await startSession($, d, surface)
      expect(d.relay.calls).toHaveLength(1)
      await d.clock.advance(WAIT_MS)
      expect(d.relay.calls).toHaveLength(2)
      await d.clock.advance(WAIT_MS)
      expect(d.relay.calls.map(c => c.cursor)).toEqual(['c7', 'c7', 'c7'])
      expect(d.relay.delivered).toEqual([])
      expect(d.toasts).toEqual([])
    })

    test('a server that answers an empty list at once cannot make the loop spin: one call per MIN_ROUND_MS', async ($, on) => {
      const d = dashboard(on)
      for (let i = 0; i < 6; i++) d.relay.server.script.push(empty)
      await startSession($, d, surface)
      await d.clock.settle()
      expect(d.relay.calls).toHaveLength(1)
      await d.clock.advance(MIN_ROUND_MS - 1)
      expect(d.relay.calls).toHaveLength(1)
      await d.clock.advance(1)
      expect(d.relay.calls).toHaveLength(2)
      await d.clock.advance(MIN_ROUND_MS)
      expect(d.relay.calls).toHaveLength(3)
    })

    test("a /clear or a resume gives the process another session id: the cursor is kept under the one in use now", async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c5', text: 'before the clear' })
      await d.clock.settle()
      expect(d.stored.get(KEY)).toMatchObject({ cursor: 'c5' })
      d.world.sessionId = 'sess-new'
      d.relay.push({ cursor: 'c6', text: 'after the clear' })
      await d.clock.settle()
      expect(d.stored.get(`${CURSOR_PREFIX}sess-new`)).toMatchObject({ planId: 23, cursor: 'c6' })
      expect(d.stored.get(KEY)).toMatchObject({ cursor: 'c5' })
    })

    test("a run ended while it delivers (a move to another plan) does not overwrite the new run's cursor", async ($, on) => {
      const d = dashboard(on)
      answerPlanConnect(on, d)
      await startSession($, d, surface)
      let moved!: () => void
      const hasMoved = new Promise<void>(resolve => (moved = resolve))
      d.relay.duringPrompt(async () => {
        d.relay.duringPrompt(async () => {})
        try {
          await $.tool.call({ tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect', plan_id: 24 } as any)
          await d.clock.settle()
        } finally {
          moved()
        }
      })
      d.relay.push({ cursor: 'c9', text: 'delivered as the plan moves' }, { cursor: 'c10', text: 'next in the same batch' })
      await hasMoved
      await d.clock.settle()
      // the old run stopped at the end of the move: the rest of its batch is not delivered by it, and the new plan starts clean
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] delivered as the plan moves'])
      expect(d.relay.calls.at(-1)).toMatchObject({ plan_id: 24, cursor: null })
      expect(d.stored.get(KEY)).toBeUndefined()
    })

    test("a stopped answer that arrives AFTER a move to another plan halts nothing, writes no state and tells nothing: a return to the first plan restarts the relay", async ($, on) => {
      const d = dashboard(on)
      answerPlanConnect(on, d)
      let release: () => void = () => {}
      const held = new Promise<void>(resolve => (release = resolve))
      d.relay.server.script.push(async () => (await held, answer({ stopped: { reason: 'plan_archived', detail: 'PLAN-23 is archived', fix: 'connect elsewhere' } })))
      await startSession($, d, surface)
      await $.tool.call({ tool: toolName('plan_connect'), plan_id: 24 } as any)
      await d.clock.settle()
      release()
      await d.clock.settle()
      expect(toldModel(d)).toEqual([])
      expect(d.stateWrites.filter(w => w.key === 'relay').map(w => w.value).at(-1)).toMatchObject({ planId: 24, phase: 'streaming' })
      d.world.planId = 23
      await forceRefresh($, d)
      expect(d.relay.calls.map(c => c.plan_id)).toEqual([23, 24, 23])
    })

    test('a failed refresh (the view in error) does not stop a running relay: the next event still arrives, with no new wait started', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.failList()
      await forceRefresh($, d)
      d.relay.push({ cursor: 'c5', text: 'during the blip' })
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] during the blip'])
      expect(d.relay.calls.map(c => c.cursor)).toEqual([null, 'c5'])
    })

    test("a session-id change keeps the cursor under the id in use now, even when no event arrives", async ($, on) => {
      const d = dashboard(on)
      d.relay.server.holdMs = 'timeout_ms'
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c5', text: 'before the clear' })
      await d.clock.settle()
      d.world.sessionId = 'sess-new'
      await d.clock.advance(WAIT_MS)
      expect(d.stored.get(`${CURSOR_PREFIX}sess-new`)).toMatchObject({ planId: 23, cursor: 'c5' })
    })

    test('leaving a plan and connecting the SAME plan again while the old wait is still pending starts a new relay', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      expect(d.relay.calls).toHaveLength(1)
      d.world.planId = null
      await forceRefresh($, d)
      d.world.planId = 23
      await forceRefresh($, d)
      expect(d.relay.calls.map(c => c.plan_id)).toEqual([23, 23])
    })

    test("pruning the cursors never touches the plugin's other $.store keys, even past CURSOR_KEEP", async ($, on) => {
      const d = dashboard(on)
      for (let i = 0; i < CURSOR_KEEP + 5; i++) d.stored.set(`${CURSOR_PREFIX}old-${i}`, { planId: 23, cursor: 'c1', at: 100 + i })
      d.stored.set('permissionTold', ['aaaa'])
      d.stored.set('dashboardOrigin', 'https://danxbot.example')
      await startSession($, d, surface)
      expect(d.stored.get('permissionTold')).toEqual(['aaaa'])
      expect(d.stored.get('dashboardOrigin')).toBe('https://danxbot.example')
    })

    test("a stored cursor carries the fake clock's now, so pruning keeps the live session's and drops the oldest", async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c5', text: 'live' })
      await d.clock.settle()
      expect(d.stored.get(KEY)).toMatchObject({ cursor: 'c5', at: CLOCK_START })
      for (let i = 0; i < CURSOR_KEEP + 5; i++) d.stored.set(`${CURSOR_PREFIX}old-${i}`, { planId: 23, cursor: 'c1', at: CLOCK_START - 1_000 - i })
      // a new run prunes: leave the plan and come back
      d.world.planId = null
      await forceRefresh($, d)
      d.world.planId = 23
      await forceRefresh($, d)
      await d.clock.settle()
      expect(d.stored.get(KEY)).toMatchObject({ cursor: 'c5' })
      expect([...d.stored.keys()].filter(k => k.startsWith(CURSOR_PREFIX))).toHaveLength(CURSOR_KEEP)
      expect(d.stored.has(`${CURSOR_PREFIX}old-${CURSOR_KEEP + 4}`)).toBe(false)
    })

    test("the real wait call carries the session's transcript path once the session reported it", async ($, on) => {
      const d = dashboard(on)
      on('classic.SessionStart', () => ({}) as any)
      await $.classic.SessionStart({ source: 'startup', session_title: 'PLAN-23', transcript_path: 'C:\p\sess-own.jsonl' } as any)
      await startSession($, d, surface)
      expect(d.relay.calls[0]).toEqual({ plan_id: 23, cursor: null, timeout_ms: WAIT_MS, transcript_path: 'C:\p\sess-own.jsonl' })
    })

    test('the backoff starts over after a success: a failure after a good wait waits the first step again', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.script.push(() => ({ deny: 'boom' }) as any, () => ({ deny: 'boom' }) as any, empty, () => ({ deny: 'boom' }) as any)
      await startSession($, d, surface)
      await d.clock.advance(1_000)
      await d.clock.advance(2_000)
      // the third call answered an empty list at once: the round is padded to MIN_ROUND_MS, then the fourth call fails
      await d.clock.advance(MIN_ROUND_MS)
      expect(d.relay.calls).toHaveLength(4)
      // the fail after the success waits the FIRST step (1 s), not the third (5 s)
      await d.clock.advance(1_000)
      expect(d.relay.calls).toHaveLength(5)
    })

    test('an unexpected error in the loop halts the relay for the plan: shown, told once, not restarted by a refresh', async ($, on) => {
      const d = dashboard(on)
      d.stored.set(KEY, { planId: 23, cursor: 'c1', at: 1 })
      d.relay.failCursorWrites('the store is full')
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c2', text: 'one' })
      await d.clock.settle()
      expect(toldModel(d)).toHaveLength(1)
      expect(toldModel(d)[0]).toContain('the relay hit an error: ')
      expect(toldModel(d)[0]).toContain('the store is full')
      const calls = d.relay.calls.length
      await d.clock.advance(60_000)
      await forceRefresh($, d)
      expect(d.relay.calls).toHaveLength(calls)
    })

    test("a run ended while it delivers leaves the pane's relay state on the NEW plan", async ($, on) => {
      const d = dashboard(on)
      answerPlanConnect(on, d)
      await startSession($, d, surface)
      let moved!: () => void
      const hasMoved = new Promise<void>(resolve => (moved = resolve))
      d.relay.duringPrompt(async () => {
        d.relay.duringPrompt(async () => {})
        try {
          await $.tool.call({ tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect', plan_id: 24 } as any)
          await d.clock.settle()
        } finally {
          moved()
        }
      })
      d.relay.push({ cursor: 'c9', text: 'delivered as the plan moves' }, { cursor: 'c10', text: 'next in the same batch' })
      await hasMoved
      await d.clock.settle()
      const writes = d.stateWrites.filter(w => w.key === 'relay').map(w => w.value)
      expect(writes.at(-1)).toMatchObject({ planId: 24 })
    })

    test('a run ended while its delivery FAILS tells the model nothing about the dead run and leaves its state alone', async ($, on) => {
      const d = dashboard(on)
      answerPlanConnect(on, d)
      await startSession($, d, surface)
      let moved!: () => void
      const hasMoved = new Promise<void>(resolve => (moved = resolve))
      d.relay.duringPrompt(async () => {
        d.relay.duringPrompt(async () => {})
        d.relay.rejectPrompts('busy')
        try {
          await $.tool.call({ tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect', plan_id: 24 } as any)
          await d.clock.settle()
        } finally {
          moved()
        }
      })
      d.relay.push({ cursor: 'c9', text: 'fails as the plan moves' })
      await hasMoved
      await d.clock.settle()
      expect(toldModel(d)).toEqual([])
      expect(d.stateWrites.filter(w => w.key === 'relay').map(w => w.value).at(-1)).toMatchObject({ planId: 24 })
    })
  })
}
