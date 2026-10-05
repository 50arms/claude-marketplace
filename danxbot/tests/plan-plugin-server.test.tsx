// DX-4555: a session whose only dashboard MCP server is the danxbot plugin's own (`plugin:danxbot:danx-dashboard`, the name
// `claude mcp list` shows) still loads the plan, and its plan_connect / request_permission calls reach the listeners.
import { describe, expect, test } from 'claude-code/testing'

import { SERVERS, toolName } from '../hooks/plan/config'
import { dashboard, startSession } from './plan-kit'

const PLUGIN_SERVER = 'plugin:danxbot:danx-dashboard'
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any

describe('the plugin-provided dashboard server', () => {
  test('SERVERS names the project server first and the plugin server last, and toolName spells each as the session does', () => {
    expect(SERVERS).toEqual(['danx-dashboard', PLUGIN_SERVER])
    expect(toolName('danx-dashboard', 'plan_connect')).toBe('mcp__danx-dashboard__plan_connect')
    expect(toolName(PLUGIN_SERVER, 'plan_connect')).toBe('mcp__plugin_danxbot_danx-dashboard__plan_connect')
  })

  test('with only the plugin server connected the plan loads through it', async ($, on) => {
    const d = dashboard(on, { server: PLUGIN_SERVER })
    await startSession($, d, 'desktop')
    const servers = new Set(d.calls.filter((c: any) => c.tool === 'danxbot_api').map((c: any) => c.server))
    expect(servers).toEqual(new Set(['danx-dashboard', PLUGIN_SERVER]))
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    expect(await text(band)).not.toMatch(/no dashboard|unreachable/i)
    expect(d.api.length).toBeGreaterThan(0)
  })

  test('with only the project server connected the plugin name is never called', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    expect(d.calls.some((c: any) => c.server === PLUGIN_SERVER)).toBe(false)
    expect(d.api.length).toBeGreaterThan(0)
  })
})
