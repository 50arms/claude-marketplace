import "./run-tests-with-npm-test.generated"
// DX-4630: across a whole session (connect, sign-in, a permission request, a refresh) the band draws its page controls as
// Markdown links and the plugin makes no Claude_Browser call and draws no Link element, on both surfaces.
import { describe, expect } from 'claude-code/testing'

import { test, APPROVAL_URL, SURFACES, browserCalls, dashboard, linksOf, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any

for (const surface of SURFACES) {
  describe(`a full session on ${surface}`, () => {
    test('every page control is a Markdown link and no browser tool is called', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out' })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      expect((await linksOf(band)).map(l => l.href)).toContain(APPROVAL_URL)
      d.world.signIn.approved = true
      await d.clock.advance(45_000)
      await d.clock.settle()
      await $.command.run({ command: 'danx-plan' })
      await d.clock.settle()
      expect((await linksOf(band)).map(l => l.key)).toEqual(['open-plan', 'open-problems'])
      expect(await band.findAll({ type: 'Link' })).toEqual([])
      expect(browserCalls(d)).toEqual([])
    })

    // A Markdown with a link handler hands a plain click to the plugin and the app opens nothing. The harness presses a Markdown's link
    // only where the plugin gave it a handler, so a press on a page link must find no such element.
    test('no page link has a handler: a press on one reaches no plugin code', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const links = await linksOf(band)
      expect(links.length).toBeGreaterThan(0)
      for (const l of links) await expect(band.press({ key: l.key, link: { href: l.href } })).rejects.toThrow()
    })
  })
}
