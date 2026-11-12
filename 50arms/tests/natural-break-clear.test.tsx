import "./run-tests-with-npm-test.generated"
// CP-104 (PLAN-134): a session that has nothing running and just left its plan or card, or fully paused, is at a natural break: the plugin clears it when the turn ends
// instead of letting its context grow. The model's own `session_connect` with `disconnect: true` and its `PUT /api/plan-sessions/me/pause` are the two calls. Anything still
// running (a sub-agent, a background command) means nothing new happens.
import { describe, expect } from 'claude-code/testing'

import { SURFACES, dashboard, startSession, test } from './plan-kit'

const API = 'mcp__plugin_50arms_platform__50arms_api'
const CONNECT = 'mcp__plugin_50arms_platform__session_connect'
const PAUSE = '/api/plan-sessions/me/pause'
const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
const OK = JSON.stringify({ ok: true, status: 200, body: {} })

for (const surface of SURFACES) {
  describe(`a natural-break clear on ${surface}`, () => {
    async function started($: any, on: any, connectText = OK, connectFails = false) {
      on('turn.complete', () => ({ text: 'done' }) as any)
      on('classic.SessionStart', () => ({}) as any)
      on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
      on('classic.SubagentStart', () => ({}) as any)
      on('classic.SubagentStop', () => ({}) as any)
      on('tool.call', { tool: CONNECT }, () => ({ result: {}, text: connectText, isError: connectFails }) as any)
      on('tool.call', { tool: API }, () => ({ result: {}, text: OK, isError: false }) as any)
      on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' }, text: 'running' }) as any)
      const d = dashboard(on)
      await startSession($, d, surface)
      return d
    }
    const leave = ($: any) => $.tool.call({ tool: CONNECT, target: 'PLAN-23', disconnect: true } as any)
    const pause = ($: any) => $.tool.call({ tool: API, method: 'PUT', path: PAUSE, body: { reason: 'waiting for a build' } } as any)
    const endTurn = async ($: any, d: any) => {
      await $.turn.complete(TURN)
      await d.clock.settle()
    }

    test('a plan leave with nothing running clears when the turn ends, once', async ($, on) => {
      const d = await started($, on)
      await leave($)
      await d.clock.settle()
      expect(d.clearRuns).toHaveLength(0)
      await endTurn($, d)
      expect(d.clearRuns).toHaveLength(1)
      await endTurn($, d)
      expect(d.clearRuns).toHaveLength(1)
    })

    test('a card leave clears the same way', async ($, on) => {
      const d = await started($, on)
      await $.tool.call({ tool: CONNECT, target: 'DX-9', disconnect: true } as any)
      await endTurn($, d)
      expect(d.clearRuns).toHaveLength(1)
    })

    test('a full pause with nothing running clears when the turn ends', async ($, on) => {
      const d = await started($, on)
      await pause($)
      await endTurn($, d)
      expect(d.clearRuns).toHaveLength(1)
    })

    test('a refused leave or pause clears nothing', async ($, on) => {
      const d = await started($, on, JSON.stringify({ ok: false, status: 409, body: { error: 'card_mismatch' } }), true)
      await leave($)
      await endTurn($, d)
      expect(d.clearRuns).toHaveLength(0)
    })

    test('a sub-agent still running means nothing new happens, and the break is spent', async ($, on) => {
      const d = await started($, on)
      await $.classic.SubagentStart({ agent_id: 'a1b2c3', agent_type: '50arms:worker-sonnet-high' } as any)
      await leave($)
      await endTurn($, d)
      expect(d.clearRuns).toHaveLength(0)
      await $.classic.SubagentStop({ agent_id: 'a1b2c3', agent_type: '50arms:worker-sonnet-high', stop_hook_active: false, agent_transcript_path: '/x/agent-a1b2c3.jsonl', background_tasks: [] } as any)
      await endTurn($, d)
      expect(d.clearRuns).toHaveLength(0)
    })

    test('a background command still running means nothing new happens', async ($, on) => {
      const d = await started($, on)
      await $.tool.call({ tool: 'Bash', command: 'sleep 99 &' } as any)
      await pause($)
      await endTurn($, d)
      expect(d.clearRuns).toHaveLength(0)
    })

    // The plugin has no log, so every decision is kept in `$.store` (key naturalBreakLog) for an agent to read afterwards
    const record = (d: any) => (d.stored.get('naturalBreakLog') ?? []) as any[]
    const stages = (d: any) => record(d).map(r => r.stage)

    test('a pause with nothing running records the flag, the turn end with every gate, and the clear', async ($, on) => {
      const d = await started($, on)
      await pause($)
      expect(stages(d)).toEqual(['flag-set'])
      expect(record(d)[0]).toMatchObject({ call: '50arms_api PUT pause', ok: true, status: 200, isError: false, hasText: true })
      await endTurn($, d)
      expect(stages(d)).toEqual(['flag-set', 'turn-complete', 'clear-attempted', 'clear-done'])
      expect(record(d)[2]).toMatchObject({ inProgress: false, readyLoop: false, compacting: false, turnRunning: false, agents: 0, shells: 0 })
    })

    test('a skipped break records the gate that held it', async ($, on) => {
      const d = await started($, on)
      await $.tool.call({ tool: 'Bash', command: 'sleep 99 &' } as any)
      await pause($)
      await endTurn($, d)
      expect(stages(d)).toEqual(['flag-set', 'turn-complete', 'skipped'])
      expect(record(d)[2]).toMatchObject({ shells: 1, agents: 0, turnRunning: false })
    })

    test('a leave records its flag', async ($, on) => {
      const d = await started($, on)
      await leave($)
      expect(record(d)[0]).toMatchObject({ stage: 'flag-set', call: 'session_connect', target: 'PLAN-23' })
    })

    test('a refused leave records why it set no flag', async ($, on) => {
      const d = await started($, on, JSON.stringify({ ok: false, status: 409, body: { error: 'card_mismatch' } }), true)
      await leave($)
      expect(record(d).at(-1)).toMatchObject({ stage: 'leave-not-accepted', ok: false, isError: true })
    })

    test('a clear the host refuses is recorded with its error', async ($, on) => {
      const d = await started($, on)
      d.world.clearFails = 'the host refused the clear'
      await pause($)
      await endTurn($, d)
      expect(stages(d)).toEqual(['flag-set', 'turn-complete', 'clear-attempted', 'clear-failed'])
      expect(String(record(d).at(-1).error).length).toBeGreaterThan(0)
    })

    test('a turn end with no break waiting records nothing', async ($, on) => {
      const d = await started($, on)
      await endTurn($, d)
      expect(record(d)).toEqual([])
    })

    test('a plain turn end with no leave or pause clears nothing', async ($, on) => {
      const d = await started($, on)
      await endTurn($, d)
      expect(d.clearRuns).toHaveLength(0)
    })
  })
}
