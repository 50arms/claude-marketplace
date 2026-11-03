import "./designated-test-container.mjs";
// DX-4857: the engine's test kit raises every call with origin `engine`, so no behavioural test can raise a plugin-origin tool.call. This pins by
// source that onToolStamp returns on `raisedByPlugin(next.origin)` right after the awaited next call, before the session start and the stamp are taken.
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')
// the Bash call's command may be completed (the recorder variable) on its way into next; the call is still awaited first
const NEXT_CALL = "const r = await next(e.tool === 'Bash' ? await withRecorder($, e) : e)"
const body = source.slice(source.indexOf('async function onToolStamp('))

test('onToolStamp returns a plugin-raised call right after the awaited next call, before toolResultSent and stampEntries', () => {
  const next = body.indexOf(NEXT_CALL)
  const guard = body.indexOf('if (raisedByPlugin(next.origin)) return r')
  const sent = body.indexOf('toolResultSent')
  const stamp = body.indexOf('stampEntries')
  assert.ok(next >= 0 && guard > next, 'guard follows await next(e)')
  assert.ok(sent > guard && stamp > guard, 'guard precedes toolResultSent and stampEntries')
  assert.ok(!body.slice(next + NEXT_CALL.length, guard).replace(/\/\/.*\n/g, '').trim(), 'nothing but comments between')
})
