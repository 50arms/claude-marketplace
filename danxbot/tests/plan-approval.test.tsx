// DX-4391: a signed-out session's plan_connect answers `approval_required` (the MCP server,
// DX-4390). The plugin opens the approval page once and leaves the confirm code up; every other
// answer (pending, a normal connect, a refusal, a denied call) opens nothing.
import { describe, expect, test } from 'claude-code/testing'

import { approvalRequestOf } from '../hooks/plan/approval'
import { dashboard, startSession } from './plan-kit'

const URL_A = 'https://danxbot.example/connect/aaaa'
const URL_B = 'https://danxbot.example/connect/bbbb'
const required = (url: string, code = 'NXGUF88G') =>
  JSON.stringify({ state: 'approval_required', approvalUrl: url, confirmCode: code, expiresAt: '2026-10-03T08:10:00.000Z', instruction: 'Show the code.' })
const pending = JSON.stringify({ state: 'approval_pending', approvalUrl: URL_A, confirmCode: 'NXGUF88G', expiresAt: 'x', instruction: 'Wait.' })
const connected = JSON.stringify({ ok: true, status: 200, body: { session: { plan_id: 23 } } })

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const CALL = { tool: 'mcp__danx-dashboard__plan_connect', plan_id: 23 } as any
const browserCalls = (d: any) => d.calls.filter((c: any) => c.server === 'Claude_Browser')
const navigations = (d: any) => browserCalls(d).filter((c: any) => c.tool === 'navigate' || c.tool === 'preview_start')

// The tool answers `text` the way the host reports an MCP result.
function answering(on: any, texts: string[]) {
  let i = 0
  on('tool.call', { tool: 'mcp__danx-dashboard__plan_connect' }, () => ({ result: {}, text: texts[Math.min(i++, texts.length - 1)], isError: false }) as any)
}

describe('approvalRequestOf', () => {
  test('reads only an approval_required answer with a web link and a code', () => {
    expect(approvalRequestOf(required(URL_A))).toEqual({ url: URL_A, code: 'NXGUF88G' })
    expect(approvalRequestOf(pending)).toBeNull()
    expect(approvalRequestOf(connected)).toBeNull()
    expect(approvalRequestOf('not json')).toBeNull()
    expect(approvalRequestOf(undefined)).toBeNull()
    expect(approvalRequestOf(required('javascript:alert(1)'))).toBeNull()
    expect(approvalRequestOf(required(URL_A, ''))).toBeNull()
  })
})

