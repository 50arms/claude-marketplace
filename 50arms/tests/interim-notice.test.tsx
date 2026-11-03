import "./run-tests-with-npm-test.generated"
// CP-53: an interim sub-agent notice (the sub-agent ended a turn with a command of its own still running) does not wake the orchestrator. It is held;
// the result for the same task still reaches the model, and a notice whose sub-agent never reports again is told after INTERIM_HOLD_MS.
import { describe, expect } from 'claude-code/testing'

import { INTERIM_HOLD_MS, INTERIM_NOTE, nextWakeMs, receive, splitDue, taskNoticeOf } from '../hooks/context/interim-notice'
import { test, SURFACES, dashboard, startSession } from './plan-kit'

const notice = (taskId: string, extra: string, status = 'completed') =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n<summary>Agent "work" finished</summary>\n${extra}</task-notification>`
const INTERIM = (taskId: string) => notice(taskId, `<note>This agent ${INTERIM_NOTE}. It may resume on its own when that work completes or reports.</note>\n<result>not reported yet</result>\n`)
const FINAL = (taskId: string) => notice(taskId, '<result>done: commit abc123</result>\n')
const FROM_ENGINE = { kind: 'task-notification' } as const

describe('reading a notice', () => {
  test('an interim notice names its task and is interim', () => {
    expect(taskNoticeOf(FROM_ENGINE, INTERIM('a1'))).toEqual({ taskId: 'a1', interim: true })
  })

  test('a result is not interim, and a failed or killed task is not either', () => {
    expect(taskNoticeOf(FROM_ENGINE, FINAL('a1'))).toEqual({ taskId: 'a1', interim: false })
    expect(taskNoticeOf(FROM_ENGINE, notice('a1', '', 'failed'))).toEqual({ taskId: 'a1', interim: false })
  })

  test('only an engine task notification counts: the same words from a person or a plugin are text', () => {
    expect(taskNoticeOf({ kind: 'composer' }, INTERIM('a1'))).toBeNull()
    expect(taskNoticeOf({ kind: 'plugin' }, INTERIM('a1'))).toBeNull()
    expect(taskNoticeOf(undefined, INTERIM('a1'))).toBeNull()
  })

  test('a task notification naming no task is let through as it is', () => {
    expect(taskNoticeOf(FROM_ENGINE, 'task finished')).toBeNull()
  })
})

describe('the held notices', () => {
  const interim = { taskId: 'a1', interim: true }
  const final = { taskId: 'a1', interim: false }

  test('an interim notice is held, keeping the clock of the first one for the same task', () => {
    const first = receive([], interim, 'one', 1000)
    expect(first).toEqual({ holds: true, held: [{ taskId: 'a1', text: 'one', heldAt: 1000 }] })
    expect(receive(first.held, interim, 'two', 5000).held).toEqual([{ taskId: 'a1', text: 'two', heldAt: 1000 }])
  })

  test('a result for the task goes through and supersedes the held notice; other tasks stay held', () => {
    const held = [{ taskId: 'a1', text: 'one', heldAt: 1 }, { taskId: 'b2', text: 'two', heldAt: 2 }]
    expect(receive(held, final, 'done', 9)).toEqual({ holds: false, held: [{ taskId: 'b2', text: 'two', heldAt: 2 }] })
  })

  test('a notice is due once its wait is over, and the next wake is a slice of the soonest wait', () => {
    const held = [{ taskId: 'a1', text: 'one', heldAt: 0 }, { taskId: 'b2', text: 'two', heldAt: 600_000 }]
    expect(splitDue(held, INTERIM_HOLD_MS - 1).due).toEqual([])
    expect(splitDue(held, INTERIM_HOLD_MS).due.map(h => h.taskId)).toEqual(['a1'])
    expect(nextWakeMs([], 0)).toBeNull()
    expect(nextWakeMs(held, INTERIM_HOLD_MS - 5_000)).toBe(5_000)
    expect(nextWakeMs(held, INTERIM_HOLD_MS + 1)).toBe(0)
  })
})

for (const surface of SURFACES) {
  describe(`an interim sub-agent notice on ${surface}`, () => {
    test('is held: no prompt enters, and the person is told why', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const r = await $.prompt.submit({ text: INTERIM('a1'), origin: FROM_ENGINE } as any)
      expect(r.drop).toMatch(/a1/)
      expect(d.relay.submitted).toEqual([])
    })

    test('a result after it still reaches the model, and the held notice is never told', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      await $.prompt.submit({ text: INTERIM('a1'), origin: FROM_ENGINE } as any)
      const r = await $.prompt.submit({ text: FINAL('a1'), origin: FROM_ENGINE } as any)
      expect(r.drop).toBeUndefined()
      expect(r.text).toBe(FINAL('a1'))
      expect(r.context).toHaveLength(1)
      await d.clock.advance(INTERIM_HOLD_MS * 2)
      expect(d.relay.submitted).toEqual([FINAL('a1')])
    })

    test('a result with no interim notice before it reaches the model', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const r = await $.prompt.submit({ text: FINAL('a1'), origin: FROM_ENGINE } as any)
      expect(r.drop).toBeUndefined()
      expect(r.text).toBe(FINAL('a1'))
      expect(d.relay.submitted).toEqual([FINAL('a1')])
    })

    test('an interim notice for one task is not settled by the result of another', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      await $.prompt.submit({ text: INTERIM('a1'), origin: FROM_ENGINE } as any)
      await $.prompt.submit({ text: FINAL('b2'), origin: FROM_ENGINE } as any)
      await d.clock.advance(INTERIM_HOLD_MS + 60_000)
      expect(d.relay.submitted).toHaveLength(2)
      expect(d.relay.submitted[1]).toContain(INTERIM('a1'))
    })

    test('whose sub-agent never reports again is told after the wait, once, as the plugin\'s own prompt', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      await $.prompt.submit({ text: INTERIM('a1'), origin: FROM_ENGINE } as any)
      await d.clock.advance(INTERIM_HOLD_MS - 60_000)
      expect(d.relay.submitted).toEqual([])
      await d.clock.advance(120_000)
      expect(d.relay.submitted).toHaveLength(1)
      expect(d.relay.submitted[0]).toContain(INTERIM('a1'))
      await d.clock.advance(INTERIM_HOLD_MS * 2)
      expect(d.relay.submitted).toHaveLength(1)
    })

    test('a second interim notice for the task does not push the release out', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      await $.prompt.submit({ text: INTERIM('a1'), origin: FROM_ENGINE } as any)
      await d.clock.advance(INTERIM_HOLD_MS - 120_000)
      const again = await $.prompt.submit({ text: INTERIM('a1'), origin: FROM_ENGINE } as any)
      expect(again.drop).toBeDefined()
      await d.clock.advance(180_000)
      expect(d.relay.submitted).toHaveLength(1)
    })

    test('a person typing the same words is not held', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const r = await $.prompt.submit({ text: INTERIM('a1'), origin: { kind: 'composer' } } as any)
      expect(r.drop).toBeUndefined()
    })
  })
}
