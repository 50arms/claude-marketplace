import type { TurnState } from '../../types'
import { RELAY_MARKER } from './config'

// DX-4721: how one relayed event reaches the session, decided here and nowhere else. The server decides urgency, by the record's kind
// (danxbot packages/danx-dashboard-mcp urgent-records.ts); the plugin only follows it:
//   not urgent -> a submitted prompt ($.prompt.submit): it waits behind a running turn and wakes an idle session, so it is read as the
//                 next prompt, after the turn
//   urgent, a turn running -> a note ($.session.append) the model reads with the next main-loop tool result
//   urgent, no turn running -> a prompt like any other (nothing would read a note)
// A note nothing read (the turn ended with no tool result after it) is told once more, as a prompt that says it repeats the note (repeatLine).
export type DeliveryMode = 'note' | 'prompt'

export const deliveryMode = (urgent: boolean, isTurnRunning: boolean): DeliveryMode => (urgent && isTurnRunning ? 'note' : 'prompt')

// the text of an event, as a note or as a prompt
export const relayLine = (text: string) => `${RELAY_MARKER} ${text}`

// the text of a note told again as a prompt: it says so, so the model can tell it already saw the note
export const repeatLine = (text: string) => `${RELAY_MARKER} (repeat of an urgent note already added to this conversation) ${text}`

// The turn: whether the main loop's turn is running now (turn.start .. turn.complete), and the texts of the notes appended into it that no
// tool result has carried yet. A main-loop tool result carries every note appended so far; one still pending when the turn ends was appended
// after its last tool result, so no tool result will carry it: it is told once as a prompt, never stranded.
export const IDLE: TurnState = { isRunning: false, pending: [] }

export const turnStarted = (): TurnState => ({ isRunning: true, pending: [] })

// A note was appended. When the turn ended between the decision and the append (turn.complete landed in between), no tool result will carry it: it
// is a prompt at once (`prompt`) instead of a pending note.
export function noteAppended(turn: TurnState, text: string): { turn: TurnState; prompt: string | null } {
  if (!turn.isRunning) return { turn, prompt: text }
  return { turn: { ...turn, pending: [...turn.pending, text] }, prompt: null }
}

// A main-loop tool result went out: every note appended so far rides it (the same state back when none is pending).
export const toolResultSent = (turn: TurnState): TurnState => (turn.pending.length === 0 ? turn : { ...turn, pending: [] })

// The main loop's turn ended: idle, and the notes it did not read, to tell once each as a prompt. A turn the person ABORTED (Esc) tells none:
// their stop is not undone by a prompt that starts another turn, and the notes stay in the conversation, read with their next prompt.
export function turnEnded(turn: TurnState, isAborted: boolean): { turn: TurnState; prompts: string[] } {
  return { turn: IDLE, prompts: isAborted ? [] : turn.pending }
}
