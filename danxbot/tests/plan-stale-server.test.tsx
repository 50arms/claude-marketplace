// DX-4610: plugin 0.12.58 deleted the plugin server's standby mode, but a session started before it keeps the standby process it started
// (a session hot-reloads hooks, never MCP servers). The new hooks call only the plugin's server, and the standby one lists no tool
// (tests/old-standby-shape.test.mjs pins that against the real old server shape), so every call fails with the engine's ordinary
// "no connected MCP tool" rejection: the same one a server that has not connected yet gives. What tells them apart is the session's
// tool list (`$.tool.list`): only a session whose plugin server is the old standby has the repo's own `danx-dashboard` tools and none of the plugin's.
// Such a session is told, in one plain line, to restart. It is never told so while it merely waits for a connection.
import { describe, expect, test } from 'claude-code/testing'

import { RESTART_LINE, START_RETRY_MS, STALE_GRACE_MS } from '../hooks/plan/config'
import { PACING_REFRESH_MS, resetPacing } from '../hooks/plan/pacing-line'
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

  test('it is not told to restart once its server answers: the next refresh clears the band, the pane and the pacing toast', async ($, on) => {
    resetPacing()
    const d = dashboard(on, { mcp: 'stale' })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    d.setMcp('up')
    await d.clock.advance(START_RETRY_MS[0])
    expect(await text(band)).toContain('PLAN-23 · Danxbot plugin')
    expect(await text(band)).not.toContain('Restart')
    expect(await text(pane)).not.toContain(RESTART_LINE)
    await d.clock.advance(STALE_GRACE_MS + PACING_REFRESH_MS)
    expect(d.toasts.filter(t => t.includes(RESTART_LINE))).toEqual([])
  })

  test('pacing says so once, only after the start retries have run out, instead of staying silent', async ($, on) => {
    resetPacing()
    const d = dashboard(on, { mcp: 'stale' })
    await startSession($, d, 'desktop')
    // a fresh session of an old checkout may just be waiting for its server: no toast inside the grace
    expect(d.toasts.filter(t => t.includes(RESTART_LINE))).toEqual([])
    await d.clock.advance(START_RETRY_MS[0])
    expect(d.toasts.filter(t => t.includes(RESTART_LINE))).toEqual([])
    // the first read after the grace has passed (the next minute tick) is the one that tells
    await d.clock.advance(PACING_REFRESH_MS)
    expect(d.toasts.filter(t => t.startsWith('Usage pacing could not be read') && t.includes(RESTART_LINE))).toHaveLength(1)
    await d.clock.advance(PACING_REFRESH_MS)
    expect(d.toasts.filter(t => t.includes(RESTART_LINE))).toHaveLength(1)
  })
})

describe('a session whose plugin server has simply not connected yet', () => {
  test('both servers listing their tools while the call is refused is not the standby: Disconnected, never restart', async ($, on) => {
    const d = dashboard(on, { mcp: 'down', toolList: 'both' })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    expect(await text(band)).toContain('Disconnected')
    expect(await text(band)).not.toContain('Restart')
  })

  test('a tool list that cannot be read leaves the plain Disconnected failure, with the call error shown', async ($, on) => {
    const d = dashboard(on, { mcp: 'down', toolList: 'rejects' })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    expect(await text(band)).toContain('Disconnected')
    expect(await text(pane)).toContain('no connected MCP tool')
  })

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
