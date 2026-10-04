// DX-4423: a session with no dashboard key (revoked, lapsed, never approved). The danx-dashboard MCP answers every tool but
// plan_connect with an error result written for the agent; the band, pane and footer must say "Danxbot: signed out" in the
// person's words with a Sign in button, and Sign in must run the request-and-approve dance through plan_connect.
import { describe, expect, test } from 'claude-code/testing'

import { SIGN_IN_ROUNDS } from '../hooks/plan/config'
import { loadPlan } from '../hooks/plan/load'
import { isSignedOut } from '../hooks/plan/mcp'
import { signInStep } from '../hooks/plan/sign-in'
import { APPROVAL_PENDING, APPROVAL_REQUIRED, APPROVAL_URL, CONFIRM_CODE, REVOKED_HALT, SIGN_IN_HALT, SURFACES, dashboard, footerText, mountIndicator, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = { component: 'Pane', requestId: 'danx-plan', props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' } } as any
const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' ')
const buttons = async (ui: any) => (await ui.findAll({ type: 'Button' })).map((b: any) => b.text)
// the server's agent-facing wording: none of it may reach the person, in any drawing or toast
const AGENT_TEXT = /plan_connect|Not signed in|user approves|request access|lapsed|no longer accepts/i
const connectCalls = (d: any) => d.calls.filter((c: any) => c.server === 'danx-dashboard' && c.tool === 'plan_connect')
const previewStarts = (d: any) => d.calls.filter((c: any) => c.server === 'Claude_Browser' && c.tool === 'preview_start')
const approvalToasts = (d: any) => d.toasts.filter((t: string) => t.includes(CONFIRM_CODE))
const answer = (value: unknown, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError })

describe('classification: the signed-out answer is its own state, not an error', () => {
  const halt = (text: string) => ({ ok: false, status: 0, body: { error: text } })

  test('both halts of the server read as signed out, and nothing else does', () => {
    expect(isSignedOut(halt(SIGN_IN_HALT))).toBe(true)
    expect(isSignedOut(halt(REVOKED_HALT))).toBe(true)
    expect(isSignedOut(halt('plan_connect: bad arguments'))).toBe(false)
    expect(isSignedOut({ ok: false, status: 500, body: { error: SIGN_IN_HALT } })).toBe(false)
    expect(isSignedOut({ ok: true, status: 200, body: { error: SIGN_IN_HALT } })).toBe(false)
    expect(isSignedOut({ ok: false, status: 0, body: undefined })).toBe(false)
    // only the server's own sentence: another service's "not signed in", or a bare mention of plan_connect, is a plain failure
    expect(isSignedOut(halt('Not signed in to Slack'))).toBe(false)
    expect(isSignedOut(halt('Call `plan_connect` with a plan id'))).toBe(false)
  })

  test('the first call, a later call, and the revoked wording each end the load as signed-out', async () => {
    const list = { ok: true, status: 200, body: { plans: [], total: 0, session: { plan_id: 23, plan_name: 'x' }, dashboard_url: 'http://localhost:5555' } }
    expect(await loadPlan(async () => halt(SIGN_IN_HALT), 't')).toMatchObject({ phase: 'signed-out', error: null, connected: null, refreshedAt: 't' })
    expect(await loadPlan(async () => halt(REVOKED_HALT), 't')).toMatchObject({ phase: 'signed-out' })
    // the key dropped between the plan list and the plan's own read
    const later = await loadPlan(async (_m, path) => (path === '/api/plans' ? list : halt(REVOKED_HALT)), 't')
    expect(later).toMatchObject({ phase: 'signed-out', error: null })
  })

  test('a generic failure, even one that mentions signing in, is still an error', async () => {
    const v = await loadPlan(async () => ({ ok: false, status: 401, body: { error: 'Not signed in to the danxbot dashboard' } }), 't')
    expect(v.phase).toBe('error')
  })
})

describe('the loaded view', () => {
  test('a ready view carries resumePlan null: the field is never undefined', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    const v = d.stateWrites.filter(w => w.key === 'view').at(-1)!.value as any
    expect(v.phase).toBe('ready')
    expect(v.resumePlan).toBeNull()
  })
})

