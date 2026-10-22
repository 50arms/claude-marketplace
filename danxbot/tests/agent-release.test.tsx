import "./run-tests-with-npm-test.generated"
// DX-5554: when the Claude session ends, the plugin frees the team agent it signed in as at once (DELETE /api/plan-sessions/me/agent), instead of the
// agent staying held for the dashboard's 30-minute dead-session window. Best effort and bounded: a failure is one toast, and a dashboard that never
// answers holds the end for AGENT_RELEASE_DEADLINE_MS at most.
import { describe, expect } from 'claude-code/testing'

import { AGENT_RELEASE_DEADLINE_MS, AGENT_RELEASE_PATH, releaseFailureToast } from '../hooks/plan/agent'
import { test, SURFACES, dashboard, startSession } from './plan-kit'

const AGENT = { id: 6, name: 'Tendai', avatar_url: null }
// the reasons after which the Claude process is gone, and the two after which it carries on (same MCP, same session id)
const PROCESS_ENDS = ['prompt_input_exit', 'logout', 'other'] as const
const PROCESS_CONTINUES = ['clear', 'resume'] as const

for (const surface of SURFACES) {
  describe(`the team agent is freed when the session ends, on ${surface}`, () => {
    async function started($: any, on: any, options: Parameters<typeof dashboard>[1] = {}) {
      on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
      const d = dashboard(on, options)
      d.world.agent = AGENT
      await startSession($, d, surface)
      return d
    }

    for (const reason of PROCESS_CONTINUES) {
      test(`a session ending (${reason}) keeps its agent: the process and its MCP carry on with the same session id`, async ($, on) => {
        const d = await started($, on)
        await $.session.end({ reason, sessionId: 'sess-own' } as any)
        expect(d.releaseCalls).toEqual([])
        expect(d.world.agent).toEqual(AGENT)
        expect(d.toasts).toEqual([])
      })
    }

    for (const reason of PROCESS_ENDS) {
      test(`a session ending (${reason}) releases its agent once, as the plugin's background call`, async ($, on) => {
        const d = await started($, on)
        await $.session.end({ reason, sessionId: 'sess-own' } as any)
        expect(d.releaseCalls).toEqual([{ method: 'DELETE', path: AGENT_RELEASE_PATH, background: true }])
        expect(d.world.agent).toBe(null)
        expect(d.toasts).toEqual([])
      })
    }

    test('a session on no plan releases its agent too', async ($, on) => {
      const d = await started($, on, { connected: false })
      await $.session.end({ reason: 'logout', sessionId: 'sess-own' } as any)
      expect(d.releaseCalls).toHaveLength(1)
    })

    test('a session that held no agent is answered released: false, quietly', async ($, on) => {
      const d = await started($, on)
      d.world.agent = null
      await $.session.end({ reason: 'logout', sessionId: 'sess-own' } as any)
      expect(d.releaseCalls).toHaveLength(1)
      expect(d.toasts).toEqual([])
    })

    for (const signedOut of ['signed-out', 'lapsed', 'revoked'] as const) {
      test(`a ${signedOut} session has no key to release with: no call is made`, async ($, on) => {
        const d = await started($, on, { connected: false, signedOut })
        await $.session.end({ reason: 'logout', sessionId: 'sess-own' } as any)
        expect(d.releaseCalls).toEqual([])
        expect(d.toasts).toEqual([])
      })
    }

    test('a release the dashboard refuses is one toast naming why, and the end completes', async ($, on) => {
      const d = await started($, on)
      d.world.release.status = 500
      await $.session.end({ reason: 'logout', sessionId: 'sess-own' } as any)
      expect(d.toasts).toEqual([releaseFailureToast('500: release boom')])
    })

    test('a rejected call (the server is gone) is one toast too', async ($, on) => {
      const d = await started($, on)
      d.world.release.deny = 'request timed out after 60000ms'
      await $.session.end({ reason: 'logout', sessionId: 'sess-own' } as any)
      expect(d.toasts).toEqual([releaseFailureToast('mcp: danxbot: $.mcp.call: request timed out after 60000ms')])
    })

    test('a dashboard that never answers holds the end for the deadline at most, then one toast', async ($, on) => {
      const d = await started($, on)
      d.world.release.hangs = true
      let ended = false
      const ending = $.session.end({ reason: 'logout', sessionId: 'sess-own' } as any).then(() => (ended = true))
      await d.clock.advance(AGENT_RELEASE_DEADLINE_MS - 1)
      expect(ended).toBe(false)
      await d.clock.advance(1)
      await ending
      expect(d.toasts).toEqual([releaseFailureToast(`timeout: no response within ${AGENT_RELEASE_DEADLINE_MS / 1000}s`)])
      d.release()
    })
  })
}
