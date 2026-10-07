// How the pane words an age (the pacing panel's "targets last read ..."), against the fake clock, never Date.now.
import { describe, expect, test } from 'claude-code/testing'

import { age } from '../hooks/plan/words'

describe('how the pane words an age', () => {
  const NOW = Date.parse('2026-10-03T08:00:00.000Z')
  for (const [iso, words] of [
    ['2026-10-03T07:58:30.000Z', '1m ago'],
    ['2026-10-03T07:55:00.000Z', '5m ago'],
    ['2026-10-03T06:00:00.000Z', '2h ago'],
    ['2026-09-30T08:00:00.000Z', '3d ago'],
  ] as const) {
    test(`${iso} reads ${words}`, () => {
      expect(age(iso, NOW)).toBe(words)
    })
  }
})
