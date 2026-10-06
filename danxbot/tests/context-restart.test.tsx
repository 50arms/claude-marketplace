// DX-4234 (DX-3928, DX-4632): a session that is not on a plan but replaced one that was is told which plan it was on and how many events wait.
// The session's own danx-dashboard server finds the earlier session and answers through its `restart_notice` tool (no arguments); this hook
// tells the model that answer and surfaces a stop. Both surfaces: the model's context and the failure line.
import { describe, expect, test } from 'claude-code/testing'

import { CONTEXT_DEADLINE_MS, deadlineReason, eventFailureLine, restartFailureLine } from '../hooks/context/events'
import { SURFACES, dashboard, startSession } from './plan-kit'

const NOTICE = 'This session replaced one on PLAN-23; 3 events wait.'
const stopped = (reason: string, detail: string) => ({ stopped: { reason, detail, fix: 'continue without it; call plan_connect' } })

for (const surface of SURFACES) {
  describe(`the restart notice on ${surface}`, () => {
    async function started($: any, on: any, options: Parameters<typeof dashboard>[1] = { connected: false }) {
      on('classic.SessionStart', () => ({}) as any)
      const d = dashboard(on, options)
      await startSession($, d, surface)
      d.contextReads.length = 0
      return d
    }

    for (const source of ['startup', 'resume'] as const) {
      test(`a not-connected ${source} is told the notice the server answers, asked with no arguments`, async ($, on) => {
        const d = await started($, on)
        d.world.restart.json = { notice: NOTICE }
        const r = await $.classic.SessionStart({ source, cwd: '/work' })
        expect(r.additionalContext).toEqual([NOTICE])
        expect(d.restartCalls).toEqual([{}])
      })
    }

    test('after a compaction, and on clear or fork, the tool is not called and nothing is told', async ($, on) => {
      const d = await started($, on)
      d.world.restart.json = { notice: NOTICE }
      for (const source of ['compact', 'clear', 'fork'] as const) {
        expect((await $.classic.SessionStart({ source, cwd: '/work' })).additionalContext).toBeUndefined()
      }
      expect(d.restartCalls).toEqual([])
    })

    test('a connected session is told its event text, never the restart notice', async ($, on) => {
      const d = await started($, on, {})
      d.world.restart.json = { notice: NOTICE }
      const r = await $.classic.SessionStart({ source: 'resume', cwd: '/work' })
      expect(r.additionalContext).toEqual(['The session_resume text.'])
      expect(d.restartCalls).toEqual([])
    })

    test('`{notice: null}` is quiet (a project that never connected a plan hears nothing)', async ($, on) => {
      const d = await started($, on)
      expect((await $.classic.SessionStart({ source: 'startup', cwd: '/work' })).additionalContext).toBeUndefined()
      expect(d.restartCalls).toEqual([{}])
    })

    test('a signed-out session is told the notice too: the tool works before sign-in', async ($, on) => {
      const d = await started($, on, { connected: false, signedOut: 'signed-out' })
      d.world.restart.json = { notice: NOTICE }
      expect((await $.classic.SessionStart({ source: 'startup', cwd: '/work' })).additionalContext).toEqual([NOTICE])
    })

    for (const reason of ['no_session_id', 'lookup_failed', 'lookup_timeout'] as const) {
      test(`a \`${reason}\` stop is one warning line naming the reason and detail, never quiet`, async ($, on) => {
        const d = await started($, on)
        d.world.restart.json = stopped(reason, 'the detail')
        const r = await $.classic.SessionStart({ source: 'startup', cwd: '/work' })
        expect(r.additionalContext).toEqual([restartFailureLine(`${reason}: the detail`)])
        expect(r.additionalContext![0]).toMatch(/^⚠ Could not load the restart notice \(.*\)\. Tell the operator if this session should be plan-connected\.$/)
      })
    }

    test('a call the engine rejects is the warning line with the rejection', async ($, on) => {
      const d = await started($, on)
      d.world.restart.deny = 'boom'
      const r = await $.classic.SessionStart({ source: 'startup', cwd: '/work' })
      expect(r.additionalContext![0]).toContain('Could not load the restart notice (error: ')
      expect(r.additionalContext![0]).toContain('boom')
    })

    test('an error result is the warning line with its text', async ($, on) => {
      const d = await started($, on)
      d.world.restart.raw = { content: [{ type: 'text', text: 'tool blew up' }], isError: true }
      expect((await $.classic.SessionStart({ source: 'startup', cwd: '/work' })).additionalContext).toEqual([restartFailureLine('error: tool blew up')])
    })

    for (const [name, text] of [['text that is not JSON', 'nope'], ['an answer with neither a notice nor a stop', '{}'], ['an empty notice', '{"notice":""}'], ['a non-string notice', '{"notice":3}']] as const) {
      test(`${name} is a failure, never papered over`, async ($, on) => {
        const d = await started($, on)
        d.world.restart.raw = { content: [{ type: 'text', text }], isError: false }
        const r = await $.classic.SessionStart({ source: 'startup', cwd: '/work' })
        expect(r.additionalContext![0]).toContain('Could not load the restart notice (bad_response')
      })
    }

    test('ONE deadline: a tool that never answers is cut at 8 s with the session_start timeout line', async ($, on) => {
      const d = await started($, on)
      d.world.restart.hangs = true
      const pending = $.classic.SessionStart({ source: 'startup', cwd: '/work' })
      await d.clock.advance(CONTEXT_DEADLINE_MS)
      expect((await pending).additionalContext).toEqual([eventFailureLine('session_start', deadlineReason())])
    })

    test('a slow answer inside the deadline is told', async ($, on) => {
      const d = await started($, on)
      d.world.restart = { json: { notice: NOTICE }, delayMs: 6_000 }
      const pending = $.classic.SessionStart({ source: 'startup', cwd: '/work' })
      await d.clock.advance(6_000)
      expect((await pending).additionalContext).toEqual([NOTICE])
    })

    test('R-2: the restart notice is the server’s own tool; nothing spawns the danx-dashboard-mcp CLI', async ($, on) => {
      const d = await started($, on)
      await $.classic.SessionStart({ source: 'startup', cwd: '/work' })
      expect(d.readers.filter(r => /restart-notice|restart_notice/.test(r.argv.join(' ')))).toEqual([])
    })
  })
}
