// DX-4448: card ids in an assistant reply are drawn as links to the card. The stored message is never touched (a rewrite
// changes the drawing), and the draw reads only the `view` atom, so it makes no call.
import { describe, expect } from 'claude-code/testing'

import { linkCardIds } from '../hooks/plan/card-links'
import { test, DASHBOARD_URL, SURFACES, dashboard, footerText, forceRefresh, mountIndicator, problemBadgeOf, startSession } from './plan-kit'

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


const message = (text: string, extra: object = {}) =>
  ({ plugin: 'danxbot', component: 'AssistantMessage', props: { text, isFirstOfReply: true, ...extra } }) as any
// the engine's own drawing stand-in (plan-kit) draws the props' text, so what reaches it is what is drawn
const drawnText = async (ui: any): Promise<string | undefined> => (await ui.find({ type: 'Text' }))?.text

for (const surface of SURFACES) {
  describe(`card links in an assistant reply on ${surface}`, () => {
    test('connected: the rewritten text reaches the engine drawing; a plan card of any status links to the plan, others to the board; no call is made', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const calls = d.calls.length
      const api = d.api.length
      // DX-1 needs you, DX-9 is in progress, DX-30 is ToDo and DX-31 Done (neither in a bucket the view lists), SG-7 is the plan's card on
      // its other board; SG-5 is on that board but not in the plan
      const ui = await $.ui.mount({ ...message('DX-1 DX-9 DX-30 DX-31 SG-7 SG-5 UTF-8 DX-99'), surface })
      expect(await drawnText(ui)).toBe(
        [PLAN_URL('DX-1'), PLAN_URL('DX-9'), PLAN_URL('DX-30'), PLAN_URL('DX-31'), PLAN_URL('SG-7'), BOARD_URL('SG-5'), 'UTF-8', BOARD_URL('DX-99')].join(' '),
      )
      // DX-4448: the draw reads the view atom only
      expect(d.calls.length).toBe(calls)
      expect(d.api.length).toBe(api)
    })

    test('the other props ride along as received', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const ui = await $.ui.mount({ ...message('DX-1', { isFirstOfReply: false, onScreen: null }), surface })
      expect((await ui.find({ type: 'Text', text: /^first=/ }))?.text).toBe('first=false onScreen=null')
      expect(await drawnText(ui)).toBe(PLAN_URL('DX-1'))
    })

    test('a reply with nothing to link is drawn as it is', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      expect(await drawnText(await $.ui.mount({ ...message('Nothing here, UTF-8 only.'), surface }))).toBe('Nothing here, UTF-8 only.')
    })

    test('not connected: the reply is drawn as it is', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      expect(await drawnText(await $.ui.mount({ ...message('DX-1'), surface }))).toBe('DX-1')
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

    // DX-4448: what the links stand on failing is the links' own error: the plan view stays ready and the reply stays as written
    for (const [name, options] of [
      ['the boards call failing', { boardsFail: true }],
      ['a boards answer with no boards', { boardsShape: 'none' }],
      ['a boards answer with a malformed prefix', { boardsShape: 'badPrefix' }],
      ['a boards answer with no boards key', { boardsShape: 'noKey' }],
      ['a plan card with no id', { planCardsShape: 'noId' }],
      ['cards that do not add up to the plan card_count (a board missing)', { planCardsShape: 'otherCount' }],
    ] as const) {
      test(`${name}: the plan stays ready, the reply is drawn as it is`, async ($, on) => {
        const d = dashboard(on, options as any)
        await startSession($, d, surface)
        expect(await footerText(await mountIndicator($, surface))).toBe('Danxbot · PLAN-23')
        expect(await drawnText(await $.ui.mount({ ...message('DX-1'), surface }))).toBe('DX-1')
        expect(d.toasts.filter(t => t.startsWith('Card links unavailable: '))).toHaveLength(1)
      })
    }

    // DX-5232: the open-problem count is summed from the same every-card read; one that cannot be read whole leaves the plan ready,
    // the band with no count (never a guessed 0), and the reason told once
    for (const [name, options] of [
      ['the plan cards call failing', { planCardsFail: true }],
      ['the plan cards answer counting more cards than it returned', { planCardsTotal: 9 }],
      ['the plan cards answer with no list', { planCardsShape: 'noList' }],
      ['the plan cards answer with no total', { planCardsShape: 'noTotal' }],
    ] as const) {
      test(`${name}: the plan stays ready, no count is shown, the reason is told once`, async ($, on) => {
        const d = dashboard(on, options as any)
        await startSession($, d, surface)
        await forceRefresh($, d)
        const band = await $.ui.mount({ plugin: 'danxbot', surface, component: 'AbovePrompt', props: { hasSurvey: false } } as any)
        const all = (await band.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
        expect(all).not.toContain('Disconnected')
        expect(all).toContain('PLAN-23')
        expect(await problemBadgeOf(band)).toBeUndefined()
        expect(d.toasts.filter(t => t.startsWith('Open problem count unavailable: GET /api/plans/23/cards (all)'))).toHaveLength(1)
        expect(d.toasts.filter(t => t.startsWith('Card links unavailable: GET /api/plans/23/cards (all)'))).toHaveLength(1)
      })
    }
  })
}
