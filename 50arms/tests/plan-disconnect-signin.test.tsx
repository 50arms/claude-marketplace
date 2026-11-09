import "./run-tests-with-npm-test.generated"
// CP-89 / DX-7026: after a person's Revoke the session's key is dead and only the person's Sign in restarts it. The band never sits on "Signing in…" with nothing in flight,
// the plugin makes no connect call of its own, and the Sign in that follows shows the approval link and code.
import { describe, expect } from 'claude-code/testing'

import { test, APPROVAL_REQUIRED, APPROVAL_URL, CONFIRM_CODE, SURFACES, dashboard, forceRefresh, linksOf, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const connects = (d: any) => d.calls.filter((c: any) => c.server === 'plugin:50arms:platform' && c.tool === 'session_connect')
const modelConnect = (on: any) => on('tool.call', { tool: 'mcp__plugin_50arms_platform__session_connect' }, () => ({ result: {}, text: JSON.stringify(APPROVAL_REQUIRED), isError: false }) as any)

for (const surface of SURFACES) {
  describe(`Revoke then Sign in on ${surface}`, () => {
    test('the band offers Sign in, not Signing in…, and the plugin makes no connect call of its own, however long the session sits', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      await band.press({ key: 'revoke' })
      await d.clock.settle()

      expect(await texts(band)).toContain('50 Arms: access revoked by dana')
      expect((await band.find({ key: 'sign-in' })).text).toBe('Sign in')
      // Revoke makes no leave call and no connect call of the plugin's own
      expect(connects(d)).toEqual([])

      await d.clock.advance(10 * 60_000)
      await d.clock.settle()
      expect((await band.find({ key: 'sign-in' })).text).toBe('Sign in')
      expect(connects(d)).toHaveLength(0)
    })

    test('a sign-in watch the model started before the Revoke is ended by the Revoke: the band reads Sign in at once, with no stop toast', async ($, on) => {
      const d = dashboard(on)
      modelConnect(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      // the model's connect is answered with a sign-in request and the watch waits on it (its call is held on the clock), while the session still holds its plan
      d.world.signedOut = 'signed-out'
      await $.tool.call({ tool: 'mcp__plugin_50arms_platform__session_connect', target: 'PLAN-23' } as any)
      await d.clock.settle()
      d.world.signedOut = null
      await forceRefresh($, d)
      expect((await band.find({ key: 'sign-in' })) ?? null).toBeNull()

      await band.press({ key: 'revoke' })
      await d.clock.settle()
      expect((await band.find({ key: 'sign-in' })).text).toBe('Sign in')
      expect((await linksOf(band)).map(l => l.href)).not.toContain(APPROVAL_URL)

      // the held call answers later: the aborted watch does nothing with it
      const toasts = d.toasts.length
      await d.clock.advance(60_000)
      await d.clock.settle()
      expect(d.toasts.slice(toasts).filter((t: string) => t.includes('must stop'))).toEqual([])
      expect((await band.find({ key: 'sign-in' })).text).toBe('Sign in')
    })

    test('Sign in after the Revoke asks as a person (person_sign_in), names no plan, and shows the approval link and code', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      await band.press({ key: 'revoke' })
      await d.clock.settle()
      expect(await texts(band)).toContain('access revoked')

      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      const signIn = connects(d).at(-1).args
      expect(signIn.person_sign_in).toBe(true)
      expect(signIn.target).toBeUndefined()
      expect((await linksOf(band)).map(l => l.href)).toContain(APPROVAL_URL)
      expect(await texts(band)).toContain(`code ${CONFIRM_CODE}`)
    })
  })
}
