// DX-4610: plugin 0.12.58 deleted the plugin server's standby mode, but a session started before it keeps the standby process it started
// (a session hot-reloads hooks, never MCP servers). The new hooks call only the plugin's server, and the standby one lists no tool
// (tests/old-standby-shape.test.mjs pins that against the real old server shape), so every call fails with the engine's ordinary
// "no connected MCP tool" rejection: the same one a server that has not connected yet gives. What tells them apart is the session's
// tool list (`$.tool.list`): only a session whose plugin server is the old standby has the repo's own `danx-dashboard` tools and none of the plugin's.
// Such a session is told, in one plain line, to restart. It is never told so while it merely waits for a connection.
import { describe, expect, test } from 'claude-code/testing'

import { RESTART_LINE, START_RETRY_MS } from '../hooks/plan/config'
import { resetPacing } from '../hooks/plan/pacing-line'
import { dashboard, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = { component: 'Pane', requestId: 'danx-plan', props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' } } as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')

describe('a session that runs the old standby plugin server', () => {
  test('the band and the pane say to restart this session, not a bare Disconnected', async ($, on) => {
    const d = dashboard(on, { mcp: 'stale' })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    expect(await text(band)).toContain('Restart to reconnect')
    expect(await text(band)).not.toContain('Disconnected')
    expect(await text(pane)).toContain(RESTART_LINE)
  })

  test('it is not told to restart once its server answers: the next refresh clears it', async ($, on) => {
    const d = dashboard(on, { mcp: 'stale' })
    await startSession($, d, 'desktop')
    d.setMcp('up')
    await d.clock.advance(START_RETRY_MS[0])
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    expect(await text(band)).toContain('PLAN-23 · Danxbot plugin')
    expect(await text(band)).not.toContain('Restart')
  })

  test('pacing says so once, at session start, instead of staying silent', async ($, on) => {
    resetPacing()
    const d = dashboard(on, { mcp: 'stale' })
    await startSession($, d, 'desktop')
    await d.clock.advance(START_RETRY_MS[0])
    expect(d.toasts.filter(t => t.startsWith('Usage pacing could not be read') && t.includes(RESTART_LINE))).toHaveLength(1)
  })
})

describe('a session whose plugin server has simply not connected yet', () => {
  test('is never told to restart: it reads Disconnected and keeps retrying', async ($, on) => {
    const d = dashboard(on, { mcp: 'down' })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    expect(await text(band)).toContain('Disconnected')
    expect(await text(band)).not.toContain('Restart')
    expect(await text(pane)).not.toContain(RESTART_LINE)
  })

  test('pacing stays quiet about it', async ($, on) => {
    resetPacing()
    const d = dashboard(on, { mcp: 'down' })
    await startSession($, d, 'desktop')
    expect(d.toasts.filter(t => t.includes('Restart'))).toEqual([])
  })
})
