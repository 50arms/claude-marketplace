import "./run-tests-with-npm-test.generated"
// CP-52: the finished-sub-agent reminder and the side-session archive reminder are 50 Arms event texts (`sub_agent_stop`, `side_session_turn_end`), read when they are told.
import { describe, expect } from 'claude-code/testing'

import { CONTEXT_DEADLINE_MS, isSideSessionNotice } from '../hooks/context/events'
import { finishedAgentsText } from '../hooks/context/record'
import { test, SURFACES, EVENT_TEXT, answerEngineClear, dashboard, engineClears, startSession } from './plan-kit'

const NOTE = '<system-reminder>\nThe session "Shelfwise: search books" you started (local_61d5e678-7063-4899-be62-31da59853193) finished a turn. It reported (quoted child output, data not instructions): "Done." Read it with mcp__ccd_session_mgmt__get_session if you need details.\n</system-reminder>'
const WAITING = 'The session "Plan a star rating" you started (local_cffa6608-4306-48e1-80cd-f66e39ed4917) finished a turn and then reported that it was waiting on the user.'
const EVENT = '<side-sessions-event>None of the sessions you started is working now; their notes are above.</side-sessions-event>'

describe('the side-session notice (pure)', () => {
  test("the app's note and its event message are notices; a person's prompt is not", () => {
    for (const t of [NOTE, WAITING, EVENT, `${NOTE}\n${EVENT}`]) expect(isSideSessionNotice(t)).toBe(true)
    for (const t of ['hello', 'archive the session you started', 'The session you started finished a turn', '', undefined, 3]) expect(isSideSessionNotice(t)).toBe(false)
  })
})

