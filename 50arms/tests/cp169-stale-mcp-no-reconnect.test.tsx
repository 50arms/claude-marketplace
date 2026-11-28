import "./run-tests-with-npm-test.generated"
// CP-169 (DEC-3131, EV-205): a session whose running MCP is older than the plugin is held; the hold names the two fixes (revert the plugin release, or restart
// the session), the plugin makes no connector reconnect request, and every tool runs, the reconnect tool too (dan, 2026-11-28).
import { describe, expect } from 'claude-code/testing'

import { RETRY_WINDOW_MS } from '../hooks/bundle/hold'
import { test, SURFACES, dashboard, startSession } from './plan-kit'

const tool = async ($: any) => (await $.tool.call({ tool: 'Bash', command: 'ls' } as any)) as any
// dan, 2026-11-28: a held context's calls run; what it is told rides beside the result (a call another hook denied carries it in the denial)
const said = (r: any): string => [...(typeof r?.deny === 'string' ? [r.deny] : []), ...((r?.context ?? []) as string[])].join('\n\n')

async function staleHeld($: any, on: any, surface: any) {
  on('classic.SessionStart', () => ({}) as any)
  on('classic.Stop', () => ({}) as any)
  on('tool.call', () => ({ result: {}, text: 'done' }) as any)
  const d = dashboard(on, { mcp: 'beforeReplyToFile' })
  await startSession($, d, surface)
  await $.prompt.submit({ text: 'hello' })
  await d.clock.advance(RETRY_WINDOW_MS + 1_000)
  return d
}

for (const surface of SURFACES) {
  describe(`a stale-MCP hold on ${surface}`, () => {
    test('the plugin makes no connector reconnect request', async ($, on) => {
      const d = await staleHeld($, on, surface)
      expect(said(await tool($))).toMatch(/CRITICAL/)
      expect(d.world.connectors.reconnects).toEqual([])
    })

    test('the reconnect tool runs like any other, and is told the hold line', async ($, on) => {
      await staleHeld($, on, surface)
      const reconnect = (await $.tool.call({ tool: 'mcp__ccd_connectors__reconnect_session_connector', server: 'plugin:50arms:platform' } as any)) as any
      expect(reconnect.deny).toBeUndefined()
      expect(said(reconnect)).toMatch(/CRITICAL/)
    })

    test('the hold line names the revert and the restart', async ($, on) => {
      await staleHeld($, on, surface)
      expect(said(await tool($))).toContain('revert the plugin release, or restart the session')
    })
  })
}
