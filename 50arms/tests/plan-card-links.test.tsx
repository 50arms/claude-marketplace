import "./run-tests-with-npm-test.generated"
// CP-73, DEC-720: every `[A-Z]{1,4}-\d+` token in an assistant reply is drawn as a link to the dashboard's ref redirect. The stored message is never
// touched (a rewrite changes the drawing), and the draw reads only the `view` atom, so it makes no call.
import { describe, expect } from 'claude-code/testing'

import { linkRefs } from '../hooks/plan/card-links'
import { test, DASHBOARD_URL, SURFACES, dashboard, startSession } from './plan-kit'

const link = (text: string) => linkRefs(text, DASHBOARD_URL)
const REF = (id: string) => `[${id}](${DASHBOARD_URL}/api/ref/${id})`

describe('linkRefs', () => {
  test('every kind of ref links to the redirect, whatever its prefix', () => {
    expect(link('See DX-1, PBLM-3722, DEC-5, DSGN-6, PLAN-3 and FB-30.')).toBe(`See ${REF('DX-1')}, ${REF('PBLM-3722')}, ${REF('DEC-5')}, ${REF('DSGN-6')}, ${REF('PLAN-3')} and ${REF('FB-30')}.`)
  })

  test('look-alikes of another shape are untouched; those of the ref shape link', () => {
    expect(link('xDX-12, a/DX-12, DX-, 12-3, ABCDE-1')).toBe('xDX-12, a/DX-12, DX-, 12-3, ABCDE-1')
    expect(link('UTF-8')).toBe(REF('UTF-8'))
    expect(link('DX-1431-IMPORTED')).toBe(`${REF('DX-1431')}-IMPORTED`)
  })

  test('inline code spans (any backtick run length) are untouched, the prose around them is not', () => {
    expect(link('`DX-1` and ``a ` DX-2 ``, but DX-3')).toBe(`\`DX-1\` and \`\`a \` DX-2 \`\`, but ${REF('DX-3')}`)
  })

  test('fenced code (backtick and tilde, closed or not) is untouched', () => {
    const fenced = '```ts\nconst a = "DX-1"\n```'
    expect(link(`DX-2\n${fenced}\nDX-3`)).toBe(`${REF('DX-2')}\n${fenced}\n${REF('DX-3')}`)
    expect(link('~~~\nDX-1\n~~~')).toBe('~~~\nDX-1\n~~~')
    expect(link('x DX-2\n```\nDX-1 never closed')).toBe(`x ${REF('DX-2')}\n\`\`\`\nDX-1 never closed`)
  })

  test('existing markdown links, images, reference links, autolinks and bare URLs are untouched', () => {
    for (const text of [
      '[DX-1](https://x.test/a)',
      '[see DX-1 here](https://x.test/DX-1)',
      '![DX-1](https://x.test/i.png)',
      '[DX-1][ref]',
      '[ref]: https://x.test/DX-1',
      '<https://x.test/DX-1>',
      'open https://x.test/cards/DX-1?id=DX-2 now',
    ]) {
      expect(link(text)).toBe(text)
    }
  })

  test('a link beside a bare ref: only the bare ref is linked', () => {
    expect(link('[DX-1](https://x.test) and DX-2')).toBe(`[DX-1](https://x.test) and ${REF('DX-2')}`)
  })
})

const message = (text: string, extra: object = {}) =>
  ({ plugin: '50arms', component: 'AssistantMessage', props: { text, isFirstOfReply: true, ...extra } }) as any
// the engine's own drawing stand-in (plan-kit) draws the props' text, so what reaches it is what is drawn
const drawnText = async (ui: any): Promise<string | undefined> => (await ui.find({ type: 'Text' }))?.text

for (const surface of SURFACES) {
  describe(`ref links in an assistant reply on ${surface}`, () => {
    test('signed in: the rewritten text reaches the engine drawing; no call is made', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const calls = d.calls.length
      const api = d.api.length
      const ui = await $.ui.mount({ ...message('DX-1 PBLM-3722 DEC-5 `FB-30` x'), surface })
      expect(await drawnText(ui)).toBe(`${REF('DX-1')} ${REF('PBLM-3722')} ${REF('DEC-5')} \`FB-30\` x`)
      // the draw reads the view atom only
      expect(d.calls.length).toBe(calls)
      expect(d.api.length).toBe(api)
    })

    test('the other props ride along as received', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const ui = await $.ui.mount({ ...message('DX-1', { isFirstOfReply: false, onScreen: null }), surface })
      expect((await ui.find({ type: 'Text', text: /^first=/ }))?.text).toBe('first=false onScreen=null')
      expect(await drawnText(ui)).toBe(REF('DX-1'))
    })

    test('a reply with nothing to link is drawn as it is', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      expect(await drawnText(await $.ui.mount({ ...message('Nothing here, no ids.'), surface }))).toBe('Nothing here, no ids.')
    })

    test('a session on no plan links too', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      expect(await drawnText(await $.ui.mount({ ...message('DX-1'), surface }))).toBe(REF('DX-1'))
    })

    test('signed out: the reply is drawn as it is', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out' })
      await startSession($, d, surface)
      expect(await drawnText(await $.ui.mount({ ...message('DX-1'), surface }))).toBe('DX-1')
    })

    test('before the first load finishes (the empty view) the reply is drawn as it is', async ($, on) => {
      dashboard(on)
      expect(await drawnText(await $.ui.mount({ ...message('DX-1'), surface }))).toBe('DX-1')
    })
  })
}
