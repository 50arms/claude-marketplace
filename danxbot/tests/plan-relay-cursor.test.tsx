// DX-4233: the resume cursor. One rule: after a record is delivered, its cursor (an opaque string the server minted) is stored in $.store
// verbatim, and the next wait carries it, so a restart or a reload asks for what follows the last record delivered. The plugin never
// compares or orders cursors: the server decides what comes after one (ids can become visible out of order).
import { describe, expect, test } from 'claude-code/testing'

import { CURSOR_KEEP, CURSOR_PREFIX } from '../hooks/relay/config'
import { SURFACES, dashboard, startSession } from './plan-kit'

const KEY = `${CURSOR_PREFIX}sess-own`
const answer = (body: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false } })

for (const surface of SURFACES) {
  describe(`the resume cursor on ${surface}`, () => {
    test("a delivered record's cursor is stored for this session and plan, and the next wait carries it", async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c5', text: 'one' })
      await d.clock.settle()
      expect(d.stored.get(KEY)).toEqual({ planId: 23, cursor: 'c5', at: expect.any(Number) })
      expect(d.relay.calls.map(c => c.cursor)).toEqual([null, 'c5'])
    })

    test('records are delivered in the order the server sent them, whatever their cursors look like; the last cursor is stored verbatim', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.push({ cursor: 'zz-9', text: 'first' }, { cursor: '000-1', text: 'second' }, { cursor: 'm.5', text: 'a digest' })
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] first', '[danxbot plan event] second', '[danxbot plan event] a digest'])
      expect(d.stored.get(KEY)).toMatchObject({ cursor: 'm.5' })
      expect(d.relay.calls.at(-1)?.cursor).toBe('m.5')
    })

    test('a failed delivery does not advance it: the record is asked for again and delivered once', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c5', text: 'one' })
      await d.clock.settle()
      d.relay.rejectPrompts('the session is busy')
      d.relay.push({ cursor: 'c6', text: 'two' })
      await d.clock.settle()
      expect(d.stored.get(KEY)).toMatchObject({ cursor: 'c5' })
      d.relay.acceptPrompts()
      await d.clock.advance(1_000)
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] one', '[danxbot plan event] two'])
      expect(d.stored.get(KEY)).toMatchObject({ cursor: 'c6' })
      // the asks after the failure carried the cursor before the undelivered record
      expect(d.relay.calls.map(c => c.cursor)).toEqual([null, 'c5', 'c5', 'c6'])
    })

    test('a failure in the middle of a batch: the first is delivered and stored, the next call carries it, the rest arrive once after', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      let prompts = 0
      d.relay.duringPrompt(async () => {
        prompts++
        if (prompts === 2) d.relay.rejectPrompts('the session is busy')
      })
      d.relay.push({ cursor: 'c5', text: 'five' }, { cursor: 'c6', text: 'six' }, { cursor: 'c7', text: 'seven' })
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] five'])
      expect(d.stored.get(KEY)).toMatchObject({ cursor: 'c5' })
      d.relay.acceptPrompts()
      await d.clock.advance(1_000)
      expect(d.relay.calls.at(-2)?.cursor).toBe('c5')
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] five', '[danxbot plan event] six', '[danxbot plan event] seven'])
      expect(d.stored.get(KEY)).toMatchObject({ cursor: 'c7' })
    })

    test('a resumed process calls with the stored cursor, as it is', async ($, on) => {
      const d = dashboard(on)
      d.stored.set(KEY, { planId: 23, cursor: 'opaque/7=', at: 1 })
      await startSession($, d, surface)
      expect(d.relay.calls.map(c => c.cursor)).toEqual(['opaque/7='])
    })

    for (const [name, record] of [['another plan', { planId: 24, cursor: 'c7', at: 1 }], ['a number', { planId: 23, cursor: 7, at: 1 }], ['an empty cursor', { planId: 23, cursor: '', at: 1 }], ['junk', 'junk']] as const) {
      test(`a stored record that is ${name} starts clean`, async ($, on) => {
        const d = dashboard(on)
        d.stored.set(KEY, record)
        await startSession($, d, surface)
        expect(d.relay.calls.map(c => c.cursor)).toEqual([null])
      })
    }

    test('what the server answers is delivered as it comes: the plugin does not drop a record for looking old', async ($, on) => {
      const d = dashboard(on)
      d.stored.set(KEY, { planId: 23, cursor: 'c5', at: 1 })
      d.relay.server.script.push(() => answer({ events: [{ cursor: 'c3', text: 'visible late' }, { cursor: 'c6', text: 'new' }] }))
      await startSession($, d, surface)
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] visible late', '[danxbot plan event] new'])
      expect(d.stored.get(KEY)).toMatchObject({ cursor: 'c6' })
    })

    test(`the store keeps the newest ${CURSOR_KEEP} sessions' cursors`, async ($, on) => {
      const d = dashboard(on)
      for (let i = 0; i < CURSOR_KEEP + 5; i++) d.stored.set(`${CURSOR_PREFIX}old-${i}`, { planId: 23, cursor: 'c1', at: 100 + i })
      await startSession($, d, surface)
      const kept = [...d.stored.keys()].filter(k => k.startsWith(CURSOR_PREFIX))
      expect(kept).toHaveLength(CURSOR_KEEP)
      expect(kept).toContain(`${CURSOR_PREFIX}old-${CURSOR_KEEP + 4}`)
      expect(kept).not.toContain(`${CURSOR_PREFIX}old-0`)
    })
  })
}
