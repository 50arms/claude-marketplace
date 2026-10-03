// The one parser of a tool's {ok, status, body} result, and the refusal sentence built from it.
import { expect, test } from 'claude-code/testing'

import { refusalText, toolOutcome } from '../hooks/plan/mcp'

const result = (value: unknown, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError })

test('an envelope is read as it is: a refusal is ok false with its status and body, not an error', () => {
  expect(toolOutcome(result({ ok: true, status: 200, body: { x: 1 } }))).toEqual({ ok: true, status: 200, body: { x: 1 } })
  expect(toolOutcome(result({ ok: false, status: 409, body: { error: 'e' } }))).toEqual({ ok: false, status: 409, body: { error: 'e' } })
})

test('an error result carries plain text: it is a failure with that text', () => {
  expect(toolOutcome({ content: [{ type: 'text', text: 'plan_connect: bad arguments' }], isError: true })).toEqual({
    ok: false,
    status: 0,
    body: { error: 'plan_connect: bad arguments' },
  })
})

test('no result, plain text and JSON that is no envelope are failures, never a success', () => {
  expect(toolOutcome(undefined).ok).toBe(false)
  expect(toolOutcome(null).ok).toBe(false)
  expect(toolOutcome({ content: [{ type: 'text', text: 'hello' }], isError: false })).toMatchObject({ ok: false, body: { error: 'hello' } })
  expect(toolOutcome(result({ session: {} })).ok).toBe(false)
  expect(toolOutcome(result([1, 2])).ok).toBe(false)
})

test('a refusal says the server message, and for plan_mismatch which plan the session is on', () => {
  expect(refusalText({ ok: false, status: 409, body: { error: 'session_not_connected', message: 'nothing to leave.' } })).toBe('409 nothing to leave.')
  expect(refusalText({ ok: false, status: 404, body: { error: 'Plan 9 not found' } })).toBe('404 Plan 9 not found')
  expect(
    refusalText({
      ok: false,
      status: 409,
      body: { error: 'plan_mismatch', message: 'on plan 24, not 23.', actual_plan: { id: 24, name: 'Agent mode' } },
    }),
  ).toBe('409 on plan 24, not 23. (PLAN-24 "Agent mode")')
  expect(refusalText({ ok: false, status: 0, body: undefined })).toBe('mcp no detail')
})
