// DX-4233 / DX-4721: how a relayed event reaches the session. One decision (relay/delivery.ts), made on the server's `urgent` flag and one turn
// fact (is a turn running now): a not-urgent event is ALWAYS a submitted prompt (it waits behind a running turn and wakes an idle session); an
// urgent event is a note ($.session.append) in a running turn and a prompt when none runs. `claude plugin test` has no seam that lets the
// plugin's own $.session.append succeed, so a note shows as the attempt: a refused note is a failed delivery (told once, the cursor does not
// move, the next wait asks again), never a quiet prompt. What a successful note does is proved on a live session (the E2E items).
import { describe, expect, test } from 'claude-code/testing'

import { IDLE, deliveryMode, noteAppended, relayLine, repeatLine, toolResultSent, turnEnded, turnStarted } from '../hooks/relay/delivery'
import { SURFACES, dashboard, startSession, toldModel } from './plan-kit'

const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
const START = { turnId: 't1' } as any

// whether the plugin holds the main loop's turn as running, read from its writes
const turnOf = (d: any) => d.stateWrites.filter((w: any) => w.key === 'turn').at(-1)?.value
const runningOf = (d: any) => turnOf(d)?.isRunning

describe('the delivery decision', () => {
  test('only an urgent event in a running turn is a note; everything else is a prompt', () => {
    expect(deliveryMode(true, true)).toBe('note')
    expect(deliveryMode(true, false)).toBe('prompt')
    expect(deliveryMode(false, true)).toBe('prompt')
    expect(deliveryMode(false, false)).toBe('prompt')
  })

  test('the event text is the marker, a space and the text, unchanged', () => {
    expect(relayLine('operator commented on problem 3')).toBe('[danxbot plan event] operator commented on problem 3')
    expect(repeatLine('key revoked')).toBe('[danxbot plan event] (repeat of an urgent note already added to this conversation) key revoked')
  })
})

describe('the notes a turn did not read', () => {
  test('a note appended in a running turn is pending, with no prompt', () => {
    expect(noteAppended(turnStarted(), 'a')).toEqual({ turn: { isRunning: true, pending: ['a'] }, prompt: null })
  })

  test('a note appended after the turn ended (turn.complete landed between the decision and the append) is a prompt at once, not pending', () => {
    expect(noteAppended(IDLE, 'raced')).toEqual({ turn: IDLE, prompt: 'raced' })
  })

  test('a main-loop tool result reads every pending note; with none pending it hands back the very same state', () => {
    expect(toolResultSent(noteAppended(turnStarted(), 'a').turn)).toEqual(turnStarted())
    const t = turnStarted()
    expect(toolResultSent(t)).toBe(t)
  })

  test('the turn ends: pending notes are prompts, in order, once; none after a tool result; none after an abort', () => {
    let t = noteAppended(turnStarted(), 'one').turn
    t = noteAppended(t, 'two').turn
    expect(turnEnded(t, false)).toEqual({ turn: IDLE, prompts: ['one', 'two'] })
    expect(turnEnded(toolResultSent(t), false)).toEqual({ turn: IDLE, prompts: [] })
    expect(turnEnded(t, true)).toEqual({ turn: IDLE, prompts: [] })
  })

  test('the transitions never change what they are given', () => {
    const t = { isRunning: true, pending: ['a'] }
    noteAppended(t, 'b')
    toolResultSent(t)
    turnEnded(t, false)
    expect(t).toEqual({ isRunning: true, pending: ['a'] })
  })
})

