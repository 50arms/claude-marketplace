import "./designated-test-container.generated"
// DX-5398: the relay's poll loop never waits on a delivery. A plugin's `$.prompt.submit` settles only when the queued prompt ENTERS the session
// (claude.exe 2.1.299), so behind a running turn (a main agent blocked in a foreground sub-agent) it settled when that turn ended, and the loop
// that awaited it made no poll, no heartbeat and no sub-agent stats for the rest of the turn. The kit's `holdPrompts()` models that engine. The
// events are queued in an outbox and delivered in order; the stored resume cursor moves per DELIVERED event; a loop that makes no step at all
// (a call that never settles) is told to the person and the session and started again.
import { describe, expect } from 'claude-code/testing'

import { BACKOFF_MS, RELAY_STALL_CHECK_MS, RELAY_STALL_MS } from '../hooks/relay/config'
import { stalledNotice } from '../hooks/relay/text'
import { test, SURFACES, answerPlanConnect, dashboard, startSession } from './plan-kit'

const KEY = 'relayCursor:sess-own'
const START = { turnId: 't1' } as any
const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
const STALLED = (t: string) => t.startsWith('Plan events stalled')
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const bandText = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const answer = (body: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false } })
const MCP_PLAN_CONNECT = 'mcp__plugin_danxbot_danx-dashboard__plan_connect'
// what the plugin keeps in $.state for an event it took and has not delivered (the `relayOutbox` atom)
const PENDING = { planId: 23, cursor: 'c1', text: 'digest', urgent: false }
const pendingWrites = (d: any) => d.stateWrites.filter((w: any) => w.key === 'relayOutbox').map((w: any) => w.value)

