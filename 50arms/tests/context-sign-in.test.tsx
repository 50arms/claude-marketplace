import "./run-tests-with-npm-test.generated"
// A session that starts without a usable key is told one invitation to sign in (the floor's) and no 50 Arms text besides; the mantra (the bundle's session.start text)
// arrives once the session is signed in, on its next prompt or tool result, and its sub-agents get theirs from then on. A session that starts signed in is never
// told the mantra a second time by a later load.
import { describe, expect } from 'claude-code/testing'

import { SIGN_IN_INVITATION } from '../hooks/bundle/floor'
import { test, EVENT_TEXT, SURFACES, dashboard, deliveredReports, firstPrompt, forceRefresh, startSession, STAMP_LINE } from './plan-kit'

const START = { agent_id: 'a1', agent_type: '50arms:worker-sonnet-high' }
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
// the prompt's context without its time stamp (a signed-out prompt has none: the stamp is the bundle's)
const prompt = async ($: any) => ((await $.prompt.submit({ text: 'next' })).context ?? []).filter((l: string) => !STAMP_LINE.test(l)) as string[]

for (const surface of SURFACES) {
  describe(`the mantra after a sign-in on ${surface}`, () => {
    async function started($: any, on: any, options: Parameters<typeof dashboard>[1]) {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.SubagentStart', () => ({}) as any)
      const d = dashboard(on, options)
      await startSession($, d, surface)
      d.contextReads.length = 0
      return d
    }

    test('signing in at the band: the next prompt carries the session_start text once, without a restart notice, and sub-agents are told from then on', async ($, on) => {
      const d = await started($, on, { signedOut: 'signed-out', connected: false })
      expect((await firstPrompt($, 'startup')).startLines).toEqual([SIGN_IN_INVITATION])
      // a load that still finds it signed out tells nothing
      await forceRefresh($, d)
      expect(await prompt($)).toEqual([])
      expect((await $.classic.SubagentStart(START)).additionalContext).toBeUndefined()

      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      d.world.signIn.approved = true
      await d.clock.advance(45_000)
      await d.clock.settle()

      expect(await prompt($)).toEqual([EVENT_TEXT('session_start')])
      expect(await prompt($)).toEqual([])
      await d.clock.settle()
      expect(deliveredReports(d, 'session.start')).toHaveLength(1)
      // the signed-out startup asked no restart notice, and the sign-in's start asks none
      expect(d.restartCalls).toEqual([])
      const sub = await $.classic.SubagentStart(START)
      await d.clock.settle()
      expect(sub.additionalContext).toEqual([EVENT_TEXT('sub_agent_start')])
    })

    test('a key that works again without the band (a load finds the session signed in): the next prompt carries the text once', async ($, on) => {
      const d = await started($, on, { signedOut: 'lapsed' })
      expect((await firstPrompt($, 'startup')).startLines).toEqual([SIGN_IN_INVITATION])
      d.world.signedOut = null
      await forceRefresh($, d)
      expect(await prompt($)).toEqual([EVENT_TEXT('session_start')])
      await forceRefresh($, d)
      expect(await prompt($)).toEqual([])
    })

    test('a session that started with a person-revoked key is told the text once it is signed in again', async ($, on) => {
      const d = await started($, on, { signedOut: 'revoked' })
      expect((await firstPrompt($, 'startup')).startLines).toBeUndefined()
      d.world.signedOut = null
      await forceRefresh($, d)
      expect(await prompt($)).toEqual([EVENT_TEXT('session_start')])
    })

    test('a session that started signed in is never told the text again by a later load', async ($, on) => {
      const d = await started($, on, {})
      expect((await firstPrompt($, 'startup')).startLines).toEqual([EVENT_TEXT('session_start')])
      d.world.signedOut = 'lapsed'
      await forceRefresh($, d)
      d.world.signedOut = null
      await forceRefresh($, d)
      expect(await prompt($)).toEqual([])
      await d.clock.settle()
      expect(deliveredReports(d, 'session.start')).toHaveLength(1)
    })

    test('a session that starts signed in after having been owed (a second start) is told once, not twice', async ($, on) => {
      const d = await started($, on, { signedOut: 'lapsed' })
      expect((await firstPrompt($, 'startup')).startLines).toEqual([SIGN_IN_INVITATION])
      d.world.signedOut = null
      const r = await firstPrompt($, 'resume')
      expect(r.startLines).toEqual([EVENT_TEXT('session_resume')])
      await forceRefresh($, d)
      expect(await prompt($)).toEqual([])
    })
  })
}
