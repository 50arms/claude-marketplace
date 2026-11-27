import "./run-tests-with-npm-test.generated"
// CP-146: the plugin delivers every hook text from the policy bundle (`GET /api/behavior-events/bundle`), holds an agent context that has no current bundle, owes it the start texts it missed,
// and reports what it delivered and held. Written for the kit's stand-in dashboard (`plan-kit.tsx`: `world.bundle`, `world.deliveryReports`, `world.floorSends`); the pure parts are in `bundle-pure.test.tsx`.
import { describe, expect } from 'claude-code/testing'

import { floorLines } from '../hooks/bundle/floor'
import { RETRY_WINDOW_MS } from '../hooks/bundle/hold'
import { RETRY_DELAYS_MS } from '../hooks/bundle/reports'
import { CONTEXT_DEADLINE_MS } from '../hooks/context/events'
import { test, BUNDLE_FILE_PATH, relayPhase, EVENT_TEXT, NEXT_BUNDLE_VERSION, PLUGIN_VERSION, SURFACES, bundleEvent, bundleFileText, dashboard, deliveredReports, firstPrompt, sha256Hex, startSession } from './plan-kit'

const MIN = 60_000
const NEWER_THAN_ANSWER = `${'c'.repeat(63)}3`
const SUB = { agent_id: 'a1', agent_type: '50arms:worker-sonnet-high' }
const tool = async ($: any, agentId?: string) => (await $.tool.call({ tool: 'Bash', command: 'ls', ...(agentId === undefined ? {} : { agentId }) } as any)) as any
const holdsNow = (d: any) => Object.keys((d.stateWrites.filter((w: any) => w.key === 'behavior').at(-1)?.value as any)?.holds ?? {})
const reports = (d: any) => d.world.deliveryReports.flatMap((r: any) => r.body.reports) as any[]

