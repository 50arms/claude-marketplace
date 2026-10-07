// DX-4508: the live sub-agent numbers. A host child (`node <installed danx-dashboard-mcp>/dist/index.js subagents-live <main
// transcript>`) streams this session's sub-agents while one runs; its lines are checked, merged and laid over the dashboard rows.
import { describe, expect, test } from 'claude-code/testing'

import type { LiveSnapshot, LiveSubagents, PlanView, SubagentRow } from '../types'
import { EMPTY, NO_LIVE, SUBAGENT_ENDED_VISIBLE_MS, liveUnavailableLine } from '../hooks/plan/config'
import { NEW_READER, exitReason, liveReaderArgv, mergeSnapshots, parseLiveLine, pruneSnapshots, readPiece, splitLines, stateOfStatus, withLive } from '../hooks/plan/live'
import { CLOCK_START, OTHER_SESSION, OWN_SESSION, READER_PIECE_MS, SURFACES, dashboard, rawSubagent, startSession } from './plan-kit'

const OWN = OWN_SESSION.session_id
const MAIN_TRANSCRIPT = 'C:\\Users\\me\\.claude\\projects\\p\\sess-own.jsonl'

const snapshot = (id: string, over: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
  id: `agent-${id}`,
  parentId: null,
  description: `Live ${id}`,
  agentType: 'danxbot:worker-sonnet-high',
  model: 'claude-sonnet-5-5',
  effort: 'high',
  startedAt: CLOCK_START - 60_000,
  lastActivityAt: CLOCK_START - 1_000,
  finishedAt: null,
  endStatus: null,
  tokensTotal: 50_000,
  costUsd: 1.5,
  toolCallCount: 30,
  currentActivity: 'Edit: register.tsx',
  cardId: null,
  ...over,
})

const row = (id: string, over: Partial<SubagentRow> = {}): SubagentRow => ({
  id: `agent-${id}`,
  sessionId: OWN,
  parentId: null,
  label: `Dashboard ${id}`,
  agentType: 'danxbot:worker-sonnet-high',
  model: 'claude-sonnet-5-5',
  effort: 'high',
  state: 'running',
  startedAt: CLOCK_START - 60_000,
  finishedAt: null,
  visibleUntil: null,
  tokensTotal: 100,
  costUsd: 0.01,
  toolCalls: 1,
  activity: 'Read: old',
  card: { id: 'DX-9', title: 'In flight card' },
  ...over,
})

const viewOf = (rows: SubagentRow[], over: Partial<PlanView> = {}): PlanView => ({ ...EMPTY, subagents: { ...EMPTY.subagents, rows }, ...over })
const liveOf = (snapshots: LiveSnapshot[], statuses: Record<string, string> = {}, over: Partial<LiveSubagents> = {}): LiveSubagents => ({
  ...NO_LIVE,
  sessionId: OWN,
  snapshots: Object.fromEntries(snapshots.map(s => [s.id, s])),
  statuses,
  ...over,
})

// DX-4508: the module starts the plugin's own reader script (scripts/subagents-live.mjs, tested by subagents-live.test.mjs), which
// finds the installed danx-dashboard-mcp from its own location and runs its `subagents-live`: the module reads no file of its own.
describe('how the live reader is started', () => {
  test("node, the plugin's reader script under its root, the main transcript", () => {
    expect(liveReaderArgv('/plugins/danxbot', MAIN_TRANSCRIPT)).toEqual(['node', '/plugins/danxbot/scripts/subagents-live.mjs', MAIN_TRANSCRIPT])
  })
})

