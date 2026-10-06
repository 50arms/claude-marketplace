// DX-4423: a session with no dashboard key (lapsed, never approved; a key a person revoked is its own view, DX-4418). The danx-dashboard MCP answers every tool but
// plan_connect with an error result written for the agent; the band, pane and footer must say "Danxbot: signed out" in the
// person's words with a Sign in button, and Sign in must run the request-and-approve dance through plan_connect.
import { describe, expect, test } from 'claude-code/testing'

import { loadPlan } from '../hooks/plan/load'
import { isSignedOut, keyRevokedBy, outcomeRevokedBy } from '../hooks/plan/mcp'
import { signInToast } from '../hooks/plan/approval'
import { APPROVAL_TOAST_MS } from '../hooks/plan/config'
import { signInNote } from '../hooks/plan/notes'
import { signInStep } from '../hooks/plan/sign-in'
import { APPROVAL_PENDING, APPROVAL_REQUIRED, APPROVAL_URL, CONFIRM_CODE, KEY_LAPSED_HALT, KEY_REVOKED_HALT, REVOKER, SIGN_IN_HALT, SURFACES, dashboard, footerText, mountIndicator, startSession, toldModel, forceRefresh } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = { component: 'Pane', requestId: 'danx-plan', props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' } } as any
const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' ')
const buttons = async (ui: any) => (await ui.findAll({ type: 'Button' })).map((b: any) => b.text)
// the server's agent-facing wording: none of it may reach the person, in any drawing or toast
const AGENT_TEXT = /plan_connect|Not signed in|user approves|request access|lapsed|no longer accepts|STOP ALL WORK|Commit your work|agent-finalize/i
// DX-4530: the toasts the person reads; the kit can deliver the model's own rows only as a toast (toldModel)
const personToasts = (d: any) => d.toasts.filter((t: string) => !t.startsWith('Could not tell the model'))
const connectCalls = (d: any) => d.calls.filter((c: any) => c.server === 'plugin:danxbot:danx-dashboard' && c.tool === 'plan_connect')
// the page loads by preview_start (pane closed) or navigate (pane open)
// DX-4630: EVERY Claude_Browser call, so a sign-in that touched the browser in any way (tabs_context, tabs_create, ...) fails
const browserCalls = (d: any) => d.calls.filter((c: any) => c.server === 'Claude_Browser')
const approvalToasts = (d: any) => d.toasts.filter((t: string) => t.includes(CONFIRM_CODE))
// the model's own plan_connect call, answering the same approval request the dashboard's world gives the Sign in press
const modelConnect = (on: any) => on('tool.call', { tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect' }, () => ({ result: {}, text: JSON.stringify(APPROVAL_REQUIRED), isError: false }) as any)
const answer = (value: unknown, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError })

describe('classification: the signed-out answer is its own state, not an error', () => {
  const halt = (text: string) => ({ ok: false, status: 0, body: { error: text } })

  test('both halts of the server read as signed out, and nothing else does', () => {
    expect(isSignedOut(halt(SIGN_IN_HALT))).toBe(true)
    expect(isSignedOut(halt(KEY_LAPSED_HALT))).toBe(true)
    // a key a person revoked is the stop halt, never signed out: it does not carry the sign-in sentence
    expect(isSignedOut(halt(KEY_REVOKED_HALT))).toBe(false)
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
    expect(await loadPlan(async () => halt(SIGN_IN_HALT), 't', null)).toMatchObject({ phase: 'signed-out', error: null, connected: null, refreshedAt: 't' })
    expect(await loadPlan(async () => halt(KEY_LAPSED_HALT), 't', null)).toMatchObject({ phase: 'signed-out' })
    // the key dropped between the plan list and the plan's own read
    const later = await loadPlan(async (_m, path) => (path === '/api/plans' ? list : halt(KEY_LAPSED_HALT)), 't', null)
    expect(later).toMatchObject({ phase: 'signed-out', error: null })
  })

  test('a generic failure, even one that mentions signing in, is still an error', async () => {
    const v = await loadPlan(async () => ({ ok: false, status: 401, body: { error: 'Not signed in to the danxbot dashboard' } }), 't', null)
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

describe('a key a person revoked (DX-4418): the stop halt of MCP 0.1.225', () => {
  const halt = (text: string) => ({ ok: false, status: 0, body: { error: text } })

  test('the exact halt names who revoked the key, and only that exact opening counts', () => {
    expect(keyRevokedBy(KEY_REVOKED_HALT)).toBe(REVOKER)
    // a name with spaces, and the opening cut from the real text (key-revoked-halt.ts, keyRevokedHalt)
    expect(keyRevokedBy('STOP ALL WORK NOW. Dana Smith revoked your access to the danxbot dashboard at 2026-10-04T07:00:00.000Z.\n\nCommit your work.')).toBe('Dana Smith')
    for (const other of [
      KEY_LAPSED_HALT,
      SIGN_IN_HALT,
      `Note: ${KEY_REVOKED_HALT}`,
      'STOP ALL WORK NOW. dana revoked your access to Slack at 2026-10-04T07:00:00.000Z.\n\n',
      'STOP ALL WORK NOW. revoked your access to the danxbot dashboard at 2026-10-04T07:00:00.000Z.\n\n',
      'STOP ALL WORK NOW. dana revoked your access to the danxbot dashboard at 2026-10-04T07:00:00.000Z.',
      '',
    ]) {
      expect(keyRevokedBy(other)).toBeNull()
    }
  })

  test('an outcome reads as revoked only when it is an error result carrying the halt', () => {
    expect(outcomeRevokedBy(halt(KEY_REVOKED_HALT))).toBe(REVOKER)
    expect(outcomeRevokedBy({ ok: false, status: 401, body: { error: KEY_REVOKED_HALT } })).toBeNull()
    expect(outcomeRevokedBy({ ok: true, status: 200, body: { error: KEY_REVOKED_HALT } })).toBeNull()
    expect(outcomeRevokedBy({ ok: false, status: 0, body: undefined })).toBeNull()
  })

  test('the first call and a later call each end the load as key-revoked, naming who', async () => {
    const list = { ok: true, status: 200, body: { plans: [], total: 0, session: { plan_id: 23, plan_name: 'x' }, dashboard_url: 'http://localhost:5555' } }
    expect(await loadPlan(async () => halt(KEY_REVOKED_HALT), 't', null)).toMatchObject({ phase: 'key-revoked', revokedBy: REVOKER, error: null, connected: null, refreshedAt: 't' })
    const later = await loadPlan(async (_m, path) => (path === '/api/plans' ? list : halt(KEY_REVOKED_HALT)), 't', null)
    expect(later).toMatchObject({ phase: 'key-revoked', revokedBy: REVOKER })
  })

  test('Sign in reads the halt as the end, never as a stop it could retry', () => {
    expect(signInStep({ content: [{ type: 'text', text: KEY_REVOKED_HALT }], isError: true })).toEqual({ kind: 'revoked', by: REVOKER })
  })
})

describe('what one plan_connect answer means to Sign in', () => {
  test("each answer of the server maps to one step, and the words are never the server's", () => {
    expect(signInStep(answer(APPROVAL_REQUIRED))).toEqual({ kind: 'waiting', request: { url: APPROVAL_URL, code: CONFIRM_CODE } })
    // a waiting call names the request it waits on; one that names none is a stop (DX-4548: the wait has no round limit, so it must not repeat)
    expect(signInStep(answer(APPROVAL_PENDING))).toEqual({ kind: 'waiting', request: { url: APPROVAL_URL, code: CONFIRM_CODE } })
    expect(signInStep(answer({ state: 'approval_pending' }))).toEqual({ kind: 'stop', message: 'Sign in failed: the approval request had no usable link.' })
    expect(signInStep(answer({ state: 'signed_in' }))).toEqual({ kind: 'done' })
    expect(signInStep(answer({ ok: true, status: 200, body: { session: { plan_id: 23 } } }))).toEqual({ kind: 'done' })
    expect(signInStep(answer({ state: 'denied', instruction: 'The user denied the request. Do not retry unless they ask.' }))).toEqual({ kind: 'denied' })
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

// DX-4530: the row the model reads once the Sign in button signed its session in (it did not press it, so it is told)
describe('signInNote', () => {
  test('back on the plan it was on, on no plan, or signed in with the plan connect refused', () => {
    expect(signInNote(23, true)).toContain('call plan_connect with plan_id 23')
    expect(signInNote(null, true)).toContain('call plan_connect to see which plan')
    const refused = signInNote(23, false)
    expect(refused).toContain('signed this session in')
    expect(refused).toContain('plan_id 23 was refused')
    expect(refused).not.toContain('call plan_connect with plan_id 23 yourself to read its briefing')
    for (const note of [signInNote(23, true), signInNote(null, true), refused]) expect(note).toMatch(/retry/i)
  })
})

for (const surface of SURFACES) {
  for (const kind of ['signed-out', 'lapsed'] as const) {
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

  describe(`a revoked key on ${surface}`, () => {
    test('band, pane and footer say access revoked by the person in red, with no Sign in anywhere and none of the halt', async ($, on) => {
      const d = dashboard(on, { signedOut: 'revoked' })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      const footer = await mountIndicator($, surface)

      const label = await band.find({ type: 'Text', text: /Danxbot: access revoked by dana/ })
      expect(label.props.color).toBe('red')
      expect(await texts(pane)).toContain('Danxbot: access revoked by dana')
      expect(await texts(pane)).toContain("A person revoked this session's access, so the session must stop.")
      expect(await footerText(footer)).toBe('Danxbot: access revoked')
      expect(await band.find({ key: 'sign-in' })).toBeUndefined()
      expect(await pane.find({ key: 'sign-in' })).toBeUndefined()
      for (const shown of [await texts(band), await texts(pane), (await buttons(band)).join(' '), (await buttons(pane)).join(' ')]) {
        expect(shown).not.toMatch(AGENT_TEXT)
        expect(shown).not.toContain('Sign in')
      }
      expect(await buttons(pane)).not.toContain('Disconnect')
      expect(d.toasts.join(' ')).not.toMatch(AGENT_TEXT)
    })

    test('the plugin never calls plan_connect for a revoked session, however long it polls', async ($, on) => {
      const d = dashboard(on, { signedOut: 'revoked' })
      await startSession($, d, surface)
      for (let i = 0; i < 5; i++) await forceRefresh($, d)
      expect(connectCalls(d)).toEqual([])
    })

    test('a lapsed key that is then revoked reads revoked, and the view never offers Sign in again', async ($, on) => {
      const d = dashboard(on, { signedOut: 'lapsed' })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await texts(band)).toContain('Danxbot: signed out')
      d.world.signedOut = 'revoked'
      await forceRefresh($, d)
      expect(await texts(band)).toContain('Danxbot: access revoked by dana')
      expect(await band.find({ key: 'sign-in' })).toBeUndefined()
    })

    test('a leave pressed on a pane drawn before the revoke: the person reads the view\'s words, never the halt, and the view reloads revoked', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      d.world.signedOut = 'revoked'
      d.toasts.length = 0
      await pane.press({ key: 'disconnect' })
      await d.clock.settle()
      expect(d.toasts).toEqual(['Danxbot: access revoked by dana. This session must stop.'])
      expect(await texts(pane)).toContain('Danxbot: access revoked by dana')
    })

    test('a person revokes the key while Sign in waits: one toast, the view reads revoked, and no further call is made', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out' })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      d.world.signedOut = 'revoked'
      await d.clock.advance(45_000)
      await d.clock.settle()
      expect(d.toasts.at(-1)).toBe('Danxbot: access revoked by dana. This session must stop.')
      expect(await texts(band)).toContain('Danxbot: access revoked by dana')
      expect(await band.find({ key: 'sign-in' })).toBeUndefined()
      const calls = connectCalls(d).length
      await d.clock.advance(120_000)
      expect(connectCalls(d)).toHaveLength(calls)
    })
  })

  describe(`Sign in on ${surface}`, () => {
    test('a session that was on a plan loses its key: the next refresh reads signed out and Sign in asks for that plan again with its title', async ($, on) => {
      const d = dashboard(on)
      on('classic.SessionStart', () => ({}) as any)
      await $.classic.SessionStart({ source: 'startup', session_title: 'PLAN-23: danxbot plugin' } as any)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      d.world.signedOut = 'lapsed'
      // three polls while signed out: the plan it was on is still remembered after the first
      for (let i = 0; i < 3; i++) await forceRefresh($, d)
      expect(await texts(band)).toContain('Danxbot: signed out')
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      expect(connectCalls(d)[0]!.args).toEqual({ plan_id: 23, title: 'PLAN-23: danxbot plugin' })
      expect(connectCalls(d).every((c: any) => c.args.disconnect === undefined)).toBe(true)
      // DX-4530: approved: the model is told, once, that it is signed in and back on the plan it was on
      d.world.signIn.approved = true
      await d.clock.advance(45_000)
      await d.clock.settle()
      const told = toldModel(d)
      expect(told).toHaveLength(1)
      expect(told[0]).toContain('signed this session in')
      expect(told[0]).toContain('call plan_connect with plan_id 23')
    })

    test('a failed load before the revoke does not make the session forget its plan', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.failList()
      await forceRefresh($, d)
      d.failList(false)
      d.world.signedOut = 'lapsed'
      await forceRefresh($, d)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      expect(connectCalls(d)[0]!.args).toEqual({ plan_id: 23 })
    })

    // DX-4630: the link and code are drawn the moment the request exists, whatever the browser does: a refused or slow browser
    // cannot delay or hide them, and no browser call is made for sign-in at all.
    test('the request is drawn in the band and the pane at once, with a toast, and no browser call is made', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out', browserClosed: true, browser: 'denied', navigateTakesMs: 60_000 })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      d.calls.length = 0
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      expect(browserCalls(d)).toEqual([])
      for (const ui of [band, pane]) {
        expect((await ui.findAll({ type: 'Link' })).map((l: any) => l.props.href)).toContain(APPROVAL_URL)
        expect(await texts(ui)).toContain(`code ${CONFIRM_CODE}`)
      }
      expect(approvalToasts(d)).toEqual([signInToast({ url: APPROVAL_URL, code: CONFIRM_CODE })])
      expect(d.toastTimeouts.at(-1)).toBe(APPROVAL_TOAST_MS)
      // the later rounds of the same wait say nothing more
      await d.clock.advance(45_000)
      await d.clock.advance(45_000)
      expect(browserCalls(d)).toEqual([])
      expect(approvalToasts(d)).toHaveLength(1)
    })

    test('a request the model started is drawn too, and a Sign in press while it waits says the link and code again and starts no second wait', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out', browserClosed: true })
      modelConnect(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      d.calls.length = 0
      await $.tool.call({ tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect', plan_id: 23 } as any)
      await d.clock.settle()
      expect((await band.findAll({ type: 'Link' })).map((l: any) => l.props.href)).toContain(APPROVAL_URL)
      expect(approvalToasts(d)).toHaveLength(1)
      const calls = connectCalls(d).length
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      expect(approvalToasts(d)).toHaveLength(2)
      expect(connectCalls(d)).toHaveLength(calls)
      expect(browserCalls(d)).toEqual([])
    })

    for (const outcome of ['approved', 'denied'] as const) {
      test(`${outcome} clears the band's link and code`, async ($, on) => {
        const d = dashboard(on, { signedOut: 'signed-out' })
        await startSession($, d, surface)
        const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
        await band.press({ key: 'sign-in' })
        await d.clock.settle()
        expect((await band.findAll({ type: 'Link' })).map((l: any) => l.props.href)).toContain(APPROVAL_URL)
        if (outcome === 'approved') d.world.signIn.approved = true
        else d.world.signIn.answer = { text: JSON.stringify({ state: 'denied' }) }
        await d.clock.advance(45_000)
        await d.clock.settle()
        expect((await band.findAll({ type: 'Link' })).map((l: any) => l.props.href)).not.toContain(APPROVAL_URL)
        expect(await texts(band)).not.toContain(`code ${CONFIRM_CODE}`)
      })
    }

    test('the buttons read Signing in… while it waits, a second press makes no second call, and approval reloads the view by itself', async ($, on) => {
      const d = dashboard(on, { signedOut: 'lapsed' })
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
      // not one toast of the whole sign-in carried the server's words (the model's own row, which the kit can only toast, aside)
      expect(personToasts(d).join(' ')).not.toMatch(AGENT_TEXT)
      // DX-4530: the model did not press Sign in, so it is told, once
      const told = toldModel(d)
      expect(told).toHaveLength(1)
      expect(told[0]).toContain('signed this session in')
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
      // DX-4530: told it is signed in, with no plan named (it asked for none)
      const told = toldModel(d)
      expect(told).toHaveLength(1)
      expect(told[0]).toContain('signed this session in')
      expect(told[0]).toContain('call plan_connect to see which plan')
      expect(told[0]).not.toContain('plan_id')
    })

    test('signed in, but the plan connect refused: the model is told it is signed in and that the plan was refused', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      // on PLAN-23, the key lapses: Sign in asks for plan 23 again
      d.world.signedOut = 'lapsed'
      await forceRefresh($, d)
      d.world.signIn.answer = { text: JSON.stringify({ ok: false, status: 409, body: { error: 'plan_archived', message: 'PLAN-23 is archived.' } }) }
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      expect(connectCalls(d)[0]!.args.plan_id).toBe(23)
      expect(d.toasts).toContain('Signed in, but the plan connect was refused: 409 PLAN-23 is archived.')
      const told = toldModel(d)
      expect(told).toHaveLength(1)
      expect(told[0]).toContain('signed this session in')
      expect(told[0]).toContain('plan_id 23 was refused')
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
        // DX-4530: nothing was signed in, so the model is told nothing
        expect(toldModel(d)).toEqual([])
        expect(connectCalls(d)).toHaveLength(1)
        expect(await texts(band)).toContain('Danxbot: signed out')
        expect((await band.find({ key: 'sign-in' })).text).toBe('Sign in')
      })
    }

    // DX-4548: the call that outlives a request answers its renewal: shown to the person and watched in its place
    test('a request that expires is replaced by the renewed one: its page and code are shown and the wait goes on until it is approved', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out', browserClosed: true })
      d.world.signIn.expireAfterCalls = 3
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      await band.press({ key: 'sign-in' })
      for (let i = 0; i < 4; i++) await d.clock.advance(45_000)
      await d.clock.settle()
      expect(d.toasts).toContain('Sign in expired. A new request is open.')
      expect(d.toasts.some(t => t.includes('NEWCODE9') && t.includes(`${APPROVAL_URL}-renewed`))).toBe(true)
      // DX-4630: the renewal swaps the band's link and code
      expect((await band.findAll({ type: 'Link' })).map((l: any) => l.props.href)).toContain(`${APPROVAL_URL}-renewed`)
      expect(await texts(band)).toContain('code NEWCODE9')
      expect(await texts(band)).not.toContain(`code ${CONFIRM_CODE}`)
      expect((await band.find({ key: 'sign-in' })).text).toBe('Signing in…')
      d.world.signIn.approved = true
      await d.clock.advance(45_000)
      await d.clock.settle()
      expect(d.toasts).toContain('Signed in')
    })

    // DX-4548: a request stays open while its session lives, so the wait has no round limit
    test('a request nobody decides is waited on past any round count: no timeout toast, still Signing in…, and approval ends it', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out' })
      // DX-4586: five-second rounds (the shortest the plugin allows), so the 40 rounds cost 200 s of fake clock, not 30 minutes
      d.world.signIn.waitMs = 5_000
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      await band.press({ key: 'sign-in' })
      for (let i = 0; i < 40; i++) await d.clock.advance(5_000)
      await d.clock.settle()
      expect(connectCalls(d).length).toBeGreaterThan(30)
      expect(d.toasts.join(' ')).not.toMatch(/timed out/)
      expect((await band.find({ key: 'sign-in' })).text).toBe('Signing in…')
      d.world.signIn.approved = true
      await d.clock.advance(5_000)
      await d.clock.settle()
      expect(d.toasts).toContain('Signed in')
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
