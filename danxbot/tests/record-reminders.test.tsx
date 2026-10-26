import "./run-tests-with-npm-test.generated"
// CP-15: the three reminders to record state: a sub-agent finished, a stretch of work with no plan or card write, a handoff-like local file written.
import { describe, expect } from 'claude-code/testing'

import { HANDOFF_FILE_REMINDER, NO_RECENT_RECORD_REMINDER, RECORD_AFTER_MS, SUBAGENT_DONE_REMINDER, clockAfterCall, isRecordWrite, looksLikeHandoff, recordDue } from '../hooks/context/record'
import { test, SURFACES, dashboard, startSession } from './plan-kit'

const API = 'mcp__plugin_danxbot_danx-dashboard__danxbot_api'
const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any

describe('the record clock (pure)', () => {
  test('only a non-GET call on an issue or plan path is a record write', () => {
    expect(isRecordWrite('POST', '/api/issues/CP-15/notes')).toBe(true)
    expect(isRecordWrite('patch', '/api/plans/66/records/1')).toBe(true)
    expect(isRecordWrite('POST', '/api/issues')).toBe(true)
    expect(isRecordWrite('POST', '/api/plans')).toBe(true)
    expect(isRecordWrite('POST', '/api/issues-other')).toBe(false)
    expect(isRecordWrite('GET', '/api/issues/CP-15')).toBe(false)
    expect(isRecordWrite('POST', '/api/plan-sessions/me/events/5/ack')).toBe(false)
    expect(isRecordWrite(undefined, undefined)).toBe(false)
  })
  test('the first call starts the clock, a read leaves it, a record write restarts it', () => {
    expect(clockAfterCall({ since: null }, false, 10)).toEqual({ since: 10 })
    expect(clockAfterCall({ since: 10 }, false, 20)).toEqual({ since: 10 })
    expect(clockAfterCall({ since: 10 }, true, 20)).toEqual({ since: 20 })
  })
  test('due only once the clock is old enough, and it restarts', () => {
    expect(recordDue({ since: null }, 1e9).reminder).toBeNull()
    expect(recordDue({ since: 0 }, RECORD_AFTER_MS - 1).reminder).toBeNull()
    expect(recordDue({ since: 0 }, RECORD_AFTER_MS)).toEqual({ reminder: NO_RECENT_RECORD_REMINDER, clock: { since: RECORD_AFTER_MS } })
  })
  test('a handoff-like name or content', () => {
    for (const p of ['/x/.junk/handoff.md', 'C:\\x\\notes.txt', '/x/pending-writes.json', '/x/session-handoff.md', 'C:\\x\\hand-off.txt']) expect(looksLikeHandoff(p, '')).toBe(true)
    expect(looksLikeHandoff('/x/a.ts', 'this is the handoff for the next session')).toBe(true)
    expect(looksLikeHandoff('/x/a.ts', 'pending card writes: CP-15 note')).toBe(true)
  })
  test('no handoff: a name that only contains a keyword, or a directory that does, on either path style', () => {
    for (const p of ['/x/notes-app/a.ts', 'C:\\Users\\dev\\notes-app\\a.ts', 'C:\\x\\notes\\a.ts', 'C:\\x\\pending\\a.ts', 'C:\\x\\wip\\a.ts', '/x/wipe.ts', '/x/release-notes.md', '/x/pending-orders.ts', '/x/resume.tsx', '/x/continue.ts', '/x/wip.ts', '/x/pending.ts']) expect(looksLikeHandoff(p, 'const a = 1')).toBe(false)
    expect(looksLikeHandoff(undefined, 'handoff')).toBe(false)
    expect(looksLikeHandoff('/x/a.ts', 'const a = 1')).toBe(false)
  })
})

