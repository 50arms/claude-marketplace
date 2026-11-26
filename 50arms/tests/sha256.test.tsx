import "./run-tests-with-npm-test.generated"
// The plugin's own SHA-256 (hooks/bundle/sha256.ts), checked against published digests and against the kit's independent one for text whose UTF-8 bytes need care.
import { describe, expect, test } from 'claude-code/testing'

import { sha256Hex } from '../hooks/bundle/sha256'
import { sha256Hex as kitSha256Hex } from './plan-kit'

describe('the plugin sha256', () => {
  test('matches the published digests (FIPS 180-4 examples)', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
    expect(sha256Hex('a'.repeat(1_000_000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
  })

  test('hashes the UTF-8 bytes: multi-byte text, an astral character and a lone surrogate agree with the kit\'s separate implementation', () => {
    for (const text of ['é', 'caf\u00e9 \u20ac \u00e9', '\u{1F600} emoji', 'a\ud800b', '\udc00', 'x'.repeat(55) + '\u00e9', 'x'.repeat(119) + '\u{1F600}']) expect(sha256Hex(text)).toBe(kitSha256Hex(text))
  })

  test('hashes a text at the block edges (55, 56, 63, 64, 65 bytes) as the kit does', () => {
    for (const n of [55, 56, 63, 64, 65, 119, 120, 128]) expect(sha256Hex('q'.repeat(n))).toBe(kitSha256Hex('q'.repeat(n)))
  })
})
