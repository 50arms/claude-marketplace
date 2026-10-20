// DX-4805: in auto mode the engine's classifier can refuse the plugin's own hook-initiated `$.mcp.call` ("gave no verdict"), which leaves the
// relay dead. The plugin ships the permission its own calls need (a `tool.check` allow for calls IT raised) and, when a refusal still happens,
// says so loudly with the engine's real words and the real fix, never "update the plugin".
import { describe, expect } from 'claude-code/testing'

import { toolName } from '../hooks/plan/config'
import { ownServerCheck, raisedByPlugin } from '../hooks/relay/refusal'
import { BACKOFF_MS } from '../hooks/relay/config'
import { test, CLASSIFIER_REFUSAL, DASHBOARD_URL, SURFACES, dashboard, footerText, forceRefresh, linksOf, mountIndicator, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 100 } } as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const ENGINE_WORDS = `danxbot: $.mcp.call(plugin:danxbot:danx-dashboard, plan_events_wait) refused: ${CLASSIFIER_REFUSAL}`
const LOUD = /^\[danxbot plan event\] events delayed: events are NOT reaching this session: .*auto mode classifier gave no verdict.*Fix: .*mcp__plugin_danxbot_danx-dashboard__\*.*it then resumes on its own \(restart if not\)\.$/
const NAMES_START = /the person runs \/danxbot:start \(or you load its skill\), which adds the allow rule \S+ once the person says yes, or the person adds it to permissions\.allow in ~\/\.claude\/settings\.json/
const NOT_THE_FIX = /\b(update[ds]?|updating|reinstall(ing)?)\b(?!( the plugin)? does not)/i

const LEFT = JSON.stringify({ ok: true, status: 200, body: { session: { planId: null } } })
const MODEL_CONNECTED = JSON.stringify({ ok: true, status: 200, body: { session: { planId: 23, planName: 'Plan twenty-three' } } })
// DX-4982: the words the person reads, whole, and nothing of the engine's raw refusal in them
const SAID = "Auto mode is blocking Danxbot's calls. Run /danxbot:start to allow them; this clears by itself, or restart the session if it does not."
const RAW = /\$\.mcp\.call|refused:|classifier gave no verdict|Sign in failed|Disconnected/

