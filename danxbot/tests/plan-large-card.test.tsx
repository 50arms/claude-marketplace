// DX-4458: a card with dozens of problems (DX-4443: 49 questions, two solutions each) answers over the host's size limit when
// its solutions come with it. The load reads problem rows only; an opened problem reads its own solutions; one card that
// cannot be read is one line and the rest of the pane still draws.
import { describe, expect, test } from 'claude-code/testing'

import { errText, failureReason, loadPlan } from '../hooks/plan/load'
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
      // the in-progress card is read for its agent name alone (DX-4405: assigned_agent_name, no relation)
      expect(issueReads(d).find((a: any) => a.path === '/api/issues/DX-9')?.query).toEqual({ fields: { assigned_agent_name: true } })
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

    test('an opened problem whose comments cannot be read shows that line and no solutions picker', async ($, on) => {
      const { pane } = await openPane($, on, surface, { commentsFail: true })
      await pane.press({ key: 'open-11' })
      expect(await text(pane)).toContain("Couldn't load the comments of PBLM-11: the dashboard answered 500")
      expect(await pane.find({ key: 'use-112' })).toBeUndefined()
    })

    test('an opened problem the narrowed read no longer returns says it is no longer open', async ($, on) => {
      const { pane } = await openPane($, on, surface, { problemsEmpty: true })
      await pane.press({ key: 'open-11' })
      expect(await text(pane)).toContain('PBLM-11 is no longer open on DX-1: refresh the pane.')
    })

    test('opening a problem reads its detail; a refresh with it open re-reads it; opening another moves the read; closing reads none', async ($, on) => {
      const { d, pane } = await openPane($, on, surface)
      const detailReads = () => d.api.filter((a: any) => /\/problems$/.test(a.path)).map((a: any) => a.query.q)
      await pane.press({ key: 'open-11' })
      expect(detailReads()).toEqual(['Which route?'])
      await pane.press({ key: 'refresh' })
      expect(detailReads()).toEqual(['Which route?', 'Which route?'])
      await pane.press({ key: 'open-12' })
      expect(detailReads()).toEqual(['Which route?', 'Which route?', 'Allow the site'])
      await pane.press({ key: 'open-12' })
      expect(detailReads()).toHaveLength(3)
    })

    test('answering an opened problem on a large card with a failing card beside it lands, and no call exceeded the host limit', async ($, on) => {
      const { d, pane } = await openPane($, on, surface, { bigCard: true, cardFails: 'DX-2' })
      await pane.press({ key: 'open-305' })
      await pane.press({ key: 'use-3010' })
      expect(d.writes().map((w: any) => w.path)).toEqual(['/api/issues/DX-3/problems/305/answer'])
      const t = await text(pane)
      expect(t).toContain("Couldn't load DX-2")
      expect(t).not.toContain('Question 5?')
      expect(t).not.toMatch(/exceeds maximum/)
    })

    test('a signed-out answer to a detail read ends the view as signed out, never a line on the problem', async ($, on) => {
      const { d, pane } = await openPane($, on, surface)
      d.world.signedOut = 'lapsed'
      await pane.press({ key: 'open-11' })
      const t = await text(pane)
      expect(t).toContain('signed out')
      expect(t).not.toContain("Couldn't load")
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

describe('what a failed call says to a person', () => {
  const r = (status: number, body: any) => ({ ok: false, status, body })
  test('the host oversize notice (in error or message) is the too-large line; others say what answered, never the body', () => {
    expect(failureReason(r(0, { error: HOST_OVERSIZE(85_234) }))).toBe('the dashboard answer was too large')
    expect(failureReason(r(0, { message: HOST_OVERSIZE(1) }))).toBe('the dashboard answer was too large')
    expect(errText(r(0, { error: HOST_OVERSIZE(85_234) }))).toBe('the dashboard answer was too large')
    expect(failureReason(r(500, { error: 'secret server text' }))).toBe('the dashboard answered 500')
    expect(failureReason(r(0, { error: 'secret' }))).toBe('the dashboard did not answer')
  })
})

// DX-4490 / DX-4492: every dashboard list sorts by `?sort=<field>&order=asc|desc`; any other sort shape is a 400. The pane's card
// lists ask for the most important first: field `priority`, order `desc`.
for (const surface of SURFACES) {
  describe(`the pane's card lists on ${surface}`, () => {
    test('ask the dashboard for a sort field and order it accepts', async ($, on) => {
      const { d } = await openPane($, on, surface)
      const sorted = d.api.filter((a: any) => a.method === 'GET' && /^\/api\/plans\/[^/]+\/cards$/.test(a.path) && a.query?.sort !== undefined)
      expect(sorted.length).toBeGreaterThan(0)
      for (const a of sorted) expect({ sort: a.query.sort, order: a.query.order }).toEqual({ sort: 'priority', order: 'desc' })
    })
  })
}
