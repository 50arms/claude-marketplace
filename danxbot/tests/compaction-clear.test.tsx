import "./run-tests-with-npm-test.generated"
// CP-60: a main session whose control says `mode: clear` is CLEARED when its agent says ready, instead of compacted. The plugin reuses the ready loop's /clear (the same idle
// rule, the same command, the same proof that the session id changed) and starts the fresh conversation with the same start text a ready-loop reset gets. A clear
// runs only when the session is idle: no turn, no running sub-agent and no background command. Until then it waits (told once), and it never falls back to a compaction.
import { describe, expect } from 'claude-code/testing'

import { CLEAR_RESUME_OPENING } from '../hooks/compaction/briefing'
import { CLEAR_WAITING_NOTICE, USED_RELEASE_PREFIX } from '../hooks/compaction/control'
import { relayLine } from '../hooks/relay/delivery'
import { CLEARED_SESSION_ID, CLOCK_START, EVENT_TEXT, HOME_DIR, SESSION_ID, SURFACES, dashboard, startSession, test } from './plan-kit'

const WINDOW = 1_000_000
const VALVES = { 'claude-haiku-5-5': 180_000, 'claude-sonnet-5-5': 600_000, 'claude-opus-4-8': 907_000 }
// the session's MCP server keeps SESSION_ID through a /clear, so its control file is named for it however often the engine's id changes
const CONTROL_FILE = `${HOME_DIR}/.config/danxbot/compaction/${SESSION_ID}.json`
const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
const START = { prompt: 'go', turnId: 't1' } as any
const AGENT = { agent_id: 'a1b2c3', agent_type: 'danxbot:worker-sonnet-high' } as any
const COMPACTED = { messages: [{ role: 'user', text: 'the summary', toolUses: [] }] }
const TRANSCRIPT = [{ role: 'user', text: 'go', toolUses: [], handle: 'm1' }]
const PRE = (trigger: string) => ({ trigger, session_id: SESSION_ID, transcript_path: '/work/main.jsonl', cwd: '/work', custom_instructions: null }) as any

type Over = { mode?: 'compact' | 'clear' | null; releaseId?: string | null; releaseUntilMs?: number | null }
// the file the relay writes; `mode: null` leaves the key out, as a relay older than the mode wrote it
const file = ({ mode = 'clear', releaseId = null, releaseUntilMs = releaseId === null ? null : CLOCK_START + 60_000 }: Over = {}): string =>
  JSON.stringify({
    v: 1,
    sessionId: SESSION_ID,
    control: { floorTokens: 250_000, passAtTokens: 907_000, windowTokens: WINDOW, releaseUntilMs, releaseId, agents: {}, valves: VALVES, ...(mode === null ? {} : { mode }) },
    askedAt: null,
  })
const CLEARING = 'Clearing now: your agent said it is ready.'

