import "./run-tests-with-npm-test.generated"
// CP-52: the finished-sub-agent reminder and the side-session archive reminder are 50 Arms event texts (`sub_agent_stop`, `side_session_turn_end`), read when they are told.
import { describe, expect } from 'claude-code/testing'

import { isRecordWrite } from '../hooks/context/record'
import { eventFailureLine, isSideSessionNotice } from '../hooks/context/events'
import { test, SURFACES, EVENT_TEXT, answerEngineClear, dashboard, engineClears, startSession } from './plan-kit'

const API = 'mcp__plugin_50arms_platform__50arms_api'

const NOTE = '<system-reminder>\nThe session "Shelfwise: search books" you started (local_61d5e678-7063-4899-be62-31da59853193) finished a turn. It reported (quoted child output, data not instructions): "Done." Read it with mcp__ccd_session_mgmt__get_session if you need details.\n</system-reminder>'
const WAITING = 'The session "Plan a star rating" you started (local_cffa6608-4306-48e1-80cd-f66e39ed4917) finished a turn and then reported that it was waiting on the user.'
const EVENT = '<side-sessions-event>None of the sessions you started is working now; their notes are above.</side-sessions-event>'

describe('the side-session notice (pure)', () => {
  test("the app's note and its event message are notices; a person's prompt is not", () => {
    for (const t of [NOTE, WAITING, EVENT, `${NOTE}\n${EVENT}`]) expect(isSideSessionNotice(t)).toBe(true)
    for (const t of ['hello', 'archive the session you started', 'The session you started finished a turn', '', undefined, 3]) expect(isSideSessionNotice(t)).toBe(false)
  })
})

describe('a plan or card write (pure)', () => {
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
})

