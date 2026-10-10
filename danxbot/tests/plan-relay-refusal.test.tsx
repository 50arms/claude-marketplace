// DX-4805: in auto mode the engine's classifier can refuse the plugin's own hook-initiated `$.mcp.call` ("gave no verdict"), which leaves the
// relay dead. The plugin ships the permission its own calls need (a `tool.check` allow for calls IT raised) and, when a refusal still happens,
// says so loudly with the engine's real words and the real fix, never "update the plugin".
import { describe, expect, test } from 'claude-code/testing'

import { toolName } from '../hooks/plan/config'
import { ownServerCheck } from '../hooks/relay/refusal'
import { BACKOFF_MS } from '../hooks/relay/config'
import { CLASSIFIER_REFUSAL, SURFACES, dashboard, startSession } from './plan-kit'

const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const ENGINE_WORDS = `danxbot: $.mcp.call(plugin:danxbot:danx-dashboard, plan_events_wait) refused: ${CLASSIFIER_REFUSAL}`
const LOUD = /^\[danxbot plan event\] events stopped: events are NOT reaching this session: .*auto mode classifier gave no verdict.*Fix: .*mcp__plugin_danxbot_danx-dashboard__\*.*restart the session\.$/
const NOT_THE_FIX = /(update[ds]?|updating|reinstall(ing)?)(?! does not)/i

for (const surface of SURFACES) {
  describe(`a classifier refusal on ${surface}`, () => {
    test('a refused wait stops the relay: the pane and ONE transcript line carry the refusal and the allow-rule fix, and it does not retry', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.script.push(() => ({ deny: ENGINE_WORDS }) as any)
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('auto mode classifier refused the plugin')
      expect(d.relay.told).toHaveLength(1)
      expect(d.relay.told[0]).toMatch(LOUD)
      expect(d.relay.told[0]).not.toMatch(NOT_THE_FIX)
      await d.clock.advance(BACKOFF_MS[BACKOFF_MS.length - 1]! * 3)
      expect(d.relay.calls).toHaveLength(1)
      expect(d.relay.told).toHaveLength(1)
    })

    test('a refused first read (the relay never starts): the session is told once, and the view says the refusal and the fix', async ($, on) => {
      const d = dashboard(on, { mcp: 'refused' })
      await startSession($, d, surface)
      expect(d.relay.calls).toHaveLength(0)
      expect(d.relay.told).toHaveLength(1)
      expect(d.relay.told[0]).toMatch(LOUD)
      expect(d.relay.told[0]).not.toMatch(NOT_THE_FIX)
      // the start's own retries keep reading (the refusal may clear) without telling it again
      await d.clock.advance(120_000)
      expect(d.relay.told).toHaveLength(1)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('mcp__plugin_danxbot_danx-dashboard__*')
    })
  })
}

describe('the plugin ships the permission its own calls need', () => {
  const own = toolName('plan_events_wait')
  const nextOf = (plugin: string, engine: 'allow' | 'ask' | 'deny') => Object.assign(async () => ({ decision: engine, reason: 'engine' }), { origin: { plugin } }) as any

  test("a call the plugin raised on its own server's tools is allowed where the engine would ask", async () => {
    expect((await ownServerCheck({ tool: own }, nextOf('danxbot', 'ask'))).decision).toBe('allow')
  })

  test('a deny from the engine (a user rule, an organization rule) stays a deny', async () => {
    expect(await ownServerCheck({ tool: own }, nextOf('danxbot', 'deny'))).toEqual({ decision: 'deny', reason: 'engine' })
  })

  test("an organization ceiling of ask stands: the plugin's allow does not lift it", async () => {
    expect((await ownServerCheck({ tool: own, ceiling: 'ask' }, nextOf('danxbot', 'ask'))).decision).toBe('ask')
  })

  test("the model's call (origin engine), another plugin's call and other tools keep the engine's verdict", async () => {
    expect((await ownServerCheck({ tool: own }, nextOf('engine', 'ask'))).reason).toBe('engine')
    expect((await ownServerCheck({ tool: own }, nextOf('someone-else', 'ask'))).reason).toBe('engine')
    expect((await ownServerCheck({ tool: 'Bash' }, nextOf('danxbot', 'ask'))).reason).toBe('engine')
    expect((await ownServerCheck({ tool: 'mcp__plugin_other_server__plan_events_wait' }, nextOf('danxbot', 'ask'))).reason).toBe('engine')
  })
})
