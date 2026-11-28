import "./run-tests-with-npm-test.generated"
// CP-145 (DX-7748 DEC-1297, DEC-1340): a queued job offered to a ready session is taken by the plugin, not the model. The relay record carries `offer: {item_id, ...}`;
// the plugin claims the job (DX-8401: no assignment id is sent), runs the repo's `worktree_command` (tokens filled) from the session's checkout, and only then tells the model one prompt with the
// take's whole answer and the worktree's path. A failed command leaves the job (DELETE .../take with {error}), so it goes back to the queue, and the model is told what failed (CP-148),
// once per job and error: it no longer holds the job, so it repairs a local cause and claims it again.
// CP-181: a reload keeps the job in hand. The reloaded module claims it again (the holder's claim answers the job once more) and carries on; it hands the job back only when its worktree cannot be prepared.
import { describe, expect } from 'claude-code/testing'

import { claimedItemOf, markWritable, NOT_HOLDER, OWNER_SILENT_MS, takeoverOf, withHandedBack, withoutHandedBack, HANDED_BACK_MAX, lostToTakeover, withTakenOver, withoutTakenOver, TAKEN_OVER_MAX, type Offer, type TakingJob } from '../hooks/ready/offer'
import { fromPending, toPending } from '../hooks/relay/outbox'
import { STALE_PENDING_DETAIL } from '../hooks/relay/text'
import { test, relayPhase, SURFACES, dashboard, startSession, answerEngineClear, CLEARED_SESSION_ID } from './plan-kit'

const ITEM = 41
const OFFER = { item_id: ITEM }
// the record the server's MCP sends today: it names the offer's assignment too, which a claim does not use
const SERVER_OFFER = { item_id: ITEM, assignment_id: 7 }
const API = 'mcp__plugin_50arms_platform__50arms_api'
// the harness clock's start
const NOW = Date.parse('2026-10-03T08:00:00.000Z')
// the mark a module instance keeps for the job in hand (queueJobTaking): what a reloaded module finds. One whose owner wrote it long ago is gone; one written just now may still be working
// the old module's mark while it may still be working the job (its command or prompt survive a reload, its timers do not): judged on the reader's own timer
const LIVE = { item_id: ITEM, urgent: false, prepared: null, owner: 'previous-module', at: NOW, retry_at: null }
// the old module's mark while it waited on a claim's retry, which is due: no command runs behind it, and the reload cancelled its timer
const RETRYING = { ...LIVE, at: NOW - 1_000, retry_at: NOW - 1 }
const marksWritten = (d: any) => d.stateWrites.filter((w: any) => w.key === 'queueJobTaking').map((w: any) => w.value)
const OFFER_TEXT = 'Queued job: take it now with 50arms_api POST /api/dispatch-queue/41/take'
const TAKE = `/api/dispatch-queue/${ITEM}/take`
const WORKTREE_PATH = '/work/repo/.claude/worktrees/landing-fix'
// the take answer as the dashboard words it for a branch job (lockJobAnswer)
const ANSWER = {
  item_id: ITEM,
  repo: 'danxbot',
  target_branch: 'main',
  branch: 'landing-fix',
  red_sha: 'abc123',
  failures: [{ check: 'test', file: 'src/a.test.ts' }],
  cards: [{ card: 'DX-1', title: 'A card', sha: 'def456' }],
  last_verdict: null,
  worktree: { branch: 'landing-fix', commit: 'abc123', folder: '.claude/worktrees/landing-fix' },
  worktree_command: ['make', 'add-worktree', 'BRANCH={branch}', 'AT={commit}'],
  instruction: 'Fix every listed failure together.',
}

const told = (d: any): string[] => d.relay.delivered.map((x: { text: string }) => x.text)
const calls = (d: any, method: string) => d.api.filter((a: any) => a.method === method && a.path === TAKE)
// the take answer a told prompt carries: the JSON after its first line
const answerIn = (prompt: string) => JSON.parse(prompt.slice(prompt.indexOf('\n') + 1))
const makeRuns = (d: any) => d.runCalls.filter((argv: string[]) => argv[0] === 'make')
// the outbox entry a module keeps for an offer record it took and has not delivered (what a reload finds)
const SAVED = { planId: 23, cursor: 'c1', text: OFFER_TEXT, urgent: false, acks: [], offer: OFFER }

const job = (owner: string, at: number, retryAt: number | null = null, item = ITEM): TakingJob => ({ item_id: item, urgent: false, prepared: null, owner, at, retry_at: retryAt })

