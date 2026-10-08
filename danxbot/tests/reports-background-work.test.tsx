// DX-4235: the background-work report, as function hooks. A plan-connected session puts the count of its running background work
// (PUT /api/plan-sessions/me/background-work) at every Stop and SubagentStop, from the engine's own `background_tasks` list, so the
// dashboard's idle nudge stays quiet while that work runs; it clears the count when no list can be trusted (a session start, a main-session
// failure). Checked as the engine runs the hooks, on both surfaces.
import { describe, expect, test } from 'claude-code/testing'

import { countRunning, heartbeatCount } from '../hooks/reports/background-work'
import { OWN_SESSION, SURFACES, answerReportEvents, countReports, dashboard, startSession } from './plan-kit'

const task = (id: string, type: string, status = 'running') => ({ id, type, status, description: id })
// one of each kind the engine lists: three that count, a watcher that does not, and a finished shell
const TASKS = [task('s1', 'shell'), task('a1', 'subagent'), task('w1', 'workflow'), task('m1', 'monitor'), task('s2', 'shell', 'completed')]
const SUBAGENT_STOP = { agent_id: 'a1', stop_hook_active: false, agent_transcript_path: '/x/agent-a1.jsonl', agent_type: 'Explore' }

describe('the count (pure)', () => {
  test('counts the running shell, subagent and workflow entries; a watcher and a finished entry do not count', () => {
    expect(countRunning(TASKS)).toBe(3)
    expect(countRunning([])).toBe(0)
  })

  test('a stopping sub-agent is left out of its own count', () => {
    expect(countRunning(TASKS, 'a1')).toBe(2)
  })

  test('a heartbeat re-sends the count on record, at least 1', () => {
    expect(heartbeatCount(null)).toBe(1)
    expect(heartbeatCount(0)).toBe(1)
    expect(heartbeatCount(4)).toBe(4)
  })
})

for (const surface of SURFACES) {
  describe(`the count at a stop on ${surface}`, () => {
    test("Stop and SubagentStop put the snapshot's count (the stopping sub-agent left out), timed by the hook", async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await d.clock.advance(4_000)
      const stopAt = d.clock.now()
      await $.classic.Stop({ stop_hook_active: true, background_tasks: TASKS } as any)
      await d.clock.settle()
      await d.clock.advance(2_000)
      const subStopAt = d.clock.now()
      await $.classic.SubagentStop({ ...SUBAGENT_STOP, background_tasks: TASKS } as any)
      await d.clock.settle()
      expect(countReports(d)).toEqual([
        { count: 3, eventAt: new Date(stopAt).toISOString() },
        { count: 2, eventAt: new Date(subStopAt).toISOString() },
      ])
    })

    test('a stop that carries no background_tasks list is one toast and no count', async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.classic.Stop({ stop_hook_active: true } as any)
      await d.clock.settle()
      expect(countReports(d)).toEqual([])
      expect(d.toasts.filter(t => t.startsWith('danxbot background-work report failed'))).toHaveLength(1)
    })
  })

  describe(`the clear on ${surface}`, () => {
    test('a session start clears the count at the first bound event after it, never from classic.SessionStart itself', async ($, on) => {
      answerReportEvents(on)
      on('classic.SessionStart', () => ({}) as any)
      const d = dashboard(on)
      await startSession($, d, surface)
      // classic.SessionStart runs before the engine binds the session: it calls nothing
      d.unbind()
      await $.classic.SessionStart({ source: 'resume', cwd: '/work', session_id: OWN_SESSION.session_id, transcript_path: '/work/main.jsonl' })
      expect(d.unboundCalls).toEqual([])
      d.bind()
      await d.clock.advance(1_000)
      const at = d.clock.now()
      await $.prompt.submit({ text: 'hello' })
      await d.clock.settle()
      expect(countReports(d)).toEqual([{ count: null, eventAt: new Date(at).toISOString() }])
      // told once: the next prompt clears nothing
      await $.prompt.submit({ text: 'again' })
      await d.clock.settle()
      expect(countReports(d)).toHaveLength(1)
    })

    test("the first main-loop tool result takes the start too, and clears", async ($, on) => {
      answerReportEvents(on)
      on('classic.SessionStart', () => ({}) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.classic.SessionStart({ source: 'compact', cwd: '/work', session_id: OWN_SESSION.session_id })
      await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
      await d.clock.settle()
      expect(countReports(d).map(r => r.count)).toEqual([null])
    })

    test("a main-session StopFailure clears the count; a sub-agent's (agent_id set) sends nothing", async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.classic.StopFailure({ agent_id: 'a1', error: 'server_error' } as any)
      await d.clock.settle()
      expect(countReports(d)).toEqual([])
      const at = d.clock.now()
      await $.classic.StopFailure({ error: 'server_error' } as any)
      await d.clock.settle()
      expect(countReports(d)).toEqual([{ count: null, eventAt: new Date(at).toISOString() }])
    })
  })

  describe(`silence and failures on ${surface}`, () => {
    test('a session not on a plan sends no count at a stop, a sub-agent stop, a failure or after a start, and its prompts still carry the time stamp', async ($, on) => {
      answerReportEvents(on)
      on('classic.SessionStart', () => ({}) as any)
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      await $.classic.SessionStart({ source: 'startup', cwd: '/work', session_id: OWN_SESSION.session_id })
      const prompt = await $.prompt.submit({ text: 'hello' })
      await $.classic.Stop({ stop_hook_active: false, background_tasks: TASKS } as any)
      await $.classic.SubagentStop({ ...SUBAGENT_STOP, background_tasks: TASKS } as any)
      await $.classic.StopFailure({ error: 'server_error' } as any)
      await d.clock.settle()
      expect(d.reports).toEqual([])
      expect(prompt.context).toHaveLength(1)
    })

    test('a count the dashboard refuses is one toast per failed report, never swallowed', async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      d.world.reportReplies['PUT /api/plan-sessions/me/background-work'] = { status: 500, body: { error: 'count boom' } }
      await $.classic.SubagentStop({ ...SUBAGENT_STOP, background_tasks: TASKS } as any)
      await d.clock.settle()
      expect(d.toasts.filter(t => t.startsWith('danxbot background-work report failed'))).toEqual(['danxbot background-work report failed: 500: count boom'])
    })
  })
}
