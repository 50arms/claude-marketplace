import "./run-tests-with-npm-test.generated"
// DX-7106 (PLAN-116): a compaction of a desktop session is a CLEAR when the team's compaction setting says `clear` (DX-6732, DEC-459). The dashboard sends the setting as `mode` in the
// session's compaction control (`compact` | `clear`), the MCP relay writes it into the compaction file, and the plugin reads it there: with `clear` the agent's ready makes the plugin run
// the ready loop's own /clear (not /compact), and the fresh conversation is told what a new session is told plus a resume briefing that points at the cards. With `compact` (or a relay that
// predates the setting and writes no mode) nothing changes: /compact.
import { describe, expect } from 'claude-code/testing'

import { CLEAR_RESUME_OPENING, CLEAR_RESUME_PROCEDURE, briefingText } from '../hooks/compaction/briefing'
import { CLEAR_MARK_PREFIX, USED_RELEASE_KEEP, USED_RELEASE_PREFIX, compactionClearMarkKey, parseControlFile, usedReleaseKey } from '../hooks/compaction/control'
import { relayLine } from '../hooks/relay/delivery'
import { CLEARED_SESSION_ID, CLOCK_START, EVENT_TEXT, OWN_SESSION, RECORD_PATH, SESSION_ID, HOME_DIR, SURFACES, dashboard, startSession, test } from './plan-kit'

