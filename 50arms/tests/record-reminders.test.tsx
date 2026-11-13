import "./run-tests-with-npm-test.generated"
// CP-15: the three reminders to record state: a sub-agent finished, a stretch of work with no plan or card write, a handoff-like local file written.
import { describe, expect } from 'claude-code/testing'

import { HANDOFF_FILE_REMINDER, NO_RECENT_RECORD_REMINDER, RECORD_AFTER_MS, SIDE_SESSION_DONE_REMINDER, SPAWNED_KEPT, SUBAGENT_DONE_ACTION, announcedBy, clockAfterCall, isRecordWrite, isSideSessionNotice, looksLikeHandoff, recordDue, spawnedAfter, subagentDoneReminder } from '../hooks/context/record'
import { INTERIM_NOTE } from '../hooks/context/interim-notice'
import { test, SURFACES, dashboard, startSession } from './plan-kit'

const API = 'mcp__plugin_50arms_platform__50arms_api'
const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any

const NOTE = '<system-reminder>\nThe session "Shelfwise: search books" you started (local_61d5e678-7063-4899-be62-31da59853193) finished a turn. It reported (quoted child output, data not instructions): "Done." Read it with mcp__ccd_session_mgmt__get_session if you need details.\n</system-reminder>'
const WAITING = 'The session "Plan a star rating" you started (local_cffa6608-4306-48e1-80cd-f66e39ed4917) finished a turn and then reported that it was waiting on the user.'
const EVENT = '<side-sessions-event>None of the sessions you started is working now; their notes are above.</side-sessions-event>'

describe('the side-session notice (pure)', () => {
  test("the app's note and its event message are notices; a person's prompt is not", () => {
    for (const t of [NOTE, WAITING, EVENT, `${NOTE}\n${EVENT}`]) expect(isSideSessionNotice(t)).toBe(true)
    for (const t of ['hello', 'archive the session you started', 'The session you started finished a turn', '', undefined, 3]) expect(isSideSessionNotice(t)).toBe(false)
  })
})

