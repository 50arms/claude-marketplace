import "./run-tests-with-npm-test.generated"
// DX-5385: a compaction that ends while no turn runs (the plugin's own after the agent's ready, or a typed /compact) leaves the agent idle: nothing is coming to carry
// the briefing. The plugin starts the turn itself with ONE resume prompt (the relay's prompt path), only for the main agent of a plan-connected session.
import { describe, expect } from 'claude-code/testing'

import { RESUME_PROCEDURE, briefingText } from '../hooks/compaction/briefing'
import { relayLine, repeatLine } from '../hooks/relay/delivery'
import { SURFACES, TOLD, dashboard, startSession, test } from './plan-kit'

const COMPACTED = { messages: [{ role: 'user', text: 'the summary', toolUses: [] }] }
const TRANSCRIPT = [{ role: 'user', text: 'go', toolUses: [], handle: 'm1' }]
const AGENT = { id: 'a1', type: 'danxbot:worker-sonnet-high', description: 'build the thing', status: 'running' }
const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
const START = { prompt: 'go', turnId: 't1' } as any
const COMPACT = { source: 'compact', cwd: '/work', session_id: 'sess-own', transcript_path: '/work/main.jsonl' }
// the main agent's own compaction: its manual session.compact enters it, and the restart consumes the entry
const restartMain = async ($: any) => {
  await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })
  await $.classic.SessionStart(COMPACT)
}
const resumes = (d: any) => d.relay.submitted.filter((t: string) => t.includes('Your conversation was just compacted'))

describe('the resume procedure (pure)', () => {
  test('names the five steps in order, and the briefing carries it', () => {
    const at = ['re-invoke every skill', 'newest handoff agent note', 're-read each In Progress card', 'check your running sub-agents', 'continue the step that was in progress'].map(s => RESUME_PROCEDURE.indexOf(s))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(RESUME_PROCEDURE).toContain('without asking the person')
    const ok = <T,>(value: T) => ({ ok: true as const, value })
    expect(briefingText({ plan: null, owed: ok([]), cards: ok([]), agents: ok([]), git: ok({ branch: null, changed: 0, upstream: null, ahead: null }) })).toContain(RESUME_PROCEDURE)
  })
})