for (const surface of SURFACES) {
  describe(`the record reminders on ${surface}`, () => {
    async function started($: any, on: any) {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.SubagentStop', () => ({}) as any)
      on('turn.complete', () => ({ text: 'done' }) as any)
      on('tool.call', () => ({ result: {}, text: '{"ok":true,"status":200,"body":{}}' }) as any)
      const d = dashboard(on)
      await startSession($, d, surface)
      return d
    }
    const api = ($: any, method: string, path: string) => $.tool.call({ tool: API, method, path } as any)
    const endTurn = async ($: any) => {
      await $.turn.start({ turnId: 't1' } as any)
      await $.turn.complete(TURN)
    }
    const reminders = (d: any) => d.relay.told.filter((t: string) => t === NO_RECENT_RECORD_REMINDER)

    test('a sub-agent that stops carries the reminder', async ($, on) => {
      await started($, on)
      const r = await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'x' })
      expect(r.additionalContext).toContain(SUBAGENT_DONE_REMINDER)
    })

    test('a turn ending after the stretch with no record write is reminded once, then not until another stretch', async ($, on) => {
      const d = await started($, on)
      await api($, 'GET', '/api/issues/CP-15')
      await d.clock.advance(RECORD_AFTER_MS)
      await endTurn($)
      expect(reminders(d)).toHaveLength(1)
      await endTurn($)
      expect(reminders(d)).toHaveLength(1)
    })

    test('a turn ending before the stretch, or with no model dashboard call at all (the plugin reads never start it), is quiet', async ($, on) => {
      const d = await started($, on)
      await d.clock.advance(RECORD_AFTER_MS * 2)
      await endTurn($)
      await api($, 'GET', '/api/issues/CP-15')
      await d.clock.advance(RECORD_AFTER_MS - 1000)
      await endTurn($)
      expect(reminders(d)).toHaveLength(0)
    })

    for (const tool of ['plan_connect', 'card_connect']) {
      test(`${tool} starts the clock`, async ($, on) => {
        const d = await started($, on)
        await $.tool.call({ tool: `mcp__plugin_danxbot_danx-dashboard__${tool}` } as any)
        await d.clock.advance(RECORD_AFTER_MS)
        await endTurn($)
        expect(reminders(d)).toHaveLength(1)
      })
    }


    for (const path of ['/api/issues', '/api/plans']) {
      test(`a POST to ${path} refreshes the plan, a GET does not`, async ($, on) => {
        const d = await started($, on)
        const reads = () => d.api.filter((a: any) => a.method === 'GET').length
        await api($, 'GET', path)
        await d.clock.settle()
        const before = reads()
        await api($, 'POST', path)
        await d.clock.settle()
        expect(reads()).toBeGreaterThan(before)
      })
    }

    test('a sub-agent write does not restart the stretch', async ($, on) => {
      const d = await started($, on)
      await api($, 'GET', '/api/issues/CP-15')
      await d.clock.advance(RECORD_AFTER_MS - 1000)
      await $.tool.call({ tool: API, method: 'POST', path: '/api/issues/CP-15/notes', agentId: 'a1' } as any)
      await d.clock.advance(1000)
      await endTurn($)
      expect(reminders(d)).toHaveLength(1)
    })

    test('a write to a card restarts the stretch', async ($, on) => {
      const d = await started($, on)
      await api($, 'GET', '/api/issues/CP-15')
      await d.clock.advance(RECORD_AFTER_MS - 1000)
      await api($, 'POST', '/api/issues/CP-15/notes')
      await d.clock.advance(RECORD_AFTER_MS - 1000)
      await endTurn($)
      expect(reminders(d)).toHaveLength(0)
      await d.clock.advance(1000)
      await endTurn($)
      expect(reminders(d)).toHaveLength(1)
    })

    const write = ($: any, file_path: string, content = 'x') => $.tool.call({ tool: 'Write', file_path, content } as any)
    const contextOf = async (r: any) => (r.context ?? []) as string[]

    test('writing an untracked handoff-like file carries the reminder and is never denied', async ($, on) => {
      const d = await started($, on)
      d.world.processes['git'] = { exitCode: 1, stdout: '' }
      const r = await write($, '/repo/.junk/handoff.md')
      expect(r.deny).toBeUndefined()
      expect(await contextOf(r)).toContain(HANDOFF_FILE_REMINDER)
      expect(d.runCalls).toContainEqual(['git', '-C', '/repo/.junk/', 'ls-files', '--error-unmatch', '--', '/repo/.junk/handoff.md'])
    })

    test('a Windows path is split on its backslashes', async ($, on) => {
      const d = await started($, on)
      d.world.processes['git'] = { exitCode: 1, stdout: '' }
      expect(await contextOf(await write($, 'C:\\Users\\dev\\notes-app\\a.ts'))).not.toContain(HANDOFF_FILE_REMINDER)
      expect(await contextOf(await write($, 'C:\\Users\\dev\\.junk\\handoff.md'))).toContain(HANDOFF_FILE_REMINDER)
      expect(d.runCalls).toContainEqual(['git', '-C', 'C:\\Users\\dev\\.junk\\', 'ls-files', '--error-unmatch', '--', 'C:\\Users\\dev\\.junk\\handoff.md'])
    })

    test('a tracked file, and a file that is no handoff, carry none', async ($, on) => {
      const d = await started($, on)
      d.world.processes['git'] = { exitCode: 0, stdout: '' }
      expect(await contextOf(await write($, '/repo/docs/notes.md'))).not.toContain(HANDOFF_FILE_REMINDER)
      d.world.processes['git'] = { exitCode: 1, stdout: '' }
      expect(await contextOf(await write($, '/repo/src/a.ts', 'const a = 1'))).not.toContain(HANDOFF_FILE_REMINDER)
    })
  })
}
