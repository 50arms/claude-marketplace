// DX-4499: the Plan pane's Sub-agents section: each running sub-agent of the plan's live sessions as its own card, read in the
// same refresh as the rest of the pane (DX-4498's two routes), its runtime counted on a local clock, ended ones dimmed until they drop.
import { describe, expect, test } from 'claude-code/testing'

import { SUBAGENTS_UNAVAILABLE_LINE, SUBAGENT_ACTIVITY_MAX, SUBAGENT_CARD_BACKGROUND, SUBAGENT_LABEL_MAX, SUBAGENT_STATE_COLOR, SUBAGENT_UNTITLED } from '../hooks/plan/config'
import { compactCount, dollars, duration, nestSubagents, visibleSubagents } from '../hooks/plan/subagents'
import { CLOCK_START, DASHBOARD_URL, OTHER_SESSION, OWN_SESSION, SURFACES, dashboard, endedSubagent, rawSubagent, startSession, forceRefresh, linksOf } from './plan-kit'

const pane = (bodyColumns = 100) =>
  ({ component: 'Pane', requestId: 'danx-plan', props: { title: 'Plan', isFocused: false, bodyColumns, placement: 'dock' } }) as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const cards = async (ui: any) => (await ui.findAll({ type: 'Box' })).filter((b: any) => String(b.key ?? '').startsWith('sa-'))
const cardKeys = async (ui: any) => (await cards(ui)).map((b: any) => b.key)
// every key of a described element's descendants, document order
const keysBelow = (el: any): string[] =>
  (el.children ?? []).flatMap((c: any) => (typeof c === 'string' ? [] : [...(c.props?.key ? [c.props.key] : []), ...keysBelow(c)]))
const OWN = OWN_SESSION.session_id
// DX-4508: the status dots of the Sub-agents section (the pane draws other dots above it), `<colour>:<dimmed>` each
const sectionDots = async (ui: any) => {
  const texts = await ui.findAll({ type: 'Text' })
  const from = texts.findIndex((t: any) => t.text === 'Sub-agents')
  return texts.slice(from).filter((t: any) => t.text === '●').map((t: any) => `${t.props.color}:${!!t.props.dimColor}`)
}
const subagentCalls = (d: any) => d.api.filter((a: any) => a.path.startsWith('/api/plan-sessions'))

describe('the words a sub-agent card is drawn in', () => {
  test('a runtime reads as seconds, minutes and seconds, or hours and minutes, and never goes negative', () => {
    expect(duration(0)).toBe('0s')
    expect(duration(38_900)).toBe('38s')
    expect(duration(252_000)).toBe('4m 12s')
    expect(duration(60_000)).toBe('1m 00s')
    expect(duration(3_900_000)).toBe('1h 05m')
    expect(duration(-5_000)).toBe('0s')
  })

  test('a token count is compact, and one that rounds up reads in the next unit', () => {
    expect(compactCount(950)).toBe('950')
    expect(compactCount(1_000)).toBe('1k')
    expect(compactCount(1_250)).toBe('1.3k')
    expect(compactCount(12_360)).toBe('12k')
    expect(compactCount(999_700)).toBe('1M')
    expect(compactCount(4_600_000)).toBe('4.6M')
  })

  test('a cost shows cents, and work that cost something never reads $0.00', () => {
    expect(dollars(0)).toBe('$0.00')
    expect(dollars(0.004)).toBe('<$0.01')
    expect(dollars(0.4216)).toBe('$0.42')
    expect(dollars(12.5)).toBe('$12.50')
  })
})

describe('which sub-agents show, and in what order', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'x', sessionId: 's', parentId: null, label: null, agentType: null, model: null, effort: null, state: 'running', startedAt: 0,
    finishedAt: null, visibleUntil: null, tokensTotal: 0, costUsd: 0, toolCalls: 0, activity: null, card: null, ...over,
  }) as any

  test('a running row always shows; an ended one until its visibleUntil passes on the pane clock', () => {
    const rows = [row({ id: 'r' }), row({ id: 'e', state: 'done', finishedAt: 100, visibleUntil: 600 })]
    expect(visibleSubagents(rows, 599).map(r => r.id)).toEqual(['r', 'e'])
    expect(visibleSubagents(rows, 600).map(r => r.id)).toEqual(['r'])
  })

  test('running rows come first, oldest start first; ended rows follow, newest finish first; the same at every level', () => {
    const rows = [
      row({ id: 'old', state: 'done', startedAt: 1, finishedAt: 50, visibleUntil: 1 }),
      row({ id: 'late', startedAt: 20 }),
      row({ id: 'new', state: 'failed', startedAt: 2, finishedAt: 90, visibleUntil: 1 }),
      row({ id: 'early', startedAt: 10 }),
      row({ id: 'kid-done', parentId: 'early', state: 'done', startedAt: 11, finishedAt: 30, visibleUntil: 1 }),
      row({ id: 'kid-run', parentId: 'early', startedAt: 12 }),
    ]
    const tree = nestSubagents(rows).map(n => [n.row.id, n.children.map(c => c.row.id)])
    expect(tree).toEqual([['early', ['kid-run', 'kid-done']], ['late', []], ['new', []], ['old', []]])
  })

  test('a row whose parent is not listed is a root', () => {
    expect(nestSubagents([row({ id: 'orphan', parentId: 'gone' })]).map(n => n.row.id)).toEqual(['orphan'])
  })
})