describe('the job in hand and its owner (CP-181, DEC-3425)', () => {
  test("a module may write its job over no mark (the job is still its session's) unless another instance took it over from it; over its own mark of the same job and over one of another shape; never over its own mark of another job or another instance's, unless it takes that very mark over, judged by owner and at", () => {
    const me = (cur: unknown, item: number, over: { owner: string; at: number } | null, lost = false) => markWritable(cur, 'me', item, over, lost)
    expect(me(null, ITEM, null)).toEqual({ ok: true })
    // a late copy: another instance took the job over from it and told it, so it stops, never writing a fresh mark
    expect(me(null, ITEM, null, true)).toEqual({ ok: false, by: null })
    // a takeover of a mark that is gone is no takeover
    expect(me(null, ITEM, { owner: 'old', at: NOW })).toEqual({ ok: false, by: null })
    expect(me(job('me', NOW), ITEM, null)).toEqual({ ok: true })
    expect(me({ item_id: ITEM, assignment_id: 7 }, ITEM, null)).toEqual({ ok: true })
    // its own mark of another job: that job's claim is unanswered, or it is in hand
    expect(me(job('me', NOW), ITEM + 1, null)).toEqual({ ok: false, by: job('me', NOW) })
    expect(me(job('old', NOW), ITEM, null)).toEqual({ ok: false, by: job('old', NOW) })
    expect(me(job('old', NOW), ITEM, { owner: 'old', at: NOW })).toEqual({ ok: true })
    expect(me(job('old', NOW), ITEM + 1, { owner: 'old', at: NOW })).toEqual({ ok: false, by: job('old', NOW) })
    // the owner wrote again between the judgement and the write: the takeover does not replace that mark
    expect(me(job('old', NOW + 1), ITEM, { owner: 'old', at: NOW })).toEqual({ ok: false, by: job('old', NOW + 1) })
    expect(me(job('other', NOW), ITEM, { owner: 'old', at: NOW })).toEqual({ ok: false, by: job('other', NOW) })
  })

  test('a copy is late for a job only when another instance took it over from it: the taker itself, and any other job, are not', () => {
    const list = withTakenOver([], ITEM, 'taker')
    expect(lostToTakeover(list, ITEM, 'old')).toBe(true)
    expect(lostToTakeover(list, ITEM, 'taker')).toBe(false)
    expect(lostToTakeover(list, ITEM + 1, 'old')).toBe(false)
    expect(lostToTakeover(withoutTakenOver(list, ITEM), ITEM, 'old')).toBe(false)
    const many = Array.from({ length: TAKEN_OVER_MAX }, (_, i) => ({ item_id: i + 1000, by: 'x' }))
    expect(withTakenOver(many, 1, 'x')).toHaveLength(TAKEN_OVER_MAX)
    expect(withTakenOver(withTakenOver([], ITEM, 'a'), ITEM, 'b')).toEqual([{ item_id: ITEM, by: 'b' }])
  })

  test('the reader takes a mark over by signs of life: its own when it is due, a retry mark once retry_at has passed, any other mark only after its own timer ran a whole window with at unchanged and is still pending until then', () => {
    const seen = { item_id: ITEM, owner: 'old', at: 100 }
    expect(takeoverOf(job('me', NOW), 'me', NOW, null, false, false)).toEqual({ kind: 'own' })
    // a claim of its own that waits on its retry is not carried on before it is due
    expect(takeoverOf(job('me', NOW, NOW + 1_000), 'me', NOW, null, false, false)).toEqual({ kind: 'retry', waitMs: 1_000 })
    expect(takeoverOf(job('me', NOW, NOW + 1_000), 'me', NOW + 1_000, null, false, false)).toEqual({ kind: 'own' })
    // a mark waiting on a retry
    expect(takeoverOf(job('old', NOW, NOW + 5_000), 'me', NOW, null, false, false)).toEqual({ kind: 'retry', waitMs: 5_000 })
    expect(takeoverOf(job('old', NOW, NOW + 5_000), 'me', NOW + 5_000, null, false, false)).toEqual({ kind: 'take' })
    // any other mark: not watched yet, however old its time is by the clock
    expect(takeoverOf(job('old', 100), 'me', NOW + OWNER_SILENT_MS * 100, null, false, false)).toEqual({ kind: 'watch' })
    expect(takeoverOf(job('old', 100), 'me', NOW, seen, false, true)).toEqual({ kind: 'waiting' })
    // watched but no timer is pending (a fire was lost to a busy module): watch again, never wait on nothing
    expect(takeoverOf(job('old', 100), 'me', NOW, seen, false, false)).toEqual({ kind: 'watch' })
    expect(takeoverOf(job('old', 100), 'me', NOW, seen, true, false)).toEqual({ kind: 'take' })
    // the owner wrote again (it is alive): a new watch, never a takeover
    expect(takeoverOf(job('old', 200), 'me', NOW, seen, true, false)).toEqual({ kind: 'watch' })
    expect(takeoverOf(job('other-owner', 100), 'me', NOW, seen, true, false)).toEqual({ kind: 'watch' })
  })

  test("the model's own claim is a POST of a queue job's take route, and nothing else", () => {
    expect(claimedItemOf('POST', '/api/dispatch-queue/41/take')).toBe(41)
    expect(claimedItemOf('post', '/api/dispatch-queue/41/take')).toBe(41)
    expect(claimedItemOf('DELETE', '/api/dispatch-queue/41/take')).toBeNull()
    expect(claimedItemOf('POST', '/api/dispatch-queue/41/done')).toBeNull()
    expect(claimedItemOf('POST', undefined)).toBeNull()
  })

  test('the handed-back jobs keep the newest, one entry per job', () => {
    expect(withHandedBack([1, 2], 2)).toEqual([1, 2])
    expect(withHandedBack([1, 2], 1)).toEqual([2, 1])
    expect(withoutHandedBack([1, 2], 1)).toEqual([2])
    const many = Array.from({ length: HANDED_BACK_MAX }, (_, i) => i + 1)
    expect(withHandedBack(many, 999)).toEqual([...many.slice(1), 999])
  })
})

describe('an offer kept across a reload', () => {
  test('the outbox atom keeps a record\'s offer, and a record with none comes back with none', () => {
    const queued = (cursor: string, offer: Offer | null) => ({ planId: 23, seq: 1, event: { cursor, text: OFFER_TEXT, urgent: false, acks: [], offer }, held: false })
    const back = fromPending(toPending([queued('c1', OFFER), queued('c2', null)]), 23, 1)
    expect(back.map(q => q.event.offer)).toEqual([OFFER, null])
  })
})

