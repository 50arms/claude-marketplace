import "./run-tests-with-npm-test.generated"
// DX-5398: the relay's poll loop never waits on a delivery. A plugin's `$.prompt.submit` settles only when the queued prompt ENTERS the session
// (claude.exe 2.1.299), so behind a running turn (a main agent blocked in a foreground sub-agent) it settled when that turn ended, and the loop
// that awaited it made no poll, no heartbeat and no sub-agent stats for the rest of the turn. The kit's `holdPrompts()` models that engine. The
// events are queued in an outbox and issued in order; the stored resume cursor moves per event the moment `$.prompt.submit` is CALLED for it (DX-5602:
// the engine owns a queued prompt, and the promise that waited on it is lost with a reloaded module, so waiting for the promise re-sent every queued
// event at each reload); a refusal the same module instance sees puts the event back; a loop that makes no step at all
// (a call that never settles) is told to the person and the session and started again.
import { describe, expect } from 'claude-code/testing'

import { BACKOFF_MS, RELAY_STALL_CHECK_MS, RELAY_STALL_MS } from '../hooks/relay/config'
import { fromPending, pollCursor, putBack, toPending } from '../hooks/relay/outbox'
import type { Queued } from '../hooks/relay/outbox'
import { stalledNotice } from '../hooks/relay/text'
import { test, bandSilent, relayPhase, SURFACES, answerPlanConnect, dashboard, startSession } from './plan-kit'

