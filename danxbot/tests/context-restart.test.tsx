// DX-4234 (DX-3928, DX-4632): a session that is not on a plan but replaced one that was is told which plan it was on and how many events wait.
// The session's own danx-dashboard server finds the earlier session and answers through its `restart_notice` tool (no arguments); this hook
// tells the model that answer and surfaces a stop. Both surfaces: the model's context and the failure line.
import { describe, expect, test } from 'claude-code/testing'

import { CONTEXT_DEADLINE_MS, restartFailureLine } from '../hooks/context/events'
import { SURFACES, dashboard, firstPrompt, startSession } from './plan-kit'

const NOTICE = 'This session replaced one on PLAN-23; 3 events wait.'
const stopped = (reason: string, detail: string) => ({ stopped: { reason, detail, fix: 'continue without it; call plan_connect' } })

// A restarted session has a new id and holds NO key: signed out until plan_connect is approved. That is the state the notice is for.
const SIGNED_OUT = { connected: false, signedOut: 'signed-out' } as const

for (const surface of SURFACES) {
  describe(`the restart notice on ${surface}`, () => {
    async function started($: any, on: any, options: Parameters<typeof dashboard>[1] = SIGNED_OUT) {
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
        const r = await firstPrompt($, source)
        expect(r.told).toEqual([NOTICE])
        expect(d.restartCalls).toEqual([{}])
      })
    }

    test('after a compaction, and on clear or fork, the tool is not called and nothing is told', async ($, on) => {
      const d = await started($, on)
      d.world.restart.json = { notice: NOTICE }
      for (const source of ['compact', 'clear', 'fork'] as const) {
        expect((await firstPrompt($, source)).told).toBeUndefined()
      }
      expect(d.restartCalls).toEqual([])
    })

    test('a connected session is told its event text, never the restart notice', async ($, on) => {
      const d = await started($, on, {})
      d.world.restart.json = { notice: NOTICE }
      const r = await firstPrompt($, 'resume')
      expect(r.told).toEqual(['The session_resume text.'])
      expect(d.restartCalls).toEqual([])
    })

    test('`{notice: null}` is quiet (a project that never connected a plan hears nothing)', async ($, on) => {
      const d = await started($, on)
      expect((await firstPrompt($, 'startup')).told).toBeUndefined()
      expect(d.restartCalls).toEqual([{}])
    })

    for (const signedOut of ['signed-out', 'lapsed', 'revoked'] as const) {
      test(`a ${signedOut} session is told the notice: the plans read cannot answer, the tool needs no key`, async ($, on) => {
        const d = await started($, on, { connected: false, signedOut })
        d.world.restart.json = { notice: NOTICE }
        expect((await firstPrompt($, 'startup')).told).toEqual([NOTICE])
        expect(d.restartCalls).toEqual([{}])
      })
    }

    test('a signed-out session is never told the notice after a compaction, a clear or a fork, and the tool is not called', async ($, on) => {
      const d = await started($, on)
      d.world.restart.json = { notice: NOTICE }
      for (const source of ['compact', 'clear', 'fork'] as const) {
        expect((await firstPrompt($, source)).told).toBeUndefined()
      }
      expect(d.restartCalls).toEqual([])
    })

    test('a session that holds a key but is on no plan (a person who signed in and has not connected) is told the notice too', async ($, on) => {
      const d = await started($, on, { connected: false })
      d.world.restart.json = { notice: NOTICE }
      expect((await firstPrompt($, 'resume')).told).toEqual([NOTICE])
    })

    for (const reason of ['no_session_id', 'lookup_failed', 'lookup_timeout'] as const) {
      test(`a \`${reason}\` stop is one warning line naming the reason and detail, never quiet`, async ($, on) => {
        const d = await started($, on)
        d.world.restart.json = stopped(reason, 'the detail')
        const r = await firstPrompt($, 'startup')
        expect(r.told).toEqual([restartFailureLine(`${reason}: the detail. continue without it; call plan_connect`)])
        expect(r.told![0]).toMatch(/^⚠ Could not load the restart notice \(.*\)\. Tell the operator if this session should be plan-connected\.$/)
      })
    }

    test('a call the engine rejects is the warning line with the rejection', async ($, on) => {
      const d = await started($, on)
      d.world.restart.deny = 'boom'
      const r = await firstPrompt($, 'startup')
      expect(r.told![0]).toContain('Could not load the restart notice (error: ')
      expect(r.told![0]).toContain('boom')
    })

    test('an error result is the warning line with its text', async ($, on) => {
      const d = await started($, on)
      d.world.restart.raw = { content: [{ type: 'text', text: 'tool blew up' }], isError: true }
      expect((await firstPrompt($, 'startup')).told).toEqual([restartFailureLine('error: tool blew up')])
    })

    for (const [name, text] of [['text that is not JSON', 'nope'], ['an answer with neither a notice nor a stop', '{}'], ['an empty notice', '{"notice":""}'], ['a non-string notice', '{"notice":3}']] as const) {
      test(`${name} is a failure, never papered over`, async ($, on) => {
        const d = await started($, on)
        d.world.restart.raw = { content: [{ type: 'text', text }], isError: false }
        const r = await firstPrompt($, 'startup')
        expect(r.told![0]).toContain('Could not load the restart notice (bad_response')
      })
    }

    test('the server owns the restart_notice deadline: its lookup_timeout stop at 8 s arrives with its fix text, not a plugin timeout line', async ($, on) => {
      const d = await started($, on)
      d.world.restart = { json: stopped('lookup_timeout', 'the lookup did not finish within 8000 ms'), delayMs: CONTEXT_DEADLINE_MS }
      const pending = firstPrompt($, 'startup')
      await d.clock.advance(CONTEXT_DEADLINE_MS)
      const r = await pending
      expect(r.told).toEqual([restartFailureLine('lookup_timeout: the lookup did not finish within 8000 ms. continue without it; call plan_connect')])
      expect(r.told![0]).toContain('call plan_connect')
    })

    test('DX-3421: a plans read that fails with a dashboard fault is silent for the event text, and the restart notice is still asked', async ($, on) => {
      const d = await started($, on, { connected: false })
      d.world.plansStatus = 500
      d.world.restart.json = { notice: NOTICE }
      const r = await firstPrompt($, 'startup')
      expect(r.told).toEqual([NOTICE])
      expect(d.restartCalls).toEqual([{}])
    })

    test('DX-3421: a plans read that fails with a dashboard fault and no notice is quiet', async ($, on) => {
      const d = await started($, on, { connected: false })
      d.world.plansStatus = 503
      expect((await firstPrompt($, 'resume')).told).toBeUndefined()
      expect(d.contextReads.filter(p => p.startsWith('/api/reminders/event/'))).toEqual([])
    })

    test('a slow answer inside the deadline is told', async ($, on) => {
      const d = await started($, on)
      d.world.restart = { json: { notice: NOTICE }, delayMs: 6_000 }
      const pending = firstPrompt($, 'startup')
      await d.clock.advance(6_000)
      expect((await pending).told).toEqual([NOTICE])
    })

    test('R-2: the restart notice is the server’s own tool; nothing spawns the danx-dashboard-mcp CLI', async ($, on) => {
      const d = await started($, on)
      await firstPrompt($, 'startup')
      expect(d.readers).toEqual([])
    })
  })
}
