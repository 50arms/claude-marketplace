import type { RelayEvent } from './answer'

// DX-5398: the relay's outbox. The poll loop (plan_events_wait) takes events from the server and puts them here; a separate pump delivers them to
// the session in the order the server sent them. The loop never waits on a delivery: a plugin's `$.prompt.submit` settles only when the queued
// prompt ENTERS the session (claude.exe 2.1.299: the call returns a promise the prompt core settles at the idle), so a prompt queued behind a long
// foreground turn used to hold the whole loop (polls, heartbeats, the sub-agents' stats that ride them) until that turn ended (live evidence: DX-5398
// notes). Delivery being slow is normal while a turn runs; polling stopping is never.
//
// An event leaves the outbox when it is delivered, and only then does the stored resume cursor move to its cursor (so a crash or a reload repeats at
// most the events not yet delivered, never loses one). The outbox is a module variable shared by successive runs of one plan: a run that replaces a
// stuck one (the model's plan_connect, the stall watch) polls from the newest cursor still waiting here, so an event in flight is neither asked for
// again nor delivered twice.
// `done`: null until the event has been issued to the session, then the pending outcome of its delivery (null inside when delivered, else the cause).
export type Queued = { planId: number | null; event: RelayEvent; done: Promise<string | null> | null }

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