for (const surface of SURFACES) {
  describe(`a queued job offered on ${surface}`, () => {
    test('the plugin claims it, makes its worktree with the filled command, then tells the model the whole take answer and the path; never the offer text', async ($, on) => {
      const d = dashboard(on)
      d.world.takeReplies[ITEM] = { body: ANSWER }
      d.world.processes['make'] = { stdout: `starting pass\n${WORKTREE_PATH}\n` }
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: SERVER_OFFER })
      await d.clock.settle()
      // the claim names nothing: the offer's assignment is not sent (DX-8401)
      expect(calls(d, 'POST').map((a: any) => a.body)).toEqual([undefined])
      expect(d.runCalls).toContainEqual(['make', 'add-worktree', 'BRANCH=landing-fix', 'AT=abc123'])
      expect(told(d)).toHaveLength(1)
      expect(told(d)[0]).toContain(WORKTREE_PATH)
      expect(told(d)[0]).not.toContain('never call')
      expect(answerIn(told(d)[0])).toEqual(ANSWER)
      expect(told(d).some(t => t.includes(OFFER_TEXT))).toBe(false)
      expect(calls(d, 'DELETE')).toEqual([])
    })

    test('a take that answers no worktree runs no command and tells the model the whole answer', async ($, on) => {
      const d = dashboard(on)
      const { worktree, worktree_command, ...plain } = ANSWER
      d.world.takeReplies[ITEM] = { body: plain }
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
      await d.clock.settle()
      expect(makeRuns(d)).toEqual([])
      expect(told(d)).toHaveLength(1)
      expect(answerIn(told(d)[0])).toEqual(plain)
      expect(calls(d, 'DELETE')).toEqual([])
    })

    test('a take answer whose worktree names no commit is left, and the model is told why no command ran', async ($, on) => {
      const d = dashboard(on)
      d.world.takeReplies[ITEM] = { body: { ...ANSWER, worktree: { branch: 'landing-fix' } } }
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
      await d.clock.settle()
      expect(makeRuns(d)).toEqual([])
      expect(calls(d, 'DELETE')).toHaveLength(1)
      expect(told(d)).toHaveLength(1)
      expect(told(d)[0]).toContain('the take answered a worktree with no branch or commit')
      expect(told(d)[0]).toContain(`queued job ${ITEM}`)
    })

    test('a worktree command that cannot run (the engine rejects it) leaves the job with that error, and the model is told it', async ($, on) => {
      const d = dashboard(on)
      d.world.takeReplies[ITEM] = { body: ANSWER }
      d.world.processes['make'] = { stdout: '', throws: 'spawn make ENOENT' }
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
      await d.clock.settle()
      const left = calls(d, 'DELETE')
      expect(left).toHaveLength(1)
      expect(left[0].body.error).toContain('spawn make ENOENT')
      expect(told(d)).toHaveLength(1)
      expect(told(d)[0]).toContain('spawn make ENOENT')
    })

    test('a job prompt the session refuses leaves the job', async ($, on) => {
      const d = dashboard(on)
      d.world.takeReplies[ITEM] = { body: ANSWER }
      d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
      await startSession($, d, surface)
      d.relay.rejectPrompts('busy')
      d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
      await d.clock.settle()
      expect(calls(d, 'DELETE')).toHaveLength(1)
      expect(told(d)).toEqual([])
    })

    test('a leave the dashboard refuses after a failed command tells the person both failures', async ($, on) => {
      const d = dashboard(on)
      d.world.takeReplies[ITEM] = { body: ANSWER }
      d.world.processes['make'] = { exitCode: 2, stdout: '', stderr: 'boom' }
      d.world.leaveReply = { status: 500, body: { error: 'leave boom' } }
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
      await d.clock.settle()
      expect(d.toasts.some((t: string) => t.includes('leave boom'))).toBe(true)
      // the session still holds the job: it was not handed back, so the model is not told it was
      expect(told(d)).toEqual([])
    })

    test('a failed worktree command leaves the job with its error and tells the model the job, the command, its exit and output, and that the job is no longer its', async ($, on) => {
      const d = dashboard(on)
      d.world.takeReplies[ITEM] = { body: ANSWER }
      d.world.processes['make'] = { exitCode: 2, stdout: '', stderr: 'fatal: origin has no commit abc123' }
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
      await d.clock.settle()
      const left = calls(d, 'DELETE')
      expect(left).toHaveLength(1)
      expect(left[0].body.error).toContain('fatal: origin has no commit abc123')
      expect(told(d)).toHaveLength(1)
      const note = told(d)[0]
      expect(note).toContain(`queued job ${ITEM} (branch landing-fix at abc123; cards DX-1)`)
      expect(note).toContain('`make add-worktree BRANCH=landing-fix AT=abc123`')
      expect(note).toContain('exited 2')
      expect(note).toContain('fatal: origin has no commit abc123')
      expect(note).toContain('do not work it unless you claim it again')
      // it says how to claim the job again once the cause is repaired, and forbids nothing
      expect(note).toContain(`POST ${TAKE}`)
      // the session makes the worktree: the model only claims
      expect(note).not.toContain('worktree_command')
      expect(note).toContain('never make the worktree yourself')
      expect(note).toContain('repo_mismatch')
      expect(note).not.toContain('never call')
      // the take's answer is not repeated: the job is not the model's
      expect(note).not.toContain('Fix every listed failure together.')
    })

    test('the model hears the same failure of the same job once: the next offers of it are handed back again and tell nothing', async ($, on) => {
      const d = dashboard(on)
      d.world.takeReplies[ITEM] = { body: ANSWER }
      d.world.processes['make'] = { exitCode: 2, stdout: '', stderr: 'shared install damaged' }
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
      await d.clock.settle()
      d.relay.push({ cursor: 'c2', text: OFFER_TEXT, offer: { item_id: ITEM, assignment_id: 8 } })
      await d.clock.settle()
      d.relay.push({ cursor: 'c3', text: OFFER_TEXT, offer: { item_id: ITEM, assignment_id: 9 } })
      await d.clock.settle()
      expect(calls(d, 'DELETE')).toHaveLength(3)
      expect(told(d)).toHaveLength(1)
    })

    test('a different failure of the same job is told again', async ($, on) => {
      const d = dashboard(on)
      d.world.takeReplies[ITEM] = { body: ANSWER }
      d.world.processes['make'] = { exitCode: 2, stdout: '', stderr: 'shared install damaged' }
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
      await d.clock.settle()
      d.world.processes['make'] = { exitCode: 2, stdout: '', stderr: 'no space left on device' }
      d.relay.push({ cursor: 'c2', text: OFFER_TEXT, offer: { item_id: ITEM, assignment_id: 8 } })
      await d.clock.settle()
      expect(told(d)).toHaveLength(2)
      expect(told(d)[1]).toContain('no space left on device')
    })

    test('the same failure of another job is told', async ($, on) => {
      const d = dashboard(on)
      d.world.takeReplies[ITEM] = { body: ANSWER }
      d.world.takeReplies[ITEM + 1] = { body: { ...ANSWER, item_id: ITEM + 1 } }
      d.world.processes['make'] = { exitCode: 2, stdout: '', stderr: 'shared install damaged' }
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
      await d.clock.settle()
      d.relay.push({ cursor: 'c2', text: OFFER_TEXT, offer: { item_id: ITEM + 1, assignment_id: 9 } })
      await d.clock.settle()
      expect(told(d)).toHaveLength(2)
      expect(told(d)[1]).toContain(`queued job ${ITEM + 1}`)
    })

    test('a job the model was told that then fails again with the same error is told again', async ($, on) => {
      const d = dashboard(on)
      d.world.takeReplies[ITEM] = { body: ANSWER }
      d.world.processes['make'] = { exitCode: 2, stdout: '', stderr: 'shared install damaged' }
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
      await d.clock.settle()
      d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
      d.relay.push({ cursor: 'c2', text: OFFER_TEXT, offer: { item_id: ITEM, assignment_id: 8 } })
      await d.clock.settle()
      d.world.processes['make'] = { exitCode: 2, stdout: '', stderr: 'shared install damaged' }
      d.relay.push({ cursor: 'c3', text: OFFER_TEXT, offer: { item_id: ITEM, assignment_id: 9 } })
      await d.clock.settle()
      expect(told(d)).toHaveLength(3)
      expect(told(d)[1]).toContain(WORKTREE_PATH)
      expect(told(d)[2]).toContain('shared install damaged')
    })

    test('a command whose last line is no absolute path is a failed command: the job is left and the model is told', async ($, on) => {
      const d = dashboard(on)
      d.world.takeReplies[ITEM] = { body: ANSWER }
      d.world.processes['make'] = { stdout: 'worktree ready at: somewhere\n' }
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
      await d.clock.settle()
      expect(calls(d, 'DELETE')).toHaveLength(1)
      expect(told(d)).toHaveLength(1)
      expect(told(d)[0]).toContain('printed no worktree path as its last line')
    })

    test('a refused take holds nothing: no command runs, nothing is left, the model is told nothing (the person has the toast)', async ($, on) => {
      const d = dashboard(on)
      // no scripted reply: the claim answers 409 dispatch_queue_take_held
      await startSession($, d, surface)
      const runsBefore = d.runCalls.length
      d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
      await d.clock.settle()
      expect(calls(d, 'POST')).toHaveLength(1)
      expect(d.runCalls.slice(runsBefore).some((argv: string[]) => argv[0] === 'make')).toBe(false)
      expect(calls(d, 'DELETE')).toEqual([])
      expect(told(d)).toEqual([])
    })

    test('an offer record a reloaded module kept undelivered is taken by the plugin, never told as text', async ($, on) => {
      const d = dashboard(on)
      d.world.takeReplies[ITEM] = { body: ANSWER }
      d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
      d.seedState('relayOutbox', [SAVED])
      await startSession($, d, surface)
      await d.clock.settle()
      expect(calls(d, 'POST')).toHaveLength(1)
      expect(told(d)).toHaveLength(1)
      expect(told(d).some(t => t.includes(OFFER_TEXT))).toBe(false)
    })

    test('a kept outbox entry whose offer is malformed stops the relay loudly and takes nothing', async ($, on) => {
      const d = dashboard(on)
      d.seedState('relayOutbox', [{ ...SAVED, offer: { item_id: 'x' } }])
      await startSession($, d, surface)
      await d.clock.settle()
      expect(relayPhase(d)).toBe('stopped')
      expect(d.relay.told.some((t: string) => t.includes(STALE_PENDING_DETAIL))).toBe(true)
      expect(calls(d, 'POST')).toEqual([])
      expect(told(d)).toEqual([])
    })

    describe('a plugin reload while the session holds a job (CP-181)', () => {
      test('the old module is still working the job (its mark is fresh): the reloaded module claims nothing, makes no worktree, tells nothing and hands nothing back', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
        d.seedState('queueJobTaking', LIVE)
        await startSession($, d, surface)
        await d.clock.settle()
        expect(calls(d, 'POST')).toEqual([])
        expect(calls(d, 'DELETE')).toEqual([])
        expect(makeRuns(d)).toEqual([])
        expect(told(d)).toEqual([])
        expect(marksWritten(d)).toEqual([])
      })

      test('the old module that stays silent for a whole window on the reader own timer is gone: the reloaded module takes the job over, claims it again, makes its worktree and tells the model once', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
        // its time is ancient by the clock, which the reader never compares: only its own timer judges
        d.seedState('queueJobTaking', { ...LIVE, at: NOW - OWNER_SILENT_MS * 5 })
        await startSession($, d, surface)
        await d.clock.settle()
        expect(calls(d, 'POST')).toEqual([])
        await d.clock.advance(OWNER_SILENT_MS - 10_000)
        await d.clock.settle()
        expect(calls(d, 'POST')).toEqual([])
        await d.clock.advance(20_000)
        await d.clock.settle()
        expect(calls(d, 'POST')).toHaveLength(1)
        expect(makeRuns(d)).toHaveLength(1)
        expect(told(d)).toHaveLength(1)
        expect(told(d)[0]).toContain(WORKTREE_PATH)
        expect(calls(d, 'DELETE')).toEqual([])
      })

      test('an owner that has been silent long ago is gone at once: the reloaded module carries the job on, and the session keeps the job (nothing handed back)', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
        d.seedState('queueJobTaking', RETRYING)
        await startSession($, d, surface)
        await d.clock.settle()
        expect(calls(d, 'POST')).toHaveLength(1)
        expect(makeRuns(d)).toHaveLength(1)
        expect(told(d)).toHaveLength(1)
        expect(answerIn(told(d)[0])).toEqual(ANSWER)
        expect(calls(d, 'DELETE')).toEqual([])
        expect(marksWritten(d).at(-1)).toBeNull()
      })

      test('a worktree the previous module already made is not made again', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.seedState('queueJobTaking', { ...RETRYING, prepared: { path: WORKTREE_PATH, worktree: { branch: 'landing-fix', commit: 'abc123' } } })
        await startSession($, d, surface)
        await d.clock.settle()
        expect(makeRuns(d)).toEqual([])
        expect(told(d)).toHaveLength(1)
        expect(told(d)[0]).toContain(WORKTREE_PATH)
        expect(calls(d, 'DELETE')).toEqual([])
      })

      test("a claim that got no answer, then a reload (the old module's retry timer is gone): the new module takes over at retry_at, makes the worktree once, tells the job once, and a later offer is not refused", async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.world.takeReplies[ITEM + 1] = { body: { ...ANSWER, item_id: ITEM + 1 } }
        d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
        d.seedState('queueJobTaking', { ...LIVE, retry_at: NOW + 2_000 })
        await startSession($, d, surface)
        await d.clock.settle()
        expect(calls(d, 'POST')).toEqual([])
        await d.clock.advance(2_000)
        await d.clock.settle()
        expect(calls(d, 'POST')).toHaveLength(1)
        expect(makeRuns(d)).toHaveLength(1)
        expect(told(d)).toHaveLength(1)
        expect(answerIn(told(d)[0]).item_id).toBe(ITEM)
        expect(calls(d, 'DELETE')).toEqual([])
        // the mark is cleared: the session takes the next job
        d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: { item_id: ITEM + 1 } })
        await d.clock.settle()
        expect(d.api.filter((a: any) => a.method === 'POST' && a.path === `/api/dispatch-queue/${ITEM + 1}/take`)).toHaveLength(1)
        expect(told(d)).toHaveLength(2)
        expect(d.toasts.some((t: string) => t.includes('is still preparing'))).toBe(false)
      })

      test('the window ends while the module is busy with a model claim: the fire is not lost, the mark is taken over afterwards and a later offer is taken', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.world.takeReplies[ITEM + 2] = { body: { ...ANSWER, item_id: ITEM + 2 } }
        d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
        d.seedState('queueHandedBack', [ITEM + 1])
        d.seedState('queueJobTaking', LIVE)
        on('tool.call', { tool: API }, () => ({ result: {}, text: JSON.stringify({ ok: true, status: 200, body: { ...ANSWER, item_id: ITEM + 1 } }), isError: false }) as any)
        await startSession($, d, surface)
        await d.clock.settle()
        await d.clock.advance(OWNER_SILENT_MS - 2_000)
        // the model's claim of another job lands now, and its hand-back waits on a slow dashboard across the end of the window
        d.holdApi(6_000)
        await $.tool.call({ tool: API, method: 'POST', path: `/api/dispatch-queue/${ITEM + 1}/take`, body: {} } as any)
        await d.clock.advance(4_000)
        expect(calls(d, 'POST')).toEqual([])
        d.holdApi(0)
        await d.clock.advance(20_000)
        await d.clock.settle()
        expect(calls(d, 'POST')).toHaveLength(1)
        expect(makeRuns(d)).toHaveLength(1)
        expect(told(d).map(t => t.includes(`queued job ${ITEM}`) && t.includes(WORKTREE_PATH))).toContain(true)
        d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: { item_id: ITEM + 2 } })
        await d.clock.settle()
        expect(d.api.filter((a: any) => a.method === 'POST' && a.path === `/api/dispatch-queue/${ITEM + 2}/take`)).toHaveLength(1)
        expect(d.toasts.some((t: string) => t.includes('is still preparing'))).toBe(false)
      })

      test('a hand-back that waits on the network is preceded by a sign of life: the owner rewrites its mark before the DELETE', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.world.processes['make'] = { exitCode: 2, stdout: '', stderr: 'shared install damaged' }
        await startSession($, d, surface)
        d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
        await d.clock.settle()
        // the claim, the command and the sign of life before the DELETE: three writes of the owner's mark before it is dropped
        const live = marksWritten(d).filter((m: unknown) => m !== null)
        expect(live).toHaveLength(3)
        expect(live.every((m: any) => m.retry_at === null)).toBe(true)
        expect(marksWritten(d).at(-1)).toBeNull()
        expect(calls(d, 'DELETE')).toHaveLength(1)
      })

      test("the mark goes missing between the claim's send and its answer (a /clear's carry gap, or an older module clearing it): the job is still the session's, so its worktree is made and its prompt told once", async ($, on) => {
        answerEngineClear(on)
        const d = dashboard(on, { stateSteps: true })
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
        await startSession($, d, surface)
        d.holdApi(3_000)
        d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
        await d.clock.advance(500)
        // the claim is on its way, its mark is written: the state is emptied under it
        d.wipeState()
        d.holdApi(0)
        await d.clock.advance(6_000)
        await d.clock.settle()
        expect(calls(d, 'POST')).toHaveLength(1)
        expect(makeRuns(d)).toHaveLength(1)
        expect(told(d)).toHaveLength(1)
        expect(answerIn(told(d)[0])).toEqual(ANSWER)
        expect(calls(d, 'DELETE')).toEqual([])
      })

      test("a /clear's restore writes back a mark the module dropped meanwhile: the job is not told a second time, and a mark the module wrote in the gap is not lost", async ($, on) => {
        answerEngineClear(on)
        const d = dashboard(on, { stateSteps: true })
        d.world.takeReplies[ITEM] = { body: ANSWER }
        let release!: () => void
        d.world.processHolds.push({ command: 'make add-worktree BRANCH=landing-fix AT=abc123', hold: new Promise<void>(r => (release = r)) })
        d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
        await startSession($, d, surface)
        d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
        await d.clock.advance(500)
        // the clear ends the conversation while the worktree command runs: the mark in hand is what session.end reads
        await $.session.end({ reason: 'clear', sessionId: d.world.sessionId } as any)
        d.wipeState()
        release()
        await d.clock.settle()
        expect(told(d)).toHaveLength(1)
        expect(marksWritten(d).at(-1)).toBeNull()
        // the new conversation starts: the restore must not bring the dropped mark back
        const from = d.stateWrites.length
        d.world.sessionId = `${CLEARED_SESSION_ID}-gap`
        await $.classic.SessionStart({ source: 'clear', cwd: '/work', session_id: d.world.sessionId, transcript_path: '/work/cleared-gap.jsonl' })
        await d.clock.settle()
        expect(d.stateWrites.slice(from).filter((w: any) => w.key === 'queueJobTaking').map((w: any) => w.value).every((v: unknown) => v === null)).toBe(true)
        expect(told(d)).toHaveLength(1)
        expect(makeRuns(d)).toHaveLength(1)
        expect(calls(d, 'POST')).toHaveLength(1)
      })

      test('a takeover records its taker, and the taker itself is not stopped when its mark goes missing meanwhile', async ($, on) => {
        answerEngineClear(on)
        const d = dashboard(on, { stateSteps: true })
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
        d.seedState('queueJobTaking', { ...RETRYING, retry_at: NOW + 5_000 })
        await startSession($, d, surface)
        d.holdApi(3_000)
        await d.clock.advance(5_200)
        d.wipeState()
        d.holdApi(0)
        await d.clock.advance(6_000)
        await d.clock.settle()
        const taken = d.stateWrites.filter((w: any) => w.key === 'queueTakenOver').map((w: any) => w.value)
        expect(taken[0]).toHaveLength(1)
        expect(taken[0][0].item_id).toBe(ITEM)
        const owner = marksWritten(d).find((m: any) => m !== null).owner
        expect(taken[0][0].by).toBe(owner)
        expect(makeRuns(d)).toHaveLength(1)
        expect(told(d)).toHaveLength(1)
        expect(calls(d, 'DELETE')).toEqual([])
      })

      test('a taken-over job whose worktree is made is carried on even when the repo has cleared its worktree command since', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { body: { ...ANSWER, worktree_command: [] } }
        d.seedState('queueJobTaking', { ...RETRYING, prepared: { path: WORKTREE_PATH, worktree: { branch: 'landing-fix', commit: 'abc123' } } })
        await startSession($, d, surface)
        await d.clock.settle()
        expect(makeRuns(d)).toEqual([])
        expect(calls(d, 'DELETE')).toEqual([])
        expect(told(d)).toHaveLength(1)
        expect(told(d)[0]).toContain(WORKTREE_PATH)
      })

      test('an offer that arrives while a claim awaits its retry is refused, and the first claim is still made again', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { status: 503, body: { error: 'unavailable' } }
        d.world.takeReplies[ITEM + 1] = { body: { ...ANSWER, item_id: ITEM + 1 } }
        d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
        await startSession($, d, surface)
        d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
        await d.clock.settle()
        d.relay.push({ cursor: 'c2', text: OFFER_TEXT, offer: { item_id: ITEM + 1 } })
        await d.clock.settle()
        expect(d.api.filter((a: any) => a.method === 'POST' && a.path === `/api/dispatch-queue/${ITEM + 1}/take`)).toEqual([])
        expect(d.toasts.some((t: string) => t.includes(`Queued job ${ITEM + 1} was not taken: this session is still preparing queued job ${ITEM}`))).toBe(true)
        // the mark says its owner waits on a retry, so a reload that cancels the timer cannot strand the job
        const retrying = marksWritten(d).filter((m: any) => m !== null).at(-1)
        expect(typeof retrying.retry_at).toBe('number')
        d.world.takeReplies[ITEM] = { body: ANSWER }
        await d.clock.advance(1_000)
        await d.clock.settle()
        expect(calls(d, 'POST')).toHaveLength(2)
        expect(told(d)).toHaveLength(1)
        expect(answerIn(told(d)[0]).item_id).toBe(ITEM)
      })

      test('a mark of another shape (an older plugin\'s module, which may still be working the job) is never read and never handed back', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.seedState('queueJobTaking', { item_id: ITEM, assignment_id: 7 })
        await startSession($, d, surface)
        await d.clock.settle()
        expect(calls(d, 'POST')).toEqual([])
        expect(calls(d, 'DELETE')).toEqual([])
        expect(told(d)).toEqual([])
      })

      test('an offer that arrives while a mark of another instance stands is refused, and the mark is not written over', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM + 1] = { body: { ...ANSWER, item_id: ITEM + 1 } }
        d.seedState('queueJobTaking', LIVE)
        await startSession($, d, surface)
        d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: { item_id: ITEM + 1 } })
        await d.clock.settle()
        expect(d.api.filter((a: any) => a.method === 'POST' && a.path === `/api/dispatch-queue/${ITEM + 1}/take`)).toEqual([])
        expect(d.toasts.some((t: string) => t.includes(`Queued job ${ITEM + 1} was not taken: this session is still preparing queued job ${ITEM}`))).toBe(true)
        // whatever was written back is the mark that stood
        expect(marksWritten(d).every((m: unknown) => JSON.stringify(m) === JSON.stringify(LIVE))).toBe(true)
      })

      test('an offer and a job a gone owner left, both at startup: the left job is carried on and its mark is never lost to the offer', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.world.takeReplies[ITEM + 1] = { body: { ...ANSWER, item_id: ITEM + 1 } }
        d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
        d.seedState('queueJobTaking', RETRYING)
        d.seedState('relayOutbox', [{ ...SAVED, offer: { item_id: ITEM + 1 } }])
        await startSession($, d, surface)
        await d.clock.settle()
        expect(calls(d, 'POST')).toHaveLength(1)
        expect(calls(d, 'DELETE')).toEqual([])
        expect(told(d).map(t => answerIn(t).item_id)).toContain(ITEM)
      })

      test('the job in hand is written before the claim, before the command and before the prompt, owned by this instance, and cleared once the prompt is made', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
        await startSession($, d, surface)
        d.relay.push({ cursor: 'c1', text: OFFER_TEXT, urgent: true, offer: OFFER })
        await d.clock.settle()
        const marks = marksWritten(d)
        const shaped = marks.map((m: any) => (m === null ? null : { ...m, owner: typeof m.owner, at: typeof m.at }))
        const prepared = { path: WORKTREE_PATH, worktree: { branch: 'landing-fix', commit: 'abc123' } }
        const mine = (prepared: unknown) => ({ item_id: ITEM, urgent: true, prepared, owner: 'string', at: 'number', retry_at: null })
        expect(shaped).toEqual([mine(null), mine(null), mine(prepared), null])
        expect(new Set(marks.filter((m: any) => m !== null).map((m: any) => m.owner)).size).toBe(1)
      })

      test('a worktree that cannot be prepared after the reload hands the job back, and the model is told', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.world.processes['make'] = { exitCode: 2, stdout: '', stderr: 'no space left on device' }
        d.seedState('queueJobTaking', RETRYING)
        await startSession($, d, surface)
        await d.clock.settle()
        const left = calls(d, 'DELETE')
        expect(left).toHaveLength(1)
        expect(left[0].body.error).toContain('no space left on device')
        expect(told(d)).toHaveLength(1)
        expect(told(d)[0]).toContain('no space left on device')
      })

      for (const error of ['dispatch_queue_take_held', 'dispatch_queue_take_not_ready', 'dispatch_queue_item_finished']) {
        test(`a claim refused ${error}, which holds nothing of the job, hands nothing back: the person is told`, async ($, on) => {
          const d = dashboard(on)
          d.world.takeReplies[ITEM] = { status: 409, body: { error } }
          d.seedState('queueJobTaking', RETRYING)
          await startSession($, d, surface)
          await d.clock.settle()
          expect(calls(d, 'DELETE')).toEqual([])
          expect(makeRuns(d)).toEqual([])
          expect(told(d)).toEqual([])
          expect(d.toasts.some((t: string) => t.includes(`Queued job ${ITEM} was not taken`))).toBe(true)
          expect(marksWritten(d).at(-1)).toBeNull()
        })
      }

      for (const status of [400, 403, 429]) {
        test(`a claim made again after the reload and refused ${status} may leave the session holding the job: it is handed back, quiet when the dashboard says it holds nothing`, async ($, on) => {
          const d = dashboard(on)
          d.world.takeReplies[ITEM] = { status, body: { error: 'refused' } }
          d.world.leaveReply = { status: 403, body: { error: NOT_HOLDER } }
          d.seedState('queueJobTaking', RETRYING)
          await startSession($, d, surface)
          await d.clock.settle()
          const left = calls(d, 'DELETE')
          expect(left).toHaveLength(1)
          expect(left[0].body.error).toContain('after the plugin reloaded was refused')
          expect(told(d)).toEqual([])
          expect(d.toasts.some((t: string) => t.includes(`Queued job ${ITEM}`))).toBe(false)
        })
      }

      test('a claim the dashboard cannot answer keeps the job in hand and is made again after the relay backoff, not at the next relay run', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { status: 503, body: { error: 'unavailable' } }
        d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
        await startSession($, d, surface)
        d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
        await d.clock.settle()
        expect(calls(d, 'POST')).toHaveLength(1)
        expect(calls(d, 'DELETE')).toEqual([])
        expect(told(d)).toEqual([])
        expect(d.toasts.filter((t: string) => t.includes('claimed again shortly'))).toHaveLength(1)
        d.world.takeReplies[ITEM] = { body: ANSWER }
        await d.clock.advance(1_000)
        await d.clock.settle()
        expect(calls(d, 'POST')).toHaveLength(2)
        expect(told(d)).toHaveLength(1)
        expect(told(d)[0]).toContain(WORKTREE_PATH)
        expect(calls(d, 'DELETE')).toEqual([])
      })
    })

    describe("the model's claim of a handed-back job (CP-181, BPR-24)", () => {
      const CLAIM = { tool: API, method: 'POST', path: TAKE, body: {} } as any
      const answerWith = (body: unknown) => ({ result: {}, text: JSON.stringify({ ok: true, status: 200, body }), isError: false }) as any
      // the job handed back after its worktree failed: the offer's claim, the command's failure, the leave and the model told
      async function handedBack(d: any, $: any, on: any, answer: (e: any) => any = () => answerWith(ANSWER)) {
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.world.processes['make'] = { exitCode: 2, stdout: '', stderr: 'shared install damaged' }
        on('tool.call', { tool: API }, (_$: any, e: any) => answer(e))
        await startSession($, d, surface)
        d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
        await d.clock.settle()
        expect(calls(d, 'DELETE')).toHaveLength(1)
        expect(told(d)).toHaveLength(1)
      }

      test('the model only claims: the session makes the worktree and tells the model the job', async ($, on) => {
        const d = dashboard(on)
        await handedBack(d, $, on)
        d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
        await $.tool.call(CLAIM)
        await d.clock.settle()
        // the plugin made no claim of its own beside the offer's: the model's is the claim
        expect(calls(d, 'POST')).toHaveLength(1)
        expect(makeRuns(d)).toHaveLength(2)
        expect(told(d)).toHaveLength(2)
        expect(told(d)[1]).toContain(WORKTREE_PATH)
        expect(answerIn(told(d)[1])).toEqual(ANSWER)
        expect(calls(d, 'DELETE')).toHaveLength(1)
      })

      test('the claim uses the handed-back job up: a second claim of it is the model\'s own, and makes no worktree and tells nothing', async ($, on) => {
        const d = dashboard(on)
        await handedBack(d, $, on)
        d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
        await $.tool.call(CLAIM)
        await d.clock.settle()
        await $.tool.call(CLAIM)
        await d.clock.settle()
        expect(makeRuns(d)).toHaveLength(2)
        expect(told(d)).toHaveLength(2)
      })

      test("a holder's re-claim of the job it was told (reading it back after a /clear or a compaction) passes through: no worktree, no second prompt", async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
        on('tool.call', { tool: API }, () => answerWith(ANSWER))
        await startSession($, d, surface)
        d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
        await d.clock.settle()
        expect(told(d)).toHaveLength(1)
        const read = await $.tool.call(CLAIM)
        await d.clock.settle()
        expect(JSON.stringify(read)).toContain('landing-fix')
        expect(makeRuns(d)).toHaveLength(1)
        expect(told(d)).toHaveLength(1)
        expect(calls(d, 'DELETE')).toEqual([])
      })

      test("a sub-agent's re-claim of the job it was told is the same: no worktree, no second prompt", async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
        on('tool.call', { tool: API }, () => answerWith(ANSWER))
        await startSession($, d, surface)
        d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
        await d.clock.settle()
        await $.tool.call({ ...CLAIM, agentId: 'a1' })
        await d.clock.settle()
        expect(makeRuns(d)).toHaveLength(1)
        expect(told(d)).toHaveLength(1)
        expect(calls(d, 'DELETE')).toEqual([])
      })

      test('a refused claim, or any other call, makes no worktree and tells nothing', async ($, on) => {
        const d = dashboard(on)
        let refusing = false
        const refusal = { result: {}, text: JSON.stringify({ ok: false, status: 409, body: { error: 'dispatch_queue_take_held' } }), isError: false } as any
        await handedBack(d, $, on, (e: any) => (refusing && e.method === 'POST' ? refusal : answerWith(refusing ? {} : ANSWER)))
        refusing = true
        await $.tool.call(CLAIM)
        await $.tool.call({ tool: API, method: 'GET', path: '/api/dispatch-queue/41/fix' } as any)
        await d.clock.settle()
        expect(makeRuns(d)).toHaveLength(1)
        expect(told(d)).toHaveLength(1)
      })

      test('a worktree that fails again is told again: the model waits for the job it claimed', async ($, on) => {
        const d = dashboard(on)
        await handedBack(d, $, on)
        await $.tool.call(CLAIM)
        await d.clock.settle()
        expect(calls(d, 'DELETE')).toHaveLength(2)
        expect(told(d)).toHaveLength(2)
        expect(told(d)[1]).toContain('shared install damaged')
      })

      test('a claim while the session has another job in hand does not leave the claimed job held with nobody working it: it is handed back and the model is told why', async ($, on) => {
        const d = dashboard(on)
        d.seedState('queueHandedBack', [ITEM + 1])
        d.seedState('queueJobTaking', LIVE)
        on('tool.call', { tool: API }, () => answerWith({ ...ANSWER, item_id: ITEM + 1 }))
        await startSession($, d, surface)
        await $.tool.call({ ...CLAIM, path: `/api/dispatch-queue/${ITEM + 1}/take` })
        await d.clock.settle()
        const left = d.api.filter((a: any) => a.method === 'DELETE' && a.path === `/api/dispatch-queue/${ITEM + 1}/take`)
        expect(left).toHaveLength(1)
        expect(left[0].body.error).toContain(`queued job ${ITEM} in hand`)
        expect(makeRuns(d)).toEqual([])
        expect(told(d)).toHaveLength(1)
        expect(told(d)[0]).toContain(`queued job ${ITEM + 1}`)
        // it waits for the prompt of the job in hand and does not claim again at once
        expect(told(d)[0]).toContain(`Wait for the prompt that tells you queued job ${ITEM}`)
        expect(told(d)[0]).toContain('do not claim')
        // what is shown: back in the queue for any session, claimable again once this session holds no other job; no promise that 50 Arms offers it again
        expect(told(d)[0]).toContain('back in the queue for any session')
        expect(told(d)[0]).toContain('session_holds_job')
        expect(told(d)[0]).not.toContain('offers it again')
        // the model that claims again at once is handed the job back again, and is not woken again
        await $.tool.call({ ...CLAIM, path: `/api/dispatch-queue/${ITEM + 1}/take` })
        await d.clock.settle()
        expect(d.api.filter((a: any) => a.method === 'DELETE' && a.path === `/api/dispatch-queue/${ITEM + 1}/take`)).toHaveLength(2)
        expect(told(d)).toHaveLength(1)
        // no false "was not taken": the claim had landed
        expect(d.toasts.some((t: string) => t.includes('was not taken'))).toBe(false)
      })
    })

    test('a record with no offer is told as before', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: 'operator commented on problem 3', offer: null })
      await d.clock.settle()
      expect(told(d)).toEqual(['[50 Arms plan event] operator commented on problem 3'])
      expect(d.api.some((a: any) => a.path.startsWith('/api/dispatch-queue/'))).toBe(false)
    })
  })
}
