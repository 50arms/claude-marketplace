// DX-4805: the engine's test kit cannot forge a plugin origin, so the one thing no behavioural test can pin is that the module seats the
// tool.check hook at all: without it the plugin's own calls go back to the classifier. This pins the seating by source.
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')

test("register.tsx seats the tool.check hook that answers the plugin's own calls through ownServerCheck", () => {
  assert.match(source, /on\('tool\.check', \(_\$, e, next\) => ownServerCheck\(e, next\)\)/)
})
