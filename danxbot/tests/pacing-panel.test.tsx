// DX-4339 (PLAN-29): the plan band and pane show each enabled pacing limit's usage against its target and critical threshold, the level, the
// time to reset, and in the pane the account's budget (and the hold until the reset). The usage is the session's own reading and moves with it;
// the targets come from GET /api/team/pacing, the verdict from the DX-4340 cache. With the settings read not working the session's own usage
// still shows against the last settings read, marked local: quietly for a session with no danxbot, with the named error when danxbot answered
// and the answer was unusable.
//
// UNVERIFIED live (DX-4340 is not deployed): these suites run on the stand-in dashboard (plan-kit); the desktop and terminal check in a real
// session is the card's last acceptance item.
import { describe, expect, test } from 'claude-code/testing'

import { BAND_GAP_COLS, DANGER, ORANGE, PACING_POLL_MS, SUCCESS, USAGE_TICK_MS, WARNING } from '../hooks/plan/config'
import { bandText, clockText, formatMinutes, readoutSentence, untilText, verdictLines } from '../hooks/plan/pacing-format'
import { EMPTY_PANEL_STATE, buildPanel } from '../hooks/plan/pacing-panel'
import { parseTeamPacing } from '../hooks/plan/pacing-settings'
import { LEVEL_COLOR, TONE_COLOR } from '../hooks/plan/pacing-panel-view'
import type { LimitReadout, PanelState } from '../types'
import { SURFACES, dashboard, startSession } from './plan-kit'

