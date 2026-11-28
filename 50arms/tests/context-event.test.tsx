import "./run-tests-with-npm-test.generated"
// DX-4234 / DX-5554 / CP-146: the bundle's text for every signed-in session (SessionStart startup / resume / compact, and every sub-agent's start), read from the policy bundle through the session's own dashboard server
// (R-2: `50arms_api`, never the package's CLI), and the silence rules: a session with no usable key is told one invitation to sign in (nothing at its sub-agents, nothing for a revoked key); a signed-in session that
// cannot be given the bundle is held (the loading line, then the hold line) and owed its start. The bundle decides the words: a plan-connected session's after-compaction text carries the briefing, a session on no plan's does not.
import { describe, expect } from 'claude-code/testing'

import { SIGN_IN_INVITATION } from '../hooks/bundle/floor'
import { RETRY_WINDOW_MS } from '../hooks/bundle/hold'
import { CONTEXT_DEADLINE_MS } from '../hooks/context/events'
import { test, BUNDLE_EVENT_KEY, EVENT_TEXT, TOLD, SURFACES, clearedEvent, dashboard, deliveredReports, firstPrompt, startSession } from './plan-kit'

const START = { agent_id: 'a1', agent_type: '50arms:worker-sonnet-high' }
const BUNDLE_PATH = '/api/behavior-events/bundle'
const MIN = 60_000
const BUNDLE_WAIT_MS = 4_000
const tool = async ($: any) => (await $.tool.call({ tool: 'Bash', command: 'ls' } as any)) as any
// dan, 2026-11-28: a held context's calls run; what it is told rides beside the result (a call another hook denied carries it in the denial)
const said = (r: any): string => [...(typeof r?.deny === 'string' ? [r.deny] : []), ...((r?.context ?? []) as string[])].join('\n\n')
const joined = (lines: string[] | undefined) => (lines ?? []).join('\n')