for (const surface of SURFACES) {
  describe(`a sub-agent card on ${surface}`, () => {
    // DX-4508: drawn as Claude Code's own background task cards are: no visible border, a raised fill, rounded corners, colour only
    // on the status dot. A Box rounds its corners only by drawing a `round` border, so the border is drawn in the card's own fill.
    test('a running sub-agent is its own card: a round border in its own fill, a raised fill, padding, a coloured dot, and every fact the operator asked for', async ($, on) => {
      const d = dashboard(on)
      d.world.subagents[OWN] = [rawSubagent('a1')]
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      const card = await ui.find({ key: 'sa-agent-a1' })
      expect(card?.props).toMatchObject({ backgroundColor: SUBAGENT_CARD_BACKGROUND, paddingX: 1 })
      expect(SUBAGENT_CARD_BACKGROUND).toBe('userMessageBackground')
      expect(card?.props).toMatchObject({ borderStyle: 'round', borderColor: SUBAGENT_CARD_BACKGROUND })
      expect(card?.props.borderDimColor).toBeUndefined()
      const dot = (await ui.findAll({ type: 'Text', text: '●' })).find((t: any) => t.props.color === SUBAGENT_STATE_COLOR.running)
      expect(dot).toBeDefined()
      // the name in the primary colour (bold), every metadata line muted: the dot is the only colour on the card
      const name = (await ui.findAll({ type: 'Text', text: 'Build a1' }))[0]
      expect(name?.props.bold).toBe(true)
      expect(!!name?.props.dimColor).toBe(false)
      expect(name?.props.color).toBeUndefined()
      for (const line of ['4m 12s', 'danxbot:worker-sonnet-high · claude-sonnet-5-5 · high', '12k tokens', '▸ Bash', 'In flight card']) {
        const t = (await ui.findAll({ type: 'Text', text: line })).at(-1)
        expect(t?.props.dimColor, line).toBe(true)
        expect(t?.props.color, line).toBeUndefined()
      }
      const shown = card!.text
      expect(shown).toContain('Build a1')
      expect(shown).toContain('danxbot:worker-sonnet-high · claude-sonnet-5-5 · high')
      // DX-4508: no session line
      expect(shown).not.toContain('session:')
      expect(shown).not.toContain(OWN_SESSION.title)
      // 4 minutes 12 seconds before the fake clock's start
      expect(shown).toContain('4m 12s')
      expect(shown).toContain('12k tokens · $0.42 · 7 tool calls')
      expect(shown).toContain('▸ Bash: Run the affected tests')
      expect(shown).toContain('In flight card')
      const link = (await linksOf(ui)).find(l => l.label === 'DX-9')
      expect(link?.href).toBe(`${DASHBOARD_URL}/plans/23/cards/DX-9`)
      expect(await text(ui)).toContain('1 running')
    })

    // The harness checks the tree, not the layout, so a narrow pane (40 columns) is guarded by what the tree asks of it: every long
    // line is cut at a cap and truncates at the card's edge, and the short facts (runtime, card ref) are never the ones that shrink.
    test('a narrow pane cuts the long lines, never the runtime or the card ref', async ($, on) => {
      const long = 'x'.repeat(200)
      const d = dashboard(on)
      d.world.subagents[OWN] = [
        endedSubagent('long', 'failed', 30_000, { description: long, current_activity: long, card: { id: 'DX-9', title: long, via: 'brief' } }),
      ]
      d.world.sessions = [{ session_id: OWN, title: long }]
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane(40) })
      const card = (await ui.find({ key: 'sa-agent-long' }))!
      const cut = (cap: number) => `${'x'.repeat(cap - 1)}…`
      expect(card.text).toContain(cut(SUBAGENT_LABEL_MAX))
      expect(card.text).toContain(`▸ ${cut(SUBAGENT_ACTIVITY_MAX)}`)
      expect(card.text).not.toContain('session:')
      const texts = await ui.findAll({ type: 'Text' })
      const long60 = texts.filter((t: any) => t.text.includes('xxxxxxxx'))
      expect(long60.length).toBeGreaterThanOrEqual(3)
      for (const t of long60) expect(t.props.wrap).toBe('truncate-end')
      const runtimeBox = (await ui.findAll({ type: 'Box' })).find((b: any) => b.text === 'failed 1m 30s')
      expect(runtimeBox?.props.flexShrink).toBe(0)
      const link = (await linksOf(ui)).find(l => l.label === 'DX-9')
      expect(link).toBeDefined()
    })
  })

  describe(`the Sub-agents section on ${surface}`, () => {
    test('a card outside the plan links its board page, and a sub-agent with no card says so', async ($, on) => {
      const d = dashboard(on)
      d.world.subagents[OWN] = [
        rawSubagent('far', { card: { id: 'DX-77', title: 'Another board', via: 'claim' } }),
        rawSubagent('none', { card: null }),
      ]
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      const link = (await linksOf(ui)).find(l => l.label === 'DX-77')
      expect(link?.href).toBe(`${DASHBOARD_URL}/board/DX-77`)
      expect((await ui.find({ key: 'sa-agent-none' }))?.text).toContain('no card')
    })

    // DX-4508: the title is the description, else the agent type, never the id (`agent-a7526d...`)
    test('a sub-agent with no description is titled by its agent type, and with neither by a plain word, never its id', async ($, on) => {
      const d = dashboard(on)
      d.world.subagents[OWN] = [
        rawSubagent('typed', { description: null, model: null, effort: null }),
        rawSubagent('bare', { description: null, agent_type: null, model: null, effort: null, current_activity: null, started_at: CLOCK_START - 10_000 }),
      ]
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect((await ui.findAll({ type: 'Text', text: 'danxbot:worker-sonnet-high' }))[0]?.props.bold).toBe(true)
      const typed = (await ui.find({ key: 'sa-agent-typed' }))!.text
      expect(typed).not.toContain('agent-typed')
      const bare = (await ui.find({ key: 'sa-agent-bare' }))!.text
      expect(bare).toContain(SUBAGENT_UNTITLED)
      expect(bare).not.toContain('agent-bare')
      expect(bare).not.toContain(' · claude')
      expect(bare).not.toContain('▸')
    })

    test('the section names the plan sessions it reads: live ones of the plan, newest activity first, one sub-agents read each', async ($, on) => {
      const d = dashboard(on)
      d.world.sessions = [OWN_SESSION, OTHER_SESSION]
      await startSession($, d, surface)
      const list = d.api.find(a => a.path === '/api/plan-sessions')
      expect(list?.query).toEqual({ plan_id: 23, live: true, limit: 20 })
      expect(subagentCalls(d).map(a => a.path).sort()).toEqual(['/api/plan-sessions', `/api/plan-sessions/${OTHER_SESSION.session_id}/subagents`, `/api/plan-sessions/${OWN}/subagents`].sort())
    })

    test('two sessions: the cards name no session, and order across them by start', async ($, on) => {
      const d = dashboard(on)
      d.world.sessions = [OWN_SESSION, OTHER_SESSION]
      d.world.subagents[OWN] = [rawSubagent('a1')]
      d.world.subagents[OTHER_SESSION.session_id] = [rawSubagent('b1', { session_id: OTHER_SESSION.session_id, started_at: CLOCK_START - 60_000 })]
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect((await ui.find({ key: 'sa-agent-a1' }))!.text).not.toContain(OWN_SESSION.title)
      expect((await ui.find({ key: 'sa-agent-b1' }))!.text).not.toContain(OTHER_SESSION.title)
      // oldest start first among running rows, whichever session they belong to
      expect(await cardKeys(ui)).toEqual(['sa-agent-a1', 'sa-agent-b1'])
    })

    test('order: running first (oldest start first), then ended ones newest finish first, dimmed with their end state in words', async ($, on) => {
      const d = dashboard(on)
      d.world.subagents[OWN] = [
        endedSubagent('e1', 'done', 60_000),
        rawSubagent('a2', { started_at: CLOCK_START - 100_000 }),
        endedSubagent('e2', 'failed', 30_000),
        rawSubagent('a1'),
      ]
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(await cardKeys(ui)).toEqual(['sa-agent-a1', 'sa-agent-a2', 'sa-agent-e2', 'sa-agent-e1'])
      const failed = (await ui.find({ key: 'sa-agent-e2' }))!
      expect(failed.text).toContain('failed 1m 30s')
      // an ended card is dimmed: its dot keeps its state's colour, dimmed, and so is its name
      expect(await sectionDots(ui)).toEqual([`${SUBAGENT_STATE_COLOR.running}:false`, `${SUBAGENT_STATE_COLOR.running}:false`, `${SUBAGENT_STATE_COLOR.failed}:true`, `${SUBAGENT_STATE_COLOR.done}:true`])
      expect((await ui.findAll({ type: 'Text', text: 'Build e2' }))[0]?.props.dimColor).toBe(true)
      const stateWords = await text(ui)
      expect(stateWords).toContain('2 running, 2 ended')
    })

    test('a stopped sub-agent has its own colour, and a running one is full colour', async ($, on) => {
      const d = dashboard(on)
      d.world.subagents[OWN] = [endedSubagent('s1', 'stopped', 10_000)]
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(await sectionDots(ui)).toEqual([`${SUBAGENT_STATE_COLOR.stopped}:true`])
      expect(new Set(Object.values(SUBAGENT_STATE_COLOR)).size).toBe(4)
    })

    test('a sub-agent that spawned others holds their cards inside its own', async ($, on) => {
      const d = dashboard(on)
      d.world.subagents[OWN] = [
        rawSubagent('p'),
        rawSubagent('c', { parent_id: 'agent-p', started_at: CLOCK_START - 60_000 }),
        rawSubagent('gc', { parent_id: 'agent-c', started_at: CLOCK_START - 30_000 }),
        rawSubagent('orphan', { parent_id: 'agent-gone', started_at: CLOCK_START - 10_000 }),
      ]
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      const parent = (await ui.find({ key: 'sa-agent-p' }))!
      expect(keysBelow(parent).filter((k: string) => k.startsWith('sa-'))).toEqual(['sa-agent-c', 'sa-agent-gc'])
      expect(await cardKeys(ui)).toEqual(['sa-agent-p', 'sa-agent-c', 'sa-agent-gc', 'sa-agent-orphan'])
    })

    test('nothing running: one short empty line, and no clock', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(await text(ui)).toContain('Sub-agents | 0 running')
      expect(await text(ui)).toContain('No sub-agents running.')
      expect(await cardKeys(ui)).toEqual([])
      await d.clock.advance(10_000)
      expect(d.stateWrites.filter(w => w.key === 'tick')).toHaveLength(0)
    })

    test('the runtime counts up on a local clock only: a second moves it, and the dashboard is not asked again', async ($, on) => {
      const d = dashboard(on)
      d.world.subagents[OWN] = [rawSubagent('a1')]
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      const calls = d.api.length
      expect((await ui.find({ key: 'sa-agent-a1' }))!.text).toContain('4m 12s')
      await d.clock.advance(5_000)
      expect((await ui.find({ key: 'sa-agent-a1' }))!.text).toContain('4m 17s')
      expect(d.api).toHaveLength(calls)
      expect(d.stateWrites.filter(w => w.key === 'tick').length).toBeGreaterThanOrEqual(5)
    })

    test('an ended sub-agent drops at its visibleUntil on the pane clock, with no read, and the clock stops with the last one', async ($, on) => {
      const d = dashboard(on)
      // it finished 9 min 50 s before the fake clock's start and stays listed 10 minutes after finishing: 10 s from now
      // (DX-4586: the pane clock ticks every second, so a nearer drop costs fewer ticks of real time under machine load)
      d.world.subagents[OWN] = [endedSubagent('gone', 'failed', 590_000)]
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(await cardKeys(ui)).toEqual(['sa-agent-gone'])
      await d.clock.advance(9_000)
      expect(await cardKeys(ui)).toEqual(['sa-agent-gone'])
      await d.clock.advance(2_000)
      expect(await cardKeys(ui)).toEqual([])
      expect(await text(ui)).toContain('No sub-agents running.')
      const ticks = d.stateWrites.filter(w => w.key === 'tick').length
      await d.clock.advance(10_000)
      expect(d.stateWrites.filter(w => w.key === 'tick')).toHaveLength(ticks)
    })

    test('a refresh brings a new sub-agent and an ended one disappears from the server: no extra loop, a reload reads it', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(await cardKeys(ui)).toEqual([])
      d.world.subagents[OWN] = [rawSubagent('a1')]
      const reads = () => d.api.filter(a => a.path === '/api/plan-sessions').length
      const before = reads()
      // no polling timer: the clock alone reads nothing
      await d.clock.advance(60_000)
      expect(reads()).toBe(before)
      await forceRefresh($, d)
      expect(reads()).toBe(before + 1)
      expect(await cardKeys(ui)).toEqual(['sa-agent-a1'])
    })

    test('a sub-agent starting or stopping reads at once (within the minimum gap, after it) and once more five seconds later, never in a loop', async ($, on) => {
      const d = dashboard(on)
      on('classic.SubagentStart', () => ({}) as any)
      on('classic.SubagentStop', () => ({}) as any)
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      const reads = () => d.api.filter(a => a.path === '/api/plan-sessions').length
      const start = reads()
      d.world.subagents[OWN] = [rawSubagent('a1')]
      // a burst of events: the load just made stands for the immediate ask (inside the minimum gap), one settle read is pending
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high' })
      await $.classic.SubagentStart({ agent_id: 'a2', agent_type: 'danxbot:worker-sonnet-high' })
      await $.classic.SubagentStop({ agent_id: 'a2', agent_type: 'danxbot:worker-sonnet-high', stop_hook_active: false, agent_transcript_path: '' })
      expect(reads()).toBe(start)
      expect(await cardKeys(ui)).toEqual([])
      await d.clock.advance(5_000)
      expect(reads()).toBe(start + 1)
      expect(await cardKeys(ui)).toEqual(['sa-agent-a1'])
      // nothing repeats on its own: no poll reads the plan, only events, turns and presses do
      await d.clock.advance(20_000)
      expect(reads()).toBe(start + 1)
    })

    test('a session connected to no plan schedules no settle read', async ($, on) => {
      const d = dashboard(on, { connected: false })
      on('classic.SubagentStart', () => ({}) as any)
      await startSession($, d, surface)
      const reads = () => d.api.length
      await d.clock.advance(11_000)
      const before = reads()
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high' })
      await d.clock.settle()
      const afterEvent = reads()
      await d.clock.advance(5_000)
      expect(reads()).toBe(afterEvent)
      expect(afterEvent).toBeGreaterThan(before)
    })

    test('a stop event outside the minimum gap reads at once as well', async ($, on) => {
      const d = dashboard(on)
      on('classic.SubagentStop', () => ({}) as any)
      await startSession($, d, surface)
      await d.clock.advance(11_000)
      const reads = () => d.api.filter(a => a.path === '/api/plan-sessions').length
      const before = reads()
      await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high', stop_hook_active: false, agent_transcript_path: '' })
      await d.clock.settle()
      expect(reads()).toBe(before + 1)
    })
  })

  describe(`a failed sub-agents read on ${surface}`, () => {
    test('the plan sessions list failing is one line, and the rest of the pane still shows', async ($, on) => {
      const d = dashboard(on, { sessionsFail: true })
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      const all = await text(ui)
      expect(all).toContain("Couldn't read the plan's sessions: the dashboard answered 500")
      expect(all).not.toContain('No sub-agents running.')
      expect(all).toContain('Connected: PLAN-23')
      expect(all).toContain('Needs You')
      expect(all).not.toContain('sessions boom')
    })

    test('one session failing names it and keeps the other session cards', async ($, on) => {
      const d = dashboard(on, { subagentsFail: OTHER_SESSION.session_id })
      d.world.sessions = [OWN_SESSION, OTHER_SESSION]
      d.world.subagents[OWN] = [rawSubagent('a1')]
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(await cardKeys(ui)).toEqual(['sa-agent-a1'])
      expect(await text(ui)).toContain(`Couldn't read the sub-agents of "${OTHER_SESSION.title}": the dashboard answered 500`)
    })

    for (const [name, options] of [
      ['no list of sessions', { sessionsShape: 'noList' }],
      ['a session with no title', { sessionsShape: 'noTitle' }],
      ['no list of sub-agents', { subagentsNoList: true }],
    ] as const) {
      test(`an answer the pane cannot read is named, never drawn as a guess: ${name}`, async ($, on) => {
        const d = dashboard(on, options)
        await startSession($, d, surface)
        const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
        const all = await text(ui)
        expect(all).toContain("Couldn't read")
        expect(all).not.toContain('No sub-agents running.')
        expect(await cardKeys(ui)).toEqual([])
      })
    }

    test('a row with a missing or wrong field is one line naming the row and the field', async ($, on) => {
      const d = dashboard(on)
      d.world.subagents[OWN] = [rawSubagent('a1'), rawSubagent('bad', { state: 'sleeping' })]
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(await text(ui)).toContain(`Couldn't read the sub-agents of "${OWN_SESSION.title}": agent-bad has no valid state`)
      // a session's list is read whole or not at all: no half list that would hide a sub-agent
      expect(await cardKeys(ui)).toEqual([])
    })

    test('a running row that carries a finish, or an ended one that carries none, is refused', async ($, on) => {
      const d = dashboard(on)
      d.world.subagents[OWN] = [rawSubagent('a', { finished_at: 5 }), rawSubagent('b', { state: 'done', finished_at: null, visible_until: null })]
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(await text(ui)).toContain('agent-a has no valid finished_at for its state')
    })

    test('a parent chain that loops is refused, naming the row', async ($, on) => {
      const d = dashboard(on)
      d.world.subagents[OWN] = [rawSubagent('x', { parent_id: 'agent-y' }), rawSubagent('y', { parent_id: 'agent-x' })]
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(await text(ui)).toMatch(/Couldn't draw the sub-agents: agent-[xy] is its own ancestor/)
      expect(await cardKeys(ui)).toEqual([])
    })

    test('as many live sessions as one load reads: the pane says there may be more', async ($, on) => {
      const d = dashboard(on)
      d.world.sessions = Array.from({ length: 20 }, (_, i) => ({ session_id: `s-${i}`, title: `Session ${i}` }))
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(await text(ui)).toContain('Showing the most recently active sessions only')
      // one fewer: no note
      d.world.sessions = d.world.sessions.slice(1)
      await forceRefresh($, d)
      expect(await text(ui)).not.toContain('Showing the most recently active sessions only')
    })

    // Production does not serve the sub-agents route until DX-4498 deploys: every session's read answers 404.
    test('a dashboard with no sub-agents route yet: one quiet line, no warning per session, the rest of the pane intact', async ($, on) => {
      const d = dashboard(on, { subagentsNotFound: true })
      d.world.sessions = [OWN_SESSION, OTHER_SESSION]
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      const all = await text(ui)
      expect(all).toContain(`Sub-agents | ${SUBAGENTS_UNAVAILABLE_LINE}`)
      expect(all).not.toContain("Couldn't read")
      expect(all).not.toContain('404')
      expect(all).not.toContain('0 running')
      expect(all).not.toContain('No sub-agents running.')
      expect((await ui.findAll({ type: 'Text' })).filter((t: any) => t.props.color === 'yellow' && t.text.includes('sub-agents'))).toEqual([])
      expect(all).toContain('Connected: PLAN-23')
      expect(await cardKeys(ui)).toEqual([])
      // no clock runs for a section that shows nothing
      await d.clock.advance(10_000)
      expect(d.stateWrites.filter(w => w.key === 'tick')).toHaveLength(0)
    })

    test('the route appearing (the dashboard deployed) replaces the line on the next refresh', async ($, on) => {
      const d = dashboard(on, { subagentsNotFound: true })
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(await text(ui)).toContain(SUBAGENTS_UNAVAILABLE_LINE)
      d.serveSubagents()
      d.world.subagents[OWN] = [rawSubagent('a1')]
      await forceRefresh($, d)
      expect(await text(ui)).not.toContain(SUBAGENTS_UNAVAILABLE_LINE)
      expect(await cardKeys(ui)).toEqual(['sa-agent-a1'])
    })

    test('a 404 for only one of two sessions is that session failing, named, not the missing route', async ($, on) => {
      const d = dashboard(on, { subagentsNotFound: OTHER_SESSION.session_id })
      d.world.sessions = [OWN_SESSION, OTHER_SESSION]
      d.world.subagents[OWN] = [rawSubagent('a1')]
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(await cardKeys(ui)).toEqual(['sa-agent-a1'])
      const all = await text(ui)
      expect(all).toContain(`Couldn't read the sub-agents of "${OTHER_SESSION.title}": the dashboard answered 404`)
      expect(all).not.toContain(SUBAGENTS_UNAVAILABLE_LINE)
    })

    test('a signed-out answer to the sub-agents read ends the load as signed out, never as a line', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out' })
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(await text(ui)).toContain('signed out')
      expect(await text(ui)).not.toContain('Sub-agents')
    })
  })
}