const KEY = 'relayCursor:sess-own'
const START = { turnId: 't1' } as any
const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
const STALLED = (t: string) => t.startsWith('Plan events stalled')
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const answer = (body: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false } })
const MCP_PLAN_CONNECT = 'mcp__plugin_danxbot_danx-dashboard__plan_connect'
// what the plugin keeps in $.state for an event it took and has not delivered (the `relayOutbox` atom)
const PENDING = { planId: 23, cursor: 'c1', text: 'digest', urgent: false }
// DX-5602: an event put back after the session refused it was delivered once at its call, so it carries `again` (issuing it again stores no cursor)
const PUT_BACK = { ...PENDING, again: true }
// the state the 'two events queued' test asserts is left behind (stored resume cursor, atom contents); the reload test starts from this same value
const AFTER_TWO_QUEUED = { stored: { planId: 23, cursor: 'c2' }, atom: [] as unknown[] }
const pendingWrites = (d: any) => d.stateWrites.filter((w: any) => w.key === 'relayOutbox').map((w: any) => w.value)
// the submits of the event texts the plugin made, refused ones included
const tries = (d: any) => d.relay.attempts.filter((a: any) => a.text.includes('digest')).length

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
      // both are out (the prompt is queued in the engine, the note is appended): the stored cursor is at the note
      expect(d.stored.get(KEY)).toMatchObject({ planId: 23, cursor: 'c2' })
    })

    test('the waiting prompts are delivered exactly once when the turn ends; the cursor moved at each call, in order, and nothing moves at the turn end', async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      await startSession($, d, surface)
      await $.turn.start(START)
      const prompts = d.relay.holdPrompts()
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      expect(d.stored.get(KEY)).toMatchObject({ planId: 23, cursor: 'c1' })
      d.relay.push({ cursor: 'c2', text: 'second digest' })
      await d.clock.settle()
      expect(d.stored.get(KEY)).toMatchObject({ planId: 23, cursor: 'c2' })
      await $.turn.complete(TURN)
      prompts.release()
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] digest', '[danxbot plan event] second digest'])
      expect(d.stored.get(KEY)).toMatchObject({ planId: 23, cursor: 'c2' })
      await d.clock.advance(60_000)
      expect(d.relay.delivered).toHaveLength(2)
      expect(d.relay.calls.map(c => c.cursor)).toEqual([null, 'c1', 'c2'])
    })

    // DX-5602: the second submit's promise never settles (a prompt merged into a queued turn, or one whose module reloaded), yet the event is delivered:
    // the engine owns the queued prompt (measured: it survives a hook-module reload), so the cursor and the atom follow the CALL.
    test('two events queued behind a running turn: the stored cursor reaches the second event and the atom is empty while neither promise has settled', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      const prompts = d.relay.holdPrompts()
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      d.relay.push({ cursor: 'c2', text: 'second digest' })
      await d.clock.settle()
      expect(prompts.held()).toBe(2)
      expect(d.relay.delivered).toEqual([])
      expect(d.stored.get(KEY)).toMatchObject(AFTER_TWO_QUEUED.stored)
      expect(pendingWrites(d).at(-1)).toEqual(AFTER_TWO_QUEUED.atom)
    })

    // The kit cannot register a second module instance inside one test (its hooks register once), so the reload starts from the state that the
    // 'two events queued' test above asserts it leaves (the one constant AFTER_TWO_QUEUED, so that test failing is what guards this one). Nothing may be submitted again, and the first poll
    // goes on from the second event.
    test('after a reload that followed two events queued behind a running turn, nothing is submitted again and the first poll goes on from the second event', async ($, on) => {
      const d = dashboard(on)
      d.stored.set(KEY, { ...AFTER_TWO_QUEUED.stored, at: 1 } as any)
      d.seedState('relayOutbox', AFTER_TWO_QUEUED.atom)
      await startSession($, d, surface)
      await d.clock.settle()
      expect(d.relay.calls[0]?.cursor).toBe(AFTER_TWO_QUEUED.stored.cursor)
      expect(d.relay.delivered).toEqual([])
      await d.clock.advance(60_000)
      expect(d.relay.attempts.filter((a: any) => a.text.includes('digest'))).toEqual([])
    })

    // the cursor first, then the atom: a reload between the two repeats the event, where the other order would lose the resume point
    test('a delivered event stores its cursor before the atom drops it', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      d.relay.holdPrompts()
      let storedAtAtomWrite: unknown = 'not written'
      // the first atom write is the copy taken before the poll that acknowledges the event; the second is the drop once the event is delivered
      d.beforeNextWrite('relayOutbox', async () => {
        d.beforeNextWrite('relayOutbox', async () => {
          storedAtAtomWrite = d.stored.get(KEY)
        })
      })
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      expect(storedAtAtomWrite).toMatchObject({ planId: 23, cursor: 'c1' })
    })

    test('a run that replaces a stalled one while prompts still wait in the engine polls on from the stored cursor: the server does not send them again and nothing is delivered twice', async ($, on) => {
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
      // the replacing run made its own wait (the stuck one never answers), asking after the newest event issued (the stored cursor), which would hand c1 and c2 over again if it were unset
      expect(d.relay.calls.length).toBeGreaterThan(callsBeforeStall)
      expect(d.relay.calls.at(-1)?.cursor).toBe('c2')
      expect(prompts.held()).toBe(2)
      // both were issued, so the atom lists nothing and the store holds c2
      expect(pendingWrites(d).at(-1)).toEqual([])
      expect(d.stored.get(KEY)).toMatchObject({ cursor: 'c2' })
      prompts.release()
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] digest', '[danxbot plan event] second digest'])
      expect(d.stored.get(KEY)).toMatchObject({ cursor: 'c2' })
      expect(pendingWrites(d).at(-1)).toEqual([])
    })

    // A put-back event was delivered at its first call, so its cursor is older than the stored one: a run that replaces this one while the event waits out
    // its backoff would poll from it and the server would hand later events over again.
    test('c1 refused and c2 queued behind it, then the stall watch replaces the run while c1 waits: its first poll carries c2, not the put-back c1, and nothing is delivered twice, in order', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.rejectPrompts('busy')
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      // the wait after c2 never settles; the stall watch replaces its run. c2 is not issued ahead of the put-back c1.
      d.relay.server.script.push(() => new Promise(() => {}))
      d.relay.push({ cursor: 'c2', text: 'second digest' })
      await d.clock.settle()
      expect(d.stored.get(KEY)).toMatchObject({ planId: 23, cursor: 'c1' })
      const polled = d.relay.calls.length
      await d.clock.advance(2 * RELAY_STALL_MS)
      expect(d.toasts.filter(STALLED)).toHaveLength(1)
      expect(pendingWrites(d).at(-1)).toEqual([expect.objectContaining({ cursor: 'c1', again: true }), expect.objectContaining({ cursor: 'c2' })])
      expect(d.relay.calls.length).toBeGreaterThan(polled)
      expect(d.relay.calls.slice(polled).map(c => c.cursor)).not.toContain('c1')
      expect(d.relay.calls.at(-1)?.cursor).toBe('c2')
      d.relay.acceptPrompts()
      await d.clock.advance(BACKOFF_MS[BACKOFF_MS.length - 1])
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] digest', '[danxbot plan event] second digest'])
      expect(d.stored.get(KEY)).toMatchObject({ planId: 23, cursor: 'c2' })
      await d.clock.advance(60_000)
      expect(d.relay.delivered).toHaveLength(2)
    })

    test('an event behind a put-back head is not issued while the head waits out its backoff', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.rejectPrompts('busy')
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      d.relay.acceptPrompts()
      d.relay.push({ cursor: 'c2', text: 'second digest' })
      await d.clock.settle()
      await d.clock.advance(BACKOFF_MS[0] - 1)
      expect(d.relay.delivered).toEqual([])
      await d.clock.advance(1)
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] digest', '[danxbot plan event] second digest'])
    })

    test('a put-back never moves the stored cursor back: c1 refused, c2 behind it; c1 issued again goes first, c2 follows and is refused too, then both are delivered in order with the cursor at c2', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.rejectPrompts('busy')
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      d.relay.push({ cursor: 'c2', text: 'second digest' })
      await d.clock.settle()
      // c2 waits behind the put-back c1: nothing but c1 moves the cursor so far
      expect(d.stored.get(KEY)).toMatchObject({ planId: 23, cursor: 'c1' })
      // c1 is issued again (and refused again), c2 right after it: both are put back, the stored cursor is c2 and stays there
      await d.clock.advance(BACKOFF_MS[0])
      expect(d.stored.get(KEY)).toMatchObject({ planId: 23, cursor: 'c2' })
      expect(d.relay.delivered).toEqual([])
      d.relay.acceptPrompts()
      await d.clock.advance(BACKOFF_MS[BACKOFF_MS.length - 1])
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] digest', '[danxbot plan event] second digest'])
      expect(d.stored.get(KEY)).toMatchObject({ planId: 23, cursor: 'c2' })
    })

    test('c1 and c2 are both called, c2 is refused first and c1 after it: both go back in the original order and are delivered c1 then c2', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.rejectPrompts('busy')
      // c1's call is held inside the engine until released, so c2's call (made while c1's has not settled) settles and is refused first
      let calls = 0
      let releaseC1!: () => void
      const c1Gate = new Promise<void>(resolve => (releaseC1 = resolve))
      d.relay.duringPrompt(async () => {
        if (++calls === 1) await c1Gate
      })
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      d.relay.push({ cursor: 'c2', text: 'second digest' })
      await d.clock.settle()
      expect(d.relay.attempts.map(a => a.text)).toEqual(['[danxbot plan event] digest', '[danxbot plan event] second digest'])
      releaseC1()
      await d.clock.settle()
      d.relay.acceptPrompts()
      await d.clock.advance(BACKOFF_MS[BACKOFF_MS.length - 1])
      // bounded: a regression that issues in a wrong order or loops fails here by name rather than hanging
      expect(d.relay.attempts.map(a => a.text)).toEqual([
        '[danxbot plan event] digest',
        '[danxbot plan event] second digest',
        '[danxbot plan event] digest',
        '[danxbot plan event] second digest',
      ])
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] digest', '[danxbot plan event] second digest'])
    })

    test('after a reload the put-back event the atom kept is issued once, the stored cursor stays at c2, and the first poll carries c2', async ($, on) => {
      const d = dashboard(on)
      d.stored.set(KEY, { planId: 23, cursor: 'c2', at: 1 })
      d.seedState('relayOutbox', [PUT_BACK])
      await startSession($, d, surface)
      await d.clock.settle()
      expect(d.relay.calls[0]?.cursor).toBe('c2')
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] digest'])
      expect(d.stored.get(KEY)).toMatchObject({ planId: 23, cursor: 'c2' })
      expect(pendingWrites(d).at(-1)).toEqual([])
    })

    test('a refusal that repeats waits longer each time, and a delivery that works starts the waits again from the first', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.rejectPrompts('busy')
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      // the first re-issue after BACKOFF_MS[0] is refused again: the second wait is BACKOFF_MS[1]
      await d.clock.advance(BACKOFF_MS[0])
      d.relay.acceptPrompts()
      await d.clock.advance(BACKOFF_MS[1] - 1)
      expect(d.relay.delivered).toEqual([])
      await d.clock.advance(1)
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] digest'])
      // delivered: the next refusal waits BACKOFF_MS[0] again
      d.relay.rejectPrompts('busy')
      d.relay.push({ cursor: 'c2', text: 'second digest' })
      await d.clock.settle()
      d.relay.acceptPrompts()
      await d.clock.advance(BACKOFF_MS[0])
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] digest', '[danxbot plan event] second digest'])
    })

    test('a late success does not clear the retrying state while another event is still put back', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.rejectPrompts('busy')
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      d.relay.acceptPrompts()
      d.relay.push({ cursor: 'c2', text: 'second digest' })
      await d.clock.settle()
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(relayPhase(d)).toBe('retrying')
      await bandSilent(band)
      await d.clock.advance(BACKOFF_MS[0])
      expect(d.relay.delivered).toHaveLength(2)
      expect(relayPhase(d)).not.toBe('retrying')
      await bandSilent(band)
    })

    // nb3: the note is in the turn once it is appended, so a bookkeeping failure after that is a toast: the event is neither put back nor appended again
    test('a note appended whose turn bookkeeping throws is delivered once: the failure is toasted, and nothing is put back or appended again', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      d.refuseNextWrite('turn')
      d.relay.push({ cursor: 'c1', text: 'critical pacing stop', urgent: true })
      await d.clock.settle()
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(d.toasts.filter((t: string) => t.startsWith('Plan event delivered'))).toHaveLength(1)
      expect(d.relay.told).toEqual(['[danxbot plan event] critical pacing stop'])
      expect(pendingWrites(d).at(-1)).toEqual([])
      expect(relayPhase(d)).not.toBe('retrying')
      await bandSilent(band)
      await d.clock.advance(BACKOFF_MS[0])
      expect(d.relay.told).toHaveLength(1)
      expect(d.relay.delivered).toEqual([])
    })

    // nb4: a re-issued put-back whose submit never settles (the engine holds it) does not leave the relay on 'retrying': its call is the delivery
    test('a re-issued put-back whose submit never settles does not leave the relay retrying', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.rejectPrompts('busy')
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(relayPhase(d)).toBe('retrying')
      await bandSilent(band)
      d.relay.acceptPrompts()
      const prompts = d.relay.holdPrompts()
      await d.clock.advance(BACKOFF_MS[0])
      expect(prompts.held()).toBe(1)
      expect(relayPhase(d)).not.toBe('retrying')
      await bandSilent(band)
      prompts.release()
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] digest'])
      expect(pendingWrites(d).at(-1)).toEqual([])
    })

    // nb6: a plan move starts the refusal backoff afresh: the old plan's two refusals do not lengthen the new plan's first wait
    test('a plan move starts the refusal backoff afresh: a refused event on the new plan waits the first backoff step', async ($, on) => {
      const d = dashboard(on)
      answerPlanConnect(on, d)
      await startSession($, d, surface)
      d.relay.rejectPrompts('busy')
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      // the re-issue after the first step is refused again: the old plan has two refusals in a row
      await d.clock.advance(BACKOFF_MS[0])
      expect(tries(d)).toBe(2)
      await $.tool.call({ tool: MCP_PLAN_CONNECT, plan_id: 24 } as any)
      await d.clock.settle()
      d.relay.push({ cursor: 'd1', text: 'plan 24 digest' })
      await d.clock.settle()
      expect(tries(d)).toBe(3)
      // refused once on the new plan: its first wait is BACKOFF_MS[0], so it is issued again at that step and not later
      await d.clock.advance(BACKOFF_MS[0])
      expect(tries(d)).toBe(4)
      d.relay.acceptPrompts()
      await d.clock.advance(BACKOFF_MS[1] + 60_000)
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] plan 24 digest'])
    })

    // n31: a stall restart keeps the put-back events held. A restart that swapped them for unheld copies would submit them at the moment the stall is judged,
    // before their backoff ends; the judged moment must see no submit.
    test('a stall restart keeps the put-back events held: none is submitted at the moment the stall is judged', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.rejectPrompts('busy')
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      // the wait after c2 never settles, so the loop makes no step and the stall watch replaces its run while c1 and c2 are put back
      d.relay.server.script.push(() => new Promise(() => {}))
      d.relay.push({ cursor: 'c2', text: 'second digest' })
      await d.clock.settle()
      const submitsBefore = tries(d)
      for (let i = 0; i < 10 && d.toasts.filter(STALLED).length === 0; i++) await d.clock.advance(RELAY_STALL_CHECK_MS)
      expect(d.toasts.filter(STALLED)).toHaveLength(1)
      const judgedAt = d.clock.now()
      expect(d.relay.attempts.filter((a: any) => a.at === judgedAt)).toEqual([])
      expect(tries(d)).toBeGreaterThan(submitsBefore)
      d.relay.acceptPrompts()
      await d.clock.advance(BACKOFF_MS[BACKOFF_MS.length - 1])
      // both delivered once, in the order they were taken
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] digest', '[danxbot plan event] second digest'])
      expect(d.stored.get(KEY)).toMatchObject({ planId: 23, cursor: 'c2' })
    })

    test('a refusal that reaches a module whose plan has moved on puts nothing back and leaves no retrying state behind', async ($, on) => {
      const d = dashboard(on)
      answerPlanConnect(on, d)
      await startSession($, d, surface)
      await $.turn.start(START)
      const prompts = d.relay.holdPrompts()
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      expect(prompts.held()).toBe(1)
      d.relay.server.script.push(() => answer({ events: [] }))
      await $.tool.call({ tool: MCP_PLAN_CONNECT, plan_id: 24 } as any)
      await d.clock.settle()
      // the engine refuses the prompt the old plan's event was handed over as, after the move
      d.relay.rejectPrompts('the session is closing')
      prompts.release()
      await d.clock.advance(BACKOFF_MS[0])
      expect(pendingWrites(d).at(-1)).toEqual([])
      expect(relayPhase(d)).not.toBe('retrying')
      await bandSilent(await $.ui.mount({ plugin: 'danxbot', surface, ...BAND }))
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
      expect(pendingWrites(d).at(-1)).toEqual([PUT_BACK])
      d.relay.acceptPrompts()
      await d.clock.advance(BACKOFF_MS[0])
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] digest'])
      expect(pendingWrites(d).at(-1)).toEqual([])
      expect(d.stored.get(KEY)).toMatchObject({ planId: 23, cursor: 'c1' })
      await d.clock.advance(60_000)
      expect(d.relay.delivered).toHaveLength(1)
    })

    // DX-5602: delivered at the call, but the instance that made the call still sees how it ends: a `drop` puts the event back and issues it again.
    test('a prompt the engine drops is put back and issued again by the same module: the cursor stays where it is, and the event is delivered once', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.dropPrompts('busy')
      d.relay.push({ cursor: 'c1', text: 'digest' })
      await d.clock.settle()
      // delivered at the call (cursor moved), then the drop put it back in the atom
      expect(d.stored.get(KEY)).toMatchObject({ planId: 23, cursor: 'c1' })
      expect(pendingWrites(d).at(-1)).toEqual([PUT_BACK])
      expect(d.relay.delivered).toEqual([])
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
      expect(relayPhase(d)).toBe('retrying')
      await bandSilent(band)
      d.relay.acceptPrompts()
      // the new plan's first wait fails, then answers an empty list: a poll that works says the relay is streaming again
      d.relay.server.script.push(() => ({ deny: 'request timed out' }) as any, () => answer({ events: [] }))
      await $.tool.call({ tool: MCP_PLAN_CONNECT, plan_id: 24 } as any)
      await d.clock.settle()
      await d.clock.advance(BACKOFF_MS[0] + 60_000)
      expect(relayPhase(d)).not.toBe('retrying')
      await bandSilent(band)
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

describe('the outbox helpers', () => {
  const q = (cursor: string, again = false, planId: number | null = 23, seq = Number(cursor.slice(1))): Queued => ({ planId, seq, event: { cursor, text: cursor, urgent: false }, held: false, ...(again ? { again: true as const } : {}) })

  test('pollCursor goes on from the newest event not yet delivered, else the stored cursor, never from a put-back', () => {
    expect(pollCursor([q('c1'), q('c2')], 23, 'c0')).toBe('c2')
    expect(pollCursor([q('c1', true)], 23, 'c2')).toBe('c2')
    expect(pollCursor([q('c1', true), q('c3')], 23, 'c2')).toBe('c3')
    expect(pollCursor([q('x1', false, 99)], 23, 'c2')).toBe('c2')
    expect(pollCursor([], 23, null)).toBeNull()
  })

  test('putBack returns an event to its place in the original order, whatever order the refusals came in', () => {
    const outbox = [q('c3'), q('c4')]
    putBack(outbox, q('c2', true))
    putBack(outbox, q('c1', true))
    expect(outbox.map(x => x.event.cursor)).toEqual(['c1', 'c2', 'c3', 'c4'])
    const only: Queued[] = [q('c2', true)]
    putBack(only, q('c1', true))
    putBack(only, q('c5', true))
    expect(only.map(x => x.event.cursor)).toEqual(['c1', 'c2', 'c5'])
  })

  test('the atom keeps `again` across a reload and drops another plan\'s events', () => {
    const pending = toPending([q('c1', true), q('c2'), q('x1', false, 99)])
    expect(pending.map(p => p.again)).toEqual([true, undefined, undefined])
    const back = fromPending(pending, 23, 7)
    expect(back.map(x => [x.event.cursor, x.again, x.seq])).toEqual([['c1', true, 7], ['c2', undefined, 8]])
    expect(back.every(x => !x.held)).toBe(true)
  })
})