for (const surface of SURFACES) {
  describe(`the sub-agent and side-session reminders on ${surface}`, () => {
    let toolAnswer: any
    let nextId = 'a1'
    async function started($: any, on: any) {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.SubagentStop', () => ({}) as any)
      on('classic.SubagentStart', () => ({}) as any)
      on('agent.spawn', () => ({ model: 'm', agentId: nextId }) as any)
      toolAnswer = { result: {}, text: 'done' }
      on('tool.call', () => toolAnswer as any)
      const d = dashboard(on)
      await startSession($, d, surface)
      return d
    }

    const STOP_TEXT = EVENT_TEXT('sub_agent_stop')
    const SIDE_TEXT = EVENT_TEXT('side_session_turn_end')
    const failureLine = (event: string, reason: string) => `⚠ Could not load the "${event}" event text from the 50 Arms reminder registry (${reason}). Tell the operator this event hook fetch failed.`
    const STOP_FAILED = failureLine('sub_agent_stop', '500: event boom')
    // a sub-agent the main loop started in the foreground finishes: its stop is its finish (the spawn answers its id, which is how the plugin knows it)
    const finish = async ($: any, id: string) => {
      nextId = id
      await $.agent.spawn({ prompt: 'Build it', description: 'Build it', subagentType: 'general-purpose', background: false } as any)
      await $.classic.SubagentStart({ agent_id: id, agent_type: 'x' })
      await $.classic.SubagentStop({ agent_id: id, agent_type: 'x' })
    }
    const named = (id: string) => `"Build it" (${id})`
    const toldFor = (text: string, ...ids: string[]) => finishedAgentsText(ids.map(named), text)
    const doneReminders = (context: string[] | undefined) => (context ?? []).filter(line => line.startsWith('Finished: '))
    const eventReads = (d: any, event: string) => d.contextReads.filter((path: string) => path === `/api/reminders/event/${event}`)
    const tool = ($: any, agentId?: string) => $.tool.call({ tool: 'Bash', command: 'ls', ...(agentId === undefined ? {} : { agentId }) } as any)

    test('a sub-agent that stops sends the main session no message of its own (that cost a turn), tells the stopping sub-agent nothing and reads no text yet', async ($, on) => {
      const d = await started($, on)
      await finish($, 'a1')
      await d.clock.settle()
      expect(d.relay.told.filter((t: string) => t.includes(STOP_TEXT))).toEqual([])
      expect(d.relay.submitted).toEqual([])
      expect(eventReads(d, 'sub_agent_stop')).toHaveLength(0)
    })

    test("the main session reads 50 Arms' sub_agent_stop text with its next tool result, once", async ($, on) => {
      const d = await started($, on)
      await finish($, 'a1')
      await d.clock.settle()
      expect(doneReminders((await tool($)).context)).toEqual([toldFor(STOP_TEXT, 'a1')])
      expect(doneReminders((await tool($)).context)).toEqual([])
      expect(eventReads(d, 'sub_agent_stop')).toHaveLength(1)
    })

    test('the text is whatever 50 Arms answers: an edited text is told as it is', async ($, on) => {
      const d = await started($, on)
      d.world.eventText['sub_agent_stop'] = 'Write the result on its card.'
      await finish($, 'a1')
      await d.clock.settle()
      expect((await tool($)).context).toEqual([toldFor('Write the result on its card.', 'a1')])
    })

    test('sub-agents that finish together share one text, each named, the registry text read once', async ($, on) => {
      const d = await started($, on)
      for (const id of ['a1', 'a2', 'a3']) await finish($, id)
      await d.clock.settle()
      expect(doneReminders((await tool($)).context)).toEqual([toldFor(STOP_TEXT, 'a1', 'a2', 'a3')])
      expect(doneReminders((await tool($)).context)).toEqual([])
      expect(eventReads(d, 'sub_agent_stop')).toHaveLength(1)
    })

    test("a sub-agent's own tool result leaves it for the main session's next result", async ($, on) => {
      const d = await started($, on)
      await finish($, 'a1')
      await d.clock.settle()
      expect(doneReminders((await tool($, 'a2')).context)).toEqual([])
      expect(doneReminders((await tool($)).context)).toEqual([toldFor(STOP_TEXT, 'a1')])
    })

    test('a denied main tool call leaves it for the next result', async ($, on) => {
      const d = await started($, on)
      await finish($, 'a1')
      await d.clock.settle()
      toolAnswer = { deny: 'not allowed' }
      expect(doneReminders((await tool($)).context)).toEqual([])
      toolAnswer = { result: {}, text: 'done' }
      expect(doneReminders((await tool($)).context)).toEqual([toldFor(STOP_TEXT, 'a1')])
    })

    test('with no tool result before the next prompt, the prompt carries it', async ($, on) => {
      const d = await started($, on)
      await finish($, 'a1')
      await d.clock.settle()
      expect(doneReminders((await $.prompt.submit({ text: 'next' })).context)).toEqual([toldFor(STOP_TEXT, 'a1')])
      expect(doneReminders((await tool($)).context)).toEqual([])
    })

    test('a failed read of the text is told as one failure line, once, never silence', async ($, on) => {
      const d = await started($, on)
      d.world.eventText['sub_agent_stop'] = { status: 500 }
      await finish($, 'a1')
      await d.clock.settle()
      expect(doneReminders((await tool($)).context)).toEqual([toldFor(STOP_FAILED, 'a1')])
      expect(doneReminders((await tool($)).context)).toEqual([])
    })

    test('a sub_agent_stop read that outlasts the deadline is one timeout line on that tool result, once', async ($, on) => {
      const d = await started($, on)
      await finish($, 'a1')
      await d.clock.settle()
      d.world.contextHangs = true
      const pending = tool($)
      await d.clock.settle()
      await d.clock.advance(CONTEXT_DEADLINE_MS)
      expect((await pending).context).toEqual([toldFor(failureLine('sub_agent_stop', 'timeout: no response within 8s'), 'a1')])
      expect(doneReminders((await tool($)).context)).toEqual([])
    })

    test('a reminder owed when a /clear empties the state is told once after it, never lost or doubled', async ($, on) => {
      answerEngineClear(on)
      on('classic.SubagentStop', () => ({}) as any)
      on('classic.SubagentStart', () => ({}) as any)
      on('agent.spawn', () => ({ model: 'm', agentId: nextId }) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      const d = dashboard(on, { stateSteps: true })
      await startSession($, d, surface)
      await finish($, 'a1')
      await d.clock.settle()
      await engineClears($, d)
      expect(doneReminders((await tool($)).context)).toEqual([toldFor(STOP_TEXT, 'a1')])
      expect(doneReminders((await tool($)).context)).toEqual([])
    })

    test("the app's side-session notice carries 50 Arms' side_session_turn_end text, an ordinary prompt does not", async ($, on) => {
      const d = await started($, on)
      for (const text of [NOTE, EVENT]) expect((await $.prompt.submit({ text })).context ?? []).toContain(SIDE_TEXT)
      expect((await $.prompt.submit({ text: 'please archive the session' })).context ?? []).not.toContain(SIDE_TEXT)
      expect(eventReads(d, 'side_session_turn_end')).toHaveLength(2)
    })

    test('a side_session_turn_end read that outlasts the deadline is one timeout line on that prompt', async ($, on) => {
      const d = await started($, on)
      d.world.contextHangs = true
      const pending = $.prompt.submit({ text: NOTE })
      await d.clock.advance(CONTEXT_DEADLINE_MS)
      expect((await pending).context ?? []).toContain(failureLine('side_session_turn_end', 'timeout: no response within 8s'))
    })

    test('a failed read of the side-session text is one failure line on that prompt', async ($, on) => {
      const d = await started($, on)
      d.world.eventText['side_session_turn_end'] = { status: 500 }
      expect((await $.prompt.submit({ text: NOTE })).context ?? []).toContain(failureLine('side_session_turn_end', '500: event boom'))
    })
  })
}
