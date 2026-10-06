// DX-4233: how a relayed event reaches the session. One decision (relay/delivery.ts): a turn is in flight (turn.start .. turn.complete
// of the main loop) -> a row the model reads in that turn ($.session.append); idle -> a submitted prompt that wakes the session. A
// refused row is a failed delivery, never a quiet prompt. `claude plugin test` has no seam that lets the plugin's own
// $.session.append succeed, so what follows a successful append (the rows a turn did not read) is tested on the pure transitions, and
// the hooks that carry them (turn.step, turn.complete) over a turn state the kit seeds (`seedUnseen`). The one thing no test here can
// reach is the plugin REMEMBERING a row it appended (deliverEvent's update with rowAppended): that needs an append that succeeds, so it
// is proved on a live session (the E2E items) and by `rowAppended`'s own tests below.
import { describe, expect, test } from 'claude-code/testing'

import { IDLE, deliveryMode, eventRow, requestSent, rowAppended, turnEnded, turnStarted } from '../hooks/relay/delivery'
import { SURFACES, dashboard, startSession, toldModel } from './plan-kit'

const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
const START = { turnId: 't1' } as any

// the turn state as the plugin keeps it in $.state, read from its writes
const turnOf = (d: any) => d.stateWrites.filter((w: any) => w.key === 'turn').at(-1)?.value

describe('the delivery decision', () => {
  test('a turn in flight is a row, an idle session a prompt', () => {
    expect(deliveryMode(IDLE)).toBe('prompt')
    expect(deliveryMode(turnStarted())).toBe('row')
    expect(deliveryMode({ isInFlight: true, unseen: ['x'] })).toBe('row')
    expect(deliveryMode({ isInFlight: false, unseen: [] })).toBe('prompt')
  })

  test('the row text is the marker, a space and the text, unchanged', () => {
    expect(eventRow('operator commented on problem 3')).toBe('[danxbot plan event] operator commented on problem 3')
  })
})

describe('the rows a turn did not read', () => {
  test('a row appended in a turn in flight is remembered, with no wake', () => {
    expect(rowAppended(turnStarted(), 'a')).toEqual({ turn: { isInFlight: true, unseen: ['a'] }, wake: null })
  })

  test('a row appended after the turn ended (turn.complete landed between the decision and the append) is named in a wake at once, not remembered', () => {
    expect(rowAppended(IDLE, 'raced')).toEqual({ turn: IDLE, wake: '[danxbot plan event] an event arrived as the last turn ended: raced' })
    // the turn that began after: its own state, none of the old row
    expect(turnStarted().unseen).toEqual([])
  })

  test('an ABORTED turn (the person pressed Esc) goes idle and names nothing: the rows stay for their next prompt', () => {
    const t = rowAppended(turnStarted(), 'unread').turn
    expect(turnEnded(t, true)).toEqual({ turn: IDLE, wake: null })
  })

  test('a turn that read every row it was given ends with no wake prompt', () => {
    let t = rowAppended(turnStarted(), 'a').turn
    t = requestSent(t)
    expect(t.unseen).toEqual([])
    expect(turnEnded(t, false)).toEqual({ turn: IDLE, wake: null })
  })

  test('a row appended after the last model request is named again when the turn ends', () => {
    let t = turnStarted()
    t = requestSent(t)
    t = rowAppended(t, 'late one').turn
    const ended = turnEnded(t, false)
    expect(ended.turn).toEqual(IDLE)
    expect(ended.wake).toBe('[danxbot plan event] an event arrived as the last turn ended: late one')
  })

  test('only the rows after the last request are named, in order, counted', () => {
    let t = turnStarted()
    t = rowAppended(t, 'early').turn
    t = requestSent(t)
    t = rowAppended(t, 'one').turn
    t = rowAppended(t, 'two').turn
    expect(turnEnded(t, false).wake).toBe('[danxbot plan event] 2 events arrived as the last turn ended: one | two')
  })

  test('a turn with no request at all names every row it was given', () => {
    expect(turnEnded(rowAppended(turnStarted(), 'only').turn, false).wake).toContain('only')
  })

  test('a new turn forgets the rows of the one before', () => {
    expect(turnStarted().unseen).toEqual([])
    expect(turnEnded(IDLE, false)).toEqual({ turn: IDLE, wake: null })
  })

  test('a request with nothing unseen hands back the very same state (no write per model request)', () => {
    const t = turnStarted()
    expect(requestSent(t)).toBe(t)
  })

  test('the transitions never change what they are given', () => {
    const t = { isInFlight: true, unseen: ['a'] }
    rowAppended(t, 'b')
    requestSent(t)
    turnEnded(t, false)
    expect(t).toEqual({ isInFlight: true, unseen: ['a'] })
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

    // This test asserts the kit's MISSING append: the engine rejects the plugin's own $.session.append under `claude plugin test`, so what
    // is observable is that a turn in flight tries a row (never a prompt), and that a refused row is a failed delivery: told once, the cursor
    // does not move, and the next wait asks again.
    test('a turn in flight gets a row (turn.start .. turn.complete), never a prompt; a refused row is a failed delivery', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.start(START)
      expect(turnOf(d)).toEqual({ isInFlight: true, unseen: [] })
      d.relay.push({ cursor: 'c5', text: 'during the turn' })
      await d.clock.settle()
      expect(toldModel(d)).toHaveLength(1)
      expect(toldModel(d)[0]).toContain('the session did not take the event')
      expect(d.stored.get('relayCursor:sess-own')).toBeUndefined()
      await d.clock.advance(1_000)
      expect(d.relay.calls.at(-1)?.cursor).toBeNull()
      expect(d.relay.delivered).toEqual([])
    })

    test('turn.complete ends the turn: the next event is a prompt again', async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      await startSession($, d, surface)
      await $.turn.start(START)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(turnOf(d)).toEqual({ isInFlight: false, unseen: [] })
      d.relay.push({ cursor: 'c5', text: 'after the turn' })
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] after the turn'])
    })

    test('an aborted main-loop turn.complete sends no wake prompt; the rows stay and the turn is over', async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      d.seedUnseen(['unread when the person pressed Esc'])
      await startSession($, d, surface)
      await $.turn.start(START)
      await $.turn.complete({ ...TURN, reason: 'aborted', isAborted: true })
      await d.clock.settle()
      expect(d.relay.delivered).toEqual([])
      expect(turnOf(d)).toEqual({ isInFlight: false, unseen: [] })
    })

    test("a sub-agent's turn.complete names nothing and leaves the rows for the main loop's own end", async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      d.seedUnseen(['still unseen'])
      await startSession($, d, surface)
      await $.turn.start(START)
      await $.turn.complete({ ...TURN, agentId: 'agent-1' })
      await d.clock.settle()
      expect(d.relay.delivered).toEqual([])
      expect(turnOf(d)).toEqual({ isInFlight: true, unseen: ['still unseen'] })
    })

    test('a turn.complete with nothing unseen submits no prompt', async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      await startSession($, d, surface)
      await $.turn.start(START)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.relay.delivered).toEqual([])
    })

    test('a wake the session did not take is a toast, not a failed turn.complete', async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      d.seedUnseen(['x'])
      await startSession($, d, surface)
      await $.turn.start(START)
      d.relay.dropPrompts('busy')
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.toasts.some(t => t.startsWith('Plan events not told to the session: the session did not take the event: busy'))).toBe(true)
    })

    test('a prompt does not mark a turn: a slash command may start none', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.prompt.submit({ text: '/some-local-command' } as any)
      await d.clock.settle()
      expect(turnOf(d)).toBeUndefined()
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
