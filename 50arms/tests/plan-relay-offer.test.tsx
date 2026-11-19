import "./run-tests-with-npm-test.generated"
// CP-145 (DX-7748 DEC-1297, DEC-1340): a queued job offered to a ready session is taken by the plugin, not the model. The relay record carries `offer: {item_id, assignment_id}`;
// the plugin takes the job with the assignment id, runs the repo's `worktree_command` (tokens filled) from the session's checkout, and only then tells the model one prompt with the
// take's whole answer and the worktree's path. A failed command leaves the job (DELETE .../take with {error}), so it goes back to the queue, and the model is told nothing.
import { describe, expect } from 'claude-code/testing'

import { RELOADED_WHILE_PREPARING } from '../hooks/ready/offer'
import { test, SURFACES, dashboard, startSession } from './plan-kit'

const ITEM = 41
const OFFER = { item_id: ITEM, assignment_id: 7 }
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

for (const surface of SURFACES) {
  describe(`a queued job offered on ${surface}`, () => {
    test('the plugin takes it, makes its worktree with the filled command, then tells the model the whole take answer and the path; never the offer text', async ($, on) => {
      const d = dashboard(on)
      d.world.takeReplies[ITEM] = { body: ANSWER }
      d.world.processes['make'] = { stdout: `starting pass\n${WORKTREE_PATH}\n` }
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
      await d.clock.settle()
      expect(calls(d, 'POST').map((a: any) => a.body)).toEqual([{ assignment_id: 7 }])
      expect(d.runCalls).toContainEqual(['make', 'add-worktree', 'BRANCH=landing-fix', 'AT=abc123'])
      expect(told(d)).toHaveLength(1)
      expect(told(d)[0]).toContain(WORKTREE_PATH)
      expect(told(d)[0]).toContain(JSON.stringify(ANSWER, null, 2))
      expect(told(d).some(t => t.includes(OFFER_TEXT))).toBe(false)
      expect(calls(d, 'DELETE')).toEqual([])
    })

    test('a failed worktree command leaves the job with its error and tells the model nothing', async ($, on) => {
      const d = dashboard(on)
      d.world.takeReplies[ITEM] = { body: ANSWER }
      d.world.processes['make'] = { exitCode: 2, stdout: '', stderr: 'fatal: origin has no commit abc123' }
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
      await d.clock.settle()
      const left = calls(d, 'DELETE')
      expect(left).toHaveLength(1)
      expect(left[0].body.error).toContain('fatal: origin has no commit abc123')
      expect(told(d)).toEqual([])
    })

    test('a command whose last line is no absolute path is a failed command: the job is left', async ($, on) => {
      const d = dashboard(on)
      d.world.takeReplies[ITEM] = { body: ANSWER }
      d.world.processes['make'] = { stdout: 'worktree ready at: somewhere\n' }
      await startSession($, d, surface)
      d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
      await d.clock.settle()
      expect(calls(d, 'DELETE')).toHaveLength(1)
      expect(told(d)).toEqual([])
    })

    test('a refused take holds nothing: no command runs, nothing is left, the model is told nothing', async ($, on) => {
      const d = dashboard(on)
      // no scripted reply: the take answers 403 dispatch_queue_take_not_offered
      await startSession($, d, surface)
      const runsBefore = d.runCalls.length
      d.relay.push({ cursor: 'c1', text: OFFER_TEXT, offer: OFFER })
      await d.clock.settle()
      expect(calls(d, 'POST')).toHaveLength(1)
      expect(d.runCalls.slice(runsBefore).some((argv: string[]) => argv[0] === 'make')).toBe(false)
      expect(calls(d, 'DELETE')).toEqual([])
      expect(told(d)).toEqual([])
    })

    test('a job a reloaded module was preparing is left at the next relay run', async ($, on) => {
      const d = dashboard(on)
      d.seedState('queueJobTaking', OFFER)
      await startSession($, d, surface)
      const left = calls(d, 'DELETE')
      expect(left).toHaveLength(1)
      expect(left[0].body).toEqual({ error: RELOADED_WHILE_PREPARING })
      expect(told(d)).toEqual([])
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
