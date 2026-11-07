import "./run-tests-with-npm-test.generated"
// CP-83 / DX-6917: ONE connect tool, `session_connect`, holds a plan or a card, named by its `target` (`PLAN-n`, or a card's id), and only signs in when it names none.
// The plugin reads that target the way the dashboard does, and a sign-in the model started for a card is watched like one for a plan.
import { describe, expect } from 'claude-code/testing'

import { signInApprovedNote } from '../hooks/plan/notes'
import { connectTargetOf, planTarget } from '../hooks/plan/target'
import { relayLine } from '../hooks/relay/delivery'
import { test, APPROVAL_REQUIRED, CONFIRM_CODE, dashboard, startSession, woken } from './plan-kit'

describe('what a connect target names', () => {
  test('PLAN-n is plan n; the target a call to hold plan n carries is the same text', () => {
    expect(connectTargetOf('PLAN-23')).toEqual({ kind: 'plan', id: 23 })
    expect(planTarget(23)).toBe('PLAN-23')
    expect(connectTargetOf(planTarget(7))).toEqual({ kind: 'plan', id: 7 })
  })

  test('any other text is a card id, as the dashboard reads it: a different case of PLAN- is not a plan', () => {
    expect(connectTargetOf('DX-12')).toEqual({ kind: 'card', ref: 'DX-12' })
    expect(connectTargetOf('plan-23')).toEqual({ kind: 'card', ref: 'plan-23' })
  })

  test('no target, or a PLAN- target that is no plan number, names nothing (the dashboard refuses the second)', () => {
    for (const target of [undefined, null, '', 23, 'PLAN-', 'PLAN-0', 'PLAN-01', 'PLAN-abc', 'PLAN-1.5', 'PLAN--1']) expect(connectTargetOf(target)).toBe(null)
  })
})

const CARD_CALL = { tool: 'mcp__plugin_50arms_platform__session_connect', target: 'DX-9', title: 'Tendai: DX-9 A one-off card' } as any
const connectCalls = (d: any) => d.calls.filter((c: any) => c.server === 'plugin:50arms:platform' && c.tool === 'session_connect')

describe('a sign-in the model started while connecting to a card', () => {
  test('is watched with the call\'s own target, and the model is told once to connect to that card again', async ($, on) => {
    const d = dashboard(on, { signedOut: 'signed-out' })
    on('tool.call', { tool: 'mcp__plugin_50arms_platform__session_connect' }, () => ({ result: {}, text: JSON.stringify(APPROVAL_REQUIRED), isError: false }) as any)
    await startSession($, d, 'desktop')
    await $.tool.call(CARD_CALL)
    await d.clock.settle()
    expect(connectCalls(d)[0].args).toEqual({ target: 'DX-9', title: 'Tendai: DX-9 A one-off card' })
    d.world.signIn.approved = true
    await d.clock.advance(45_000)
    await d.clock.settle()
    expect(woken(d)).toEqual([relayLine(signInApprovedNote(CONFIRM_CODE, 'DX-9'))])
    expect(woken(d)[0]).toContain('call session_connect again now with target DX-9')
  })
})