describe('plan_connect while signed out', () => {
  test('approval_required opens the approval page once and leaves the confirm code up', async ($, on) => {
    const d = dashboard(on, { browserClosed: true })
    answering(on, [required(URL_A)])
    await startSession($, d, 'desktop')
    d.calls.length = 0
    await $.tool.call(CALL)
    await d.clock.settle()
    expect(navigations(d).map((c: any) => c.args.url)).toEqual([URL_A])
    expect(d.toasts.at(-1)).toBe(`Approve this session in the browser. Confirm code NXGUF88G must match the page: ${URL_A}`)
    // the failure toast of a plan open never shows for this open: one toast, the outcome
    expect(d.toasts.some(t => t.startsWith('Browser '))).toBe(false)
    expect(d.toastTimeouts.at(-1)).toBe(60_000)
  })

  // The shape core gives a hook for an MCP tool (the engine's own typings, ToolCallResult): `{ ref, result, text }`
  // with `result` the tool's record (an MCP result's content blocks) and `text` the blocks joined as the model reads them.
  test('reads the answer in the shape core gives for an MCP tool: ref, result content blocks, text', async ($, on) => {
    const d = dashboard(on, { browserClosed: true })
    const text = required(URL_A)
    on('tool.call', { tool: 'mcp__danx-dashboard__plan_connect' }, () => ({ ref: 7, result: { content: [{ type: 'text', text }] }, text }) as any)
    await startSession($, d, 'desktop')
    d.calls.length = 0
    const ran = await $.tool.call(CALL)
    await d.clock.settle()
    expect(ran.text).toBe(text)
    expect(navigations(d).map((c: any) => c.args.url)).toEqual([URL_A])
    expect(d.toasts.at(-1)).toContain('NXGUF88G')
  })

  test('the open does not hold the plan_connect answer: the model reads it at once, the toast follows the open', async ($, on) => {
    const d = dashboard(on, { browserClosed: true, navigateTakesMs: 5_000 })
    answering(on, [required(URL_A)])
    await startSession($, d, 'desktop')
    let answered = false
    const call = $.tool.call(CALL).then((r: any) => {
      answered = true
      return r
    })
    await d.clock.settle()
    expect(answered).toBe(true)
    expect(d.toasts.some(t => t.includes('NXGUF88G'))).toBe(false)
    await d.clock.advance(5_000)
    await d.clock.settle()
    expect((await call).text).toBe(required(URL_A))
    expect(d.toasts.at(-1)).toContain('NXGUF88G')
  })

  test('a browser busy with another open says so, with the code and the link, and makes no browser call of its own', async ($, on) => {
    const d = dashboard(on, { browserClosed: true, navigateTakesMs: 5_000 })
    answering(on, [required(URL_A)])
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    const planOpen = band.press({ key: 'open-tab' })
    await d.clock.settle()
    const calls = browserCalls(d).length
    await $.tool.call(CALL)
    await d.clock.settle()
    expect(browserCalls(d)).toHaveLength(calls)
    expect(d.toasts.at(-1)).toBe(`Could not open the approval page (busy: another browser open is in progress). Open this link and check that confirm code NXGUF88G matches: ${URL_A}`)
    await d.clock.advance(5_000)
    await planOpen
  })

  test('the same request repeated opens nothing again; a new request opens its own page', async ($, on) => {
    const d = dashboard(on, { tabs: ['tab-1'] })
    answering(on, [required(URL_A), required(URL_A), required(URL_B, 'ZZZZ1111')])
    await startSession($, d, 'desktop')
    d.calls.length = 0
    for (let n = 0; n < 3; n++) {
      await $.tool.call(CALL)
      await d.clock.settle()
    }
    expect(navigations(d).map((c: any) => c.args.url)).toEqual([URL_A, URL_B])
    expect(d.toasts.at(-1)).toContain('ZZZZ1111')
  })

  test('a failed browser open still leaves the code and the link', async ($, on) => {
    const d = dashboard(on, { browser: 'denied' })
    answering(on, [required(URL_A)])
    await startSession($, d, 'desktop')
    await $.tool.call(CALL)
    await d.clock.settle()
    // ONE last toast carries the cause, the code and the link, for the longest the host allows
    expect(d.toasts.at(-1)).toMatch(/^Could not open the approval page \(navigate: .+\)\. Open this link and check that confirm code NXGUF88G matches: /)
    expect(d.toasts.at(-1)).toContain(URL_A)
    expect(d.toastTimeouts.at(-1)).toBe(60_000)
  })

  for (const [name, text] of [
    ['approval_pending', pending],
    ['a normal connect', connected],
    ['text that is not JSON', 'plan_connect: bad arguments'],
  ] as const) {
    test(`${name} opens nothing and shows no code`, async ($, on) => {
      const d = dashboard(on, { tabs: ['tab-1'] })
      answering(on, [text])
      await startSession($, d, 'desktop')
      d.calls.length = 0
      d.toasts.length = 0
      await $.tool.call(CALL)
      await d.clock.settle()
      expect(browserCalls(d)).toEqual([])
      expect(d.toasts.filter(t => /Confirm code|approval/i.test(t))).toEqual([])
    })
  }

  test('a denied call opens nothing', async ($, on) => {
    const d = dashboard(on, { tabs: ['tab-1'] })
    on('tool.call', { tool: 'mcp__danx-dashboard__plan_connect' }, () => ({ deny: 'plan_connect is not available' }) as any)
    await startSession($, d, 'desktop')
    d.calls.length = 0
    await $.tool.call(CALL)
    await d.clock.settle()
    expect(browserCalls(d)).toEqual([])
  })
})
