import "./run-tests-with-npm-test.generated"
// CP-61 / DX-6733 (DEC-637, PBLM-3811): 50 Arms counts a mantra, a start packet or an event text as held only when the PLUGIN says it is in the model's conversation. Every text the
// dashboard sends carries an id (`delivery_id`, `startPacketDeliveryId`, `mantraDeliveryId`); the plugin posts it to POST /api/plan-sessions/me/events/<id>/ack, in the background,
// and only once the text is really there. A text that was queued and never entered, was dropped after a missed deadline, was refused by the session or was lost when the session
// exited is not acknowledged. The model is never asked to. (The plan events' own acknowledgements are in plan-relay-acks.test.tsx.)
import { describe, expect } from 'claude-code/testing'

import { START_PACKET_PATH } from '../hooks/context/packet'
import { CONTEXT_DEADLINE_MS, DEADLINE_REASON, eventFailureLine } from '../hooks/context/events'
import { SERVER } from '../hooks/plan/config'
import { APPROVAL_REQUIRED, EVENT_TEXT, SURFACES, dashboard, firstPrompt, forceRefresh, startSession, test } from './plan-kit'

const SESSION_CONNECT = 'mcp__plugin_50arms_platform__session_connect'
const API = 'mcp__plugin_50arms_platform__50arms_api'
const FILE = {
  profile: 'orchestrator',
  path: '/tmp/danx-start-packet/orchestrator-0123456789abcdef.md',
  bytes: 78688,
  instruction: 'Read this file now, whole, in ONE Read call with allow_large: true and no offset or limit.',
}
const START = { turnId: 't1' } as any
const COMPACT = { source: 'compact', cwd: '/work', session_id: 'sess-own', transcript_path: '/work/main.jsonl' }
const TRANSCRIPT = [{ role: 'user', text: 'go', toolUses: [], handle: 'm1' }]
const COMPACTED = { messages: [{ role: 'user', text: 'the summary', toolUses: [] }] }
const envelope = (body: unknown, ok = true) => JSON.stringify({ ok, status: ok ? 200 : 409, body })
const AGENT_ID = 'a1'

