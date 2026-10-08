// DX-4235: the activity report, as function hooks. A plan-connected session tells the dashboard (POST /api/plan-sessions/me/activity)
// when a sub-agent starts and ends and when a background shell starts and ends, so its running count opens and closes with them; a
// working sub-agent re-posts its row so it never reads as silent (comment 10017). Checked as the engine runs the hooks, on both surfaces.
import { describe, expect, test } from 'claude-code/testing'

import { LIVENESS_MS, agentRow, endedShells, shellRow, subagentActivityId } from '../hooks/reports/activity'
import { SURFACES, activityRows, answerReportEvents, countReports, dashboard, finishes, forceRefresh, startSession } from './plan-kit'

const START = { agent_id: 'a1b2c3', agent_type: 'danxbot:worker-sonnet-high' }
const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
// the engine's result of a Bash call it moved to the background: the id it lists the shell under in `background_tasks`
const BACKGROUNDED = { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bjlibh54w' }, text: 'Command running in background with ID: bjlibh54w' }
const shell = (id: string, status = 'running') => ({ id, type: 'shell', status, description: 'sleep' })

describe('the activity rows (pure)', () => {
  test("a sub-agent's key is agent-<id>, whichever way the id arrives", () => {
    expect(subagentActivityId('abc')).toBe('agent-abc')
    expect(subagentActivityId('agent-abc')).toBe('agent-abc')
  })

  test('a row carries every field the stats wire requires, the transcript-only facts unknown', () => {
    expect(agentRow('agent-abc', 'Explore', 5, null)).toEqual({
      kind: 'agent',
      activityId: 'agent-abc',
      agentType: 'Explore',
      description: null,
      startedAt: 5,
      lastActivityAt: 5,
      finishedAt: null,
      parentActivityId: null,
      effort: null,
      currentActivity: null,
      endStatus: null,
      briefIssueId: null,
    })
    expect(shellRow('b1', 7, 7)).toMatchObject({ kind: 'bash', activityId: 'b1', agentType: null, startedAt: 7, lastActivityAt: 7, finishedAt: 7 })
  })

  test('a shell has ended when the snapshot no longer lists it running', () => {
    expect(endedShells(['b1', 'b2', 'b3'], [shell('b1'), shell('b2', 'completed')])).toEqual(['b2', 'b3'])
  })
})

for (const surface of SURFACES) {
  describe(`the sub-agent rows on ${surface}`, () => {
    test('a sub-agent start posts one running agent-<id> row, timed by the hook', async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await d.clock.advance(3_000)
      const now = d.clock.now()
      await $.classic.SubagentStart(START)
      await d.clock.settle()
      expect(activityRows(d)).toEqual([agentRow('agent-a1b2c3', 'danxbot:worker-sonnet-high', now, null)])
    })

    test("its turn's end posts its finish, for a clean stop and for a failed sub-agent (no SubagentStop, no clear)", async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.classic.SubagentStart(START)
      await $.classic.SubagentStart({ ...START, agent_id: 'f00' })
      await d.clock.advance(5_000)
      const now = d.clock.now()
      await $.turn.complete({ ...TURN, agentId: 'a1b2c3' })
      // the failed one: its turn ends on an error, and the engine raises StopFailure for it instead of SubagentStop
      await $.turn.complete({ ...TURN, reason: 'error', agentId: 'f00' })
      await $.classic.StopFailure({ agent_id: 'f00', error: 'server_error' } as any)
      await d.clock.settle()
      expect(finishes(d)).toEqual([agentRow('agent-a1b2c3', null, now, now), agentRow('agent-f00', null, now, now)])
      expect(countReports(d)).toEqual([])
    })

    test("a resumed sub-agent opens again and its next turn finishes it again; a turn with no start since its finish owes nothing", async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.classic.SubagentStart(START)
      await $.turn.complete({ ...TURN, agentId: 'a1b2c3' })
      await $.classic.SubagentStart(START)
      await $.turn.complete({ ...TURN, agentId: 'a1b2c3' })
      await $.turn.complete({ ...TURN, agentId: 'a1b2c3' })
      await d.clock.settle()
      expect(activityRows(d).map(r => r.finishedAt === null)).toEqual([true, false, true, false])
    })

    test("the main loop's turn and a turn of an agent this session never started (an engine fork) post nothing", async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.turn.complete(TURN)
      await $.turn.complete({ ...TURN, agentId: 'fork-1' })
      await d.clock.settle()
      expect(d.reports).toEqual([])
    })
  })

  describe(`the background shell rows on ${surface}`, () => {
    test('a call whose result names a background task posts one running bash row keyed by it; a foreground call posts nothing', async ($, on) => {
      let answer: any = BACKGROUNDED
      on('tool.call', () => answer)
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      const now = d.clock.now()
      const r = await $.tool.call({ tool: 'Bash', command: 'sleep 99', run_in_background: true } as any)
      expect(r.text).toBe(BACKGROUNDED.text)
      answer = { result: { stdout: 'hi', stderr: '', interrupted: false }, text: 'hi' }
      await $.tool.call({ tool: 'Bash', command: 'echo hi' } as any)
      await d.clock.settle()
      expect(activityRows(d)).toEqual([shellRow('bjlibh54w', now, null)])
    })

    test('a Stop or SubagentStop whose snapshot no longer lists a shell running finishes it; one still running stays open until a later Stop', async ($, on) => {
      let answer: any = BACKGROUNDED
      on('tool.call', () => answer)
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.tool.call({ tool: 'Bash', command: 'sleep 99', run_in_background: true } as any)
      answer = { ...BACKGROUNDED, result: { ...BACKGROUNDED.result, backgroundTaskId: 'b2' } }
      await $.tool.call({ tool: 'Bash', command: 'sleep 5', run_in_background: true } as any)
      await d.clock.settle()
      await d.clock.advance(10_000)
      const first = d.clock.now()
      // b2 is gone, bjlibh54w still runs
      await $.classic.SubagentStop({ agent_id: 'a9', stop_hook_active: false, agent_transcript_path: '/x/agent-a9.jsonl', agent_type: 'Explore', background_tasks: [shell('bjlibh54w'), { id: 'a9', type: 'subagent', status: 'running', description: 'x' }] } as any)
      await d.clock.settle()
      expect(activityRows(d).filter(r => r.finishedAt !== null)).toEqual([shellRow('b2', first, first)])
      await d.clock.advance(10_000)
      const second = d.clock.now()
      await $.classic.Stop({ stop_hook_active: true, background_tasks: [] } as any)
      await d.clock.settle()
      expect(activityRows(d).filter(r => r.finishedAt !== null)).toEqual([shellRow('b2', first, first), shellRow('bjlibh54w', second, second)])
      // closed once: a further Stop has nothing left to finish
      await $.classic.Stop({ stop_hook_active: true, background_tasks: [] } as any)
      await d.clock.settle()
      expect(activityRows(d).filter(r => r.finishedAt !== null)).toHaveLength(2)
    })
  })

  describe(`a working sub-agent's liveness on ${surface} (comment 10017)`, () => {
    test('its own tool calls re-post its row at most once a minute, each with a fresh lastActivityAt and the count (at least 1)', async ($, on) => {
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.classic.SubagentStart(START)
      await d.clock.settle()
      const posts = () => activityRows(d).filter(r => r.finishedAt === null && r.kind === 'agent')
      // 10 s after the start: not yet due
      await d.clock.advance(10_000)
      await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1b2c3' } as any)
      await d.clock.settle()
      expect(posts()).toHaveLength(1)
      // a minute and a second after the start: due
      await d.clock.advance(51_000)
      const beat = d.clock.now()
      await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1b2c3' } as any)
      await d.clock.settle()
      expect(posts()).toEqual([expect.anything(), agentRow('agent-a1b2c3', null, beat, null)])
      expect(countReports(d)).toEqual([{ count: 1, eventAt: new Date(beat).toISOString() }])
      // two calls 10 s apart after that: one post; 61 s apart: two
      await d.clock.advance(10_000)
      await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1b2c3' } as any)
      await d.clock.advance(LIVENESS_MS - 10_000 + 1_000)
      await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1b2c3' } as any)
      await d.clock.settle()
      expect(posts()).toHaveLength(3)
    })

    test('a sub-agent whose turn ended, or one this session never started, makes no liveness post', async ($, on) => {
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.classic.SubagentStart(START)
      await $.turn.complete({ ...TURN, agentId: 'a1b2c3' })
      await d.clock.advance(2 * LIVENESS_MS)
      await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1b2c3' } as any)
      await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'stranger' } as any)
      await d.clock.settle()
      expect(activityRows(d).filter(r => r.finishedAt === null)).toHaveLength(1)
      expect(countReports(d)).toEqual([])
    })
  })

  describe(`silence and failures on ${surface}`, () => {
    test('a session not on a plan makes no report call on any activity event, and its tool results still carry the time stamp', async ($, on) => {
      on('tool.call', () => BACKGROUNDED as any)
      answerReportEvents(on)
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      await $.classic.SubagentStart(START)
      const r = await $.tool.call({ tool: 'Bash', command: 'sleep 9', run_in_background: true, agentId: 'a1b2c3' } as any)
      await d.clock.advance(2 * LIVENESS_MS)
      await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1b2c3' } as any)
      await $.turn.complete({ ...TURN, agentId: 'a1b2c3' })
      await $.classic.SubagentStop({ agent_id: 'a1b2c3', stop_hook_active: false, agent_transcript_path: '/x/agent-a1b2c3.jsonl', agent_type: 'Explore', background_tasks: [] } as any)
      await d.clock.settle()
      expect(d.reports).toEqual([])
      expect(r.context).toHaveLength(1)
    })

    test('a report the dashboard refuses, or one the engine cannot send, is one toast each, never swallowed', async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      d.world.reportReplies['POST /api/plan-sessions/me/activity'] = { status: 500, body: { error: 'activity boom' } }
      await $.classic.SubagentStart(START)
      await d.clock.settle()
      d.world.reportReplies['POST /api/plan-sessions/me/activity'] = { deny: 'request timed out after 60000ms' }
      await $.classic.SubagentStart({ ...START, agent_id: 'second' })
      await d.clock.settle()
      expect(d.toasts.filter(t => t.startsWith('danxbot activity report failed'))).toEqual([
        'danxbot activity report failed: 500: activity boom',
        'danxbot activity report failed: mcp: danxbot: $.mcp.call: request timed out after 60000ms',
      ])
    })

    test('a refusal toasts too: the dashboard has the session on no plan, any other 409, a lapsed key', async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      d.world.reportReplies['POST /api/plan-sessions/me/activity'] = { status: 409, body: { error: 'session_not_connected' } }
      await $.classic.SubagentStart(START)
      await d.clock.settle()
      d.world.reportReplies['POST /api/plan-sessions/me/activity'] = { status: 409, body: { error: 'something_else' } }
      await $.classic.SubagentStart({ ...START, agent_id: 'second' })
      await d.clock.settle()
      d.world.reportReplies['POST /api/plan-sessions/me/activity'] = {}
      d.world.signedOut = 'lapsed'
      await $.classic.SubagentStart({ ...START, agent_id: 'third' })
      await d.clock.settle()
      const failed = d.toasts.filter(t => t.startsWith('danxbot activity report failed'))
      expect(failed).toHaveLength(3)
      expect(failed[0]).toContain('409: session_not_connected')
      expect(failed[1]).toContain('409: something_else')
      expect(failed[2]).toContain('no longer accepts this session')
    })
  })

  describe(`what the reports need of the plan state on ${surface}`, () => {
    test("a close owed while a plan refresh has failed (the view holds no plan for a moment) still goes out: a sub-agent's finish and a shell's end", async ($, on) => {
      on('tool.call', () => BACKGROUNDED as any)
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.classic.SubagentStart(START)
      await $.tool.call({ tool: 'Bash', command: 'sleep 9', run_in_background: true } as any)
      await d.clock.settle()
      d.failList()
      await forceRefresh($, d)
      await $.turn.complete({ ...TURN, agentId: 'a1b2c3' })
      await $.classic.Stop({ stop_hook_active: true, background_tasks: [] } as any)
      await d.clock.settle()
      expect(activityRows(d).filter(r => r.finishedAt !== null).map(r => r.activityId)).toEqual(['agent-a1b2c3', 'bjlibh54w'])
    })

    test('a revoked key is a session known to be off its plan: what it owed is dropped, nothing is posted, nothing toasts', async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.classic.SubagentStart(START)
      await d.clock.settle()
      d.world.signedOut = 'revoked'
      await forceRefresh($, d)
      const before = d.reports.length
      await $.turn.complete({ ...TURN, agentId: 'a1b2c3' })
      await d.clock.settle()
      expect(d.reports.slice(before)).toEqual([])
      expect(d.toasts.filter(t => t.includes('report failed'))).toEqual([])
    })

    test("a sub-agent's end seen while off its plan forgets everything owed: back on the plan, the shell it had opened is never closed from here", async ($, on) => {
      on('tool.call', () => BACKGROUNDED as any)
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.classic.SubagentStart(START)
      await $.tool.call({ tool: 'Bash', command: 'sleep 9', run_in_background: true } as any)
      await d.clock.settle()
      d.world.planId = null
      await forceRefresh($, d)
      await $.turn.complete({ ...TURN, agentId: 'a1b2c3' })
      d.world.planId = 23
      await forceRefresh($, d)
      await $.classic.Stop({ stop_hook_active: true, background_tasks: [] } as any)
      await d.clock.settle()
      expect(finishes(d)).toEqual([])
    })

    test("a stop seen while off its plan forgets everything owed: back on the plan, the sub-agent's end posts nothing", async ($, on) => {
      on('tool.call', () => BACKGROUNDED as any)
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.classic.SubagentStart(START)
      await d.clock.settle()
      d.world.planId = null
      await forceRefresh($, d)
      await $.classic.Stop({ stop_hook_active: true, background_tasks: [] } as any)
      d.world.planId = 23
      await forceRefresh($, d)
      await $.turn.complete({ ...TURN, agentId: 'a1b2c3' })
      await d.clock.settle()
      expect(finishes(d)).toEqual([])
    })

    test("a main-session StopFailure seen while off its plan forgets everything owed: back on the plan, the sub-agent's end posts nothing", async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.classic.SubagentStart(START)
      await d.clock.settle()
      d.world.planId = null
      await forceRefresh($, d)
      await $.classic.StopFailure({ error: 'server_error' } as any)
      d.world.planId = 23
      await forceRefresh($, d)
      await $.turn.complete({ ...TURN, agentId: 'a1b2c3' })
      await d.clock.settle()
      expect(finishes(d)).toEqual([])
      expect(countReports(d)).toEqual([])
    })

    test('nothing new opens while the plan state is unknown: no start row, no shell row, no liveness post', async ($, on) => {
      on('tool.call', () => BACKGROUNDED as any)
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.classic.SubagentStart(START)
      await d.clock.settle()
      d.failList()
      await forceRefresh($, d)
      await $.classic.SubagentStart({ ...START, agent_id: 'later' })
      await d.clock.advance(2 * LIVENESS_MS)
      await $.tool.call({ tool: 'Bash', command: 'sleep 9', run_in_background: true, agentId: 'a1b2c3' } as any)
      await d.clock.settle()
      expect(activityRows(d).map(r => r.activityId)).toEqual(['agent-a1b2c3'])
    })

    test('a session that leaves its plan while a sub-agent runs drops what it owed: the dashboard takes no report from a session on no plan, so nothing is posted and nothing toasts', async ($, on) => {
      on('tool.call', () => BACKGROUNDED as any)
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.classic.SubagentStart(START)
      await $.tool.call({ tool: 'Bash', command: 'sleep 9', run_in_background: true } as any)
      await d.clock.settle()
      d.world.planId = null
      await forceRefresh($, d)
      const before = d.reports.length
      await $.turn.complete({ ...TURN, agentId: 'a1b2c3' })
      await $.classic.Stop({ stop_hook_active: true, background_tasks: [] } as any)
      await d.clock.settle()
      expect(d.reports.slice(before)).toEqual([])
      expect(d.toasts.filter(t => t.includes('report failed'))).toEqual([])
    })
  })
}
