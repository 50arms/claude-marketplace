// DX-4233: a relay that cannot deliver says so: the pane's event line and ONE transcript line (the server's own words), never silence;
// it retries on one bounded backoff, and stops only when the server says it cannot go on. A malformed answer is a failure, not an
// empty list.
import { describe, expect, test } from 'claude-code/testing'

import { BACKOFF_MS } from '../hooks/relay/config'
import { NO_URGENT_DETAIL, NO_URGENT_FIX, OLD_SERVER_FIX } from '../hooks/relay/text'
import { SURFACES, SIGN_IN_HALT, answerPlanConnect, forceRefresh, dashboard, startSession } from './plan-kit'

const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const answer = (body: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false } })
const raw = (t: string, isError = false) => ({ value: { content: [{ type: 'text', text: t }], isError } })

for (const surface of SURFACES) {
  describe(`relay failure on ${surface}`, () => {
    test('a rejected call: the pane says retrying, the session is told once, the loop retries after the first backoff step', async ($, on) => {
      const d = dashboard(on)
      for (let i = 0; i < 3; i++) d.relay.server.script.push(() => ({ deny: 'request timed out after 60000ms' }) as any)
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('relay retrying')
      expect(await text(pane)).toContain('request timed out after 60000ms')
      expect(d.relay.told).toHaveLength(1)
      expect(d.relay.told[0]).toMatch(/^\[danxbot plan event\] events delayed: .*request timed out after 60000ms\. The relay keeps retrying on its own\.$/)
      await d.clock.advance(BACKOFF_MS[0])
      expect(d.relay.calls).toHaveLength(2)
      await d.clock.advance(BACKOFF_MS[1])
      expect(d.relay.calls).toHaveLength(3)
      // the same failure is not told again
      expect(d.relay.told).toHaveLength(1)
    })

    test('the backoff steps 1, 2, 5, 10 s and then stays at 10 s', async ($, on) => {
      const d = dashboard(on)
      for (let i = 0; i < 8; i++) d.relay.server.script.push(() => raw('the dashboard is down', true))
      await startSession($, d, surface)
      const steps = [...BACKOFF_MS, BACKOFF_MS[BACKOFF_MS.length - 1]!]
      expect(Math.max(...BACKOFF_MS)).toBeLessThanOrEqual(10_000)
      let calls = 1
      for (const step of steps) {
        await d.clock.advance(step - 1)
        expect(d.relay.calls).toHaveLength(calls)
        await d.clock.advance(1)
        calls++
        expect(d.relay.calls).toHaveLength(calls)
      }
    })

    test('a wait that works after a failure shows streaming again and tells the next failure afresh', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.script.push(() => ({ deny: 'boom' }) as any)
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      await d.clock.advance(BACKOFF_MS[0])
      // the retry's wait answers (an event arrives): streaming again
      d.relay.push({ cursor: 'c5', text: 'x' })
      await d.clock.settle()
      expect(await text(pane)).not.toContain('relay retrying')
      // a failure after that is told afresh, even with the same words
      d.relay.server.script.push(() => ({ deny: 'boom' }) as any)
      d.relay.push({ cursor: 'c6', text: 'y' })
      await d.clock.settle()
      expect(d.relay.told).toHaveLength(2)
    })

    test("a stop answer shows the server's fix once; neither the clock nor a refresh retries it", async ($, on) => {
      const d = dashboard(on)
      d.relay.server.stopped = { reason: 'relay_failed', detail: 'the relay cannot go on', fix: 'Connect this session to a plan with plan_connect' }
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('relay stopped')
      expect(await text(pane)).toContain('Connect this session to a plan with plan_connect')
      expect(d.relay.told).toEqual([
        '[danxbot plan event] events stopped: events are NOT reaching this session: the relay cannot go on. Fix: Connect this session to a plan with plan_connect.',
      ])
      await d.clock.advance(120_000)
      await forceRefresh($, d)
      expect(d.relay.calls).toHaveLength(1)
    })

    // DX-4721: records with NO urgent flag come from an MCP server older than the release that adds it: nothing will change by retrying, so the
    // relay stops with the remedy (restart the session). A flag that is there and not a boolean is a malformed answer, retried (the loop above).
    test('a record with no urgent flag stops the relay with the restart remedy, told once, never retried', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.script.push(() => answer({ events: [{ cursor: 'c3', text: 'x', urgent: false }, { cursor: 'c4', text: 'y' }] }))
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('relay stopped')
      expect(await text(pane)).toContain(NO_URGENT_FIX)
      expect(d.relay.told).toEqual([
        `[danxbot plan event] events stopped: events are NOT reaching this session: ${NO_URGENT_DETAIL}. Fix: ${NO_URGENT_FIX}.`,
      ])
      expect(d.relay.delivered).toEqual([])
      await d.clock.advance(120_000)
      await forceRefresh($, d)
      expect(d.relay.calls).toHaveLength(1)
    })

    // The pane reads the relay's state as the last run on ANY plan left it: after a move the new run's first write comes after async work,
    // so the pane must not draw a state that belongs to another plan.
    test("the pane draws the relay's retrying state only for the plan it belongs to", async ($, on) => {
      const other = dashboard(on)
      other.seedRelay({ phase: 'retrying', planId: 24, detail: 'left over from plan 24' })
      await startSession($, other, surface)
      const stale = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(stale)).not.toContain('relay retrying')
      expect(await text(stale)).not.toContain('left over from plan 24')
    })

    test("the same retrying state on the connected plan is drawn", async ($, on) => {
      const d = dashboard(on)
      d.seedRelay({ phase: 'retrying', planId: 23, detail: 'this plan failed' })
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('relay retrying')
      expect(await text(pane)).toContain('this plan failed')
    })

    test('a halt is cleared by leaving the plan: the same plan connected again starts a relay of its own', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.stopped = { reason: 'plan_archived', detail: 'archived', fix: 'connect again' }
      await startSession($, d, surface)
      d.relay.server.stopped = undefined
      d.world.planId = null
      await forceRefresh($, d)
      expect(d.relay.calls).toHaveLength(1)
      d.world.planId = 23
      await forceRefresh($, d)
      expect(d.relay.calls.map(c => c.plan_id)).toEqual([23, 23])
    })

    test('a halt from a lost key is cleared by the signed-out view: signing in again restarts the relay', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.script.push(() => raw(SIGN_IN_HALT, true))
      await startSession($, d, surface)
      expect(d.relay.calls).toHaveLength(1)
      d.world.signedOut = 'signed-out'
      await forceRefresh($, d)
      d.world.signedOut = null
      await forceRefresh($, d)
      await d.clock.settle()
      expect(d.relay.calls.map(c => c.plan_id)).toEqual([23, 23])
    })

    test("a reconnect shows no stale 'stopped' state: the new run's first word comes before its own awaits", async ($, on) => {
      const d = dashboard(on)
      d.relay.server.stopped = { reason: 'plan_archived', detail: 'the old stop', fix: 'the old fix' }
      await startSession($, d, surface)
      d.relay.server.stopped = undefined
      d.world.planId = null
      await forceRefresh($, d)
      const release = d.relay.holdStoreKeys()
      d.world.planId = 23
      await forceRefresh($, d)
      const relayWrites = d.stateWrites.filter(w => w.key === 'relay').map((w: any) => w.value)
      expect(relayWrites.at(-1)).toMatchObject({ phase: 'streaming', planId: 23 })
      release()
      await d.clock.settle()
    })

    test('a stale halt on one plan is cleared by a move away and back (23 -> 24 -> 23), with no connect and no sign-in', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.stopped = { reason: 'plan_archived', detail: 'archived', fix: 'connect again' }
      await startSession($, d, surface)
      d.relay.server.stopped = undefined
      await forceRefresh($, d)
      expect(d.relay.calls).toHaveLength(1)
      d.world.planId = 24
      await forceRefresh($, d)
      expect(d.relay.calls.at(-1)).toMatchObject({ plan_id: 24 })
      d.world.planId = 23
      await forceRefresh($, d)
      expect(d.relay.calls.map(c => c.plan_id)).toEqual([23, 24, 23])
    })

    test('a stop belongs to its plan: the session found on another plan (no connect, a refresh) starts a relay of its own', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.stopped = { reason: 'plan_archived', detail: 'archived', fix: 'connect again' }
      await startSession($, d, surface)
      d.relay.server.stopped = undefined
      d.world.planId = 24
      await forceRefresh($, d)
      expect(d.relay.calls.at(-1)).toMatchObject({ plan_id: 24, cursor: null })
    })

    test('a connect after a stop starts it again', async ($, on) => {
      const d = dashboard(on)
      answerPlanConnect(on, d)
      d.relay.server.stopped = { reason: 'plan_archived', detail: 'archived', fix: 'connect again' }
      await startSession($, d, surface)
      d.relay.server.stopped = undefined
      await $.tool.call({ tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect', plan_id: 23 } as any)
      await d.clock.settle()
      expect(d.relay.calls).toHaveLength(2)
    })

    test('a server without the tool names its own fix and stops', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.script.push(() => raw('Unknown tool: plan_events_wait', true))
      await startSession($, d, surface)
      expect(d.relay.told).toHaveLength(1)
      expect(d.relay.told[0]).toContain(`Fix: ${OLD_SERVER_FIX}`)
      await d.clock.advance(60_000)
      await forceRefresh($, d)
      expect(d.relay.calls).toHaveLength(1)
    })

    for (const [name, body] of [
      ['not JSON', 'the dashboard answered html'],
      ['neither events nor stopped', JSON.stringify({ ok: true })],
      ['events that are not a list', JSON.stringify({ events: 'x' })],
      ['an event with an id and no cursor', JSON.stringify({ events: [{ id: 3, text: 'x' }], cursor: 3 })],
      ['an event with a numeric cursor', JSON.stringify({ events: [{ cursor: 3, text: 'x' }] })],
      ['an event with an empty cursor', JSON.stringify({ events: [{ cursor: '', text: 'x' }] })],
      ['an event with a null cursor', JSON.stringify({ events: [{ cursor: null, text: 'x' }] })],
      ['an event with no text', JSON.stringify({ events: [{ cursor: 'c3', urgent: false }] })],
      ['an event with an empty text', JSON.stringify({ events: [{ cursor: 'c3', text: '', urgent: false }] })],
      ['an event whose urgent is a string', JSON.stringify({ events: [{ cursor: 'c3', text: 'x', urgent: 'true' }] })],
      ['an event whose urgent is a number', JSON.stringify({ events: [{ cursor: 'c3', text: 'x', urgent: 1 }] })],
      ['an event whose urgent is null', JSON.stringify({ events: [{ cursor: 'c3', text: 'x', urgent: null }] })],
      ['a good event followed by one whose urgent is a string', JSON.stringify({ events: [{ cursor: 'c3', text: 'x', urgent: false }, { cursor: 'c4', text: 'y', urgent: 'no' }] })],
      ['a stopped record without a fix', JSON.stringify({ stopped: { reason: 'r', detail: 'd' } })],
    ] as const) {
      test(`a malformed answer (${name}) is a loud failure, never an empty list`, async ($, on) => {
        const d = dashboard(on)
        d.relay.server.script.push(() => raw(body))
        await startSession($, d, surface)
        const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
        expect(await text(pane)).toContain('relay retrying')
        expect(d.relay.told).toHaveLength(1)
        expect(d.relay.told[0]).toContain('plan_events_wait answered')
        expect(d.relay.delivered).toEqual([])
      })
    }

    test('a session that lost its key is not told: the band and pane already say so, and the relay stops quietly', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.script.push(() => raw(SIGN_IN_HALT, true))
      await startSession($, d, surface)
      expect(d.relay.told).toEqual([])
      await d.clock.advance(60_000)
      await forceRefresh($, d)
      expect(d.relay.calls).toHaveLength(1)
    })
  })
}