const FIVE = '2026-10-03T11:10:00.000Z'
const WEEK = '2026-10-09T09:00:00.000Z'
const WINDOWS = [
  { kind: 'five_hour', percentUsed: 62, resetsAt: FIVE },
  { kind: 'seven_day', percentUsed: 41, resetsAt: WEEK },
]
const five = { enabled: true, target_percent: 80, mode: 'spread_evenly', critical_percent: 95 }
const weekly = { enabled: true, target_percent: 70, mode: 'fast_then_hold', critical_percent: 90 }
const spendOff = { enabled: false, target_percent: 80, mode: 'spread_evenly', critical_percent: 95, budget_usd: 50, period: { kind: 'days', count: 7 } }
const spendOn = { ...spendOff, enabled: true }
const SETTINGS = { five_hour: five, weekly, spend: spendOff }
const NOW = Date.parse('2026-10-03T08:00:00.000Z')

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = { component: 'Pane', requestId: 'danx-plan', props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' } } as any
const LINE = 'Pacing: this account is over pace; 0 agents may run on the account until 2026-10-09 09:00 UTC. Do the work yourself, cheaply.'
const HOLD_FIVE = { limit: 'five_hour', level: 'over_pace', state: 'hold', headroom_minutes: -40, resets_in_minutes: 100, used_percent: 62, target_percent: 80, critical_percent: 95, resets_at: FIVE }
const SPARE_FIVE = { ...HOLD_FIVE, level: 'on_pace', state: 'spare', headroom_minutes: 60 }
const verdictBody = (over: Record<string, unknown> = {}) => ({ account: 'uuid:u1', level: 'over_pace', budget: 0, resets_at: FIVE, running_agents: 3, line: LINE, spend: null, limits: [HOLD_FIVE], worst_limit: 'five_hour', reason: null, ...over })

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

const SPEND_OFF = { enabled: false, targetPercent: 80, mode: 'spread_evenly' as const, criticalPercent: 95, budgetUsd: 50, period: { kind: 'days' as const, count: 7 } }
const state = (over: Partial<PanelState> = {}): PanelState => ({
  ...EMPTY_PANEL_STATE,
  settings: { five_hour: { enabled: true, targetPercent: 80, mode: 'spread_evenly', criticalPercent: 95 }, weekly: { enabled: true, targetPercent: 70, mode: 'fast_then_hold', criticalPercent: 90 }, spend: SPEND_OFF },
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
      spend: SPEND_OFF,
    })
    expect(parseTeamPacing({ five_hour: five })).toEqual({ error: expect.any(String) })
    expect(parseTeamPacing({ ...SETTINGS, weekly: { ...weekly, mode: 'sprint' } })).toEqual({ error: expect.any(String) })
    expect(parseTeamPacing({ ...SETTINGS, weekly: { ...weekly, target_percent: '70' } })).toEqual({ error: expect.any(String) })
    expect(parseTeamPacing(null)).toEqual({ error: expect.any(String) })
  })

  // DX-4595
  test('parseTeamPacing reads the spend settings and fails loud without a readable spend object', () => {
    const parsed = parseTeamPacing({ ...SETTINGS, spend: { ...spendOn, budget_usd: null, period: { kind: 'hours', count: 12 } } }) as any
    expect(parsed.spend).toEqual({ enabled: true, targetPercent: 80, mode: 'spread_evenly', criticalPercent: 95, budgetUsd: null, period: { kind: 'hours', count: 12 } })
    const { spend: _omit, ...without } = SETTINGS
    expect(parseTeamPacing(without)).toEqual({ error: expect.stringContaining('spend') })
    expect(parseTeamPacing({ ...SETTINGS, spend: { ...spendOn, period: { kind: 'weeks', count: 1 } } })).toEqual({ error: expect.stringContaining('spend') })
    expect(parseTeamPacing({ ...SETTINGS, spend: { ...spendOn, budget_usd: '50' } })).toEqual({ error: expect.stringContaining('spend') })
  })

  describe('the spend limit (DX-4595)', () => {
    const enabled = (over: Partial<PanelState> = {}) => state({ settings: { ...state().settings!, spend: { ...SPEND_OFF, enabled: true } }, ...over })
    const figure = { usedPercent: 61.6, level: 'over_pace' as const, resetsAt: WEEK, spentUsd: 30.8, budgetUsd: 50 }

    test('is hidden while the team has not enabled it, even when the line carries a figure', () => {
      const m = buildPanel(state({ spend: figure }))
      expect(m.spend).toBeNull()
      expect(bandText(m)).toBe('5h 62%/80% 7d 41%/70%')
    })

    test("its figure and level come straight from the server's spend, and the money shows", () => {
      const m = buildPanel(enabled({ spend: figure }))
      expect(m.spend).toMatchObject({ state: 'figure', used: 62, resetsAt: Date.parse(WEEK), spentUsd: 30.8, budgetUsd: 50, level: 'over_pace' })
      expect(bandText(m)).toBe('5h 62%/80% 7d 41%/70% spend 62%/80% ▲')
    })

    test('the server level stands even when it is worse than the thresholds would give', () => {
      const m = buildPanel(enabled({ spend: { ...figure, usedPercent: 10, level: 'critical' } }))
      expect(m.spend).toMatchObject({ used: 10, level: 'critical' })
      expect(bandText(m)).toContain('spend 10%/80% ‼')
    })

    test('with no spend on the line there is no figure and no level', () => {
      const m = buildPanel(enabled({ spend: null }))
      expect(m.spend).toMatchObject({ state: 'unjudged', used: null, level: null, spentUsd: null })
      expect(bandText(m)).toBe('5h 62%/80% 7d 41%/70% spend …')
    })

    test('with the dashboard unreachable it needs danxbot, while 5-hour and weekly keep their local figures', () => {
      for (const settingsRead of [{ state: 'silent' }, { state: 'error', message: 'boom' }] as const) {
        const m = buildPanel(enabled({ settingsRead, spend: figure }))
        expect(m.spend).toMatchObject({ state: 'needs_danxbot', used: null, level: null })
        expect(m.local).toBe(true)
        expect(bandText(m)).toBe('5h 62%/80% 7d 41%/70% spend needs danxbot local')
      }
    })

    test('shows alone when the session has no window figures and the windows are off', () => {
      const s = enabled().settings!
      const m = buildPanel(enabled({ limits: [], settings: { ...s, five_hour: { ...s.five_hour, enabled: false }, weekly: { ...s.weekly, enabled: false } }, spend: figure }))
      expect(bandText(m)).toBe('spend 62%/80% ▲')
    })
  })

  test('each limit is judged by its own thresholds: on pace below the target, over pace at it, critical at the threshold', () => {
    const level = (used: number) => buildPanel(state({ limits: [{ kind: 'five_hour', percentUsed: used, resetsAt: FIVE }] })).entries[0]!.level
    expect([79, 80, 94, 95, 100].map(level)).toEqual(['on_pace', 'over_pace', 'over_pace', 'critical', 'critical'])
  })

  // DX-4591: a team may set the critical threshold equal to the target; then the used percent alone has no over-pace band (on pace below it, critical at it); the server's verdict can still call over pace below the target from its reserve or projection.
  test('a critical threshold equal to the target leaves no over-pace band by used percent: on pace below it, critical at it', () => {
    const equal = state({ settings: { five_hour: { enabled: true, targetPercent: 80, mode: 'spread_evenly', criticalPercent: 80 }, weekly: { enabled: false, targetPercent: 85, mode: 'fast_then_hold', criticalPercent: 85 } } })
    const level = (used: number) => buildPanel({ ...equal, limits: [{ kind: 'five_hour', percentUsed: used, resetsAt: FIVE }] }).entries[0]!.level
    expect([79, 79.9, 80, 100].map(level)).toEqual(['on_pace', 'on_pace', 'critical', 'critical'])
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

// DX-4656: the server's readout on the band, in its four forms
describe('the worst-limit readout', () => {
  const lim = (over: Partial<LimitReadout>): LimitReadout => ({ limit: 'five_hour', level: 'on_pace', state: 'spare', headroomMinutes: 60, resetsInMinutes: 100, usedPercent: 3, targetPercent: 95, criticalPercent: 99, resetsAt: FIVE, ...over })
  const band = (l: LimitReadout[], worst = l[0]!.limit) => buildPanel(state({ readout: { limits: l, worst } }))

  test('formatMinutes: 45m, 1h, 1h30m, -1h30m, 0m', () => {
    expect([45, 60, 90, -90, 0, 1440, 0.4, 2879].map(formatMinutes)).toEqual(['45m', '1h', '1h30m', '-1h30m', '0m', '24h', '0m', '47h59m'])
    // 48 h or more reads in days (DX-4657): the minutes drop, a 0h is left out
    expect([2880, -2880, 2940, -6691, 10080, 4320].map(formatMinutes)).toEqual(['2d', '-2d', '2d1h', '-4d15h', '7d', '3d'])
  })

  test('spare is +headroom green, short is -headroom yellow, hold is the time to reset orange, stop is just stop red', () => {
    const cases: [Partial<LimitReadout>, string, string][] = [
      [{ state: 'spare', headroomMinutes: 60 }, '5h 95%: +1h', SUCCESS],
      [{ state: 'short', level: 'on_pace', headroomMinutes: -90 }, '5h 95%: -1h30m', WARNING],
      [{ state: 'hold', level: 'over_pace', headroomMinutes: -20, resetsInMinutes: 100 }, '5h 95%: hold 1h40m', ORANGE],
      [{ state: 'stop', level: 'critical' }, '5h 95%: stop', DANGER],
    ]
    for (const [over, text, color] of cases) {
      expect(bandText(band([lim(over)]))).toBe(text)
      expect(TONE_COLOR[over.state!]).toBe(color)
    }
  })

  test('only the worst limit shows, named 7d for weekly and $ for spend', () => {
    const l = [lim({}), lim({ limit: 'weekly', state: 'short', headroomMinutes: -30, targetPercent: 90 }), lim({ limit: 'spend', state: 'spare', headroomMinutes: 5, targetPercent: 80 })]
    expect(bandText(band(l, 'weekly'))).toBe('7d 90%: -30m')
    expect(bandText(band([lim({ limit: 'weekly', state: 'short', headroomMinutes: -6691, targetPercent: 58 })]))).toBe('7d 58%: -4d15h')
    expect(bandText(band(l, 'spend'))).toBe('$ 80%: +5m')
  })

  test('with no readout the band is the session figures, and a failing settings read drops a stale one', () => {
    expect(bandText(buildPanel(state()))).toBe('5h 62%/80% 7d 41%/70%')
    const stale = state({ readout: { limits: [lim({})], worst: 'five_hour' }, settingsRead: { state: 'error', message: 'boom' } })
    expect(bandText(buildPanel(stale))).toBe('5h 62%/80% 7d 41%/70% local')
  })

  test('each limit is explained in plain words', () => {
    expect(readoutSentence(lim({ state: 'spare', headroomMinutes: 60 }))).toBe('5-hour limit: at the current rate you reach 95% about 1h after the window resets, so you have 1h spare.')
    expect(readoutSentence(lim({ limit: 'weekly', state: 'short', headroomMinutes: -90 }))).toBe('Weekly limit: at the current rate you reach 95% 1h30m before the window resets, so you are 1h30m short.')
    expect(readoutSentence(lim({ state: 'hold', resetsInMinutes: 100 }))).toBe('5-hour limit: over pace (past 95%), so nothing new starts until the window resets in 1h40m.')
    expect(readoutSentence(lim({ limit: 'spend', state: 'stop', resetsInMinutes: 45 }))).toBe('Spend limit: critical (past 99%), so everything new stops until the window resets in 45m.')
  })
})

for (const surface of SURFACES)
  describe(`the pacing panel on ${surface}`, () => {
    test('the band shows each enabled limit as used / target, coloured by level, and the pane the target, critical, mode, reset, level and budget', async ($, on) => {
      const d = await paced($, on, surface, { teamPacing: { body: SETTINGS }, pacingLine: { body: verdictBody() } })
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      // DX-4656: with the server's readout the band shows the worst limit alone
      expect(await joined(band)).toContain('5h 80%: hold 1h40m')
      expect(await joined(band)).not.toContain('7d')
      expect(await joined(band)).not.toContain('local')
      expect((await band.find({ type: 'Text', text: /^5h 80%/ })).props.color).toBe(ORANGE)
      expect(LEVEL_COLOR).toEqual({ on_pace: SUCCESS, over_pace: WARNING, critical: DANGER })

      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      const all = await joined(pane)
      expect(all).toContain('5-hour')
      expect(all).toContain('5-hour limit: over pace (past 80%), so nothing new starts until the window resets in 1h40m.')
      expect(all).toContain('62% used')
      expect(all).toContain('target 80% · critical 95% · spread evenly · resets in 3h 10m (Sat 11:10Z)')
      expect(all).toContain('target 70% · critical 90% · fast then hold · resets in 6d 1h')
      expect(all).toContain('Account: over pace · budget 0 agents may start · 3 running')
      expect(all).toContain('Holding: no new agents start until the window resets, Sat 11:10Z (in 3h 10m).')
      expect(d.toasts.filter(t => /pacing/i.test(t))).toEqual([])
    })

    // DX-4595
    test('the spend limit shows its server figure, the money, target, critical and reset, in the level colour', async ($, on) => {
      const spend = { used_percent: 61.6, level: 'critical', resets_at: WEEK, spent_usd: 12.4, budget_usd: 50 }
      await paced($, on, surface, { teamPacing: { body: { ...SETTINGS, spend: spendOn } }, pacingLine: { body: verdictBody({ spend, limits: [HOLD_FIVE, { ...HOLD_FIVE, limit: 'spend', level: 'critical', state: 'stop' }], worst_limit: 'spend' }) } })
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await joined(band)).toContain('$ 80%: stop')
      expect((await band.find({ type: 'Text', text: /^\$ 80%/ })).props.color).toBe(DANGER)
      const all = await joined(pane)
      expect(all).toContain('Spend limit: critical')
      expect(all).toContain('5-hour limit: over pace')
      expect(all).toContain('62% used')
      expect(all).toContain('$12.40 of $50.00 · target 80% · critical 95% · spread evenly · resets in 6d 1h')
    })

    test('spend with no spend on the line says danxbot has not judged it; with the MCP down it needs danxbot', async ($, on) => {
      const d = await paced($, on, surface, { teamPacing: { body: { ...SETTINGS, spend: spendOn } }, pacingLine: { body: verdictBody() } })
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await joined(band)).not.toContain('spend')
      expect(await joined(pane)).toContain('danxbot has not judged spend for this account yet')
      d.setMcp('down')
      await d.clock.advance(PACING_POLL_MS + 1)
      await d.clock.settle()
      expect(await joined(band)).toContain('5h 62%/80% 7d 41%/70% spend needs danxbot local')
      expect(await joined(pane)).toContain('needs danxbot')
    })

    test('a team with spend off draws no spend', async ($, on) => {
      await paced($, on, surface, { teamPacing: { body: SETTINGS }, pacingLine: { body: verdictBody() } })
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await joined(band)).not.toContain('spend')
    })

    test('the figures move with the session: a new reading redraws the band and the pane', async ($, on) => {
      const d = await paced($, on, surface, { teamPacing: { body: SETTINGS }, pacingLine: { body: verdictBody({ level: 'on_pace', budget: null, limits: [SPARE_FIVE] }) } })
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await joined(band)).toContain('5h 80%: +1h')
      const moved = [{ kind: 'five_hour', percentUsed: 96, resetsAt: FIVE }, { kind: 'seven_day', percentUsed: 41, resetsAt: WEEK }]
      await $.session.measure({ context: {}, rateLimits: moved, changed: ['rateLimits'] } as any)
      await d.clock.settle()
      expect(await joined(pane)).toContain('96% used')
      expect((await pane.find({ type: 'Text', text: '96% used' })).props.color).toBe(DANGER)
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
      d.setTeamPacing({ body: { ...SETTINGS, five_hour: { ...five, target_percent: 60 }, weekly: { ...weekly, enabled: false } } })
      await d.clock.advance(PACING_POLL_MS + 1)
      await d.clock.settle()
      expect(await joined(band)).toContain('5h 62%/60% ▲')
      expect(await joined(band)).not.toContain('7d')
    })

    test('a verdict change appears at the first poll after it, the verdict re-read every poll', async ($, on) => {
      const d = await paced($, on, surface, { teamPacing: { body: SETTINGS }, pacingLine: { body: verdictBody({ level: 'on_pace', budget: null, limits: [SPARE_FIVE] }) } })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await joined(pane)).toContain('Account: on pace · budget no cap · 3 running')
      expect(await joined(pane)).not.toContain('Holding')
      d.setPacingLine({ body: verdictBody({ level: 'critical', budget: 0, limits: [{ ...HOLD_FIVE, level: 'critical', state: 'stop' }] }) })
      await d.clock.advance(PACING_POLL_MS + 1)
      await d.clock.settle()
      expect(await joined(pane)).toContain('Account: critical · budget 0 agents may start · 3 running')
      expect(await joined(pane)).toContain('Holding: no new agents start until the window resets')
      expect(await joined(band)).toContain('5h 80%: stop')
      expect((await band.find({ type: 'Text', text: /^5h 80%/ })).props.color).toBe(DANGER)
    })

    test('with no danxbot MCP the own usage shows against the last settings, marked local, with the pane saying nothing about a connection', async ($, on) => {
      const d = await paced($, on, surface, { teamPacing: { body: SETTINGS }, pacingLine: { body: verdictBody() } })
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await joined(band)).not.toContain('local')
      d.setMcp('down')
      await d.clock.advance(PACING_POLL_MS + 1)
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
      await d.clock.advance(PACING_POLL_MS + 1)
      await d.clock.settle()
      expect(await joined(band)).not.toContain('local')
    })

    test('a real error from danxbot is named once in the pane, the band only says local, and nothing is toasted', async ($, on) => {
      const d = await paced($, on, surface, { teamPacing: { body: SETTINGS }, pacingLine: { body: verdictBody() } })
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      d.setTeamPacing({ status: 500 })
      await d.clock.advance(PACING_POLL_MS + 1)
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
      await d.clock.advance(PACING_POLL_MS + 1)
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

    // DX-4626: the column model is the terminal's; the desktop's layout cuts the name instead
    if (surface === 'terminal') {
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
    }
  })