for (const surface of SURFACES) {
  describe(`the policy bundle on ${surface}`, () => {
    async function started($: any, on: any, options: Parameters<typeof dashboard>[1] = {}) {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.SubagentStart', () => ({}) as any)
      on('classic.SubagentStop', () => ({}) as any)
      on('classic.Stop', () => ({}) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
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

      // CP-169: an MCP server older than the plugin refuses the bundle fetch's `reply_to_file`; the hold has its own reason, refuses what any hold refuses, and ends once the server is current
      test('a session whose running MCP is older than the plugin is held as stale_mcp: 50arms_api stays refused, session_connect runs, and the hold ends once the server is current', async ($, on) => {
        const d = await started($, on, { mcp: 'beforeReplyToFile' })
        await $.prompt.submit({ text: 'hello' })
        await d.clock.advance(RETRY_WINDOW_MS + 1_000)
        expect((await tool($)).deny).toMatch(/CRITICAL/)
        expect(((await $.tool.call({ tool: 'mcp__plugin_50arms_platform__50arms_api', method: 'GET', path: '/api/auth/me' } as any)) as any).deny).toMatch(/CRITICAL/)
        expect(((await $.tool.call({ tool: 'mcp__plugin_50arms_platform__session_connect' } as any)) as any).deny).toBeUndefined()
        await d.clock.settle()
        const open = reports(d).filter(r => r.kind === 'hold')
        expect(open).toHaveLength(1)
        expect(open[0]).toMatchObject({ reason: 'stale_mcp' })
        d.setMcp('up')
        await $.prompt.submit({ text: 'restarted' })
        await d.clock.settle()
        expect((await tool($)).deny).toBeUndefined()
        expect(reports(d).filter(r => r.kind === 'hold' && r.ended_at !== undefined)).toHaveLength(1)
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
        // one delivery, so one report fails
        await $.classic.SubagentStart(SUB)
        await d.clock.settle()
        const before = d.world.deliveryReports.length
        await d.clock.advance(MIN)
        await d.clock.advance(2 * MIN)
        await d.clock.advance(4 * MIN)
        // the report_failed item is sent by the flush the loud failure schedules, a second later
        await d.clock.advance(2_000)
        await d.clock.settle()
        expect(d.world.deliveryReports.length).toBeGreaterThan(before)
        const failed = reports(d).filter(r => r.kind === 'report_failed')
        expect(failed).toHaveLength(1)
        expect(failed[0]).toMatchObject({ kind: 'report_failed', plugin_version: PLUGIN_VERSION })
        // the report_failed item follows the same bound (the send and 3 retries) and, once they are spent, is dropped without a further report about it
        await d.clock.advance(10 * MIN)
        const attempts = reports(d).filter(r => r.kind === 'report_failed')
        expect(attempts).toHaveLength(1 + RETRY_DELAYS_MS.length)
        expect(new Set(attempts.map(r => r.at)).size).toBe(1)
      })

      test('a 400 is a contract mismatch: not retried, failed loudly at once', async ($, on) => {
        const d = await started($, on)
        d.world.reportReplies['POST /api/plan-sessions/me/behavior-events'] = { status: 400, body: { error: 'bad_report' } }
        // one delivery, so one report fails
        await $.classic.SubagentStart(SUB)
        await d.clock.settle()
        const sends = d.world.deliveryReports.length
        await d.clock.advance(10 * MIN)
        // only the report_failed item follows, once
        expect(d.world.deliveryReports.length).toBeLessThanOrEqual(sends + 1)
        expect(reports(d).filter(r => r.kind === 'report_failed')).toHaveLength(1)
      })
    })

    describe('the role from session.bind', () => {
      const ROLE = (text = 'Your role: work the card.') => ({ key: 'role', mechanism: 'plugin.context', frequency: 'every', text, chars: text.length, rules: [{ ref: 'BPR-9', content_hash: 'e'.repeat(64) }] })
      const BOUND = (d: any) => (d.world.bundle.events['session.bind'] = bundleEvent('session.bind', []))
      const roleTold = (c: string[]) => c.filter(x => x.includes('Your role'))

      test('the role is fetched as a file when session.bind is told and delivered as an entry of its own, once per role, never joined with an event text', async ($, on) => {
        const d = await started($, on)
        BOUND(d)
        d.world.role = ROLE()
        const first = await firstPrompt($, 'startup')
        expect(roleTold(first.context)).toEqual(['Your role: work the card.'])
        expect(first.context.some(c => c.includes('Your role') && c.includes(EVENT_TEXT('session_start')))).toBe(false)
        expect(d.world.roleReads).toEqual([{ plugin_version: PLUGIN_VERSION, reply_to_file: true }])
        expect(d.world.repliedAsFile).toContain('/api/plan-sessions/me/role')
        const next = ((await $.prompt.submit({ text: 'next' })).context ?? []) as string[]
        expect(roleTold(next)).toEqual([])
        expect(d.world.roleReads).toHaveLength(1)
        await d.clock.settle()
        expect(deliveredReports(d, 'session.bind').map(r => r.attachment_ids)).toEqual([[]])
      })

      test('a null answer (a session on neither a plan nor a card) delivers nothing and holds nothing', async ($, on) => {
        const d = await started($, on)
        BOUND(d)
        d.world.role = null
        const first = await firstPrompt($, 'startup')
        expect(roleTold(first.context)).toEqual([])
        expect((await tool($)).deny).toBeUndefined()
      })

      test('a role over the entry cap is delivered through the temporary file the agent is told to read', async ($, on) => {
        const d = await started($, on)
        d.world.bundle.events['session.bind'] = bundleEvent('session.bind', [], { cap: 10_000 })
        const big = `Your role: ${'work. '.repeat(3_000)}`
        d.world.role = ROLE(big)
        const first = await firstPrompt($, 'startup')
        const file = /read (\/home\/u\/\.config\/danxbot\/behavior-text\/\S+\.txt)\./.exec(first.context.join('\n'))?.[1]
        expect(file).toBeDefined()
        expect(d.world.files[file as string]).toBe(big)
      })

      test('a body whose sha256 differs from the one the answer names is a failed fetch: the context is held and the role is told once it can be fetched', async ($, on) => {
        const d = await started($, on)
        BOUND(d)
        d.world.role = ROLE()
        d.world.bundle.events['session.after_compaction'] = bundleEvent('session.after_compaction', ['Compacted.'], { id: 330 })
        await firstPrompt($, 'startup')
        d.world.replySha256 = 'f'.repeat(64)
        const compacted = await firstPrompt($, 'compact')
        expect(roleTold(compacted.context)).toEqual([])
        expect(compacted.context.join('\n')).toMatch(/loading/)
        d.world.replySha256 = undefined
        await d.clock.advance(RETRY_WINDOW_MS + 10_000)
        const refused = (await tool($)).deny as string
        expect(refused).toContain('\n\nYour role: work the card.')
      })

      test('a failed fetch holds the main conversation: the next tool call is refused and fetches again, a prompt text told meanwhile leaves the hold, and the retold role ends it and is not told again', async ($, on) => {
        const d = await started($, on)
        BOUND(d)
        d.world.role = ROLE()
        d.world.roleOverride = { status: 503, body: { error: 'dashboard_unreachable' } }
        const first = await firstPrompt($, 'startup')
        expect(first.context.join('\n')).toMatch(/are loading/)
        expect(roleTold(first.context)).toEqual([])
        // a prompt text delivered meanwhile does not end the hold, and no second fetch starts from the prompt
        const reads = d.world.roleReads.length
        const between = (await $.prompt.submit({ text: 'again' })).context as string[] | undefined
        expect(roleTold(between ?? [])).toEqual([])
        expect(d.world.roleReads).toHaveLength(reads)
        await d.clock.advance(RETRY_WINDOW_MS + 10_000)
        const refused = (await tool($)).deny as string
        expect(refused).toContain('could not deliver this agent its instructions')
        d.world.roleOverride = undefined
        const arrived = (await tool($)).deny as string
        expect(arrived).toMatch(/have arrived/)
        expect(arrived).toContain('\n\nYour role: work the card.')
        expect((await tool($)).deny).toBeUndefined()
        const next = ((await $.prompt.submit({ text: 'next' })).context ?? []) as string[]
        expect(roleTold(next)).toEqual([])
        await d.clock.settle()
        expect(reports(d).filter(r => r.kind === 'hold').map(r => r.event)).toEqual(['session.bind'])
      })

      test('a role route that answers 426 holds the context with the plugin version to update to', async ($, on) => {
        const d = await started($, on)
        BOUND(d)
        d.world.role = ROLE()
        d.world.roleOverride = { status: 426, body: { plugin: { need: '9.9.9' } } }
        await firstPrompt($, 'startup')
        await d.clock.advance(RETRY_WINDOW_MS + 10_000)
        expect((await tool($)).deny as string).toContain('9.9.9')
      })

      test('the role is told again after a compaction, and not on the next prompt for the same key', async ($, on) => {
        const d = await started($, on)
        BOUND(d)
        d.world.role = ROLE()
        d.world.bundle.events['session.after_compaction'] = bundleEvent('session.after_compaction', ['Compacted.'], { id: 330 })
        await firstPrompt($, 'startup')
        expect(d.world.roleReads).toHaveLength(1)
        const compacted = await firstPrompt($, 'compact')
        expect(roleTold(compacted.context)).toEqual(['Your role: work the card.'])
        expect(d.world.roleReads).toHaveLength(2)
        const next = ((await $.prompt.submit({ text: 'next' })).context ?? []) as string[]
        expect(roleTold(next)).toEqual([])
        expect(d.world.roleReads).toHaveLength(2)
      })

      test('a change of plan fetches the role again and tells it once', async ($, on) => {
        const d = await started($, on)
        BOUND(d)
        d.world.role = ROLE()
        await firstPrompt($, 'startup')
        expect(d.world.roleReads).toHaveLength(1)
        d.world.planId = 24
        d.world.role = ROLE('Your role: plan 24.')
        await startSession($, d, surface)
        await d.clock.settle()
        const changed = (((await $.prompt.submit({ text: 'changed' })).context ?? []) as string[])
        expect(roleTold(changed)).toEqual(['Your role: plan 24.'])
        expect(d.world.roleReads).toHaveLength(2)
        const next = ((await $.prompt.submit({ text: 'next' })).context ?? []) as string[]
        expect(roleTold(next)).toEqual([])
        expect(d.world.roleReads).toHaveLength(2)
      })

      test('a clear tells the role again, and the next prompt for the same key does not', async ($, on) => {
        const d = await started($, on)
        BOUND(d)
        d.world.role = ROLE()
        d.world.bundle.events['session.after_clear'] = bundleEvent('session.after_clear', ['Cleared.'], { id: 340 })
        await firstPrompt($, 'startup')
        const cleared = await firstPrompt($, 'clear')
        expect(roleTold(cleared.context)).toEqual(['Your role: work the card.'])
        expect(d.world.roleReads).toHaveLength(2)
        const next = ((await $.prompt.submit({ text: 'next' })).context ?? []) as string[]
        expect(roleTold(next)).toEqual([])
        expect(d.world.roleReads).toHaveLength(2)
      })

      test('a key that changed, failed and came back before the next tool call: the retell finds the key told and ends the hold', async ($, on) => {
        const d = await started($, on)
        BOUND(d)
        d.world.role = ROLE()
        await firstPrompt($, 'startup')
        d.world.planId = 24
        d.world.roleOverride = { status: 503, body: { error: 'dashboard_unreachable' } }
        await startSession($, d, surface)
        await d.clock.settle()
        await $.prompt.submit({ text: 'changed' })
        expect(holdsNow(d)).toEqual(['main'])
        d.world.planId = 23
        d.world.roleOverride = undefined
        await startSession($, d, surface)
        await d.clock.settle()
        await d.clock.advance(RETRY_WINDOW_MS + 10_000)
        const reads = d.world.roleReads.length
        expect((await tool($)).deny).toBeUndefined()
        expect(d.world.roleReads).toHaveLength(reads)
        expect(holdsNow(d)).toEqual([])
      })

      test('a retell racing a prompt fetches and tells the role once', async ($, on) => {
        const d = await started($, on)
        BOUND(d)
        d.world.role = ROLE()
        d.world.roleOverride = { status: 503, body: { error: 'dashboard_unreachable' } }
        await firstPrompt($, 'startup')
        d.world.roleOverride = undefined
        await d.clock.advance(RETRY_WINDOW_MS + 10_000)
        const reads = d.world.roleReads.length
        const [refused, prompted] = await Promise.all([tool($), $.prompt.submit({ text: 'together' })])
        const told = [(refused.deny ?? '') as string, ...((prompted.context ?? []) as string[])]
        expect(told.filter(c => c.includes('Your role: work the card.'))).toHaveLength(1)
        expect(d.world.roleReads).toHaveLength(reads + 1)
      })

      test('a role fetch that fails names the role fetch in the hold line, never the bundle fetch', async ($, on) => {
        const d = await started($, on)
        BOUND(d)
        d.world.role = ROLE()
        d.world.roleOverride = { status: 500, body: { error: 'role boom' } }
        await firstPrompt($, 'startup')
        await d.clock.advance(RETRY_WINDOW_MS + 10_000)
        const refused = (await tool($)).deny as string
        expect(refused).toContain('the role fetch answered 500')
        expect(refused).not.toContain('the bundle fetch')
      })

      test('two hooks landing together fetch and tell the role once', async ($, on) => {
        const d = await started($, on)
        BOUND(d)
        d.world.role = ROLE()
        const [a, b] = await Promise.all([$.prompt.submit({ text: 'one' }), $.prompt.submit({ text: 'two' })])
        const told = [...((a.context ?? []) as string[]), ...((b.context ?? []) as string[])]
        expect(roleTold(told)).toEqual(['Your role: work the card.'])
        expect(d.world.roleReads).toHaveLength(1)
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

    test('one hook waits for the bundle fetch once: a prompt over a hung fetch takes one wait, not one per event it tells, and a context never borrows another context\'s hold', async ($, on) => {
      const d = await started($, on)
      await firstPrompt($, 'startup')
      // the fetch hangs from now on: the minute check hangs with it, so the bundle is stale after 90 s
      d.world.contextHangs = true
      await d.clock.advance(2 * MIN)
      // the bundle is stale and the fetch hangs: the prompt tells the role, the prompt text and more, yet waits for the fetch once
      const pending = $.prompt.submit({ text: 'next' })
      await d.clock.settle()
      await d.clock.advance(4_000)
      expect(((await pending).context ?? []).join('\n')).toMatch(/loading/)
      // a sub-agent has no hold of its own: its call waits its own first wait, and its refusal names the fetch not answering, not the main context's reason
      const sub = tool($, 'a1')
      await d.clock.settle()
      await d.clock.advance(4_000)
      expect((await sub).deny).toMatch(/had not answered within the hook deadline/)
      d.world.contextHangs = false
      d.release()
      await d.clock.settle()
    })

    // CP-146: a hook has ONE deadline. The bundle wait and a pending start's own reads (the plan read, then the event text) share it, so a dashboard that answers nothing holds a prompt for 8 s, never 16
    test('one deadline per hook: a prompt carrying a pending start over a dashboard whose bundle read and plan read both hang settles at the 8 s deadline, and the start is owed', async ($, on) => {
      const d = await started($, on)
      d.world.contextDelayMs = 60 * MIN
      const pending = firstPrompt($, 'startup')
      let settled = false
      void pending.then(() => (settled = true))
      await d.clock.advance(CONTEXT_DEADLINE_MS - 1_000)
      await d.clock.settle()
      expect(settled).toBe(false)
      // the bundle wait ends at 8 s with the whole of the budget used: the start's plan read has no time of its own to add
      await d.clock.advance(1_000 + 500)
      await d.clock.settle()
      expect(settled).toBe(true)
      const r = await pending
      expect((r.context ?? []).join('\n')).toMatch(/loading/)
      expect((r.context ?? []).join('\n')).not.toContain(EVENT_TEXT('session_start'))
      // the start is owed, not dropped: once the dashboard answers, the next prompt tells it
      d.world.contextDelayMs = 0
      await d.clock.advance(60 * MIN)
      expect(((await $.prompt.submit({ text: 'again' })).context ?? []).join('\n')).toContain(EVENT_TEXT('session_start'))
    })

    const holdsWritten = (d: any) => d.stateWrites.filter((w: any) => w.key === 'behavior' && Object.keys(w.value?.holds ?? {}).length > 0)

    // a bundle read answers `signed-out` for a key that lapsed after the session view was drawn: the session is no outage, so no call of the hook holds it
    test('a hook whose one wait found the session signed out holds nothing at its later calls', async ($, on) => {
      const d = await started($, on)
      d.world.bundle.events['tool.after'] = bundleEvent('tool.after', ['After a tool.'], { id: 310 })
      await firstPrompt($, 'startup')
      d.world.bundle.version = NEXT_BUNDLE_VERSION
      d.world.files[BUNDLE_FILE_PATH(d.world.sessionId)] = bundleFileText(d.world.sessionId, NEXT_BUNDLE_VERSION)
      d.world.signedOut = 'lapsed'
      // the relay streams, so the session file makes the held bundle stale: the call fetches (one wait, answered signed-out), and its later events (the tool's own) run in the same hook
      expect(['streaming', 'held']).toContain(relayPhase(d))
      const reads = d.contextReads.length
      expect((await tool($)).deny).toBeUndefined()
      await d.clock.settle()
      expect(d.contextReads.length).toBeGreaterThan(reads)
      expect(holdsWritten(d)).toEqual([])
      expect(reports(d).filter(r => r.kind === 'hold')).toEqual([])
    })

    // the fetch answered, yet the relay's file names a version still newer than the answer: the hook goes on with what its one wait got, it does not hold the context for a timeout that never happened
    test('a hook whose one wait found a bundle goes on with it when the relay names a newer version than the answer', async ($, on) => {
      const d = await started($, on)
      d.world.bundle.events['tool.after'] = bundleEvent('tool.after', ['After a tool.'], { id: 310 })
      await firstPrompt($, 'startup')
      d.world.files[BUNDLE_FILE_PATH(d.world.sessionId)] = bundleFileText(d.world.sessionId, NEWER_THAN_ANSWER)
      expect(['streaming', 'held']).toContain(relayPhase(d))
      const reads = d.world.bundleReads.length
      expect((await tool($)).deny).toBeUndefined()
      await d.clock.settle()
      // the file makes the held bundle stale, so the call fetched; the answer is older than the file, and the hook still goes on with it
      expect(d.world.bundleReads.length).toBeGreaterThan(reads)
      expect(holdsWritten(d)).toEqual([])
      expect(deliveredReports(d, 'tool.after')).toHaveLength(1)
    })

    const holdKeys = (d: any) => Object.keys((d.stateWrites.filter((w: any) => w.key === 'behavior').at(-1)?.value as any)?.holds ?? {})

    // a hold placed while the answer was unknown (the dashboard was down at the start) is let go when a later fetch finds the session signed out: nothing was ever down, so nothing is reported
    test('a signed-out answer releases a hold placed while the answer was unknown, with no hold report', async ($, on) => {
      const d = await started($, on)
      d.world.bundle.override = { status: 503, body: { error: 'dashboard_unreachable' } }
      await firstPrompt($, 'startup')
      expect(holdKeys(d)).toEqual(['main'])
      d.world.bundle.override = undefined
      d.world.signedOut = 'lapsed'
      const reads = d.contextReads.length
      expect((await tool($)).deny).toBeUndefined()
      await d.clock.settle()
      expect(d.contextReads.length).toBeGreaterThan(reads)
      expect(holdKeys(d)).toEqual([])
      expect(reports(d).filter(r => r.kind === 'hold')).toEqual([])
    })

    // the start is owed in one place: the deadline fallback. A plan read that answers after it, when the start was owed and told long since, owes and holds nothing
    test('a start owed at the deadline and told on the next prompt is not owed again when its plan read answers later', async ($, on) => {
      const d = await started($, on)
      d.holdApi(20_000)
      const pending = firstPrompt($, 'startup')
      await d.clock.advance(CONTEXT_DEADLINE_MS + 500)
      await d.clock.settle()
      expect(((await pending).context ?? []).join('\n')).toMatch(/loading/)
      expect(((await $.prompt.submit({ text: 'again' })).context ?? []).join('\n')).toContain(EVENT_TEXT('session_start'))
      // the held plan read answers now, after the start was told
      await d.clock.advance(30_000)
      await d.clock.settle()
      expect((await tool($)).deny).toBeUndefined()
      expect(((await $.prompt.submit({ text: 'more' })).context ?? []).join('\n')).not.toContain(EVENT_TEXT('session_start'))
      await d.clock.settle()
      expect(deliveredReports(d, 'session.start')).toHaveLength(1)
    })

    // a signed-in session on no plan whose view has not loaded when its first prompt comes: no connection record, no loaded view, so the deadline fallback owes nothing for it. The start is owed by whoever finds it
    // signed in (the plan read's answer), once, and told once whichever order the deadline, the plan read and the slot reads come in
    async function startedViewHeld($: any, on: any) {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.SubagentStart', () => ({}) as any)
      on('classic.Stop', () => ({}) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      const d = dashboard(on, { connected: false })
      // the view's own load (the same plan read) is held for 20 s: the view is not loaded at the first prompt
      d.holdApi(20_000)
      await startSession($, d, surface)
      return d
    }

    test('no connection record, view not loaded, plan read answering signed in after the deadline: the start is owed by that answer and told once', async ($, on) => {
      const d = await startedViewHeld($, on)
      const pending = firstPrompt($, 'startup')
      await d.clock.advance(CONTEXT_DEADLINE_MS + 500)
      await d.clock.settle()
      expect(((await pending).context ?? []).join('\n')).not.toContain(EVENT_TEXT('session_start'))
      // the held reads answer: the view loads signed in, and the start's plan read says signed in
      await d.clock.advance(30_000)
      await d.clock.settle()
      expect(((await $.prompt.submit({ text: 'again' })).context ?? []).join('\n')).toContain(EVENT_TEXT('session_start'))
      expect(((await $.prompt.submit({ text: 'more' })).context ?? []).join('\n')).not.toContain(EVENT_TEXT('session_start'))
      await d.clock.settle()
      expect(deliveredReports(d, 'session.start')).toHaveLength(1)
    })

    test('no connection record, view not loaded, plan read in time and the briefing slot reads past the deadline: the start is owed once and told once', async ($, on) => {
      const d = await startedViewHeld($, on)
      // only the view's load is held; the start's own reads answer at once, but its owed-comments slot read does not
      d.holdApi(0)
      d.world.bundle.events['session.after_compaction'] = bundleEvent('session.after_compaction', ['Compacted: {{slot:owed_list}}'], { id: 330, slots: ['owed_list'] })
      d.world.reportReplies['GET /api/plan-sessions/me/owed-comments'] = { delayMs: 60 * MIN }
      const pending = firstPrompt($, 'compact')
      await d.clock.advance(CONTEXT_DEADLINE_MS + 500)
      await d.clock.settle()
      expect(((await pending).context ?? []).join('\n')).not.toContain('Compacted:')
      delete d.world.reportReplies['GET /api/plan-sessions/me/owed-comments']
      await d.clock.advance(30_000)
      await d.clock.settle()
      expect(((await $.prompt.submit({ text: 'again' })).context ?? []).join('\n')).toContain('Compacted:')
      expect(((await $.prompt.submit({ text: 'more' })).context ?? []).join('\n')).not.toContain('Compacted:')
      await d.clock.settle()
      expect(deliveredReports(d, 'session.after_compaction')).toHaveLength(1)
    })

    // one release for every hold, by what the hold had reported: a hold whose open report went out (an outdated plugin) is closed with its end when a signed-out answer lets it go, or the alert 50 Arms opened for it never closes
    test('a signed-out answer ends a hold whose open report was sent with an end report', async ($, on) => {
      const d = await started($, on)
      d.world.bundle.minPlugin = '9.0.0'
      await $.prompt.submit({ text: 'hello' })
      await d.clock.advance(RETRY_WINDOW_MS + 1_000)
      expect((await tool($)).deny).toMatch(/9\.0\.0/)
      await d.clock.settle()
      expect(reports(d).filter(r => r.kind === 'hold')).toHaveLength(1)
      d.world.bundle.minPlugin = '0.17.0'
      d.world.signedOut = 'lapsed'
      expect((await tool($)).deny).toBeUndefined()
      await d.clock.settle()
      const holdReports = reports(d).filter(r => r.kind === 'hold')
      expect(holdReports.map(r => r.ended_at !== undefined)).toEqual([false, true])
      expect(holdReports[1].started_at).toBe(holdReports[0].started_at)
      expect(holdKeys(d)).toEqual([])
    })

    // a real outage that lasted past the hold line is reported with its end like an ordinary answer would, though the answer that ends it is signed out
    test('a signed-out answer ends a hold from an outage past the hold line with its one report', async ($, on) => {
      const d = await started($, on)
      d.world.bundle.override = { status: 503, body: { error: 'dashboard_unreachable' } }
      await firstPrompt($, 'startup')
      await d.clock.advance(RETRY_WINDOW_MS + 1_000)
      expect((await tool($)).deny).toMatch(/CRITICAL/)
      d.world.bundle.override = undefined
      d.world.signedOut = 'lapsed'
      expect((await tool($)).deny).toBeUndefined()
      await d.clock.settle()
      const holdReports = reports(d).filter(r => r.kind === 'hold')
      expect(holdReports).toHaveLength(1)
      expect(holdReports[0].ended_at).toBeDefined()
      expect(holdKeys(d)).toEqual([])
    })

    // DX-8223: the process ends while a hold's open report is out: its alert episode in 50 Arms closes only on the end report, and nothing runs after the session's end hook, so the end report is sent inside it
    describe('a session that ends while it holds', () => {
      const PROCESS_END = { reason: 'logout' } as const
      const endSession = ($: any, d: any, e: { reason: string } = PROCESS_END) => $.session.end({ ...e, sessionId: d.world.sessionId } as any)
      const heldOutdated = async ($: any, d: any) => {
        d.world.bundle.minPlugin = '9.0.0'
        await $.prompt.submit({ text: 'hello' })
        await d.clock.advance(RETRY_WINDOW_MS + 1_000)
        expect((await tool($)).deny).toMatch(/9\.0\.0/)
        await d.clock.settle()
      }

      test('a hold already reported open sends its end report before the end hook returns, once', async ($, on) => {
        on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
        const d = await started($, on)
        await heldOutdated($, d)
        const open = reports(d).filter(r => r.kind === 'hold')
        expect(open).toHaveLength(1)
        expect(open[0].ended_at).toBeUndefined()
        await endSession($, d)
        // no settle: the process is gone once the hook returns
        const sent = reports(d).filter(r => r.kind === 'hold')
        expect(sent.map(r => r.ended_at !== undefined)).toEqual([false, true])
        expect(sent[1]).toMatchObject({ reason: 'plugin_outdated', agent_id: null, started_at: open[0].started_at })
        await d.clock.advance(10 * MIN)
        await d.clock.settle()
        expect(reports(d).filter(r => r.kind === 'hold')).toHaveLength(2)
      })

      test('a hold inside its loading window reports nothing', async ($, on) => {
        on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
        const d = await started($, on)
        d.world.bundle.override = { status: 503, body: { error: 'dashboard_unreachable' } }
        await firstPrompt($, 'startup')
        await d.clock.advance(30_000)
        await endSession($, d)
        await d.clock.settle()
        expect(reports(d).filter(r => r.kind === 'hold')).toEqual([])
      })

      // an outage hold past the hold line is reported once it ends (`reportStepOf`), never open: the session's end is no end of that outage
      test('a hold past the hold line that was never reported open reports nothing', async ($, on) => {
        on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
        const d = await started($, on)
        d.world.bundle.override = { status: 503, body: { error: 'dashboard_unreachable' } }
        await firstPrompt($, 'startup')
        await d.clock.advance(RETRY_WINDOW_MS + 1_000)
        expect((await tool($)).deny).toMatch(/CRITICAL/)
        await endSession($, d)
        await d.clock.settle()
        expect(reports(d).filter(r => r.kind === 'hold')).toEqual([])
      })

      test('a /clear carries the open hold across and reports nothing', async ($, on) => {
        on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
        const d = await started($, on)
        await heldOutdated($, d)
        await endSession($, d, { reason: 'clear' })
        await d.clock.settle()
        expect(reports(d).filter(r => r.kind === 'hold')).toHaveLength(1)
      })
    })

    // the briefing slots of an after-compaction start read the dashboard: a read past the hook's deadline gives the start up before anything is counted told, so no delivery is reported that nobody saw
    test('a start whose briefing slots read past the deadline is owed, with nothing told or reported for it, and the next prompt tells it once', async ($, on) => {
      const d = await started($, on)
      d.world.reportReplies['GET /api/plan-sessions/me/owed-comments'] = { delayMs: 60 * MIN }
      const pending = firstPrompt($, 'compact')
      await d.clock.advance(CONTEXT_DEADLINE_MS + 1_000)
      await d.clock.settle()
      const first = await pending
      expect(first.context.join('\n')).toMatch(/loading/)
      expect(first.context.join('\n')).not.toContain(EVENT_TEXT('after_compaction'))
      await d.clock.settle()
      expect(deliveredReports(d, 'session.after_compaction')).toEqual([])
      delete d.world.reportReplies['GET /api/plan-sessions/me/owed-comments']
      await d.clock.advance(60 * MIN)
      expect(((await $.prompt.submit({ text: 'again' })).context ?? []).join('\n')).toContain(EVENT_TEXT('after_compaction'))
      await d.clock.settle()
      expect(deliveredReports(d, 'session.after_compaction')).toHaveLength(1)
    })

    // DX-8226, DX-8225: the bundle the plugin published 0.17.167 on was 72,000 to 83,000 characters, which Claude Code refuses as a tool result. These cases serve a bundle of that size through the kit's stand-in dashboard with the host-limit stand-in on
    // (`hostLimited` refuses any tool result over its limit, as Claude Code does) and the stand-in MCP answering `reply_to_file` with the file form.
    describe('a bundle of the hosted size and the requested endpoints', () => {
      const HOSTED_CHARS = 83_059
      const filler = (n: number) => `${String(n)} `.repeat(Math.ceil(10_000 / (String(n).length + 1))).slice(0, 10_000)
      const hostedSize = (d: any) => {
        // nine more events, each of ten thousand characters that are its own: the bundle lists each once, so it is the sum of what its events say
        for (let n = 1; n <= 9; n++) d.world.bundle.events[`filler.${n}`] = bundleEvent(`filler.${n}`, [filler(n)], { id: 5000 + n * 10 })
      }
      const fileRead = (d: any): string => {
        const path = d.world.fsReads.find((p: string) => p.includes('/tmp/danx-api/'))
        expect(path).toBeDefined()
        return d.world.files[path]
      }

      test('a session start and a sub-agent start each deliver their bundle texts from the file, with no loading or hold line, and report their deliveries', async ($, on) => {
        const d = await started($, on)
        hostedSize(d)
        const start = await firstPrompt($, 'startup')
        expect(start.startLines).toEqual([EVENT_TEXT('session_start')])
        expect(fileRead(d).length).toBeGreaterThanOrEqual(HOSTED_CHARS)
        const sub = await $.classic.SubagentStart(SUB)
        expect(sub.additionalContext).toEqual([EVENT_TEXT('sub_agent_start')])
        await d.clock.settle()
        expect(deliveredReports(d, 'session.start')).toHaveLength(1)
        expect(deliveredReports(d, 'subagent.start')).toHaveLength(1)
        expect(reports(d).filter(r => r.kind === 'hold')).toEqual([])
        // the bundle came only as a file: the host would have refused it as a tool result
        expect(d.world.repliedAsFile).toContain('/api/behavior-events/bundle')
        expect(start.context.join('\n')).not.toMatch(/exceeds maximum allowed tokens/)
      })

      test('the bundle is asked for as a file, and the file is checked against the sha256 the answer names: a bundle of the hosted size is read whole', async ($, on) => {
        const d = await started($, on)
        hostedSize(d)
        await firstPrompt($, 'startup')
        const body = fileRead(d)
        expect(sha256Hex(body)).toMatch(/^[0-9a-f]{64}$/)
        expect(JSON.parse(body).sections).toBeDefined()
        expect(Object.keys(JSON.parse(body).sections).length).toBeGreaterThan(9)
      })

      test('an answer to a reply_to_file call that carries its body inline is a failed fetch: the session is held, never told from it', async ($, on) => {
        const d = await started($, on)
        d.world.inlineReplies = true
        const first = await firstPrompt($, 'startup')
        expect(first.context.join('\n')).toMatch(/loading/)
        expect(first.context.join('\n')).not.toContain(EVENT_TEXT('session_start'))
        expect(deliveredReports(d, 'session.start')).toEqual([])
        d.world.inlineReplies = false
        await d.clock.advance(60 * MIN)
        expect(((await $.prompt.submit({ text: 'again' })).context ?? []).join('\n')).toContain(EVENT_TEXT('session_start'))
      })

      test('an answer whose file differs from the sha256 it names is a failed fetch: the session is held, never told from it', async ($, on) => {
        const d = await started($, on)
        d.world.replySha256 = 'f'.repeat(64)
        const first = await firstPrompt($, 'startup')
        expect(first.context.join('\n')).toMatch(/loading/)
        expect(first.context.join('\n')).not.toContain(EVENT_TEXT('session_start'))
        expect(deliveredReports(d, 'session.start')).toEqual([])
        d.world.replySha256 = undefined
        await d.clock.advance(60 * MIN)
        expect(((await $.prompt.submit({ text: 'again' })).context ?? []).join('\n')).toContain(EVENT_TEXT('session_start'))
      })

      const ENDPOINTS = (chars: number) => {
        const text = `Endpoints you read with 50arms_api_spec before this compaction:\n\n${'GET /api/issues/:id how-to. '.repeat(Math.ceil(chars / 28))}`.slice(0, chars)
        return { key: 'requested_endpoints', mechanism: 'plugin.context', frequency: 'every', text, chars: text.length, rules: [{ ref: 'BPR-77', content_hash: 'd'.repeat(64) }] }
      }
      const COMPACTED = (d: any) => (d.world.bundle.events['session.after_compaction'] = bundleEvent('session.after_compaction', ['Compacted.'], { id: 330, cap: 10_000 }))

      test('after a compaction the requested endpoints are fetched as a file and delivered through the temporary file the agent is told to read, and reported with no attachment id', async ($, on) => {
        const d = await started($, on)
        COMPACTED(d)
        d.world.requestedEndpoints = ENDPOINTS(22_694)
        const compacted = await firstPrompt($, 'compact')
        const told = compacted.context.join('\n')
        const file = /read (\/home\/u\/\.config\/danxbot\/behavior-text\/\S+\.txt)\./.exec(told)?.[1]
        expect(file).toBeDefined()
        // one file holds everything the hook put through the mechanism: the event's own text, then the endpoints
        expect(d.world.files[file as string]).toBe(`Compacted.\n\n${ENDPOINTS(22_694).text}`)
        expect(told).toMatch(/It is|characters/)
        expect(told).not.toContain('GET /api/issues/:id how-to.')
        expect(d.world.requestedEndpointReads).toEqual([{ plugin_version: PLUGIN_VERSION, reply_to_file: true }])
        expect(d.world.repliedAsFile).toContain('/api/behavior-events/requested-endpoints')
        await d.clock.settle()
        const delivered = deliveredReports(d, 'session.after_compaction')
        expect(delivered.map(r => r.attachment_ids)).toEqual([[330], []])
        expect(delivered[1]).toMatchObject({ mechanism: 'plugin.context', rules: [{ ref: 'BPR-77', content_hash: 'd'.repeat(64) }] })
      })

      test('a compaction of a session that read no spec delivers the event\'s text and nothing more, and no other event asks for the requested endpoints', async ($, on) => {
        const d = await started($, on)
        COMPACTED(d)
        await firstPrompt($, 'startup')
        expect(d.world.requestedEndpointReads).toEqual([])
        const compacted = await firstPrompt($, 'compact')
        expect(compacted.startLines).toEqual(['Compacted.'])
        expect(d.world.requestedEndpointReads).toHaveLength(1)
        await d.clock.settle()
        expect(deliveredReports(d, 'session.after_compaction')).toHaveLength(1)
      })


      test('a tool text no start owes whose file cannot be written is told as the hold line, kept on the hold and told again at the next tool call, and the hold is reported once when it is delivered', async ($, on) => {
        const d = await started($, on)
        d.world.bundle.events['tool.after'] = bundleEvent('tool.after', ['y'.repeat(12_000)], { id: 310, cap: 10_000 })
        await firstPrompt($, 'startup')
        d.world.carrierWriteFails = true
        // the call that met the failure shows the hold line with its result, never nothing
        const first = (await tool($)) as any
        expect((first.context ?? []).join('\n')).toMatch(/are loading/)
        expect(holdsNow(d)).toEqual(['main'])
        // past the window the next call is refused with the hold line, the text still owed to the agent
        await d.clock.advance(RETRY_WINDOW_MS + 10_000)
        const refused = (await tool($)).deny as string
        expect(refused).not.toMatch(/are loading/)
        expect(refused).toContain('could not be saved to a file')
        expect(reports(d).filter(r => r.kind === 'hold')).toEqual([])
        d.world.carrierWriteFails = false
        const arrived = (await tool($)).deny as string
        expect(arrived).toMatch(/have arrived/)
        expect(arrived).toMatch(/It is \d+ characters: read \/home\/u\/\.config\/danxbot\/behavior-text\/\S+\.txt/)
        await d.clock.settle()
        const holdReports = reports(d).filter(r => r.kind === 'hold')
        expect(holdReports).toHaveLength(1)
        expect(holdReports[0]).toMatchObject({ reason: 'fetch_failed', event: 'tool.after', agent_id: null })
        expect(typeof holdReports[0].ended_at).toBe('string')
        expect(holdsNow(d)).toEqual([])
        expect((await tool($)).deny).toBeUndefined()
      })

      test('when a later retell fails, the texts this call already told come with the hold line: nothing counted delivered is dropped', async ($, on) => {
        const d = await started($, on)
        d.world.bundle.events['tool.before'] = bundleEvent('tool.before', ['b'.repeat(12_000)], { id: 311, cap: 10_000 })
        d.world.bundle.events['tool.after'] = bundleEvent('tool.after', ['a'.repeat(12_000)], { id: 312, cap: 10_000 })
        await firstPrompt($, 'startup')
        d.world.carrierWriteFails = true
        await tool($)
        // both events failed and are kept; now only the file of tool.after cannot be written
        d.world.carrierWriteFails = false
        d.world.carrierWriteFailsFor = '-tool.after-'
        const refused = (await tool($)).deny as string
        // tool.before was told on this call (a pointer to its file, reported delivered), and tool.after failed after it: one answer carries both
        expect(refused).toMatch(/have arrived/)
        expect(refused).toMatch(/read \/home\/u\/\.config\/danxbot\/behavior-text\/\S+-tool\.before-\S+\.txt/)
        expect(refused).toMatch(/are loading/)
        await d.clock.settle()
        expect(deliveredReports(d, 'tool.before')).toHaveLength(1)
        // the one that failed is still owed, and the one told is not told again
        d.world.carrierWriteFailsFor = null
        const rest = (await tool($)).deny as string
        expect(rest).toMatch(/read \/home\/u\/\.config\/danxbot\/behavior-text\/\S+-tool\.after-\S+\.txt/)
        expect(rest).not.toMatch(/tool\.before/)
        expect((await tool($)).deny).toBeUndefined()
      })

      test('requested endpoints that keep failing while the bundle is current are held past the loading line, not dropped by each bundle answer: the hold line comes, and the hold is reported once, with its end, when the text is delivered', async ($, on) => {
        const d = await started($, on)
        COMPACTED(d)
        d.world.requestedEndpoints = ENDPOINTS(1_000)
        d.world.requestedEndpointsOverride = { status: 503, body: { error: 'dashboard_unreachable' } }
        const first = await firstPrompt($, 'compact')
        expect(first.context.join('\n')).toMatch(/are loading/)
        // the plugin keeps asking for the bundle through the window; each unchanged answer must leave the hold in place
        const reads = d.world.bundleReads.length
        await d.clock.advance(RETRY_WINDOW_MS + 10_000)
        expect(d.world.bundleReads.length).toBeGreaterThan(reads)
        const refused = (await tool($)).deny as string
        expect(refused).not.toMatch(/are loading/)
        expect(refused).toContain('requested endpoints could not be fetched')
        await d.clock.settle()
        expect(reports(d).filter(r => r.kind === 'hold')).toEqual([])
        d.world.requestedEndpointsOverride = undefined
        expect(((await $.prompt.submit({ text: 'again' })).context ?? []).join('\n')).toContain('Compacted.')
        await d.clock.settle()
        const holdReports = reports(d).filter(r => r.kind === 'hold')
        expect(holdReports).toHaveLength(1)
        expect(holdReports[0]).toMatchObject({ reason: 'fetch_failed', event: 'session.after_compaction', agent_id: null })
        expect(typeof holdReports[0].ended_at).toBe('string')
        expect((await tool($)).deny).toBeUndefined()
      })

      test('requested endpoints that cannot be fetched hold the compacted context with nothing told or reported, and the next prompt tells the compaction once the fetch works', async ($, on) => {
        const d = await started($, on)
        COMPACTED(d)
        d.world.requestedEndpoints = ENDPOINTS(1_000)
        d.world.requestedEndpointsOverride = { status: 503, body: { error: 'dashboard_unreachable' } }
        const first = await firstPrompt($, 'compact')
        expect(first.context.join('\n')).toMatch(/loading/)
        expect(first.context.join('\n')).not.toContain('Compacted.')
        await d.clock.settle()
        expect(deliveredReports(d, 'session.after_compaction')).toEqual([])
        d.world.requestedEndpointsOverride = undefined
        await d.clock.advance(60 * MIN)
        const told = ((await $.prompt.submit({ text: 'again' })).context ?? []).join('\n')
        expect(told).toContain('Compacted.')
        expect(told).toContain('GET /api/issues/:id how-to.')
        await d.clock.settle()
        expect(deliveredReports(d, 'session.after_compaction')).toHaveLength(2)
      })

      test('a text over its mechanism\'s cap whose file cannot be written was not delivered: the context is held, never told a warning in its place, and its once-only text is told once the file can be written', async ($, on) => {
        const d = await started($, on)
        d.world.bundle.events['session.start'] = bundleEvent('session.start', ['x'.repeat(12_000)], { id: 100, frequency: 'once_per_session', cap: 10_000 })
        d.world.carrierWriteFails = true
        const first = await firstPrompt($, 'startup')
        expect(first.context.join('\n')).toMatch(/loading/)
        // the hold line states why it holds; the text itself is not told, whole or cut, and no warning line stands in for it
        expect(first.context.join('\n')).not.toContain('x'.repeat(100))
        expect(first.context.join('\n')).not.toContain('Tell the person')
        await d.clock.settle()
        expect(deliveredReports(d, 'session.start')).toEqual([])
        d.world.carrierWriteFails = false
        await d.clock.advance(60 * MIN)
        const told = ((await $.prompt.submit({ text: 'again' })).context ?? []).join('\n')
        expect(told).toMatch(/It is \d+ characters: read \/home\/u\/\.config\/danxbot\/behavior-text\/\S+\.txt/)
        await d.clock.settle()
        expect(deliveredReports(d, 'session.start')).toHaveLength(1)
      })
    })

    describe('a held main conversation at a stop', () => {
      const STOP = { stop_hook_active: false, background_tasks: [] } as any
      const READY_CARD = { id: 'DX-1', type: 'Story', title: 'A card', assigned_agent: null, dispatch: null, blocked: null, open_problem_count: 0, waiting_on: false, conflict_on_active_count: 0, review_runnable: false, next_pre_gate: null }

      test('is never also told by a pick-up-cards block, and a stop never uses up the start texts it is owed: the next prompt tells them', async ($, on) => {
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

      // a slot reads only the sources it names: a stop text with `agent_list` needs the engine's agent list, never the owed-comments read or `git status`
      test('a stop text naming agent_list reads neither the owed comments nor git status', async ($, on) => {
        const d = await started($, on)
        d.world.bundle.events['turn.stop'] = bundleEvent('turn.stop', ['Agents running: {{slot:agent_list}}'], { id: 410, mechanism: 'plugin.stop_block', slots: ['agent_list'] })
        await firstPrompt($, 'startup')
        d.world.readyRows[7] = [READY_CARD]
        const reads = d.reports.length
        const runs = d.runCalls.length
        expect((await $.classic.Stop(STOP))?.block).toContain('Agents running:')
        expect(d.reports.slice(reads).filter((r: any) => r.path === '/api/plan-sessions/me/owed-comments')).toEqual([])
        expect(d.runCalls.length).toBe(runs)
      })
    })
  })
}
