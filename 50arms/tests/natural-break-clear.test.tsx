import "./run-tests-with-npm-test.generated"
// CP-104 (PLAN-134): a session that has nothing running and just left its plan or card, or fully paused, is at a natural break: the plugin clears it when the turn ends
// instead of letting its context grow. The model's own `session_connect` with `disconnect: true` and its `PUT /api/plan-sessions/me/pause` are the two calls. Anything still
// running (a sub-agent, a background command) means nothing new happens.
import { describe, expect } from 'claude-code/testing'

import { DISCONNECT_GLYPH } from '../hooks/plan/config'
import { SURFACES, dashboard, startSession, test } from './plan-kit'

const TRANSCRIPT = [{ role: 'user', text: 'go', toolUses: [], handle: 'm1' }]
const REPO = 'acme-app'
const COMPACTED = { messages: [{ role: 'user', text: 'the summary', toolUses: [] }] }

const API = 'mcp__plugin_50arms_platform__50arms_api'
const CONNECT = 'mcp__plugin_50arms_platform__session_connect'
const PAUSE = '/api/plan-sessions/me/pause'
const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
const OK = JSON.stringify({ ok: true, status: 200, body: {} })

for (const surface of SURFACES) {
  describe(`a natural-break clear on ${surface}`, () => {
    async function started($: any, on: any, connectText = OK, connectFails = false, apiText = OK, connected = true) {
      on('classic.PreCompact', () => ({}) as any)
      on('session.compact', async () => COMPACTED as any)
      on('turn.complete', () => ({ text: 'done' }) as any)
      on('classic.SessionStart', () => ({}) as any)
      on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
      on('classic.SubagentStart', () => ({}) as any)
      on('classic.SubagentStop', () => ({}) as any)
      on('tool.call', { tool: CONNECT }, () => ({ result: {}, text: connectText, isError: connectFails }) as any)
      on('tool.call', { tool: API }, () => ({ result: {}, text: apiText, isError: false }) as any)
      on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' }, text: 'running' }) as any)
      const d = dashboard(on, { connected })
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

    test('a refused pause clears nothing', async ($, on) => {
      const d = await started($, on, OK, false, JSON.stringify({ ok: false, status: 409, body: { error: 'not_paused' } }))
      await pause($)
      await endTurn($, d)
      expect(d.clearRuns).toHaveLength(0)
    })

    test('a timed pause clears like an untimed one', async ($, on) => {
      const d = await started($, on)
      await $.tool.call({ tool: API, method: 'PUT', path: PAUSE, body: { reason: 'waiting for a build', expires_in_minutes: 30 } } as any)
      await endTurn($, d)
      expect(d.clearRuns).toHaveLength(1)
    })

    test("the band's Disconnect is a person's press and clears nothing", async ($, on) => {
      const d = await started($, on)
      const band = await $.ui.mount({ plugin: '50arms', surface, component: 'AbovePrompt', props: { hasSurvey: false } } as any)
      expect((await band.find({ key: 'disconnect' }))?.text).toBe(DISCONNECT_GLYPH)
      await band.press({ key: 'disconnect' })
      await d.clock.settle()
      expect(d.calls.filter((c: any) => c.tool === 'session_connect' && c.args.disconnect)).toHaveLength(1)
      await endTurn($, d)
      expect(d.clearRuns).toHaveLength(0)
    })

    test('a session on the ready list is left to its own loop', async ($, on) => {
      const d = await started($, on, OK, false, OK, false)
      d.world.agent = { id: 6, name: 'Tendai', avatar_url: null }
      d.world.repos = [{ name: REPO, github_remote: { owner: 'acme', repo: 'app' } }]
      d.world.processes.git = { stdout: 'git@github.com:Acme/App.git\n' }
      await $.command.run({ command: '50arms:ready' })
      await d.clock.settle()
      expect(d.world.readyMark).toBe(REPO)
      await leave($)
      await endTurn($, d)
      expect(d.clearRuns).toHaveLength(0)
    })

    test('a compaction already running is skipped, and the break is spent', async ($, on) => {
      const d = await started($, on)
      await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })
      await d.clock.settle()
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

    test('a plain turn end with no leave or pause clears nothing', async ($, on) => {
      const d = await started($, on)
      await endTurn($, d)
      expect(d.clearRuns).toHaveLength(0)
    })
  })
}
