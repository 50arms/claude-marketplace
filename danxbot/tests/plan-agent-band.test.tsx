import "./run-tests-with-npm-test.generated"
// DX-5554: the band names the team agent the session signs in as (GET /api/plans `session.agent`) and what it answers for: the plan, the stand-alone
// card it holds (`session.card_id` / `card_title`), or neither. A held card's Open link goes to the card's own page; the footer names the card too.
import { describe, expect } from 'claude-code/testing'

import { EMPTY } from '../hooks/plan/config'
import { bandLabel, footerLabel } from '../hooks/plan/words'
import { agentBlockOf } from '../hooks/plan/mcp'
import { test, AGENT_GATE_HALT, DASHBOARD_URL, SURFACES, dashboard, footerText, forceRefresh, linksOf, mountIndicator, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const AGENT = { id: 6, name: 'Tendai', avatar_url: 'https://cdn.example/tendai.png' }
const CARD = { id: 'DX-77', title: 'One-off fix' }
const labelOf = async (ui: any) => (await ui.find({ type: 'Text', text: /Tendai|Danxbot:|PLAN-23|DX-77/ }))?.text as string
const woken = (d: any): string[] => d.relay.delivered.map((x: any) => x.text)
const openLinks = async (ui: any) => (await linksOf(ui)).filter(l => l.key === 'open-tab')

describe('the agent and its association in the band label', () => {
  const agent = { name: 'Tendai' }
  const ready = { ...EMPTY, phase: 'ready' as const, dashboardUrl: DASHBOARD_URL }
  test('on a plan: the agent, then the plan', () => {
    const v = { ...ready, agent, connected: { id: 23, ref: 'PLAN-23', name: 'Danxbot plugin', dashboardUrl: DASHBOARD_URL } }
    expect(bandLabel(v)).toBe('Tendai · PLAN-23 · Danxbot plugin')
    // the plan name is what a narrow band cuts, never the agent's name
    expect(bandLabel(v, 30)).toBe('Tendai · PLAN-23 · Danxbot pl…')
  })
  test('holding a card: the agent, then the card', () => {
    expect(bandLabel({ ...ready, agent, card: CARD })).toBe('Tendai · DX-77 · One-off fix')
  })
  test('on neither: the agent, and that it is on neither', () => {
    expect(bandLabel({ ...ready, agent })).toBe('Danxbot · Tendai: not connected to a plan or card')
  })
  test('no agent held: the association alone', () => {
    expect(bandLabel({ ...ready, card: CARD })).toBe('DX-77 · One-off fix')
    expect(bandLabel(ready)).toBe('Danxbot: not connected to a plan or card')
  })
  test('DX-5549: a session the agent gate holds reads why it has no agent', () => {
    expect(bandLabel({ ...ready, agentBlock: 'agent_needed' })).toBe('Danxbot: waiting for a team agent')
    expect(bandLabel({ ...ready, agentBlock: 'agent_limit_reached' })).toBe('Danxbot: agent session limit reached')
    expect(bandLabel({ ...ready, agentBlock: 'agent_not_held' })).toBe('Danxbot: no team agent held (plan_connect claims one)')
  })
  test('the agent gate is read from its own answer, and nothing else is', () => {
    const halted = (body: unknown) => ({ ok: false, status: 0, body: { error: JSON.stringify(body) } })
    expect(agentBlockOf(halted(AGENT_GATE_HALT('agent_needed')))).toBe('agent_needed')
    expect(agentBlockOf(halted(AGENT_GATE_HALT('agent_limit_reached')))).toBe('agent_limit_reached')
    expect(agentBlockOf(halted({ state: 'agent_needed' }))).toBe(null)
    expect(agentBlockOf({ ok: false, status: 0, body: { error: 'not json' } })).toBe(null)
    // the dashboard's own refusal for a session whose agent was released: status 403, body {error, state, instruction}
    const refused = (status: number, body: unknown) => ({ ok: false, status, body })
    for (const state of ['agent_not_held', 'agent_needed', 'agent_limit_reached'] as const) {
      expect(agentBlockOf(refused(403, { error: state, state, instruction: 'Call plan_connect.' }))).toBe(state)
    }
    expect(agentBlockOf(refused(403, { error: 'agent_not_held', state: 'agent_not_held' }))).toBe(null)
    expect(agentBlockOf(refused(403, { error: 'forbidden', state: 'something_else', instruction: 'x' }))).toBe(null)
    expect(agentBlockOf(refused(409, { error: 'agent_not_held', state: 'agent_not_held', instruction: 'x' }))).toBe(null)
    expect(agentBlockOf({ ok: true, status: 200, body: { state: 'agent_not_held', instruction: 'x' } })).toBe(null)
    expect(agentBlockOf({ ok: false, status: 409, body: { error: JSON.stringify(AGENT_GATE_HALT('agent_needed')) } })).toBe(null)
  })
  test('the footer names a held card as it names a plan', () => {
    expect(footerLabel({ ...ready, agent, card: CARD })).toBe('Danxbot · DX-77')
  })
})

for (const surface of SURFACES) {
  describe(`the band reads the agent and the association on ${surface}`, () => {
    test('a plan-connected session holding an agent reads the agent and the plan', async ($, on) => {
      const d = dashboard(on)
      d.world.agent = AGENT
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await labelOf(band)).toBe('Tendai · PLAN-23 · Danxbot plugin')
    })

    test('a session holding a stand-alone card reads the card, and Open card goes to its page', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = AGENT
      d.world.card = CARD
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await labelOf(band)).toBe('Tendai · DX-77 · One-off fix')
      expect(await openLinks(band)).toEqual([{ key: 'open-tab', label: 'Open card', href: `${DASHBOARD_URL}/board/DX-77` }])
      expect(await band.find({ key: 'disconnect' })).toBeUndefined()
      expect(await footerText(await mountIndicator($, surface))).toBe('Danxbot · DX-77')
    })

    test('a signed-in session on neither reads the agent and the plans list link', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = AGENT
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await labelOf(band)).toBe('Danxbot · Tendai: not connected to a plan or card')
      expect(await openLinks(band)).toEqual([{ key: 'open-tab', label: 'Open plan', href: `${DASHBOARD_URL}/plans` }])
    })

    test('a resumed session whose agent was released reads that it holds none (never Disconnected) from the dashboard own 403 refusal', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      d.world.agentGate = 'agent_not_held'
      await forceRefresh($, d)
      expect(await labelOf(band)).toBe('Danxbot: no team agent held (plan_connect claims one)')
    })

    test('a session row whose agent is not {id, name} fails the load, never a guessed name', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      d.world.agent = { id: 6, name: '' } as any
      await forceRefresh($, d)
      expect(await labelOf(band)).toBe('Danxbot: Disconnected')
    })

    test('DX-5549: while the agent gate holds the session, the band says so (never Disconnected), the relay runs on no plan and an event wakes it', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      d.world.agentGate = 'agent_needed'
      await forceRefresh($, d)
      expect(await labelOf(band)).toBe('Danxbot: waiting for a team agent')
      expect(d.relay.calls.at(-1)?.plan_id).toBe(null)
      // the dashboard's wake once a person created the agent (the MCP turns the stream's team_agent_created into an urgent record)
      d.relay.push({ cursor: 'c1', text: 'A person created your team agent Mira: call plan_connect again to take it.', urgent: true })
      await d.clock.settle()
      expect(woken(d).some(t => t.includes('call plan_connect again to take it'))).toBe(true)
    })

    test('DX-5549: a session the agent gate holds frees nothing at its end, quietly (it holds no agent)', async ($, on) => {
      on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      d.world.agentGate = 'agent_limit_reached'
      await forceRefresh($, d)
      await $.session.end({ reason: 'logout', sessionId: 'sess-own' } as any)
      expect(d.releaseCalls).toEqual([])
      expect(d.toasts).toEqual([])
    })
  })
}
