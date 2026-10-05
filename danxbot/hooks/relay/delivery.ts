import type { TurnState } from '../../types'
import { RELAY_MARKER } from './config'

// DX-4233: how one relayed event reaches the session, decided here and nowhere else. The decision: a turn is in flight (turn.start ..
// turn.complete of the main loop) -> a row the model reads in that turn (`$.session.append`); idle -> a submitted prompt, which wakes
// the session. The rest is the one gap that decision leaves, closed by plain transitions over `TurnState`:
//   a row appended after the turn's last model request (`turn.step`) is not read by that turn, which makes no more requests, so the
//   events of the rows appended since the last request are named again in one prompt when the turn ends.
// Sufficient because every model request carries the whole conversation so far: a row appended before the last request is read in it,
// and one appended after can only be read by a later request. A row appended in the instant before the request is built is named again
// too (a repeat, never a loss).
export type DeliveryMode = 'row' | 'prompt'

export const IDLE: TurnState = { isInFlight: false, unseen: [] }

export const deliveryMode = (turn: TurnState): DeliveryMode => (turn.isInFlight ? 'row' : 'prompt')

export const eventRow = (text: string) => `${RELAY_MARKER} ${text}`

export const turnStarted = (): TurnState => ({ isInFlight: true, unseen: [] })

// The one prompt that names the events of rows the session will not read on its own: `N events arrived as the last turn ended: a | b`.
const wakeText = (texts: string[]) =>
  `${RELAY_MARKER} ${texts.length === 1 ? 'an event' : `${texts.length} events`} arrived as the last turn ended: ${texts.join(' | ')}`

// A row was appended. Decided on the turn as it is NOW (the one this update sees), not as it was when the delivery chose a row: when the
// turn ended in between (turn.complete landed after the decision and before the append), nothing will read the row, so it is named in
// a wake prompt at once instead of being remembered for a turn that is over.
export function rowAppended(turn: TurnState, text: string): { turn: TurnState; wake: string | null } {
  if (!turn.isInFlight) return { turn, wake: wakeText([text]) }
  return { turn: { ...turn, unseen: [...turn.unseen, text] }, wake: null }
}

// a model request of the main loop is about to be sent: every row appended so far is in it (the same state back when there is none)
export const requestSent = (turn: TurnState): TurnState => (turn.unseen.length === 0 ? turn : { ...turn, unseen: [] })

// The turn ended: idle again, and the prompt that names what it did not read (null when it read everything). A turn the person ABORTED
// (Esc) gets no wake prompt: their stop is not undone by a prompt that starts another turn, and the rows stay in the conversation, read with
// the next prompt they send.
export function turnEnded(turn: TurnState, isAborted: boolean): { turn: TurnState; wake: string | null } {
  return { turn: IDLE, wake: isAborted || turn.unseen.length === 0 ? null : wakeText(turn.unseen) }
}
