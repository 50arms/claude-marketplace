// DX-4548: a sign-in the MODEL started (its plan_connect answered approval_required) is watched by the plugin, which tells the
// model once how it ended (approved, denied or expired), so the person never has to type "approved" into the chat.
import { describe, expect, test } from 'claude-code/testing'

import { SIGN_IN_MIN_ROUND_MS } from '../hooks/plan/config'
import { signInApprovedNote, signInDeniedNote, signInExpiredNote } from '../hooks/plan/notes'
import { APPROVAL_PENDING, APPROVAL_URL, APPROVAL_REQUIRED, CONFIRM_CODE, dashboard, startSession, toldModel } from './plan-kit'

const CALL = { tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect', plan_id: 23, title: 'PLAN-23: danxbot plugin' } as any
const connectCalls = (d: any) => d.calls.filter((c: any) => c.server === 'plugin:danxbot:danx-dashboard' && c.tool === 'plan_connect')
// the model's own call answers the new request, as the MCP does
const modelConnect = (on: any) => on('tool.call', { tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect' }, () => ({ result: {}, text: JSON.stringify(APPROVAL_REQUIRED), isError: false }) as any)

async function modelAsks($: any, d: any) {
  await $.tool.call(CALL)
  await d.clock.settle()
}

describe('a sign-in the model started', () => {
  test('approved: the model is told once to call plan_connect again, and the wait ends', async ($, on) => {
    const d = dashboard(on, { signedOut: 'signed-out' })
    modelConnect(on)
    await startSession($, d, 'desktop')
    await modelAsks($, d)
    // the watch repeats the model's own arguments, and tells nothing while the request is open
    expect(connectCalls(d)[0].args).toEqual({ plan_id: 23, title: 'PLAN-23: danxbot plugin' })
    await d.clock.advance(45_000)
    expect(toldModel(d)).toEqual([])
    d.world.signIn.approved = true
    await d.clock.advance(45_000)
    await d.clock.settle()
    expect(toldModel(d)).toEqual([signInApprovedNote(CONFIRM_CODE, 23)])
    expect(toldModel(d)[0]).toContain('call plan_connect again now')
    // nothing more is told or asked afterwards
    const calls = connectCalls(d).length
    await d.clock.advance(300_000)
    expect(toldModel(d)).toHaveLength(1)
    expect(connectCalls(d)).toHaveLength(calls)
  })

  test('told once: the same request asked again and approved again tells nothing more', async ($, on) => {
    const d = dashboard(on, { signedOut: 'signed-out' })
    modelConnect(on)
    await startSession($, d, 'desktop')
    await modelAsks($, d)
    d.world.signIn.approved = true
    await d.clock.advance(45_000)
    await d.clock.settle()
    expect(toldModel(d)).toHaveLength(1)
    // the key is lost again and the model asks for the very same request id
    d.world.signedOut = 'signed-out'
    d.world.signIn.approved = false
    await modelAsks($, d)
    d.world.signIn.approved = true
    await d.clock.advance(45_000)
    await d.clock.settle()
    expect(toldModel(d)).toHaveLength(1)
  })

  test('denied: the model is told, once, and one toast says so', async ($, on) => {
    const d = dashboard(on, { signedOut: 'signed-out' })
    modelConnect(on)
    await startSession($, d, 'desktop')
    await modelAsks($, d)
    d.world.signIn.answer = { text: JSON.stringify({ state: 'denied', instruction: 'The user denied the request.' }) }
    await d.clock.advance(45_000)
    await d.clock.settle()
    expect(toldModel(d)).toEqual([signInDeniedNote(CONFIRM_CODE)])
    expect(d.toasts).toContain('Sign in was denied.')
  })

  test('expired: the model is told a renewed request is open, and the renewed request is shown and watched, so its approval is told too', async ($, on) => {
    const d = dashboard(on, { signedOut: 'signed-out' })
    d.world.signIn.expireAfterCalls = 3
    modelConnect(on)
    await startSession($, d, 'desktop')
    await modelAsks($, d)
    for (let i = 0; i < 5; i++) await d.clock.advance(45_000)
    await d.clock.settle()
    expect(toldModel(d)).toEqual([signInExpiredNote(CONFIRM_CODE)])
    expect(toldModel(d)[0]).toContain('a renewed request is already open')
    expect(d.toasts).toContain('Sign in expired. A new request is open.')
    // the renewed request reached the person
    expect(d.toasts.some(t => t.includes('NEWCODE9') && t.includes(`${APPROVAL_URL}-renewed`))).toBe(true)
    // and is watched: its approval is told once, with its own code
    d.world.signIn.approved = true
    await d.clock.advance(45_000)
    await d.clock.settle()
    expect(toldModel(d)).toEqual([signInExpiredNote(CONFIRM_CODE), signInApprovedNote('NEWCODE9', 23)])
  })

  test('a renewed request the model receives as approval_pending is still shown to the person', async ($, on) => {
    const d = dashboard(on, { signedOut: 'signed-out' })
    // the model's own call answers a request this session has not shown yet, but as pending
    on('tool.call', { tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect' }, () => ({ result: {}, text: JSON.stringify({ ...APPROVAL_PENDING, approvalUrl: `${APPROVAL_URL}-renewed`, confirmCode: 'NEWCODE9' }), isError: false }) as any)
    await startSession($, d, 'desktop')
    await modelAsks($, d)
    expect(d.toasts.some(t => t.includes('NEWCODE9') && t.includes(`${APPROVAL_URL}-renewed`))).toBe(true)
    expect(connectCalls(d).length).toBeGreaterThan(0)
  })

  test('a request with no id is refused: it is not watched and nothing is told', async ($, on) => {
    const d = dashboard(on, { signedOut: 'signed-out' })
    on('tool.call', { tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect' }, () => ({ result: {}, text: JSON.stringify({ ...APPROVAL_REQUIRED, approvalUrl: 'http://localhost:5555/' }), isError: false }) as any)
    await startSession($, d, 'desktop')
    await modelAsks($, d)
    expect(connectCalls(d)).toHaveLength(0)
    expect(d.toasts.some(t => t.includes('had no id'))).toBe(true)
    expect(toldModel(d)).toEqual([])
    // DX-4630: nothing stays drawn for the refused request, and a later Sign in press starts its own watch
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } } as any)
    expect((await band.findAll({ type: 'Link' })).map((l: any) => l.props.href)).not.toContain('http://localhost:5555/')
    d.world.signIn.answer = undefined
    await band.press({ key: 'sign-in' })
    await d.clock.settle()
    expect(connectCalls(d).length).toBeGreaterThan(0)
    expect((await band.findAll({ type: 'Link' })).map((l: any) => l.props.href)).toContain(APPROVAL_URL)
  })

  for (const reason of ['clear', 'resume'] as const) {
    test(`/${reason} mid-watch ends the watch: no further plan_connect call, nothing told to the new conversation`, async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out' })
      modelConnect(on)
      on('session.end', () => ({ sessionId: 's1' }) as any)
      await startSession($, d, 'desktop')
      await modelAsks($, d)
      await $.session.end({ reason } as any)
      const calls = connectCalls(d).length
      d.world.signIn.approved = true
      await d.clock.advance(300_000)
      await d.clock.settle()
      expect(connectCalls(d)).toHaveLength(calls)
      expect(toldModel(d)).toEqual([])
    })
  }

  test('/clear while plan_connect is in flight frees the sign-in key at once: the new conversation watch runs', async ($, on) => {
    const d = dashboard(on, { signedOut: 'signed-out' })
    modelConnect(on)
    on('session.end', () => ({ sessionId: 's1' }) as any)
    await startSession($, d, 'desktop')
    await modelAsks($, d)
    // the first watch's plan_connect is still out (the MCP's wait); abort it
    await $.session.end({ reason: 'clear' } as any)
    const calls = connectCalls(d).length
    await modelAsks($, d)
    expect(connectCalls(d).length).toBeGreaterThan(calls)
  })

  test('an MCP that answers pending at once is not spun: rounds are paced by the minimum round duration', async ($, on) => {
    const d = dashboard(on, { signedOut: 'signed-out' })
    d.world.signIn.answer = { text: JSON.stringify(APPROVAL_PENDING) }
    modelConnect(on)
    await startSession($, d, 'desktop')
    await modelAsks($, d)
    await d.clock.advance(60_000)
    await d.clock.settle()
    // 60 s at one round per SIGN_IN_MIN_ROUND_MS
    expect(connectCalls(d).length).toBeLessThanOrEqual(60_000 / SIGN_IN_MIN_ROUND_MS + 2)
    expect(connectCalls(d).length).toBeGreaterThan(1)
  })

  test('a repeat call of the model (the request pending) starts no second wait', async ($, on) => {
    const d = dashboard(on, { signedOut: 'signed-out' })
    modelConnect(on)
    await startSession($, d, 'desktop')
    await modelAsks($, d)
    const calls = connectCalls(d).length
    await modelAsks($, d)
    expect(connectCalls(d)).toHaveLength(calls)
  })

  test('the band Sign in press that is denied tells the model nothing: it did not ask', async ($, on) => {
    const d = dashboard(on, { signedOut: 'signed-out' })
    d.world.signIn.answer = { text: JSON.stringify({ state: 'denied' }) }
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } } as any)
    await band.press({ key: 'sign-in' })
    await d.clock.settle()
    expect(d.toasts).toContain('Sign in was denied.')
    expect(toldModel(d)).toEqual([])
  })
})