describe("reading the live reader's output", () => {
  test('a piece is not a line: the tail waits for the next piece, CRLF and blank lines are dropped', () => {
    expect(splitLines('', '{"a":1}\n{"b"')).toEqual({ lines: ['{"a":1}'], rest: '{"b"' })
    expect(splitLines('{"b"', ':2}\r\n\n')).toEqual({ lines: ['{"b":2}'], rest: '' })
  })

  test('a line is its snapshots, every field checked', () => {
    const s = snapshot('a1', { cardId: 'DX-9' })
    expect(parseLiveLine(JSON.stringify({ subagents: [s] }))).toEqual([s])
    expect(parseLiveLine('{"subagents":[]}')).toEqual([])
  })

  for (const [name, line, reason] of [
    ['not JSON', 'oops', 'not JSON'],
    ['no list', '{"agents":[]}', 'no list of sub-agents'],
    ['an id that is not an agent id', JSON.stringify({ subagents: [snapshot('a', { id: 'a1' })] }), 'no agent- id'],
    ['a negative token count', JSON.stringify({ subagents: [snapshot('a', { tokensTotal: -1 })] }), 'agent-a has no valid tokensTotal'],
    ['a cost that is a string', JSON.stringify({ subagents: [{ ...snapshot('a'), costUsd: '1' }] }), 'agent-a has no valid tokensTotal, costUsd'],
    ['a finish with no end status', JSON.stringify({ subagents: [snapshot('a', { finishedAt: 5 })] }), 'finishedAt for its endStatus'],
    ['an unknown end status', JSON.stringify({ subagents: [{ ...snapshot('a', { finishedAt: 5 }), endStatus: 'gone' }] }), 'endStatus'],
    ['its own parent', JSON.stringify({ subagents: [snapshot('a', { parentId: 'agent-a' })] }), 'parentId'],
  ] as const) {
    test(`a line the pane cannot read is the reason, never a guessed value: ${name}`, () => {
      const r = parseLiveLine(line)
      expect(typeof r).toBe('string')
      expect(r).toContain(reason)
    })
  }

  test('a piece reads its whole lines in order; stderr is kept for the exit reason, never read as data', () => {
    const one = JSON.stringify({ subagents: [snapshot('a1')] })
    const two = JSON.stringify({ subagents: [snapshot('a2')] })
    let step = readPiece(NEW_READER, { stream: 'stdout', text: one.slice(0, 10) }, 100)
    expect(step.lines).toEqual([])
    step = readPiece(step.reader, { stream: 'stdout', text: `${one.slice(10)}\n${two}\n` }, 100)
    expect(step.lines.map(l => l.map(s => s.id))).toEqual([['agent-a1'], ['agent-a2']])
    expect(step.failure).toBeNull()
    step = readPiece(step.reader, { stream: 'stderr', text: 'transcript gone' }, 100)
    expect(step.lines).toEqual([])
    expect(exitReason({ code: 1, signal: null }, step.reader.stderr)).toBe('the live reader exited with exit code 1: transcript gone')
    expect(exitReason({ code: null, signal: 'SIGTERM' }, '')).toBe('the live reader exited on signal SIGTERM')
  })

  test('a bad line ends the reading after the good lines before it', () => {
    const good = JSON.stringify({ subagents: [snapshot('a1')] })
    const step = readPiece(NEW_READER, { stream: 'stdout', text: `${good}\nnope\n` }, 100)
    expect(step.lines).toHaveLength(1)
    expect(step.failure).toContain('the live reader printed a line that is not JSON')
  })

  test('the first line replaces what an earlier child said; later lines merge by id', () => {
    const old = { 'agent-x': snapshot('x') }
    expect(Object.keys(mergeSnapshots(old, [snapshot('a1')], true))).toEqual(['agent-a1'])
    expect(Object.keys(mergeSnapshots(old, [snapshot('a1')], false)).sort()).toEqual(['agent-a1', 'agent-x'])
  })

  test("an ended snapshot is dropped once past the server's window", () => {
    const ended = snapshot('e', { finishedAt: 1_000, endStatus: 'completed' })
    expect(Object.keys(pruneSnapshots({ 'agent-e': ended }, 1_000 + SUBAGENT_ENDED_VISIBLE_MS - 1))).toEqual(['agent-e'])
    expect(Object.keys(pruneSnapshots({ 'agent-e': ended }, 1_000 + SUBAGENT_ENDED_VISIBLE_MS))).toEqual([])
  })

  test("the engine's statuses as the pane's states; any other is unknown", () => {
    expect(['running', 'completed', 'failed', 'killed', 'pending'].map(stateOfStatus)).toEqual(['running', 'done', 'failed', 'stopped', null])
  })
})