for (const surface of SURFACES) {
  describe(`the relay outbox on ${surface}`, () => {
    test('a not-urgent event queued behind a running turn does not stop the polls: the next event is taken while the first waits', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      const prompts = d.relay.holdPrompts()
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      expect(prompts.held()).toBe(1)
      expect(d.relay.delivered).toEqual([])
      // the poll went on from the event's cursor at once, and takes the next event
      expect(d.relay.calls.map(c => c.cursor)).toEqual([null, 'c1'])
      d.relay.push({ cursor: 'c2', text: 'another digest' })
      await d.clock.settle()
      expect(d.relay.calls.map(c => c.cursor)).toEqual([null, 'c1', 'c2'])
      expect(prompts.held()).toBe(2)
    })

    test('waits and their heartbeats keep coming through the whole turn while a prompt waits', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.holdMs = 'timeout_ms'
      await startSession($, d, surface)
      await $.turn.start(START)
      d.relay.holdPrompts()
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      const before = d.relay.calls.length
      await d.clock.advance(5 * 60_000)
      // a wait is 20 s: a loop held by the prompt would have made none of these
      expect(d.relay.calls.length - before).toBeGreaterThanOrEqual(10)
      expect(d.relay.calls.at(-1)?.cursor).toBe('c1')
    })

    test('an urgent event behind the waiting prompt still reaches the running turn as a note', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      d.relay.holdPrompts()
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      d.relay.push({ cursor: 'c2', text: 'critical pacing stop', urgent: true })
      await d.clock.settle()
      expect(d.relay.told).toEqual(['[danxbot plan event] critical pacing stop'])
      expect(d.relay.delivered).toEqual([])
      // the note is out; the prompt before it is not delivered, so the stored cursor has not moved past the prompt
      expect(d.stored.get(KEY)).toBeUndefined()
    })

    test('the waiting prompts are delivered exactly once when the turn ends, and the cursor moves then, in order', async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      await startSession($, d, surface)
      await $.turn.start(START)
      const prompts = d.relay.holdPrompts()
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      d.relay.push({ cursor: 'c2', text: 'second digest' })
      await d.clock.settle()
      expect(d.stored.get(KEY)).toBeUndefined()
      await $.turn.complete(TURN)
      prompts.release()
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] digest', '[danxbot plan event] second digest'])
      expect(d.stored.get(KEY)).toMatchObject({ planId: 23, cursor: 'c2' })
      await d.clock.advance(60_000)
      expect(d.relay.delivered).toHaveLength(2)
      expect(d.relay.calls.map(c => c.cursor)).toEqual([null, 'c1', 'c2'])
    })

    // the cursor first, then the atom: a reload between the two repeats the event, where the other order would lose the resume point
    test('a delivered event stores its cursor before the atom drops it', async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      await startSession($, d, surface)
      await $.turn.start(START)
      const prompts = d.relay.holdPrompts()
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      let storedAtAtomWrite: unknown = 'not written'
      d.beforeNextWrite('relayOutbox', async () => {
        storedAtAtomWrite = d.stored.get(KEY)
      })
      await $.turn.complete(TURN)
      prompts.release()
      await d.clock.settle()
      expect(storedAtAtomWrite).toMatchObject({ planId: 23, cursor: 'c1' })
    })

    test('a run that replaces a stalled one while a prompt still waits polls on from the waiting event: the server does not send it again, nothing is delivered twice, and the atom still lists what waits', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      const prompts = d.relay.holdPrompts()
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      // the next wait (after c1) never settles; the stall watch replaces its run
      d.relay.server.script.push(() => new Promise(() => {}))
      d.relay.push({ cursor: 'c2', text: 'second digest' })
      await d.clock.settle()
      const callsBeforeStall = d.relay.calls.length
      await d.clock.advance(2 * RELAY_STALL_MS)
      expect(d.toasts.filter(STALLED)).toHaveLength(1)
      // the replacing run made its own wait (the stuck one never answers), asking after the newest waiting event, not after the stored cursor (still unset, which would hand c1 and c2 over again)
      expect(d.relay.calls.length).toBeGreaterThan(callsBeforeStall)
      expect(d.relay.calls.at(-1)?.cursor).toBe('c2')
      expect(prompts.held()).toBe(2)
      // the restart keeps what its own module still holds, and the atom still lists it
      expect(pendingWrites(d).at(-1)).toEqual([PENDING, { ...PENDING, cursor: 'c2', text: 'second digest' }])
      prompts.release()
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] digest', '[danxbot plan event] second digest'])
      expect(d.stored.get(KEY)).toMatchObject({ cursor: 'c2' })
      expect(pendingWrites(d).at(-1)).toEqual([])
    })

    test('a loop that makes no step (a wait that never settles) is told to the person and the session, and started again', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.script.push(() => new Promise(() => {}))
      await startSession($, d, surface)
      expect(d.relay.calls).toHaveLength(1)
      await d.clock.advance(RELAY_STALL_MS - RELAY_STALL_CHECK_MS)
      expect(d.toasts.filter(STALLED)).toEqual([])
      await d.clock.advance(RELAY_STALL_MS + RELAY_STALL_CHECK_MS)
      const toasts = d.toasts.filter(STALLED)
      expect(toasts).toHaveLength(1)
      expect(toasts[0]).toContain('events were NOT reaching this session')
      expect(d.relay.told).toHaveLength(1)
      expect(d.relay.told[0]).toMatch(/^\[danxbot plan event\] Plan events stalled: the listener made no progress for \d+ s/)
      // the restarted loop waits again, and delivers
      expect(d.relay.calls.length).toBeGreaterThanOrEqual(2)
      d.relay.push({ cursor: 'c1', text: 'after the restart' })
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] after the restart'])
    })

    // The poll presents the newest TAKEN cursor, and the real server drops every record at or below the cursor a call presents (the kit's server does the
    // same: `server.dropped`). So an event the session refused, waiting out the backoff, is held nowhere but by the plugin.
    test('a refused event is kept in $.state while it waits, though the server dropped it at the next poll; it is delivered once, and the copy is cleared', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.rejectPrompts('the session is closing')
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      expect(d.relay.calls.map(c => c.cursor)).toEqual([null, 'c1'])
      expect(d.relay.server.dropped).toBe(1)
      expect(d.relay.server.buffer).toEqual([])
      expect(pendingWrites(d).at(-1)).toEqual([PENDING])
      d.relay.acceptPrompts()
      await d.clock.advance(BACKOFF_MS[0])
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] digest'])
      expect(pendingWrites(d).at(-1)).toEqual([])
      expect(d.stored.get(KEY)).toMatchObject({ planId: 23, cursor: 'c1' })
      await d.clock.advance(60_000)
      expect(d.relay.delivered).toHaveLength(1)
    })

    // The kit has no second module instance. What it models of a reload: the hook module starts empty (a fresh test) and $.state holds what it held
    // (`seedState`, the value asserted above), with a server that has dropped the events (its buffer is empty).
    test('after a reload the events the previous module had taken and not delivered are delivered once, and the first poll goes on from the newest of them', async ($, on) => {
      const d = dashboard(on)
      d.seedState('relayOutbox', [PENDING, { ...PENDING, cursor: 'c2', text: 'second digest' }, { ...PENDING, planId: 99, cursor: 'x1', text: 'another plan' }])
      await startSession($, d, surface)
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] digest', '[danxbot plan event] second digest'])
      expect(d.relay.calls[0]?.cursor).toBe('c2')
      expect(d.stored.get(KEY)).toMatchObject({ planId: 23, cursor: 'c2' })
      expect(pendingWrites(d).at(-1)).toEqual([])
      await d.clock.advance(60_000)
      expect(d.relay.delivered).toHaveLength(2)
    })

    // The wall clock runs while the machine sleeps and no timer does: the first tick after a wake finds a wait that was started long ago and has not answered.
    test('a machine that slept is not a stalled loop: the first tick after the wake is not judged', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.holdMs = 5 * 60_000
      await startSession($, d, surface)
      await d.clock.advance(RELAY_STALL_CHECK_MS)
      d.suspend(10 * 60_000)
      await d.clock.advance(RELAY_STALL_CHECK_MS)
      expect(d.toasts.filter(STALLED)).toEqual([])
      expect(d.relay.told).toEqual([])
      expect(d.relay.server.maxInFlight).toBe(1)
    })

    test('a loop that is stalled after a wake is still reported, counted from the wake', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.script.push(() => new Promise(() => {}))
      await startSession($, d, surface)
      await d.clock.advance(RELAY_STALL_CHECK_MS)
      d.suspend(10 * 60_000)
      await d.clock.advance(RELAY_STALL_CHECK_MS)
      expect(d.toasts.filter(STALLED)).toEqual([])
      await d.clock.advance(RELAY_STALL_MS + 2 * RELAY_STALL_CHECK_MS)
      expect(d.toasts.filter(STALLED)).toHaveLength(1)
    })

    test('a failing event that a move to another plan drops no longer holds the new plan on retrying', async ($, on) => {
      const d = dashboard(on)
      answerPlanConnect(on, d)
      await startSession($, d, surface)
      d.relay.rejectPrompts('the session is closing')
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await bandText(band)).toContain('relay retrying')
      d.relay.acceptPrompts()
      // the new plan's first wait fails, then answers an empty list: a poll that works says the relay is streaming again
      d.relay.server.script.push(() => ({ deny: 'request timed out' }) as any, () => answer({ events: [] }))
      await $.tool.call({ tool: MCP_PLAN_CONNECT, plan_id: 24 } as any)
      await d.clock.settle()
      await d.clock.advance(BACKOFF_MS[0] + 60_000)
      expect(await bandText(band)).not.toContain('relay retrying')
      expect(d.relay.delivered).toEqual([])
    })

    test('a loop that keeps making steps is never reported stalled, however long the session runs', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.holdMs = 'timeout_ms'
      await startSession($, d, surface)
      await d.clock.advance(30 * 60_000)
      expect(d.toasts.filter(STALLED)).toEqual([])
      expect(d.relay.server.maxInFlight).toBe(1)
    })
  })
}

describe('the stalled notice', () => {
  test('says events were not reaching the session and what was done', () => {
    expect(stalledNotice(95)).toMatch(/^Plan events stalled: the listener made no progress for 95 s, so events were NOT reaching this session\./)
  })
})
