import "./designated-test-container.mjs";
// The engine's test kit raises every call with origin `engine`, so no behavioural test can raise a plugin-origin tool.call. This pins by
// source that onToolStamp takes the whole-suite reminder only for a call the model made: it returns a plugin-raised call before the reminder is read.
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')
const start = source.indexOf('async function onToolStamp(')
const body = source.slice(start, source.indexOf('\n}', start))

test('onToolStamp reads the whole-suite reminder only after it returned a plugin-raised call', () => {
  assert.ok(start >= 0)
  assert.ok(body.indexOf('raisedByPlugin(next.origin)') >= 0)
  assert.ok(body.indexOf('raisedByPlugin(next.origin)') < body.indexOf('wholeSuiteReminder('))
})