describe('what one plan_connect answer means to Sign in', () => {
  test("each answer of the server maps to one step, and the words are never the server's", () => {
    expect(signInStep(answer(APPROVAL_REQUIRED))).toEqual({ kind: 'waiting', request: { url: APPROVAL_URL, code: CONFIRM_CODE } })
    // a waiting call names the request it waits on; one that names none is still waiting
    expect(signInStep(answer(APPROVAL_PENDING))).toEqual({ kind: 'waiting', request: { url: APPROVAL_URL, code: CONFIRM_CODE } })
    expect(signInStep(answer({ state: 'approval_pending' }))).toEqual({ kind: 'waiting', request: null })
    expect(signInStep(answer({ state: 'signed_in' }))).toEqual({ kind: 'done' })
    expect(signInStep(answer({ ok: true, status: 200, body: { session: { plan_id: 23 } } }))).toEqual({ kind: 'done' })
    expect(signInStep(answer({ state: 'denied', instruction: 'The user denied the request. Do not retry unless they ask.' }))).toEqual({ kind: 'stop', message: 'Sign in was denied.' })
    expect(signInStep(answer({ state: 'rate_limited', retryAfterSeconds: 60, error: 'x' }, true)).kind).toBe('stop')
    expect(signInStep(answer({ state: 'something_new' }, true))).toEqual({ kind: 'stop', message: 'Sign in stopped (something_new).' })
    expect(signInStep(answer({ state: 'approval_required', approvalUrl: 'javascript:x', confirmCode: 'A' })).kind).toBe('stop')
    expect(signInStep(answer({ state: 'request_failed', error: 'x' }, true))).toEqual({ kind: 'stop', message: 'Sign in could not be completed: try again in a moment.' })
    expect(signInStep(answer({ state: 'request_refused', status: 403 }, true))).toEqual({ kind: 'stop', message: 'The dashboard refused the sign-in request.' })
    expect(signInStep({ content: [{ type: 'text', text: 'plain text' }], isError: true }).kind).toBe('stop')
    const refused = signInStep(answer({ ok: false, status: 409, body: { error: 'plan_archived', message: 'PLAN-23 is archived.' } }))
    expect(refused).toEqual({ kind: 'refused', message: 'Signed in, but the plan connect was refused: 409 PLAN-23 is archived.' })
  })
})