describe('the live numbers over the dashboard rows', () => {
  test("this session's row takes the snapshot's numbers, activity and identity; the dashboard's times stand", () => {
    const { rows, errors } = withLive(viewOf([row('a1')]), liveOf([snapshot('a1')], { 'agent-a1': 'running' }))
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ label: 'Live a1', tokensTotal: 50_000, costUsd: 1.5, toolCalls: 30, activity: 'Edit: register.tsx', state: 'running', startedAt: CLOCK_START - 60_000 })
    // no card in the snapshot: the dashboard's stands
    expect(rows[0].card).toEqual({ id: 'DX-9', title: 'In flight card' })
  })

  // DX-4508: a sub-agent whose end never reached the dashboard (no task notification) reads `running` there for good; the engine's
  // own list is the truth for this session's sub-agents, as it is for a row only the live child reported.
  test("this session's row takes the engine's state: an end the dashboard missed shows, timed by the transcript", () => {
    const stuck = row('s1', { startedAt: 1_000 })
    const live = liveOf([snapshot('s1', { lastActivityAt: 9_000 })], { 'agent-s1': 'completed' })
    expect(withLive(viewOf([stuck]), live).rows[0]).toMatchObject({ state: 'done', finishedAt: 9_000, visibleUntil: 9_000 + SUBAGENT_ENDED_VISIBLE_MS })
    // an end the dashboard already has keeps its own finish
    const ended = row('e1', { state: 'done', finishedAt: 4_000, visibleUntil: 4_000 + SUBAGENT_ENDED_VISIBLE_MS })
    expect(withLive(viewOf([ended]), liveOf([snapshot('e1')], { 'agent-e1': 'killed' })).rows[0]).toMatchObject({ state: 'stopped', finishedAt: 4_000 })
    // running again by the engine (a resumed sub-agent): running, no finish
    expect(withLive(viewOf([ended]), liveOf([snapshot('e1')], { 'agent-e1': 'running' })).rows[0]).toMatchObject({ state: 'running', finishedAt: null, visibleUntil: null })
  })

  test("with no engine status the pane knows, or no snapshot to time an end by, the dashboard's state stands", () => {
    const stuck = row('s1')
    expect(withLive(viewOf([stuck]), liveOf([snapshot('s1')], {})).rows[0].state).toBe('running')
    expect(withLive(viewOf([stuck]), liveOf([snapshot('s1')], { 'agent-s1': 'pending' })).rows[0].state).toBe('running')
    expect(withLive(viewOf([stuck]), liveOf([], { 'agent-s1': 'completed' })).rows[0]).toEqual(stuck)
  })

  test('rows of other sessions keep the dashboard values', () => {
    const other = row('b1', { sessionId: OTHER_SESSION.session_id })
    const { rows } = withLive(viewOf([other]), liveOf([snapshot('b1')], { 'agent-b1': 'running' }))
    expect(rows).toEqual([other])
  })

  test('before any child ran, nothing is laid over', () => {
    const v = viewOf([row('a1')])
    expect(withLive(v, NO_LIVE).rows).toEqual(v.subagents.rows)
  })

  test("a snapshot with no dashboard row yet is a row of its own, its state the engine's", () => {
    const { rows, errors } = withLive(viewOf([]), liveOf([snapshot('n1', { parentId: 'agent-p' })], { 'agent-n1': 'running' }))
    expect(errors).toEqual([])
    expect(rows).toEqual([
      expect.objectContaining({ id: 'agent-n1', sessionId: OWN, parentId: 'agent-p', state: 'running', startedAt: CLOCK_START - 60_000, finishedAt: null, visibleUntil: null, tokensTotal: 50_000 }),
    ])
  })

  test("an ended one stays until the server's window after its finish, or after its last activity when the finish has not come yet", () => {
    const done = snapshot('d', { finishedAt: 5_000, endStatus: 'completed' })
    expect(withLive(viewOf([]), liveOf([done], { 'agent-d': 'completed' })).rows[0]).toMatchObject({ state: 'done', finishedAt: 5_000, visibleUntil: 5_000 + SUBAGENT_ENDED_VISIBLE_MS })
    const killed = snapshot('k', { lastActivityAt: 7_000 })
    expect(withLive(viewOf([]), liveOf([killed], { 'agent-k': 'killed' })).rows[0]).toMatchObject({ state: 'stopped', finishedAt: 7_000, visibleUntil: 7_000 + SUBAGENT_ENDED_VISIBLE_MS })
  })

  test('a snapshot the engine does not list, or lists with a status the pane does not know, is an error, never a guessed state', () => {
    const { rows, errors } = withLive(viewOf([]), liveOf([snapshot('x'), snapshot('y')], { 'agent-y': 'pending' }))
    expect(rows).toEqual([])
    expect(errors).toEqual(["agent-x is not one of this session's sub-agents as the engine lists them", 'agent-y has an engine status the pane does not know (pending)'])
  })

  test("the card the snapshot names: titled by the row's own card, else any card the pane loaded, else the id alone", () => {
    const v = viewOf([row('a1'), row('a2', { card: { id: 'DX-2', title: 'Second' } })], { inProgress: [{ id: 'DX-5', title: 'Loaded five', agent: null, updatedAt: '' }] })
    const live = liveOf([snapshot('a1', { cardId: 'DX-9' }), snapshot('a2', { cardId: 'DX-5' }), snapshot('n', { cardId: 'DX-77' })], { 'agent-n': 'running' })
    const byId = Object.fromEntries(withLive(v, live).rows.map(r => [r.id, r.card]))
    expect(byId['agent-a1']).toEqual({ id: 'DX-9', title: 'In flight card' })
    expect(byId['agent-a2']).toEqual({ id: 'DX-5', title: 'Loaded five' })
    expect(byId['agent-n']).toEqual({ id: 'DX-77', title: null })
  })

  test('parents that loop through live rows are refused; the dashboard rows stand', () => {
    const v = viewOf([row('a1')])
    const live = liveOf([snapshot('x', { parentId: 'agent-y' }), snapshot('y', { parentId: 'agent-x' })], { 'agent-x': 'running', 'agent-y': 'running' })
    const { rows, errors } = withLive(v, live)
    expect(rows).toEqual(v.subagents.rows)
    expect(errors[0]).toMatch(/agent-[xy] is its own ancestor/)
  })
})