for (const surface of SURFACES) {
  describe(`the event text on ${surface}`, () => {
    async function started($: any, on: any, options: Parameters<typeof dashboard>[1] = {}) {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.SubagentStart', () => ({}) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      const d = dashboard(on, options)
      await startSession($, d, surface)
      d.contextReads.length = 0
      return d
    }

    for (const [source, event] of [['startup', 'session_start'], ['resume', 'session_resume'], ['compact', 'after_compaction']] as const) {
      test(`a connected session's ${source} is told the ${event} text, and the delivery is reported`, async ($, on) => {
        const d = await started($, on)
        const r = await firstPrompt($, source)
        expect(r.startLines).toEqual([TOLD(event)])
        await d.clock.settle()
        expect(deliveredReports(d, BUNDLE_EVENT_KEY[event]!)).toHaveLength(1)
      })
    }

    test('a fork has no event and a clear is told the bundle\'s after-clear text only when it has one', async ($, on) => {
      const d = await started($, on)
      expect((await firstPrompt($, 'fork')).startLines).toBeUndefined()
      // the default bundle carries no text for a clear
      expect((await firstPrompt($, 'clear')).startLines).toBeUndefined()
      d.world.bundle.events['session.after_clear'] = clearedEvent()
      d.world.bundle.version = 'c'.repeat(63) + '3'
      await d.clock.advance(2 * MIN)
      const cleared = await firstPrompt($, 'clear')
      expect(cleared.startLines).toHaveLength(1)
      expect(cleared.startLines![0]).toContain(EVENT_TEXT('after_clear'))
      expect((await firstPrompt($, 'fork')).startLines).toBeUndefined()
    })

    test("a connected session's sub-agent is told the sub_agent_start text", async ($, on) => {
      const d = await started($, on)
      const r = await $.classic.SubagentStart(START)
      await d.clock.settle()
      expect(r.additionalContext).toEqual([EVENT_TEXT('sub_agent_start')])
      expect(deliveredReports(d, 'subagent.start')).toHaveLength(1)
    })

    // DX-5554: the plan-only text is the bundle's to leave out; the plugin tells every signed-in session what its bundle holds
    for (const [label, world] of [
      ['with no session row', {}],
      ['holding a team agent', { agent: { id: 6, name: 'Tendai', avatar_url: null } }],
      ['holding a stand-alone card', { agent: { id: 6, name: 'Tendai', avatar_url: null }, card: { id: 'DX-77', title: 'One-off fix' } }],
    ] as const) {
      test(`a signed-in session on no plan (${label}) is told the event text, at start, resume, compaction and a sub-agent start`, async ($, on) => {
        const d = await started($, on, { connected: false })
        Object.assign(d.world, world)
        for (const [source, event] of [['startup', 'session_start'], ['resume', 'session_resume'], ['compact', 'after_compaction']] as const) {
          const r = await firstPrompt($, source)
          // no compaction briefing: the bundle of a session on no plan has none
          expect(r.startLines).toEqual([EVENT_TEXT(event)])
        }
        const r = await $.classic.SubagentStart(START)
        await d.clock.settle()
        expect(r.additionalContext).toEqual([EVENT_TEXT('sub_agent_start')])
        for (const event of ['session.start', 'session.resume', 'session.after_compaction', 'subagent.start']) expect(deliveredReports(d, event)).toHaveLength(1)
      })
    }

    test('a signed-in session on no plan that replaced one is told its event text, then the restart notice', async ($, on) => {
      const d = await started($, on, { connected: false })
      d.world.restart.json = { notice: 'This session replaced one on PLAN-23; 3 events wait.' }
      const r = await firstPrompt($, 'startup')
      expect(r.startLines).toEqual([`${EVENT_TEXT('session_start')}
This session replaced one on PLAN-23; 3 events wait.`])
      expect(d.restartCalls).toEqual([{}])
    })

    // CP-146: a bundle that cannot be read is no failure line naming the event: the context is held (the loading line for 2 minutes, then the hold line) and its start is owed
    test('a start whose bundle cannot be read holds the context with the loading line, then the hold line, and the owed text is told once a bundle arrives', async ($, on) => {
      const d = await started($, on)
      d.world.bundle.override = { status: 500, body: { error: 'event boom' } }
      const r = await firstPrompt($, 'startup')
      expect(joined(r.context)).toMatch(/loading/)
      expect(joined(r.context)).not.toMatch(/CRITICAL/)
      expect(joined(r.context)).not.toContain(EVENT_TEXT('session_start'))
      // every call runs (dan, 2026-11-28); the loading line was told at the start, so the call is told nothing more
      const during = await tool($)
      expect(during.deny).toBeUndefined()
      expect(said(during)).not.toMatch(/loading/)
      await d.clock.advance(RETRY_WINDOW_MS + 1_000)
      expect(said(await tool($))).toMatch(/CRITICAL/)
      d.world.bundle.override = undefined
      await d.clock.advance(MIN)
      // the next call runs and carries the start it was owed beside its result
      expect(said(await tool($))).toContain(EVENT_TEXT('session_start'))
      expect((await tool($)).deny).toBeUndefined()
    })

    test('a sub-agent start whose bundle cannot be read is told the loading line, never nothing, and is owed its start', async ($, on) => {
      const d = await started($, on, { connected: false })
      d.world.bundle.override = { status: 500, body: { error: 'event boom' } }
      const r = await $.classic.SubagentStart(START)
      await d.clock.settle()
      expect(joined(r.additionalContext)).toMatch(/loading/)
      d.world.bundle.override = undefined
      await d.clock.advance(MIN)
      expect(said(await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as any))).toContain(EVENT_TEXT('sub_agent_start'))
    })

    test('a CONNECTED session (its record is on disk) whose plans read fails is held with its start owed', async ($, on) => {
      const d = await started($, on)
      d.world.sessionReadStatus = 500
      const r = await firstPrompt($, 'startup')
      expect(joined(r.context)).toMatch(/loading/)
      expect(joined(r.context)).not.toContain(EVENT_TEXT('session_start'))
    })

    test('a connected session whose call is rejected (the dashboard times out) is held too, never told a plugin text of its own', async ($, on) => {
      const d = await started($, on, { mcp: 'flaky' })
      const r = await firstPrompt($, 'startup')
      expect(joined(r.context)).toMatch(/loading/)
      expect(joined(r.context)).not.toContain(EVENT_TEXT('session_start'))
    })

    // a session with no usable key cannot ask 50 Arms for anything: its start carries the floor's one invitation, and a sub-agent's start nothing
    for (const signedOut of ['signed-out', 'lapsed'] as const) {
      test(`a ${signedOut} session is told the one sign-in invitation at its start, and its sub-agent nothing`, async ($, on) => {
        const d = await started($, on, { signedOut })
        const r = await firstPrompt($, 'startup')
        expect(r.startLines).toEqual([SIGN_IN_INVITATION])
        expect((await $.classic.SubagentStart(START)).additionalContext).toBeUndefined()
        await d.clock.settle()
        expect(d.contextReads).toEqual([])
      })

      test(`a ${signedOut} session's resume and compaction are quiet: the invitation is for a start`, async ($, on) => {
        const d = await started($, on, { signedOut })
        for (const source of ['resume', 'compact'] as const) expect((await firstPrompt($, source)).startLines).toBeUndefined()
        await d.clock.settle()
        expect(d.contextReads).toEqual([])
      })
    }

    test('a session whose key a person revoked is quiet at its start and at its sub-agent: its own tools tell the model', async ($, on) => {
      const d = await started($, on, { signedOut: 'revoked' })
      expect((await firstPrompt($, 'startup')).startLines).toBeUndefined()
      expect((await $.classic.SubagentStart(START)).additionalContext).toBeUndefined()
      await d.clock.settle()
      expect(d.contextReads).toEqual([])
    })

    for (const gate of ['agent_needed', 'agent_not_held'] as const) {
      test(`a session the agent gate holds (${gate}) is quiet at its start and its sub-agent: the dashboard's own answer tells the model`, async ($, on) => {
        const d = await started($, on)
        d.world.agentGate = gate
        expect((await firstPrompt($, 'resume')).startLines).toBeUndefined()
        const r = await $.classic.SubagentStart(START)
        await d.clock.settle()
        expect(r.additionalContext).toBeUndefined()
      })
    }

    test('a CONNECTED session whose plugin server is not connected at the deadline is held with its start owed, and the poll stops there', async ($, on) => {
      const d = await started($, on, { mcp: 'down' })
      const pending = firstPrompt($, 'startup')
      await d.clock.advance(CONTEXT_DEADLINE_MS)
      const r = await pending
      expect(joined(r.context)).toMatch(/loading/)
      // the poll is not left running in the background: a poll left going would read the tool list every 500 ms (about 60 more reads in 30 s);
      // the few reads the plugin's own load retries make are not it
      const polled = d.toolLists.n
      await d.clock.advance(30_000)
      expect(d.toolLists.n - polled).toBeLessThan(5)
    })

    test('a session that is not on a plan whose plugin server is not connected at the deadline is quiet', async ($, on) => {
      const d = await started($, on, { mcp: 'down', connected: false })
      const pending = firstPrompt($, 'startup')
      await d.clock.advance(CONTEXT_DEADLINE_MS)
      expect((await pending).startLines).toBeUndefined()
    })

    test('a session whose plugin server comes up during the wait is told its text', async ($, on) => {
      const d = await started($, on, { mcp: 'down' })
      const pending = firstPrompt($, 'resume')
      await d.clock.advance(1_000)
      d.setMcp('up')
      await d.clock.advance(30_000)
      const r = await pending
      expect(r.startLines).toEqual([EVENT_TEXT('session_resume')])
    })

    test('ONE deadline: a dashboard that never answers holds the start with the loading line, it does not hold the prompt for good', async ($, on) => {
      const d = await started($, on)
      d.world.contextHangs = true
      const pending = firstPrompt($, 'startup')
      await d.clock.advance(CONTEXT_DEADLINE_MS - 1)
      let settled = false
      void pending.then(() => (settled = true))
      await d.clock.settle()
      expect(settled).toBe(false)
      await d.clock.advance(30_000)
      const r = await pending
      expect(joined(r.context)).toMatch(/loading/)
      expect(joined(r.context)).not.toContain(EVENT_TEXT('session_start'))
      // the start is owed and the context held: the next hook's first call waits for the fetch in flight, once, then runs (the loading line was told at the start)
      const refused = tool($)
      await d.clock.settle()
      await d.clock.advance(BUNDLE_WAIT_MS)
      expect((await refused).deny).toBeUndefined()
      // the hung read ends, so no timer of this test waits on it
      d.world.contextHangs = false
      d.release()
      await d.clock.settle()
    })

    test('a start whose reads outlast the deadline is owed, never dropped: the texts arrive with the next prompt once the bundle answers', async ($, on) => {
      const d = await started($, on)
      d.world.contextHangs = true
      const first = firstPrompt($, 'startup')
      await d.clock.advance(CONTEXT_DEADLINE_MS - 1)
      await d.clock.settle()
      await d.clock.advance(30_000)
      expect(joined((await first).context)).not.toContain(EVENT_TEXT('session_start'))
      d.world.contextHangs = false
      d.release()
      await d.clock.settle()
      await d.clock.advance(MIN)
      expect(joined(((await $.prompt.submit({ text: 'again' })).context ?? []) as string[])).toContain(EVENT_TEXT('session_start'))
    })

    test('ONE deadline over the SUM of the reads: each read is quick, the lookup together is not', async ($, on) => {
      const d = await started($, on)
      d.world.contextDelayMs = 3_000
      const pending = firstPrompt($, 'resume')
      // the plan read answers at 3 s, the bundle read at 6 s: inside the deadline
      await d.clock.advance(6_000)
      expect((await pending).startLines).toEqual([EVENT_TEXT('session_resume')])
    })

    test('a sub-agent start whose bundle never answers is told the loading line at its own deadline', async ($, on) => {
      const d = await started($, on)
      d.world.contextHangs = true
      const pending = $.classic.SubagentStart(START)
      await d.clock.advance(CONTEXT_DEADLINE_MS)
      expect(joined((await pending).additionalContext)).toMatch(/loading/)
      d.world.contextHangs = false
      d.release()
      await d.clock.settle()
    })

    test('R-2: the reads go through the session’s own server; nothing spawns the platform-mcp CLI', async ($, on) => {
      const d = await started($, on)
      await firstPrompt($, 'startup')
      await $.classic.SubagentStart({ ...START, transcript_path: '/work/main.jsonl' })
      await d.clock.settle()
      expect(d.contextReads).toContain(BUNDLE_PATH)
      expect(d.spawns).toEqual([])
    })
  })
}
