// DX-4578: the danxbot plugin's own server (`plugin:danxbot:danx-dashboard`, the name `claude mcp list` shows) is the dashboard server of an operator session: the plan loads through it, its
// plan_connect / request_permission calls reach the listeners, and a session where it is not connected shows the load's error (tests/plan-lifecycle.test.tsx), never a "not available"
// state. A danxbot-dispatched agent has the server under the name `danx-dashboard` instead (hooks/plan/server.ts); tests/pacing-guard.test.tsx holds what reaches it.
import { describe, expect } from 'claude-code/testing'

import { DISPATCHED_SERVER, SERVER, serverToolName, toolName } from '../hooks/plan/config'
import { serverOf } from '../hooks/plan/server'
import { test, dashboard, startSession } from './plan-kit'

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

  test('a dispatched agent has the dashboard server under its own name, which serverOf finds by its danxbot_api tool', () => {
    expect(DISPATCHED_SERVER).toBe('danx-dashboard')
    expect(serverToolName(DISPATCHED_SERVER, 'danxbot_api')).toBe('mcp__danx-dashboard__danxbot_api')
    expect(serverOf(['Read', 'mcp__danx-dashboard__danxbot_api', 'mcp__danx-dashboard__plan_connect'])).toBe(DISPATCHED_SERVER)
    expect(serverOf([toolName('danxbot_api')])).toBe(SERVER)
    // both listed: the plugin's own wins
    expect(serverOf(['mcp__danx-dashboard__danxbot_api', toolName('danxbot_api')])).toBe(SERVER)
  })

  test('neither server listed, or only another tool of one: no server', () => {
    expect(serverOf([])).toBeNull()
    expect(serverOf(['Read', 'mcp__Claude_Browser__navigate', 'mcp__danx-dashboard__plan_connect'])).toBeNull()
  })
})
