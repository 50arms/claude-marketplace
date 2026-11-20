// A queued job offered to this session. The dashboard offers a ready session a job from its dispatch queue, and the MCP server hands that record to the relay
// with `offer: {item_id, assignment_id}` (null on every other record). The plugin, not the model, takes such a job: it takes it with the offer's assignment id, runs the
// repo's own worktree command when the take answers a `worktree`, and only then tells the model the job, with the take's whole answer and the worktree's path. A take ends
// the offer, so the model could never take it again: everything it needs is in that one prompt. When anything after the take fails, the plugin leaves the job (it goes
// back to the queue) with the error, and the model is told what failed (jobHandedBack) when the take had landed and its worktree could not be made. The pure part is here; every `$` call is in the hooks module.

export type Offer = { item_id: number; assignment_id: number }

const isId = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0

// A record's offer: absent or null is no offer (an older MCP server sends none at all); anything else that is not {item_id, assignment_id} as positive integers is malformed
export function offerOf(record: any): Offer | null | 'malformed' {
  const o = record?.offer
  if (o === undefined || o === null) return null
  if (typeof o !== 'object' || !isId(o.item_id) || !isId(o.assignment_id)) return 'malformed'
  return { item_id: o.item_id, assignment_id: o.assignment_id }
}

export const takePath = (itemId: number) => `/api/dispatch-queue/${itemId}/take`

// The worktree a take answered, and the repo's command that makes it, filled with its branch and commit
export type Worktree = { branch: string; commit: string }
export type TakePlan = { worktree: Worktree; argv: string[] } | { worktree: null }

const isText = (x: unknown): x is string => typeof x === 'string' && x !== ''

// What a take answer asks the plugin to prepare. `worktree` absent or null: nothing (a job that works no one branch). A worktree needs the repo's
// `worktree_command`, an argument list whose `{branch}` and `{commit}` tokens are filled here. Anything else is the reason the answer cannot be read.
export function takePlanOf(answer: any): TakePlan | { malformed: string } {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return { malformed: 'the take answered no job' }
  const w = answer.worktree
  if (w === undefined || w === null) return { worktree: null }
  if (typeof w !== 'object' || !isText(w.branch) || !isText(w.commit)) return { malformed: 'the take answered a worktree with no branch or commit' }
  const command = answer.worktree_command
  if (!Array.isArray(command) || command.length === 0 || !command.every(isText)) return { malformed: "the take answered a worktree but no worktree_command to make it" }
  const worktree = { branch: w.branch, commit: w.commit }
  return { worktree, argv: command.map(arg => arg.replaceAll('{branch}', worktree.branch).replaceAll('{commit}', worktree.commit)) }
}

// how much of a failed command's output the error quotes
export const COMMAND_OUTPUT_MAX = 600
const tail = (text: string) => (text.length > COMMAND_OUTPUT_MAX ? `…${text.slice(-COMMAND_OUTPUT_MAX)}` : text)

const isAbsolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')

// The worktree's path from the command's run: by its contract the command exits 0 and its last line of standard output is the worktree's absolute path.
// Anything else is the error the job is left with.
export function worktreePathOf(argv: readonly string[], run: { exitCode: number; stdout: string; stderr: string }): { path: string } | { error: string } {
  const command = argv.join(' ')
  if (run.exitCode !== 0) {
    const output = (run.stderr.trim() !== '' ? run.stderr : run.stdout).trim()
    return { error: `the worktree command \`${command}\` exited ${run.exitCode}${output === '' ? '' : `: ${tail(output)}`}` }
  }
  const last = run.stdout.replace(/\s+$/, '').split(/\r?\n/).at(-1)?.trim() ?? ''
  if (!isAbsolute(last)) return { error: `the worktree command \`${command}\` printed no worktree path as its last line${last === '' ? '' : ` (it printed: ${tail(last)})`}` }
  return { path: last }
}

export const commandFailed = (argv: readonly string[], message: string) => `the worktree command \`${argv.join(' ')}\` could not run: ${message}`

