import "./designated-test-container.mjs";
// CP-15: the engine's test kit raises every call with origin `engine`, so no behavioural test can raise a plugin-origin tool.call. This pins by source
// that the record handlers skip a plugin-raised call (touchRecordClock also a sub-agent's), before touching the clock, git or the context.
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')
const bodyOf = name => {
  const start = source.indexOf(`async function ${name}(`)
  return source.slice(start, source.indexOf('\n}\n', start))
}

test('touchRecordClock leaves the clock alone for a plugin-raised or sub-agent call', () => {
  const body = bodyOf('touchRecordClock')
  const guard = body.indexOf('if (raisedByPlugin(next.origin) || e.agentId !== undefined) return')
  assert.ok(guard >= 0, 'the guard is there')
  assert.ok(guard < body.indexOf('update($, recordClock'), 'guard precedes the clock write')
  for (const caller of ['onAckCall', 'onRecordCall']) assert.ok(bodyOf(caller).indexOf('const r') < bodyOf(caller).indexOf('await touchRecordClock($, e, next)') || bodyOf(caller).indexOf('const ran') < bodyOf(caller).indexOf('await touchRecordClock($, e, next)'), `${caller} touches the clock after next(e)`)
})

test('onHandoffWrite adds nothing and runs no git for a plugin-raised call', () => {
  const body = bodyOf('onHandoffWrite')
  const guard = body.indexOf('raisedByPlugin(next.origin)')
  assert.ok(guard > body.indexOf('const r = await next(e)'), 'guard follows await next(e)')
  assert.ok(guard < body.indexOf('$.process.run') && guard < body.indexOf('HANDOFF_FILE_REMINDER'), 'guard precedes git and the reminder')
})
