import "./run-tests-with-npm-test.generated"
// CP-145 (DX-7748 DEC-1297, DEC-1340): a queued job offered to a ready session is taken by the plugin, not the model. The relay record carries `offer: {item_id, ...}`;
// the plugin claims the job (DX-8401: no assignment id is sent), runs the repo's `worktree_command` (tokens filled) from the session's checkout, and only then tells the model one prompt with the
// take's whole answer and the worktree's path. A failed command leaves the job (DELETE .../take with {error}), so it goes back to the queue, and the model is told what failed (CP-148),
// once per job and error: it no longer holds the job, so it repairs a local cause and claims it again.
// CP-181: a reload keeps the job in hand. The reloaded module claims it again (the holder's claim answers the job once more) and carries on; it hands the job back only when its worktree cannot be prepared.
import { describe, expect } from 'claude-code/testing'

import { NOT_HOLDER, type Offer } from '../hooks/ready/offer'
import { fromPending, toPending } from '../hooks/relay/outbox'
import { STALE_PENDING_DETAIL } from '../hooks/relay/text'
import { test, relayPhase, SURFACES, dashboard, startSession } from './plan-kit'

const ITEM = 41
const OFFER = { item_id: ITEM }
// the record the server's MCP sends today: it names the offer's assignment too, which a claim does not use
const SERVER_OFFER = { item_id: ITEM, assignment_id: 7 }
// the mark a module keeps for the job in hand (queueJobTaking): what a reloaded module finds
const MARK = { item_id: ITEM, urgent: false, prepared: null }
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
      expect(note).toContain('worktree_command')
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
      test('the reloaded plugin claims the job again, makes its worktree and tells the model; the session keeps the job and nothing is handed back', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
        d.seedState('queueJobTaking', MARK)
        await startSession($, d, surface)
        await d.clock.settle()
        expect(calls(d, 'POST')).toHaveLength(1)
        expect(makeRuns(d)).toHaveLength(1)
        expect(told(d)).toHaveLength(1)
        expect(told(d)[0]).toContain(WORKTREE_PATH)
        expect(answerIn(told(d)[0])).toEqual(ANSWER)
        // the job is still the session's: it was never given back, and the model has it
        expect(calls(d, 'DELETE')).toEqual([])
        expect(d.stateWrites.filter((w: any) => w.key === 'queueJobTaking').at(-1)?.value).toBeNull()
      })

      test('a worktree the old module already made is not made again', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.seedState('queueJobTaking', { ...MARK, prepared: { path: WORKTREE_PATH, worktree: ANSWER.worktree } })
        await startSession($, d, surface)
        await d.clock.settle()
        expect(makeRuns(d)).toEqual([])
        expect(told(d)).toHaveLength(1)
        expect(told(d)[0]).toContain(WORKTREE_PATH)
        expect(calls(d, 'DELETE')).toEqual([])
      })

      test('the prompt keeps the urgency the old module was told', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.world.processes['make'] = { stdout: `${WORKTREE_PATH}\n` }
        d.seedState('queueJobTaking', { ...MARK, urgent: true })
        await startSession($, d, surface)
        await d.clock.settle()
        expect(d.relay.delivered.map((x: { urgent: boolean }) => x.urgent)).toEqual([true])
      })

      test('a worktree that cannot be prepared after the reload hands the job back, and the model is told', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { body: ANSWER }
        d.world.processes['make'] = { exitCode: 2, stdout: '', stderr: 'no space left on device' }
        d.seedState('queueJobTaking', MARK)
        await startSession($, d, surface)
        await d.clock.settle()
        const left = calls(d, 'DELETE')
        expect(left).toHaveLength(1)
        expect(left[0].body.error).toContain('no space left on device')
        expect(told(d)).toHaveLength(1)
        expect(told(d)[0]).toContain('no space left on device')
      })

      test('a claim the dashboard refuses after the reload (the job is another session\'s) holds nothing: the person is told, nothing is handed back', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { status: 409, body: { error: 'dispatch_queue_take_held', holder: { session_id: 's-2', agent: 'Maren', since: '2026-11-28T00:00:00.000Z' } } }
        d.seedState('queueJobTaking', MARK)
        await startSession($, d, surface)
        await d.clock.settle()
        expect(calls(d, 'DELETE')).toEqual([])
        expect(makeRuns(d)).toEqual([])
        expect(told(d)).toEqual([])
        expect(d.toasts.some((t: string) => t.includes(`Queued job ${ITEM} was not taken`))).toBe(true)
        expect(d.stateWrites.filter((w: any) => w.key === 'queueJobTaking').at(-1)?.value).toBeNull()
      })

      test('a claim the dashboard could not answer keeps the job in hand for the next relay run, and hands nothing back', async ($, on) => {
        const d = dashboard(on)
        d.world.takeReplies[ITEM] = { status: 503, body: { error: 'unavailable' } }
        d.seedState('queueJobTaking', MARK)
        await startSession($, d, surface)
        await d.clock.settle()
        expect(calls(d, 'DELETE')).toEqual([])
        expect(told(d)).toEqual([])
        expect(d.toasts.some((t: string) => t.includes('claimed again at the next relay run'))).toBe(true)
        expect(d.stateWrites.filter((w: any) => w.key === 'queueJobTaking').at(-1)?.value).toEqual(MARK)
      })

      test('a mark of another shape cannot be carried on: the job is left with that reason, quiet when the session does not hold it', async ($, on) => {
        const d = dashboard(on)
        d.seedState('queueJobTaking', { item_id: ITEM, assignment_id: 7 })
        d.world.leaveReply = { status: 403, body: { error: NOT_HOLDER } }
        await startSession($, d, surface)
        await d.clock.settle()
        const left = calls(d, 'DELETE')
        expect(left).toHaveLength(1)
        expect(left[0].body.error).toContain('could not read the job it had in hand')
        expect(calls(d, 'POST')).toEqual([])
        expect(told(d)).toEqual([])
        expect(d.toasts.some((t: string) => t.includes(`Queued job ${ITEM}`))).toBe(false)
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
