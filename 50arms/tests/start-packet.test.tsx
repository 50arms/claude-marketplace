import "./run-tests-with-npm-test.generated"
// CP-61 / DX-6733: a main session's start packet. At a session start (startup, resume) and after a compaction the plugin reads the dashboard's
// `GET /api/plan-sessions/me/start-packet` ITSELF, once, and tells the model the file the session's own dashboard server wrote, so the agent makes no
// route call, no chunked role read and no skill re-invoke of its own. The wording of the packet is the dashboard's; the plugin's two lines are pinned
// literally (not imported), so a reworded production text must fail here.
import { describe, expect } from 'claude-code/testing'

import { START_PACKET_PATH } from '../hooks/context/packet'
import { signInApprovedNote, signInNote } from '../hooks/plan/notes'
import { relayLine } from '../hooks/relay/delivery'
import { APPROVAL_REQUIRED, CONFIRM_CODE, DEFAULT_BRIEFING, EVENT_TEXT, SURFACES, dashboard, firstPrompt, forceRefresh, startSession, test, woken } from './plan-kit'

const START = { agent_id: 'a1', agent_type: '50arms:worker-sonnet-high' }
// what the session's dashboard server answers in place of the packet's text (spillStartPacket): where the file is and the one Read that takes it whole
const FILE = {
  profile: 'orchestrator',
  path: '/tmp/danx-start-packet/orchestrator-0123456789abcdef.md',
  bytes: 78688,
  instruction: 'Read this file now, whole, in ONE Read call with allow_large: true and no offset or limit. It is your start packet: your role\'s workflow, then what you hold now.',
}
const POINTER = `[50 ARMS] Your start packet is already fetched for you. File: ${FILE.path} (78688 bytes, the orchestrator role). ${FILE.instruction}`
const PACKET_READS = (reads: string[]) => reads.filter(p => p === START_PACKET_PATH)

for (const surface of SURFACES) {
  describe(`the start packet on ${surface}`, () => {
    async function started($: any, on: any, options: Parameters<typeof dashboard>[1] = {}) {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.SubagentStart', () => ({}) as any)
      const d = dashboard(on, options)
      await startSession($, d, surface)
      d.contextReads.length = 0
      return d
    }

    for (const [source, event] of [['startup', 'session_start'], ['resume', 'session_resume']] as const) {
      test(`a connected session's ${source} is told the packet's file before the ${event} text, from one read`, async ($, on) => {
        const d = await started($, on)
        d.world.startPacket = FILE
        const r = await firstPrompt($, source)
        expect(r.startLines).toEqual([`${POINTER}\n${EVENT_TEXT(event)}`])
        expect(PACKET_READS(d.contextReads)).toEqual([START_PACKET_PATH])
      })
    }

    test("a compaction is told the packet's file, then the event text, then the resume briefing, from one read", async ($, on) => {
      const d = await started($, on)
      d.world.startPacket = FILE
      const r = await firstPrompt($, 'compact')
      expect(r.startLines).toEqual([`${POINTER}\n${EVENT_TEXT('after_compaction')}\n${DEFAULT_BRIEFING}`])
      expect(PACKET_READS(d.contextReads)).toEqual([START_PACKET_PATH])
    })

    test('a session that holds nothing is told nothing of a packet (the dashboard answers null)', async ($, on) => {
      const d = await started($, on)
      const r = await firstPrompt($, 'startup')
      expect(r.startLines).toEqual([EVENT_TEXT('session_start')])
      expect(PACKET_READS(d.contextReads)).toEqual([START_PACKET_PATH])
    })

    test('a read the dashboard refuses is one warning line before the event text, never silence and never a guessed packet', async ($, on) => {
      const d = await started($, on)
      d.world.startPacket = { status: 500 }
      const r = await firstPrompt($, 'startup')
      expect(r.startLines).toEqual([`⚠ Could not load your start packet (500: packet boom). Tell the operator this start packet fetch failed.\n${EVENT_TEXT('session_start')}`])
    })

    test('a packet that came inline (a dashboard MCP older than the dashboard) is a failure that names the remedy, not a line built from the text', async ($, on) => {
      const d = await started($, on)
      d.world.startPacket = { profile: 'orchestrator', text: 'the whole role text, which the client would cut to a preview' }
      const r = await firstPrompt($, 'startup')
      expect(r.startLines).toEqual([`⚠ Could not load your start packet (old_mcp: the dashboard MCP server answered the packet inline, with no file: reconnect it with /mcp or start a new session). Tell the operator this start packet fetch failed.\n${EVENT_TEXT('session_start')}`])
    })

    test('an answer of no known shape is a failure, not a pointer', async ($, on) => {
      const d = await started($, on)
      d.world.startPacket = { profile: 'orchestrator', path: '', bytes: 1, instruction: 'x' }
      const r = await firstPrompt($, 'startup')
      expect(r.startLines).toEqual([`⚠ Could not load your start packet (bad_response: startPacket is not {profile, path, bytes, instruction}). Tell the operator this start packet fetch failed.\n${EVENT_TEXT('session_start')}`])
    })

    test("a signed-in session on no plan that holds a card is told its packet's file before the event text", async ($, on) => {
      const d = await started($, on, { connected: false })
      Object.assign(d.world, { agent: { id: 6, name: 'Tendai', avatar_url: null }, card: { id: 'DX-77', title: 'One-off fix' } })
      d.world.startPacket = { ...FILE, profile: 'work' }
      const r = await firstPrompt($, 'startup')
      expect(r.startLines).toEqual([`${POINTER.replace('the orchestrator role', 'the work role')}\n${EVENT_TEXT('session_start')}`])
    })

    // a /clear reads the session_start text alone (the model's own connect brings the packet), a fork nothing; that text is pinned in context-event.test.tsx
    test('a clear reads no packet, a fork has no start, a sub-agent no packet: no packet is read', async ($, on) => {
      const d = await started($, on)
      d.world.startPacket = FILE
      await firstPrompt($, 'clear')
      expect((await firstPrompt($, 'fork')).startLines).toBeUndefined()
      const r = await $.classic.SubagentStart(START)
      await d.clock.settle()
      expect(r.additionalContext).toEqual([EVENT_TEXT('sub_agent_start')])
      expect(PACKET_READS(d.contextReads)).toEqual([])
    })
  })
}

