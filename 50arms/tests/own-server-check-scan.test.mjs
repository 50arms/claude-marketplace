import "./designated-test-container.mjs";
// DX-4805: the engine's test kit cannot forge a plugin origin, so the one thing no behavioural test can pin is that the module seats the
// tool.check hook at all: without it the plugin's own calls go back to the classifier. This pins the seating by source.
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')

test("register.tsx seats the tool.check hook that answers the plugin's own calls through ownServerCheck", () => {
  assert.match(source, /on\('tool\.check', \(\$, e, next\) => ownServerCheck\(e, Object\.assign\(\(x: any\) => legacyRuleCheck\(x, next, \(\) => readLegacySettings\(\$\)\), \{ origin: next\.origin \}\)\)\)/)
})

// CP-70 (temporary dual name): the legacy-rule check is seated inside that one registration (the plugin allows a single unmatched tool.check), reads the settings through readLegacySettings,
// and the plugin's own call, whose origin the wrapper keeps, still reaches ownServerCheck first.
test("register.tsx seats legacyRuleCheck once, reads the three settings files read-only, and registers no second unmatched tool.check", () => {
  assert.equal(source.match(/on\('tool\.check'/g).length, 1)
  assert.equal(source.match(/legacyRuleCheck\(/g).length, 1)
  const reader = source.slice(source.indexOf('async function readLegacySettings'), source.indexOf('async function readLegacySettings') + 900)
  assert.match(reader, /legacySettingsPaths\(/)
  assert.match(reader, /\$\.fs\.read\(/)
  assert.doesNotMatch(reader, /\$\.fs\.write|\$\.fs\.remove/)
})