for (const surface of SURFACES) {
  describe(`delivery on ${surface}`, () => {
    test('an idle session gets a submitted prompt, which wakes it', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c5', text: 'operator commented on problem 3' })
      await d.clock.settle()
      expect(d.relay.delivered).toEqual([{ text: '[danxbot plan event] operator commented on problem 3' }])
    })

    test('a not-urgent event during a running turn is one prompt (queued behind the turn by the engine), never a note', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      expect(runningOf(d)).toBe(true)
      d.relay.push({ cursor: 'c5', text: 'a comment during the turn' })
      await d.clock.settle()
      expect(d.relay.delivered).toEqual([{ text: '[danxbot plan event] a comment during the turn' }])
      expect(toldModel(d)).toEqual([])
      expect(d.stored.get('relayCursor:sess-own')).toMatchObject({ cursor: 'c5' })
    })

    // The kit's missing append: the engine rejects the plugin's own $.session.append, so what is observable is that a running turn gets a note
    // attempt (never a prompt), and that a refused note is a failed delivery: told once, the cursor does not move, the next wait asks again.
    test('an urgent event during a running turn is one note and no prompt; a refused note is a failed delivery', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      d.relay.push({ cursor: 'c5', text: 'critical pacing stop', urgent: true })
      await d.clock.settle()
      expect(toldModel(d)).toHaveLength(1)
      expect(toldModel(d)[0]).toContain('the session did not take the event')
      expect(d.stored.get('relayCursor:sess-own')).toBeUndefined()
      await d.clock.advance(1_000)
      expect(d.relay.calls.at(-1)?.cursor).toBeNull()
      expect(d.relay.delivered).toEqual([])
    })

    test('an urgent event while idle is a prompt', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c5', text: 'key revoked', urgent: true })
      await d.clock.settle()
      expect(d.relay.delivered).toEqual([{ text: '[danxbot plan event] key revoked' }])
      expect(toldModel(d)).toEqual([])
    })

    test('turn.complete ends the turn: an urgent event is a prompt again', async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      await startSession($, d, surface)
      await $.turn.start(START)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(runningOf(d)).toBe(false)
      d.relay.push({ cursor: 'c5', text: 'after the turn', urgent: true })
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] after the turn'])
    })

    // The kit cannot take the plugin's own append, so the state a successful note leaves (pending) is seeded on the turn's start.
    test('an urgent note appended after the last tool result is told once as a prompt when the turn ends', async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      d.seedPending(['critical pacing stop'])
      await startSession($, d, surface)
      await $.turn.start(START)
      expect(turnOf(d)).toEqual({ isRunning: true, pending: ['critical pacing stop'] })
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.relay.delivered).toEqual([{ text: repeatLine('critical pacing stop') }])
      expect(turnOf(d)).toEqual({ isRunning: false, pending: [] })
      // not told again by the next turn's end
      await $.turn.start(START)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.relay.delivered).toHaveLength(1)
    })

    test('an urgent note followed by a main-loop tool result is read: not told again when the turn ends', async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      on('tool.call', () => ({ result: { ok: true }, text: 'done' }) as any)
      d.seedPending(['critical pacing stop'])
      await startSession($, d, surface)
      await $.turn.start(START)
      await $.tool.call({ tool: 'Bash', command: 'echo hi' } as any)
      expect(turnOf(d)).toEqual({ isRunning: true, pending: [] })
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.relay.delivered).toEqual([])
    })

    test("a sub-agent's tool result does not read the main loop's notes", async ($, on) => {
      const d = dashboard(on)
      on('tool.call', () => ({ result: { ok: true }, text: 'done' }) as any)
      d.seedPending(['critical pacing stop'])
      await startSession($, d, surface)
      await $.turn.start(START)
      await $.tool.call({ tool: 'Bash', command: 'echo hi', agentId: 'agent-1' } as any)
      expect(turnOf(d)).toEqual({ isRunning: true, pending: ['critical pacing stop'] })
    })

    test('two pending notes are each told once, in order', async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      d.seedPending(['first stop', 'second stop'])
      await startSession($, d, surface)
      await $.turn.start(START)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.relay.delivered).toEqual([{ text: repeatLine('first stop') }, { text: repeatLine('second stop') }])
      expect(turnOf(d)).toEqual({ isRunning: false, pending: [] })
    })

    test('a note the session refuses is a toast, and the next note is still tried', async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      d.seedPending(['first stop', 'second stop'])
      let attempts = 0
      await startSession($, d, surface)
      await $.turn.start(START)
      d.relay.duringPrompt(async () => void attempts++)
      d.relay.dropPrompts('busy')
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(attempts).toBe(2)
      expect(d.toasts.filter(t => t.startsWith('Plan events not told to the session: the session did not take the event: busy'))).toHaveLength(2)
      expect(turnOf(d)).toEqual({ isRunning: false, pending: [] })
    })

    test('an aborted turn tells no pending note as a prompt', async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      d.seedPending(['critical pacing stop'])
      await startSession($, d, surface)
      await $.turn.start(START)
      await $.turn.complete({ ...TURN, reason: 'aborted', isAborted: true })
      await d.clock.settle()
      expect(d.relay.delivered).toEqual([])
      expect(turnOf(d)).toEqual({ isRunning: false, pending: [] })
    })

    test("a sub-agent's turn.complete does not end the main loop's turn", async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      await startSession($, d, surface)
      await $.turn.start(START)
      await $.turn.complete({ ...TURN, agentId: 'agent-1' })
      await d.clock.settle()
      expect(runningOf(d)).toBe(true)
    })

    test('a burst of not-urgent events pushed during a turn and after it arrives in order with none lost', async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      await startSession($, d, surface)
      await $.turn.start(START)
      d.relay.push({ cursor: 'c5', text: 'one' })
      await d.clock.settle()
      await $.turn.complete(TURN)
      d.relay.push({ cursor: 'c6', text: 'two' }, { cursor: 'c7', text: 'three' }, { cursor: 'c8', text: 'four' })
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] one', '[danxbot plan event] two', '[danxbot plan event] three', '[danxbot plan event] four'])
      expect(d.stored.get('relayCursor:sess-own')).toMatchObject({ cursor: 'c8' })
    })

    test('a prompt does not mark a turn: a slash command may start none', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.prompt.submit({ text: '/some-local-command' } as any)
      await d.clock.settle()
      expect(runningOf(d)).toBeUndefined()
      d.relay.push({ cursor: 'c5', text: 'still idle' })
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] still idle'])
    })

    test('events of one answer are delivered in order, a relay-made record (a digest) too', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c5', text: 'first' }, { cursor: 'c6', text: 'second' }, { cursor: 'c6.5', text: 'a digest' })
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] first', '[danxbot plan event] second', '[danxbot plan event] a digest'])
    })
  })
}
