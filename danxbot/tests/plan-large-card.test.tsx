import "./run-tests-with-npm-test.generated"
// DX-4458: a card with dozens of problems (DX-4443: 49 questions) is never read for its rows: the count comes from the every-card list.
import { describe, expect } from 'claude-code/testing'

import { errText, failureReason, loadPlan } from '../hooks/plan/load'
import { test, HOST_OVERSIZE, SURFACES, dashboard, problemBadgeOf, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')

async function openBand($: any, on: any, surface: (typeof SURFACES)[number], options: any = {}) {
  const d = dashboard(on, options)
  await startSession($, d, surface)
  const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
  return { d, band }
}

const issueReads = (d: any) => d.api.filter((a: any) => a.method === 'GET' && /^\/api\/issues\/[A-Z]+-\d+$/.test(a.path))

for (const surface of SURFACES) {
  describe(`a card with many problems on ${surface}`, () => {
    test('the load reads no card of its own: the count is summed from the every-card list, whatever one card holds', async ($, on) => {
      const { d, band } = await openBand($, on, surface, { bigCard: true })
      expect(issueReads(d)).toEqual([])
      expect(await problemBadgeOf(band)).toBe('⚠ 52')
      expect(await text(band)).not.toContain('Disconnected')
    })

    test('the plan list is asked for one row only, however many plans exist', async ($, on) => {
      const { d } = await openBand($, on, surface)
      const lists = d.api.filter((a: any) => a.method === 'GET' && a.path === '/api/plans')
      expect(lists.length).toBeGreaterThan(0)
      for (const a of lists) expect(a.query).toEqual({ limit: 1 })
    })

    test('the host notice on any call of the load is never the band text', async () => {
      const oversize = async () => ({ ok: false, status: 0, body: { error: HOST_OVERSIZE(85_234) } })
      const v = await loadPlan(oversize, 't')
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

// DX-4490 / DX-4492: every dashboard list sorts by `?sort=<field>&order=asc|desc`; any other sort shape is a 400. The plan's card
// lists ask for the most important first: field `priority`, order `desc`.
for (const surface of SURFACES) {
  describe(`the plan's card lists on ${surface}`, () => {
    test('ask the dashboard for a sort field and order it accepts', async ($, on) => {
      const { d } = await openBand($, on, surface)
      const sorted = d.api.filter((a: any) => a.method === 'GET' && /^\/api\/plans\/[^/]+\/cards$/.test(a.path) && a.query?.sort !== undefined)
      expect(sorted.length).toBeGreaterThan(0)
      for (const a of sorted) expect({ sort: a.query.sort, order: a.query.order }).toEqual({ sort: 'priority', order: 'desc' })
    })
  })
}
