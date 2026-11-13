// An interim sub-agent notice must not wake the orchestrator. When a sub-agent ends a turn while a command of its own still runs, Claude
// Code queues a `task-notification` prompt saying so; the same task id notifies again when the sub-agent really finishes. Each such wake-up is a
// paid turn of the orchestrator at its full context. This is the pure half: reading a notice, and what to keep of the ones held. Nothing here reads
// a clock, a file or a session.

// the engine's own words in the interim notice's `<note>` (a closed sentence of the harness, the only signal it gives: the status stays `completed`)
export const INTERIM_NOTE = 'stopped with background work of its own still running'

// How long an interim notice is held before it is told after all. Longer than the trial runs and test suites a sub-agent waits on, short enough that
// a sub-agent that never notifies again is noticed within one working session.
export const INTERIM_HOLD_MS = 30 * 60 * 1000

// The wall clock decides when a notice is due, so a timer is only ever a slice of the wait (`$.clock.after` does not count the time the computer sleeps).
export const INTERIM_WAKE_MS = 30_000

export type HeldNotice = { taskId: string; text: string; heldAt: number }

export type TaskNotice = { taskId: string; interim: boolean }

// The notice a `prompt.submit` carries, or null when it is not a task notification or names no task (it then reaches the model as it is).
export function taskNoticeOf(origin: { kind?: unknown } | undefined, text: string): TaskNotice | null {
  if (origin?.kind !== 'task-notification') return null
  const taskId = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(text)?.[1]
  if (taskId === undefined) return null
  return { taskId, interim: new RegExp(`<note>[^<]*${INTERIM_NOTE}[^<]*</note>`).test(text) }
}

// What a notice does to the held ones. An interim notice is held (a second one for the same task replaces the text and keeps the first's clock, so the
// release stays bounded); any other notice for a task that has a held one supersedes it. The notice itself reaches the model unless it is held.
export function receive(held: readonly HeldNotice[], notice: TaskNotice, text: string, now: number): { held: HeldNotice[]; holds: boolean } {
  const rest = held.filter(h => h.taskId !== notice.taskId)
  if (!notice.interim) return { held: rest, holds: false }
  const first = held.find(h => h.taskId === notice.taskId)
  return { held: [...rest, { taskId: notice.taskId, text, heldAt: first?.heldAt ?? now }], holds: true }
}

export function splitDue(held: readonly HeldNotice[], now: number): { due: HeldNotice[]; rest: HeldNotice[] } {
  return { due: held.filter(h => now >= h.heldAt + INTERIM_HOLD_MS), rest: held.filter(h => now < h.heldAt + INTERIM_HOLD_MS) }
}

// The wait until the next timer wake: the soonest release, in slices.
export function nextWakeMs(held: readonly HeldNotice[], now: number): number | null {
  if (held.length === 0) return null
  const soonest = Math.min(...held.map(h => h.heldAt + INTERIM_HOLD_MS))
  return Math.min(INTERIM_WAKE_MS, Math.max(0, soonest - now))
}

// the reason shown to the person when a notice is held (the engine shows a drop's text as the reason)
export const heldReason = (taskId: string): string => `Held an interim notice from sub-agent ${taskId}: it is waiting on its own background work and notifies again when it finishes.`

// what the model reads when a held notice is told after the wait
export const releasedText = (held: HeldNotice, now: number): string =>
  `A sub-agent sent an interim notice ${Math.round((now - held.heldAt) / 60_000)} minutes ago, saying it was waiting on its own background work, and has not reported since. The notice:\n${held.text}`
