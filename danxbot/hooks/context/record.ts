// CP-15: a session can end at any time and only the dashboard and git survive, so the plugin reminds it to record state at three moments no API call marks.
// This is the pure half: the texts, the thresholds and the questions the handlers ask. Nothing here reads a clock, a file or a session.

export const SUBAGENT_DONE_REMINDER =
  'A sub-agent you started just finished. Before doing anything else, put its result on its card (an agent note with what it did, the evidence and the commit), so it survives this session ending.'

// about 30-45 minutes (set during planning)
export const RECORD_AFTER_MS = 40 * 60 * 1000

export const NO_RECENT_RECORD_REMINDER =
  'You have worked about 40 minutes with no write to your plan or cards. Record your decisions and the state of the work on the card or plan now: this conversation can end at any moment, and only the dashboard and git survive it.'

export const HANDOFF_FILE_REMINDER =
  'A local file is never a record: it dies with this checkout and nobody reads it. Put what that file says (the handoff, the notes, the pending writes) on the card or plan now, as an agent note or a plan record.'

/** The session's record clock: `since` is the last write to a plan or card, the last reminder, or the first dashboard call (null before any). */
export type RecordClock = { since: number | null }

/** A call that writes a plan or a card (the session's own, through danxbot_api). */
export function isRecordWrite(method: unknown, path: unknown): boolean {
  return typeof method === 'string' && method.toUpperCase() !== 'GET' && typeof path === 'string' && /^\/api\/(issues|plans)\//.test(path)
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

const HANDOFF_NAME = /hand[-_ ]?(off|over)|notes?|pending|resume|continu(e|ation)|wip/i
const HANDOFF_CONTENT = /hand[-_ ]?(off|over)|pending (card|plan) writes?/i

/** A Write whose file name or content suggests a handoff. The caller asks git whether the file is tracked. */
export function looksLikeHandoff(filePath: unknown, content: unknown): boolean {
  if (typeof filePath !== 'string') return false
  const name = filePath.split(/[\/]/).pop() ?? ''
  return HANDOFF_NAME.test(name) || (typeof content === 'string' && HANDOFF_CONTENT.test(content))
}
