import "./run-tests-with-npm-test.generated"
// CP-108: a sub-agent's turn end is refused while a background command it started still runs (the engine often loses the wake-up of a sub-agent that
// ends its turn to wait). The main session's own Stop is not affected, and an interim task notice is no longer held back (CP-53 removed).
import { describe, expect } from 'claude-code/testing'

import { ownRunningShells, subagentStopRefusal } from '../hooks/context/own-background'
import { test, SURFACES, answerReportEvents, dashboard, startSession } from './plan-kit'

const shell = (id: string, status = 'running') => ({ id, type: 'shell', status, description: 'sleep' })
const BACKGROUNDED = (id: string) => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id }, text: `Command running in background with ID: ${id}` })
const STOP = (agent: string, tasks: unknown[]) => ({ agent_id: agent, agent_type: 'general-purpose', stop_hook_active: false, agent_transcript_path: `/x/agent-${agent}.jsonl`, background_tasks: tasks }) as any

describe('the shells a sub-agent still runs (pure)', () => {
  const own = [{ taskId: 'b1', label: 'npm test' }, { taskId: 'b2', label: 'make land' }]

  test('only its own shells that the snapshot lists as running count', () => {
    expect(ownRunningShells(own, [shell('b1'), shell('b2', 'completed'), shell('other')])).toEqual([own[0]])
    expect(ownRunningShells(own, [])).toEqual([])
  })

  test('a snapshot that is not a list holds nobody', () => {
    expect(ownRunningShells(own, undefined)).toEqual([])
    expect(ownRunningShells(own, 'x')).toEqual([])
  })

  test('the refusal names each command and says to wait in the foreground', () => {
    const reason = subagentStopRefusal(own)
    expect(reason).toContain('b1: npm test; b2: make land')
    expect(reason).toContain('in the foreground, in bounded steps')
  })
})

for (const surface of SURFACES) {
  describe(`a sub-agent's turn end with its own command running on ${surface}`, () => {
    async function started($: any, on: any) {
      let answer: any = { result: {}, text: 'done' }
      on('tool.call', () => answer)
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      return { d, answer: (a: any) => (answer = a) }
    }

    test('is refused while the command runs, and allowed once it has finished', async ($, on) => {
      const { answer } = await started($, on)
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'general-purpose' })
      answer(BACKGROUNDED('b1'))
      await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'the suite', run_in_background: true, agentId: 'a1' } as any)
      const refused = await $.classic.SubagentStop(STOP('a1', [shell('b1')]))
      expect(refused.block).toBe(subagentStopRefusal([{ taskId: 'b1', label: 'the suite' }]))
      const allowed = await $.classic.SubagentStop(STOP('a1', [shell('b1', 'completed')]))
      expect(allowed.block).toBeUndefined()
    })

    test('a sub-agent that started none is not held by a command of another agent or of the main session', async ($, on) => {
      const { answer } = await started($, on)
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'general-purpose' })
      await $.classic.SubagentStart({ agent_id: 'a2', agent_type: 'general-purpose' })
      answer(BACKGROUNDED('b1'))
      await $.tool.call({ tool: 'Bash', command: 'sleep 99', run_in_background: true, agentId: 'a2' } as any)
      answer(BACKGROUNDED('m1'))
      await $.tool.call({ tool: 'Bash', command: 'sleep 99', run_in_background: true } as any)
      const r = await $.classic.SubagentStop(STOP('a1', [shell('b1'), shell('m1')]))
      expect(r.block).toBeUndefined()
    })

    test("the main session's own Stop is not refused by a running command", async ($, on) => {
      const { answer } = await started($, on)
      answer(BACKGROUNDED('m1'))
      await $.tool.call({ tool: 'Bash', command: 'sleep 99', run_in_background: true } as any)
      const r = await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell('m1')] } as any)
      expect(r.block).toBeUndefined()
    })

    test('an interim task notice reaches the model as the engine sent it', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const text = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<note>This agent stopped with background work of its own still running.</note>\n</task-notification>'
      const r = await $.prompt.submit({ text, origin: { kind: 'task-notification' } } as any)
      expect(r.drop).toBeUndefined()
      expect(r.text).toBe(text)
    })
  })
}
