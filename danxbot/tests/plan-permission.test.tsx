// DX-4435 (parent DX-4432): the model's `request_permission` (danx-dashboard MCP, DX-4434) answers at once with an approval URL and
// confirm code. The plugin opens that page once and toasts the code and the permissions asked for, the band counts the requests
// still open and a press opens the newest one's page, and a request leaves the count when it is decided or expires.
import { describe, expect, test } from 'claude-code/testing'

import { permissionRequestOf } from '../hooks/plan/permission'
import { dashboard, startSession } from './plan-kit'

const URL_A = 'https://danxbot.example/connect/aaaa'
const URL_B = 'https://danxbot.example/connect/bbbb'
const answer = (state: string, url: string, code: string, expiresAt = '2026-10-03T08:10:00.000Z') =>
  JSON.stringify({ state, approvalUrl: url, confirmCode: code, expiresAt, instruction: 'Show the code.' })
const TOOL = 'mcp__danx-dashboard__request_permission'
const CALL = (permissions: string[]) => ({ tool: TOOL, permissions, reason: 'to read members' }) as any
const BAND = { plugin: 'danxbot', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } } as any
const navigations = (d: any) => d.calls.filter((c: any) => c.server === 'Claude_Browser' && (c.tool === 'navigate' || c.tool === 'preview_start'))
const claims = (d: any) => d.api.filter((a: any) => /\/claim$/.test(a.path))

function answering(on: any, texts: string[]) {
  let i = 0
  on('tool.call', { tool: TOOL }, () => ({ result: {}, text: texts[Math.min(i++, texts.length - 1)], isError: false }) as any)
}

describe('permissionRequestOf', () => {
  test('reads a required or pending answer with the permissions asked for; anything else is null', () => {
    const want = { url: URL_A, code: 'CODE1', publicId: 'aaaa', permissions: ['team.members.view'], expiresAt: Date.parse('2026-10-03T08:10:00.000Z') }
    expect(permissionRequestOf(answer('approval_required', URL_A, 'CODE1'), ['team.members.view'])).toEqual(want)
    expect(permissionRequestOf(answer('approval_pending', URL_A, 'CODE1'), ['team.members.view'])).toEqual(want)
    expect(permissionRequestOf(answer('approval_required', URL_A, 'CODE1'), undefined)?.permissions).toEqual([])
    expect(permissionRequestOf(answer('approval_required', URL_A, 'CODE1', 'soon'), [])).toBeNull()
    expect(permissionRequestOf(JSON.stringify({ ok: false, status: 400, body: { error: 'already_held' } }), [])).toBeNull()
    expect(permissionRequestOf('Not signed in to the danxbot dashboard.', [])).toBeNull()
    expect(permissionRequestOf(undefined, [])).toBeNull()
  })
})

