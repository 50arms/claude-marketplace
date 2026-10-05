// DX-4578: the danxbot plugin's own server (`plugin:danxbot:danx-dashboard`, the name `claude mcp list` shows) is the one dashboard
// server of every session: the plan loads through it, its plan_connect / request_permission calls reach the listeners, and a
// session where it is not connected shows the load's error (tests/plan-lifecycle.test.tsx), never a "not available" state.
import { describe, expect, test } from 'claude-code/testing'

import { SERVER, toolName } from '../hooks/plan/config'
import { dashboard, startSession } from './plan-kit'

describe('the plugin-provided dashboard server', () => {
  test('SERVER is the name Claude Code gives a plugin server, and toolName spells its tools as the session does', () => {
    expect(SERVER).toBe('plugin:danxbot:danx-dashboard')
    expect(toolName('plan_connect')).toBe('mcp__plugin_danxbot_danx-dashboard__plan_connect')
  })

  test('the plan loads through the plugin server and no other name is called', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    expect(new Set(d.calls.filter((c: any) => c.tool === 'danxbot_api').map((c: any) => c.server))).toEqual(new Set([SERVER]))
    expect(d.api.length).toBeGreaterThan(0)
  })
})
