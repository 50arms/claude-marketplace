// DX-4346: the Plan pane's In progress section, loaded in the same refresh as Needs You.
import { describe, expect, test } from 'claude-code/testing'

import { age } from '../hooks/plan/words'
import { DASHBOARD_URL, SURFACES, dashboard, footerText, mountIndicator, startSession, forceRefresh } from './plan-kit'

const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const callsTo = (d: any, bucket: string) =>
  d.api.filter((a: any) => /^\/api\/plans\/23\/cards$/.test(a.path) && a.query?.bucket === bucket).length

describe('how the pane words an age (against the fake clock, never Date.now)', () => {
  const NOW = Date.parse('2026-10-03T08:00:00.000Z')
  for (const [iso, words] of [
    ['2026-10-03T07:58:30.000Z', '1m ago'],
    ['2026-10-03T07:55:00.000Z', '5m ago'],
    ['2026-10-03T06:00:00.000Z', '2h ago'],
    ['2026-09-30T08:00:00.000Z', '3d ago'],
  ] as const) {
    test(`${iso} reads ${words}`, () => {
      expect(age(iso, NOW)).toBe(words)
    })
  }
})

for (const surface of SURFACES) {
  describe(`the In progress section on ${surface}`, () => {
    test('two sections, Needs You and In progress; a row shows id (linked to its card page), title, agent name and updated age', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      const all = await text(pane)
      expect(all).toContain('Needs You')
      expect(all).toContain('In progress')
      expect(all).toContain('1 not waiting on you')
      expect(all).toContain('In flight card')
      expect(all).toContain('PLAN-23: danxbot plugin')
      // the card's `updatedAt` worded as updated, never as time in progress
      expect(all).toContain('updated 1m ago')
      expect(all).not.toContain('raw-session-uuid')
      const link = (await pane.findAll({ type: 'Link' })).find((l: any) => l.props.label === 'DX-9')
      expect(link?.props.href).toBe(`${DASHBOARD_URL}/plans/23/cards/DX-9`)
    })

    test('a card nobody holds shows no agent, never the word null', async ($, on) => {
      const d = dashboard(on, { noAgent: true })
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      const all = await text(pane)
      expect(all).toContain('In flight card')
      expect(all).not.toContain('null')
    })

    test('an empty bucket is an explicit line, not a blank', async ($, on) => {
      const d = dashboard(on)
      d.world.inProgress.length = 0
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('No cards in progress that are not waiting on you.')
    })

    test('capped at the card limit: the line says how many more are in the browser, from total', async ($, on) => {
      const d = dashboard(on, { inProgressTotal: 20 })
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('+19 more in-progress cards in the browser')
      // the bucket's own total labels the bucket, not the status count (3 In Progress)
      expect(await text(pane)).toContain('20 not waiting on you')
    })

    test('one refresh loads both buckets, a reload adds exactly one load of each, through danxbot_api', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      expect(callsTo(d, 'needs-you')).toBe(1)
      expect(callsTo(d, 'in-progress')).toBe(1)
      await forceRefresh($, d)
      expect(callsTo(d, 'needs-you')).toBe(2)
      expect(callsTo(d, 'in-progress')).toBe(2)
      expect(d.calls.every(c => c.server !== 'plugin:danxbot:danx-dashboard' || c.tool === 'danxbot_api' || c.tool === 'plan_connect' || c.tool === 'plan_events_wait')).toBe(true)
    })

    test('a failed in-progress call fails the load as an error shown in footer and pane, never a missing section', async ($, on) => {
      const d = dashboard(on, { inProgressFails: true })
      await startSession($, d, surface)
      expect(await footerText(await mountIndicator($, surface))).toBe('Danxbot · PLAN-23')
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('in-progress boom')
      expect(await text(pane)).not.toContain('In progress')
    })

    test('an in-progress answer with no total is the same error', async ($, on) => {
      const d = dashboard(on, { noInProgressTotal: true })
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('answered no total')
      expect(await footerText(await mountIndicator($, surface))).toBe('Danxbot · PLAN-23')
    })
  })
}
