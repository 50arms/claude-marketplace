import type { LiveSnapshot, LiveSubagents, PlanView, SubagentRow, SubagentState } from '../../types'
import { LIVE_READER_SCRIPT, SUBAGENT_ENDED_VISIBLE_MS } from './config'
import { parentLoop } from './subagents'

// DX-4508: the live sub-agent numbers. Pure (no `$`): register.tsx starts the host child (`liveReaderArgv`), feeds its stdout through
// these functions and keeps the result in the `live` atom; the pane draws the dashboard rows with it laid over them.

// The host child: node running the plugin's reader script (it finds the installed danx-dashboard-mcp itself) on the main transcript.
export function liveReaderArgv(root: string, transcript: string): string[] {
  return ['node', `${root}/${LIVE_READER_SCRIPT}`, transcript]
}

// A child's stdout arrives in pieces that end wherever its writes did: `lines` are the whole lines so far, `rest` the
// unfinished tail the next piece continues.
export function splitLines(rest: string, piece: string): { lines: string[]; rest: string } {
  const all = (rest + piece).split('\n')
  return { lines: all.slice(0, -1).map(l => l.replace(/\r$/, '')).filter(l => l !== ''), rest: all[all.length - 1] }
}

const END_STATUSES = ['completed', 'failed', 'stopped'] as const
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === 'string'
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const isCount = isTime

// One stdout line, `{"subagents":[Snapshot, ...]}`, as its snapshots, or the one reason it cannot be read. Every field is
// checked: a snapshot the pane cannot draw truthfully is an error, never a guessed value.
export function parseLiveLine(line: string): LiveSnapshot[] | string {
  let body: any
  try {
    body = JSON.parse(line)
  } catch {
    return `a line that is not JSON (${JSON.stringify(line.slice(0, 60))})`
  }
  if (body === null || typeof body !== 'object' || !Array.isArray(body.subagents)) return 'a line with no list of sub-agents'
  const out: LiveSnapshot[] = []
  for (const s of body.subagents) {
    const bad = snapshotProblem(s)
    if (bad !== null) return bad
    out.push({
      id: s.id,
      parentId: s.parentId,
      description: s.description,
      agentType: s.agentType,
      model: s.model,
      effort: s.effort,
      startedAt: s.startedAt,
      lastActivityAt: s.lastActivityAt,
      finishedAt: s.finishedAt,
      endStatus: s.endStatus,
      tokensTotal: s.tokensTotal,
      costUsd: s.costUsd,
      toolCallCount: s.toolCallCount,
      currentActivity: s.currentActivity,
      cardId: s.cardId,
    })
  }
  return out
}

function snapshotProblem(s: any): string | null {
  if (s === null || typeof s !== 'object') return 'a sub-agent that is not an object'
  if (typeof s.id !== 'string' || !s.id.startsWith('agent-')) return 'a sub-agent with no agent- id'
  const at = (what: string) => `${s.id} has no valid ${what}`
  if (!isNullableString(s.parentId) || s.parentId === s.id) return at('parentId')
  if (!isNullableString(s.description) || !isNullableString(s.agentType) || !isNullableString(s.model) || !isNullableString(s.effort)) {
    return at('description, agentType, model and effort')
  }
  if (!isTime(s.startedAt) || !isTime(s.lastActivityAt)) return at('startedAt and lastActivityAt')
  if (s.finishedAt !== null && !isTime(s.finishedAt)) return at('finishedAt')
  if (s.endStatus !== null && !END_STATUSES.includes(s.endStatus)) return at('endStatus')
  if ((s.finishedAt === null) !== (s.endStatus === null)) return at('finishedAt for its endStatus')
  if (!isCount(s.tokensTotal) || !isCount(s.costUsd) || !isCount(s.toolCallCount)) return at('tokensTotal, costUsd and toolCallCount')
  if (!isNullableString(s.currentActivity) || !isNullableString(s.cardId)) return at('currentActivity and cardId')
  return null
}

// One reading of the child's output: the unfinished stdout line, and the tail of its stderr (the reason a failing child gives).
export type LiveReader = { rest: string; stderr: string }
export const NEW_READER: LiveReader = { rest: '', stderr: '' }

// One piece of the child's output: the snapshot lines it completed, in order, or the reason the reading ends (a line that
// cannot be read). Stderr is kept for the exit reason, never read as data.
export function readPiece(
  reader: LiveReader,
  chunk: { stream: 'stdout' | 'stderr'; text: string },
  stderrMax: number,
): { reader: LiveReader; lines: LiveSnapshot[][]; failure: string | null } {
  if (chunk.stream === 'stderr') return { reader: { ...reader, stderr: (reader.stderr + chunk.text).slice(-stderrMax) }, lines: [], failure: null }
  const split = splitLines(reader.rest, chunk.text)
  const lines: LiveSnapshot[][] = []
  for (const line of split.lines) {
    const parsed = parseLiveLine(line)
    if (typeof parsed === 'string') return { reader: { ...reader, rest: split.rest }, lines, failure: `the live reader printed ${parsed}` }
    lines.push(parsed)
  }
  return { reader: { ...reader, rest: split.rest }, lines, failure: null }
}

// The child ended on its own, which it does only when it fails: how, with what it said on stderr.
export function exitReason(result: { code: number | null; signal: string | null } | undefined, stderr: string): string {
  const how = result === undefined ? 'with no exit status' : result.code !== null ? `with exit code ${result.code}` : `on signal ${result.signal}`
  const said = stderr.trim()
  return `the live reader exited ${how}${said !== '' ? `: ${said}` : ''}`
}

