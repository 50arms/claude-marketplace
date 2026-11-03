import "./run-tests-with-npm-test.generated"
// CP-62: a /clear a person types in a session that was on a plan leaves an idle conversation (a clear starts no turn). The plugin starts the turn itself, by the same prompt path as the
// resume after a compaction, telling the session which plan it was on. Each test drives a real clear's two engine events through the plugin: `session.end` for the conversation that ended,
// then `classic.SessionStart` (source clear) for the fresh one, with the engine answering the new session id in between.
import { describe, expect } from 'claude-code/testing'

import { PERSON_CLEAR_RESUME_OPENING } from '../hooks/compaction/briefing'
import { relayLine } from '../hooks/relay/delivery'
import { CLEARED_SESSION_ID, SURFACES, dashboard, startSession, test } from './plan-kit'

const NOTICE = 'This session replaced one on PLAN-23; 3 events wait.'
const PREVIOUS = 'sess-previous'
const START = { prompt: 'go', turnId: 't1' } as any
const SIGNED_OUT_TOAST = 'This cleared session has no dashboard key yet, so it cannot reconnect by itself: approve it with the link and code in the band, then it carries on.'

for (const surface of SURFACES) {
  describe(`a session a person cleared carries on by itself on ${surface}`, () => {
    async function started($: any, on: any, options: Parameters<typeof dashboard>[1] = {}) {
      on('classic.SessionStart', () => ({}) as any)
      on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      const d = dashboard(on, options)
      await startSession($, d, surface)
      d.world.restart.json = { notice: NOTICE }
      return d
    }
    // what a person's /clear does to the plugin: the ended conversation's session.end, then the fresh conversation's SessionStart, under the id the engine now answers
    async function personClears($: any, d: any, { onPlan = true }: { onPlan?: boolean } = {}) {
      if (onPlan) d.world.records.push(PREVIOUS)
      await $.session.end({ reason: 'clear', sessionId: PREVIOUS } as any)
      d.world.sessionId = CLEARED_SESSION_ID
      d.world.localRecord = false
      await $.classic.SessionStart({ source: 'clear', cwd: '/work', session_id: CLEARED_SESSION_ID, transcript_path: '/work/main.jsonl' })
      await d.clock.settle()
    }
    const wakes = (d: any) => d.relay.submitted.filter((t: string) => t.includes(PERSON_CLEAR_RESUME_OPENING))

    test('a clear with no turn running starts exactly one turn, which names the plan and says to resume from its cards and newest handoff note', async ($, on) => {
      const d = await started($, on)
      await personClears($, d)
      expect(wakes(d)).toHaveLength(1)
      const [prompt] = wakes(d)
      expect(prompt.startsWith(relayLine(''))).toBe(true)
      expect(prompt).toContain(NOTICE)
      expect(prompt).toContain('newest handoff agent note')
      expect(prompt).toContain('re-read each In Progress card')
      expect(d.restartCalls).toEqual([{ predecessor_id: PREVIOUS }])
      // told once: neither the next prompt nor the next tool result repeats it
      expect((await $.prompt.submit({ text: 'next' })).context).toHaveLength(1)
      expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)).context).toHaveLength(1)
      expect(wakes(d)).toHaveLength(1)
      expect(d.toasts).not.toContain(SIGNED_OUT_TOAST)
    })

    test('each clear gets its own single turn', async ($, on) => {
      const d = await started($, on)
      await personClears($, d)
      d.world.records.length = 0
      await personClears($, d)
      expect(wakes(d)).toHaveLength(2)
    })

    test('a session that was not on a plan stays quiet: no turn, and the server is never asked', async ($, on) => {
      const d = await started($, on)
      await personClears($, d, { onPlan: false })
      expect(d.relay.submitted).toEqual([])
      expect(d.restartCalls).toEqual([])
      expect((await $.prompt.submit({ text: 'next' })).context).toHaveLength(1)
    })

    test('a plan that has nothing to tell (no notice) starts no turn', async ($, on) => {
      const d = await started($, on)
      d.world.restart.json = { notice: null }
      await personClears($, d)
      expect(d.relay.submitted).toEqual([])
    })

    test('a clear whose end the plugin never saw starts no turn', async ($, on) => {
      const d = await started($, on)
      d.world.sessionId = CLEARED_SESSION_ID
      await $.classic.SessionStart({ source: 'clear', cwd: '/work', session_id: CLEARED_SESSION_ID, transcript_path: '/work/main.jsonl' })
      await d.clock.settle()
      expect(d.relay.submitted).toEqual([])
    })

    test('a clear that lands while a turn is running starts no second turn', async ($, on) => {
      const d = await started($, on)
      await $.turn.start(START)
      await personClears($, d)
      expect(d.relay.submitted).toEqual([])
    })

    test('a startup, resume or compaction is not a clear: no turn from this path', async ($, on) => {
      const d = await started($, on)
      for (const source of ['startup', 'resume']) {
        await $.classic.SessionStart({ source, cwd: '/work', session_id: CLEARED_SESSION_ID, transcript_path: '/work/main.jsonl' })
        await d.clock.settle()
      }
      expect(wakes(d)).toEqual([])
    })

    test('a cleared session that holds no key says so in one line, and still starts the turn that asks the person to approve it', async ($, on) => {
      const d = await started($, on)
      d.world.signedOut = 'signed-out'
      await personClears($, d)
      expect(d.toasts.filter((t: string) => t === SIGNED_OUT_TOAST)).toHaveLength(1)
      expect(wakes(d)).toHaveLength(1)
    })

    test('a prompt the session refuses is told, and the start is still owed to the next prompt', async ($, on) => {
      const d = await started($, on)
      d.relay.dropPrompts('busy')
      await personClears($, d)
      expect(d.toasts.some((t: string) => t.startsWith('The resume prompt was not taken by the session'))).toBe(true)
      d.relay.acceptPrompts()
      const next = await $.prompt.submit({ text: 'next' })
      expect(next.context!.slice(1).join('\n')).toContain(NOTICE)
      expect((await $.prompt.submit({ text: 'again' })).context).toHaveLength(1)
    })
  })
}
