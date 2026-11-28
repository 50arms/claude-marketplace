// A queued job offered to this session. The dashboard offers a ready session a job from its dispatch queue and nudges it to claim it: the MCP server hands that record to the relay
// with `offer: {item_id, assignment_id}` (null on every other record). The plugin, not the model, claims such a job (`POST /api/dispatch-queue/:id/take`: any session may claim, offered or not,
// the first claim wins, DX-8401), runs the repo's own worktree command when the claim answers a `worktree`, and only then tells the model the job, with the claim's whole answer and the worktree's
// path. The mark of the job in hand (`TakingJob`) names the module instance that owns it, so a reloaded module, which does not end the old module's work, never acts on a job another instance may still be
// working (CP-181); it takes a job over only once its owner has been silent longer than any step can take. When anything after the claim fails, the plugin leaves the job (it goes back to the queue)
// with the error, and the model is told what failed (jobHandedBack) when the claim had landed and its worktree could not be made. The pure part is here; every `$` call is in the hooks module.

export type Offer = { item_id: number }

const isId = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0

// A record's offer: absent or null is no offer (an older MCP server sends none at all); anything else that is not an object with a positive integer `item_id` is malformed. The server's record also
// names the offer's assignment; a claim needs none (DX-8401), so it is not kept.
export function offerOf(record: any): Offer | null | 'malformed' {
  const o = record?.offer
  if (o === undefined || o === null) return null
  if (typeof o !== 'object' || !isId(o.item_id)) return 'malformed'
  return { item_id: o.item_id }
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

// The longest the repo's worktree command may run: the engine's own limit for one process
export const WORKTREE_COMMAND_TIMEOUT_MS = 600_000
// A reloaded plugin does not end the old module's work: its in-flight worktree command and prompt go on, but its timers and clock waits are cancelled (a reload unloads its environment). The new module then sees a mark
// the old one wrote and cannot tell whether that owner still works it, so it judges by signs of life (DEC-3425): a mark waiting on a retry says so (`retry_at`), and any other mark is judged on the reader's OWN timer, as
// long as the longest step can take (the command's limit plus a minute, since the owner rewrites its mark at every step), never by comparing the mark's time with the clock.
export const OWNER_SILENT_MS = WORKTREE_COMMAND_TIMEOUT_MS + 60_000

// The job a module has in hand, kept in `$.state` from before its claim until the model is told it or it is left. `owner` is the instance id the module that wrote it minted when it loaded, `at` the time of its last write
// (the owner rewrites it at each step: before the claim, before the command, after the worktree, when it arms a retry). `retry_at` is when a claim that got no answer is made again (null: the owner is working, not waiting). `prepared`
// is the worktree once the repo's command made it (a module that carries the job on claims it again, which answers the holder the job once more, and does not run the command again), `urgent` how the model's prompt is issued.
export type Prepared = { path: string; worktree: Worktree }
export type TakingJob = { item_id: number; urgent: boolean; prepared: Prepared | null; owner: string; at: number; retry_at: number | null }
// what a module has in hand before it writes the mark
export type Hand = Pick<TakingJob, 'item_id' | 'urgent' | 'prepared'>

// The mark a module wrote, or null when it is not one this module writes: a mark of another shape belongs to an older plugin's module, which may still be working the job
export function takingJobOf(x: any): TakingJob | null {
  if (x === null || typeof x !== 'object' || !isId(x.item_id) || typeof x.urgent !== 'boolean' || !isText(x.owner) || typeof x.at !== 'number') return null
  if (x.retry_at !== null && typeof x.retry_at !== 'number') return null
  const p = x.prepared
  if (p !== null && (typeof p !== 'object' || !isText(p.path) || !isText(p.worktree?.branch) || !isText(p.worktree?.commit))) return null
  return { item_id: x.item_id, urgent: x.urgent, prepared: p, owner: x.owner, at: x.at, retry_at: x.retry_at }
}

// The mark a reader saw and is waiting on: the job, its owner and the `at` it saw
export type Watch = { item_id: number; owner: string; at: number }

// What the module `owner` does with the mark `job` it finds (DEC-3425):
//   own      it wrote it (a claim it retries): it carries on
//   take     the owner is gone: a mark waiting on a retry whose `retry_at` has passed (no command runs behind it, and a reload cancelled the owner's timer), or one the reader has watched for the whole window with its own
//            timer (`timerFired`) and whose `at` has not changed
//   retry    a mark waiting on a retry that is not due: look again in `waitMs`
//   watch    another instance's mark the reader has not watched yet, or whose `at` moved: note it and arm the timer
//   waiting  the reader's timer for this very mark is armed: nothing to do before it fires
export type Takeover = { kind: 'own' | 'take' | 'watch' | 'waiting' } | { kind: 'retry'; waitMs: number }
export function takeoverOf(job: TakingJob, owner: string, now: number, watched: Watch | null, timerFired: boolean): Takeover {
  if (job.owner === owner) return { kind: 'own' }
  if (job.retry_at !== null) return now >= job.retry_at ? { kind: 'take' } : { kind: 'retry', waitMs: job.retry_at - now }
  const same = watched !== null && watched.item_id === job.item_id && watched.owner === job.owner && watched.at === job.at
  if (!same) return { kind: 'watch' }
  return timerFired ? { kind: 'take' } : { kind: 'waiting' }
}

// Whether the module `owner` may write its job in hand, `itemId`, over the mark `cur`: over none, and over one of another shape (never read, so never kept from a new job). Its own mark of another job stands in the way (that job's
// claim is unanswered, or it is in hand) and so does a mark another instance wrote, which is the blocker the answer names, unless `takingOver` (the module carries that very job on after `takeoverOf` said take).
export function markWritable(cur: unknown, owner: string, itemId: number, takingOver: boolean): { ok: true } | { ok: false; by: TakingJob } {
  const job = takingJobOf(cur)
  if (job === null) return { ok: true }
  if (job.owner === owner) return job.item_id === itemId ? { ok: true } : { ok: false, by: job }
  return takingOver && job.item_id === itemId ? { ok: true } : { ok: false, by: job }
}

// The jobs this session handed back, whose claim by the model is the session's to make the worktree for: newest HANDED_BACK_MAX kept. A claim of any other job (a holder reading its job back) is the model's own.
export const HANDED_BACK_MAX = 20
export const withHandedBack = (ids: readonly number[], itemId: number): number[] => [...ids.filter(i => i !== itemId), itemId].slice(-HANDED_BACK_MAX)
export const withoutHandedBack = (ids: readonly number[], itemId: number): number[] => ids.filter(i => i !== itemId)

// The refusals a claim answers when the session holds nothing of the job. Any other refusal of a claim a reloaded module makes again may leave the session holding the job it claimed before the reload, so the job is handed back.
const CLAIM_HOLDS_NOTHING = ['dispatch_queue_take_held', 'dispatch_queue_take_not_ready', 'dispatch_queue_item_finished']
export const claimHoldsNothing = (body: any): boolean => CLAIM_HOLDS_NOTHING.includes(body?.error)

// The model's own claim of a queue job (`50arms_api` `POST /api/dispatch-queue/<id>/take`): its item id, or null for any other call
export function claimedItemOf(method: unknown, path: unknown): number | null {
  if (typeof method !== 'string' || method.toUpperCase() !== 'POST' || typeof path !== 'string') return null
  const m = /^\/api\/dispatch-queue\/(\d+)\/take$/.exec(path)
  return m === null ? null : Number(m[1])
}

// The one prompt that tells the model the job it now holds: the take is done, and its answer is the job
export function jobPrompt(itemId: number, answer: unknown, prepared: { path: string; worktree: Worktree } | null): string {
  const where =
    prepared === null
      ? 'It names no worktree to work in.'
      : `Its worktree is ready at ${prepared.path}, on ${prepared.worktree.branch} at ${prepared.worktree.commit}: work there by its absolute path and \`git -C\`, and never cd into it.`
  return `50 Arms assigned this session queued job ${itemId}, and the session has already claimed it for you. ${where} Do what its \`instruction\` says. The job, as its take answered it:\n${JSON.stringify(answer, null, 2)}`
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
  return `50 Arms assigned this session ${jobLabel(itemId, answer)}, and the session claimed it, but could not prepare it: ${error}. The session handed the job back to the queue, so it no longer holds it: do not work it unless you claim it again. If the cause is on this machine (a damaged install, a stale worktree, a missing tool), repair it now, then claim the job again with \`50arms_api\` \`POST ${takePath(itemId)}\` (no body): the first claim wins, and a refusal names the session that holds it. A refusal \`repo_mismatch\` means this session is not on the ready list of the job's repo (its ready mark ended when it claimed the job): load the \`50arms:ready\` skill to join the list again, then claim. Once the claim lands the session makes the worktree and tells you the job, as it did the first time: never make the worktree yourself. If the cause is not on this machine, tell the person what failed.`
}

// What the model is told when its claim of a handed-back job could not be worked because the session has another job in hand (DEC-3425): the claim had landed, so the job was handed back; the model waits for the job in
// hand, whose prompt is coming, and never claims this one again at once (a session holds one job: the claim would be refused, or handed back again).
export function jobBusyHandedBack(itemId: number, answer: unknown, busyWith: number): string {
  return `50 Arms assigned this session ${jobLabel(itemId, answer)}, and you claimed it, but the session is still preparing queued job ${busyWith}, so it handed this job back to the queue. Wait for the prompt that tells you queued job ${busyWith} and work that job: do not claim queued job ${itemId} again now. 50 Arms offers it again when the session is free.`
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
// The claim could not be answered (the dashboard was unreachable or failed): the mark stays and the claim is made again after a wait
export const claimUnreadToast = (itemId: number, why: string) => `Queued job ${itemId} could not be claimed (${why}): it is claimed again shortly`
export const busyToast = (itemId: number, busyWith: number) => `Queued job ${itemId} was not taken: this session is still preparing queued job ${busyWith}`
export const malformedOfferLine = 'answered a record whose offer has no item_id'

// The errors a job is left with
export const PROMPT_REFUSED = (why: string) => `the session did not take the job's prompt: ${why}`

// The leave route refuses a session that does not hold the job: a leave of a claim that never landed has nothing to give back
export const NOT_HOLDER = 'dispatch_queue_leave_not_holder'
