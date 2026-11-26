import "./designated-test-container.mjs";
// Which checkout versions the plugin tells the bundle's `checkout.behind` text about (hooks/context/app-version.ts): only a minor or major version behind, never a patch.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkoutBehind } from '../hooks/context/app-version.ts'

test('a checkout a minor or major version behind is named with both versions, the file text without its newline', () => {
  assert.deepEqual(checkoutBehind('1.2.9\n', '1.3.0'), { checkout: '1.2.9', dashboard: '1.3.0' })
  assert.deepEqual(checkoutBehind('1.9.9', '2.0.0'), { checkout: '1.9.9', dashboard: '2.0.0' })
})

test('an equal, newer or patch-only-older checkout, a repo with no version file and a file that is no version say nothing', () => {
  assert.equal(checkoutBehind('1.3.0', '1.3.0'), null)
  assert.equal(checkoutBehind('1.3.1', '1.3.0'), null)
  assert.equal(checkoutBehind('1.3.0', '1.3.9'), null)
  assert.equal(checkoutBehind(null, '1.3.0'), null)
  assert.equal(checkoutBehind('not a version', '1.3.0'), null)
})
