// DX-4233: the relay comes back whatever happened to the first plan load. It starts from the plan the session is on (the connect answer's
// plan id, a light plan read at session.start that is retried while the read fails), never only from a successful full view load; the
// "not connected yet" and unbound errors are transient; a watchdog on a turn's end and a sub-agent's start or stop starts a relay that is
// not running; the pane says when it is not.
import { describe, expect, test } from 'claude-code/testing'

import { connectedPlanId } from '../hooks/plan/mcp'
import { BACKOFF_MS } from '../hooks/relay/config'
import { OLD_SERVER_FIX } from '../hooks/relay/text'
import { SURFACES, SIGN_IN_HALT, answerPlanConnect, dashboard, forceRefresh, startSession } from './plan-kit'

const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const raw = (t: string, isError = false) => ({ value: { content: [{ type: 'text', text: t }], isError } })
const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
const TEN_MINUTES = 600_000
const FIRST_WAIT = { plan_id: 23, cursor: null, timeout_ms: 20_000 }
const NOT_CONNECTED = '$.mcp.call: no connected MCP tool "plan_events_wait" on a server named "plugin:danxbot:danx-dashboard"'
const UNBOUND = '$.mcp.call is not available in this mode: no session is bound in this process (the REPL has not mounted and no headless session is built); catch it and carry on'

