// DX-4234 (DX-3928, DX-4632): a session that is not on a plan but replaced one that was is told which plan it was on and how many events wait.
// The session's own danx-dashboard server finds the earlier session and answers through its `restart_notice` tool (no arguments); this hook
// tells the model that answer and surfaces a stop. Both surfaces: the model's context and the failure line.
import { describe, expect, test } from 'claude-code/testing'

import { CONTEXT_DEADLINE_MS, restartFailureLine } from '../hooks/context/events'
import { SURFACES, dashboard, firstPrompt, startSession } from './plan-kit'

const NOTICE = 'This session replaced one on PLAN-23; 3 events wait.'
const stopped = (reason: string, detail: string) => ({ stopped: { reason, detail, fix: 'continue without it; call plan_connect' } })

const TRANSCRIPT = '/work/main.jsonl'
// DX-4234: what the restart notice is asked with, by the source the session started from (the server's `restart_notice` contract): a resume (a
// desktop fork reports it too) names its transcript, whose copied prefix leads to the session it came from; a clear names the session that just
// ended; a startup names neither and the server scans the project.
const ARGS = { startup: {}, resume: { transcript_path: TRANSCRIPT } } as const
const PREVIOUS = 'sess-previous'

// A restarted session has a new id and holds NO key: signed out until plan_connect is approved. That is the state the notice is for.
const SIGNED_OUT = { connected: false, signedOut: 'signed-out' } as const

