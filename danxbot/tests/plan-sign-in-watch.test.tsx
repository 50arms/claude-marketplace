// DX-4548: a sign-in the MODEL started (its plan_connect answered approval_required) is watched by the plugin, which tells the
// model once how it ended (approved, denied or expired), so the person never has to type "approved" into the chat.
import { describe, expect, test } from 'claude-code/testing'

import { signInApprovedNote, signInDeniedNote, signInExpiredNote } from '../hooks/plan/notes'
import { APPROVAL_REQUIRED, CONFIRM_CODE, dashboard, startSession, toldModel } from './plan-kit'

const CALL = { tool: 'mcp__danx-dashboard__plan_connect', plan_id: 23, title: 'PLAN-23: danxbot plugin' } as any
const connectCalls = (d: any) => d.calls.filter((c: any) => c.server === 'danx-dashboard' && c.tool === 'plan_connect')
// the model's own call answers the new request, as the MCP does
const modelConnect = (on: any) => on('tool.call', { tool: 'mcp__danx-dashboard__plan_connect' }, () => ({ result: {}, text: JSON.stringify(APPROVAL_REQUIRED), isError: false }) as any)

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

  test('expired: the call that outlives the request answers a new one, and the model is told to ask again', async ($, on) => {
    const d = dashboard(on, { signedOut: 'signed-out' })
    d.world.signIn.expireAfterCalls = 3
    modelConnect(on)
    await startSession($, d, 'desktop')
    await modelAsks($, d)
    for (let i = 0; i < 5; i++) await d.clock.advance(45_000)
    await d.clock.settle()
    expect(toldModel(d)).toEqual([signInExpiredNote(CONFIRM_CODE)])
    expect(toldModel(d)[0]).toContain('the request expired, call plan_connect to ask again')
    expect(d.toasts).toContain('Sign in expired. Press Sign in again.')
    expect(connectCalls(d)).toHaveLength(3)
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