for (const surface of SURFACES) {
  describe(`the resume prompt on ${surface}`, () => {
    async function started($: any, on: any, options: Parameters<typeof dashboard>[1] = {}) {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.PreCompact', () => ({}) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      on('session.compact', async () => COMPACTED as any)
      on('turn.complete', () => ({ text: 'done' }) as any)
      const d = dashboard(on, options)
      d.world.agents = [AGENT]
      await startSession($, d, surface)
      return d
    }

    test('a compaction with no turn running starts exactly one turn with the briefing, and the next prompt and result carry no second briefing', async ($, on) => {
      const d = await started($, on)
      await restartMain($)
      await d.clock.settle()
      expect(resumes(d)).toHaveLength(1)
      const [prompt] = resumes(d)
      expect(prompt.startsWith(relayLine(''))).toBe(true)
      expect(prompt).toContain(TOLD('after_compaction').split('\n')[0])
      expect(prompt).toContain(RESUME_PROCEDURE)
      expect(prompt).toContain('Your plan is PLAN-23 Danxbot plugin.')
      expect(prompt).toContain('Cards in flight on your plan: DX-9')
      expect(prompt).toContain('Sub-agents still running (they carried on through the compaction): a1 (danxbot:worker-sonnet-high) build the thing.')
      expect(prompt).toContain('Work not pushed')
      expect((await $.prompt.submit({ text: 'next' })).context).toHaveLength(1)
      expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)).context).toHaveLength(1)
      expect(resumes(d)).toHaveLength(1)
    })

    test('each compaction gets its own single prompt', async ($, on) => {
      const d = await started($, on)
      await restartMain($)
      await d.clock.settle()
      await restartMain($)
      await d.clock.settle()
      expect(resumes(d)).toHaveLength(2)
    })

    test('a compaction in the middle of a turn starts no prompt: the briefing waits for the next tool result, once', async ($, on) => {
      const d = await started($, on)
      await $.turn.start(START)
      await restartMain($)
      await d.clock.settle()
      expect(resumes(d)).toHaveLength(0)
      const told = (await $.tool.call({ tool: 'Bash', command: 'ls' } as any)).context!.slice(1)
      expect(told).toHaveLength(1)
      expect(told[0]).toContain(TOLD('after_compaction').split('\n')[0])
      expect(told[0]).toContain(RESUME_PROCEDURE)
      expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)).context).toHaveLength(1)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(resumes(d)).toHaveLength(0)
    })

    test("a sub-agent's turns are no part of the main loop's: before an idle main compaction, with or without their end, the resume prompt still goes out", async ($, on) => {
      const d = await started($, on)
      await $.turn.start({ ...START, agentId: 'a1', turnId: 'sub-1' })
      await $.turn.complete({ ...TURN, agentId: 'a1', turnId: 'sub-1' })
      await $.turn.start({ ...START, agentId: 'a2', turnId: 'sub-2' })
      await $.turn.start({ ...START, agentId: 'a1', turnId: 'sub-3' })
      await restartMain($)
      await d.clock.settle()
      expect(resumes(d)).toHaveLength(1)
    })

    test('a session with no connection record on disk gets no prompt and its start is not taken, even when the dashboard says it is on a plan', async ($, on) => {
      const d = await started($, on)
      d.world.localRecord = false
      await restartMain($)
      await d.clock.settle()
      expect(d.relay.submitted).toEqual([])
      // not taken: the next prompt still carries the start
      expect(((await $.prompt.submit({ text: 'next' })).context ?? []).join(' ')).toContain('Your conversation was just compacted')
    })

    test('when the dashboard reads fail the prompt is the warning line plus the resume procedure', async ($, on) => {
      const d = await started($, on)
      d.world.plansStatus = 500
      await restartMain($)
      await d.clock.settle()
      expect(resumes(d)).toHaveLength(1)
      const [prompt] = resumes(d)
      expect(prompt).toContain(RESUME_PROCEDURE)
      expect(prompt).toContain('Could not load the "after_compaction" event text')
    })

    test('a session that is not on a plan gets no resume prompt', async ($, on) => {
      const d = await started($, on, { connected: false })
      await restartMain($)
      await d.clock.settle()
      expect(d.relay.submitted).toEqual([])
    })

    test("a sub-agent's compaction gets no resume prompt: its briefing stays in its own next tool result", async ($, on) => {
      const d = await started($, on)
      await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT, agentId: 'a1' })
      await $.classic.SessionStart(COMPACT)
      await d.clock.settle()
      expect(resumes(d)).toHaveLength(0)
      expect(((await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as any)).context ?? []).some((l: string) => l.includes('You are sub-agent a1'))).toBe(true)
    })

    test('a prompt the session does not take is a toast, and the briefing is still told once, on the next prompt', async ($, on) => {
      const d = await started($, on)
      d.relay.dropPrompts('busy')
      await restartMain($)
      await d.clock.settle()
      expect(d.toasts.some((t: string) => t.startsWith('The resume prompt was not taken by the session:'))).toBe(true)
      d.relay.acceptPrompts()
      const next = await $.prompt.submit({ text: 'next' })
      expect(next.context!.slice(1)[0]).toContain(RESUME_PROCEDURE)
      expect((await $.prompt.submit({ text: 'again' })).context).toHaveLength(1)
    })

    test('a compact restart nobody noted (an unattributed sub-agent compaction, a host without session.compact) while idle starts no turn, and the briefing is still told once, passively', async ($, on) => {
      const d = await started($, on)
      await $.classic.SessionStart(COMPACT)
      await d.clock.settle()
      expect(d.relay.submitted).toEqual([])
      const next = await $.prompt.submit({ text: 'next' })
      expect(next.context!.slice(1)[0]).toContain(RESUME_PROCEDURE)
      expect((await $.prompt.submit({ text: 'again' })).context).toHaveLength(1)
    })

    test('a turn that begins while the reads run gets the built briefing as a note in that turn, with no prompt and no second briefing', async ($, on) => {
      const d = await started($, on)
      d.world.contextDelayMs = 1_000
      await restartMain($)
      await $.turn.start(START)
      await d.clock.advance(5_000)
      await d.clock.settle()
      expect(d.relay.submitted).toEqual([])
      expect(d.relay.told.filter((t: string) => t.includes(RESUME_PROCEDURE))).toHaveLength(1)
      d.world.contextDelayMs = 0
      expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)).context).toHaveLength(1)
    })

    test('a turn that began during the reads and ends with no further tool result tells the briefing once as a prompt, not stranded', async ($, on) => {
      const d = await started($, on)
      d.world.contextDelayMs = 1_000
      await restartMain($)
      await $.turn.start(START)
      await d.clock.advance(5_000)
      await d.clock.settle()
      expect(d.relay.told.filter((t: string) => t.includes(RESUME_PROCEDURE))).toHaveLength(1)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(resumes(d)).toHaveLength(1)
      expect(resumes(d)[0]).toContain(repeatLine('').trim())
      expect(resumes(d)[0]).toContain(RESUME_PROCEDURE)
    })

    test('a refused note puts the start back, but never over a newer start that arrived meanwhile', async ($, on) => {
      const d = await started($, on)
      d.world.contextDelayMs = 1_000
      d.relay.rejectAppends('closed')
      await restartMain($)
      // the first write after the start is the take; the one after it is the put-back, which a newer start lands just before
      d.beforeNextWrite('pendingStart', async () => {
        d.beforeNextWrite('pendingStart', async () => {
          await $.classic.SessionStart({ ...COMPACT, session_id: 'sess-newer' })
        })
      })
      await $.turn.start(START)
      await d.clock.advance(5_000)
      await d.clock.settle()
      const writes = d.stateWrites.filter((w: any) => w.key === 'pendingStart')
      expect((writes[writes.length - 1].value as any).sessionId).toBe('sess-newer')
    })

    test('a note the running turn refuses puts the start back for its next tool result', async ($, on) => {
      const d = await started($, on)
      d.world.contextDelayMs = 1_000
      d.relay.rejectAppends('closed')
      await restartMain($)
      await $.turn.start(START)
      await d.clock.advance(5_000)
      await d.clock.settle()
      expect(d.relay.submitted).toEqual([])
      d.world.contextDelayMs = 0
      expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)).context!.slice(1)[0]).toContain(RESUME_PROCEDURE)
    })

    test('a startup, resume or clear starts no prompt', async ($, on) => {
      const d = await started($, on)
      for (const source of ['startup', 'resume', 'clear'] as const) await $.classic.SessionStart({ ...COMPACT, source })
      await d.clock.settle()
      expect(d.relay.submitted).toEqual([])
    })
  })
}