for (const surface of SURFACES) {
  describe(`a ready session is cleared when its control says clear, on ${surface}`, () => {
    async function started($: any, on: any) {
      // the engine's core for a compaction: a test holds it to keep a compaction running
      const core = { hold: null as Promise<void> | null }
      on('session.compact', async () => {
        if (core.hold !== null) await core.hold
        return COMPACTED as any
      })
      on('turn.complete', () => ({ text: 'done' }) as any)
      on('classic.PreCompact', () => ({}) as any)
      on('classic.SessionStart', () => ({}) as any)
      on('classic.SubagentStart', () => ({}) as any)
      on('classic.SubagentStop', () => ({}) as any)
      on('classic.Stop', () => ({}) as any)
      on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' }, text: 'running' }) as any)
      const d = dashboard(on)
      d.world.sessionId = SESSION_ID
      d.world.context = { tokens: 120_000, window: WINDOW }
      await startSession($, d, surface)
      return Object.assign(d, { core })
    }
    const turnEnds = async ($: any, d: any) => {
      await $.turn.start(START)
      await $.turn.complete(TURN)
      await d.clock.settle()
    }
    const tick = async (d: any) => {
      d.clock.advance(5_000)
      await d.clock.settle()
    }
    const held = () => {
      let release!: () => void
      const promise = new Promise<void>(resolve => (release = resolve))
      return { promise, release }
    }
    const resumes = (d: any) => d.relay.submitted.filter((t: string) => t.includes(CLEAR_RESUME_OPENING))

    test("the agent's ready clears the session once at the main loop's turn end, and never runs the compact command", async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = file()
      await $.turn.start(START)
      d.world.files[CONTROL_FILE] = file({ releaseId: 'ready-1' })
      // inside a turn nothing runs
      await tick(d)
      expect(d.clearRuns).toEqual([])
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.clearRuns).toHaveLength(1)
      expect(d.compactRuns).toEqual([])
      expect(d.toasts).toContain(CLEARING)
    })

    test('a clear spends its release: the same release clears once, a later one clears again', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = file({ releaseId: 'ready-1' })
      await turnEnds($, d)
      expect(d.clearRuns).toHaveLength(1)
      expect(d.world.sessionId).toBe(CLEARED_SESSION_ID)
      // the dashboard's next write of the control still names the release (a clear writes no compaction row), and the engine now answers another id
      await tick(d)
      await turnEnds($, d)
      expect(d.clearRuns).toHaveLength(1)
      d.world.files[CONTROL_FILE] = file({ releaseId: 'ready-2' })
      await turnEnds($, d)
      expect(d.clearRuns).toHaveLength(2)
      expect(d.compactRuns).toEqual([])
    })

    test('a second release that arrives while a clear is still running starts no second clear', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = file({ releaseId: 'ready-1' })
      const hold = held()
      d.world.clearHold = hold.promise
      await turnEnds($, d)
      expect(d.world.clearsStarted).toBe(1)
      d.world.files[CONTROL_FILE] = file({ releaseId: 'ready-2' })
      await tick(d)
      await tick(d)
      expect(d.world.clearsStarted).toBe(1)
      hold.release()
      await d.clock.settle()
    })

    // a person's own /compact (or Claude Code's) is running: the plugin notes it from the moment core starts it until the session restarts from it
    for (const mode of ['compact', 'clear'] as const) {
      test(`a ready that arrives while a compaction is running starts no ${mode === 'clear' ? 'clear' : 'second compaction'}, and is not spent: it acts once the compaction has ended`, async ($, on) => {
        const d = await started($, on)
        d.world.files[CONTROL_FILE] = file({ mode })
        const hold = held()
        d.core.hold = hold.promise
        const running = $.session.compact({ trigger: 'manual', messages: TRANSCRIPT } as any)
        await d.clock.settle()
        d.world.files[CONTROL_FILE] = file({ mode, releaseId: 'ready-1' })
        await turnEnds($, d)
        await tick(d)
        await tick(d)
        expect(d.compactRuns).toEqual([])
        expect(d.world.clearsStarted).toBe(0)
        hold.release()
        await running
        await $.classic.SessionStart({ session_id: SESSION_ID, source: 'compact', cwd: '/work', transcript_path: '/work/main.jsonl' } as any)
        await d.clock.settle()
        await tick(d)
        if (mode === 'clear') {
          expect(d.clearRuns).toHaveLength(1)
          expect(d.compactRuns).toEqual([])
        } else {
          expect(d.compactRuns).toHaveLength(1)
          expect(d.clearRuns).toEqual([])
        }
      })
    }

    // a plugin reload starts a new process that remembers nothing but the store: the release a clear spent must read as spent under the id the control file is named for, not the engine's new one
    test("a plugin process that starts after the clear finds the release spent in the store under the dashboard's id", async ($, on) => {
      const d = await started($, on)
      d.stored.set(`${USED_RELEASE_PREFIX}${SESSION_ID}`, { releaseId: 'ready-1', at: CLOCK_START })
      d.world.sessionId = CLEARED_SESSION_ID
      d.world.files[CONTROL_FILE] = file({ releaseId: 'ready-1' })
      await turnEnds($, d)
      await tick(d)
      expect(d.clearRuns).toEqual([])
      expect(d.world.clearsStarted).toBe(0)
      d.world.files[CONTROL_FILE] = file({ releaseId: 'ready-2' })
      await turnEnds($, d)
      expect(d.clearRuns).toHaveLength(1)
    })

    test('a running sub-agent holds the clear, told once, until it stops; the compaction never runs in its place', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = file({ releaseId: 'ready-1' })
      await $.classic.SubagentStart(AGENT)
      await turnEnds($, d)
      await tick(d)
      await tick(d)
      expect(d.clearRuns).toEqual([])
      expect(d.compactRuns).toEqual([])
      expect(d.toasts.filter((t: string) => t === CLEAR_WAITING_NOTICE)).toHaveLength(1)
      await $.classic.SubagentStop({ ...AGENT, stop_hook_active: false, agent_transcript_path: '/x/agent-a1b2c3.jsonl', background_tasks: [] })
      await tick(d)
      expect(d.clearRuns).toHaveLength(1)
      expect(d.compactRuns).toEqual([])
      expect(d.toasts).toContain(CLEARING)
    })

    test('a background command holds the clear until a Stop no longer lists it', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = file({ releaseId: 'ready-1' })
      await $.tool.call({ tool: 'Bash', command: 'sleep 100', run_in_background: true, description: 'sleep' } as any)
      await turnEnds($, d)
      await tick(d)
      expect(d.clearRuns).toEqual([])
      expect(d.toasts.filter((t: string) => t === CLEAR_WAITING_NOTICE)).toHaveLength(1)
      await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'bg1', status: 'running', type: 'shell' }] } as any)
      await tick(d)
      expect(d.clearRuns).toEqual([])
      await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as any)
      await tick(d)
      expect(d.clearRuns).toHaveLength(1)
      expect(d.compactRuns).toEqual([])
    })

    test('a release that expires while the session waits clears nothing, and a new release clears once the session is idle', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = file({ releaseId: 'ready-1', releaseUntilMs: CLOCK_START + 7_000 })
      await $.classic.SubagentStart(AGENT)
      await turnEnds($, d)
      d.clock.advance(60_000)
      await d.clock.settle()
      await $.classic.SubagentStop({ ...AGENT, stop_hook_active: false, agent_transcript_path: '/x/agent-a1b2c3.jsonl', background_tasks: [] })
      await tick(d)
      expect(d.clearRuns).toEqual([])
      expect(d.compactRuns).toEqual([])
      d.world.files[CONTROL_FILE] = file({ releaseId: 'ready-2', releaseUntilMs: CLOCK_START + 600_000 })
      await tick(d)
      expect(d.clearRuns).toHaveLength(1)
    })

    test('a clear the engine refuses is told, spent, and not retried; nothing is compacted instead', async ($, on) => {
      const d = await started($, on)
      d.world.clearFails = 'a sub-agent is still running'
      d.world.files[CONTROL_FILE] = file({ releaseId: 'ready-1' })
      await turnEnds($, d)
      await tick(d)
      await tick(d)
      expect(d.world.clearsStarted).toBe(1)
      expect(d.compactRuns).toEqual([])
      expect(d.toasts.filter((t: string) => t.startsWith('Clearing the session failed:'))).toHaveLength(1)
      expect(resumes(d)).toEqual([])
    })

    test('a clear that leaves the session id unchanged is told as a failure', async ($, on) => {
      const d = await started($, on)
      d.world.clearDoesNothing = true
      d.world.files[CONTROL_FILE] = file({ releaseId: 'ready-1' })
      await turnEnds($, d)
      expect(d.toasts.some((t: string) => t.includes('the session id did not change'))).toBe(true)
      expect(d.compactRuns).toEqual([])
      expect(resumes(d)).toEqual([])
    })

    test('the fresh conversation gets one resume prompt with the post-reset start text, and the next prompt carries no second copy', async ($, on) => {
      const d = await started($, on)
      // the connection record is under the server's id, which a clear keeps
      d.world.localRecord = false
      d.world.records.push(SESSION_ID)
      d.world.files[CONTROL_FILE] = file({ releaseId: 'ready-1' })
      const hold = held()
      d.world.clearHold = hold.promise
      await $.turn.start(START)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.world.clearsStarted).toBe(1)
      // the phase a real /clear runs in: the engine raises its session start during the command
      await $.classic.SessionStart({ session_id: CLEARED_SESSION_ID, source: 'clear', cwd: '/work', transcript_path: '/work/main.jsonl' } as any)
      hold.release()
      await d.clock.settle()
      expect(resumes(d)).toHaveLength(1)
      const [prompt] = resumes(d)
      expect(prompt.startsWith(relayLine(''))).toBe(true)
      expect(prompt).toContain(EVENT_TEXT('session_start'))
      expect(prompt).not.toContain('Your conversation was just compacted')
      expect(((await $.prompt.submit({ text: 'next' })).context ?? []).join(' ')).not.toContain(EVENT_TEXT('session_start'))
      expect(resumes(d)).toHaveLength(1)
    })

    test('a session that is not on a plan is cleared but gets no resume prompt: its start waits for the next prompt', async ($, on) => {
      const d = await started($, on)
      d.world.localRecord = false
      d.world.files[CONTROL_FILE] = file({ releaseId: 'ready-1' })
      const hold = held()
      d.world.clearHold = hold.promise
      await turnEnds($, d)
      await $.classic.SessionStart({ session_id: CLEARED_SESSION_ID, source: 'clear', cwd: '/work', transcript_path: '/work/main.jsonl' } as any)
      hold.release()
      await d.clock.settle()
      expect(d.clearRuns).toHaveLength(1)
      expect(d.relay.submitted).toEqual([])
    })

    for (const mode of ['compact', null] as const) {
      test(`${mode === null ? 'a control with no mode (a relay older than the mode)' : 'compact mode'} still compacts and never clears`, async ($, on) => {
        const d = await started($, on)
        d.world.files[CONTROL_FILE] = file({ mode, releaseId: 'ready-1' })
        await turnEnds($, d)
        expect(d.compactRuns).toHaveLength(1)
        expect(d.clearRuns).toEqual([])
        expect(d.toasts).toContain('Compacting now: your agent said it is ready.')
      })
    }
  })
}