for (const surface of SURFACES) {
  for (const kind of ['signed-out', 'revoked'] as const) {
    describe(`${kind} on ${surface}`, () => {
      test("band, pane and footer say Danxbot: signed out in red, with a Sign in button and none of the server's words", async ($, on) => {
        const d = dashboard(on, { signedOut: kind })
        await startSession($, d, surface)
        const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
        const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
        const footer = await mountIndicator($, surface)

        const label = await band.find({ type: 'Text', text: /Danxbot: signed out/ })
        expect(label.props.color).toBe('red')
        expect(await buttons(band)).toContain('Sign in')
        expect(await texts(pane)).toContain('Danxbot: signed out')
        expect(await texts(pane)).toContain("This session's access ended. Sign in to reconnect.")
        expect(await buttons(pane)).toContain('Sign in')
        expect(await footerText(footer)).toBe('Danxbot: signed out')
        for (const shown of [await texts(band), await texts(pane), (await buttons(band)).join(' '), (await buttons(pane)).join(' ')]) expect(shown).not.toMatch(AGENT_TEXT)
        expect(await buttons(pane)).not.toContain('Disconnect')
        expect(await buttons(pane)).not.toContain('Switch plan')
        expect(d.toasts.join(' ')).not.toMatch(AGENT_TEXT)
      })
    })
  }

  describe(`Sign in on ${surface}`, () => {
    test('a session that was on a plan loses its key: the next refresh reads signed out and Sign in asks for that plan again with its title', async ($, on) => {
      const d = dashboard(on)
      on('classic.SessionStart', () => ({}) as any)
      await $.classic.SessionStart({ source: 'startup', session_title: 'PLAN-23: danxbot plugin' } as any)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      d.world.signedOut = 'revoked'
      // three polls while signed out: the plan it was on is still remembered after the first
      for (let i = 0; i < 3; i++) await d.clock.advance(60_000)
      expect(await texts(band)).toContain('Danxbot: signed out')
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      expect(connectCalls(d)[0]!.args).toEqual({ plan_id: 23, title: 'PLAN-23: danxbot plugin' })
      expect(connectCalls(d).every((c: any) => c.args.disconnect === undefined)).toBe(true)
    })

    test('a failed load before the revoke does not make the session forget its plan', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.failList()
      await d.clock.advance(60_000)
      d.failList(false)
      d.world.signedOut = 'revoked'
      await d.clock.advance(60_000)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      expect(connectCalls(d)[0]!.args).toEqual({ plan_id: 23 })
    })

    test('the request opens its page once and shows the code in one toast, whichever call asked for it', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out', browserClosed: true })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      d.calls.length = 0
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      expect(previewStarts(d).map((c: any) => c.args.url)).toEqual([APPROVAL_URL])
      expect(approvalToasts(d)).toEqual([`Approve this session in the browser. Confirm code ${CONFIRM_CODE} must match the page: ${APPROVAL_URL}`])
      // the second call is waiting for the approval; the pending answers that follow open nothing more
      await d.clock.advance(45_000)
      await d.clock.advance(45_000)
      expect(previewStarts(d)).toHaveLength(1)
      expect(approvalToasts(d)).toHaveLength(1)
    })

    test('the buttons read Signing in… while it waits, a second press makes no second call, and approval reloads the view by itself', async ($, on) => {
      const d = dashboard(on, { signedOut: 'revoked' })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      expect((await band.find({ key: 'sign-in' })).text).toBe('Signing in…')
      expect((await pane.find({ key: 'sign-in' })).text).toBe('Signing in…')
      const calls = connectCalls(d).length
      await Promise.all([band.press({ key: 'sign-in' }), pane.press({ key: 'sign-in' })])
      await d.clock.settle()
      expect(connectCalls(d)).toHaveLength(calls)

      // the person approves while the call waits: it answers with the connect, and the view reloads with no restart
      d.world.signIn.approved = true
      await d.clock.advance(45_000)
      await d.clock.settle()
      expect(d.toasts).toContain('Signed in')
      expect(await texts(band)).not.toContain('signed out')
      expect(await texts(band)).toContain('PLAN-23')
      expect(await texts(pane)).toContain('Connected: PLAN-23')
      expect(await buttons(pane)).not.toContain('Sign in')
      expect(await buttons(pane)).not.toContain('Signing in…')
      // not one toast of the whole sign-in carried the server's words
      expect(d.toasts.join(' ')).not.toMatch(AGENT_TEXT)
    })

    test('a session that was on no plan signs in with no plan id and lands on the plan list', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out', connected: false })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      expect(connectCalls(d)[0]!.args).toEqual({})
      d.world.signIn.approved = true
      await d.clock.advance(45_000)
      await d.clock.settle()
      expect(await texts(band)).toContain('Danxbot: not connected to a plan')
    })

    for (const [name, value, expected] of [
      ['denied', { state: 'denied', instruction: 'The user denied the request. Do not retry unless they ask; a new `plan_connect` makes a new request.' }, 'Sign in was denied.'],
      ['rate limited', { state: 'rate_limited', retryAfterSeconds: 30, error: 'too many access requests from this address' }, 'Too many sign-in requests from this machine: wait a minute, then press Sign in again.'],
    ] as const) {
      test(`${name}: one toast in the person's words, no retry, and the signed-out view stays`, async ($, on) => {
        const d = dashboard(on, { signedOut: 'signed-out' })
        d.world.signIn.answer = { text: JSON.stringify(value), isError: name === 'rate limited' }
        await startSession($, d, surface)
        const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
        await band.press({ key: 'sign-in' })
        await d.clock.settle()
        expect(d.toasts.at(-1)).toBe(expected)
        expect(connectCalls(d)).toHaveLength(1)
        expect(await texts(band)).toContain('Danxbot: signed out')
        expect((await band.find({ key: 'sign-in' })).text).toBe('Sign in')
      })
    }

    test('a request nobody approves ends when the call that outlives it answers a new one: a toast, no second page, Sign in pressable again', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out', browserClosed: true })
      d.world.signIn.expireAfterCalls = 4
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      await band.press({ key: 'sign-in' })
      for (let i = 0; i < 6; i++) await d.clock.advance(45_000)
      await d.clock.settle()
      expect(d.toasts.at(-1)).toBe('Sign in timed out. Press Sign in again.')
      expect(connectCalls(d)).toHaveLength(4)
      expect(previewStarts(d).map((c: any) => c.args.url)).toEqual([APPROVAL_URL])
      expect(d.toasts.join(' ')).not.toContain('NEWCODE9')
      expect((await band.find({ key: 'sign-in' })).text).toBe('Sign in')
    })

    test('after an expiry a new press waits on the request the last call left, and shows its page and code', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out', browserClosed: true })
      d.world.signIn.expireAfterCalls = 3
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      await band.press({ key: 'sign-in' })
      for (let i = 0; i < 4; i++) await d.clock.advance(45_000)
      await d.clock.settle()
      expect(d.toasts.at(-1)).toBe('Sign in timed out. Press Sign in again.')
      // the server now holds the renewed request: its waiting answers name it
      d.world.signIn.answer = { text: JSON.stringify({ ...APPROVAL_PENDING, approvalUrl: `${APPROVAL_URL}-renewed`, confirmCode: 'NEWCODE9' }) }
      d.world.signIn.expireAfterCalls = undefined
      await band.press({ key: 'sign-in' })
      await d.clock.advance(45_000)
      // the pane is open by now, so the second page goes through the held tab (navigate), not preview_start
      const pages = d.calls.filter((c: any) => c.server === 'Claude_Browser' && c.args?.url).map((c: any) => c.args.url)
      expect(pages).toEqual([APPROVAL_URL, `${APPROVAL_URL}-renewed`])
      expect(d.toasts.some(t => t.includes('NEWCODE9') && t.includes(`${APPROVAL_URL}-renewed`))).toBe(true)
    })

    test('a server that never answers anything final ends after SIGN_IN_ROUNDS calls', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out' })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      await band.press({ key: 'sign-in' })
      for (let i = 0; i < SIGN_IN_ROUNDS + 4; i++) await d.clock.advance(45_000)
      await d.clock.settle()
      expect(d.toasts.at(-1)).toBe('Sign in timed out. Press Sign in again.')
      expect(connectCalls(d)).toHaveLength(SIGN_IN_ROUNDS)
      expect((await band.find({ key: 'sign-in' })).text).toBe('Sign in')
    })

    test('a call that throws is one toast, and the key is released', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out', connectThrows: true })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      d.setMcp('flaky')
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      expect(d.toasts.at(-1)).toMatch(/^Sign in failed: /)
      expect((await band.find({ key: 'sign-in' })).text).toBe('Sign in')
    })
  })
}
