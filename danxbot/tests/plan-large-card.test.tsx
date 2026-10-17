// DX-4458: a card with dozens of problems (DX-4443: 49 questions) is read for its problem rows only; one card that cannot be
// read leaves the plan ready and the band's count a lower bound.
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
    test('the load reads each card for its problem rows only: no solutions, no comments, no descriptions', async ($, on) => {
      const { d, band } = await openBand($, on, surface, { bigCard: true })
      // DX-4415: an in-progress card is listed by its id from the cards list alone: no read of its own
      const reads = issueReads(d)
      expect(reads.map((a: any) => a.path).sort()).toEqual(['/api/issues/DX-1', '/api/issues/DX-2', '/api/issues/DX-3'])
      for (const a of reads) expect(a.query).toEqual({ fields: { problems: true } })
      expect(await problemBadgeOf(band)).toBe('⚠ 52')
      expect(await text(band)).not.toContain('Disconnected')
    })

    test('one card that cannot be read leaves the plan ready; the count covers the cards that were read and is a lower bound', async ($, on) => {
      const { band } = await openBand($, on, surface, { cardFails: 'DX-2' })
      expect(await problemBadgeOf(band)).toBe('⚠ 2+')
      expect(await text(band)).not.toContain('Disconnected')
    })

    test('an unread card makes the count a lower bound', async ($, on) => {
      const { band } = await openBand($, on, surface, { cardFails: 'DX-1' })
      expect(await problemBadgeOf(band)).toBe('⚠ 1+')
    })

    test('an oversize answer for one card leaves the plan ready, and the host notice is never shown', async ($, on) => {
      const { d, band } = await openBand($, on, surface, { cardOversize: 'DX-2' })
      expect(await text(band)).not.toMatch(/exceeds maximum|tool-results|characters across|Disconnected/)
      expect(d.toasts.join(' ')).not.toContain('exceeds')
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