// CP-61: a fresh session usually has no dashboard key yet, so its first session_connect answers approval_required and the plugin's sign-in
// watch repeats that call until the person approves. The watch's call is then the one that BINDS the session, so the dashboard builds the
// packet for its answer; the model's own connect after the wake note is a reconnect, answered with none. So the packet the watch's answer
// carries is told in the wake note itself, and the plugin makes no route read of its own for it.
for (const surface of SURFACES) {
  describe(`the start packet of a sign-in approved on ${surface}`, () => {
    const CALL = { tool: 'mcp__plugin_50arms_platform__session_connect', target: 'PLAN-23', title: 'PLAN-23: 50 Arms plugin' } as any
    const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
    // the model's own call answers the request, as the MCP does, and the watch takes the wait from there
    async function modelAsksToSignIn($: any, on: any, packet: unknown) {
      on('tool.call', { tool: 'mcp__plugin_50arms_platform__session_connect' }, () => ({ result: {}, text: JSON.stringify(APPROVAL_REQUIRED), isError: false }) as any)
      const d = dashboard(on, { signedOut: 'signed-out' })
      await startSession($, d, surface)
      d.world.startPacket = packet
      d.contextReads.length = 0
      await $.tool.call(CALL)
      await d.clock.settle()
      d.world.signIn.approved = true
      await d.clock.advance(45_000)
      await d.clock.settle()
      return d
    }

    test("the model's own sign-in: the wake note carries the packet's file the binding connect answered, and no route is read", async ($, on) => {
      const d = await modelAsksToSignIn($, on, FILE)
      expect(woken(d)).toEqual([relayLine(`${signInApprovedNote(CONFIRM_CODE, 'PLAN-23')}
${POINTER}`)])
      expect(PACKET_READS(d.contextReads)).toEqual([])
    })

    test('a binding connect whose packet is malformed: the wake note is followed by one warning line, never a guessed pointer', async ($, on) => {
      const d = await modelAsksToSignIn($, on, { profile: 'orchestrator', path: '', bytes: 1, instruction: 'x' })
      expect(woken(d)).toEqual([
        relayLine(`${signInApprovedNote(CONFIRM_CODE, 'PLAN-23')}
⚠ Could not load your start packet (bad_response: startPacket is not {profile, path, bytes, instruction}). Tell the operator this start packet fetch failed.`),
      ])
    })

    test('a connect that builds no packet (null) adds nothing to the wake note', async ($, on) => {
      const d = await modelAsksToSignIn($, on, null)
      expect(woken(d)).toEqual([relayLine(signInApprovedNote(CONFIRM_CODE, 'PLAN-23'))])
    })

    test("the Sign in button: the note that the operator signed the session in carries the packet's file", async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      d.world.signedOut = 'lapsed'
      for (let i = 0; i < 3; i++) await forceRefresh($, d)
      d.world.startPacket = FILE
      d.contextReads.length = 0
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      d.world.signIn.approved = true
      await d.clock.advance(45_000)
      await d.clock.settle()
      expect(woken(d)).toEqual([relayLine(`${signInNote('PLAN-23', true)}
${POINTER}`)])
      expect(PACKET_READS(d.contextReads)).toEqual([])
    })
  })
}
