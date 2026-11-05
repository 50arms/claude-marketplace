import "./run-tests-with-npm-test.generated"
// claude.exe 2.1.317 empties a plugin's whole $.state when a /clear opens the next conversation (measured with a probe module): `session.end` (reason `clear`) still reads the
// ending conversation's values, then every key reads as never written, then `classic.SessionStart` (source `clear`) opens the new conversation and what it writes stays. The process,
// its MCP server, its loops and its timers go on, so every value the plugin keeps for the process is carried across (register.tsx carryAcrossConversation, restoreCarried).
import { describe, expect } from 'claude-code/testing'

import { test, SURFACES, CLEARED_SESSION_ID, dashboard, startSession, answerEngineClear, engineClears } from './plan-kit'

const relayPhases = (d: any) => d.stateWrites.filter((w: any) => w.key === 'relay').map((w: any) => w.value.phase)

for (const surface of SURFACES) {
  describe(`a /clear that empties $.state on ${surface}`, () => {
    test('the event relay keeps delivering, event after event, and its state stays streaming', async ($, on) => {
      answerEngineClear(on)
      const d = dashboard(on, { stateSteps: true })
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c5', text: 'before the clear' })
      await d.clock.settle()
      await engineClears($, d)
      const writes = d.stateWrites.length
      for (const [cursor, text] of [['c6', 'after the clear'], ['c7', 'and the next one']]) {
        d.relay.push({ cursor, text })
        await d.clock.settle()
      }
      expect(d.relay.delivered.map((x: any) => x.text)).toEqual(['before the clear', 'after the clear', 'and the next one'].map(t => `[50 Arms plan event] ${t}`))
      expect(relayPhases({ stateWrites: d.stateWrites.slice(writes) }).filter((p: string) => p !== 'streaming')).toEqual([])
      expect(d.toasts.filter((t: string) => /relay/i.test(t))).toEqual([])
    })
  })
}

// the value each key was last written with, among `writes`
const lastValues = (writes: { key: string; value: unknown }[]) => new Map(writes.map(w => [w.key, w.value]))
// the value each key was first written with, among `writes`
const firstValues = (writes: { key: string; value: unknown }[]) => {
  const first = new Map<string, unknown>()
  for (const w of writes) if (!first.has(w.key)) first.set(w.key, w.value)
  return first
}

describe('what a /clear that empties $.state carries', () => {
  test('every value the ending conversation held is written back by the start of the new conversation, among them the ended session, the boot id, the MCP ids, the desktop host, the relay outbox and the events in flight', async ($, on) => {
    answerEngineClear(on)
    const d = dashboard(on, { stateSteps: true })
    await startSession($, d, 'desktop')
    // an event that asks to be acknowledged: it is issued (ackInFlight) through the outbox's copy (relayOutbox)
    d.relay.push({ cursor: 'c5', text: 'asks an ack', acks: [{ eventId: 7, attempt: 1 }] })
    await d.clock.settle()
    // a first /clear, and the first prompt of the new conversation: the plugin finds the MCP server's id under the new engine id (mcpIds)
    await engineClears($, d)
    await $.prompt.submit({ text: 'next' })
    await d.clock.settle()
    // the second /clear, measured: what session.end leaves, and what the new conversation's start writes first
    await $.session.end({ reason: 'clear', sessionId: d.world.sessionId } as any)
    const held = lastValues(d.stateWrites)
    d.wipeState()
    const from = d.stateWrites.length
    d.world.sessionId = `${CLEARED_SESSION_ID}-again`
    await $.classic.SessionStart({ source: 'clear', cwd: '/work', session_id: d.world.sessionId, transcript_path: '/work/cleared-again.jsonl' })
    const back = firstValues(d.stateWrites.slice(from))
    for (const key of ['endedSession', 'bootEngineId', 'mcpIds', 'desktopHosted', 'relayOutbox', 'ackInFlight', 'readyLoop', 'measuredAt']) expect(held.has(key) ? key : `${key} never written`).toBe(key)
    const notBack = [...held].filter(([key, value]) => JSON.stringify(back.get(key)) !== JSON.stringify(value)).map(([key]) => key)
    expect(notBack).toEqual([])
  })
})
