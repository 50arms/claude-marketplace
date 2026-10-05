// DX-4435 (parent DX-4432): the model's `request_permission` (danx-dashboard MCP, DX-4434) answers at once with an approval URL and
// confirm code. The plugin opens that page once and toasts the code and the permissions asked for, the band counts the requests
// still open and a press opens the newest one's page, and a request leaves the count when it is decided or expires.
import { describe, expect, test } from 'claude-code/testing'

import { PERMISSION_POLL_MS } from '../hooks/plan/config'
import { claimStatus, permissionRequestOf } from '../hooks/plan/permission'
import { dashboard, startSession, toldModel } from './plan-kit'

const URL_A = 'https://danxbot.example/connect/aaaa'
const URL_B = 'https://danxbot.example/connect/bbbb'
// the MCP's answer as it is today, `expiresAt` included (the plugin does not read it)
const answer = (state: string, url: string, code: string) =>
  JSON.stringify({ state, approvalUrl: url, confirmCode: code, expiresAt: '2026-10-03T08:10:00.000Z', instruction: 'Show the code.' })
const TOOL = 'mcp__plugin_danxbot_danx-dashboard__request_permission'
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
    const want = { url: URL_A, code: 'CODE1', publicId: 'aaaa', permissions: ['team.members.view'] }
    expect(permissionRequestOf(answer('approval_required', URL_A, 'CODE1'), ['team.members.view'])).toEqual(want)
    expect(permissionRequestOf(answer('approval_pending', URL_A, 'CODE1'), ['team.members.view'])).toEqual(want)
    expect(permissionRequestOf(answer('approval_required', URL_A, 'CODE1'), undefined)?.permissions).toEqual([])
    // DX-4530: a request has no expiry clock (it is open until the requesting session ends), so the answer's expiry is not read
    expect(permissionRequestOf(JSON.stringify({ state: 'approval_required', approvalUrl: URL_A, confirmCode: 'CODE1', instruction: 'Show the code.' }), [])).toEqual({ ...want, permissions: [] })
    expect(permissionRequestOf(JSON.stringify({ ok: false, status: 400, body: { error: 'already_held' } }), [])).toBeNull()
    expect(permissionRequestOf('Not signed in to the danxbot dashboard.', [])).toBeNull()
    expect(permissionRequestOf(undefined, [])).toBeNull()
  })
})

