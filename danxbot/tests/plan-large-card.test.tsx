// DX-4458: a card with dozens of problems (DX-4443: 49 questions, two solutions each) answers over the host's size limit when
// its solutions come with it. The load reads problem rows only; an opened problem reads its own solutions; one card that
// cannot be read is one line and the rest of the pane still draws.
import { describe, expect, test } from 'claude-code/testing'

import { loadPlan } from '../hooks/plan/load'
import { HOST_LIMIT_CHARS, HOST_OVERSIZE, bigCard, SURFACES, dashboard, startSession } from './plan-kit'

const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')

async function openPane($: any, on: any, surface: (typeof SURFACES)[number], options: any = {}) {
  const d = dashboard(on, options)
  await startSession($, d, surface)
  const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
  return { d, pane }
}

const issueReads = (d: any) => d.api.filter((a: any) => a.method === 'GET' && /^\/api\/issues\/[A-Z]+-\d+$/.test(a.path))

for (const surface of SURFACES) {
  describe(`a card with many problems on ${surface}`, () => {
    test('the fixture is what it claims: the problem rows fit the host limit, the rows with their solutions do not', async () => {
      const { problems } = bigCard()
      expect(JSON.stringify(problems.map(({ solutions, ...row }) => row)).length).toBeLessThan(HOST_LIMIT_CHARS)
      expect(JSON.stringify(problems).length).toBeGreaterThan(HOST_LIMIT_CHARS)
    })

    test('the load reads each card for its problem rows only: no solutions, no comments, no descriptions', async ($, on) => {
      const { d, pane } = await openPane($, on, surface, { bigCard: true })
      const reads = issueReads(d).filter((a: any) => a.path !== '/api/issues/DX-9')
      expect(reads.map((a: any) => a.path).sort()).toEqual(['/api/issues/DX-1', '/api/issues/DX-2', '/api/issues/DX-3'])
      for (const a of reads) expect(a.query).toEqual({ fields: { problems: true } })
      // the in-progress card is read for its agent name alone: no relation requested
      expect(issueReads(d).find((a: any) => a.path === '/api/issues/DX-9')?.query).toBeUndefined()
      const t = await text(pane)
      expect(t).toContain('Question 0?')
      expect(t).toContain('Question 48?')
      expect(t).not.toContain('exceeds')
      expect(t).not.toContain('Couldn')
    })

    test('opening a problem reads its solutions and comments, narrowed to it; closing it reads nothing more', async ($, on) => {
      const { d, pane } = await openPane($, on, surface, { bigCard: true })
      await pane.press({ key: 'open-310' })
      const problems = d.api.filter((a: any) => /\/problems$/.test(a.path))
      expect(problems).toHaveLength(1)
      expect(problems[0]).toMatchObject({ path: '/api/issues/DX-3/problems', query: { q: 'Question 10?', status: 'open' } })
      expect(issueReads(d).filter((a: any) => a.path === '/api/issues/DX-3').some((a: any) => a.query?.fields?.comments === true)).toBe(true)
      expect((await pane.findAll({ type: 'Button' })).map((b: any) => b.key).filter((k: string) => k?.startsWith('use-'))).toEqual(['use-3020', 'use-3021'])
    })

    test('one card that cannot be read is one line naming it; the other cards and the in-progress list still show', async ($, on) => {
      const { pane } = await openPane($, on, surface, { cardFails: 'DX-2' })
      const t = await text(pane)
      expect(t).toContain("Couldn't load DX-2: the dashboard answered 500")
      expect(t).toContain('Which route?')
      expect(t).not.toContain('Second one?')
      expect(t).toContain('In flight card')
      expect(t).not.toContain('boom')
    })

    test('an unread card makes the list a lower bound: the pane says so and never claims nothing needs you', async ($, on) => {
      const { pane } = await openPane($, on, surface, { cardFails: 'DX-1' })
      const t = await text(pane)
      expect(t).toContain("Couldn't load DX-1")
      expect(t).toContain('+1 more card with open problems in the browser')
    })

    test('when the only needs-you card cannot be read the pane does not say nothing needs you', async ($, on) => {
      const { pane } = await openPane($, on, surface, { cardFails: ['DX-1', 'DX-2'] })
      const t = await text(pane)
      expect(t).toContain("Couldn't load DX-1")
      expect(t).not.toContain('Nothing needs you')
    })

    test('an in-progress card whose read fails is still listed, with one line saying its agent is unknown', async ($, on) => {
      const { pane } = await openPane($, on, surface, { cardFails: 'DX-9' })
      const t = await text(pane)
      expect(t).toContain("Couldn't load who is working on DX-9: the dashboard answered 500")
      expect(t).toContain('In flight card')
      expect(t).toContain('Which route?')
    })

    test('an opened problem whose solutions cannot be read is its own line; the pane and its row stay', async ($, on) => {
      const { pane } = await openPane($, on, surface, { problemsFail: true })
      await pane.press({ key: 'open-11' })
      const t = await text(pane)
      expect(t).toContain("Couldn't load the solutions of PBLM-11: the dashboard answered 500")
      expect(t).toContain('Second one?')
      expect(await pane.find({ key: 'use-112' })).toBeUndefined()
    })

    test('closing a problem reads nothing', async ($, on) => {
      const { d, pane } = await openPane($, on, surface)
      await pane.press({ key: 'open-11' })
      const before = d.api.length
      await pane.press({ key: 'open-11' })
      expect(d.api.length).toBe(before)
    })

    test('an oversize answer for one card is a person-facing line, never the host notice', async ($, on) => {
      const { d, pane } = await openPane($, on, surface, { cardOversize: 'DX-2' })
      const t = await text(pane)
      expect(t).toContain("Couldn't load DX-2: the dashboard answer was too large")
      expect(t).not.toMatch(/exceeds maximum|tool-results|characters across/)
      expect(t).toContain('Which route?')
      expect(d.toasts.join(' ')).not.toContain('exceeds')
    })

    test('the host notice on any call of the load is never the pane text', async () => {
      const oversize = async () => ({ ok: false, status: 0, body: { error: HOST_OVERSIZE(85_234) } })
      const v = await loadPlan(oversize, 't', null)
      expect(v.phase).toBe('error')
      expect(v.error).toBe('the dashboard answer was too large')
    })
  })
}
