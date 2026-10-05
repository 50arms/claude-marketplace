// DX-4339 (PLAN-29): the plan band and pane show each enabled pacing limit's usage against its target and critical threshold, the level, the
// time to reset, and in the pane the account's budget (and the hold until the reset). The usage is the session's own reading and moves with it;
// the targets come from GET /api/team/pacing, the verdict from the DX-4340 cache. With the settings read not working the session's own usage
// still shows against the last settings read, marked local: quietly for a session with no danxbot, with the named error when danxbot answered
// and the answer was unusable.
//
// UNVERIFIED live (DX-4340 is not deployed): these suites run on the stand-in dashboard (plan-kit); the desktop and terminal check in a real
// session is the card's last acceptance item.
import { describe, expect, test } from 'claude-code/testing'

import { BAND_GAP_COLS, DANGER, POLL_MS, SUCCESS, USAGE_TICK_MS, WARNING } from '../hooks/plan/config'
import { bandText, clockText, untilText, verdictLines } from '../hooks/plan/pacing-format'
import { EMPTY_PANEL_STATE, buildPanel } from '../hooks/plan/pacing-panel'
import { parseTeamPacing } from '../hooks/plan/pacing-settings'
import { LEVEL_COLOR } from '../hooks/plan/pacing-panel-view'
import type { PanelState } from '../types'
import { SURFACES, dashboard, startSession } from './plan-kit'

const FIVE = '2026-10-03T11:10:00.000Z'
const WEEK = '2026-10-09T09:00:00.000Z'
const WINDOWS = [
  { kind: 'five_hour', percentUsed: 62, resetsAt: FIVE },
  { kind: 'seven_day', percentUsed: 41, resetsAt: WEEK },
]
const five = { enabled: true, target_percent: 80, mode: 'spread_evenly', critical_percent: 95 }
const weekly = { enabled: true, target_percent: 70, mode: 'fast_then_hold', critical_percent: 90 }
const SETTINGS = { five_hour: five, weekly }
const NOW = Date.parse('2026-10-03T08:00:00.000Z')

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = { component: 'Pane', requestId: 'danx-plan', props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' } } as any
const LINE = 'Pacing: this account is over pace; 0 agents may run on the account until 2026-10-09 09:00 UTC. Do the work yourself, cheaply.'
const verdictBody = (over: Record<string, unknown> = {}) => ({ account: 'uuid:u1', level: 'over_pace', budget: 0, resets_at: FIVE, running_agents: 3, line: LINE, reason: null, ...over })

const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string)
const joined = async (ui: any) => (await texts(ui)).join(' ')

// a session whose windows the harness has reported (session.measure) and whose pacing reads are answered by `options`
async function paced($: any, on: any, surface: string, options: Parameters<typeof dashboard>[1] = {}) {
  const d = dashboard(on, options)
  d.world.rateLimits = WINDOWS
  on('session.measure', () => ({ changed: ['rateLimits'] }) as any)
  await startSession($, d, surface)
  await $.session.measure({ context: {}, rateLimits: WINDOWS, changed: ['rateLimits'] } as any)
  await d.clock.settle()
  return d
}

const state = (over: Partial<PanelState> = {}): PanelState => ({
  ...EMPTY_PANEL_STATE,
  settings: { five_hour: { enabled: true, targetPercent: 80, mode: 'spread_evenly', criticalPercent: 95 }, weekly: { enabled: true, targetPercent: 70, mode: 'fast_then_hold', criticalPercent: 90 } },
  settingsAt: NOW,
  settingsRead: { state: 'ok' },
  limits: WINDOWS.map(w => ({ ...w })),
  ...over,
})

