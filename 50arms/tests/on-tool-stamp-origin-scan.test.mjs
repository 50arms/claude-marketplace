import "./designated-test-container.mjs";
// DX-4857: the engine's test kit raises every call with origin `engine`, so no behavioural test can raise a plugin-origin tool.call. This pins by
// source that onToolStamp returns on `raisedByPlugin(next.origin)` right after `await next(e)`, before the session start and the stamp are taken.
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')
const body = source.slice(source.indexOf('async function onToolStamp('))

// A plugin's own call has a result the model never reads, so it must also leave the finished-sub-agent count for the next real result.
test('onToolStamp returns a plugin-raised call right after next(e), before toolResultSent, stampEntries and subagentDoneEntries', () => {
  const next = body.indexOf('const r = await next(e)')
  const guard = body.indexOf('if (raisedByPlugin(next.origin)) return r')
  const sent = body.indexOf('toolResultSent')
  const stamp = body.indexOf('stampEntries')
  assert.ok(next >= 0 && guard > next, 'guard follows await next(e)')
  const reminder = body.indexOf('subagentDoneEntries')
  assert.ok(sent > guard && stamp > guard && reminder > guard, 'guard precedes toolResultSent, stampEntries and subagentDoneEntries')
  const denied = body.indexOf('if (r.deny !== undefined) return r')
  assert.ok(denied > guard && reminder > denied, 'a denied call returns before subagentDoneEntries')
  assert.ok(!body.slice(next + 'const r = await next(e)'.length, guard).replace(/\/\/.*\n/g, '').trim(), 'nothing but comments between')
})