for (const surface of SURFACES) {
  describe(`a classifier refusal on ${surface}`, () => {
    test('a refused wait keeps the relay retrying: the band says the sentence, ONE transcript line carries the engine words and the fix, and it resumes by itself', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.script.push(() => ({ deny: ENGINE_WORDS }) as any)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      // DX-5232: the band says the relay is retrying; the reason (the sentence and fix) is toasted on the change into that state
      expect(await text(band)).toContain('relay retrying')
      // the whole sentence fits the toast (TOAST_ERROR_MAX), none of it cut
      expect(d.toasts).toContain(`events: relay retrying. ${SAID}`)
      expect(d.toasts.join(' | ')).not.toMatch(RAW)
      expect(d.relay.told).toHaveLength(1)
      expect(d.relay.told[0]).toMatch(LOUD)
      expect(d.relay.told[0]).not.toMatch(NOT_THE_FIX)
      expect(d.relay.told[0]).toMatch(NAMES_START)
      // DX-4982: no halt, so the next wait (the script is spent) goes through with nothing more told
      await d.clock.advance(BACKOFF_MS[BACKOFF_MS.length - 1]! * 3)
      expect(d.relay.calls.length).toBeGreaterThan(1)
      expect(d.relay.told).toHaveLength(1)
    })

    test('a refused first read: the band says the cause and the fix (never Disconnected or a raw refusal), the session is told once, and the view clears by itself once calls are allowed', async ($, on) => {
      const d = dashboard(on, { mcp: 'refused' })
      await startSession($, d, surface)
      expect(d.relay.calls).toHaveLength(0)
      expect(d.relay.told).toHaveLength(1)
      expect(d.relay.told[0]).toMatch(LOUD)
      expect(d.relay.told[0]).not.toMatch(NOT_THE_FIX)
      // the start's own retries keep reading (the refusal may clear) without telling it again
      await d.clock.advance(120_000)
      expect(d.relay.told).toHaveLength(1)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const said = await text(band)
      expect(said).toContain(SAID)
      expect(said).not.toMatch(RAW)
      expect(await text(band)).toContain('Danxbot: blocked by auto mode')
      // the footer says it too (never the bare brand)
      expect(await footerText(await mountIndicator($, surface))).toBe('Danxbot: blocked by auto mode')
      expect(await band.find({ key: 'sign-in' })).toBeFalsy()
      expect(d.toasts.join(' | ')).not.toMatch(RAW)
      // the rule is added: the next calls succeed, and the band shows the plan with no restart and no press
      d.setMcp('up')
      await d.clock.advance(300_000)
      expect(await text(band)).toContain('PLAN-23')
      expect(await text(band)).not.toContain(SAID)
    })

    // a model that connected plan 23 while every read of the plugin's own is refused (no origin has ever been read)
    async function modelConnected($: any, on: any, d: any) {
      on('tool.call', { tool: toolName('plan_connect') }, (_$: any, e: any) => ({ result: {}, text: e.disconnect === true ? LEFT : MODEL_CONNECTED, isError: false }) as any)
      await startSession($, d, surface)
      await $.tool.call({ tool: toolName('plan_connect'), plan_id: 23 } as any)
      await d.clock.settle()
      return $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
    }

    test("the model's own successful plan_connect names its plan in the band while the plugin's own reads are refused, and the footer says it", async ($, on) => {
      const d = dashboard(on, { mcp: 'refused' })
      d.setEnv('DANXBOT_PLUGIN_DASHBOARD_URL', DASHBOARD_URL)
      const band = await modelConnected($, on, d)
      const said = await text(band)
      expect(said).toContain('PLAN-23 · Plan twenty-three')
      expect(said).toContain(SAID)
      expect(said).not.toMatch(RAW)
      expect(await footerText(await mountIndicator($, surface))).toBe('Danxbot · PLAN-23')
      // the link is built on the configured dashboard, never on a null origin
      expect((await linksOf(band)).map(l => l.href)).toContain(`${DASHBOARD_URL}/plans/23`)
      expect(d.toasts.join(' | ')).not.toMatch(RAW)
    })

    test('with no dashboard origin known anywhere, the band names the plan but draws no link to it (never null/plans/23)', async ($, on) => {
      const d = dashboard(on, { mcp: 'refused' })
      const band = await modelConnected($, on, d)
      expect(await text(band)).toContain(SAID)
      const hrefs = (await linksOf(band)).map(l => l.href)
      expect(hrefs.filter(h => /null|undefined/.test(h))).toEqual([])
      expect(hrefs.filter(h => h.includes('/plans/23'))).toEqual([])
    })

    test("the model's own leave drops the plan it named: the blocked band names no plan afterwards", async ($, on) => {
      const d = dashboard(on, { mcp: 'refused' })
      d.setEnv('DANXBOT_PLUGIN_DASHBOARD_URL', DASHBOARD_URL)
      const band = await modelConnected($, on, d)
      expect(await text(band)).toContain('PLAN-23')
      await $.tool.call({ tool: toolName('plan_connect'), plan_id: 23, disconnect: true } as any)
      await d.clock.settle()
      expect(await text(band)).not.toContain('PLAN-23')
      expect(await text(band)).toContain('Danxbot: blocked by auto mode')
    })

    test('a press the engine refuses (Disconnect) toasts the sentence, never the raw text, and reloads the view', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await text(band)).toContain('PLAN-23')
      d.setMcp('refused')
      await band.press({ key: 'disconnect' })
      await d.clock.settle()
      expect(d.toasts).toContain(SAID)
      expect(d.toasts.join(' | ')).not.toMatch(RAW)
      expect(await text(band)).toContain(SAID)
    })

    test('a loaded view clears the plan the model named: a later block does not name it again', async ($, on) => {
      const d = dashboard(on, { mcp: 'refused' })
      d.setEnv('DANXBOT_PLUGIN_DASHBOARD_URL', DASHBOARD_URL)
      const band = await modelConnected($, on, d)
      expect(await text(band)).toContain('Plan twenty-three')
      d.setMcp('up')
      await d.clock.advance(300_000)
      d.relay.server.wake?.()
      await d.clock.settle()
      const loaded = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await text(loaded)).not.toContain('blocked by auto mode')
      d.setMcp('refused')
      await forceRefresh($, d)
      const blocked = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await text(blocked)).toContain('Danxbot: blocked by auto mode')
      expect(await text(blocked)).not.toContain('Plan twenty-three')
    })

    test('a /clear drops the plan the model named in the conversation it ended', async ($, on) => {
      const d = dashboard(on, { mcp: 'refused' })
      d.setEnv('DANXBOT_PLUGIN_DASHBOARD_URL', DASHBOARD_URL)
      on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
      const band = await modelConnected($, on, d)
      expect(await text(band)).toContain('Plan twenty-three')
      await $.session.end({ reason: 'clear', sessionId: 'old' } as any)
      await forceRefresh($, d)
      const after = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await text(after)).toContain(SAID)
      expect(await text(after)).not.toContain('Plan twenty-three')
    })

    test('an events-less wait answer on a blocked view replaces it with a real load', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      d.setMcp('refused')
      await forceRefresh($, d)
      expect(await text(band)).toContain(SAID)
      d.setMcp('up')
      // the relay's held wait comes back with no events (its timeout): that alone proves the calls are allowed
      d.relay.server.wake?.()
      await d.clock.settle()
      expect(await text(band)).not.toContain(SAID)
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

  // DX-5093: the three pane tools the plan-tab keepalive calls, raised by this plugin only
  test("the keepalive's three Browser pane tools are allowed for a call the plugin raised, and no other pane tool is", async () => {
    for (const tool of ['tabs_context', 'tabs_create', 'navigate']) {
      expect((await ownServerCheck({ tool: `mcp__Claude_Browser__${tool}` }, nextOf('danxbot', 'ask'))).decision).toBe('allow')
      expect((await ownServerCheck({ tool: `mcp__Claude_Browser__${tool}` }, nextOf('engine', 'ask'))).reason).toBe('engine')
      expect((await ownServerCheck({ tool: `mcp__Claude_Browser__${tool}` }, nextOf('danxbot', 'deny'))).decision).toBe('deny')
    }
    expect((await ownServerCheck({ tool: 'mcp__Claude_Browser__computer' }, nextOf('danxbot', 'ask'))).reason).toBe('engine')
  })
})

describe('raisedByPlugin (DX-4857)', () => {
  test('the engine is not a plugin; danxbot and any other plugin are', () => {
    expect(raisedByPlugin({ plugin: 'engine' })).toBe(false)
    expect(raisedByPlugin({ plugin: 'danxbot' })).toBe(true)
    expect(raisedByPlugin({ plugin: 'someone-else' })).toBe(true)
  })
})
