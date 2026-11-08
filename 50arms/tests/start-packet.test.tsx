import "./run-tests-with-npm-test.generated"
// CP-61 / DX-6733: a main session's start packet. At a session start (startup, resume) and after a compaction the plugin reads the dashboard's
// `GET /api/plan-sessions/me/start-packet` ITSELF, once, and tells the model the file the session's own dashboard server wrote, so the agent makes no
// route call, no chunked role read and no skill re-invoke of its own. The wording of the packet is the dashboard's; the plugin's two lines are pinned
// literally (not imported), so a reworded production text must fail here.
import { describe, expect } from 'claude-code/testing'

import { START_PACKET_PATH } from '../hooks/context/packet'
import { DEFAULT_BRIEFING, EVENT_TEXT, SURFACES, dashboard, firstPrompt, startSession, test } from './plan-kit'

const START = { agent_id: 'a1', agent_type: '50arms:worker-sonnet-high' }
// what the session's dashboard server answers in place of the packet's text (spillStartPacket): where the file is and the one Read that takes it whole
const FILE = {
  profile: 'orchestrator',
  path: '/tmp/danx-start-packet/orchestrator-0123456789abcdef.md',
  bytes: 78688,
  instruction: 'Read this file now, whole, in ONE Read call with allow_large: true and no offset or limit. It is your start packet: your role\'s workflow, then what you hold now.',
}
const POINTER = `[50 ARMS] Your start packet is already fetched for you, so call no start-packet route. File: ${FILE.path} (78688 bytes, the orchestrator role). ${FILE.instruction}`
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
      test(`a connected session's ${source} is told the packet's file after the ${event} text, from one read`, async ($, on) => {
        const d = await started($, on)
        d.world.startPacket = FILE
        const r = await firstPrompt($, source)
        expect(r.startLines).toEqual([`${EVENT_TEXT(event)}\n${POINTER}`])
        expect(PACKET_READS(d.contextReads)).toEqual([START_PACKET_PATH])
      })
    }

    test("a compaction is told the event text, then the packet's file, then the resume briefing, from one read", async ($, on) => {
      const d = await started($, on)
      d.world.startPacket = FILE
      const r = await firstPrompt($, 'compact')
      expect(r.startLines).toEqual([`${EVENT_TEXT('after_compaction')}\n${POINTER}\n${DEFAULT_BRIEFING}`])
      expect(PACKET_READS(d.contextReads)).toEqual([START_PACKET_PATH])
    })

    test('a session that holds nothing is told nothing of a packet (the dashboard answers null)', async ($, on) => {
      const d = await started($, on)
      const r = await firstPrompt($, 'startup')
      expect(r.startLines).toEqual([EVENT_TEXT('session_start')])
      expect(PACKET_READS(d.contextReads)).toEqual([START_PACKET_PATH])
    })

    test('a read the dashboard refuses is one warning line after the event text, never silence and never a guessed packet', async ($, on) => {
      const d = await started($, on)
      d.world.startPacket = { status: 500 }
      const r = await firstPrompt($, 'startup')
      expect(r.startLines).toEqual([`${EVENT_TEXT('session_start')}\n⚠ Could not load your start packet (500: packet boom). Tell the operator this start packet fetch failed.`])
    })

    test('a packet that came inline (a dashboard MCP older than the dashboard) is a failure that names the remedy, not a line built from the text', async ($, on) => {
      const d = await started($, on)
      d.world.startPacket = { profile: 'orchestrator', text: 'the whole role text, which the client would cut to a preview' }
      const r = await firstPrompt($, 'startup')
      expect(r.startLines).toEqual([`${EVENT_TEXT('session_start')}\n⚠ Could not load your start packet (old_mcp: the dashboard MCP server answered the packet inline, with no file: reconnect it with /mcp or start a new session). Tell the operator this start packet fetch failed.`])
    })

    test('an answer of no known shape is a failure, not a pointer', async ($, on) => {
      const d = await started($, on)
      d.world.startPacket = { profile: 'orchestrator', path: '', bytes: 1, instruction: 'x' }
      const r = await firstPrompt($, 'startup')
      expect(r.startLines).toEqual([`${EVENT_TEXT('session_start')}\n⚠ Could not load your start packet (bad_response: startPacket is not {profile, path, bytes, instruction}). Tell the operator this start packet fetch failed.`])
    })

    test("a signed-in session on no plan that holds a card is told its packet's file after the event text", async ($, on) => {
      const d = await started($, on, { connected: false })
      Object.assign(d.world, { agent: { id: 6, name: 'Tendai', avatar_url: null }, card: { id: 'DX-77', title: 'One-off fix' } })
      d.world.startPacket = { ...FILE, profile: 'work' }
      const r = await firstPrompt($, 'startup')
      expect(r.startLines).toEqual([`${EVENT_TEXT('session_start')}\n${POINTER.replace('the orchestrator role', 'the work role')}`])
    })

    test('clear and fork have no start, a sub-agent no packet: nothing is read', async ($, on) => {
      const d = await started($, on)
      d.world.startPacket = FILE
      for (const source of ['clear', 'fork'] as const) expect((await firstPrompt($, source)).startLines).toBeUndefined()
      const r = await $.classic.SubagentStart(START)
      await d.clock.settle()
      expect(r.additionalContext).toEqual([EVENT_TEXT('sub_agent_start')])
      expect(PACKET_READS(d.contextReads)).toEqual([])
    })
  })
}
