// a session can end at any time and only the dashboard and git survive, so the plugin reminds it to record state at three moments no API call marks.
// This is the pure half: the texts, the thresholds and the questions the handlers ask. Nothing here reads a clock, a file or a session.

// the one shared sentence of a sub-agent's finish: the notice names the agent (and the cards its brief named) before it
export const SUBAGENT_DONE_ACTION = 'Before doing anything else, put its result on its card (an agent note with what it did, the evidence and the commit), so it survives this session ending.'

const DESCRIPTION_MAX = 80

/**
 * What the plugin keeps of a sub-agent at the moment it is spawned (the `agent.spawn` hook answers its id there): its description, whether it runs
 * in the background, and whether the main loop spawned it (`direct`) rather than another sub-agent.
 */
export type SpawnedAgent = { description: string; background: boolean; direct: boolean }
export type SpawnedAgents = Record<string, SpawnedAgent>

// the newest spawns kept: a finished agent may be resumed any time, but never more than this many are remembered
export const SPAWNED_KEPT = 200

/** The record after a spawn: the agent is the newest, and a respawn (a resume) of an id replaces its entry. */
export function spawnedAfter(cur: SpawnedAgents, id: string, agent: SpawnedAgent): SpawnedAgents {
  const { [id]: _replaced, ...rest } = cur
  const next = { ...rest, [id]: agent }
  const ids = Object.keys(next)
  return ids.length <= SPAWNED_KEPT ? next : Object.fromEntries(ids.slice(ids.length - SPAWNED_KEPT).map(k => [k, next[k] as SpawnedAgent]))
}

/**
 * What tells the main session that one of its own sub-agents finished. A background agent is announced by the engine's own final task notice
 * (`notice`): the engine sends one each time the agent stops with no live background children of its own, so it is the one signal that is
 * never an interim pause, and the stop hook (which fires at every turn's end, interim or not) must say nothing for it. A foreground agent has no
 * task notice (its result is the Agent call's answer), so its stop tells (`stop`). A nested agent's result goes to its parent, and an agent this
 * session never saw spawn cannot be placed: nobody (`null`).
 */
export function announcedBy(agent: SpawnedAgent | undefined): 'notice' | 'stop' | null {
  if (agent === undefined || !agent.direct) return null
  return agent.background ? 'notice' : 'stop'
}

/** What the main session is told when one of its own sub-agents finished: the agent named by its description and id, and by the cards its brief named. */
export function subagentDoneReminder(id: string, agent: SpawnedAgent, cards: readonly string[]): string {
  const words = agent.description.replace(/\s+/g, ' ').trim()
  const label = words === '' ? id : `"${words.length > DESCRIPTION_MAX ? `${words.slice(0, DESCRIPTION_MAX)}…` : words}" (${id})`
  const named = cards.length === 0 ? '' : ` (its brief named ${cards.join(', ')})`
  return `The sub-agent ${label} you started just finished${named}. ${SUBAGENT_DONE_ACTION}`
}

export const SIDE_SESSION_DONE_REMINDER =
  'A side session you started just ended a turn. Once its work is finished (its card Done or its branch landed, nothing of its own still open), archive it now with archive_session: a finished side session is never left idle. If its work is not finished, leave it running.'

/**
 * Whether a prompt is the desktop app's notice that a side session this session started ended a turn. The app words it two ways, both
 * measured in live transcripts: a `<system-reminder>` note that opens `The session "<title>" you started (local_<id>) finished a turn`
 * (with `and then reported that it was waiting on the user` after it when that is so), and, when the starter was idle, a
 * `<side-sessions-event>` message beside it. Either marks the event; a person's own prompt carries neither.
 */
export function isSideSessionNotice(text: unknown): boolean {
  return typeof text === 'string' && (text.includes('<side-sessions-event>') || /The session ".*" you started \(local_[\w-]+\) finished a turn/.test(text))
}

// 40 minutes: the middle of the 30-45 the plan set. Long enough that a session mid-task is not nagged between steps, short enough that a crash loses little.
export const RECORD_AFTER_MS = 40 * 60 * 1000

export const NO_RECENT_RECORD_REMINDER =
  `You have worked about ${RECORD_AFTER_MS / 60_000} minutes with no write to your plan or cards. Record your decisions and the state of the work on the card or plan now: this conversation can end at any moment, and only the dashboard and git survive it.`

export const HANDOFF_FILE_REMINDER =
  'A local file is never a record: it dies with this checkout and nobody reads it. Put what that file says (the handoff, the notes, the pending writes) on the card or plan now, as an agent note or a plan record.'

/** The session's record clock: `since` is the last write to a plan or card, the last reminder, or the first dashboard call (null before any). */
export type RecordClock = { since: number | null }

/** A call that writes a plan or a card (the session's own, through 50arms_api). */
export function isRecordWrite(method: unknown, path: unknown): boolean {
  return typeof method === 'string' && method.toUpperCase() !== 'GET' && typeof path === 'string' && /^\/api\/(issues|plans)(\/|$)/.test(path)
}

/** The next clock after a dashboard call at `now`: a record write restarts it, the first call of any kind starts it, any other call leaves it. */
export function clockAfterCall(cur: RecordClock, record: boolean, now: number): RecordClock {
  if (record || cur.since === null) return { since: now }
  return cur
}

/** At a turn's end: the reminder and the clock after it. The reminder is due once the clock is RECORD_AFTER_MS old, and restarts it so it repeats only after another stretch. */
export function recordDue(cur: RecordClock, now: number): { reminder: string | null; clock: RecordClock } {
  if (cur.since === null || now - cur.since < RECORD_AFTER_MS) return { reminder: null, clock: cur }
  return { reminder: NO_RECENT_RECORD_REMINDER, clock: { since: now } }
}

// whole-word on the file's own name: a directory named notes, or a file whose name only contains "wipe" or ends in "-notes", is no handoff
const HANDOFF_STEM = /^(session[-_ ])?notes$|^pending[-_ ]writes$|(^|[-_. ])hand[-_ ]?(off|over)($|[-_. ])/i
const HANDOFF_CONTENT = /hand[-_ ]?(off|over)|pending (card|plan) writes?/i

/** The last part of a Windows or POSIX path. */
export function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? ''
}

/** A Write whose file name or content suggests a handoff. The caller asks git whether the file is tracked. */
export function looksLikeHandoff(filePath: unknown, content: unknown): boolean {
  if (typeof filePath !== 'string') return false
  const stem = baseName(filePath).replace(/\.[^.]*$/, '')
  return HANDOFF_STEM.test(stem) || (typeof content === 'string' && HANDOFF_CONTENT.test(content))
}