for (const surface of SURFACES) {
  describe(`the restart notice on ${surface}`, () => {
    async function started($: any, on: any, options: Parameters<typeof dashboard>[1] = SIGNED_OUT) {
      on('classic.SessionStart', () => ({}) as any)
      on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
      const d = dashboard(on, options)
      await startSession($, d, surface)
      d.contextReads.length = 0
      return d
    }

    for (const source of ['startup', 'resume'] as const) {
      test(`a not-connected ${source} is told the notice the server answers, asked with its source's arguments`, async ($, on) => {
        const d = await started($, on)
        d.world.restart.json = { notice: NOTICE }
        const r = await firstPrompt($, source)
        expect(r.startLines).toEqual([NOTICE])
        expect(d.restartCalls).toEqual([ARGS[source]])
      })
    }

    test('after a compaction or a fork, the tool is not called and nothing is told', async ($, on) => {
      const d = await started($, on)
      d.world.restart.json = { notice: NOTICE }
      for (const source of ['compact', 'fork'] as const) {
        expect((await firstPrompt($, source)).startLines).toBeUndefined()
      }
      expect(d.restartCalls).toEqual([])
    })

    test('a connected session is told its event text, never the restart notice', async ($, on) => {
      const d = await started($, on, {})
      d.world.restart.json = { notice: NOTICE }
      const r = await firstPrompt($, 'resume')
      expect(r.startLines).toEqual(['The session_resume text.'])
      expect(d.restartCalls).toEqual([])
    })

    test('`{notice: null}` is quiet (a project that never connected a plan hears nothing)', async ($, on) => {
      const d = await started($, on)
      d.world.restart.json = { notice: null }
      expect((await firstPrompt($, 'startup')).startLines).toBeUndefined()
      expect(d.restartCalls).toEqual([{}])
    })

    for (const signedOut of ['signed-out', 'lapsed', 'revoked'] as const) {
      test(`a ${signedOut} session is told the notice: the plans read cannot answer, the tool needs no key`, async ($, on) => {
        const d = await started($, on, { connected: false, signedOut })
        d.world.restart.json = { notice: NOTICE }
        expect((await firstPrompt($, 'startup')).startLines).toEqual([NOTICE])
        expect(d.restartCalls).toEqual([{}])
      })
    }

    test('a signed-out session is never told the notice after a compaction or a fork, and the tool is not called', async ($, on) => {
      const d = await started($, on)
      d.world.restart.json = { notice: NOTICE }
      for (const source of ['compact', 'fork'] as const) {
        expect((await firstPrompt($, source)).startLines).toBeUndefined()
      }
      expect(d.restartCalls).toEqual([])
    })

    test('a session that holds a key but is on no plan (a person who signed in and has not connected) is told the notice too', async ($, on) => {
      const d = await started($, on, { connected: false })
      d.world.restart.json = { notice: NOTICE }
      expect((await firstPrompt($, 'resume')).startLines).toEqual([NOTICE])
    })

    for (const reason of ['no_session_id', 'lookup_failed', 'lookup_timeout'] as const) {
      test(`a \`${reason}\` stop is one warning line naming the reason and detail, never quiet`, async ($, on) => {
        const d = await started($, on)
        d.world.restart.json = stopped(reason, 'the detail')
        const r = await firstPrompt($, 'startup')
        expect(r.startLines).toEqual([restartFailureLine(`${reason}: the detail. continue without it; call plan_connect`)])
        expect(r.startLines![0]).toMatch(/^⚠ Could not load the restart notice \(.*\)\. Tell the operator if this session should be plan-connected\.$/)
      })
    }

    test('a call the engine rejects is the warning line with the rejection', async ($, on) => {
      const d = await started($, on)
      d.world.restart.deny = 'boom'
      const r = await firstPrompt($, 'startup')
      expect(r.startLines![0]).toContain('Could not load the restart notice (error: ')
      expect(r.startLines![0]).toContain('boom')
    })

    test('an error result is the warning line with its text', async ($, on) => {
      const d = await started($, on)
      d.world.restart.raw = { content: [{ type: 'text', text: 'tool blew up' }], isError: true }
      expect((await firstPrompt($, 'startup')).startLines).toEqual([restartFailureLine('error: tool blew up')])
    })

    for (const [name, text] of [['text that is not JSON', 'nope'], ['an answer with neither a notice nor a stop', '{}'], ['an empty notice', '{"notice":""}'], ['a non-string notice', '{"notice":3}']] as const) {
      test(`${name} is a failure, never papered over`, async ($, on) => {
        const d = await started($, on)
        d.world.restart.raw = { content: [{ type: 'text', text }], isError: false }
        const r = await firstPrompt($, 'startup')
        expect(r.startLines![0]).toContain('Could not load the restart notice (bad_response')
      })
    }

    test('the server owns the restart_notice deadline: its lookup_timeout stop at 8 s arrives with its fix text, not a plugin timeout line', async ($, on) => {
      const d = await started($, on)
      d.world.restart = { json: stopped('lookup_timeout', 'the lookup did not finish within 8000 ms'), delayMs: CONTEXT_DEADLINE_MS }
      const pending = firstPrompt($, 'startup')
      await d.clock.advance(CONTEXT_DEADLINE_MS)
      const r = await pending
      expect(r.startLines).toEqual([restartFailureLine('lookup_timeout: the lookup did not finish within 8000 ms. continue without it; call plan_connect')])
      expect(r.startLines![0]).toContain('call plan_connect')
    })

    test('DX-3421: a plans read that fails with a dashboard fault is silent for the event text, and the restart notice is still asked', async ($, on) => {
      const d = await started($, on, { connected: false })
      d.world.plansStatus = 500
      d.world.restart.json = { notice: NOTICE }
      const r = await firstPrompt($, 'startup')
      expect(r.startLines).toEqual([NOTICE])
      expect(d.restartCalls).toEqual([{}])
    })

    test('DX-3421: a plans read that fails with a dashboard fault and no notice is quiet', async ($, on) => {
      const d = await started($, on, { connected: false })
      d.world.plansStatus = 503
      expect((await firstPrompt($, 'resume')).startLines).toBeUndefined()
      expect(d.contextReads.filter(p => p.startsWith('/api/reminders/event/'))).toEqual([])
    })

    test('a slow answer inside the deadline is told', async ($, on) => {
      const d = await started($, on)
      d.world.restart = { json: { notice: NOTICE }, delayMs: 6_000 }
      const pending = firstPrompt($, 'startup')
      await d.clock.advance(6_000)
      expect((await pending).startLines).toEqual([NOTICE])
    })

    // a clear names the session that just ended: the plugin's session.end hook remembers it and the start takes it. Only an ended session that held
    // a connection record (it was on a plan) is asked about; any other clear is not a restart of anything and stays quiet (DX-3421).
    async function cleared($: any, on: any, options: Parameters<typeof dashboard>[1] = SIGNED_OUT, ended: string | null = PREVIOUS, hadRecord = true) {
      const d = await started($, on, options)
      if (ended !== null) {
        await $.session.end({ reason: 'clear', sessionId: ended } as any)
        if (hadRecord) d.world.records.push(ended)
      }
      return d
    }

    test('a clear whose ended session was on a plan is asked with its id, and told the notice', async ($, on) => {
      const d = await cleared($, on)
      d.world.restart.json = { notice: NOTICE }
      expect((await firstPrompt($, 'clear')).startLines).toEqual([NOTICE])
      expect(d.restartCalls).toEqual([{ predecessor_id: PREVIOUS }])
    })

    test('a clear whose ended session held no record asks nothing and is quiet (the common /clear in a session on no plan)', async ($, on) => {
      const d = await cleared($, on, SIGNED_OUT, PREVIOUS, false)
      d.world.restart.json = stopped('no_predecessor_record', 'no record')
      expect((await firstPrompt($, 'clear')).startLines).toBeUndefined()
      expect(d.restartCalls).toEqual([])
    })

    test('the ended session is consumed with the start: a later clear that saw no end asks nothing, never about the earlier id', async ($, on) => {
      const d = await cleared($, on)
      await firstPrompt($, 'clear')
      expect((await firstPrompt($, 'clear')).startLines).toBeUndefined()
      expect(d.restartCalls).toEqual([{ predecessor_id: PREVIOUS }])
    })

    test('a clear whose session.end was never seen asks nothing and is quiet', async ($, on) => {
      const d = await cleared($, on, SIGNED_OUT, null)
      expect((await firstPrompt($, 'clear')).startLines).toBeUndefined()
      expect(d.restartCalls).toEqual([])
    })

    test('a resume that carried no transcript path is a failure line naming it, and asks nothing', async ($, on) => {
      const d = await started($, on)
      const r = await firstPrompt($, 'resume', { transcript_path: undefined })
      expect(r.startLines).toEqual([restartFailureLine('no_transcript_path: SessionStart resume carried no transcript_path')])
      expect(d.restartCalls).toEqual([])
    })

    test('a session end that is not a clear is not remembered as a predecessor', async ($, on) => {
      const d = await started($, on)
      d.world.records.push(PREVIOUS)
      await $.session.end({ reason: 'resume', sessionId: PREVIOUS } as any)
      expect((await firstPrompt($, 'clear')).startLines).toBeUndefined()
      expect(d.restartCalls).toEqual([])
    })

    test('a clear that is told `{notice: null}` is quiet', async ($, on) => {
      const d = await cleared($, on)
      d.world.restart.json = { notice: null }
      expect((await firstPrompt($, 'clear')).startLines).toBeUndefined()
      expect(d.restartCalls).toEqual([{ predecessor_id: PREVIOUS }])
    })

    for (const reason of ['no_predecessor_record', 'transcript_unreadable'] as const) {
      for (const source of ['resume', 'clear'] as const) {
        test(`a \`${reason}\` stop on a ${source} is one warning line with the server's detail and fix`, async ($, on) => {
          const d = await cleared($, on)
          d.world.restart.json = stopped(reason, 'the detail')
          const r = await firstPrompt($, source)
          expect(r.startLines).toEqual([restartFailureLine(`${reason}: the detail. continue without it; call plan_connect`)])
        })
      }
    }

    test('a resume answered `{notice: null}` (a readable, non-fork transcript) is quiet', async ($, on) => {
      const d = await started($, on)
      d.world.restart.json = { notice: null }
      expect((await firstPrompt($, 'resume')).startLines).toBeUndefined()
      expect(d.restartCalls).toEqual([{ transcript_path: TRANSCRIPT }])
    })

    test('R-2: the restart notice is the server’s own tool; nothing spawns the danx-dashboard-mcp CLI', async ($, on) => {
      const d = await started($, on)
      await firstPrompt($, 'startup')
      expect(d.readers).toEqual([])
    })
  })
}