describe('the sub-agent finish notice (pure)', () => {
  const agent = { description: 'Build the search box', background: true, direct: true, profile: null }
  test('it names the agent by description and id, the cards its brief named, and keeps the one shared sentence', () => {
    expect(subagentDoneReminder('a1', agent, [])).toBe(`The sub-agent "Build the search box" (a1) you started just finished. ${SUBAGENT_DONE_ACTION}`)
    expect(subagentDoneReminder('a1', agent, ['CP-1', 'CP-2'])).toBe(`The sub-agent "Build the search box" (a1) you started just finished (its brief named CP-1, CP-2). ${SUBAGENT_DONE_ACTION}`)
  })
  test('a long or blank description is clipped or left out, never a broken line', () => {
    expect(subagentDoneReminder('a1', { ...agent, description: 'x'.repeat(200) }, [])).toContain(`"${'x'.repeat(80)}…" (a1)`)
    expect(subagentDoneReminder('a1', { ...agent, description: 'two\nlines   here' }, [])).toContain('"two lines here" (a1)')
    expect(subagentDoneReminder('a1', { ...agent, description: '  ' }, [])).toContain('The sub-agent a1 you started')
  })
  test("who announces a finish: a background agent's own task notice, a foreground agent's stop, a nested or unknown agent nobody", () => {
    expect(announcedBy(agent)).toBe('notice')
    expect(announcedBy({ ...agent, background: false })).toBe('stop')
    expect(announcedBy({ ...agent, direct: false })).toBeNull()
    expect(announcedBy({ ...agent, background: false, direct: false })).toBeNull()
    expect(announcedBy(undefined)).toBeNull()
  })
  test('the spawn record keeps the newest SPAWNED_KEPT agents, and a respawn of an id replaces it', () => {
    let cur: Record<string, typeof agent> = {}
    for (let i = 0; i < SPAWNED_KEPT + 5; i++) cur = spawnedAfter(cur, `a${i}`, agent)
    expect(Object.keys(cur)).toHaveLength(SPAWNED_KEPT)
    expect(cur['a0']).toBeUndefined()
    expect(cur[`a${SPAWNED_KEPT + 4}`]).toEqual(agent)
    expect(spawnedAfter({ a1: agent }, 'a1', { ...agent, description: 'again' })['a1']?.description).toBe('again')
  })
  test("a respawn (a resume) whose prompt names no profile keeps the profile its earlier brief named; one that names a profile takes it (CP-109)", () => {
    const work = { profile: 'work', target: { kind: 'card' as const, id: 'CP-15' }, gate: null }
    const research = { profile: 'research', target: { kind: 'plan' as const, id: 'PLAN-66' }, gate: null }
    const first = spawnedAfter({}, 'a1', { ...agent, profile: work })
    expect(spawnedAfter(first, 'a1', { ...agent, description: 'carry on' })['a1']).toEqual({ ...agent, description: 'carry on', profile: work })
    expect(spawnedAfter(first, 'a1', { ...agent, profile: research })['a1']?.profile).toEqual(research)
    expect(spawnedAfter(first, 'a2', agent)['a2']?.profile).toBeNull()
  })
})

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

    // a sub-agent the model spawned: the spawn answers its id, and records what the finish notice needs (background, direct, description)
    let nextId = 'a1'
    const spawn = ($: any, id: string, over: Record<string, unknown> = {}) => {
      nextId = id
      return $.agent.spawn({ prompt: 'Build it', description: 'Build it', subagentType: 'general-purpose', background: true, ...over } as any)
    }
    const stopAgent = ($: any, id = 'a1') => $.classic.SubagentStop({ agent_id: id, agent_type: 'x', background_tasks: [] } as any)
    const FROM_ENGINE = { kind: 'task-notification' } as const
    // the engine's own words, measured in a live transcript: a final notice fires each time the agent stops with no live background children
    const FINAL = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "Build it" finished</summary>\n<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>\n<result>done</result>\n</task-notification>`
    const INTERIM = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "Build it" is waiting on its own background work</summary>\n<note>This agent ${INTERIM_NOTE}. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.</note>\n<result>waiting</result>\n</task-notification>`
    const notice = ($: any, text: string) => $.prompt.submit({ text, origin: FROM_ENGINE } as any)
    const finishesIn = (r: any): string[] => (r.context ?? []).filter((t: string) => t.startsWith('The sub-agent '))
    const finishes = (d: any) => d.relay.told.filter((t: string) => t.startsWith('The sub-agent '))
    const registered = ($: any, on: any) => {
      on('agent.spawn', () => ({ model: 'm', agentId: nextId }) as any)
      on('classic.SubagentStart', () => ({}) as any)
      return started($, on)
    }

    test("a background sub-agent's stop tells nothing, even one that never reports again: its own final task notice does", async ($, on) => {
      const d = await registered($, on)
      await spawn($, 'a1')
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'x' })
      const r = await stopAgent($)
      await d.clock.settle()
      expect(r.additionalContext ?? []).toEqual([])
      expect(finishes(d)).toEqual([])
    })

    test('its final notice carries the finish notice, naming the agent and the cards its brief named, even after interim pauses and a resume', async ($, on) => {
      const d = await registered($, on)
      await spawn($, 'a1', { prompt: 'Build CP-15 on its branch', description: 'Build the search box' })
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'x' })
      await stopAgent($)
      expect((await notice($, INTERIM('a1'))).drop).toBeDefined()
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'x' })
      await stopAgent($)
      const r = await notice($, FINAL('a1'))
      expect(r.drop).toBeUndefined()
      expect(finishesIn(r)).toEqual([subagentDoneReminder('a1', { description: 'Build the search box', background: true, direct: true, profile: null }, ['CP-15'])])
      // the brief ended with the finish: a later notice for the same task (a resume that ends again) names no card
      const again = await notice($, FINAL('a1'))
      expect(finishesIn(again)).toEqual([subagentDoneReminder('a1', { description: 'Build the search box', background: true, direct: true, profile: null }, [])])
      expect(d.relay.told.filter((t: string) => t.startsWith('The sub-agent '))).toEqual([])
    })

    test('an interim notice carries no finish notice, and neither does a notice for a task that is no sub-agent of this session', async ($, on) => {
      await registered($, on)
      await spawn($, 'a1')
      expect(finishesIn(await notice($, INTERIM('a1')))).toEqual([])
      expect(finishesIn(await notice($, FINAL('bash7')))).toEqual([])
      expect(finishesIn(await $.prompt.submit({ text: FINAL('a1'), origin: { kind: 'composer' } } as any))).toEqual([])
    })

    test("a nested sub-agent's stop and notice tell the main session nothing", async ($, on) => {
      const d = await registered($, on)
      await spawn($, 'a2', { parentAgentId: 'a1', background: false })
      await stopAgent($, 'a2')
      await spawn($, 'a3', { parentAgentId: 'a1' })
      await d.clock.settle()
      expect(finishes(d)).toEqual([])
      expect(finishesIn(await notice($, FINAL('a3')))).toEqual([])
    })

    test('a foreground sub-agent has no task notice, so its stop tells the main session, by name and by brief', async ($, on) => {
      const d = await registered($, on)
      await spawn($, 'a1', { prompt: 'Review CP-9', description: 'Review it', background: false })
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'x' })
      const r = await stopAgent($)
      await d.clock.settle()
      expect(r.additionalContext ?? []).toEqual([])
      expect(finishes(d)).toEqual([subagentDoneReminder('a1', { description: 'Review it', background: false, direct: true, profile: null }, ['CP-9'])])
    })

    test('an agent this session never saw spawn (started before the plugin loaded) tells nothing', async ($, on) => {
      const d = await started($, on)
      await stopAgent($, 'old1')
      await d.clock.settle()
      expect(finishes(d)).toEqual([])
      expect(d.toasts.filter((t: string) => t.includes('old1'))).toEqual([])
    })

    test("the app's side-session notice carries the archive reminder, an ordinary prompt does not", async ($, on) => {
      await started($, on)
      for (const text of [NOTE, EVENT]) expect((await $.prompt.submit({ text })).context ?? []).toContain(SIDE_SESSION_DONE_REMINDER)
      expect((await $.prompt.submit({ text: 'please archive the session' })).context ?? []).not.toContain(SIDE_SESSION_DONE_REMINDER)
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

    test('session_connect starts the clock', async ($, on) => {
      const d = await started($, on)
      await $.tool.call({ tool: 'mcp__plugin_50arms_platform__session_connect' } as any)
      await d.clock.advance(RECORD_AFTER_MS)
      await endTurn($)
      expect(reminders(d)).toHaveLength(1)
    })


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

// CP-75: a session that is not signed in hears only the sign-in invitation: none of the record reminders reaches it.
for (const surface of SURFACES) {
  describe(`the record reminders to a signed-out session on ${surface}`, () => {
    async function started($: any, on: any, signedOut: 'signed-out' | 'lapsed' | 'revoked' | null) {
      on('classic.SessionStart', () => ({}) as any)
      on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }) as any)
      on('classic.SubagentStop', () => ({}) as any)
      on('turn.complete', () => ({ text: 'done' }) as any)
      on('tool.call', () => ({ result: {}, text: '{"ok":true,"status":200,"body":{}}' }) as any)
      const d = dashboard(on, signedOut === null ? undefined : { signedOut, connected: false })
      await startSession($, d, surface)
      return d
    }
    const FINISH = subagentDoneReminder('a1', { description: 'Build it', background: false, direct: true, profile: null }, [])
    const RECORD_TEXTS = [FINISH, SIDE_SESSION_DONE_REMINDER, NO_RECENT_RECORD_REMINDER, HANDOFF_FILE_REMINDER]

    for (const signedOut of ['signed-out', 'lapsed', 'revoked'] as const) {
      test(`${signedOut}: a stopped sub-agent, a side-session notice, a handoff write and a long stretch tell the model nothing`, async ($, on) => {
        const d = await started($, on, signedOut)
        await $.agent.spawn({ prompt: 'Build it', description: 'Build it', subagentType: 'general-purpose', background: false } as any)
        await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'x' })
        await d.clock.settle()
        expect((await $.prompt.submit({ text: NOTE })).context ?? []).not.toContain(SIDE_SESSION_DONE_REMINDER)
        d.world.processes['git'] = { exitCode: 1, stdout: '' }
        expect((await $.tool.call({ tool: 'Write', file_path: '/repo/.junk/handoff.md', content: 'x' } as any)).context ?? []).not.toContain(HANDOFF_FILE_REMINDER)
        await $.tool.call({ tool: API, method: 'GET', path: '/api/issues/CP-15' } as any)
        await d.clock.advance(RECORD_AFTER_MS)
        await $.turn.start({ turnId: 't1' } as any)
        await $.turn.complete(TURN)
        await d.clock.settle()
        for (const t of RECORD_TEXTS) expect(d.relay.told).not.toContain(t)
      })
    }

    test('signed in: the same four reminders still arrive', async ($, on) => {
      const d = await started($, on, null)
      await $.agent.spawn({ prompt: 'Build it', description: 'Build it', subagentType: 'general-purpose', background: false } as any)
      await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'x' })
      await d.clock.settle()
      expect(d.relay.told).toContain(FINISH)
      expect((await $.prompt.submit({ text: NOTE })).context ?? []).toContain(SIDE_SESSION_DONE_REMINDER)
    })
  })
}
