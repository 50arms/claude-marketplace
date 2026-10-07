// DX-4391: a signed-out session's plan_connect answers `approval_required` (the MCP server,
// DX-4390). The plugin draws the approval link and confirm code at once (DX-4630, no browser call); every other
// answer (a normal connect, a refusal, a denied call) shows nothing.
import { describe, expect, test } from 'claude-code/testing'

import { approvalRequestOf, signInToast } from '../hooks/plan/approval'
import { APPROVAL_TOAST_MS } from '../hooks/plan/config'
import { dashboard, startSession, browserCalls, linksOf } from './plan-kit'

const URL_A = 'https://danxbot.example/connect/aaaa'
const URL_B = 'https://danxbot.example/connect/bbbb'
const required = (url: string, code = 'NXGUF88G') =>
  JSON.stringify({ state: 'approval_required', approvalUrl: url, confirmCode: code, expiresAt: '2026-10-03T08:10:00.000Z', instruction: 'Show the code.' })
const pending = JSON.stringify({ state: 'approval_pending', approvalUrl: URL_A, confirmCode: 'NXGUF88G', expiresAt: 'x', instruction: 'Wait.' })
const connected = JSON.stringify({ ok: true, status: 200, body: { session: { plan_id: 23 } } })

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const CALL = { tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect', plan_id: 23 } as any

// DX-4548: the plugin waits on a request the model's plan_connect started, through the MCP: the stand-in MCP answers the same
// request as still pending, so the wait stays open and tells the model nothing.
const stillPending = (d: any) => void (d.world.signIn.answer = { text: pending, waits: true })

// The tool answers `text` the way the host reports an MCP result.
function answering(on: any, texts: string[]) {
  let i = 0
  on('tool.call', { tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect' }, () => ({ result: {}, text: texts[Math.min(i++, texts.length - 1)], isError: false }) as any)
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
  // DX-4630: the link and code are shown the moment the request exists; no browser call is made for them, so a slow or refused
  // browser cannot delay or hide them.
  test('approval_required toasts the link and the confirm code with no browser call, whatever the browser would have done', async ($, on) => {
    const d = dashboard(on, { signedOut: 'signed-out' })
    stillPending(d)
    answering(on, [required(URL_A)])
    await startSession($, d, 'desktop')
    d.calls.length = 0
    await $.tool.call(CALL)
    await d.clock.settle()
    expect(browserCalls(d)).toEqual([])
    expect(d.toasts.at(-1)).toBe(signInToast({ url: URL_A, code: 'NXGUF88G' }))
    expect(d.toastTimeouts.at(-1)).toBe(APPROVAL_TOAST_MS)
  })

  // The shape core gives a hook for an MCP tool (the engine's own typings, ToolCallResult): `{ ref, result, text }`
  // with `result` the tool's record (an MCP result's content blocks) and `text` the blocks joined as the model reads them.
  test('reads the answer in the shape core gives for an MCP tool: ref, result content blocks, text', async ($, on) => {
    const d = dashboard(on, { signedOut: 'signed-out' })
    stillPending(d)
    const text = required(URL_A)
    on('tool.call', { tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect' }, () => ({ ref: 7, result: { content: [{ type: 'text', text }] }, text }) as any)
    await startSession($, d, 'desktop')
    d.calls.length = 0
    const ran = await $.tool.call(CALL)
    await d.clock.settle()
    expect(ran.text).toBe(text)
    expect(browserCalls(d)).toEqual([])
    expect(d.toasts.at(-1)).toContain('NXGUF88G')
  })

  // DX-4630: the model learns the person already has the link and code, so it opens nothing itself.
  test('the model is told the band already shows the link and code, and not to open it', async ($, on) => {
    const d = dashboard(on, { signedOut: 'signed-out' })
    stillPending(d)
    answering(on, [required(URL_A)])
    await startSession($, d, 'desktop')
    const ran = await $.tool.call(CALL)
    await d.clock.settle()
    expect(ran.text).toBe(required(URL_A))
    // DX-4234: the time stamp rides on every tool call too; the sign-in note is the other entry
    const note = ran.context.filter((c: string) => c.includes('approval link'))
    expect(note).toHaveLength(1)
    expect(note[0]).toContain('already shows the person the approval link')
    expect(note[0]).toContain('Do not open the link yourself')
    expect(note[0]).toContain('NXGUF88G')
  })

  test('the same request repeated shows its toast once; a new request swaps the link and the code', async ($, on) => {
    const d = dashboard(on, { signedOut: 'signed-out' })
    stillPending(d)
    answering(on, [required(URL_A), required(URL_A), required(URL_B, 'ZZZZ1111')])
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    d.calls.length = 0
    d.toasts.length = 0
    await $.tool.call(CALL)
    await $.tool.call(CALL)
    await d.clock.settle()
    expect(d.toasts.filter(t => t.includes('NXGUF88G'))).toHaveLength(1)
    await $.tool.call(CALL)
    await d.clock.settle()
    expect(d.toasts.at(-1)).toContain('ZZZZ1111')
    expect(browserCalls(d)).toEqual([])
    const hrefs = (await linksOf(band)).map(l => l.href)
    expect(hrefs).toContain(URL_B)
    expect(hrefs).not.toContain(URL_A)
    expect((await band.findAll({ type: 'Text' })).map((t: any) => t.text)).toContain('code ZZZZ1111')
  })

  // DX-4548: a request is shown by its URL, not by the answer's state: one this session has not shown appears even as approval_pending
  test('approval_pending of a request not yet shown shows its link and code', async ($, on) => {
    const d = dashboard(on)
    answering(on, [pending])
    await startSession($, d, 'desktop')
    d.calls.length = 0
    await $.tool.call(CALL)
    await d.clock.settle()
    expect(browserCalls(d)).toEqual([])
    expect(d.toasts.some(t => t.includes('NXGUF88G') && t.includes(URL_A))).toBe(true)
  })

  for (const [name, text] of [
    ['a normal connect', connected],
    ['text that is not JSON', 'plan_connect: bad arguments'],
  ] as const) {
    test(`${name} opens nothing and shows no code`, async ($, on) => {
      const d = dashboard(on)
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
    const d = dashboard(on)
    on('tool.call', { tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect' }, () => ({ deny: 'plan_connect is not available' }) as any)
    await startSession($, d, 'desktop')
    d.calls.length = 0
    await $.tool.call(CALL)
    await d.clock.settle()
    expect(browserCalls(d)).toEqual([])
  })
})
