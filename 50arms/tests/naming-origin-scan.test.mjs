import "./designated-test-container.mjs";
// CP-93: the engine's test kit raises every call with origin `engine`, so no behavioural test can raise a plugin-origin tool.call. This pins by source
// that the plugin's own calls never name the thread again (the plugin's second session_connect would answer naming again and loop) and that its own
// set_session_title passes straight through the model-rename lock it already holds.
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')
const bodyOf = name => {
  const start = source.indexOf(`async function ${name}(`)
  assert.ok(start >= 0, `${name} exists`)
  return source.slice(start, source.indexOf('\n}', start))
}

test('onSessionConnect names the thread only for a call the model made', () => {
  assert.match(bodyOf('onSessionConnect'), /!raisedByPlugin\(next\.origin\) && e\.disconnect !== true \? await applyNaming\(/)
})

test('onAckCall names the thread after a pickup only for a call the model made', () => {
  assert.match(bodyOf('onAckCall'), /if \(!raisedByPlugin\(next\.origin\)\) named = await applyNaming\(/)
})

test('onModelSetTitle returns a plugin-raised call before it takes the title lock', () => {
  const body = bodyOf('onModelSetTitle')
  assert.ok(body.indexOf('raisedByPlugin(next.origin)') >= 0)
  assert.ok(body.indexOf('raisedByPlugin(next.origin)') < body.indexOf('underTitleLock('))
})