describe('the panel model', () => {
  test('parseTeamPacing reads danxbot settings and refuses anything else', () => {
    expect(parseTeamPacing({ id: 1, ...SETTINGS })).toEqual({
      five_hour: { enabled: true, targetPercent: 80, mode: 'spread_evenly', criticalPercent: 95 },
      weekly: { enabled: true, targetPercent: 70, mode: 'fast_then_hold', criticalPercent: 90 },
    })
    expect(parseTeamPacing({ five_hour: five })).toEqual({ error: expect.any(String) })
    expect(parseTeamPacing({ ...SETTINGS, weekly: { ...weekly, mode: 'sprint' } })).toEqual({ error: expect.any(String) })
    expect(parseTeamPacing({ ...SETTINGS, weekly: { ...weekly, target_percent: '70' } })).toEqual({ error: expect.any(String) })
    expect(parseTeamPacing(null)).toEqual({ error: expect.any(String) })
  })

  test('each limit is judged by its own thresholds: on pace below the target, over pace at it, critical at the threshold', () => {
    const level = (used: number) => buildPanel(state({ limits: [{ kind: 'five_hour', percentUsed: used, resetsAt: FIVE }] })).entries[0]!.level
    expect([79, 80, 94, 95, 100].map(level)).toEqual(['on_pace', 'over_pace', 'over_pace', 'critical', 'critical'])
  })

  test('the level is judged on the unrounded figure and only the display is rounded', () => {
    const m = buildPanel(state({ limits: [{ kind: 'five_hour', percentUsed: 79.6, resetsAt: FIVE }] }))
    expect(m.entries[0]).toMatchObject({ used: 80, level: 'on_pace' })
    expect(bandText(m)).toBe('5h 80%/80% 7d …')
  })

  test('a limit the team switched off is not shown, and one with no figure shows no reading', () => {
    const off = buildPanel(state({ settings: { ...state().settings!, weekly: { ...state().settings!.weekly, enabled: false } } }))
    expect(off.entries.map(e => e.limit)).toEqual(['five_hour'])
    const none = buildPanel(state({ limits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: FIVE }] }))
    expect(none.entries.map(e => [e.limit, e.used, e.level])).toEqual([['five_hour', 10, 'on_pace'], ['weekly', null, null]])
  })

  test('no settings read and no figure is nothing to show; no settings with a figure shows the figure with no level', () => {
    expect(buildPanel(EMPTY_PANEL_STATE).entries).toEqual([])
    const m = buildPanel({ ...EMPTY_PANEL_STATE, limits: [{ kind: 'five_hour', percentUsed: 33.4, resetsAt: FIVE }] })
    expect(m.entries).toEqual([{ limit: 'five_hour', used: 33, resetsAt: Date.parse(FIVE), settings: null, level: null }])
  })

  test('not read yet is its own quiet state: not local, no error', () => {
    const m = buildPanel({ ...EMPTY_PANEL_STATE, limits: [{ kind: 'five_hour', percentUsed: 33, resetsAt: FIVE }] })
    expect(m).toMatchObject({ local: false, error: null })
    expect(bandText(m)).toBe('5h 33%')
  })

  test('a session with no danxbot is local with no error to name; a real error is local and names its text', () => {
    const limits = [{ kind: 'five_hour', percentUsed: 33, resetsAt: FIVE }]
    const silent = buildPanel({ ...EMPTY_PANEL_STATE, limits, settingsRead: { state: 'silent' } })
    expect(silent).toMatchObject({ local: true, error: null })
    expect(bandText(silent)).toBe('5h 33% local')
    const failed = buildPanel({ ...EMPTY_PANEL_STATE, limits, settingsRead: { state: 'error', message: 'the team pacing read answered 500' } })
    expect(failed).toMatchObject({ local: true, error: 'the team pacing read answered 500' })
  })

  test("the account's verdict raises the level of the window it is about, and only that one", () => {
    const m = buildPanel(state({ verdict: { level: 'over_pace', budget: 0, resetsAt: FIVE, runningAgents: 3 } }))
    expect(m.entries.map(e => [e.limit, e.level])).toEqual([['five_hour', 'over_pace'], ['weekly', 'on_pace']])
    // a verdict never lowers a threshold's own level
    const worse = buildPanel(state({ limits: [{ kind: 'five_hour', percentUsed: 96, resetsAt: FIVE }], verdict: { level: 'over_pace', budget: 0, resetsAt: FIVE, runningAgents: 1 } }))
    expect(worse.entries[0]!.level).toBe('critical')
  })

  test('with the settings read failing the verdict is dropped and the panel is local, still against the last settings', () => {
    const m = buildPanel(state({ settingsRead: { state: 'silent' }, verdict: { level: 'critical', budget: 0, resetsAt: FIVE, runningAgents: 1 } }))
    expect(m.verdict).toBeNull()
    expect(m.local).toBe(true)
    expect(bandText(m)).toBe('5h 62%/80% 7d 41%/70% local')
  })

  test('the band text is used / target with a mark besides the colour for a level above on pace', () => {
    const m = buildPanel(state({ limits: [{ kind: 'five_hour', percentUsed: 85, resetsAt: FIVE }, { kind: 'seven_day', percentUsed: 91, resetsAt: WEEK }] }))
    expect(bandText(m)).toBe('5h 85%/80% ▲ 7d 91%/70% ‼')
  })

  test('time to reset and the clock time read in the largest sensible units', () => {
    expect([30_000, 59 * 60_000, 3 * 3_600_000 + 10 * 60_000, 25 * 3_600_000, -5].map(ms => untilText(NOW + ms, NOW))).toEqual(['under a minute', '59m', '3h 10m', '1d 1h', 'under a minute'])
    expect(clockText(Date.parse(FIVE))).toBe('Sat 11:10Z')
  })

  test('the verdict lines say budget and running agents, and a hold until the reset only when it holds new work', () => {
    expect(verdictLines({ level: 'over_pace', budget: 0, resetsAt: FIVE, runningAgents: 3 }, NOW)).toEqual([
      'Account: over pace · budget 0 agents may start · 3 running',
      'Holding: no new agents start until the window resets, Sat 11:10Z (in 3h 10m).',
    ])
    expect(verdictLines({ level: 'on_pace', budget: null, resetsAt: FIVE, runningAgents: 1 }, NOW)).toEqual(['Account: on pace · budget no cap · 1 running'])
    expect(verdictLines({ level: 'on_pace', budget: 2, resetsAt: null, runningAgents: 1 }, NOW)).toEqual(['Account: on pace · budget 2 agents at most at once · 1 running'])
  })
})

