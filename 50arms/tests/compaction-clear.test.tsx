import "./run-tests-with-npm-test.generated"
// DX-7106 (PLAN-116): a compaction of a desktop session is a CLEAR when the team's compaction setting says `clear` (DX-6732, DEC-459). The dashboard sends the setting as `mode` in the
// session's compaction control (`compact` | `clear`), the MCP relay writes it into the compaction file, and the plugin reads it there: with `clear` the agent's ready makes the plugin run
// the ready loop's own /clear (not /compact), and the fresh conversation is told what a new session is told plus a resume briefing that points at the cards. With `compact` (or a relay that
// predates the setting and writes no mode) nothing changes: /compact.
import { describe, expect } from 'claude-code/testing'

import { CLEAR_RESUME_PROCEDURE, briefingText } from '../hooks/compaction/briefing'
import { parseControlFile } from '../hooks/compaction/control'
import { relayLine } from '../hooks/relay/delivery'
import { CLEARED_SESSION_ID, CLOCK_START, EVENT_TEXT, OWN_SESSION, SESSION_ID, HOME_DIR, SURFACES, dashboard, startSession, test } from './plan-kit'

const CONTROL_FILE = `${HOME_DIR}/.config/danxbot/compaction/${OWN_SESSION.session_id}.json`
const VALVES = { 'claude-opus-4-8': 907_000 }
const control = (over: Record<string, unknown> = {}) => ({ floorTokens: 250_000, passAtTokens: 907_000, windowTokens: 1_000_000, releaseUntilMs: null, releaseId: null, agents: {}, valves: VALVES, mode: 'compact', ...over })
const fileText = (c: unknown, sessionId: string = OWN_SESSION.session_id) => JSON.stringify({ v: 1, sessionId, control: c, askedAt: null })
const READY = (mode: string | undefined, id = 'ready-1', sessionId: string = OWN_SESSION.session_id) => fileText(control({ mode, releaseUntilMs: CLOCK_START + 60_000, releaseId: id }), sessionId)
const parse = (text: string) => parseControlFile(text, OWN_SESSION.session_id)

describe('the control file carries the compaction mode (pure)', () => {
  test('a `clear` or `compact` mode is read whole', () => {
    expect(parse(fileText(control({ mode: 'clear' })))).toMatchObject({ kind: 'control', control: { mode: 'clear' } })
    expect(parse(fileText(control({ mode: 'compact' })))).toMatchObject({ kind: 'control', control: { mode: 'compact' } })
  })

  test('a file with no mode is a relay older than the setting: it compacts, as it always did', () => {
    expect(parse(fileText(control({ mode: undefined })))).toMatchObject({ kind: 'control', control: { mode: 'compact' } })
  })

  test('a mode that is neither is a file the relay would not have written', () => {
    for (const mode of ['summarise', '', null, 3]) expect(parse(fileText(control({ mode })))).toEqual({ kind: 'bad', reason: 'mode must be "compact" or "clear"' })
  })
})

describe('the resume briefing of a cleared conversation (pure)', () => {
  const ok = <T,>(value: T) => ({ ok: true as const, value })
  const input = { plan: { ref: 'PLAN-23', name: 'the plugin' }, owed: ok([]), cards: ok([{ id: 'DX-9', title: 'card' }]), agents: ok([]), git: ok({ branch: 'main', changed: 0, upstream: 'origin/main', ahead: 0 }) }

  test('says the conversation was cleared, points at the cards, and never talks of a summary or loaded skills it lost', () => {
    const text = briefingText(input, 'cleared')
    expect(text).toContain(CLEAR_RESUME_PROCEDURE)
    expect(text).toContain('was just cleared')
    expect(text).toContain('Your plan is PLAN-23 the plugin.')
    expect(text).toContain('Cards in flight on your plan: DX-9 card.')
    expect(text).not.toContain('compact')
    expect(text).not.toContain('Sub-agents')
  })

  test('puts the handoff note before the card re-read, and the step in progress last', () => {
    const at = ['newest handoff agent note', 're-read each In Progress card', 'continue the step that was in progress'].map(s => CLEAR_RESUME_PROCEDURE.indexOf(s))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(CLEAR_RESUME_PROCEDURE).toContain('without asking the person')
  })
})

