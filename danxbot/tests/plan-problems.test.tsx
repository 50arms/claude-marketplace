import { describe, expect, test } from 'claude-code/testing'

import { answerNote } from '../hooks/plan-link/notes'
import { SURFACES, dashboard, startSession, triedToTell } from './plan-kit'

const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any

async function openPane($: any, on: any, surface: (typeof SURFACES)[number]) {
  const d = dashboard(on)
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

    test('an option button answers {solution_id}; the answered problem leaves the pane at once', async ($, on) => {
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
      // one row for the model, naming the card, the statement and the answer
      expect(triedToTell(d)).toBe(1)
      const note = answerNote(
        { id: 11, cardId: 'DX-1', statement: 'Which route?' } as any,
        'Best',
      )
      expect(note).toContain('DX-1 PBLM-11 "Which route?"')
      expect(note).toContain('Best')
    })

    test('This but… sends {solution_id, note} and refuses an empty note with no call', async ($, on) => {
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
    })

    test('a typed answer sends {freeform}', async ($, on) => {
      const { d, pane } = await openPane($, on, surface)
      await pane.press({ key: 'open-11' })
      await pane.input({ key: 'free-11', text: 'my own way' })
      await d.clock.settle()
      expect(d.writes().map(w => [w.path, w.body])).toEqual([['/api/issues/DX-1/problems/11/answer', { freeform: 'my own way' }]])
    })

    test('an action problem is approved with {solution_id} and rejected with a required note', async ($, on) => {
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
      expect(triedToTell(d)).toBe(1)
    })

    test('Mark done approves an action problem', async ($, on) => {
      const { d, pane } = await openPane($, on, surface)
      await pane.press({ key: 'open-12' })
      await pane.press({ key: 'use-121' })
      await d.clock.settle()
      expect(d.writes().map(w => [w.path, w.body])).toEqual([['/api/issues/DX-1/problems/12/answer', { solution_id: 121 }]])
      expect(await keys(pane)).not.toContain('open-12')
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
      expect(triedToTell(d)).toBe(0)
      expect(await keys(pane)).toContain('open-21')
    })

    test('a step tick calls PATCH …/steps/:id/check; Post comment calls POST …/comments', async ($, on) => {
      const { d, pane } = await openPane($, on, surface)
      await pane.press({ key: 'open-11' })
      await pane.press({ key: 'tick-1111' })
      await d.clock.settle()
      await pane.press({ key: 'talk-11' })
      expect((await pane.find({ type: 'Text', text: 'a comment' })) ?? (await pane.find({ type: 'Markdown', text: 'a comment' }))).toBeDefined()
      await pane.input({ key: 'comment-11', text: 'hello there' })
      await d.clock.settle()
      expect(d.writes().map(w => [w.method, w.path, w.body])).toEqual([
        ['PATCH', '/api/issues/DX-1/problems/11/solutions/111/steps/1111/check', { checked: true }],
        ['POST', '/api/issues/DX-1/comments', { text: 'hello there', problem_id: 11 }],
      ])
    })
  })
}
