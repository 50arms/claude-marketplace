import { describe, expect, test } from 'claude-code/testing'

import { SURFACES, dashboard, expectRowCarries, footerText, mountIndicator, startSession, toldModel } from './plan-kit'

const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any

async function openPane($: any, on: any, surface: (typeof SURFACES)[number], options: any = {}) {
  const d = dashboard(on, options)
  await startSession($, d, surface)
  const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
  return { d, pane }
}

const keys = async (pane: any, type = 'Button') => (await pane.findAll({ type })).map((b: any) => b.key)

for (const surface of SURFACES) {
  describe(`open problems on ${surface}`, () => {
    test('list in card-priority order; the recommended solution is listed first and badged', async ($, on) => {
      const { pane } = await openPane($, on, surface)
      expect((await keys(pane)).filter((k: string) => k?.startsWith('open-') && k !== 'open-plan')).toEqual(['open-11', 'open-12', 'open-21'])

      await pane.press({ key: 'open-11' })
      const uses = (await keys(pane)).filter((k: string) => k?.startsWith('use-'))
      expect(uses).toEqual(['use-112', 'use-111'])
      expect((await pane.find({ type: 'Text', text: /Recommended/ }))?.text).toMatch(/Recommended/)
      expect((await pane.find({ key: 'use-112' }))?.props.variant).toBe('primary')
      expect((await pane.find({ key: 'use-111' }))?.props.variant).toBe('secondary')
      // an action problem's own words
      await pane.press({ key: 'open-12' })
      expect((await pane.find({ type: 'Text', text: /Start here/ }))?.text).toMatch(/Start here/)
      expect((await pane.find({ key: 'use-121' }))?.text).toBe('Mark done')
    })

    test('an option button answers {solution_id}; the problem leaves the pane at once and the model is told', async ($, on) => {
      const { d, pane } = await openPane($, on, surface)
      await pane.press({ key: 'open-11' })
      await pane.press({ key: 'use-112' })
      await d.clock.settle()
      expect(d.writes()).toEqual([
        { method: 'POST', path: '/api/issues/DX-1/problems/11/answer', body: { solution_id: 112 }, query: undefined },
      ])
      // PBLM-1913: no answered rendering, no unanswer / change answer: the problem is simply gone
      expect(await keys(pane)).not.toContain('open-11')
      expect(await keys(pane)).toContain('open-12')
      expect(d.toasts).toContain('Answered: Best')
      const rows = toldModel(d)
      expect(rows).toHaveLength(1)
      expectRowCarries(rows[0]!, ['DX-1', 'PBLM-11', 'Which route?', 'Best'])
    })

    test('This but… sends {solution_id, note}, refuses an empty note with no call, and labels the answer with the note', async ($, on) => {
      const { d, pane } = await openPane($, on, surface)
      await pane.press({ key: 'open-11' })
      await pane.press({ key: 'note-111' })
      await pane.input({ key: 'note-in-111', text: '   ' })
      await d.clock.settle()
      expect(d.writes()).toHaveLength(0)
      expect(d.toasts).toContain('A note is required.')
      await pane.input({ key: 'note-in-111', text: 'because' })
      await d.clock.settle()
      expect(d.writes().map(w => w.body)).toEqual([{ solution_id: 111, note: 'because' }])
      expect(d.toasts).toContain('Answered: Plain (note: because)')
      const rows = toldModel(d)
      expect(rows).toHaveLength(1)
      expectRowCarries(rows[0]!, ['DX-1', 'PBLM-11', 'Which route?', 'Plain (note: because)'])
    })

    test('a typed answer sends {freeform} and labels the answer with the text', async ($, on) => {
      const { d, pane } = await openPane($, on, surface)
      await pane.press({ key: 'open-11' })
      await pane.input({ key: 'free-11', text: '  my own way ' })
      await d.clock.settle()
      expect(d.writes().map(w => [w.path, w.body])).toEqual([['/api/issues/DX-1/problems/11/answer', { freeform: 'my own way' }]])
      expect(d.toasts).toContain('Answered: "my own way"')
      const rows = toldModel(d)
      expect(rows).toHaveLength(1)
      expectRowCarries(rows[0]!, ['DX-1', 'PBLM-11', 'Which route?', '"my own way"'])
    })

    test('Mark done approves an action problem with {solution_id}', async ($, on) => {
      const { d, pane } = await openPane($, on, surface)
      await pane.press({ key: 'open-12' })
      await pane.press({ key: 'use-121' })
      await d.clock.settle()
      expect(d.writes().map(w => [w.path, w.body])).toEqual([['/api/issues/DX-1/problems/12/answer', { solution_id: 121 }]])
      expect(await keys(pane)).not.toContain('open-12')
      expect(d.toasts).toContain('Answered: Allow it')
      const rows = toldModel(d)
      expect(rows).toHaveLength(1)
      expectRowCarries(rows[0]!, ['DX-1', 'PBLM-12', 'Allow the site', 'Allow it'])
    })

    test('an action problem is rejected with {outcome: "rejected", note}; an empty note is refused with no call', async ($, on) => {
      const { d, pane } = await openPane($, on, surface)
      await pane.press({ key: 'open-12' })
      await pane.press({ key: 'rej-121' })
      await pane.input({ key: 'rej-in-121', text: '' })
      await d.clock.settle()
      expect(d.writes()).toHaveLength(0)
      expect(d.toasts).toContain('A note is required to reject.')
      await pane.input({ key: 'rej-in-121', text: 'not now' })
      await d.clock.settle()
      expect(d.writes().map(w => [w.path, w.body])).toEqual([
        ['/api/issues/DX-1/problems/12/answer', { solution_id: 121, outcome: 'rejected', note: 'not now' }],
      ])
      expect(d.toasts).toContain('Answered: REJECTED "Allow it" (reason: not now)')
      const rows = toldModel(d)
      expect(rows).toHaveLength(1)
      expectRowCarries(rows[0]!, ['DX-1', 'PBLM-12', 'Allow the site', 'REJECTED', 'Allow it', 'not now'])
    })

    test('a refused answer shows the error, tells the model nothing and keeps the problem', async ($, on) => {
      const { d, pane } = await openPane($, on, surface)
      d.world.cards[1]!.problems[0]!.statement = 'FAIL'
      await pane.press({ key: 'refresh' })
      await d.clock.settle()
      await pane.press({ key: 'open-21' })
      await pane.press({ key: 'use-211' })
      await d.clock.settle()
      expect(d.toasts.some(t => t.includes('DX-2 PBLM-21: 409: refused'))).toBe(true)
      expect(toldModel(d)).toHaveLength(0)
      expect(await keys(pane)).toContain('open-21')
    })

    test('a step tick calls PATCH …/steps/:id/check; Post comment calls POST …/comments', async ($, on) => {
      const { d, pane } = await openPane($, on, surface)
      await pane.press({ key: 'open-11' })
      await pane.press({ key: 'tick-1111' })
      await d.clock.settle()
      await pane.press({ key: 'talk-11' })
      expect((await pane.find({ type: 'Markdown', text: 'a comment' })) ?? (await pane.find({ type: 'Text', text: 'a comment' }))).toBeDefined()
      await pane.input({ key: 'comment-11', text: '  hello there ' })
      await d.clock.settle()
      expect(d.writes().map(w => [w.method, w.path, w.body])).toEqual([
        ['PATCH', '/api/issues/DX-1/problems/11/solutions/111/steps/1111/check', { checked: true }],
        ['POST', '/api/issues/DX-1/comments', { text: 'hello there', problem_id: 11 }],
      ])
      // neither tells the model anything
      expect(toldModel(d)).toHaveLength(0)
    })

    test('a step tick or a comment does not wipe the note being composed; an answer does', async ($, on) => {
      const { d, pane } = await openPane($, on, surface)
      await pane.press({ key: 'open-11' })
      await pane.press({ key: 'note-112' })
      expect(await pane.find({ key: 'note-in-112' })).toBeDefined()

      await pane.press({ key: 'tick-1111' })
      await d.clock.settle()
      expect(await pane.find({ key: 'note-in-112' })).toBeDefined()

      await pane.press({ key: 'talk-11' })
      await pane.input({ key: 'comment-11', text: 'meanwhile' })
      await d.clock.settle()
      expect(await pane.find({ key: 'note-in-112' })).toBeDefined()

      await pane.input({ key: 'note-in-112', text: 'done' })
      await d.clock.settle()
      expect(d.writes().at(-1)?.body).toEqual({ solution_id: 112, note: 'done' })
      expect(await pane.find({ key: 'note-in-112' })).toBeUndefined()
    })
  })

  describe(`what one load reads, on ${surface}`, () => {
    test('more needs-you cards than were read: the pane says how many are in the browser and the band counts a lower bound', async ($, on) => {
      const { d, pane } = await openPane($, on, surface, { cardsTotal: 20 })
      const texts = (await pane.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
      expect(texts).toContain('+18 more cards with open problems in the browser')
      const band = await $.ui.mount({ plugin: 'danxbot', surface, component: 'AbovePrompt', props: { hasSurvey: false } } as any)
      expect((await band.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')).toContain('3+ open problems')
      expect(await footerText(await mountIndicator($, surface))).toBe('◔ 25% · PLAN-23 · 3+ open')
    })

    test('a plan beyond the plan list cap still labels correctly, from the session in the same response', async ($, on) => {
      const { pane } = await openPane($, on, surface, { planOutsideList: true })
      const texts = (await pane.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
      expect(texts).toContain('Connected: PLAN-23')
      expect(texts).toContain('Danxbot plugin')
    })

    test('comments the API paged away: the count is a lower bound and the pane says more exist', async ($, on) => {
      const { pane } = await openPane($, on, surface, { commentsTotal: 25 })
      await pane.press({ key: 'open-11' })
      expect((await pane.find({ key: 'talk-11' }))?.text).toBe('▸ Discussion (1+)')
      await pane.press({ key: 'talk-11' })
      expect((await pane.find({ type: 'Text', text: /Up to 24 more comments on this card in the browser/ }))?.text).toMatch(/24 more/)
    })
  })
}