for (const surface of SURFACES)
  describe(`the pacing panel on ${surface}`, () => {
    test('the band shows each enabled limit as used / target, coloured by level, and the pane the target, critical, mode, reset, level and budget', async ($, on) => {
      const d = await paced($, on, surface, { teamPacing: { body: SETTINGS }, pacingLine: { body: verdictBody() } })
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await joined(band)).toContain('5h 62%/80% ▲ 7d 41%/70%')
      expect(await joined(band)).not.toContain('local')
      expect((await band.find({ type: 'Text', text: /^5h 62%/ })).props.color).toBe(LEVEL_COLOR.over_pace)
      expect((await band.find({ type: 'Text', text: /^7d 41%/ })).props.color).toBe(LEVEL_COLOR.on_pace)
      expect(LEVEL_COLOR).toEqual({ on_pace: SUCCESS, over_pace: WARNING, critical: DANGER })

      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      const all = await joined(pane)
      expect(all).toContain('5-hour')
      expect(all).toContain('62% used')
      expect(all).toContain('target 80% · critical 95% · spread evenly · resets in 3h 10m (Sat 11:10Z)')
      expect(all).toContain('target 70% · critical 90% · fast then hold · resets in 6d 1h')
      expect(all).toContain('Account: over pace · budget 0 agents may start · 3 running')
      expect(all).toContain('Holding: no new agents start until the window resets, Sat 11:10Z (in 3h 10m).')
      expect(d.toasts.filter(t => /pacing/i.test(t))).toEqual([])
    })

    test('the figures move with the session: a new reading redraws the band and the pane', async ($, on) => {
      const d = await paced($, on, surface, { teamPacing: { body: SETTINGS }, pacingLine: { body: verdictBody({ level: 'on_pace', budget: null }) } })
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await joined(band)).toContain('5h 62%/80% 7d 41%/70%')
      const moved = [{ kind: 'five_hour', percentUsed: 96, resetsAt: FIVE }, { kind: 'seven_day', percentUsed: 41, resetsAt: WEEK }]
      await $.session.measure({ context: {}, rateLimits: moved, changed: ['rateLimits'] } as any)
      await d.clock.settle()
      expect(await joined(band)).toContain('5h 96%/80% ‼')
      expect(await joined(pane)).toContain('96% used')
      expect((await band.find({ type: 'Text', text: /^5h 96%/ })).props.color).toBe(DANGER)
    })

    test('a measure that carries no windows says nothing about them: the last values stand; an empty list clears them', async ($, on) => {
      const d = await paced($, on, surface, { teamPacing: { body: SETTINGS } })
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      await $.session.measure({ context: {}, changed: [] } as any)
      await d.clock.settle()
      expect(await joined(band)).toContain('5h 62%/80% 7d 41%/70%')
      await $.session.measure({ context: {}, rateLimits: [], changed: ['rateLimits'] } as any)
      await d.clock.settle()
      expect(await joined(band)).toContain('5h … 7d …')
    })

    test('an unreadable usage clears the windows instead of leaving a frozen figure as current', async ($, on) => {
      const d = await paced($, on, surface, { teamPacing: { body: SETTINGS } })
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await joined(band)).toContain('5h 62%/80%')
      d.failUsage('no usage reading')
      await d.clock.advance(USAGE_TICK_MS + 1)
      await d.clock.settle()
      expect(await joined(band)).toContain('5h … 7d …')
      expect(await joined(band)).not.toContain('62%')
      // the connected session toasts the failed reading, once
      expect(d.toasts.filter(t => t.startsWith('Usage not reported'))).toHaveLength(1)
    })

    test('a settings change appears at the next poll with no restart, and a switched-off limit leaves the panel', async ($, on) => {
      const d = await paced($, on, surface, { teamPacing: { body: SETTINGS } })
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await joined(band)).toContain('5h 62%/80% 7d 41%/70%')
      d.setTeamPacing({ body: { five_hour: { ...five, target_percent: 60 }, weekly: { ...weekly, enabled: false } } })
      await d.clock.advance(POLL_MS + 1)
      await d.clock.settle()
      expect(await joined(band)).toContain('5h 62%/60% ▲')
      expect(await joined(band)).not.toContain('7d')
    })

    test('a verdict change appears at the first poll after it, the verdict re-read every poll', async ($, on) => {
      const d = await paced($, on, surface, { teamPacing: { body: SETTINGS }, pacingLine: { body: verdictBody({ level: 'on_pace', budget: null }) } })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await joined(pane)).toContain('Account: on pace · budget no cap · 3 running')
      expect(await joined(pane)).not.toContain('Holding')
      d.setPacingLine({ body: verdictBody({ level: 'critical', budget: 0 }) })
      await d.clock.advance(POLL_MS + 1)
      await d.clock.settle()
      expect(await joined(pane)).toContain('Account: critical · budget 0 agents may start · 3 running')
      expect(await joined(pane)).toContain('Holding: no new agents start until the window resets')
      expect(await joined(band)).toContain('5h 62%/80% ‼')
    })

    test('with no danxbot MCP the own usage shows against the last settings, marked local, with the pane saying nothing about a connection', async ($, on) => {
      const d = await paced($, on, surface, { teamPacing: { body: SETTINGS }, pacingLine: { body: verdictBody() } })
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await joined(band)).not.toContain('local')
      d.setMcp('down')
      await d.clock.advance(POLL_MS + 1)
      await d.clock.settle()
      expect(await joined(band)).toContain('5h 62%/80% 7d 41%/70% local')
      const all = await joined(pane)
      expect(all).toContain('local')
      expect(all).not.toMatch(/could not be read|cannot be reached/)
      // the verdict is not shown as current
      expect(all).not.toContain('Account:')
      expect(all).not.toContain('Holding')
      // the panel itself toasts nothing: the one toast is DX-4340's own pacing-line read, told once, now that a read had succeeded
      expect(d.toasts.filter(t => /panel|settings/i.test(t))).toEqual([])
      expect(d.toasts.filter(t => t.startsWith('Usage pacing could not be read'))).toEqual([
        'Usage pacing could not be read (spawns are not paced, sub-agents get no pacing line, until it can): the danx-dashboard MCP server is not reachable from this session',
      ])
      // the MCP is back: the marker clears
      d.setMcp('up')
      await d.clock.advance(POLL_MS + 1)
      await d.clock.settle()
      expect(await joined(band)).not.toContain('local')
    })

    test('a real error from danxbot is named once in the pane, the band only says local, and nothing is toasted', async ($, on) => {
      const d = await paced($, on, surface, { teamPacing: { body: SETTINGS }, pacingLine: { body: verdictBody() } })
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      d.setTeamPacing({ status: 500 })
      await d.clock.advance(POLL_MS + 1)
      await d.clock.settle()
      expect(await joined(band)).toContain('5h 62%/80% 7d 41%/70% local')
      const all = await joined(pane)
      expect(all.match(/Pacing settings could not be read/g)).toHaveLength(1)
      expect(all).toContain('the team pacing read answered 500')
      expect(all).toContain('targets last read')
      expect(all).not.toContain('Account:')
      expect(d.toasts.filter(t => /panel|settings/i.test(t))).toEqual([])
      // a wrong-shaped answer is an error too
      d.setTeamPacing({ body: { five_hour: five } })
      await d.clock.advance(POLL_MS + 1)
      await d.clock.settle()
      expect(await joined(pane)).toContain('no readable five_hour and weekly settings')
    })

    for (const signedOut of ['signed-out', 'revoked'] as const)
      test(`a session that is ${signedOut} is local with nothing said about it, its own usage still shown`, async ($, on) => {
        const d = dashboard(on, { signedOut, teamPacing: { body: SETTINGS } })
        d.world.rateLimits = WINDOWS
        await startSession($, d, surface)
        const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
        const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
        expect(await joined(band)).toContain('5h 62% 7d 41% local')
        expect(await joined(pane)).toContain('local')
        expect(await joined(pane)).not.toContain('could not be read')
        expect(d.toasts.filter(t => /panel|settings/i.test(t))).toEqual([])
      })

    test('a real settings error shows in the pane even when there is no window figure to draw', async ($, on) => {
      const d = dashboard(on, { teamPacing: { status: 500 } })
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await joined(pane)).toContain('Pacing settings could not be read: the team pacing read answered 500.')
      expect(await joined(pane)).not.toContain('own figures')
    })

    test('a session that never read settings (an old dashboard answers 404) shows its own usage with no targets and names the 404', async ($, on) => {
      await paced($, on, surface, { teamPacing: { status: 404 } })
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await joined(band)).toContain('5h 62% 7d 41% local')
      expect(await joined(pane)).toContain('the team pacing read answered 404')
      expect(await joined(pane)).toContain('no known targets')
    })

    test('a session with nothing to show (no windows, no settings) draws no pacing at all', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await joined(band)).not.toMatch(/5h|7d|local/)
      expect(await joined(pane)).not.toContain('Usage pacing')
    })

    test('the band cuts the plan name to the columns the pacing entries leave', async ($, on) => {
      const d = dashboard(on, { planName: 'A very long plan name that goes on and on and on and on and on and on and on and on and on and on and on and on and on' })
      on('session.measure', () => ({ changed: ['rateLimits'] }) as any)
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 130 } } as any)
      const labelOf = async () => (await ui.find({ type: 'Text', text: /PLAN-23/ }))?.text as string
      // no figure yet and no settings (the stand-in answers 404): nothing of pacing is drawn
      const without = await labelOf()
      await $.session.measure({ context: {}, rateLimits: WINDOWS, changed: ['rateLimits'] } as any)
      await d.clock.settle()
      expect(await joined(ui)).toContain('5h 62% 7d 41% local')
      // `PLAN-23 · ` stays; the name loses exactly the columns the pacing text and its gap take
      expect(without.length - (await labelOf()).length).toBe('5h 62% 7d 41% local'.length + BAND_GAP_COLS)
    })
  })