for (const surface of SURFACES) {
  describe(`the relay recovers on ${surface}`, () => {
    test('T1: a session start that is not bound, bound a minute later and then idle: exactly one wait loop', async ($, on) => {
      const d = dashboard(on)
      d.unbind()
      await startSession($, d, surface)
      expect(d.relay.calls).toHaveLength(0)
      await d.clock.advance(60_000)
      d.bind()
      await d.clock.advance(TEN_MINUTES)
      expect(d.relay.calls).toEqual([FIRST_WAIT])
      d.relay.push({ cursor: 'c1', text: 'one' })
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] one'])
    })

    test("T2: a first plan load that never settles, then the model's plan_connect: the relay starts", async ($, on) => {
      const d = dashboard(on, { hangFirstLoad: true, connected: false })
      answerPlanConnect(on, d)
      await startSession($, d, surface)
      await d.clock.advance(17_000)
      await $.tool.call({ tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect', plan_id: 23 } as any)
      await d.clock.advance(60_000)
      expect(d.relay.calls).toEqual([FIRST_WAIT])
    })

    test("T3: the plugin's server down at session start and up a minute later, nobody asking: the relay starts", async ($, on) => {
      const d = dashboard(on, { mcp: 'down' })
      await startSession($, d, surface)
      await d.clock.advance(60_000)
      expect(d.relay.calls).toHaveLength(0)
      d.setMcp('up')
      await d.clock.advance(TEN_MINUTES)
      expect(d.relay.calls).toEqual([FIRST_WAIT])
    })

    test('T4: a relay that runs through two minutes of unbound calls keeps delivering once bound', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.holdMs = 'timeout_ms'
      await startSession($, d, surface)
      d.unbind()
      await d.clock.advance(120_000)
      expect(d.unboundCalls.length).toBeGreaterThan(3)
      d.bind()
      await d.clock.advance(BACKOFF_MS[BACKOFF_MS.length - 1]! + 25_000)
      d.relay.push({ cursor: 'c1', text: 'after the bind' })
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] after the bind'])
    })

    test('a plan_connect answer that connected a plan starts its relay without waiting for the view', async ($, on) => {
      const d = dashboard(on, { connected: false })
      answerPlanConnect(on, d)
      await startSession($, d, surface)
      d.holdApi(3_600_000)
      await $.tool.call({ tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect', plan_id: 24 } as any)
      await d.clock.advance(1_000)
      expect(d.relay.calls).toEqual([{ plan_id: 24, cursor: null, timeout_ms: 20_000 }])
    })

    test('a view that cannot load does not keep the relay from starting at session start', async ($, on) => {
      const d = dashboard(on)
      d.failInProgress()
      await startSession($, d, surface)
      expect(d.relay.calls).toEqual([FIRST_WAIT])
    })
  })

  describe(`the relay watchdog on ${surface}`, () => {
    // the start's own retries are used up (ten minutes unbound) and the view cannot load: only the watchdog is left to start it
    async function unstarted($: any, on: any) {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      on('classic.SubagentStart', () => ({}) as any)
      on('classic.SubagentStop', () => ({}) as any)
      d.unbind()
      await startSession($, d, surface)
      await d.clock.advance(TEN_MINUTES)
      d.bind()
      d.failInProgress()
      expect(d.relay.calls).toHaveLength(0)
      return d
    }

    test('a turn that ends starts it when the plan is connected and no loop runs', async ($, on) => {
      const d = await unstarted($, on)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.relay.calls).toEqual([FIRST_WAIT])
    })

    test('a sub-agent start does too', async ($, on) => {
      const d = await unstarted($, on)
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'x', transcript_path: '/work/main.jsonl' })
      await d.clock.settle()
      expect(d.relay.calls).toHaveLength(1)
    })

    test('a sub-agent stop does too', async ($, on) => {
      const d = await unstarted($, on)
      await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'x', transcript_path: '/work/main.jsonl' })
      await d.clock.settle()
      expect(d.relay.calls).toHaveLength(1)
    })

    test('it starts nothing for a session on no plan', async ($, on) => {
      const d = dashboard(on, { connected: false })
      on('turn.complete', () => ({ text: 'done' }) as any)
      d.unbind()
      await startSession($, d, surface)
      await d.clock.advance(TEN_MINUTES)
      d.bind()
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.relay.calls).toHaveLength(0)
    })

    test('it does not start a relay the server stopped', async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      d.relay.server.stopped = { reason: 'plan_archived', detail: 'archived', fix: 'connect again' }
      await startSession($, d, surface)
      expect(d.relay.calls).toHaveLength(1)
      d.relay.server.stopped = undefined
      await $.turn.complete(TURN)
      await d.clock.advance(120_000)
      expect(d.relay.calls).toHaveLength(1)
    })

    test('a burst of sub-agent events while the dashboard is slow issues ONE plan read', async ($, on) => {
      const d = await unstarted($, on)
      d.world.contextDelayMs = 1_000
      d.contextReads.length = 0
      await Promise.all([1, 2, 3, 4, 5].map(i => $.classic.SubagentStop({ agent_id: `a${i}`, agent_type: 'x', transcript_path: '/work/main.jsonl' })))
      await d.clock.advance(5_000)
      await d.clock.settle()
      expect(d.contextReads).toEqual(['/api/plans'])
      expect(d.relay.calls).toHaveLength(1)
    })

    test('a watch that throws toasts once, however many callers share it', async ($, on) => {
      const d = await unstarted($, on)
      d.world.plansBody = 'not an object'
      d.world.contextDelayMs = 1_000
      await Promise.all([1, 2, 3, 4, 5].map(i => $.classic.SubagentStop({ agent_id: `a${i}`, agent_type: 'x', transcript_path: '/work/main.jsonl' })))
      await d.clock.advance(5_000)
      await d.clock.settle()
      expect(d.toasts.filter(t => t.startsWith('Plan event relay watch failed'))).toHaveLength(1)
    })

    test('it does not start a second loop beside one that runs', async ($, on) => {
      const d = dashboard(on)
      on('turn.complete', () => ({ text: 'done' }) as any)
      await startSession($, d, surface)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.relay.calls).toHaveLength(1)
    })
  })

  describe(`transient relay errors on ${surface}`, () => {
    test('a server that is not connected yet (no tools listed) is retried, never a stop', async ($, on) => {
      const d = dashboard(on)
      d.world.tools = 'none'
      d.relay.server.script.push(() => ({ deny: NOT_CONNECTED }) as any)
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('relay retrying')
      expect(await text(pane)).not.toContain('relay stopped')
      await d.clock.advance(BACKOFF_MS[0])
      expect(d.relay.calls).toHaveLength(2)
      // a refresh does not find it halted either
      await forceRefresh($, d)
      d.relay.push({ cursor: 'c1', text: 'later' })
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] later'])
    })

    const notConnected = (d: any, n: number) => {
      for (let i = 0; i < n; i++) d.relay.server.script.push(() => ({ deny: NOT_CONNECTED }) as any)
    }

    test('a not-connected answer from a server that lists its tools without plan_events_wait stays a retry for 8 s, then is an old server: its fix', async ($, on) => {
      const d = dashboard(on)
      d.world.tools = 'old'
      notConnected(d, 10)
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      // the third failure (at 3 s) is not yet the evidence: the tool list is dynamic, a refetch after sign-in or a grant takes a while
      await d.clock.advance(BACKOFF_MS[0] + BACKOFF_MS[1])
      expect(d.relay.calls).toHaveLength(3)
      expect(await text(pane)).toContain('relay retrying')
      expect(d.relay.told.join(' ')).not.toContain(OLD_SERVER_FIX)
      await d.clock.advance(BACKOFF_MS[2] - 1)
      expect(await text(pane)).toContain('relay retrying')
      await d.clock.advance(1)
      expect(await text(pane)).toContain('relay stopped')
      expect(d.relay.told.join(' ')).toContain(`Fix: ${OLD_SERVER_FIX}`)
      expect(d.relay.calls).toHaveLength(4)
      await d.clock.advance(60_000)
      expect(d.relay.calls).toHaveLength(4)
    })

    test('the list gaining plan_events_wait while the waits fail (after a sign-in and connect) streams: no halt, no old-server line', async ($, on) => {
      const d = dashboard(on, { connected: false })
      answerPlanConnect(on, d)
      d.world.tools = 'old'
      notConnected(d, 3)
      await startSession($, d, surface)
      await $.tool.call({ tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect', plan_id: 23 } as any)
      await d.clock.advance(2_000)
      d.world.tools = 'full'
      await d.clock.advance(60_000)
      expect(d.relay.calls.length).toBeGreaterThanOrEqual(4)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).not.toContain('relay stopped')
      expect(d.relay.told.join(' ')).not.toContain(OLD_SERVER_FIX)
      d.relay.push({ cursor: 'c1', text: 'streams' })
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] streams'])
    })

    test('the evidence is counted in a row: a successful wait between failures starts the count again', async ($, on) => {
      const d = dashboard(on)
      d.world.tools = 'old'
      notConnected(d, 2)
      // a wait that works, and takes 6 s: the next failure comes after the 8 s that would have proved the first two
      d.relay.server.script.push(async () => (await d.clock.sleep(6_000), raw(JSON.stringify({ events: [] }))))
      notConnected(d, 1)
      await startSession($, d, surface)
      await d.clock.advance(20_000)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('relay retrying')
      expect(d.relay.told.join(' ')).not.toContain(OLD_SERVER_FIX)
    })

    test('the evidence is counted in a row: a list that catches up between failures starts the count again', async ($, on) => {
      const d = dashboard(on)
      d.world.tools = 'old'
      notConnected(d, 8)
      await startSession($, d, surface)
      await d.clock.advance(2_000)
      d.world.tools = 'full'
      await d.clock.advance(1_500)
      d.world.tools = 'old'
      await d.clock.advance(16_500)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('relay retrying')
      expect(d.relay.told.join(' ')).not.toContain(OLD_SERVER_FIX)
    })

    for (const [name, change] of [
      ['a key lost mid-session (only the bootstrap tools listed)', (d: any) => void (d.world.signedOut = 'revoked')],
      ['a session moved to another plan', (d: any) => void (d.world.planId = 24)],
      ['a session left its plan', (d: any) => void (d.world.planId = null)],
    ] as const) {
      test(`${name} is never read as an old server: the run ends quietly, with no endless retry`, async ($, on) => {
        const d = dashboard(on)
        d.world.tools = 'old'
        notConnected(d, 40)
        await startSession($, d, surface)
        await d.clock.advance(1_000)
        change(d)
        await d.clock.advance(20_000)
        const calls = d.relay.calls.length
        await d.clock.advance(120_000)
        expect(d.relay.calls).toHaveLength(calls)
        const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
        expect(await text(pane)).not.toContain('relay stopped')
        expect(d.relay.told.join(' ')).not.toContain(OLD_SERVER_FIX)
      })
    }

    test('the proof needs the dashboard to answer: with the evidence in and the plan read failing, the loop keeps calling and tells no old-server line', async ($, on) => {
      const d = dashboard(on)
      d.world.tools = 'old'
      notConnected(d, 40)
      await startSession($, d, surface)
      // the 4th failure (8 s) is the one that asks the dashboard: it answers a fault
      d.world.plansStatus = 500
      await d.clock.advance(20_000)
      const calls = d.relay.calls.length
      expect(calls).toBeGreaterThanOrEqual(5)
      await d.clock.advance(60_000)
      expect(d.relay.calls.length).toBeGreaterThan(calls + 3)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('relay retrying')
      expect(await text(pane)).not.toContain('relay stopped')
      expect(d.relay.told.join(' ')).not.toContain(OLD_SERVER_FIX)
    })

    test('a not-connected answer when the tool list cannot be read (unbound) is retried', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.script.push(() => ({ deny: NOT_CONNECTED }) as any)
      d.relay.server.script.push(() => ({ deny: NOT_CONNECTED }) as any)
      d.relay.server.holdMs = 'timeout_ms'
      await startSession($, d, surface)
      d.unbind()
      await d.clock.advance(BACKOFF_MS[0] + BACKOFF_MS[1])
      d.bind()
      await d.clock.advance(60_000)
      d.relay.push({ cursor: 'c1', text: 'later' })
      await d.clock.settle()
      expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] later'])
    })

    test('an unbound call is retried with the backoff', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.script.push(() => ({ deny: UNBOUND }) as any)
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('relay retrying')
      await d.clock.advance(BACKOFF_MS[0])
      expect(d.relay.calls).toHaveLength(2)
      expect(d.relay.told).toHaveLength(1)
    })

    test('only an answer that names the tool as unknown ends the loop as an old server', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.script.push(() => raw('Unknown tool: plan_events_wait', true))
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('relay stopped')
    })
  })

  describe(`the pane's relay line on ${surface}`, () => {
    test('says the relay is not running when the plan is connected and no loop runs', async ($, on) => {
      const d = dashboard(on)
      // the key was lost: the relay ends quietly, and the view still shows the plan until the next load
      d.relay.server.script.push(() => raw(SIGN_IN_HALT, true))
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('relay not running')
    })

    test('says nothing of it while the relay streams', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).not.toContain('relay not running')
    })

    test('says nothing of it for a session on no plan', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).not.toContain('relay not running')
    })
  })
}

describe('the plan a plan_connect answer connected', () => {
  const answer = (value: unknown) => JSON.stringify(value)
  test('is the plan id of an ok envelope', () => {
    expect(connectedPlanId(answer({ ok: true, status: 200, body: { session: { plan_id: 24 }, naming: { status: 'ok' } } }))).toBe(24)
  })
  test('is none for a leave, a refusal, an approval request, text that is no envelope, or no text', () => {
    expect(connectedPlanId(answer({ ok: true, status: 200, body: { session: { plan_id: null } } }))).toBeNull()
    expect(connectedPlanId(answer({ ok: false, status: 409, body: { session: { plan_id: 24 } } }))).toBeNull()
    expect(connectedPlanId(answer({ state: 'approval_required', approvalUrl: 'u' }))).toBeNull()
    expect(connectedPlanId('connected')).toBeNull()
    expect(connectedPlanId(undefined)).toBeNull()
  })
})
