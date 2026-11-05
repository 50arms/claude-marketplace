import "./run-tests-with-npm-test.generated"
// DX-4578: the 50 Arms plugin's own server (`plugin:50arms:platform`, the name `claude mcp list` shows) is the dashboard server of an operator session: the plan loads through it, its
// plan_connect / request_permission calls reach the listeners, and a session where it is not connected shows the load's error (tests/plan-lifecycle.test.tsx), never a "not available"
// state. A 50 Arms-dispatched agent has the server under the name `platform` instead (hooks/plan/server.ts); tests/pacing-guard.test.tsx holds what reaches it.
import { describe, expect } from 'claude-code/testing'

import { DISPATCHED_SERVER, SERVER, serverToolName, toolName } from '../hooks/plan/config'
import { serverOf } from '../hooks/plan/server'
import { test, dashboard, startSession } from './plan-kit'

describe('the plugin-provided dashboard server', () => {
  test('SERVER is the name Claude Code gives a plugin server, and toolName spells its tools as the session does', () => {
    expect(SERVER).toBe('plugin:50arms:platform')
    expect(toolName('plan_connect')).toBe('mcp__plugin_50arms_platform__plan_connect')
  })

  test('the plan loads through the plugin server and no other name is called', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    expect(new Set(d.calls.filter((c: any) => c.tool === '50arms_api').map((c: any) => c.server))).toEqual(new Set([SERVER]))
    expect(d.api.length).toBeGreaterThan(0)
  })

  test('a dispatched agent has the dashboard server under its own name, which serverOf finds by its 50arms_api tool', () => {
    expect(DISPATCHED_SERVER).toBe('platform')
    expect(serverToolName(DISPATCHED_SERVER, '50arms_api')).toBe('mcp__platform__50arms_api')
    expect(serverOf(['Read', 'mcp__platform__50arms_api', 'mcp__platform__plan_connect'])).toBe(DISPATCHED_SERVER)
    expect(serverOf([toolName('50arms_api')])).toBe(SERVER)
    // both listed: the plugin's own wins
    expect(serverOf(['mcp__platform__50arms_api', toolName('50arms_api')])).toBe(SERVER)
  })

  test('neither server listed, or only another tool of one: no server', () => {
    expect(serverOf([])).toBeNull()
    expect(serverOf(['Read', 'mcp__Claude_Browser__navigate', 'mcp__platform__plan_connect'])).toBeNull()
  })
})