describe('request_permission', () => {
  test('opens the approval page once and toasts the code and the permissions asked for', async ($, on) => {
    const d = dashboard(on, { browserClosed: true })
    answering(on, [answer('approval_required', URL_A, 'CODE1'), answer('approval_pending', URL_A, 'CODE1')])
    await startSession($, d, 'desktop')
    d.calls.length = 0
    await $.tool.call(CALL(['team.members.view', 'boards.view']))
    await d.clock.settle()
    expect(navigations(d).map((c: any) => c.args.url)).toEqual([URL_A])
    expect(d.toasts.at(-1)).toBe(`Approve permission team.members.view, boards.view in the browser. Confirm code CODE1 must match the page: ${URL_A}`)
    expect(d.toastTimeouts.at(-1)).toBe(60_000)
    // the same request asked again (the MCP answers pending) is not opened a second time
    await $.tool.call(CALL(['team.members.view', 'boards.view']))
    await d.clock.settle()
    expect(navigations(d)).toHaveLength(1)
  })

  test('a refusal opens nothing and counts nothing', async ($, on) => {
    const d = dashboard(on, { browserClosed: true })
    answering(on, [JSON.stringify({ ok: false, status: 400, body: { error: 'already_held' } })])
    await startSession($, d, 'desktop')
    d.calls.length = 0
    await $.tool.call(CALL(['team.members.view']))
    await d.clock.settle()
    expect(navigations(d)).toHaveLength(0)
    const band = await $.ui.mount(BAND)
    expect(await band.find({ key: 'open-permission' })).toBeUndefined()
  })

  test('the band counts the open requests and a press opens the newest one with its code', async ($, on) => {
    const d = dashboard(on, { tabs: ['seed'] })
    answering(on, [answer('approval_required', URL_A, 'CODE1'), answer('approval_required', URL_B, 'CODE2')])
    await startSession($, d, 'desktop')
    const band = await $.ui.mount(BAND)
    expect(await band.find({ key: 'open-permission' })).toBeUndefined()
    await $.tool.call(CALL(['team.members.view']))
    expect((await band.find({ key: 'open-permission' }))?.text).toBe('⚠ 1 permission request')
    await $.tool.call(CALL(['boards.view']))
    await d.clock.settle()
    expect((await band.find({ key: 'open-permission' }))?.text).toBe('⚠ 2 permission requests')
    d.calls.length = 0
    d.toasts.length = 0
    await band.press({ key: 'open-permission' })
    await d.clock.settle()
    expect(navigations(d).map((c: any) => c.args.url)).toEqual([URL_B])
    expect(d.toasts.at(-1)).toContain('CODE2')
    expect(d.toasts.at(-1)).toContain('boards.view')
  })

  for (const status of ['approved', 'claimed', 'denied', 'expired', 'notFound'] as const) {
    test(`a request the claim route says is ${status} leaves the band at the next refresh`, async ($, on) => {
      const d = dashboard(on, { tabs: ['seed'] })
      answering(on, [answer('approval_required', URL_A, 'CODE1')])
      await startSession($, d, 'desktop')
      const band = await $.ui.mount(BAND)
      await $.tool.call(CALL(['team.members.view']))
      await d.clock.advance(60_000)
      await d.clock.settle()
      expect(claims(d).length).toBeGreaterThan(0)
      expect(await band.find({ key: 'open-permission' })).toBeDefined()
      d.world.permissionClaim = status
      await d.clock.advance(60_000)
      await d.clock.settle()
      expect(await band.find({ key: 'open-permission' })).toBeUndefined()
    })
  }

  test('a request still pending is kept, until its expiry passes', async ($, on) => {
    const d = dashboard(on, { tabs: ['seed'] })
    answering(on, [answer('approval_required', URL_A, 'CODE1')])
    await startSession($, d, 'desktop')
    const band = await $.ui.mount(BAND)
    await $.tool.call(CALL(['team.members.view']))
    await d.clock.advance(120_000)
    await d.clock.settle()
    expect(await band.find({ key: 'open-permission' })).toBeDefined()
    // past its expiry (10 minutes): gone by its own time, whatever the claim says
    await d.clock.advance(600_000)
    await d.clock.settle()
    expect(await band.find({ key: 'open-permission' })).toBeUndefined()
  })

  test('asking again for a request already open keeps one request in the band', async ($, on) => {
    const d = dashboard(on, { tabs: ['seed'] })
    answering(on, [answer('approval_required', URL_A, 'CODE1'), answer('approval_pending', URL_A, 'CODE1')])
    await startSession($, d, 'desktop')
    const band = await $.ui.mount(BAND)
    await $.tool.call(CALL(['team.members.view']))
    await $.tool.call(CALL(['team.members.view']))
    expect((await band.find({ key: 'open-permission' }))?.text).toBe('⚠ 1 permission request')
  })

  test('a session that lost its key drops its requests at the next refresh', async ($, on) => {
    const d = dashboard(on, { tabs: ['seed'] })
    answering(on, [answer('approval_required', URL_A, 'CODE1')])
    await startSession($, d, 'desktop')
    const band = await $.ui.mount(BAND)
    await $.tool.call(CALL(['team.members.view']))
    expect(await band.find({ key: 'open-permission' })).toBeDefined()
    d.world.signedOut = 'revoked'
    await d.clock.advance(60_000)
    await d.clock.settle()
    expect(await band.find({ key: 'open-permission' })).toBeUndefined()
  })

  test('a claim that fails for another reason keeps the request, to be asked again', async ($, on) => {
    const d = dashboard(on, { tabs: ['seed'] })
    answering(on, [answer('approval_required', URL_A, 'CODE1')])
    await startSession($, d, 'desktop')
    const band = await $.ui.mount(BAND)
    await $.tool.call(CALL(['team.members.view']))
    d.world.permissionClaim = 'boom'
    await d.clock.advance(60_000)
    await d.clock.settle()
    expect(claims(d).length).toBeGreaterThan(0)
    expect(await band.find({ key: 'open-permission' })).toBeDefined()
  })

  test('with no request nothing is claimed', async ($, on) => {
    const d = dashboard(on, { tabs: ['seed'] })
    await startSession($, d, 'desktop')
    await d.clock.advance(120_000)
    await d.clock.settle()
    expect(claims(d)).toHaveLength(0)
  })
})
