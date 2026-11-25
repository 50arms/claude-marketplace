import "./run-tests-with-npm-test.generated"
// DX-4234: on a desktop or headless startup, resume and fork the engine has not bound the session when SessionStart runs, so `$.mcp.call` and
// `$.tool.list` throw there ("no session is bound in this process"). SessionStart therefore only records the start; the first prompt (bound)
// tells the model the restart notice and the start-up text, once. The kit models the unbound session (`d.unbind()`), which the always-bound
// fake `$` of the earlier suites could not.
import { describe, expect } from 'claude-code/testing'

import { SIGN_IN_INVITATION } from '../hooks/bundle/floor'
import { test, BUNDLE_EVENT_KEY, EVENT_TEXT, TOLD, OTHER_SESSION, SURFACES, dashboard, deliveredReports, firstPrompt, startSession } from './plan-kit'

const NOTICE = 'This session replaced one on PLAN-23; 3 events wait.'
const SOURCES = ['startup', 'resume', 'fork', 'clear', 'compact'] as const

for (const surface of SURFACES) {
  describe(`an unbound session start on ${surface}`, () => {
    // the engine's order: SessionStart (unbound) -> the session binds -> session.start -> the first prompt
    async function unboundStart($: any, on: any, source: string, options: Parameters<typeof dashboard>[1] = {}) {
      on('classic.SessionStart', () => ({}) as any)
      const d = dashboard(on, options)
      d.unbind()
      const r = await $.classic.SessionStart({ source, cwd: '/work', session_title: 'PLAN-23', transcript_path: '/work/main.jsonl' })
      d.bind()
      await startSession($, d, surface)
      d.contextReads.length = 0
      return { d, r }
    }

    for (const source of SOURCES) {
      test(`classic.SessionStart on ${source} calls neither $.mcp.call nor $.tool.list and tells nothing itself`, async ($, on) => {
        on('classic.SessionStart', () => ({}) as any)
        const d = dashboard(on, { connected: false, signedOut: 'signed-out' })
        d.unbind()
        const r = await $.classic.SessionStart({ source, cwd: '/work' })
        expect(d.unboundCalls).toEqual([])
        expect(d.restartCalls).toEqual([])
        expect(r.additionalContext).toBeUndefined()
      })
    }

    for (const [source, event] of [['startup', 'session_start'], ['resume', 'session_resume'], ['compact', 'after_compaction']] as const) {
      test(`a connected ${source} is told the ${event} text on the first prompt, once`, async ($, on) => {
        const { d } = await unboundStart($, on, source)
        const first = await $.prompt.submit({ text: 'hello' })
        expect(first.context).toHaveLength(2)
        expect(first.context![1]).toBe(TOLD(event))
        await d.clock.settle()
        expect(deliveredReports(d, BUNDLE_EVENT_KEY[event]!)).toHaveLength(1)
        const second = await $.prompt.submit({ text: 'again' })
        expect(second.context).toHaveLength(1)
      })
    }

    for (const source of ['startup', 'resume'] as const) {
      test(`a signed-out ${source} is told ${source === 'startup' ? 'only the sign-in invitation' : 'the restart notice'} on the first prompt, once`, async ($, on) => {
        const { d } = await unboundStart($, on, source, { connected: false, signedOut: 'signed-out' })
        d.world.restart.json = { notice: NOTICE }
        const first = await $.prompt.submit({ text: 'hello' })
        // a signed-out startup is told the one sign-in invitation and nothing else (CP-75); a resume is told the notice. A signed-out prompt has no time stamp: the stamp is the bundle's
        expect(first.context).toEqual([source === 'startup' ? SIGN_IN_INVITATION : NOTICE])
        expect((await $.prompt.submit({ text: 'again' })).context).toHaveLength(0)
        expect(d.restartCalls).toEqual(source === 'resume' ? [{ transcript_path: '/work/main.jsonl' }] : [])
      })
    }

    test('fork has nothing to tell: the first prompt carries nothing', async ($, on) => {
      const { d } = await unboundStart($, on, 'fork', { connected: false, signedOut: 'signed-out' })
      d.world.restart.json = { notice: NOTICE }
      expect((await $.prompt.submit({ text: 'hello' })).context).toHaveLength(0)
      expect(d.restartCalls).toEqual([])
    })

    test('two prompts landing together tell the start once', async ($, on) => {
      await unboundStart($, on, 'startup')
      const both = await Promise.all([$.prompt.submit({ text: 'a' }), $.prompt.submit({ text: 'b' })])
      expect(both.map((r: any) => r.context.length).sort()).toEqual([1, 2])
    })

    test('the start is recorded with its session id, source and transcript path, and cleared by the first prompt', async ($, on) => {
      const { d } = await unboundStart($, on, 'resume')
      await $.prompt.submit({ text: 'hello' })
      const writes = d.stateWrites.filter(w => w.key === 'pendingStart').map(w => w.value)
      expect(writes).toEqual([{ sessionId: expect.any(String), source: 'resume', transcriptPath: '/work/main.jsonl', predecessorId: null }, null])
    })

    test('a compaction in the middle of a turn is told on the next tool result, once, and the next prompt does not repeat it', async ($, on) => {
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      const d = dashboard(on)
      on('classic.SessionStart', () => ({}) as any)
      await startSession($, d, surface)
      await $.prompt.submit({ text: 'go' })
      // the engine compacts mid-turn (bound): SessionStart records it, no prompt is coming
      await $.classic.SessionStart({ source: 'compact', cwd: '/work', session_id: 'sess-own' })
      const tool = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
      expect(tool.context!).toEqual([TOLD('after_compaction')])
      expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)).context).toHaveLength(0)
      expect((await $.prompt.submit({ text: 'next' })).context).toHaveLength(1)
    })

    test("a sub-agent's tool result takes nothing of the main session's start; the next main-loop result carries it once", async ($, on) => {
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      const d = dashboard(on)
      on('classic.SessionStart', () => ({}) as any)
      await startSession($, d, surface)
      await $.classic.SessionStart({ source: 'compact', cwd: '/work', session_id: 'sess-own' })
      const sub = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as any)
      expect(sub.context).toHaveLength(0)
      expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)).context!).toEqual([TOLD('after_compaction')])
      expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)).context).toHaveLength(0)
    })

    test('a denied tool call leaves the pending start for the next result', async ($, on) => {
      let answer: any = { deny: 'not allowed' }
      on('tool.call', () => answer)
      const d = dashboard(on)
      on('classic.SessionStart', () => ({}) as any)
      await startSession($, d, surface)
      await $.classic.SessionStart({ source: 'compact', cwd: '/work', session_id: 'sess-own' })
      expect((await $.tool.call({ tool: 'Bash', command: 'rm' } as any)).context).toBeUndefined()
      answer = { result: {}, text: 'done' }
      expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)).context!).toEqual([TOLD('after_compaction')])
    })

    test('the start records the session id SessionStart was given, not the one $.session.id() answers', async ($, on) => {
      on('classic.SessionStart', () => ({}) as any)
      const d = dashboard(on)
      await startSession($, d, surface)
      d.world.sessionReadStatus = 500
      d.world.restart.json = { notice: 'NOTICE-SENTINEL' }
      // the connection record on disk is for sess-own; the start is for sess-other, which holds none: it is a session that may have replaced one, so the restart notice is asked
      const other = await firstPrompt($, 'startup', { session_id: OTHER_SESSION.session_id })
      expect((other.startLines ?? []).join('\n')).toContain('NOTICE-SENTINEL')
      expect(d.restartCalls).toHaveLength(1)
      // sess-own holds a record: it is on a plan, so the notice is not asked for it
      const own = await firstPrompt($, 'startup')
      expect((own.startLines ?? []).join('\n')).not.toContain('NOTICE-SENTINEL')
      expect(d.restartCalls).toHaveLength(1)
    })

    test('work that throws after the start was taken holds the context with the loading line, and the start is owed: the prompt and the tool result go on', async ($, on) => {
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      on('classic.SessionStart', () => ({}) as any)
      const d = dashboard(on)
      await startSession($, d, surface)
      d.world.fsError = 'disk gone'
      const r = await firstPrompt($, 'startup')
      expect(r.context.join('\n')).toMatch(/loading/)
      d.world.fsError = undefined
      // the first call after the bundle arrives is refused with the owed start text (read it, then retry); the next one runs
      expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)).deny).toContain(EVENT_TEXT('session_start'))
      expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)).text).toBe('done')
    })
  })
}
