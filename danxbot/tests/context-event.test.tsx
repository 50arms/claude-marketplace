// DX-4234: the registry's event text for a plan-connected session (SessionStart startup / resume / compact, and every sub-agent's start),
// fetched through the session's own danx-dashboard server (R-2: `danxbot_api`, never the package's CLI), and the silence rules: nothing for
// a session that is not on a plan, one warning line for a fetch that failed, quiet for a session with no usable key.
import { describe, expect, test } from 'claude-code/testing'

import { eventFailureLine } from '../hooks/context/events'
import { EVENT_TEXT, SURFACES, dashboard, startSession } from './plan-kit'

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
        const r = await $.classic.SessionStart({ source, cwd: '/work' })
        expect(r.additionalContext).toEqual([EVENT_TEXT(event)])
        expect(EVENT_PATHS(d.contextReads)).toEqual([`/api/reminders/event/${event}`])
      })
    }

    test('clear and fork have no event: nothing is read, nothing is told', async ($, on) => {
      const d = await started($, on)
      for (const source of ['clear', 'fork'] as const) {
        const r = await $.classic.SessionStart({ source, cwd: '/work' })
        expect(r.additionalContext).toBeUndefined()
      }
      expect(d.contextReads).toEqual([])
    })

    test("a connected session's sub-agent is told the sub_agent_start text", async ($, on) => {
      const d = await started($, on)
      const r = await $.classic.SubagentStart(START)
      expect(r.additionalContext).toEqual([EVENT_TEXT('sub_agent_start')])
      expect(EVENT_PATHS(d.contextReads)).toEqual(['/api/reminders/event/sub_agent_start'])
    })

    test('a session that is not on a plan is told no event text, at start, resume, compaction or a sub-agent start', async ($, on) => {
      const d = await started($, on, { connected: false })
      for (const source of ['startup', 'resume', 'compact'] as const) {
        const r = await $.classic.SessionStart({ source, cwd: '/work' })
        expect(r.additionalContext).toBeUndefined()
      }
      expect((await $.classic.SubagentStart(START)).additionalContext).toBeUndefined()
      expect(EVENT_PATHS(d.contextReads)).toEqual([])
    })

    test('a fetch that fails is one warning line naming the event and the reason', async ($, on) => {
      const d = await started($, on)
      d.world.eventText.session_resume = { status: 500 }
      const r = await $.classic.SessionStart({ source: 'resume', cwd: '/work' })
      expect(r.additionalContext).toEqual([eventFailureLine('session_resume', '500: event boom')])
      expect(r.additionalContext![0]).toBe('⚠ Could not load the "session_resume" event text from the danxbot reminder registry (500: event boom). Tell the operator this event hook fetch failed.')
    })

    test('an empty text is that failure, never a silent success', async ($, on) => {
      const d = await started($, on)
      d.world.eventText.sub_agent_start = ''
      const r = await $.classic.SubagentStart(START)
      expect(r.additionalContext).toEqual([eventFailureLine('sub_agent_start', 'empty_response: the dashboard returned an empty text')])
    })

    test('a session whose plan cannot be read (the server answers an error) is told the same one line', async ($, on) => {
      const d = await started($, on, { mcp: 'flaky' })
      const r = await $.classic.SessionStart({ source: 'startup', cwd: '/work' })
      expect(r.additionalContext).toEqual([eventFailureLine('session_start', 'mcp: danxbot: $.mcp.call: request timed out after 60000ms')])
      expect(EVENT_PATHS(d.contextReads)).toEqual([])
    })

    for (const signedOut of ['signed-out', 'lapsed', 'revoked'] as const) {
      test(`a ${signedOut} session is quiet: its own tools tell the model`, async ($, on) => {
        await started($, on, { signedOut })
        expect((await $.classic.SessionStart({ source: 'resume', cwd: '/work' })).additionalContext).toBeUndefined()
        expect((await $.classic.SubagentStart(START)).additionalContext).toBeUndefined()
      })
    }

    test("a session whose plugin server is not connected (yet) is read again after each start retry, then stays quiet", async ($, on) => {
      const d = await started($, on, { mcp: 'down' })
      const pending = $.classic.SessionStart({ source: 'startup', cwd: '/work' })
      await d.clock.advance(30_000)
      const r = await pending
      expect(r.additionalContext).toBeUndefined()
      // the first read and one after each of the three waits
      expect(d.contextReads).toEqual(['/api/plans', '/api/plans', '/api/plans', '/api/plans'])
    })

    test('a session whose plugin server comes up during the wait is told its text', async ($, on) => {
      const d = await started($, on, { mcp: 'down' })
      const pending = $.classic.SessionStart({ source: 'resume', cwd: '/work' })
      await d.clock.advance(1_000)
      d.setMcp('up')
      await d.clock.advance(30_000)
      const r = await pending
      expect(r.additionalContext).toEqual([EVENT_TEXT('session_resume')])
    })

    test('the old standby server never connects, so the wait is skipped: one read, quiet', async ($, on) => {
      const d = await started($, on, { mcp: 'stale' })
      const r = await $.classic.SessionStart({ source: 'startup', cwd: '/work' })
      expect(r.additionalContext).toBeUndefined()
      expect(d.contextReads).toEqual(['/api/plans'])
    })

    test('a sub-agent start does not wait for a server that is not connected', async ($, on) => {
      const d = await started($, on, { mcp: 'down' })
      const r = await $.classic.SubagentStart(START)
      expect(r.additionalContext).toBeUndefined()
      expect(d.contextReads).toEqual(['/api/plans'])
    })

    test('R-2: the reads go through the session’s own server; nothing spawns the danx-dashboard-mcp CLI', async ($, on) => {
      const d = await started($, on)
      await $.classic.SessionStart({ source: 'startup', cwd: '/work' })
      await $.classic.SubagentStart(START)
      expect(d.contextReads).toContain('/api/reminders/event/session_start')
      expect(d.readers.filter(r => /event-text|restart-notice/.test(r.argv.join(' ')))).toEqual([])
    })
  })
}