for (const surface of SURFACES) {
  describe(`a compaction by clear on ${surface}`, () => {
    const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
    const START = { prompt: 'go', turnId: 't1' } as any
    const compactRuns = (d: any) => d.compactRuns as unknown[]

    async function started($: any, on: any) {
      on('turn.complete', () => ({ text: 'done' }) as any)
      on('classic.PreCompact', () => ({}) as any)
      on('classic.SessionStart', () => ({}) as any)
      on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      const d = dashboard(on, { stateSteps: true })
      d.world.context = { tokens: 120_000, window: 1_000_000 }
      await startSession($, d, surface)
      return d
    }

    // the engine's /clear around the plugin's `$.command.run`: the conversation ends, $.state is emptied, the new conversation starts under the new id; the held command returns after it
    async function engineClearsDuring($: any, d: any, release: () => void) {
      await $.session.end({ reason: 'clear', sessionId: d.world.sessionId } as any)
      d.wipeState()
      d.world.sessionId = CLEARED_SESSION_ID
      await $.classic.SessionStart({ source: 'clear', cwd: '/work', session_id: CLEARED_SESSION_ID, transcript_path: '/work/cleared.jsonl' })
      release()
      await d.clock.settle()
    }

    test('mode clear: the ready runs /clear once and never /compact', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = READY('clear')
      await $.turn.start(START)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.clearRuns).toHaveLength(1)
      expect(compactRuns(d)).toEqual([])
      // the same release is spent
      await $.turn.start(START)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.clearRuns).toHaveLength(1)
    })

    test('mode compact runs /compact and no /clear; a file with no mode does the same', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = READY('compact', 'r1')
      await $.turn.complete(TURN)
      d.world.files[CONTROL_FILE] = READY(undefined, 'r2')
      await $.turn.complete(TURN)
      expect(compactRuns(d)).toHaveLength(2)
      expect(d.clearRuns).toHaveLength(0)
    })

    test('the clear waits while a sub-agent or a background command runs, keeps the release, and runs once they have ended', async ($, on) => {
      on('classic.SubagentStart', () => ({}) as any)
      on('classic.SubagentStop', () => ({}) as any)
      on('classic.Stop', () => ({}) as any)
      on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' }, text: 'running' }) as any)
      const d = await started($, on)
      await $.classic.SubagentStart({ agent_id: 'a1b2c3', agent_type: '50arms:worker-sonnet-high' } as any)
      d.world.files[CONTROL_FILE] = READY('clear')
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.clearRuns).toHaveLength(0)
      await $.classic.SubagentStop({ agent_id: 'a1b2c3', agent_type: '50arms:worker-sonnet-high', stop_hook_active: false, agent_transcript_path: '/x/agent-a1b2c3.jsonl', background_tasks: [] } as any)
      await $.tool.call({ tool: 'Bash', command: 'sleep 99 &' } as any)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.clearRuns).toHaveLength(0)
      await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as any)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.clearRuns).toHaveLength(1)
    })

    test('a clear the engine refuses is one line to the person and starts no second /compact', async ($, on) => {
      const d = await started($, on)
      d.world.clearFails = 'the engine said no'
      d.world.files[CONTROL_FILE] = READY('clear')
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.toasts).toEqual([expect.stringMatching(/^Compaction clear failed: /)])
      expect(compactRuns(d)).toEqual([])
    })

    test('a clear that leaves the session id as it was is told, not taken for a clear', async ($, on) => {
      const d = await started($, on)
      d.world.clearDoesNothing = true
      d.world.files[CONTROL_FILE] = READY('clear')
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.toasts.some(t => t.includes('Compaction clear') && t.includes('the session id did not change'))).toBe(true)
    })

    const resumes = (d: any) => d.relay.submitted.filter((t: string) => t.includes('Your conversation was just cleared'))

    test('the fresh conversation is told a new session start and gets ONE resume prompt: the cleared procedure, the plan and its cards', async ($, on) => {
      const d = await started($, on)
      let release = () => {}
      d.world.clearHold = new Promise<void>(resolve => (release = resolve))
      d.world.files[CONTROL_FILE] = READY('clear')
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.world.clearsStarted).toBe(1)
      await engineClearsDuring($, d, release)
      expect(d.clearRuns).toHaveLength(1)
      expect(resumes(d)).toHaveLength(1)
      const [prompt] = resumes(d)
      expect(prompt.startsWith(relayLine(''))).toBe(true)
      expect(prompt).toContain(EVENT_TEXT('session_start').split('\n')[0])
      expect(prompt).toContain(CLEAR_RESUME_PROCEDURE)
      expect(prompt).toContain('Your plan is PLAN-23 50 Arms plugin.')
      expect(prompt).toContain('Cards in flight on your plan: DX-9')
      // told once: the next prompt and tool result add no second start text
      expect((await $.prompt.submit({ text: 'next' })).context).toHaveLength(1)
      expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)).context).toHaveLength(1)
      expect(resumes(d)).toHaveLength(1)
      // and no restart notice: the clear is the plugin's own
      expect(d.restartCalls).toHaveLength(0)
    })

    test("a person's own /clear is still only a clear: no resume prompt", async ($, on) => {
      const d = await started($, on)
      await $.session.end({ reason: 'clear', sessionId: d.world.sessionId } as any)
      d.wipeState()
      d.world.sessionId = CLEARED_SESSION_ID
      await $.classic.SessionStart({ source: 'clear', cwd: '/work', session_id: CLEARED_SESSION_ID, transcript_path: '/work/cleared.jsonl' })
      await d.clock.settle()
      expect(resumes(d)).toHaveLength(0)
    })

    test('the next ready after the clear starts its own clear: the module keeps no flag across conversations', async ($, on) => {
      const d = await started($, on)
      let release = () => {}
      d.world.clearHold = new Promise<void>(resolve => (release = resolve))
      d.world.files[CONTROL_FILE] = READY('clear', 'r1')
      await $.turn.complete(TURN)
      await d.clock.settle()
      await engineClearsDuring($, d, release)
      d.world.clearHold = null
      // after the clear the server writes the control under its own id
      d.world.files[`${HOME_DIR}/.config/danxbot/compaction/${SESSION_ID}.json`] = READY('clear', 'r2', SESSION_ID)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.clearRuns).toHaveLength(2)
    })
  })
}
