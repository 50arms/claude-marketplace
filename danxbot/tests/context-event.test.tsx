// DX-4234: the registry's event text for a plan-connected session (SessionStart startup / resume / compact, and every sub-agent's start),
// fetched through the session's own danx-dashboard server (R-2: `danxbot_api`, never the package's CLI), and the silence rules: nothing for
// a session that is not on a plan, one warning line for a fetch that failed, quiet for a session with no usable key.
import { describe, expect, test } from 'claude-code/testing'

import { CONTEXT_DEADLINE_MS, DEADLINE_REASON, SERVER_NOT_CONNECTED_REASON, eventFailureLine } from '../hooks/context/events'
import { EVENT_TEXT, SURFACES, dashboard, firstPrompt, startSession } from './plan-kit'

const START = { agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high' }
const EVENT_PATHS = (reads: string[]) => reads.filter(p => p.startsWith('/api/reminders/event/'))

for (const surface of SURFACES) {
  describe(`the event text on ${surface}`, () => {
    async function started($: any, on: any, options: Parameters<typeof dashboard>[1] = {}) {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.SubagentStart', () => ({}) as any)
      const d = dashboard(on, options)
      await startSession($, d, surface)
      d.contextReads.length = 0
      return d
    }

    for (const [source, event] of [['startup', 'session_start'], ['resume', 'session_resume'], ['compact', 'after_compaction']] as const) {
      test(`a connected session's ${source} is told the ${event} text`, async ($, on) => {
        const d = await started($, on)
        const r = await firstPrompt($, source)
        expect(r.startLines).toEqual([EVENT_TEXT(event)])
        expect(EVENT_PATHS(d.contextReads)).toEqual([`/api/reminders/event/${event}`])
      })
    }

    test('clear and fork have no event: nothing is read, nothing is told', async ($, on) => {
      const d = await started($, on)
      for (const source of ['clear', 'fork'] as const) {
        const r = await firstPrompt($, source)
        expect(r.startLines).toBeUndefined()
      }
      expect(d.contextReads).toEqual([])
    })

    test("a connected session's sub-agent is told the sub_agent_start text", async ($, on) => {
      const d = await started($, on)
      const r = await $.classic.SubagentStart(START)
      await d.clock.settle()
      expect(r.additionalContext).toEqual([EVENT_TEXT('sub_agent_start')])
      expect(EVENT_PATHS(d.contextReads)).toEqual(['/api/reminders/event/sub_agent_start'])
    })

    test('a session that is not on a plan is told no event text, at start, resume, compaction or a sub-agent start', async ($, on) => {
      const d = await started($, on, { connected: false })
      for (const source of ['startup', 'resume', 'compact'] as const) {
        const r = await firstPrompt($, source)
        expect(r.startLines).toBeUndefined()
      }
      expect((await $.classic.SubagentStart(START)).additionalContext).toBeUndefined()
      await d.clock.settle()
      expect(EVENT_PATHS(d.contextReads)).toEqual([])
    })

    test('a fetch that fails is one warning line naming the event and the reason', async ($, on) => {
      const d = await started($, on)
      d.world.eventText.session_resume = { status: 500 }
      const r = await firstPrompt($, 'resume')
      expect(r.startLines).toEqual([eventFailureLine('session_resume', '500: event boom')])
      expect(r.startLines![0]).toBe('⚠ Could not load the "session_resume" event text from the danxbot reminder registry (500: event boom). Tell the operator this event hook fetch failed.')
    })

    test('an empty text is that failure, never a silent success', async ($, on) => {
      const d = await started($, on)
      d.world.eventText.sub_agent_start = ''
      const r = await $.classic.SubagentStart(START)
      await d.clock.settle()
      expect(r.additionalContext).toEqual([eventFailureLine('sub_agent_start', 'empty_response: the dashboard returned an empty text')])
    })

    test('a CONNECTED session (its record is on disk) whose plans read fails is told one warning line, at start and at a sub-agent start', async ($, on) => {
      const d = await started($, on)
      d.world.plansStatus = 500
      const r = await firstPrompt($, 'startup')
      expect(r.startLines).toEqual([eventFailureLine('session_start', '500: plans boom')])
      expect((await $.classic.SubagentStart(START)).additionalContext).toEqual([eventFailureLine('sub_agent_start', '500: plans boom')])
      await d.clock.settle()
      expect(EVENT_PATHS(d.contextReads)).toEqual([])
    })

    test('DX-3421: a session with no record on disk whose plans read fails is quiet: it is not known to be on a plan', async ($, on) => {
      const d = await started($, on, { connected: false })
      d.world.plansStatus = 500
      expect((await firstPrompt($, 'resume')).startLines).toBeUndefined()
      expect((await $.classic.SubagentStart(START)).additionalContext).toBeUndefined()
      await d.clock.settle()
      expect(EVENT_PATHS(d.contextReads)).toEqual([])
    })

    test('a connected session whose call is rejected (the dashboard times out) is told the one warning line too', async ($, on) => {
      const d = await started($, on, { mcp: 'flaky' })
      const r = await firstPrompt($, 'startup')
      expect(r.startLines).toEqual([eventFailureLine('session_start', 'mcp: danxbot: $.mcp.call: request timed out after 60000ms')])
      expect(EVENT_PATHS(d.contextReads)).toEqual([])
    })

    for (const signedOut of ['signed-out', 'lapsed', 'revoked'] as const) {
      test(`a ${signedOut} session is quiet: its own tools tell the model`, async ($, on) => {
        const d = await started($, on, { signedOut })
        expect((await firstPrompt($, 'resume')).startLines).toBeUndefined()
        expect((await $.classic.SubagentStart(START)).additionalContext).toBeUndefined()
        await d.clock.settle()
      })
    }

    test('a CONNECTED session whose plugin server is not connected at the deadline is told so in one warning line, and the poll stops there', async ($, on) => {
      const d = await started($, on, { mcp: 'down' })
      const pending = firstPrompt($, 'startup')
      await d.clock.advance(CONTEXT_DEADLINE_MS)
      const r = await pending
      expect(r.startLines).toEqual([eventFailureLine('session_start', SERVER_NOT_CONNECTED_REASON)])
      // no event text is read (the relay's own plan reads, DX-4233, are not this lookup's)
      expect(EVENT_PATHS(d.contextReads)).toEqual([])
      // the poll is not left running in the background: a poll left going would read the tool list every 500 ms (about 60 more reads in 30 s);
      // the few reads the plugin's own load retries make are not it
      const polled = d.toolLists.n
      await d.clock.advance(30_000)
      expect(d.toolLists.n - polled).toBeLessThan(5)
    })

    test('a session that is not on a plan whose plugin server is not connected at the deadline is quiet', async ($, on) => {
      const d = await started($, on, { mcp: 'down', connected: false })
      const pending = firstPrompt($, 'startup')
      await d.clock.advance(CONTEXT_DEADLINE_MS)
      expect((await pending).startLines).toBeUndefined()
      // no event text is read (the relay's own plan reads, DX-4233, are not this lookup's)
      expect(EVENT_PATHS(d.contextReads)).toEqual([])
    })

    test('a session whose plugin server comes up during the wait is told its text', async ($, on) => {
      const d = await started($, on, { mcp: 'down' })
      const pending = firstPrompt($, 'resume')
      await d.clock.advance(1_000)
      d.setMcp('up')
      await d.clock.advance(30_000)
      const r = await pending
      expect(r.startLines).toEqual([EVENT_TEXT('session_resume')])
    })

    test('ONE deadline: a dashboard that never answers is one timeout line at the deadline, not a held start', async ($, on) => {
      const d = await started($, on)
      d.world.contextHangs = true
      const pending = firstPrompt($, 'startup')
      await d.clock.advance(CONTEXT_DEADLINE_MS - 1)
      let settled = false
      void pending.then(() => (settled = true))
      await d.clock.settle()
      expect(settled).toBe(false)
      await d.clock.advance(1)
      const r = await pending
      expect(r.startLines).toEqual([eventFailureLine('session_start', DEADLINE_REASON)])
      expect(r.startLines![0]).toContain('timeout: no response within 8s')
    })

    test('a hung dashboard for a session with no record on disk is quiet at the deadline', async ($, on) => {
      const d = await started($, on, { connected: false })
      d.world.contextHangs = true
      const pending = firstPrompt($, 'startup')
      await d.clock.advance(CONTEXT_DEADLINE_MS)
      expect((await pending).startLines).toBeUndefined()
    })

    test('the wait for the server and the reads share ONE deadline: about 5 s of waiting leaves too little for a read that takes 4', async ($, on) => {
      const d = await started($, on, { mcp: 'down' })
      d.world.contextDelayMs = 4_000
      const pending = firstPrompt($, 'resume')
      await d.clock.advance(5_000)
      d.setMcp('up')
      await d.clock.advance(CONTEXT_DEADLINE_MS)
      expect((await pending).startLines).toEqual([eventFailureLine('session_resume', DEADLINE_REASON)])
    })

    test('ONE deadline over the SUM of the reads: each read is quick, the lookup together is not', async ($, on) => {
      const d = await started($, on)
      d.world.contextDelayMs = 3_000
      const pending = firstPrompt($, 'resume')
      // the plan read answers at 3 s, the event read at 6 s: inside the deadline
      await d.clock.advance(6_000)
      expect((await pending).startLines).toEqual([EVENT_TEXT('session_resume')])
    })

    test('a sub-agent start has the same deadline', async ($, on) => {
      const d = await started($, on)
      d.world.contextHangs = true
      const pending = $.classic.SubagentStart(START)
      await d.clock.advance(CONTEXT_DEADLINE_MS)
      expect((await pending).additionalContext).toEqual([eventFailureLine('sub_agent_start', DEADLINE_REASON)])
      await d.clock.settle()
    })

    test('a sub-agent start does not wait for a server that is not connected', async ($, on) => {
      const d = await started($, on, { mcp: 'down' })
      const r = await $.classic.SubagentStart(START)
      await d.clock.settle()
      expect(r.additionalContext).toBeUndefined()
      expect(EVENT_PATHS(d.contextReads)).toEqual([])
    })

    test('R-2: the reads go through the session’s own server; nothing spawns the danx-dashboard-mcp CLI', async ($, on) => {
      const d = await started($, on)
      // a running sub-agent with a transcript makes the live reader start: the recorder is seen to record a spawn, so "no CLI spawn" cannot pass vacuously
      d.world.agents = [{ id: 'a1', type: 'danxbot:worker-sonnet-high', description: 'Build a1', status: 'running' }]
      await firstPrompt($, 'startup')
      await $.classic.SubagentStart({ ...START, transcript_path: '/work/main.jsonl' })
      await d.clock.settle()
      expect(d.contextReads).toContain('/api/reminders/event/session_start')
      expect(d.readers).toHaveLength(1)
      expect(d.readers.filter(r => /event-text|restart-notice/.test(r.argv.join(' ')))).toEqual([])
    })
  })
}