for (const surface of SURFACES) {
  describe(`acknowledging what a session start tells the model on ${surface}`, () => {
    // a test that has the engine deny the next tool results sets this
    let denyTools = false
    async function started($: any, on: any, options: Parameters<typeof dashboard>[1] = {}) {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.SubagentStart', () => ({}) as any)
      on('classic.PreCompact', () => ({}) as any)
      on('session.compact', async () => COMPACTED as any)
      on('turn.complete', () => ({ text: 'done' }) as any)
      denyTools = false
      on('tool.call', () => (denyTools ? ({ deny: 'refused' } as any) : ({ result: {}, text: 'done' } as any)))
      const d = dashboard(on, options)
      await startSession($, d, surface)
      d.world.startPacket = FILE
      d.world.deliveries.event = { session_start: 11, session_resume: 21, after_compaction: 31, sub_agent_start: 41 }
      d.world.deliveries.startPacket = 12
      return d
    }

    for (const [source, id] of [['startup', 11], ['resume', 21], ['compact', 31]] as const) {
      test(`a ${source} acknowledges the packet's file and the event text once the prompt that carries them entered, both in the background`, async ($, on) => {
        const d = await started($, on)
        const r = await firstPrompt($, source)
        expect(r.startLines).toHaveLength(1)
        await d.clock.settle()
        expect(d.world.acked).toEqual([12, id])
        expect(d.world.ackCalls).toEqual([{ id: 12, background: true }, { id, background: true }])
      })
    }

    test('a start that rides the first tool result is acknowledged when that result goes to the model', async ($, on) => {
      const d = await started($, on)
      await $.classic.SessionStart({ ...COMPACT, source: 'startup' })
      const r = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
      expect(r.context!.slice(1)).toHaveLength(1)
      await d.clock.settle()
      expect(d.world.acked).toEqual([12, 11])
    })

    test('a session that holds nothing (a null packet) acknowledges the event text alone', async ($, on) => {
      const d = await started($, on)
      d.world.startPacket = null
      d.world.deliveries.startPacket = null
      await firstPrompt($, 'startup')
      await d.clock.settle()
      expect(d.world.acked).toEqual([11])
    })

    test('a packet read that failed is a warning line, not a packet: only the event text is acknowledged', async ($, on) => {
      const d = await started($, on)
      d.world.startPacket = { status: 500 }
      await firstPrompt($, 'startup')
      await d.clock.settle()
      expect(d.world.acked).toEqual([11])
    })

    test('an event text that failed is a warning line, not the text: only the packet is acknowledged', async ($, on) => {
      const d = await started($, on)
      d.world.eventText.session_start = { status: 500 }
      await firstPrompt($, 'startup')
      await d.clock.settle()
      expect(d.world.acked).toEqual([12])
    })

    test('a packet that is no file (an older dashboard MCP) is never acknowledged: its line is a warning', async ($, on) => {
      const d = await started($, on)
      d.world.startPacket = { profile: 'orchestrator', text: 'inline' }
      await firstPrompt($, 'startup')
      await d.clock.settle()
      expect(d.world.acked).toEqual([11])
    })

    test('reads that finish after the start deadline are dropped with their ids: nothing is acknowledged', async ($, on) => {
      const d = await started($, on)
      d.world.contextHangs = true
      const pending = firstPrompt($, 'startup')
      await d.clock.advance(CONTEXT_DEADLINE_MS)
      const r = await pending
      expect(r.startLines![0]).toContain('timeout: no response within 8s')
      // the hung reads finish late: their answers (and ids) are the module's no longer
      d.release()
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
    })

    test('a prompt the engine refused did not carry the start to the model: nothing is acknowledged', async ($, on) => {
      const d = await started($, on)
      d.relay.dropPrompts('closed')
      await firstPrompt($, 'startup')
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
    })

    test('a tool result the engine denied carries no start: nothing is acknowledged, and the start is told on the next result', async ($, on) => {
      const d = await started($, on)
      denyTools = true
      await $.classic.SessionStart({ ...COMPACT, source: 'startup' })
      await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
      denyTools = false
      await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
      await d.clock.settle()
      expect(d.world.acked).toEqual([12, 11])
    })

    test("a compaction that ends while no turn runs: the plugin's resume prompt acknowledges the packet and the event text once it entered", async ($, on) => {
      const d = await started($, on)
      await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })
      await $.classic.SessionStart(COMPACT)
      await d.clock.settle()
      expect(d.relay.submitted.filter((t: string) => t.includes('Your conversation was just compacted'))).toHaveLength(1)
      expect(d.world.acked).toEqual([12, 31])
    })

    test('a resume prompt the session refused is not acknowledged; the start is told again, and acknowledged then', async ($, on) => {
      const d = await started($, on)
      d.relay.dropPrompts('busy')
      await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })
      await $.classic.SessionStart(COMPACT)
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
      d.relay.acceptPrompts()
      const next = await $.prompt.submit({ text: 'next' })
      expect(next.context!.slice(1)).toHaveLength(1)
      await d.clock.settle()
      expect(d.world.acked).toEqual([12, 31])
    })

    test("a compaction briefing appended to the turn that began during the reads is acknowledged once appended", async ($, on) => {
      const d = await started($, on)
      d.world.contextDelayMs = 1_000
      await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })
      await $.classic.SessionStart(COMPACT)
      await $.turn.start(START)
      await d.clock.advance(5_000)
      await d.clock.settle()
      expect(d.relay.told.filter((t: string) => t.includes('Your conversation was just compacted'))).toHaveLength(1)
      expect(d.world.acked).toEqual([12, 31])
    })

    test('a briefing note the running turn refused is not acknowledged', async ($, on) => {
      const d = await started($, on)
      d.world.contextDelayMs = 1_000
      d.relay.rejectAppends('closed')
      await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })
      await $.classic.SessionStart(COMPACT)
      await $.turn.start(START)
      await d.clock.advance(5_000)
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
    })

    test("a sub-agent's start text goes to the sub-agent, not the session: it is told and acknowledges nothing", async ($, on) => {
      const d = await started($, on)
      const r = await $.classic.SubagentStart({ agent_id: AGENT_ID, agent_type: '50arms:worker-sonnet-high' })
      await d.clock.settle()
      expect(r.additionalContext).toHaveLength(1)
      expect(d.world.ackCalls).toEqual([])
    })

    test('a fork is told nothing, so acknowledges nothing', async ($, on) => {
      const d = await started($, on)
      await firstPrompt($, 'fork')
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
    })

    test('a refused acknowledgement is shown to the person, never swallowed', async ($, on) => {
      const d = await started($, on)
      d.world.ackReplies[12] = { status: 500, error: 'ack boom' }
      await firstPrompt($, 'startup')
      await d.clock.settle()
      expect(d.world.acked).toEqual([11])
      expect(d.toasts.some(t => t.includes('Could not acknowledge a delivery to 50 Arms (12: 500: ack boom)'))).toBe(true)
    })
  })

  describe(`acknowledging what the model's own calls return on ${surface}`, () => {
    const connected = { session: { planId: 23 }, startPacket: FILE, startPacketDeliveryId: 51, mantraDeliveryId: 52 }

    async function answering($: any, on: any, tool: string, text: string) {
      on('tool.call', { tool }, () => ({ result: {}, text, isError: false }) as any)
      const d = dashboard(on)
      await startSession($, d, surface)
      return d
    }

    test("the model's session_connect: the mantra and the start packet its answer carries are acknowledged when the result goes to it", async ($, on) => {
      const d = await answering($, on, SESSION_CONNECT, envelope(connected))
      await $.tool.call({ tool: SESSION_CONNECT, target: 'PLAN-23' } as any)
      await d.clock.settle()
      expect(d.world.acked).toEqual([51, 52])
      expect(d.world.ackCalls.every(c => c.background === true)).toBe(true)
    })

    test('a connect that built neither (a reconnect: both null) acknowledges nothing', async ($, on) => {
      const d = await answering($, on, SESSION_CONNECT, envelope({ ...connected, startPacket: null, startPacketDeliveryId: null, mantraDeliveryId: null }))
      await $.tool.call({ tool: SESSION_CONNECT, target: 'PLAN-23' } as any)
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
    })

    test("a card connect's answer is acknowledged the same way", async ($, on) => {
      const d = await answering($, on, SESSION_CONNECT, envelope({ session: { cardId: 'DX-9' }, startPacket: FILE, startPacketDeliveryId: 53, mantraDeliveryId: null }))
      await $.tool.call({ tool: SESSION_CONNECT, target: 'DX-9' } as any)
      await d.clock.settle()
      expect(d.world.acked).toEqual([53])
    })

    test('a connect the dashboard refused carries no text for the model to hold: nothing is acknowledged', async ($, on) => {
      const d = await answering($, on, SESSION_CONNECT, envelope({ error: 'card_on_plan', startPacketDeliveryId: 54 }, false))
      await $.tool.call({ tool: SESSION_CONNECT, target: 'DX-9' } as any)
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
    })

    test('a connect the engine denied is not acknowledged', async ($, on) => {
      on('tool.call', { tool: SESSION_CONNECT }, () => ({ deny: 'refused by the engine' }) as any)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.tool.call({ tool: SESSION_CONNECT, target: 'PLAN-23' } as any)
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
    })

    test("a sub-agent's connect is not the session's: nothing is acknowledged", async ($, on) => {
      const d = await answering($, on, SESSION_CONNECT, envelope(connected))
      await $.tool.call({ tool: SESSION_CONNECT, target: 'PLAN-23', agentId: AGENT_ID } as any)
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
    })

    test("the model's own read of its start packet is acknowledged", async ($, on) => {
      const d = await answering($, on, API, envelope({ startPacket: FILE, startPacketDeliveryId: 55 }))
      await $.tool.call({ tool: API, method: 'GET', path: START_PACKET_PATH } as any)
      await d.clock.settle()
      expect(d.world.acked).toEqual([55])
    })

    test('another read, or the same path with another method, acknowledges nothing', async ($, on) => {
      const d = await answering($, on, API, envelope({ startPacket: FILE, startPacketDeliveryId: 55 }))
      await $.tool.call({ tool: API, method: 'GET', path: '/api/plan-sessions/me' } as any)
      await $.tool.call({ tool: API, method: 'POST', path: START_PACKET_PATH } as any)
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
    })

    test("the model's pickup that connected it is acknowledged", async ($, on) => {
      const pickup = { tool: API, method: 'POST', path: '/api/issues/DX-9/transition', body: { action: 'pickup' } } as any
      const d = await answering($, on, API, envelope({ issue: { id: 'DX-9' }, connectedByPickup: true, startPacket: FILE, startPacketDeliveryId: 56, mantraDeliveryId: 57 }))
      await $.tool.call(pickup)
      await d.clock.settle()
      expect(d.world.acked).toEqual([56, 57])
    })

    test('a pickup that connected nothing names no id, so acknowledges nothing', async ($, on) => {
      const pickup = { tool: API, method: 'POST', path: '/api/issues/DX-9/transition', body: { action: 'pickup' } } as any
      const d = await answering($, on, API, envelope({ issue: { id: 'DX-9' }, startPacket: null, startPacketDeliveryId: null, mantraDeliveryId: null }))
      await $.tool.call(pickup)
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
    })

    test('a card write the model makes acknowledges nothing, whatever its answer says', async ($, on) => {
      const d = await answering($, on, API, envelope({ ok: true, startPacketDeliveryId: 58 }))
      await $.tool.call({ tool: API, method: 'PATCH', path: '/api/issues/DX-9/edit', body: {} } as any)
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
    })
  })

  // the watch's own binding connect carries the packet (and the connect's mantra) to the plugin; only what the wake note tells is acknowledged
  describe(`acknowledging what a sign-in the plugin watches tells the model on ${surface}`, () => {
    const CALL = { tool: SESSION_CONNECT, target: 'PLAN-23', title: 'PLAN-23: 50 Arms plugin' } as any
    const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any

    async function modelAsksToSignIn($: any, on: any, setup: (d: any) => void = () => {}) {
      on('tool.call', { tool: SESSION_CONNECT }, () => ({ result: {}, text: JSON.stringify(APPROVAL_REQUIRED), isError: false }) as any)
      const d = dashboard(on, { signedOut: 'signed-out' })
      await startSession($, d, surface)
      d.world.startPacket = FILE
      d.world.deliveries.startPacket = 61
      d.world.deliveries.mantra = 62
      setup(d)
      await $.tool.call(CALL)
      await d.clock.settle()
      d.world.signIn.approved = true
      await d.clock.advance(45_000)
      await d.clock.settle()
      return d
    }

    test("the packet's id is acknowledged once the wake note that names its file entered; the connect's mantra, never told here, is not", async ($, on) => {
      const d = await modelAsksToSignIn($, on)
      expect(d.relay.submitted.some((t: string) => t.includes(FILE.path))).toBe(true)
      expect(d.world.acked).toEqual([61])
    })

    test('a wake note the session refused is not acknowledged', async ($, on) => {
      const d = await modelAsksToSignIn($, on, d => d.relay.dropPrompts('busy'))
      expect(d.world.ackCalls).toEqual([])
    })

    test('a packet that cannot be pointed at (malformed) is a warning line, not a packet: nothing is acknowledged', async ($, on) => {
      const d = await modelAsksToSignIn($, on, d => (d.world.startPacket = { profile: 'orchestrator', path: '', bytes: 1, instruction: 'x' }))
      expect(d.world.ackCalls).toEqual([])
    })

    test('a connect that built no packet names no id, so acknowledges nothing', async ($, on) => {
      const d = await modelAsksToSignIn($, on, d => {
        d.world.startPacket = null
        d.world.deliveries.startPacket = null
      })
      expect(d.world.ackCalls).toEqual([])
    })

    test('the Sign in button: the note the operator signed the session in tells the packet, and its id is acknowledged once it entered', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      d.world.signedOut = 'lapsed'
      for (let i = 0; i < 3; i++) await forceRefresh($, d)
      d.world.startPacket = FILE
      d.world.deliveries.startPacket = 63
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      d.world.signIn.approved = true
      await d.clock.advance(45_000)
      await d.clock.settle()
      expect(d.world.acked).toEqual([63])
    })
  })

  // CP-61 / DX-6733 (DEC-637): a person's /clear wipes the model's conversation, so 50 Arms must forget the mantra and the start packet it thinks the model holds. The read of the `session_start` text
  // is what tells it (it clears both on the session's row), so every /clear makes that read, through the session's own dashboard server, and acknowledges the text once it is in the conversation.
  describe(`acknowledging what a /clear tells the model on ${surface}`, () => {
    const PREVIOUS = 'sess-previous'
    const NOTICE = 'You replaced PLAN-23.'

    async function cleared($: any, on: any, options: Parameters<typeof dashboard>[1] = {}, endedOnPlan = true) {
      on('classic.SessionStart', () => ({}) as any)
      on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
      on('turn.complete', () => ({ text: 'done' }) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      const d = dashboard(on, options)
      await startSession($, d, surface)
      d.world.deliveries.event = { session_start: 61 }
      d.world.deliveries.startPacket = 62
      d.world.startPacket = FILE
      d.world.restart.json = { notice: NOTICE }
      await $.session.end({ reason: 'clear', sessionId: PREVIOUS } as any)
      // the new session has no connection record under its own engine id; the ended one had (a first /clear of a plan session is a restart)
      if (endedOnPlan) {
        d.world.localRecord = false
        d.world.records.push(PREVIOUS)
      }
      return d
    }

    test('a /clear reads the session_start text through the session own dashboard server, tells it and acknowledges only that text', async ($, on) => {
      const d = await cleared($, on, {}, false)
      await firstPrompt($, 'clear')
      await d.clock.settle()
      expect(d.contextReads).toContain('/api/reminders/event/session_start')
      expect([...d.serversCalled]).toEqual([SERVER])
      // the start packet is the model's own connect's to bring, so the clear reads and acknowledges none
      expect(d.contextReads.some(p => p.includes('start-packet'))).toBe(false)
      expect(d.world.acked).toEqual([61])
      expect(d.world.ackCalls).toEqual([{ id: 61, background: true }])
    })

    test('a /clear of a session that was on a plan is also told the restart notice, after the text; the text is acknowledged', async ($, on) => {
      const d = await cleared($, on)
      const r = await firstPrompt($, 'clear')
      expect(r.startLines?.join('\n')).toContain(NOTICE)
      await d.clock.settle()
      expect(d.restartCalls).toEqual([{ predecessor_id: PREVIOUS }])
      expect(d.world.acked).toEqual([61])
    })

    test('a /clear of a session on no plan still reads the text', async ($, on) => {
      const d = await cleared($, on, { connected: false }, false)
      await firstPrompt($, 'clear')
      await d.clock.settle()
      expect(d.world.acked).toEqual([61])
    })

    test('a signed-out /clear reads nothing and acknowledges nothing', async ($, on) => {
      const d = await cleared($, on, { connected: false, signedOut: 'signed-out' }, false)
      expect((await firstPrompt($, 'clear')).startLines).toBeUndefined()
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
      expect(d.contextReads.some(p => p.startsWith('/api/reminders/event/'))).toBe(false)
    })

    // the real /clear state: the ended session had a record, the new engine id has none. A dashboard outage then gives the one warning line inside the start's own 8 s deadline.
    test('a read that fails is the event-specific warning line and acknowledges nothing; the restart notice still follows', async ($, on) => {
      const d = await cleared($, on)
      d.world.eventText.session_start = { status: 500 }
      const r = await firstPrompt($, 'clear')
      expect(r.startLines).toEqual([`${eventFailureLine('session_start', '500: event boom')}
${NOTICE}`])
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
    })

    test('a read that misses the deadline is the deadline warning line and acknowledges nothing', async ($, on) => {
      const d = await cleared($, on)
      d.world.contextHangs = true
      const pending = firstPrompt($, 'clear')
      await d.clock.advance(CONTEXT_DEADLINE_MS)
      const r = await pending
      expect(r.startLines).toEqual([`${eventFailureLine('session_start', DEADLINE_REASON)}
${NOTICE}`])
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
    })

    test('a dashboard that never answers the session read gives the deadline warning line at 8 s, never a hang', async ($, on) => {
      const d = await cleared($, on)
      d.holdApi(10 * CONTEXT_DEADLINE_MS)
      const pending = firstPrompt($, 'clear')
      await d.clock.advance(CONTEXT_DEADLINE_MS)
      const r = await pending
      expect(r.startLines).toEqual([`${eventFailureLine('session_start', DEADLINE_REASON)}
${NOTICE}`])
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
    })

    // a later /clear: the ended session (the first /clear's) has no record, the one under the id the server booted with does
    describe('a second /clear', () => {
      async function again($: any, on: any) {
        const d = await cleared($, on, {}, false)
        d.world.localRecord = false
        d.world.records.push(d.world.sessionId)
        d.world.sessionId = 'sess-second-clear'
        return d
      }

      test('a hung session read gives the deadline warning line at 8 s', async ($, on) => {
        const d = await again($, on)
        d.holdApi(10 * CONTEXT_DEADLINE_MS)
        const pending = firstPrompt($, 'clear', { session_id: d.world.sessionId })
        await d.clock.advance(CONTEXT_DEADLINE_MS)
        expect((await pending).startLines).toEqual([`${eventFailureLine('session_start', DEADLINE_REASON)}\n${NOTICE}`])
        await d.clock.settle()
        expect(d.world.ackCalls).toEqual([])
      })

      test('a failing session read gives the event-specific warning line', async ($, on) => {
        const d = await again($, on)
        d.world.sessionReadStatus = 503
        expect((await firstPrompt($, 'clear', { session_id: d.world.sessionId })).startLines).toEqual([`${eventFailureLine('session_start', '503: session boom')}\n${NOTICE}`])
        await d.clock.settle()
        expect(d.world.ackCalls).toEqual([])
      })
    })

    test('a failing session read is one warning line naming the event and acknowledges nothing', async ($, on) => {
      const d = await cleared($, on)
      d.world.sessionReadStatus = 503
      const r = await firstPrompt($, 'clear')
      expect(r.startLines).toEqual([`${eventFailureLine('session_start', '503: session boom')}
${NOTICE}`])
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
    })
  })

  describe(`acknowledging the missed events a connect hands over on ${surface}`, () => {
    const connected = { session: { planId: 23 }, startPacket: null, startPacketDeliveryId: null, mantraDeliveryId: 52, missedEvents: [{ text: 'x' }], missedEventsDeliveryId: 71 }

    async function answering($: any, on: any, text: string) {
      on('tool.call', { tool: SESSION_CONNECT }, () => ({ result: {}, text, isError: false }) as any)
      on('tool.call', { tool: API }, () => ({ result: {}, text, isError: false }) as any)
      const d = dashboard(on)
      await startSession($, d, surface)
      return d
    }

    test("the model's own connect acknowledges missedEventsDeliveryId with the other ids", async ($, on) => {
      const d = await answering($, on, envelope(connected))
      await $.tool.call({ tool: SESSION_CONNECT, target: 'PLAN-23' } as any)
      await d.clock.settle()
      expect(d.world.acked).toEqual([52, 71])
    })

    test('a connecting pickup acknowledges it too', async ($, on) => {
      const d = await answering($, on, envelope({ issue: { id: 'DX-9' }, connectedByPickup: true, startPacket: null, startPacketDeliveryId: null, mantraDeliveryId: null, missedEvents: [{ text: 'x' }], missedEventsDeliveryId: 72 }))
      await $.tool.call({ tool: API, method: 'POST', path: '/api/issues/DX-9/transition', body: { action: 'pickup' } } as any)
      await d.clock.settle()
      expect(d.world.acked).toEqual([72])
    })

    test('a null missedEventsDeliveryId acknowledges nothing', async ($, on) => {
      const d = await answering($, on, envelope({ ...connected, mantraDeliveryId: null, missedEvents: [], missedEventsDeliveryId: null }))
      await $.tool.call({ tool: SESSION_CONNECT, target: 'PLAN-23' } as any)
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
    })

    test("a sub-agent's connect is not the session's: its missed events are not acknowledged", async ($, on) => {
      const d = await answering($, on, envelope(connected))
      await $.tool.call({ tool: SESSION_CONNECT, target: 'PLAN-23', agentId: AGENT_ID } as any)
      await d.clock.settle()
      expect(d.world.ackCalls).toEqual([])
    })
  })
}