// The child's first line carries every sub-agent of the session, each later one only those that changed.
export function mergeSnapshots(current: Record<string, LiveSnapshot>, line: LiveSnapshot[], isFirst: boolean): Record<string, LiveSnapshot> {
  const next = isFirst ? {} : { ...current }
  for (const s of line) next[s.id] = s
  return next
}

// `$.agent.list()`'s status of a sub-agent as the pane's state, or null for a status the pane does not know (an error line).
export function stateOfStatus(status: string): SubagentState | null {
  if (status === 'running') return 'running'
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'killed') return 'stopped'
  return null
}

// A sub-agent's state, finish and drop time by the engine's `state`: an end the snapshot has not timed yet is its last activity
// (the engine can report the end before the child's line with the finish arrives), and an end already known keeps its time.
function engineTimes(state: SubagentState, s: LiveSnapshot, knownFinish: number | null): Pick<SubagentRow, 'state' | 'finishedAt' | 'visibleUntil'> {
  const finishedAt = state === 'running' ? null : (knownFinish ?? s.finishedAt ?? s.lastActivityAt)
  return { state, finishedAt, visibleUntil: finishedAt === null ? null : finishedAt + SUBAGENT_ENDED_VISIBLE_MS }
}

// The pane's sub-agent rows with this session's live numbers over them. A dashboard row of the session the child reads
// (`live.sessionId`) takes the snapshot's identity, numbers, activity and card, and the engine's state (`live.statuses`, the
// engine's own list): an end that never reached the dashboard (no task notification) would otherwise read `running` there for
// good. A snapshot the dashboard has no row for yet is a row of its own, its state the engine's. Rows of other sessions are the
// dashboard's. `errors` names the snapshots that could not become a row.
export function withLive(v: PlanView, live: LiveSubagents): { rows: SubagentRow[]; errors: string[] } {
  const rows = v.subagents.rows
  if (live.sessionId === null) return { rows, errors: [] }
  const titles = loadedCardTitles(v)
  // a sub-agent id is one sub-agent wherever it is listed: a snapshot never adds a second row for an id the dashboard has
  const seen = new Set(rows.map(r => r.id))
  const errors: string[] = []
  const merged = rows.map(row => {
    const s = row.sessionId === live.sessionId ? live.snapshots[row.id] : undefined
    if (s === undefined) return row
    const status = live.statuses[row.id]
    const state = status === undefined ? null : stateOfStatus(status)
    return {
      ...row,
      ...(state === null ? {} : engineTimes(state, s, row.finishedAt)),
      label: s.description ?? row.label,
      agentType: s.agentType ?? row.agentType,
      model: s.model ?? row.model,
      effort: s.effort ?? row.effort,
      tokensTotal: s.tokensTotal,
      costUsd: s.costUsd,
      toolCalls: s.toolCallCount,
      activity: s.currentActivity,
      card: liveCard(s.cardId, row.card, titles) ?? row.card,
    }
  })
  for (const s of Object.values(live.snapshots)) {
    if (seen.has(s.id)) continue
    const status = live.statuses[s.id]
    if (status === undefined) {
      errors.push(`${s.id} is not one of this session's sub-agents as the engine lists them`)
      continue
    }
    const state = stateOfStatus(status)
    if (state === null) {
      errors.push(`${s.id} has an engine status the pane does not know (${status})`)
      continue
    }
    merged.push({
      id: s.id,
      sessionId: live.sessionId,
      parentId: s.parentId,
      label: s.description,
      agentType: s.agentType,
      model: s.model,
      effort: s.effort,
      startedAt: s.startedAt,
      ...engineTimes(state, s, null),
      tokensTotal: s.tokensTotal,
      costUsd: s.costUsd,
      toolCalls: s.toolCallCount,
      activity: s.currentActivity,
      card: liveCard(s.cardId, null, titles),
    })
  }
  // a card is never drawn inside itself: a loop the live parents make leaves the dashboard rows as they are
  const looped = parentLoop(merged)
  if (looped !== null) return { rows, errors: [...errors, `${looped} is its own ancestor`] }
  return { rows: merged, errors }
}

// DX-4508: the card a snapshot names, titled from the dashboard row's card when it is the same id, else from any card the
// pane already loaded, else untitled (the id link alone). Null when the snapshot names none.
function liveCard(cardId: string | null, rowCard: SubagentRow['card'], titles: Map<string, string>): SubagentRow['card'] {
  if (cardId === null) return null
  if (rowCard !== null && rowCard.id === cardId) return rowCard
  return { id: cardId, title: titles.get(cardId) ?? null }
}

// Every card title the view holds: the problems' cards, the in-progress list and the sub-agent rows' cards.
function loadedCardTitles(v: PlanView): Map<string, string> {
  const titles = new Map<string, string>()
  for (const p of v.problems) titles.set(p.cardId, p.cardTitle)
  for (const r of v.inProgress) titles.set(r.id, r.title)
  for (const r of v.subagents.rows) if (r.card !== null && r.card.title !== null) titles.set(r.card.id, r.card.title)
  return titles
}

// Snapshots that can no longer show: ended past the server's window.
export function pruneSnapshots(snapshots: Record<string, LiveSnapshot>, now: number): Record<string, LiveSnapshot> {
  return Object.fromEntries(Object.entries(snapshots).filter(([, s]) => s.finishedAt === null || s.finishedAt + SUBAGENT_ENDED_VISIBLE_MS > now))
}