// The one prompt that tells the model the job it now holds: the take is done, and its answer is the job
export function jobPrompt(itemId: number, answer: unknown, prepared: { path: string; worktree: Worktree } | null): string {
  const where =
    prepared === null
      ? 'It names no worktree to work in.'
      : `Its worktree is ready at ${prepared.path}, on ${prepared.worktree.branch} at ${prepared.worktree.commit}: work there by its absolute path and \`git -C\`, and never cd into it.`
  return `50 Arms assigned this session queued job ${itemId}, and the session has already taken it for you: never call its take route. ${where} Do what its \`instruction\` says. The job, as its take answered it:\n${JSON.stringify(answer, null, 2)}`
}

// What the model is told when a job the plugin took is handed back: the job it was offered, the error it was left with (which names the command, its exit and the tail of its output, or why no
// command ran) and that the job is no longer this session's, so the model repairs a local cause and never works the job. `answer` is the take's whole answer; its branch, commit and cards name the job.
function jobLabel(itemId: number, answer: any): string {
  const cards = Array.isArray(answer?.cards) ? answer.cards.map((c: any) => c?.card).filter(isText) : []
  const named = [
    isText(answer?.branch) ? `branch ${answer.branch}${isText(answer?.red_sha) ? ` at ${answer.red_sha}` : ''}` : null,
    cards.length > 0 ? `cards ${cards.join(', ')}` : null,
  ].filter((x): x is string => x !== null)
  return `queued job ${itemId}${named.length > 0 ? ` (${named.join('; ')})` : ''}`
}

export function jobHandedBack(itemId: number, answer: unknown, error: string): string {
  return `50 Arms assigned this session ${jobLabel(itemId, answer)}, and the session took it, but could not prepare it: ${error}. The session handed the job back to the queue, so it no longer holds it: do not work it and never call its take route. If the cause is on this machine (a damaged install, a stale worktree, a missing tool), repair it now, before 50 Arms offers the job again; otherwise tell the person what failed.`
}

// The failures already told to the model, one entry per job and error, so an identical failure at the next offer of the same job wakes the session no more. The newest FAILURES_TOLD_MAX are kept.
export type FailureTold = { item_id: number; error: string }
export const FAILURES_TOLD_MAX = 20
export const failureWasTold = (told: readonly FailureTold[], itemId: number, error: string) => told.some(t => t.item_id === itemId && t.error === error)
export const withFailureTold = (told: readonly FailureTold[], itemId: number, error: string): FailureTold[] => [...told, { item_id: itemId, error }].slice(-FAILURES_TOLD_MAX)
// a job the model was told (it holds it now) starts over: a later failure of it, even an identical one, is new
export const withoutFailuresOf = (told: readonly FailureTold[], itemId: number): FailureTold[] => told.filter(t => t.item_id !== itemId)

// Shown to the person when a job is not worked here
export const notTakenToast = (itemId: number, why: string) => `Queued job ${itemId} was not taken: ${why}`
export const leftToast = (itemId: number, error: string) => `Queued job ${itemId} went back to the queue: ${error}`
// the leave's own failure first: the job is still held by this session, which is what the person must act on
export const leaveFailedToast = (itemId: number, error: string, why: string) => `Queued job ${itemId} is still held here: leaving it failed (${why}) after ${error}`
export const busyToast = (itemId: number, busyWith: number) => `Queued job ${itemId} was not taken: this session is still preparing queued job ${busyWith}`
export const malformedOfferLine = 'answered a record whose offer is not {item_id, assignment_id}'

// The errors a job is left with
export const PROMPT_REFUSED = (why: string) => `the session did not take the job's prompt: ${why}`
export const RELOADED_WHILE_PREPARING = "the plugin was reloaded while it prepared the job's worktree"

// The leave route refuses a session that does not hold the job: after a reload, the take that was under way never landed, so there is nothing to give back
export const NOT_HOLDER = 'dispatch_queue_leave_not_holder'
