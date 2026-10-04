// DX-4374: v0.10.0 pinned a status line (`$.ui.status`); a session hot-reloaded from it keeps the pin unless the
// plugin clears it. The plugin never pins a status line and clears one at session start.
import { describe, expect, test } from 'claude-code/testing'

import { SURFACES, dashboard, startSession } from './plan-kit'

for (const surface of SURFACES) {
  describe(`the status line on ${surface}`, () => {
    test('session start clears any pinned status (the last call is undefined) and no call ever carries a string', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await d.clock.advance(60_000)
      expect(d.statuses.length).toBeGreaterThan(0)
      expect(d.statuses.at(-1)).toBeUndefined()
      expect(d.statuses.filter(s => typeof s === 'string')).toEqual([])
    })

    test('it does so with no danx-dashboard MCP server too', async ($, on) => {
      const d = dashboard(on, { mcp: 'down' })
      await startSession($, d, surface)
      expect(d.statuses).toEqual([undefined])
    })
  })
}
