import "./run-tests-with-npm-test.generated"
// CP-146: the plugin delivers every hook text from the policy bundle (`GET /api/behavior-events/bundle`), holds an agent context that has no current bundle, owes it the start texts it missed,
// and reports what it delivered and held. Written for the kit's stand-in dashboard (`plan-kit.tsx`: `world.bundle`, `world.deliveryReports`, `world.floorSends`); the pure parts are in `bundle-pure.test.tsx`.
import { describe, expect } from 'claude-code/testing'

import { floorLines } from '../hooks/bundle/floor'
import { RETRY_WINDOW_MS } from '../hooks/bundle/hold'
import { test, EVENT_TEXT, NEXT_BUNDLE_VERSION, PLUGIN_VERSION, SURFACES, answerReportEvents, bundleEvent, dashboard, firstPrompt, startSession } from './plan-kit'

const MIN = 60_000
const SUB = { agent_id: 'a1', agent_type: '50arms:worker-sonnet-high' }
const tool = async ($: any, agentId?: string) => (await $.tool.call({ tool: 'Bash', command: 'ls', ...(agentId === undefined ? {} : { agentId }) } as any)) as any
const reports = (d: any) => d.world.deliveryReports.flatMap((r: any) => r.body.reports) as any[]

for (const surface of SURFACES) {
  describe(`the policy bundle on ${surface}`, () => {
    async function started($: any, on: any, options: Parameters<typeof dashboard>[1] = {}) {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.SubagentStart', () => ({}) as any)
      const d = dashboard(on, options)
      await startSession($, d, surface)
      return d
    }

    test('the session start is told from the bundle, the read names the plugin version, and the delivery is reported in the background', async ($, on) => {
      const d = await started($, on)
      expect((await firstPrompt($, 'startup')).startLines).toEqual([EVENT_TEXT('session_start')])
      await d.clock.settle()
      expect(d.world.bundleReads[0]).toEqual({ plugin_version: PLUGIN_VERSION, known_version: undefined })
      const delivered = reports(d).filter(r => r.kind === 'delivery' && r.event === 'session.start')
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toMatchObject({ kind: 'delivery', mechanism: 'plugin.context', attachment_ids: [100], chars: EVENT_TEXT('session_start').length })
      expect(typeof delivered[0].delivered_at).toBe('string')
    })

    test('the floor lines are sent once after the first bundle answer, while the team holds none, and not again once it holds this plugin version', async ($, on) => {
      const d = await started($, on)
      await firstPrompt($, 'startup')
      await d.clock.settle()
      expect(d.world.floorSends).toHaveLength(1)
      expect(d.world.floorSends[0].body.plugin_version).toBe(PLUGIN_VERSION)
      expect(d.world.floorSends[0].body.lines.map((l: any) => l.reason)).toEqual(expect.arrayContaining(['signed_out', 'loading', 'dashboard_unreachable', 'key_revoked']))
      d.world.bundle.floorVersion = PLUGIN_VERSION
      await d.clock.advance(2 * MIN)
      await $.prompt.submit({ text: 'again' })
      await d.clock.settle()
      expect(d.world.floorSends).toHaveLength(1)
    })

    // CP-146 (DEC-1453): the sign-in and outage floor is more than the hold lines: what to do when the session is not connected to 50 Arms, and how to report an error to the person
    test('the floor send carries the relay failure lines, the revoke and sign-in notes, the expired permission, the failed report, the foreground-lock notice and the disk fault lines, each with its placeholders and no one session value', async ($, on) => {
      const d = await started($, on)
      await firstPrompt($, 'startup')
      await d.clock.settle()
      const sent = d.world.floorSends[0].body.lines as { reason: string; event: string; text: string }[]
      const NOTICE_REASONS = ['relay_stopped', 'relay_refused', 'relay_delayed', 'relay_stalled', 'revoke_note', 'revoke_note_failed', 'sign_in_note_no_target', 'sign_in_note_refused', 'sign_in_note_connected', 'sign_in_approved', 'sign_in_approved_no_target', 'sign_in_denied', 'sign_in_expired', 'permission_expired', 'report_failed', 'foreground_lock', 'disk_check_failed', 'disk_floors_unavailable']
      for (const reason of NOTICE_REASONS) {
        const line = sent.find(l => l.reason === reason)
        expect(line, `the floor send lacks ${reason}`).toBeDefined()
        expect(line!.text.length).toBeGreaterThan(0)
        expect([...line!.text].length).toBeLessThanOrEqual(10_000)
      }
      // a value of the session stands as a placeholder, never as a value
      expect(sent.find(l => l.reason === 'relay_stopped')!.text).toContain('{{slot:detail}}')
      expect(sent.find(l => l.reason === 'sign_in_denied')!.text).toContain('{{slot:code}}')
      expect(sent.find(l => l.reason === 'disk_check_failed')!.text).toContain('{{slot:detail}}')
      // the set sent is the set the plugin holds, one line per (reason, event)
      expect(sent).toEqual(floorLines())
      expect(new Set(sent.map(l => `${l.reason}/${l.event}`)).size).toBe(sent.length)
    })

    test('a once-only text is told once per agent context: the main conversation and each sub-agent count apart', async ($, on) => {
      const d = await started($, on)
      d.world.bundle.events['subagent.start'] = bundleEvent('subagent.start', ['Mantra.'], { id: 300, frequency: 'once_per_session', mechanism: 'plugin.context' })
      await firstPrompt($, 'startup')
      const first = await $.classic.SubagentStart(SUB)
      const other = await $.classic.SubagentStart({ ...SUB, agent_id: 'a2' })
      const again = await $.classic.SubagentStart(SUB)
      expect(first.additionalContext).toEqual(['Mantra.'])
      expect(other.additionalContext).toEqual(['Mantra.'])
      expect(again.additionalContext).toBeUndefined()
    })

    test('a stop that a Stop hook already blocked is never blocked by an attached text', async ($, on) => {
      const d = await started($, on)
      d.world.bundle.events['turn.stop'] = bundleEvent('turn.stop', ['Keep going.'], { id: 400, mechanism: 'plugin.stop_block' })
      await firstPrompt($, 'startup')
      const stop = await $.classic.Stop({ stop_hook_active: true })
      expect(stop?.block).toBeUndefined()
    })

    describe('a bundle that cannot be had', () => {
      test('a session holding a bundle is held once it is no longer current: the loading line for 2 minutes (a deploy), then the hold line, and session_connect always runs', async ($, on) => {
        const d = await started($, on)
        await firstPrompt($, 'startup')
        expect((await tool($)).deny).toBeUndefined()
        d.world.bundle.override = { status: 503, body: { error: 'dashboard_unreachable', unreachable_since: '2026-10-03T08:00:00.000Z' } }
        await d.clock.advance(2 * MIN)
        const loading = await tool($)
        expect(loading.deny).toMatch(/loading/)
        expect(loading.deny).not.toMatch(/critical/i)
        await d.clock.advance(RETRY_WINDOW_MS)
        const held = await tool($)
        expect(held.deny).toMatch(/CRITICAL/)
        expect((await $.tool.call({ tool: 'mcp__plugin_50arms_platform__session_connect' } as any)).deny).toBeUndefined()
        d.world.bundle.override = undefined
        expect((await $.prompt.submit({ text: 'back' })).context).toBeDefined()
        expect((await tool($)).deny).toBeUndefined()
      })

      test('a start with no bundle is owed: the start hook tells the loading line, every tool call is refused, and once a bundle arrives the owed texts are delivered before the context runs a tool', async ($, on) => {
        const d = await started($, on)
        d.world.bundle.override = { status: 503, body: { error: 'dashboard_unreachable' } }
        await firstPrompt($, 'startup')
        const sub = await $.classic.SubagentStart(SUB)
        expect((sub.additionalContext ?? []).join('\n')).toMatch(/loading/)
        expect((await tool($, 'a1')).deny).toMatch(/loading/)
        d.world.bundle.override = undefined
        await d.clock.advance(MIN)
        // the next call of the sub-agent is refused with its owed start text, so it reads them, then retries the step
        const refused = await tool($, 'a1')
        expect(refused.deny).toContain(EVENT_TEXT('sub_agent_start'))
        expect((await tool($, 'a1')).deny).toBeUndefined()
      })

      test('a plugin below the floor is held with the version to update to, and the open hold is reported, then ended', async ($, on) => {
        const d = await started($, on)
        d.world.bundle.minPlugin = '9.0.0'
        await $.prompt.submit({ text: 'hello' })
        await d.clock.advance(RETRY_WINDOW_MS + 1_000)
        expect((await tool($)).deny).toMatch(/9\.0\.0/)
        await d.clock.settle()
        const open = reports(d).filter(r => r.kind === 'hold')
        expect(open).toHaveLength(1)
        expect(open[0]).toMatchObject({ kind: 'hold', agent_id: null, plugin_version: PLUGIN_VERSION })
        expect(open[0].ended_at).toBeUndefined()
        d.world.bundle.minPlugin = '0.17.0'
        await $.prompt.submit({ text: 'fixed' })
        await d.clock.settle()
        const ended = reports(d).filter(r => r.kind === 'hold' && r.ended_at !== undefined)
        expect(ended).toHaveLength(1)
        expect(ended[0].started_at).toBe(open[0].started_at)
      })

      test('a bundle that cannot be read holds the context like a failed fetch', async ($, on) => {
        const d = await started($, on)
        d.world.bundle.override = { status: 200, body: { version: 'not a version' } }
        await $.prompt.submit({ text: 'hello' })
        await d.clock.advance(RETRY_WINDOW_MS + 1_000)
        expect((await tool($)).deny).toMatch(/CRITICAL/)
      })
    })

    describe('the reports', () => {
      test('a delivery report that fails is retried at 1, 2 and 4 minutes, then fails loudly: the context is told once, the band shows it, and one report_failed item is sent in a request of its own', async ($, on) => {
        const d = await started($, on)
        d.world.reportReplies['POST /api/plan-sessions/me/behavior-events'] = { status: 500, body: { error: 'report boom' } }
        await firstPrompt($, 'startup')
        await d.clock.settle()
        const before = d.world.deliveryReports.length
        await d.clock.advance(MIN)
        await d.clock.advance(2 * MIN)
        await d.clock.advance(4 * MIN)
        await d.clock.settle()
        expect(d.world.deliveryReports.length).toBeGreaterThan(before)
        const failed = reports(d).filter(r => r.kind === 'report_failed')
        expect(failed).toHaveLength(1)
        expect(failed[0]).toMatchObject({ kind: 'report_failed', plugin_version: PLUGIN_VERSION })
        // a failed report_failed is dropped without a further report about it
        await d.clock.advance(10 * MIN)
        expect(reports(d).filter(r => r.kind === 'report_failed')).toHaveLength(1)
      })

      test('a 400 is a contract mismatch: not retried, failed loudly at once', async ($, on) => {
        const d = await started($, on)
        d.world.reportReplies['POST /api/plan-sessions/me/behavior-events'] = { status: 400, body: { error: 'bad_report' } }
        await firstPrompt($, 'startup')
        await d.clock.settle()
        const sends = d.world.deliveryReports.length
        await d.clock.advance(10 * MIN)
        // only the report_failed item follows, once
        expect(d.world.deliveryReports.length).toBeLessThanOrEqual(sends + 1)
        expect(reports(d).filter(r => r.kind === 'report_failed')).toHaveLength(1)
      })
    })

    describe('the role from session.bind', () => {
      test('a bundle that carries a session.bind event delivers the role as an entry of its own, once per role, never joined with an event text', async ($, on) => {
        const d = await started($, on)
        d.world.bundle.events['session.bind'] = bundleEvent('session.bind', ['Your role: work the card.'], { id: 500, frequency: 'once_per_session' })
        const first = await firstPrompt($, 'startup')
        expect(first.context).toContain('Your role: work the card.')
        expect(first.context.filter(c => c.includes('Your role'))).toEqual(['Your role: work the card.'])
        expect(first.context.some(c => c.includes('Your role') && c.includes(EVENT_TEXT('session_start')))).toBe(false)
        const next = ((await $.prompt.submit({ text: 'next' })).context ?? []) as string[]
        expect(next.some(c => c.includes('Your role'))).toBe(false)
      })

      test('a bundle with no session.bind event delivers no role', async ($, on) => {
        const d = await started($, on)
        const first = await firstPrompt($, 'startup')
        expect(first.context.some(c => c.includes('role'))).toBe(false)
        expect(d.world.bundleReads.length).toBeGreaterThan(0)
      })
    })

    test('a policy edit reaches the running session through the behavior-bundle session file, with no restart', async ($, on) => {
      const d = await started($, on)
      await firstPrompt($, 'startup')
      d.world.bundle.version = NEXT_BUNDLE_VERSION
      d.world.eventText['sub_agent_start'] = 'Edited mantra.'
      const reads = d.world.bundleReads.length
      // the relay writes the file naming the new version; the next call refetches with the known version (while the relay streams the file is read at once, otherwise the minute check finds the edit)
      d.world.files[`/home/u/.config/danxbot/behavior-bundle/${d.world.sessionId}.json`] = JSON.stringify({ v: 1, sessionId: d.world.sessionId, version: NEXT_BUNDLE_VERSION })
      await d.clock.advance(MIN)
      const sub = await $.classic.SubagentStart(SUB)
      expect(d.world.bundleReads.length).toBeGreaterThan(reads)
      expect(sub.additionalContext).toEqual(['Edited mantra.'])
    })

    test('with nothing telling the session its bundle changed, the plugin asks 50 Arms again every minute in the background, and no call waits for the answer', async ($, on) => {
      const d = await started($, on)
      await firstPrompt($, 'startup')
      d.world.bundle.version = NEXT_BUNDLE_VERSION
      d.world.eventText['sub_agent_start'] = 'Edited mantra.'
      const reads = d.world.bundleReads.length
      await d.clock.advance(MIN + 1_000)
      expect(d.world.bundleReads.length).toBeGreaterThan(reads)
      expect(d.world.bundleReads.at(-1)).toMatchObject({ known_version: expect.any(String) })
      expect((await $.classic.SubagentStart(SUB)).additionalContext).toEqual(['Edited mantra.'])
    })

    test('a bundle that cannot be confirmed because the minute check fails is held as a broken relay once 90 s pass', async ($, on) => {
      const d = await started($, on)
      await firstPrompt($, 'startup')
      d.world.bundle.override = { status: 500, body: { error: 'boom' } }
      await d.clock.advance(2 * MIN)
      expect((await tool($)).deny).toMatch(/loading/)
      await d.clock.advance(RETRY_WINDOW_MS + MIN)
      expect((await tool($)).deny).toMatch(/relay that tells this session when its instructions change is broken/)
    })

    describe('a held main conversation at a stop', () => {
      const STOP = { stop_hook_active: false, background_tasks: [] } as any
      const READY_CARD = { id: 'DX-1', type: 'Story', title: 'A card', assigned_agent: null, dispatch: null, blocked: null, open_problem_count: 0, waiting_on: false, conflict_on_active_count: 0, review_runnable: false, next_pre_gate: null }

      test('is never also told by a pick-up-cards block, and a stop never uses up the start texts it is owed: the next prompt tells them', async ($, on) => {
        answerReportEvents(on)
        const d = await started($, on)
        d.world.bundle.override = { status: 503, body: { error: 'dashboard_unreachable' } }
        await firstPrompt($, 'startup')
        d.world.readyRows[7] = [READY_CARD]
        expect((await $.classic.Stop(STOP))?.block).toBeUndefined()
        d.world.bundle.override = undefined
        await d.clock.advance(MIN)
        // the bundle is back: the stop now blocks for the ready card, and the owed start texts are still owed
        expect((await $.classic.Stop(STOP))?.block).toMatch(/DX-1/)
        const next = ((await $.prompt.submit({ text: 'again' })).context ?? []) as string[]
        expect(next.join('\n')).toContain(EVENT_TEXT('session_start'))
      })
    })
  })
}