const pane = () => ({ component: 'Pane', requestId: 'danx-plan', props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' } }) as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const running = (id: string) => ({ id, type: 'danxbot:worker-sonnet-high', description: `Build ${id}`, status: 'running' })
const subagentReads = (d: any) => d.api.filter((a: any) => a.path.startsWith('/api/plan-sessions')).length
const line = (snapshots: LiveSnapshot[]) => ({ stream: 'stdout' as const, text: `${JSON.stringify({ subagents: snapshots })}\n` })

for (const surface of SURFACES) {
  describe(`the live reader's life on ${surface}`, () => {
    test('no running sub-agent: the engine is asked, no child starts and nothing is said', async ($, on) => {
      const d = dashboard(on)
      on('classic.SubagentStart', () => ({}) as any)
      await startSession($, d, surface)
      const asked = d.agentLists.count
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high', transcript_path: MAIN_TRANSCRIPT })
      await d.clock.settle()
      expect(d.agentLists.count).toBeGreaterThan(asked)
      expect(d.readers).toEqual([])
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(await text(ui)).not.toContain('Live numbers unavailable')
    })

    test('a session on no plan never asks', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agents = [running('a1')]
      on('classic.SubagentStart', () => ({}) as any)
      await startSession($, d, surface)
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high', transcript_path: MAIN_TRANSCRIPT })
      await d.clock.settle()
      expect(d.agentLists.count).toBe(0)
      expect(d.readers).toEqual([])
    })

    test('a running sub-agent but no transcript path reported: one muted line says so, the dashboard numbers stand', async ($, on) => {
      const d = dashboard(on)
      d.world.subagents[OWN] = [rawSubagent('a1')]
      d.world.agents = [running('a1')]
      on('classic.SubagentStart', () => ({}) as any)
      await startSession($, d, surface)
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high' })
      await d.clock.settle()
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      const line = (await ui.findAll({ type: 'Text', text: liveUnavailableLine('the session has not reported its transcript path yet') }))[0]
      expect(line?.props.dimColor).toBe(true)
      expect(d.readers).toEqual([])
      expect((await ui.find({ key: 'sa-agent-a1' }))!.text).toContain('12k tokens · $0.42 · 7 tool calls')
    })

    test('once no sub-agent runs, the failure line goes: there is nothing live to show', async ($, on) => {
      const d = dashboard(on)
      d.world.subagents[OWN] = [rawSubagent('a1')]
      d.world.agents = [running('a1')]
      on('classic.SubagentStart', () => ({}) as any)
      on('classic.SubagentStop', () => ({}) as any)
      await startSession($, d, surface)
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high', transcript_path: MAIN_TRANSCRIPT })
      await d.clock.settle()
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(d.readers).toHaveLength(1)
      d.readers[0].end = { code: 1, signal: null }
      await d.clock.advance(READER_PIECE_MS)
      expect(await text(ui)).toContain('Live numbers unavailable: the live reader exited with exit code 1')
      d.world.agents = [{ ...running('a1'), status: 'completed' }]
      await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high', stop_hook_active: false, agent_transcript_path: '' })
      await d.clock.settle()
      expect(await text(ui)).not.toContain('Live numbers unavailable')
      // the one start is not retried
      expect(d.readers).toHaveLength(1)
    })

    // DX-4508: the reader's whole life, driven through a stand-in child: started only while a sub-agent runs, one at a time, its lines
    // laid over this session's row with no dashboard read, stopped once none runs.
    test("a running sub-agent starts one reader; its lines redraw this session's card with no dashboard read; it stops with the last one", async ($, on) => {
      const d = dashboard(on)
      d.world.subagents[OWN] = [rawSubagent('a1')]
      d.world.agents = [running('a1')]
      const children = d.readers
      on('classic.SubagentStart', () => ({}) as any)
      on('classic.SubagentStop', () => ({}) as any)
      await startSession($, d, surface)
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high', transcript_path: MAIN_TRANSCRIPT })
      await d.clock.settle()
      expect(children).toHaveLength(1)
      const [node, script, path] = children[0].argv
      expect([node, path]).toEqual(['node', MAIN_TRANSCRIPT])
      expect(script.replace(/\\/g, '/')).toMatch(/\/scripts\/subagents-live\.mjs$/)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect((await ui.find({ key: 'sa-agent-a1' }))!.text).toContain('12k tokens · $0.42 · 7 tool calls')

      const reads = subagentReads(d)
      children[0].pieces.push(line([snapshot('a1', { tokensTotal: 2_500_000, costUsd: 3.25, toolCallCount: 41, currentActivity: 'Edit: live.ts' })]))
      await d.clock.advance(READER_PIECE_MS)
      const shown = (await ui.find({ key: 'sa-agent-a1' }))!.text
      expect(shown).toContain('2.5M tokens · $3.25 · 41 tool calls')
      expect(shown).toContain('▸ Edit: live.ts')
      expect(subagentReads(d)).toBe(reads)

      // a second sub-agent while the reader runs: still one reader
      d.world.agents = [running('a1'), running('a2')]
      await $.classic.SubagentStart({ agent_id: 'a2', agent_type: 'danxbot:worker-sonnet-high', transcript_path: MAIN_TRANSCRIPT })
      await d.clock.settle()
      expect(children).toHaveLength(1)

      // one ends, one still runs: the reader runs on
      d.world.agents = [{ ...running('a1'), status: 'completed' }, running('a2')]
      await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high', stop_hook_active: false, agent_transcript_path: '' })
      await d.clock.settle()
      await d.clock.advance(READER_PIECE_MS)
      expect(children[0].stopped).toBe(false)

      // the last one ends: the reader is stopped, and nothing is said about it
      d.world.agents = [{ ...running('a1'), status: 'completed' }, { ...running('a2'), status: 'completed' }]
      await $.classic.SubagentStop({ agent_id: 'a2', agent_type: 'danxbot:worker-sonnet-high', stop_hook_active: false, agent_transcript_path: '' })
      await d.clock.settle()
      await d.clock.advance(READER_PIECE_MS)
      expect(children[0].stopped).toBe(true)
      expect(children).toHaveLength(1)
      expect(await text(ui)).not.toContain('Live numbers unavailable')
    })

    test('a reader that exits on its own: one line names why with what it said, and only the next start tries again', async ($, on) => {
      const d = dashboard(on)
      d.world.subagents[OWN] = [rawSubagent('a1')]
      d.world.agents = [running('a1')]
      const children = d.readers
      on('classic.SubagentStart', () => ({}) as any)
      await startSession($, d, surface)
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high', transcript_path: MAIN_TRANSCRIPT })
      await d.clock.settle()
      children[0].pieces.push({ stream: 'stderr', text: 'no recorded dashboard MCP version' })
      children[0].end = { code: 1, signal: null }
      await d.clock.advance(READER_PIECE_MS)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      const said = liveUnavailableLine('the live reader exited with exit code 1: no recorded dashboard MCP version')
      expect((await ui.findAll({ type: 'Text', text: said }))[0]?.props.dimColor).toBe(true)
      // the dashboard's numbers stand
      expect((await ui.find({ key: 'sa-agent-a1' }))!.text).toContain('12k tokens · $0.42 · 7 tool calls')
      await d.clock.advance(60_000)
      expect(children).toHaveLength(1)
      await $.classic.SubagentStart({ agent_id: 'a2', agent_type: 'danxbot:worker-sonnet-high', transcript_path: MAIN_TRANSCRIPT })
      await d.clock.settle()
      expect(children).toHaveLength(2)
    })

    test('a line the pane cannot read stops the reader and says why', async ($, on) => {
      const d = dashboard(on)
      d.world.subagents[OWN] = [rawSubagent('a1')]
      d.world.agents = [running('a1')]
      const children = d.readers
      on('classic.SubagentStart', () => ({}) as any)
      await startSession($, d, surface)
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high', transcript_path: MAIN_TRANSCRIPT })
      await d.clock.settle()
      children[0].pieces.push({ stream: 'stdout', text: 'nope\n' })
      await d.clock.advance(READER_PIECE_MS)
      await d.clock.advance(READER_PIECE_MS)
      expect(children[0].stopped).toBe(true)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(await text(ui)).toContain('Live numbers unavailable: the live reader printed a line that is not JSON')
    })

    test('the latest transcript path the classic events carry is kept', async ($, on) => {
      const d = dashboard(on)
      on('classic.UserPromptSubmit', () => ({}) as any)
      await startSession($, d, surface)
      await $.classic.UserPromptSubmit({ prompt: 'hi', transcript_path: MAIN_TRANSCRIPT } as any)
      expect(d.stateWrites.filter((w: any) => w.key === 'transcript').map((w: any) => w.value)).toEqual([MAIN_TRANSCRIPT])
    })
  })
}
