import type { PendingEvent } from '../../types'
import type { RelayEvent } from './answer'

// DX-5398: the relay's outbox. The poll loop (plan_events_wait) takes events from the server and puts them here; a separate pump delivers them to
// the session in the order the server sent them. The loop never waits on a delivery: a plugin's `$.prompt.submit` settles only when the queued
// prompt ENTERS the session (claude.exe 2.1.299: the call returns a promise the prompt core settles at the idle), so a prompt queued behind a long
// foreground turn used to hold the whole loop (polls, heartbeats, the sub-agents' stats that ride them) until that turn ended (live evidence: DX-5398
// notes). Delivery being slow is normal while a turn runs; polling stopping is never.
//
// DX-5602: an event is DELIVERED the moment the engine call for it is made (`$.prompt.submit` / the note append): it leaves the outbox and the stored resume
// cursor moves to its cursor then, not when the call's promise settles. The engine owns a queued prompt (measured, DX-5602 note 18703: it survives a reload of
// the hook module and enters as its own turn later); only the promise the old module instance awaited is lost, and a prompt merged into a queued turn never
// settles it. Waiting for the promise kept every event in the outbox for hours and sent the whole backlog again at each reload. The module instance that made
// the call still watches its outcome: a refusal (`drop`, or a throw) puts the event back and issues it again (`again`, so its older cursor never moves the
// stored one back). The outbox is a module variable shared by successive runs of one plan: a run that replaces a stuck one (the model's plan_connect, the
// stall watch) polls from the newest cursor still waiting here, else from the stored one, so a delivered event is neither asked for again nor delivered twice.
//
// The poll's cursor ACKNOWLEDGES: the server (danxbot plan-events-relay.ts) drops every record at or below the cursor a call presents, so an event taken
// and not yet delivered exists nowhere else once the next poll is made. A reload of the hook module empties the module variable, so each queued event is
// also kept in the `relayOutbox` atom ($.state outlives a reload), written before the poll that acknowledges it and cleared when it is delivered, i.e. when
// its engine call is made (`toPending`, `fromPending`). A reload therefore loses no event that was taken and not yet called for, and re-sends none that was:
// the only window is the instant between the call and the write that records it (a duplicate there, never a loss). A new process has no atom, and the server
// then resumes from the stored (delivered) cursor.
// `done`: null while the event waits to be issued; on an event put back after a refusal, a placeholder held until the backoff has passed (it is not issued before).
// `again`: it was delivered once and put back; its cursor is stored already, so issuing it again stores none.
export type Queued = { planId: number | null; event: RelayEvent; done: Promise<string | null> | null; again?: true }

// What a run on `planId` polls from: the cursor of the newest event of that plan still waiting for delivery, else the stored one.
export function pollCursor(outbox: readonly Queued[], planId: number | null, stored: string | null): string | null {
  for (let i = outbox.length - 1; i >= 0; i--) if (outbox[i].planId === planId) return outbox[i].event.cursor
  return stored
}

// Events of another plan are not this plan's to deliver (the server starts clean whenever the plan changes).
export const onlyPlan = (outbox: readonly Queued[], planId: number | null): Queued[] => outbox.filter(q => q.planId === planId)

// The loop is stalled when it has made no step for longer than `limitMs`; `since` is when the watch first saw this run, so a run that never
// made its first step is judged from there.
export const isStalled = (now: number, beat: number, since: number, limitMs: number): boolean => now - Math.max(beat, since) > limitMs

// The part of the outbox that survives a reload (the delivery promise does not).
export const toPending = (outbox: readonly Queued[]): PendingEvent[] =>
  outbox.map(q => ({ planId: q.planId, cursor: q.event.cursor, text: q.event.text, urgent: q.event.urgent, ...(q.again === true ? { again: true as const } : {}) }))

// The outbox of a run on `planId`, from what a reload found: nothing is issued yet, and another plan's events are not this run's.
export const fromPending = (pending: readonly PendingEvent[], planId: number | null): Queued[] =>
  pending.filter(p => p.planId === planId).map(p => ({ planId: p.planId, event: { cursor: p.cursor, text: p.text, urgent: p.urgent }, done: null, ...(p.again === true ? { again: true as const } : {}) }))

// A watch tick that ran more than twice its interval after the last one: the machine slept, and the wall clock moved while no timer did.
export const isLateTick = (now: number, lastTickAt: number | null, intervalMs: number): boolean => lastTickAt !== null && now - lastTickAt > 2 * intervalMs