// the desktop's own session id, which every process of the session sees and the sidebar names it by (the engine's session id changes at a clear; this one does not)
const HOST_VAR = 'CLAUDE_CODE_HOST_SESSION_ID'
const HOST = 'local_9d9d392a-test'
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
      expect(d.toasts).toEqual(['Compaction clear failed: the session id did not change'])
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
      expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)).context).toHaveLength(0)
      expect(resumes(d)).toHaveLength(1)
      // and no restart notice: the clear is the plugin's own
      expect(d.restartCalls).toHaveLength(0)
    })

    test("a person's own /clear after a compaction clear is only a clear: no second resume prompt", async ($, on) => {
      const d = await started($, on)
      let release = () => {}
      d.world.clearHold = new Promise<void>(resolve => (release = resolve))
      d.world.files[CONTROL_FILE] = READY('clear')
      await $.turn.complete(TURN)
      await d.clock.settle()
      await engineClearsDuring($, d, release)
      expect(resumes(d)).toHaveLength(1)
      // the person types /clear in the new conversation: the engine's order, with no plugin command running
      const again = `${CLEARED_SESSION_ID}-again`
      await $.session.end({ reason: 'clear', sessionId: d.world.sessionId } as any)
      d.wipeState()
      d.world.sessionId = again
      await $.classic.SessionStart({ source: 'clear', cwd: '/work', session_id: again, transcript_path: '/work/cleared-again.jsonl' })
      await d.clock.settle()
      expect(resumes(d)).toHaveLength(1)
    })

    // the cleared session's turn is started with the opening whatever the start text could not be read as: the start is already taken, so nothing else would tell it how to resume
    const OPENING = relayLine(CLEAR_RESUME_OPENING)

    test('a start text that cannot be read (the dashboard answers nothing for it) still submits the resume opening', async ($, on) => {
      const d = await started($, on)
      let release = () => {}
      d.world.clearHold = new Promise<void>(resolve => (release = resolve))
      d.world.files[CONTROL_FILE] = READY('clear')
      await $.turn.complete(TURN)
      await d.clock.settle()
      // a lapsed key: the dashboard is quiet for it, so the start has no text, while the connection record on disk still says the session is on a plan
      d.world.signedOut = 'lapsed'
      await engineClearsDuring($, d, release)
      expect(d.relay.submitted.filter((t: string) => t === OPENING)).toHaveLength(1)
    })

    test('a start text whose reads throw is one warning line before the resume opening, and the opening is still submitted', async ($, on) => {
      const d = await started($, on)
      let release = () => {}
      d.world.clearHold = new Promise<void>(resolve => (release = resolve))
      d.world.files[CONTROL_FILE] = READY('clear')
      await $.turn.complete(TURN)
      await d.clock.settle()
      // the new conversation's connection record is looked for twice: by the resume (before it takes the start) and by the start's text; the second read of the disk throws
      let looks = 0
      d.world.afterExists = (path: string) => {
        if (path === RECORD_PATH(CLEARED_SESSION_ID) && ++looks === 2) throw new Error('the disk is gone')
      }
      await engineClearsDuring($, d, release)
      expect(looks).toBeGreaterThanOrEqual(2)
      const [prompt] = d.relay.submitted.filter((t: string) => t.includes('was just cleared'))
      // the kit answers a hook that threw as `no implementation`; what matters is that the reads failed and said so, in the event's own line
      expect(prompt).toContain('Could not load the "session_start" event text')
      expect(prompt).toContain(CLEAR_RESUME_OPENING)
    })

    // The clear ends the process in the desktop app: the next conversation runs in a NEW process of the same desktop session. It has an empty $.state, a new engine id that its `session.start` makes the boot id, and the
    // relay of that process names its file by its own session id; the dashboard keeps sending the same release until it expires. The spent record is the desktop session's (its host id survives the process end) and
    // names the release, so the release stays spent for it, and a new release clears again.
    test('a new process with an empty $.state does not act on the release again, and a new release clears again', async ($, on) => {
      const d = await started($, on)
      d.setEnv(HOST_VAR, HOST)
      d.world.sessionId = SESSION_ID
      const relayFile = (id: string) => `${HOME_DIR}/.config/danxbot/compaction/${id}.json`
      d.world.files[relayFile(SESSION_ID)] = READY('clear', 'r1', SESSION_ID)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.clearRuns).toHaveLength(1)
      // the new process, in the engine's order: an empty $.state, then `session.start` under the new id, then the relay's file for it holding the same unexpired release
      d.wipeState()
      expect(d.world.sessionId).not.toBe(SESSION_ID)
      await $.session.start({ cwd: '/work', surface, isInteractive: true } as any)
      const id = d.world.sessionId
      d.world.files[relayFile(id)] = READY('clear', 'r1', id)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.clearRuns).toHaveLength(1)
      d.world.files[relayFile(id)] = READY('clear', 'r2', id)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.clearRuns).toHaveLength(2)
    })

    test("another desktop session's spent record for the same release id does not hold this one", async ($, on) => {
      const d = await started($, on)
      d.setEnv(HOST_VAR, HOST)
      d.stored.set(usedReleaseKey('local_someone-else', 'r1'), { releaseId: 'r1', at: CLOCK_START })
      d.world.files[CONTROL_FILE] = READY('clear', 'r1')
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.clearRuns).toHaveLength(1)
      expect(d.stored.has(usedReleaseKey(HOST, 'r1'))).toBe(true)
    })

    test('a release id that is a timestamp (it holds colons) is spent and pruned as one record', async ($, on) => {
      const d = await started($, on)
      d.setEnv(HOST_VAR, HOST)
      const stamp = '2026-11-11T05:00:00.000Z'
      d.world.files[CONTROL_FILE] = READY('clear', stamp)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.stored.get(usedReleaseKey(HOST, stamp))).toMatchObject({ releaseId: stamp })
      expect(d.clearRuns).toHaveLength(1)
      for (let i = 0; i < USED_RELEASE_KEEP + 3; i++) d.stored.set(usedReleaseKey(HOST, `2026-11-11T04:${String(i).padStart(2, '0')}:00.000Z`), { releaseId: 'old', at: 100 + i })
      // the kit's /clear moved the engine id; the control file is read under the id the session started with
      d.world.sessionId = OWN_SESSION.session_id
      d.world.files[CONTROL_FILE] = READY('clear', '2026-11-11T05:01:00.000Z')
      await $.turn.complete(TURN)
      await d.clock.settle()
      const kept = [...d.stored.keys()].filter(k => k.startsWith(USED_RELEASE_PREFIX))
      expect(kept).toHaveLength(USED_RELEASE_KEEP)
      expect(kept).toContain(usedReleaseKey(HOST, stamp))
      expect(kept).toContain(usedReleaseKey(HOST, '2026-11-11T05:01:00.000Z'))
      expect(kept).not.toContain(usedReleaseKey(HOST, '2026-11-11T04:00:00.000Z'))
    })

    // The mark of a clear in progress outlives the process the clear ends: it is a $.store record of the desktop session (its host id), with an expiry. The new process of that session takes it with its first start, any source.
    const MARK_TTL = 10 * 60_000
    const mark = (over: Record<string, unknown> = {}) => ({ releaseId: 'r1', at: CLOCK_START, until: CLOCK_START + MARK_TTL, ...over })
    const NEW_PROCESS_ID = 'sess-new-process'
    const markKeys = (d: any) => [...d.stored.keys()].filter(k => k.startsWith(CLEAR_MARK_PREFIX))
    async function newProcessStarts($: any, d: any, source: string) {
      d.wipeState()
      d.world.sessionId = NEW_PROCESS_ID
      await $.session.start({ cwd: '/work', surface, isInteractive: true } as any)
      await $.classic.SessionStart({ source, cwd: '/work', session_id: NEW_PROCESS_ID, transcript_path: '/work/new.jsonl' })
      await d.clock.settle()
    }

    for (const source of ['startup', 'resume', 'clear', 'compact']) {
      test(`a new process of the desktop session that left the clear mark: its first start (${source}) gets exactly one cleared resume prompt, and a second start none`, async ($, on) => {
        const d = await started($, on)
        d.setEnv(HOST_VAR, HOST)
        d.stored.set(compactionClearMarkKey(HOST), mark())
        await newProcessStarts($, d, source)
        expect(resumes(d)).toHaveLength(1)
        expect(resumes(d)[0]).toContain(CLEAR_RESUME_PROCEDURE)
        expect(markKeys(d)).toEqual([])
        await $.classic.SessionStart({ source: 'resume', cwd: '/work', session_id: NEW_PROCESS_ID, transcript_path: '/work/new.jsonl' })
        await d.clock.settle()
        expect(resumes(d)).toHaveLength(1)
      })
    }

    test("another desktop session's mark in the same folder is left alone and gives no resume", async ($, on) => {
      const d = await started($, on)
      d.setEnv(HOST_VAR, HOST)
      d.stored.set(compactionClearMarkKey('local_someone-else'), mark())
      await newProcessStarts($, d, 'startup')
      expect(resumes(d)).toHaveLength(0)
      expect(markKeys(d)).toEqual([compactionClearMarkKey('local_someone-else')])
    })

    test('a mark that has expired gives no resume and is dropped', async ($, on) => {
      const d = await started($, on)
      d.setEnv(HOST_VAR, HOST)
      d.stored.set(compactionClearMarkKey(HOST), mark({ until: CLOCK_START - 1 }))
      await newProcessStarts($, d, 'startup')
      expect(resumes(d)).toHaveLength(0)
      expect(markKeys(d)).toEqual([])
    })

    test('a start that is not the new process first one, and not the clear itself, leaves the mark alone', async ($, on) => {
      const d = await started($, on)
      d.setEnv(HOST_VAR, HOST)
      // this process has started already: a later resume start is none of a mark's business (the mark is a predecessor's, left after it)
      await $.classic.SessionStart({ source: 'startup', cwd: '/work', session_id: OWN_SESSION.session_id, transcript_path: '/work/main.jsonl' })
      d.stored.set(compactionClearMarkKey(HOST), mark())
      await $.classic.SessionStart({ source: 'resume', cwd: '/work', session_id: OWN_SESSION.session_id, transcript_path: '/work/main.jsonl' })
      await d.clock.settle()
      expect(resumes(d)).toHaveLength(0)
      expect(markKeys(d)).toEqual([compactionClearMarkKey(HOST)])
    })

    // a person's own /clear is a start in a process that has started before: it must not be taken for a new process's first start, which holds only while `startSeen` is carried across the /clear
    test("a person's own /clear start leaves a stored mark alone", async ($, on) => {
      const d = await started($, on)
      d.setEnv(HOST_VAR, HOST)
      await $.classic.SessionStart({ source: 'startup', cwd: '/work', session_id: OWN_SESSION.session_id, transcript_path: '/work/main.jsonl' })
      d.stored.set(compactionClearMarkKey(HOST), mark())
      await $.session.end({ reason: 'clear', sessionId: d.world.sessionId } as any)
      d.wipeState()
      d.world.sessionId = CLEARED_SESSION_ID
      await $.classic.SessionStart({ source: 'clear', cwd: '/work', session_id: CLEARED_SESSION_ID, transcript_path: '/work/cleared.jsonl' })
      await d.clock.settle()
      expect(resumes(d)).toHaveLength(0)
      expect(markKeys(d)).toEqual([compactionClearMarkKey(HOST)])
    })

    test('a terminal host (no host id) writes no store mark: its clear keeps the process, and the $.state mark covers it', async ($, on) => {
      const d = await started($, on)
      let release = () => {}
      d.world.clearHold = new Promise<void>(resolve => (release = resolve))
      d.world.files[CONTROL_FILE] = READY('clear', 'r1')
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(markKeys(d)).toEqual([])
      await engineClearsDuring($, d, release)
      expect(resumes(d)).toHaveLength(1)
    })

    test('the mark is written before the clear and gone once its start has taken it, before the plugin command returns', async ($, on) => {
      const d = await started($, on)
      d.setEnv(HOST_VAR, HOST)
      let release = () => {}
      d.world.clearHold = new Promise<void>(resolve => (release = resolve))
      d.world.files[CONTROL_FILE] = READY('clear', 'r1')
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.stored.get(compactionClearMarkKey(HOST))).toMatchObject({ releaseId: 'r1', until: expect.any(Number) })
      // the engine's events while the command is held; the start takes the mark
      await $.session.end({ reason: 'clear', sessionId: d.world.sessionId } as any)
      d.wipeState()
      d.world.sessionId = CLEARED_SESSION_ID
      await $.classic.SessionStart({ source: 'clear', cwd: '/work', session_id: CLEARED_SESSION_ID, transcript_path: '/work/cleared.jsonl' })
      expect(markKeys(d)).toEqual([])
      release()
      await d.clock.settle()
      expect(resumes(d)).toHaveLength(1)
    })

    test('a clear that did not happen leaves no mark behind', async ($, on) => {
      const d = await started($, on)
      d.setEnv(HOST_VAR, HOST)
      d.world.clearFails = 'no'
      d.world.files[CONTROL_FILE] = READY('clear', 'r9')
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(markKeys(d)).toEqual([])
    })

    // a start that is not a /clear is never the plugin's clear's start, so it leaves the mark for the clear's own
    test('a resume start while the plugin clear runs gets no cleared resume and leaves the mark for the clear start', async ($, on) => {
      const d = await started($, on)
      d.seedState('compactionClear', true)
      await $.classic.SessionStart({ source: 'resume', cwd: '/work', session_id: OWN_SESSION.session_id, transcript_path: '/work/main.jsonl' })
      await d.clock.settle()
      expect(resumes(d)).toHaveLength(0)
      d.world.sessionId = CLEARED_SESSION_ID
      await $.classic.SessionStart({ source: 'clear', cwd: '/work', session_id: CLEARED_SESSION_ID, transcript_path: '/work/cleared.jsonl' })
      await d.clock.settle()
      expect(resumes(d)).toHaveLength(1)
    })

    // the mark is for one start: a person's own /clear that lands first takes it, and the plugin clear's start after it finds none
    test("a person's own /clear start that lands while the plugin clear is held takes the mark once: the clear's own start is no second resume", async ($, on) => {
      const d = await started($, on)
      let release = () => {}
      d.world.clearHold = new Promise<void>(resolve => (release = resolve))
      d.world.files[CONTROL_FILE] = READY('clear')
      await $.turn.complete(TURN)
      await d.clock.settle()
      const person = `${CLEARED_SESSION_ID}-person`
      d.world.sessionId = person
      await $.classic.SessionStart({ source: 'clear', cwd: '/work', session_id: person, transcript_path: '/work/person.jsonl' })
      await d.clock.settle()
      expect(resumes(d)).toHaveLength(1)
      await engineClearsDuring($, d, release)
      expect(resumes(d)).toHaveLength(1)
    })

    // a plugin reload keeps $.state and drops the module's variables, so the mark of a clear in progress is a $.state value: a conversation that opens while it is set is the one to resume
    test("the mark of a compaction clear in progress lives in $.state: a clear start that finds it set is resumed", async ($, on) => {
      const d = await started($, on)
      d.seedState('compactionClear', true)
      d.world.sessionId = CLEARED_SESSION_ID
      await $.classic.SessionStart({ source: 'clear', cwd: '/work', session_id: CLEARED_SESSION_ID, transcript_path: '/work/cleared.jsonl' })
      await d.clock.settle()
      expect(resumes(d)).toHaveLength(1)
    })

    test('in the same process the conversation a clear opened does not clear again for the release the clear acted on, and a new release clears again', async ($, on) => {
      const d = await started($, on)
      let release = () => {}
      d.world.clearHold = new Promise<void>(resolve => (release = resolve))
      d.world.files[CONTROL_FILE] = READY('clear', 'r1')
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.world.clearsStarted).toBe(1)
      // the relay's file is the dashboard session id's, which the clear does not change, and it names r1 until the dashboard moves on
      const relayFile = `${HOME_DIR}/.config/danxbot/compaction/${SESSION_ID}.json`
      d.world.files[relayFile] = READY('clear', 'r1', SESSION_ID)
      await engineClearsDuring($, d, release)
      d.world.clearHold = null
      expect(d.clearRuns).toHaveLength(1)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.clearRuns).toHaveLength(1)
      expect(d.world.clearsStarted).toBe(1)
      d.world.files[relayFile] = READY('clear', 'r2', SESSION_ID)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.clearRuns).toHaveLength(2)
    })
  })
}