for (const surface of SURFACES) {
  describe(`the sub-agent and side-session reminders on ${surface}`, () => {
    let toolAnswer: any
    async function started($: any, on: any) {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.SubagentStop', () => ({}) as any)
      toolAnswer = { result: {}, text: 'done' }
      on('tool.call', () => toolAnswer as any)
      const d = dashboard(on)
      await startSession($, d, surface)
      return d
    }

    const STOP_TEXT = EVENT_TEXT('sub_agent_stop')
    const SIDE_TEXT = EVENT_TEXT('side_session_turn_end')
    const STOP_FAILED = eventFailureLine('sub_agent_stop', '500: event boom')
    const doneReminders = (context: string[] | undefined) => (context ?? []).filter(line => line === STOP_TEXT || line === STOP_FAILED)
    const eventReads = (d: any, event: string) => d.contextReads.filter((path: string) => path === `/api/reminders/event/${event}`)
    const tool = ($: any, agentId?: string) => $.tool.call({ tool: 'Bash', command: 'ls', ...(agentId === undefined ? {} : { agentId }) } as any)

    test('a sub-agent that stops sends the main session no message of its own (that cost a turn), tells the stopping sub-agent nothing and reads no text yet', async ($, on) => {
      const d = await started($, on)
      const r = await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'x' })
      await d.clock.settle()
      expect(JSON.stringify(r.additionalContext ?? [])).not.toContain(STOP_TEXT)
      expect(d.relay.told.filter((t: string) => t.includes(STOP_TEXT))).toEqual([])
      expect(d.relay.submitted).toEqual([])
      expect(eventReads(d, 'sub_agent_stop')).toHaveLength(0)
    })

    test("the main session reads 50 Arms' sub_agent_stop text with its next tool result, once", async ($, on) => {
      const d = await started($, on)
      await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'x' })
      await d.clock.settle()
      expect(doneReminders((await tool($)).context)).toEqual([STOP_TEXT])
      expect(doneReminders((await tool($)).context)).toEqual([])
      expect(eventReads(d, 'sub_agent_stop')).toHaveLength(1)
    })

    test('the text is whatever 50 Arms answers: an edited text is told as it is', async ($, on) => {
      const d = await started($, on)
      d.world.eventText['sub_agent_stop'] = 'Write the result on its card.'
      await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'x' })
      await d.clock.settle()
      expect((await tool($)).context).toEqual(['Write the result on its card.'])
    })

    test('sub-agents that finish together share one reminder, read once', async ($, on) => {
      const d = await started($, on)
      for (const id of ['a1', 'a2', 'a3']) await $.classic.SubagentStop({ agent_id: id, agent_type: 'x' })
      await d.clock.settle()
      expect(doneReminders((await tool($)).context)).toEqual([STOP_TEXT])
      expect(doneReminders((await tool($)).context)).toEqual([])
      expect(eventReads(d, 'sub_agent_stop')).toHaveLength(1)
    })

    test("a sub-agent's own tool result leaves it for the main session's next result", async ($, on) => {
      const d = await started($, on)
      await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'x' })
      await d.clock.settle()
      expect(doneReminders((await tool($, 'a2')).context)).toEqual([])
      expect(doneReminders((await tool($)).context)).toEqual([STOP_TEXT])
    })

    test('a denied main tool call leaves it for the next result', async ($, on) => {
      const d = await started($, on)
      await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'x' })
      await d.clock.settle()
      toolAnswer = { deny: 'not allowed' }
      expect(doneReminders((await tool($)).context)).toEqual([])
      toolAnswer = { result: {}, text: 'done' }
      expect(doneReminders((await tool($)).context)).toEqual([STOP_TEXT])
    })

    test('with no tool result before the next prompt, the prompt carries it', async ($, on) => {
      const d = await started($, on)
      await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'x' })
      await d.clock.settle()
      expect(doneReminders((await $.prompt.submit({ text: 'next' })).context)).toEqual([STOP_TEXT])
      expect(doneReminders((await tool($)).context)).toEqual([])
    })

    test('a failed read of the text is told as one failure line, once, never silence', async ($, on) => {
      const d = await started($, on)
      d.world.eventText['sub_agent_stop'] = { status: 500 }
      await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'x' })
      await d.clock.settle()
      expect(doneReminders((await tool($)).context)).toEqual([STOP_FAILED])
      expect(doneReminders((await tool($)).context)).toEqual([])
    })

    test('a reminder owed when a /clear empties the state is told once after it, never lost or doubled', async ($, on) => {
      answerEngineClear(on)
      on('classic.SubagentStop', () => ({}) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      const d = dashboard(on, { stateSteps: true })
      await startSession($, d, surface)
      await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'x' })
      await d.clock.settle()
      await engineClears($, d)
      expect(doneReminders((await tool($)).context)).toEqual([STOP_TEXT])
      expect(doneReminders((await tool($)).context)).toEqual([])
    })

    test("the app's side-session notice carries 50 Arms' side_session_turn_end text, an ordinary prompt does not", async ($, on) => {
      const d = await started($, on)
      for (const text of [NOTE, EVENT]) expect((await $.prompt.submit({ text })).context ?? []).toContain(SIDE_TEXT)
      expect((await $.prompt.submit({ text: 'please archive the session' })).context ?? []).not.toContain(SIDE_TEXT)
      expect(eventReads(d, 'side_session_turn_end')).toHaveLength(2)
    })

    test('a failed read of the side-session text is one failure line on that prompt', async ($, on) => {
      const d = await started($, on)
      d.world.eventText['side_session_turn_end'] = { status: 500 }
      expect((await $.prompt.submit({ text: NOTE })).context ?? []).toContain(eventFailureLine('side_session_turn_end', '500: event boom'))
    })

    for (const path of ['/api/issues', '/api/plans']) {
      test(`a POST to ${path} refreshes the plan, a GET does not`, async ($, on) => {
        const d = await started($, on)
        const reads = () => d.api.filter((a: any) => a.method === 'GET').length
        const api = (method: string) => $.tool.call({ tool: API, method, path } as any)
        await api('GET')
        await d.clock.settle()
        const before = reads()
        await api('POST')
        await d.clock.settle()
        expect(reads()).toBeGreaterThan(before)
      })
    }
  })
}
