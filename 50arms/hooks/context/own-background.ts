// CP-108: a sub-agent must not end its turn while a command it started in the background still runs. Claude Code is supposed to wake it when the command
// finishes, but that wake-up is often lost and the sub-agent then sits idle until someone resumes it. Pure: no clock, file or session.

export type OwnShell = { taskId: string; label: string }

// The shells of this sub-agent that the engine's `background_tasks` snapshot still lists as running. A snapshot that is not a list names none (fail open).
export function ownRunningShells(own: readonly OwnShell[], tasks: unknown): OwnShell[] {
  if (!Array.isArray(tasks)) return []
  const running = new Set(tasks.filter(t => t?.status === 'running').map(t => t.id))
  return own.filter(s => running.has(s.taskId))
}

// the reason the engine shows the sub-agent when its turn end is refused
export const subagentStopRefusal = (running: readonly OwnShell[]): string =>
  `You cannot end your turn yet: a command you started in the background is still running (${running.map(s => `${s.taskId}: ${s.label}`).join('; ')}). Ending the turn to wait for it loses the wake-up, and you would sit idle. Wait for it here instead, in the foreground, in bounded steps: run a command that checks it (its output, or a sleep of at most a minute or two) and returns well within the tool timeout, and repeat until it has finished. If you no longer need it, stop it with TaskStop. End your turn only once it is done.`
