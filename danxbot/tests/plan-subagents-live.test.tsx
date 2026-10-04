// DX-4508: the live sub-agent numbers. A host child (`node <installed danx-dashboard-mcp>/dist/index.js subagents-live <main
// transcript>`) streams this session's sub-agents while one runs; its lines are checked, merged and laid over the dashboard rows.
import { describe, expect, test } from 'claude-code/testing'

import type { LiveSnapshot, LiveSubagents, PlanView, SubagentRow } from '../types'
import { DASHBOARD_MCP_BIN_REL, EMPTY, NO_LIVE, SUBAGENT_ENDED_VISIBLE_MS, liveUnavailableLine } from '../hooks/plan/config'
import {
  NEW_READER,
  dashboardMcpBin,
  dashboardMcpRecord,
  exitReason,
  mergeSnapshots,
  parseLiveLine,
  pluginDataDir,
  pruneSnapshots,
  readPiece,
  readVersionRecord,
  splitLines,
  stateOfStatus,
  withLive,
} from '../hooks/plan/live'
import { CLOCK_START, OTHER_SESSION, OWN_SESSION, SURFACES, dashboard, rawSubagent, startSession } from './plan-kit'

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

describe('where the installed live reader is', () => {
  test("a marketplace install's data directory, by Claude Code's layout, with either separator", () => {
    expect(pluginDataDir('C:\\Users\\newms\\.claude\\plugins\\cache\\newms-plugins\\danxbot\\0.12.35')).toEqual({
      dir: 'C:\\Users\\newms\\.claude\\plugins\\data\\danxbot-newms-plugins',
    })
    expect(pluginDataDir('/home/me/.claude/plugins/cache/newms-plugins/danxbot/0.12.35/')).toEqual({ dir: '/home/me/.claude/plugins/data/danxbot-newms-plugins' })
  })

  test('a root of any other shape (a --plugin-dir load) is a named reason, never a guess', () => {
    const r = pluginDataDir('C:\\work\\claude-plugins\\danxbot')
    expect(r).toEqual({ reason: expect.stringContaining('not loaded from a marketplace install') })
    expect('reason' in pluginDataDir('/plugins/cache/x')).toBe(true)
  })

  test('the version record and the bin under that version', () => {
    expect(dashboardMcpRecord('D')).toBe('D/dashboard-mcp/current')
    expect(readVersionRecord('1.2.3\n')).toEqual({ version: '1.2.3' })
    for (const bad of ['', 'latest', '1.2', '1.2.3-beta']) expect('reason' in readVersionRecord(bad)).toBe(true)
    expect(dashboardMcpBin('D', '1.2.3')).toBe(`D/dashboard-mcp/1.2.3/${DASHBOARD_MCP_BIN_REL}`)
    // the one layout ensure-dashboard-mcp.sh installs: BIN_REL="node_modules/${PKG_NAME}/dist/index.js"
    expect(DASHBOARD_MCP_BIN_REL).toBe('node_modules/@thehammer/danx-dashboard-mcp/dist/index.js')
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
  test("this session's row takes the snapshot's numbers, activity and identity; the dashboard's state and times stand", () => {
    const { rows, errors } = withLive(viewOf([row('a1')]), liveOf([snapshot('a1')], { 'agent-a1': 'running' }))
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ label: 'Live a1', tokensTotal: 50_000, costUsd: 1.5, toolCalls: 30, activity: 'Edit: register.tsx', state: 'running', startedAt: CLOCK_START - 60_000 })
    // no card in the snapshot: the dashboard's stands
    expect(rows[0].card).toEqual({ id: 'DX-9', title: 'In flight card' })
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
const liveWrites = (d: any) => d.stateWrites.filter((w: any) => w.key === 'live').map((w: any) => w.value)

for (const surface of SURFACES) {
  describe(`the live reader's life on ${surface}`, () => {
    test('no running sub-agent: the engine is asked, no child starts and nothing is said', async ($, on) => {
      const d = dashboard(on)
      on('classic.SubagentStart', () => ({}) as any)
      await startSession($, d, surface)
      const asked = d.agentLists.count
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high', transcript_path: MAIN_TRANSCRIPT })
      expect(d.agentLists.count).toBeGreaterThan(asked)
      expect(d.spawns).toEqual([])
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(await text(ui)).not.toContain('Live numbers unavailable')
    })

    test('a session on no plan never asks', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agents = [running('a1')]
      on('classic.SubagentStart', () => ({}) as any)
      await startSession($, d, surface)
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high', transcript_path: MAIN_TRANSCRIPT })
      expect(d.agentLists.count).toBe(0)
      expect(d.spawns).toEqual([])
    })

    test('a running sub-agent but no transcript path reported: one muted line says so, the dashboard numbers stand', async ($, on) => {
      const d = dashboard(on)
      d.world.subagents[OWN] = [rawSubagent('a1')]
      d.world.agents = [running('a1')]
      on('classic.SubagentStart', () => ({}) as any)
      await startSession($, d, surface)
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high' })
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      const line = (await ui.findAll({ type: 'Text', text: liveUnavailableLine('the session has not reported its transcript path yet') }))[0]
      expect(line?.props.dimColor).toBe(true)
      expect(d.spawns).toEqual([])
      expect((await ui.find({ key: 'sa-agent-a1' }))!.text).toContain('12k tokens · $0.42 · 7 tool calls')
    })

    // `claude plugin test` loads the plugin from its source folder, which is not a marketplace install: the reason is named, and
    // the failure stands (no retry on a refresh) until the next sub-agent starts.
    test('a plugin not loaded from a marketplace install: the line names it, a refresh does not retry, the next start does', async ($, on) => {
      const d = dashboard(on)
      d.world.subagents[OWN] = [rawSubagent('a1')]
      d.world.agents = [running('a1')]
      on('classic.SubagentStart', () => ({}) as any)
      await startSession($, d, surface)
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high', transcript_path: MAIN_TRANSCRIPT })
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(await text(ui)).toContain('Live numbers unavailable: the plugin is not loaded from a marketplace install')
      expect(d.spawns).toEqual([])
      const tries = () => liveWrites(d).filter((v: any) => !v.failed).length
      const before = tries()
      // the 60 s refresh re-checks, but a standing failure is not tried again
      await d.clock.advance(60_000)
      expect(tries()).toBe(before)
      expect(await text(ui)).toContain('Live numbers unavailable')
      // the next start clears it and tries once more (and fails the same way here)
      await $.classic.SubagentStart({ agent_id: 'a2', agent_type: 'danxbot:worker-sonnet-high', transcript_path: MAIN_TRANSCRIPT })
      expect(tries()).toBeGreaterThan(before)
      expect(liveWrites(d).at(-1)).toMatchObject({ failed: true, warning: expect.stringContaining('not loaded from a marketplace install') })
    })

    test('once no sub-agent runs, the failure line goes: there is nothing live to show', async ($, on) => {
      const d = dashboard(on)
      d.world.subagents[OWN] = [rawSubagent('a1')]
      d.world.agents = [running('a1')]
      on('classic.SubagentStart', () => ({}) as any)
      on('classic.SubagentStop', () => ({}) as any)
      await startSession($, d, surface)
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high', transcript_path: MAIN_TRANSCRIPT })
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...pane() })
      expect(await text(ui)).toContain('Live numbers unavailable')
      d.world.agents = [{ ...running('a1'), status: 'completed' }]
      await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high', stop_hook_active: false, agent_transcript_path: '' })
      expect(await text(ui)).not.toContain('Live numbers unavailable')
      expect(d.spawns).toEqual([])
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
