// DX-5398: the relay's poll loop never waits on a delivery. A plugin's `$.prompt.submit` settles only when the queued prompt ENTERS the session
// (claude.exe 2.1.299), so behind a running turn (a main agent blocked in a foreground sub-agent) it settled when that turn ended, and the loop
// that awaited it made no poll, no heartbeat and no sub-agent stats for the rest of the turn. The kit's `holdPrompts()` models that engine. The
// events are queued in an outbox and delivered in order; the stored resume cursor moves per DELIVERED event; a loop that makes no step at all
// (a call that never settles) is told to the person and the session and started again.
import { describe, expect } from 'claude-code/testing'

import { RELAY_STALL_CHECK_MS, RELAY_STALL_MS } from '../hooks/relay/config'
import { stalledNotice } from '../hooks/relay/text'
import { test, SURFACES, dashboard, startSession } from './plan-kit'

const KEY = 'relayCursor:sess-own'
const START = { turnId: 't1' } as any
const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
const STALLED = (t: string) => t.startsWith('Plan events stalled')

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

    test('a run that replaces a stalled one while a prompt still waits polls on from the waiting event: the server does not send it again, nothing is delivered twice', async ($, on) => {
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
      await d.clock.advance(2 * RELAY_STALL_MS)
      expect(d.toasts.filter(STALLED)).toHaveLength(1)
      // the replacing run asked after the newest waiting event, not after the stored cursor (still unset, which would hand c1 and c2 over again)
      expect(d.relay.calls.at(-1)?.cursor).toBe('c2')
      expect(prompts.held()).toBe(2)
      prompts.release()
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] digest', '[danxbot plan event] second digest'])
      expect(d.stored.get(KEY)).toMatchObject({ cursor: 'c2' })
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
    expect(stalledNotice(95)).toBe('Plan events stalled: the listener made no progress for 95 s, so events were NOT reaching this session. It was started again on its own; if events stay silent, call plan_connect.')
  })
})
