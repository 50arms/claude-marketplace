// DX-4448: card ids in an assistant reply are drawn as links to the card. The stored message is never touched (a rewrite
// changes the drawing), and the draw reads only the `view` atom, so it makes no call.
import { describe, expect, test } from 'claude-code/testing'

import { EMPTY } from '../hooks/plan/config'
import { linkCardIds } from '../hooks/plan/card-links'
import { DASHBOARD_URL, SURFACES, dashboard, startSession } from './plan-kit'

const plan = { id: 23, ref: 'PLAN-23', name: 'p', status: 'building', dashboardUrl: DASHBOARD_URL } as any
const PREFIXES = ['DX', 'SG']
const link = (text: string, planCards: string[] = ['DX-1']) => linkCardIds(text, PREFIXES, plan, new Set(planCards))
const PLAN_URL = (id: string) => `[${id}](${DASHBOARD_URL}/plans/23/cards/${id})`
const BOARD_URL = (id: string) => `[${id}](${DASHBOARD_URL}/board/${id})`

describe('linkCardIds', () => {
  test('a plan card links to its plan page, any other known-prefix card to the board route', () => {
    expect(link('See DX-1 and SG-1017, then DX-4447.')).toBe(`See ${PLAN_URL('DX-1')} and ${BOARD_URL('SG-1017')}, then ${BOARD_URL('DX-4447')}.`)
  })

  test('unknown prefixes and look-alikes are untouched', () => {
    const text = 'UTF-8, SHA-256, ISO-8601, XDX-12, DX-12-b, a/DX-12, FOO-123'
    expect(link(text)).toBe(text)
  })

  test('no prefixes known: the text is unchanged', () => {
    expect(linkCardIds('DX-1', [], plan, new Set())).toBe('DX-1')
  })

  test('inline code spans (any backtick run length) are untouched, the prose around them is not', () => {
    expect(link('`DX-1` and ``a ` DX-2 ``, but DX-3')).toBe(`\`DX-1\` and \`\`a \` DX-2 \`\`, but ${BOARD_URL('DX-3')}`)
  })

  test('fenced code (backtick and tilde, closed or not) is untouched', () => {
    const fenced = '```ts\nconst a = "DX-1"\n```'
    expect(link(`DX-2\n${fenced}\nDX-3`)).toBe(`${BOARD_URL('DX-2')}\n${fenced}\n${BOARD_URL('DX-3')}`)
    expect(link('~~~\nDX-1\n~~~')).toBe('~~~\nDX-1\n~~~')
    expect(link('x DX-2\n```\nDX-1 never closed')).toBe(`x ${BOARD_URL('DX-2')}\n\`\`\`\nDX-1 never closed`)
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

  test('a link beside a bare id: only the bare id is linked', () => {
    expect(link('[DX-1](https://x.test) and DX-2')).toBe(`[DX-1](https://x.test) and ${BOARD_URL('DX-2')}`)
  })
})

const message = (text: string) => ({ plugin: 'danxbot', component: 'AssistantMessage', props: { text, isFirstOfReply: true } }) as any
const markdownOf = async (ui: any) => (await ui.find({ type: 'Markdown' }))?.props.text as string | undefined
// the engine's own drawing stand-in (plan-kit): a Text carrying the reply as it is
const plainOf = async (ui: any, text: string) => expect((await ui.find({ type: 'Text', text }))?.text).toBe(text)

for (const surface of SURFACES) {
  describe(`card links in an assistant reply on ${surface}`, () => {
    test('connected: the reply is drawn as Markdown with a plan link and a board link, and no call is made', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const calls = d.calls.length
      const api = d.api.length
      const ui = await $.ui.mount({ ...message('Fix DX-1 (in the plan), SG-5 (elsewhere), UTF-8 (no).'), surface })
      expect(await markdownOf(ui)).toBe(`Fix ${PLAN_URL('DX-1')} (in the plan), ${BOARD_URL('SG-5')} (elsewhere), UTF-8 (no).`)
      // DX-4448: the draw reads the view atom only
      expect(d.calls.length).toBe(calls)
      expect(d.api.length).toBe(api)
    })

    test('a reply with nothing to link is not redrawn', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const ui = await $.ui.mount({ ...message('Nothing here, UTF-8 only.'), surface })
      expect(await markdownOf(ui)).toBeUndefined()
      await plainOf(ui, 'Nothing here, UTF-8 only.')
    })

    test('a rewrite past the Markdown cap is not drawn as Markdown', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const long = `DX-1 ${'x'.repeat(9_990)}`
      const ui = await $.ui.mount({ ...message(long), surface })
      expect(await markdownOf(ui)).toBeUndefined()
      await plainOf(ui, long)
    })

    test('not connected: the reply is drawn as it is', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const ui = await $.ui.mount({ ...message('DX-1'), surface })
      expect(await markdownOf(ui)).toBeUndefined()
      await plainOf(ui, 'DX-1')
    })

    test('signed out: the reply is drawn as it is', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out' })
      await startSession($, d, surface)
      const ui = await $.ui.mount({ ...message('DX-1'), surface })
      expect(await markdownOf(ui)).toBeUndefined()
      await plainOf(ui, 'DX-1')
    })

    test('the boards call failing leaves the plan view and the reply as they are', async ($, on) => {
      const d = dashboard(on, { boardsFail: true })
      await startSession($, d, surface)
      const ui = await $.ui.mount({ ...message('DX-1'), surface })
      expect(await markdownOf(ui)).toBeUndefined()
      await plainOf(ui, 'DX-1')
    })

    test('before the first load finishes (the empty view) the reply is drawn as it is', async ($, on) => {
      dashboard(on)
      expect(EMPTY.cardPrefixes).toEqual([])
      const ui = await $.ui.mount({ ...message('DX-1'), surface })
      expect(await markdownOf(ui)).toBeUndefined()
      await plainOf(ui, 'DX-1')
    })
  })
}