describe('claimStatus', () => {
  test('answers the decision the claim route gives, with the permissions granted', () => {
    expect(claimStatus({ status: 'pending', granted: null })).toEqual({ kind: 'pending' })
    expect(claimStatus({ status: 'approved', granted: ['team.members.view'] })).toEqual({ kind: 'granted', granted: ['team.members.view'] })
    expect(claimStatus({ status: 'claimed', granted: ['boards.view'] })).toEqual({ kind: 'granted', granted: ['boards.view'] })
    expect(claimStatus({ status: 'denied', granted: null })).toEqual({ kind: 'denied' })
    expect(claimStatus({ status: 'expired', granted: null })).toEqual({ kind: 'expired' })
  })

  test('anything it cannot read is unknown: a strange status, or an approval that names no grant', () => {
    expect(claimStatus({ status: 'maybe' })).toEqual({ kind: 'unknown' })
    expect(claimStatus({ status: 'approved', granted: null })).toEqual({ kind: 'unknown' })
    expect(claimStatus({ status: 'approved', granted: ['ok', 3] })).toEqual({ kind: 'unknown' })
    expect(claimStatus(null)).toEqual({ kind: 'unknown' })
    expect(claimStatus('approved')).toEqual({ kind: 'unknown' })
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

  // DX-4530: a request has no expiry clock: it waits for the person until the requesting session ends
  test('a request still pending is kept past the old 10-minute window, and the model is told nothing', async ($, on) => {
    const d = dashboard(on, { tabs: ['seed'] })
    answering(on, [answer('approval_required', URL_A, 'CODE1')])
    await startSession($, d, 'desktop')
    const band = await $.ui.mount(BAND)
    await $.tool.call(CALL(['team.members.view']))
    // past the old 10-minute window, polled all the while (a longer wait only repeats the same pending claim; DX-4586: every poll tick of a
    // longer advance is real time that times the test out under machine load)
    await d.clock.advance(660_000)
    await d.clock.settle()
    expect(await band.find({ key: 'open-permission' })).toBeDefined()
    expect(toldModel(d)).toEqual([])
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

  // DX-4530: the poll runs every PERMISSION_POLL_MS while a request is open, and stops once none is
  test('an open request is claimed on the fast poll, and claiming stops once it is decided', async ($, on) => {
    const d = dashboard(on, { tabs: ['seed'] })
    answering(on, [answer('approval_required', URL_A, 'CODE1')])
    await startSession($, d, 'desktop')
    await $.tool.call(CALL(['team.members.view']))
    await d.clock.settle()
    const before = claims(d).length
    await d.clock.advance(PERMISSION_POLL_MS)
    await d.clock.settle()
    expect(claims(d).length).toBeGreaterThan(before)
    d.world.permissionClaim = 'approved'
    await d.clock.advance(PERMISSION_POLL_MS)
    await d.clock.settle()
    const decided = claims(d).length
    await d.clock.advance(180_000)
    await d.clock.settle()
    expect(claims(d)).toHaveLength(decided)
  })

  test('a session start (a reload, or a new process) resumes the fast poll for a request still open', async ($, on) => {
    const d = dashboard(on, { tabs: ['seed'] })
    answering(on, [answer('approval_required', URL_A, 'CODE1')])
    await startSession($, d, 'desktop')
    await $.tool.call(CALL(['team.members.view']))
    await startSession($, d, 'desktop')
    const before = claims(d).length
    await d.clock.advance(PERMISSION_POLL_MS)
    await d.clock.settle()
    expect(claims(d).length).toBeGreaterThan(before)
    d.world.permissionClaim = 'approved'
    await d.clock.advance(PERMISSION_POLL_MS)
    await d.clock.settle()
    // one poll, not two stacked ones: told once
    expect(toldModel(d)).toHaveLength(1)
  })
})

// DX-4530: the requesting session is told the decision once, in its chat (the MCP only frees its slot, DX-4435 comment 10745)
describe('the model is told the decision', () => {
  async function decide($: any, on: any, set: (d: any) => void, asked = ['team.members.view']) {
    const d = dashboard(on, { tabs: ['seed'] })
    answering(on, [answer('approval_required', URL_A, 'CODE1'), answer('approval_pending', URL_A, 'CODE1')])
    await startSession($, d, 'desktop')
    const band = await $.ui.mount(BAND)
    await $.tool.call(CALL(asked))
    await d.clock.advance(PERMISSION_POLL_MS)
    await d.clock.settle()
    expect(toldModel(d)).toEqual([])
    set(d)
    await d.clock.advance(PERMISSION_POLL_MS)
    await d.clock.settle()
    return { d, band }
  }

  for (const status of ['approved', 'claimed'] as const) {
    test(`${status}: told once which permissions were granted and to retry the refused call`, async ($, on) => {
      const { d, band } = await decide($, on, d => void (d.world.permissionClaim = status))
      expect(await band.find({ key: 'open-permission' })).toBeUndefined()
      const told = toldModel(d)
      expect(told).toHaveLength(1)
      expect(told[0]).toContain('CODE1')
      expect(told[0]).toContain('granted team.members.view')
      expect(told[0]).toMatch(/[Rr]etry the call/)
      expect(told[0]).not.toContain('Not granted')
      // later polls and refreshes tell nothing more
      await d.clock.advance(180_000)
      await d.clock.settle()
      expect(toldModel(d)).toHaveLength(1)
    })
  }

  test('a grant of part of what was asked names what was not granted', async ($, on) => {
    const { d } = await decide($, on, d => {
      d.world.permissionClaim = 'approved'
      d.world.permissionGranted = ['boards.view']
    }, ['team.members.view', 'boards.view'])
    const told = toldModel(d)
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('granted boards.view')
    expect(told[0]).toContain('Not granted: team.members.view')
  })

  test('denied: told once that the person denied it', async ($, on) => {
    const { d, band } = await decide($, on, d => void (d.world.permissionClaim = 'denied'))
    expect(await band.find({ key: 'open-permission' })).toBeUndefined()
    const told = toldModel(d)
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('CODE1')
    expect(told[0]).toContain('denied')
    expect(told[0]).toContain('team.members.view')
    expect(told[0]).not.toMatch(/[Rr]etry the call/)
  })

  for (const [name, set] of [
    ['expired', (d: any) => void (d.world.permissionClaim = 'expired')],
    // a request the dashboard no longer knows (another key now, or gone): the same as expired
    ['not found', (d: any) => void (d.world.permissionClaim = 'notFound')],
    // the key lapsed while the request waited: the session ended
    ['the key lapsed', (d: any) => void (d.world.signedOut = 'lapsed')],
  ] as const) {
    test(`${name}: told once the session ended, to reconnect it and request the permission again`, async ($, on) => {
      const { d, band } = await decide($, on, set)
      expect(await band.find({ key: 'open-permission' })).toBeUndefined()
      const told = toldModel(d)
      expect(told).toHaveLength(1)
      expect(told[0]).toContain('CODE1')
      expect(told[0]).toContain('expired')
      expect(told[0]).toContain('plan_connect')
      expect(told[0]).toContain('request_permission again for team.members.view')
    })
  }

  test('a key a person revoked drops the request and tells nothing: the session must stop, not ask again', async ($, on) => {
    const { d, band } = await decide($, on, d => void (d.world.signedOut = 'revoked'))
    expect(await band.find({ key: 'open-permission' })).toBeUndefined()
    expect(toldModel(d)).toEqual([])
  })

  test('a claim that fails for another reason tells nothing and keeps the request', async ($, on) => {
    const { d, band } = await decide($, on, d => void (d.world.permissionClaim = 'boom'))
    expect(await band.find({ key: 'open-permission' })).toBeDefined()
    expect(toldModel(d)).toEqual([])
  })

  test('a request told once is never told again, even when it comes back into the list', async ($, on) => {
    const { d, band } = await decide($, on, d => void (d.world.permissionClaim = 'approved'))
    expect(toldModel(d)).toHaveLength(1)
    // the same request back in the list (the model asked again and was answered the same request): its next claim says claimed
    await $.tool.call(CALL(['team.members.view']))
    expect(await band.find({ key: 'open-permission' })).toBeDefined()
    d.world.permissionClaim = 'claimed'
    await d.clock.advance(PERMISSION_POLL_MS)
    await d.clock.settle()
    expect(await band.find({ key: 'open-permission' })).toBeUndefined()
    expect(toldModel(d)).toHaveLength(1)
  })
})
