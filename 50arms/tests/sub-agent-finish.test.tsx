import "./run-tests-with-npm-test.generated"
// CP-15 / CP-52: which sub-agent finishes reach the main session (a background agent's final task notice, a foreground agent's stop, never a nested or unknown agent), how each is named,
// and that the wording is 50 Arms' `sub_agent_stop` text.
import { describe, expect } from 'claude-code/testing'

import { SPAWNED_KEPT, announcedBy, finishedAgentLabel, finishedAgentsText, spawnedAfter } from '../hooks/context/record'
import { INTERIM_NOTE } from '../hooks/context/interim-notice'
import { test, SURFACES, EVENT_TEXT, dashboard, startSession } from './plan-kit'

describe('the sub-agent finish notice (pure)', () => {
  const agent = { description: 'Build the search box', background: true, direct: true }
  test('it names the agent by description and id and by the cards its brief named, then carries the registry text as it is', () => {
    expect(finishedAgentLabel('a1', agent, [])).toBe('"Build the search box" (a1)')
    expect(finishedAgentLabel('a1', agent, ['CP-1', 'CP-2'])).toBe('"Build the search box" (a1) (its brief named CP-1, CP-2)')
    expect(finishedAgentsText(['x (a1)', 'y (a2)'], 'THE TEXT')).toBe('Finished: x (a1); y (a2). THE TEXT')
  })
  test('a long or blank description is clipped or left out, never a broken line', () => {
    expect(finishedAgentLabel('a1', { ...agent, description: 'x'.repeat(200) }, [])).toBe(`"${'x'.repeat(80)}…" (a1)`)
    expect(finishedAgentLabel('a1', { ...agent, description: 'two\nlines   here' }, [])).toBe('"two lines here" (a1)')
    expect(finishedAgentLabel('a1', { ...agent, description: '  ' }, [])).toBe('a1')
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
})

for (const surface of SURFACES) {
  describe(`the sub-agent finish on ${surface}`, () => {
    let nextId = 'a1'
    async function started($: any, on: any, signedOut?: 'signed-out' | 'lapsed' | 'revoked') {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.SubagentStop', () => ({}) as any)
      on('classic.SubagentStart', () => ({}) as any)
      on('agent.spawn', () => ({ model: 'm', agentId: nextId }) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      const d = dashboard(on, signedOut === undefined ? undefined : { signedOut, connected: false })
      await startSession($, d, surface)
      return d
    }
    const STOP_TEXT = EVENT_TEXT('sub_agent_stop')
    const spawn = ($: any, id: string, over: Record<string, unknown> = {}) => {
      nextId = id
      return $.agent.spawn({ prompt: 'Build it', description: 'Build it', subagentType: 'general-purpose', background: true, ...over } as any)
    }
    const startAgent = ($: any, id = 'a1') => $.classic.SubagentStart({ agent_id: id, agent_type: 'x' })
    const stopAgent = ($: any, id = 'a1') => $.classic.SubagentStop({ agent_id: id, agent_type: 'x', background_tasks: [] } as any)
    const FROM_ENGINE = { kind: 'task-notification' } as const
    // the engine's own words, measured in a live transcript: a final notice fires each time the agent stops with no live background children
    const FINAL = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "Build it" finished</summary>\n<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>\n<result>done</result>\n</task-notification>`
    const INTERIM = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "Build it" is waiting on its own background work</summary>\n<note>This agent ${INTERIM_NOTE}. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.</note>\n<result>waiting</result>\n</task-notification>`
    const notice = ($: any, text: string) => $.prompt.submit({ text, origin: FROM_ENGINE } as any)
    const finishesIn = (r: any): string[] => (r.context ?? []).filter((t: string) => t.startsWith('Finished: '))
    const tool = ($: any) => $.tool.call({ tool: 'Bash', command: 'ls' } as any)
    const toldFor = (label: string) => finishedAgentsText([label], STOP_TEXT)

    test("a background sub-agent's stop tells nothing, even one that never reports again: its own final task notice does", async ($, on) => {
      const d = await started($, on)
      await spawn($, 'a1')
      await startAgent($)
      const r = await stopAgent($)
      await d.clock.settle()
      expect(r.additionalContext ?? []).toEqual([])
      expect(finishesIn(await tool($))).toEqual([])
      expect(finishesIn(await $.prompt.submit({ text: 'next' }))).toEqual([])
    })

    test('its final notice carries the finish, naming the agent and the cards its brief named, even after interim pauses and a resume', async ($, on) => {
      await started($, on)
      await spawn($, 'a1', { prompt: 'Build CP-15 on its branch', description: 'Build the search box' })
      await startAgent($)
      await stopAgent($)
      expect((await notice($, INTERIM('a1'))).drop).toBeDefined()
      await startAgent($)
      await stopAgent($)
      const r = await notice($, FINAL('a1'))
      expect(r.drop).toBeUndefined()
      expect(finishesIn(r)).toEqual([toldFor('"Build the search box" (a1) (its brief named CP-15)')])
      // the brief ended with the finish: a later notice for the same task (a resume that ends again) names no card
      expect(finishesIn(await notice($, FINAL('a1')))).toEqual([toldFor('"Build the search box" (a1)')])
    })

    test('an interim notice carries no finish, and neither does a notice for a task that is no sub-agent of this session', async ($, on) => {
      await started($, on)
      await spawn($, 'a1')
      expect(finishesIn(await notice($, INTERIM('a1')))).toEqual([])
      expect(finishesIn(await notice($, FINAL('bash7')))).toEqual([])
      expect(finishesIn(await $.prompt.submit({ text: FINAL('a1'), origin: { kind: 'composer' } } as any))).toEqual([])
    })

    test("a nested sub-agent's stop and notice tell the main session nothing", async ($, on) => {
      const d = await started($, on)
      await spawn($, 'a2', { parentAgentId: 'a1', background: false })
      await stopAgent($, 'a2')
      await spawn($, 'a3', { parentAgentId: 'a1' })
      await d.clock.settle()
      expect(finishesIn(await tool($))).toEqual([])
      expect(finishesIn(await notice($, FINAL('a3')))).toEqual([])
    })

    test('a foreground sub-agent has no task notice, so its stop is owed to the main session, by name and by brief, and rides its next action', async ($, on) => {
      const d = await started($, on)
      await spawn($, 'a1', { prompt: 'Review CP-9', description: 'Review it', background: false })
      await startAgent($)
      const r = await stopAgent($)
      await d.clock.settle()
      expect(r.additionalContext ?? []).toEqual([])
      expect(d.relay.told).toEqual([])
      expect(finishesIn(await tool($))).toEqual([toldFor('"Review it" (a1) (its brief named CP-9)')])
      expect(finishesIn(await tool($))).toEqual([])
    })

    test("a final notice and an owed foreground finish share one text, the registry's read once", async ($, on) => {
      const d = await started($, on)
      await spawn($, 'a1', { description: 'Review it', background: false })
      await startAgent($)
      await stopAgent($)
      await spawn($, 'a2', { description: 'Build it' })
      await d.clock.settle()
      const r = await notice($, FINAL('a2'))
      expect(finishesIn(r)).toEqual([finishedAgentsText(['"Review it" (a1)', '"Build it" (a2)'], STOP_TEXT)])
      expect(d.contextReads.filter((p: string) => p === '/api/reminders/event/sub_agent_stop')).toHaveLength(1)
    })

    test('an agent this session never saw spawn (started before the plugin loaded) tells nothing', async ($, on) => {
      const d = await started($, on)
      await stopAgent($, 'old1')
      await d.clock.settle()
      expect(finishesIn(await tool($))).toEqual([])
    })

    for (const signedOut of ['signed-out', 'lapsed', 'revoked'] as const) {
      test(`${signedOut}: a finished sub-agent tells the model nothing`, async ($, on) => {
        const d = await started($, on, signedOut)
        await spawn($, 'a1', { background: false })
        await stopAgent($)
        await d.clock.settle()
        expect(finishesIn(await tool($))).toEqual([])
      })

      test(`${signedOut}: a background agent's final notice tells the model nothing and reads no event text`, async ($, on) => {
        const d = await started($, on, signedOut)
        await spawn($, 'a1')
        await startAgent($)
        await stopAgent($)
        expect(finishesIn(await notice($, FINAL('a1')))).toEqual([])
        await d.clock.settle()
        expect(d.contextReads.filter((p: string) => p === '/api/reminders/event/side_session_turn_end' || p === '/api/reminders/event/sub_agent_stop')).toEqual([])
      })
    }
  })
}
