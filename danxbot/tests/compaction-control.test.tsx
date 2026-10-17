// DX-4993 (PLAN-42 rule R-4): the plugin's half of an operator session's compaction handshake, as pure rules (hooks/compaction/*) and as the engine runs the
// hooks: the agent's ready (a release in the control file the relay writes) makes the plugin run /compact itself at the next main-loop turn end, once; an automatic
// proposal is refused while the session is under the handshake; a manual /compact and the safety valve always pass; nothing is armed for the main agent (DX-5231);
// and the first turn after a compaction carries the resume briefing.
import { describe, expect } from 'claude-code/testing'

import { briefingText, parseGitStatus } from '../hooks/compaction/briefing'
import { HELD_REASON, USED_RELEASE_KEEP, USED_RELEASE_PREFIX, controlPath, parseControlFile, readyRelease, staleUsedReleaseKeys, usedReleaseKey, verdict } from '../hooks/compaction/control'
import type { ControlFile, GateControl, GateInput } from '../hooks/compaction/control'
import { CLOCK_START, EVENT_TEXT, HOME_DIR, OWN_SESSION, SURFACES, dashboard, startSession, test } from './plan-kit'

const CONTROL_FILE = `${HOME_DIR}/.config/danxbot/compaction/${OWN_SESSION.session_id}.json`
const NOW = Date.parse('2026-10-14T12:00:00.000Z')
const WINDOW = 1_000_000
// the pass-at size comes from the control file (50 Arms computes it); the plugin holds no margin of its own
const PASS_AT = 907_000

// DX-5222: the dashboard's per-model-line valves (the sub-agent with no entry is measured against its model's line) and the sub-agents' own controls
const VALVES = { haiku: 180_000, sonnet: 600_000, opus: 907_000 }
const gateControl = (over: Partial<GateControl> = {}): GateControl => ({ floorTokens: 250_000, passAtTokens: 907_000, windowTokens: WINDOW, releaseUntilMs: null, releaseId: null, agents: {}, valves: VALVES, ...over })
const fileText = (control: GateControl | null, askedAt: string | null = null, sessionId: string = OWN_SESSION.session_id): string => JSON.stringify({ v: 1, sessionId, control, askedAt })
const parse = (text: string | null): ControlFile => parseControlFile(text, OWN_SESSION.session_id)
const withControl = (over: Partial<GateControl> = {}): ControlFile => ({ kind: 'control', control: gateControl(over) })

describe('the control file (pure)', () => {
  test('is named for the session under the danxbot config, the relay writes it', () => {
    expect(controlPath('/home/u', 's1')).toBe('/home/u/.config/danxbot/compaction/s1.json')
  })

  test('a missing file is absent, a null control is a session the handshake does not hold, a control is read whole', () => {
    expect(parse(null)).toEqual({ kind: 'absent' })
    expect(parse(fileText(null))).toEqual({ kind: 'control', control: null })
    expect(parse(fileText(gateControl({ releaseUntilMs: 5, releaseId: 'r' })))).toEqual(withControl({ releaseUntilMs: 5, releaseId: 'r' }))
  })

  test('anything the relay would not have written is bad, with the reason', () => {
    expect(parse('not json')).toEqual({ kind: 'bad', reason: 'not JSON' })
    expect(parse('[]')).toEqual({ kind: 'bad', reason: 'not a compaction file' })
    expect(parse(JSON.stringify({ v: 2, sessionId: 'sess-own', control: null }))).toEqual({ kind: 'bad', reason: 'not a compaction file' })
    expect(parse(JSON.stringify({ v: 1, sessionId: 'sess-own' }))).toEqual({ kind: 'bad', reason: 'not a compaction file' })
    // a file of an older shape names no session
    expect(parse(JSON.stringify({ v: 1, control: null, askedAt: null }))).toEqual({ kind: 'bad', reason: 'not a compaction file' })
    // a leftover written for another session never arms this one
    expect(parse(fileText(gateControl(), null, 'sess-other'))).toEqual({ kind: 'bad', reason: 'written for another session' })
    expect(parse(fileText({ ...gateControl(), floorTokens: 1.5 }))).toEqual({ kind: 'bad', reason: 'floorTokens, passAtTokens and windowTokens must be whole numbers' })
    expect(parse(fileText({ ...gateControl(), windowTokens: undefined as any }))).toEqual({ kind: 'bad', reason: 'floorTokens, passAtTokens and windowTokens must be whole numbers' })
    expect(parse(fileText({ ...gateControl(), windowTokens: 907_000 }))).toEqual({ kind: 'bad', reason: 'windowTokens must be above passAtTokens' })
    expect(parse(fileText({ ...gateControl(), passAtTokens: 250_000 }))).toEqual({ kind: 'bad', reason: 'passAtTokens must be above floorTokens' })
    expect(parse(fileText({ ...gateControl(), releaseUntilMs: 5 }))).toEqual({ kind: 'bad', reason: 'releaseUntilMs and releaseId are both set or both null' })
    expect(parse(fileText({ ...gateControl(), releaseUntilMs: 'x' as any, releaseId: 'r' }))).toEqual({ kind: 'bad', reason: 'releaseUntilMs must be a number or null' })
    expect(parse(fileText({ ...gateControl(), releaseUntilMs: 5, releaseId: '' }))).toEqual({ kind: 'bad', reason: 'releaseId must be a string or null' })
  })
})

// The wire, relay to plugin: this literal is the file the relay writes for a released operator session (the relay's own test packages/danx-dashboard-mcp/__tests__/compaction-control.test.ts
// builds the same from the dashboard's frame, and danxbot's operator-session.test.ts feeds the dashboard's control through the relay). The plugin reads the pass-at size from it.
describe('the wire shape (pure)', () => {
  const RELAY_FILE = '{"v":1,"sessionId":"sess-own","control":{"floorTokens":250000,"passAtTokens":907000,"windowTokens":1000000,"releaseUntilMs":1800000000000,"releaseId":"2026-10-14T11:59:00.000Z","agents":{"a1":{"passAtTokens":600000,"ask":{"seq":1,"at":"2026-10-14T11:58:00.000Z","text":"Prepare."},"releaseUntilMs":null,"releaseId":null}},"valves":{"haiku":180000,"sonnet":600000,"opus":907000}},"askedAt":null}'

  test('the file the relay writes is read whole, and its pass-at size is the safety valve (the plugin has no margin of its own)', () => {
    const file = parse(RELAY_FILE)
    expect(file).toEqual({
      kind: 'control',
      control: {
        floorTokens: 250_000,
        passAtTokens: 907_000,
        windowTokens: 1_000_000,
        releaseUntilMs: 1_800_000_000_000,
        releaseId: '2026-10-14T11:59:00.000Z',
        agents: { a1: { passAtTokens: 600_000, ask: { seq: 1, at: '2026-10-14T11:58:00.000Z', text: 'Prepare.' }, releaseUntilMs: null, releaseId: null } },
        valves: VALVES,
      },
    })
    const input = { trigger: 'auto', window: WINDOW, file } as const
    expect(verdict({ ...input, tokens: 906_999 })).toEqual({ pass: false, reason: HELD_REASON })
    expect(verdict({ ...input, tokens: 907_000 })).toEqual({ pass: true, why: 'valve' })
    // a different pass-at size moves the valve: nothing else decides it
    const other = parse(RELAY_FILE.replace('907000', '500000'))
    expect(verdict({ ...input, file: other, tokens: 500_000 })).toEqual({ pass: true, why: 'valve' })
  })
})

describe('the release that starts a compaction (pure)', () => {
  const REL = '2026-10-14T11:59:00.000Z'
  const release = (over: Partial<GateControl> = {}) => withControl({ releaseUntilMs: NOW + 60_000, releaseId: REL, ...over })

  test('an unexpired release the plugin has not spent is waiting; a spent one, an expired one and no release are not', () => {
    expect(readyRelease(release(), null, NOW)).toBe(REL)
    expect(readyRelease(release(), REL, NOW)).toBeNull()
    expect(readyRelease(release({ releaseUntilMs: NOW }), null, NOW)).toBeNull()
    expect(readyRelease(release({ releaseUntilMs: NOW - 1 }), null, NOW)).toBeNull()
    expect(readyRelease(withControl(), null, NOW)).toBeNull()
  })

  test('a later release is a new one', () => {
    expect(readyRelease(release({ releaseId: 'newer' }), REL, NOW)).toBe('newer')
  })

  test('a session the handshake does not hold, or whose file cannot be read, has none', () => {
    expect(readyRelease({ kind: 'control', control: null }, null, NOW)).toBeNull()
    expect(readyRelease({ kind: 'absent' }, null, NOW)).toBeNull()
    expect(readyRelease({ kind: 'bad', reason: 'x' }, null, NOW)).toBeNull()
  })
})

describe('the gate (pure)', () => {
  const input = (over: Partial<GateInput> = {}): GateInput => ({
    trigger: 'auto',
    tokens: 300_000,
    window: WINDOW,
    file: withControl(),
    ...over,
  })

  test("a person's own /compact always passes, whatever else is true", () => {
    expect(verdict(input({ trigger: 'manual', file: { kind: 'bad', reason: 'x' }, tokens: null }))).toEqual({ pass: true, why: 'manual' })
  })

  test('anything that is not exactly auto is refused', () => {
    for (const trigger of [undefined, 'Auto', 'idle', 7]) {
      expect(verdict(input({ trigger }))).toEqual({ pass: false, reason: `${HELD_REASON} (unexpected PreCompact trigger ${JSON.stringify(trigger)})` })
    }
  })

  test("an automatic proposal under a control is held", () => {
    expect(verdict(input())).toEqual({ pass: false, reason: HELD_REASON })
  })

  test('a file with no control, or no file, holds nothing: there is no handshake to wait for', () => {
    expect(verdict(input({ file: { kind: 'control', control: null } }))).toEqual({ pass: true, why: 'no-control' })
    expect(verdict(input({ file: { kind: 'absent' }, tokens: null }))).toEqual({ pass: true, why: 'no-control' })
  })

  test("a release in the file releases no proposal: a ready agent is compacted by the plugin's own /compact", () => {
    expect(verdict(input({ file: withControl({ releaseUntilMs: NOW + 60_000, releaseId: 'r' }) }))).toEqual({ pass: false, reason: HELD_REASON })
  })

  test("the safety valve passes at the pass-at size the control names, whatever the session's window", () => {
    expect(verdict(input({ tokens: PASS_AT - 1 }))).toEqual({ pass: false, reason: HELD_REASON })
    expect(verdict(input({ tokens: PASS_AT }))).toEqual({ pass: true, why: 'valve' })
    expect(verdict(input({ tokens: 107_000, file: withControl({ passAtTokens: 107_000 }) }))).toEqual({ pass: true, why: 'valve' })
  })

  // A1: refusing with no way out ends the session, and the way out (the valve) lives in the file the gate could not read, so what it cannot establish passes
  test('what the gate cannot establish passes, never holds: an unknown size, an unreadable file', () => {
    expect(verdict(input({ tokens: null }))).toEqual({ pass: true, why: 'unknown-size' })
    expect(verdict(input({ file: { kind: 'bad', reason: 'not JSON' } }))).toEqual({ pass: true, why: 'unreadable' })
  })

  test('a window smaller than the control assumed holds nothing (the floor and the valve could never be reached); an unknown window still holds', () => {
    expect(verdict(input({ window: 200_000, tokens: 150_000 }))).toEqual({ pass: true, why: 'no-control' })
    expect(verdict(input({ window: null }))).toEqual({ pass: false, reason: HELD_REASON })
  })
})

describe('spent releases in the store (pure)', () => {
  test('the oldest sessions past the keep count are stale', () => {
    const entries = Array.from({ length: USED_RELEASE_KEEP + 2 }, (_, i) => ({ key: usedReleaseKey(`s${i}`), at: i }))
    expect(staleUsedReleaseKeys(entries)).toEqual([usedReleaseKey('s0'), usedReleaseKey('s1')])
    expect(staleUsedReleaseKeys(entries.slice(2))).toEqual([])
  })

  // DX-5222: a session's sub-agents' records belong to the session: its newer sub-agent records never evict its own older main record, and an old session goes whole
  test("a session's records stay and go together, so its sub-agents never evict its own main record", () => {
    const old = [{ key: usedReleaseKey('old'), at: 1 }, { key: usedReleaseKey('old', 'a1'), at: 2 }]
    const sessions = Array.from({ length: USED_RELEASE_KEEP - 1 }, (_, i) => ({ key: usedReleaseKey(`s${i}`), at: 100 + i }))
    const current = [{ key: usedReleaseKey('cur'), at: 50 }, ...Array.from({ length: 60 }, (_, i) => ({ key: usedReleaseKey('cur', `a${i}`), at: 1000 + i }))]
    expect(staleUsedReleaseKeys([...old, ...sessions, ...current])).toEqual(old.map(e => e.key))
  })
})

describe('the resume briefing (pure)', () => {
  test('parses git status: branch, changes, upstream and unpushed commits', () => {
    expect(parseGitStatus('## main...origin/main [ahead 2]\n M a.ts\n?? b.ts\n')).toEqual({ branch: 'main', changed: 2, upstream: 'origin/main', ahead: 2 })
    expect(parseGitStatus('## main...origin/main\n')).toEqual({ branch: 'main', changed: 0, upstream: 'origin/main', ahead: 0 })
    expect(parseGitStatus('## main...origin/main [ahead 1, behind 3]\n')).toMatchObject({ ahead: 1 })
    expect(parseGitStatus('## card/x\n M a.ts\n')).toEqual({ branch: 'card/x', changed: 1, upstream: null, ahead: null })
    expect(parseGitStatus('## HEAD (no branch)\n')).toMatchObject({ branch: null })
    expect(parseGitStatus('## No commits yet on main\n')).toMatchObject({ branch: null })
    expect(parseGitStatus('')).toBeNull()
    expect(parseGitStatus('fatal: not a git repository')).toBeNull()
  })

  const ok = <T,>(value: T) => ({ ok: true as const, value })
  const GIT = { branch: 'card/x', changed: 3, upstream: 'origin/card/x', ahead: 2 }

  test('names the plan, the cards in flight, the running sub-agents and the work not pushed', () => {
    const text = briefingText({
      plan: { ref: 'PLAN-23', name: 'The plugin' },
      cards: ok([{ id: 'DX-9', title: 'In flight card' }]),
      agents: ok([{ id: 'a1', type: 'danxbot:worker-sonnet-high', description: 'Build the thing' }]),
      git: ok(GIT),
    })
    expect(text).toContain('[50 ARMS] Your conversation was just compacted.')
    expect(text).toContain('Your plan is PLAN-23 The plugin.')
    expect(text).toContain('Cards in flight on your plan: DX-9 In flight card.')
    expect(text).toContain('Sub-agents still running (they carried on through the compaction): a1 (danxbot:worker-sonnet-high) Build the thing.')
    expect(text).toContain("Work not pushed, in the session's own checkout (branch card/x): 3 uncommitted paths, 2 unpushed commits.")
  })

  test('says what is empty and what could not be read, never an empty-looking line for either', () => {
    const text = briefingText({
      plan: null,
      cards: ok([]),
      agents: { ok: false, reason: 'the engine did not list this session\'s sub-agents' },
      git: { ok: false, reason: 'git status exited 128' },
    })
    expect(text).toContain('You are on no plan.')
    expect(text).toContain('Cards in flight: none on your plan.')
    expect(text).toContain("Sub-agents: not known (the engine did not list this session's sub-agents).")
    expect(text).toContain('Work not pushed: not known (git status exited 128).')
  })

  test('counts the rest past eight cards or agents, and words a clean checkout and a branch with no upstream', () => {
    const cards = Array.from({ length: 10 }, (_, i) => ({ id: `DX-${i + 1}`, title: `Card ${i + 1}` }))
    const text = briefingText({ plan: null, cards: ok(cards), agents: ok([]), git: ok({ branch: null, changed: 0, upstream: null, ahead: null }) })
    expect(text).toContain('DX-8 Card 8, and 2 more.')
    expect(text).toContain('Sub-agents running: none.')
    expect(text).toContain('(a detached checkout): no uncommitted changes, no upstream branch (nothing on it is pushed).')
    expect(briefingText({ plan: null, cards: ok([]), agents: ok([]), git: ok({ ...GIT, changed: 1, ahead: 1 }) })).toContain('1 uncommitted path, 1 unpushed commit.')
    expect(briefingText({ plan: null, cards: ok([]), agents: ok([]), git: ok({ ...GIT, changed: 0, ahead: 0 }) })).toContain('no uncommitted changes, nothing unpushed.')
  })
})

for (const surface of SURFACES) {
  describe(`the handshake on ${surface}`, () => {
    const PRE = (trigger: string, extra: Record<string, unknown> = {}) => ({ trigger, session_id: OWN_SESSION.session_id, transcript_path: '/work/main.jsonl', cwd: '/work', custom_instructions: null, ...extra }) as any

    async function started($: any, on: any, options: Parameters<typeof dashboard>[1] = {}) {
      on('turn.complete', () => ({ text: 'done' }) as any)
      on('classic.PreCompact', () => ({}) as any)
      const d = dashboard(on, options)
      d.world.context = { tokens: 120_000, window: WINDOW }
      await startSession($, d, surface)
      return d
    }
    const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
    const START = { prompt: 'go', turnId: 't1' } as any

    const READY = (id: string, ms: number = CLOCK_START + 60_000) => fileText(gateControl({ releaseUntilMs: ms, releaseId: id }))
    const compactRuns = (d: any) => d.compactRuns as unknown[]

    test('a session with no control file is not held and starts nothing', async ($, on) => {
      const d = await started($, on)
      await $.turn.start(START)
      await $.turn.complete(TURN)
      expect(compactRuns(d)).toEqual([])
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBeUndefined()
    })

    // DX-5231 / DX-5222: the main agent's compaction is started by the plugin's own /compact; the early-proposal percent is armed for the SUB-AGENTS (whose proposals are the only way they
    // compact), once, from the floor (compaction-agents.test.tsx has the rest)
    test('the plugin arms the sub-agents percent once, from the floor, however many turns follow', async ($, on) => {
      const d = await started($, on, { stateSteps: true })
      // this host runs session.compact (a session's first such event raises it: compaction-agents.test.tsx)
      d.seedState('sessionCompactSeen', true)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
      await $.turn.complete(TURN)
      await $.turn.start(START)
      expect(d.envSets).toEqual([{ name: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', value: '25' }])
    })

    test("the agent's ready starts /compact once, at the main loop's turn end, and not before", async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
      d.world.files[CONTROL_FILE] = READY('ready-1')
      // a turn's start is inside the session's work: nothing runs
      await $.turn.start(START)
      expect(compactRuns(d)).toEqual([])
      await $.turn.complete(TURN)
      // the plugin gives the command no arguments (the control carries no instructions)
      expect(compactRuns(d)).toHaveLength(1)
      expect(String(compactRuns(d)[0] ?? '').trim()).toBe('')
      expect(d.toasts).toContain('Compacting now: your agent said it is ready.')
      // the same release is spent: the dashboard's next write of the control still names it
      await $.turn.start(START)
      await $.turn.complete(TURN)
      expect(compactRuns(d)).toHaveLength(1)
      d.world.files[CONTROL_FILE] = READY('ready-2')
      await $.turn.complete(TURN)
      expect(compactRuns(d)).toHaveLength(2)
    })

    test("a sub-agent's turn end never starts the compaction", async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = READY('ready-1')
      await $.turn.complete({ ...TURN, agentId: 'a1' })
      expect(compactRuns(d)).toEqual([])
      await $.turn.complete(TURN)
      expect(compactRuns(d)).toHaveLength(1)
    })

    test('an expired release, or a session the handshake does not hold, starts nothing', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = READY('ready-1', CLOCK_START - 1)
      await $.turn.complete(TURN)
      d.world.files[CONTROL_FILE] = fileText(null)
      await $.turn.complete(TURN)
      expect(compactRuns(d)).toEqual([])
    })

    test('the start is kept in the plugin store with when it was spent, so it is not started again', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = READY('ready-1')
      await $.turn.complete(TURN)
      expect(d.stored.get(`${USED_RELEASE_PREFIX}${OWN_SESSION.session_id}`)).toEqual({ releaseId: 'ready-1', at: expect.any(Number) })
    })

    test("the store keeps the newest sessions' spent releases only", async ($, on) => {
      const d = await started($, on)
      for (let i = 0; i < USED_RELEASE_KEEP + 5; i++) d.stored.set(`${USED_RELEASE_PREFIX}old-${i}`, { releaseId: 'r', at: 100 + i })
      d.stored.set('relayCursor:not-ours', { planId: 1, cursor: 'c', at: 1 })
      d.world.files[CONTROL_FILE] = READY('ready-1')
      await $.turn.complete(TURN)
      const kept = [...d.stored.keys()].filter(k => k.startsWith(USED_RELEASE_PREFIX))
      expect(kept).toHaveLength(USED_RELEASE_KEEP)
      expect(kept).toContain(`${USED_RELEASE_PREFIX}${OWN_SESSION.session_id}`)
      expect(kept).not.toContain(`${USED_RELEASE_PREFIX}old-0`)
      expect(d.stored.has('relayCursor:not-ours')).toBe(true)
    })

    test('an automatic proposal is held while the session is under the handshake; a manual one (which the plugin runs too) passes', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBe(HELD_REASON)
      expect((await $.classic.PreCompact(PRE('manual'))).block).toBeUndefined()
    })

    test('a leftover file cannot hold a later session once the relay has pruned it', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBe(HELD_REASON)
      delete d.world.files[CONTROL_FILE]
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBeUndefined()
    })

    test('the safety valve passes an automatic proposal at the size where holding would end the session', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      d.world.context = { tokens: PASS_AT, window: WINDOW }
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBeUndefined()
      expect(d.toasts).toContain('Compacting now: the context reached the size where holding it would end the session.')
    })

    // A1: the only way out of a hold is the valve, and it lives in the control file; a gate that cannot read the file must not hold the session until it ends
    test('a control that cannot be read holds nothing and is told once; a gate that cannot establish the size holds nothing either', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBe(HELD_REASON)
      d.world.files[CONTROL_FILE] = 'not json'
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBeUndefined()
      await $.turn.complete(TURN)
      await $.turn.start(START)
      expect(d.toasts.filter(t => t.startsWith('Compaction control unreadable (not JSON)'))).toHaveLength(1)
      expect(compactRuns(d)).toEqual([])
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBe(HELD_REASON)
      d.world.context = { window: WINDOW }
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBeUndefined()
    })

    test('a read that throws holds nothing (a hook that throws also lets the compaction through, and the person is told once)', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      d.failUsage('the engine has no usage reading')
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBeUndefined()
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBeUndefined()
      expect(d.toasts.filter(t => t.startsWith("Compaction gate could not decide, so Claude Code's own automatic compaction applies"))).toHaveLength(1)
    })

    // B1: a leftover file written for another session holds nothing and starts nothing
    test('a file written for another session holds nothing and starts nothing', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl({ releaseUntilMs: CLOCK_START + 60_000, releaseId: 'r' }), null, 'sess-earlier')
      await $.turn.start(START)
      await $.turn.complete(TURN)
      expect(compactRuns(d)).toEqual([])
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBeUndefined()
      expect(d.toasts.some(t => t.startsWith('Compaction control unreadable (written for another session)'))).toBe(true)
    })

    // A2: the board's table lists the model line at 1M; this session runs it at 200k
    test('a session whose real window is smaller than the one the control assumed is never held', async ($, on) => {
      on('turn.complete', () => ({ text: 'done' }) as any)
      on('classic.PreCompact', () => ({}) as any)
      const d = dashboard(on)
      d.world.context = { tokens: 150_000, window: 200_000 }
      await startSession($, d, surface)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBeUndefined()
    })

    // DX-5217 / DX-5231: a process an older plugin version armed still holds CLAUDE_CODE_AUTO_COMPACT_WINDOW (the shrunken meter) or the percent after a plugin reload
    test('a window or percent variable left by an older plugin version is cleared while the session is under the handshake', async ($, on) => {
      const d = await started($, on, { autoCompactWindow: '400000', autocompactPct: '25', stateSteps: true })
      d.seedState('sessionCompactSeen', true)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
      await $.turn.complete(TURN)
      // the older plugin's window variable is taken back, and the percent it left is replaced by the one armed for the sub-agents (25 = 250,000 of 1,000,000)
      expect(d.envSets).toEqual([
        { name: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', value: undefined },
        { name: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', value: undefined },
        { name: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', value: '25' },
      ])
      expect(d.env('CLAUDE_CODE_AUTO_COMPACT_WINDOW')).toBeUndefined()
    })

    // DX-5231: the clear is once per process: a value set after it (the percent the sub-agents are armed with, or a person's) is never wiped by a later turn
    test('a leftover variable is cleared once per process: a value set after the first clear is never touched', async ($, on) => {
      const d = await started($, on, { autoCompactWindow: '400000', autocompactPct: '25', stateSteps: true })
      d.seedState('sessionCompactSeen', true)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
      await $.turn.complete(TURN)
      expect(d.envSets).toHaveLength(3)
      d.setEnv('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', '30')
      await $.turn.start(START)
      await $.turn.complete(TURN)
      await $.turn.start(START)
      expect(d.envSets).toHaveLength(3)
      expect(d.env('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')).toBe('30')
    })

    test("a person's own /compact answers a waiting ready: the plugin runs no second one at the turn's end", async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = READY('ready-1')
      await $.turn.start(START)
      expect((await $.classic.PreCompact(PRE('manual'))).block).toBeUndefined()
      await $.turn.complete(TURN)
      expect(compactRuns(d)).toEqual([])
      expect(d.stored.get(`${USED_RELEASE_PREFIX}${OWN_SESSION.session_id}`)).toMatchObject({ releaseId: 'ready-1' })
    })

    test('a failing /compact is told, never thrown', async ($, on) => {
      const d = await started($, on, { compactRunFails: 'the host refused' })
      d.world.files[CONTROL_FILE] = READY('ready-1')
      await $.turn.complete(TURN)
      // the run is detached from the hook: let it settle
      await d.clock.settle()
      expect(d.toasts.filter(t => t.startsWith('Compaction failed: '))).toHaveLength(1)
    })

    // DX-5231: the claim of a ready is one step: a tick landing between a start's check and its spend, or a person's own /compact there, must not start a second /compact
    test('an idle check that fires while the turn end is starting the compaction runs it exactly once', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
      d.world.files[CONTROL_FILE] = READY('ready-1', CLOCK_START + 120_000)
      d.beforeNextWrite('claimedRelease', () => d.clock.advance(5_000))
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(compactRuns(d)).toHaveLength(1)
    })

    test("a person's own /compact that lands while an idle check is starting the compaction runs it exactly once", async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
      await $.turn.complete(TURN)
      d.world.files[CONTROL_FILE] = READY('ready-1', CLOCK_START + 120_000)
      d.beforeNextWrite('claimedRelease', async () => {
        expect((await $.classic.PreCompact(PRE('manual'))).block).toBeUndefined()
      })
      await d.clock.advance(5_000)
      await d.clock.settle()
      expect(compactRuns(d)).toHaveLength(0)
      await $.turn.complete(TURN)
      expect(compactRuns(d)).toHaveLength(0)
    })

    // DX-5231: only a session under the handshake can be given a ready, so only it looks for one
    test('the idle check runs only while the session is under the handshake', async ($, on) => {
      const d = await started($, on)
      await $.turn.start(START)
      await $.turn.complete(TURN)
      d.world.files[CONTROL_FILE] = READY('ready-1', CLOCK_START + 600_000)
      await d.clock.advance(5_000)
      // no control file when the turn ended: the check was never armed
      expect(compactRuns(d)).toHaveLength(0)
      await $.turn.start(START)
      await $.turn.complete(TURN)
      expect(compactRuns(d)).toHaveLength(1)
      d.world.files[CONTROL_FILE] = READY('ready-2', CLOCK_START + 600_000)
      await d.clock.advance(5_000)
      expect(compactRuns(d)).toHaveLength(2)
      // the switch goes off: the next check finds no control and stops
      d.world.files[CONTROL_FILE] = fileText(null)
      await d.clock.advance(5_000)
      d.world.files[CONTROL_FILE] = READY('ready-3', CLOCK_START + 600_000)
      await d.clock.advance(20_000)
      expect(compactRuns(d)).toHaveLength(2)
    })

    // DX-5231: a plugin reload re-runs session.start with the process (and the idle check's timer) gone; a ready that lands after it must still be started
    test('a ready that lands after a plugin reload starts the compaction at the next idle check', async ($, on) => {
      on('turn.complete', () => ({ text: 'done' }) as any)
      on('classic.PreCompact', () => ({}) as any)
      const d = dashboard(on, {})
      d.world.context = { tokens: 120_000, window: WINDOW }
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await startSession($, d, surface)
      d.world.files[CONTROL_FILE] = READY('ready-1', CLOCK_START + 120_000)
      await d.clock.advance(5_000)
      expect(compactRuns(d)).toHaveLength(1)
    })

    // DX-5231: the relay writes the file after the agent's call returned, so a ready can land once the turn has ended; no turn.complete follows an idle session
    test('a ready that lands while no turn is running starts the compaction at the next idle check, and never while a turn runs', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
      await $.turn.complete(TURN)
      d.world.files[CONTROL_FILE] = READY('ready-1', CLOCK_START + 120_000)
      await d.clock.advance(5_000)
      expect(compactRuns(d)).toHaveLength(1)
      d.world.files[CONTROL_FILE] = READY('ready-2', CLOCK_START + 120_000)
      await $.turn.start(START)
      await d.clock.advance(10_000)
      expect(compactRuns(d)).toHaveLength(1)
      await $.turn.complete(TURN)
      expect(compactRuns(d)).toHaveLength(2)
    })

    test('a session with no control file keeps a variable it did not set', async ($, on) => {
      const d = await started($, on, { autoCompactWindow: '400000', autocompactPct: '25' })
      await $.turn.start(START)
      await $.turn.complete(TURN)
      expect(d.envSets).toEqual([])
    })

    test('a sub-agent proposal is held with the main session (it cannot be told apart, and the agent prepares for both)', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      expect((await $.classic.PreCompact(PRE('auto', { agent_id: 'a1' }))).block).toBe(HELD_REASON)
    })

    test('the first turn after a compaction carries the resume briefing beside the registry text', async ($, on) => {
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      on('classic.SessionStart', () => ({}) as any)
      const d = dashboard(on)
      d.world.agents = [
        { id: 'a1', type: 'danxbot:worker-sonnet-high', description: 'Build the thing', status: 'running' },
        { id: 'a2', type: 'Explore', description: 'Done already', status: 'completed' },
      ]
      d.world.gitStatus = { exitCode: 0, stdout: '## card/x...origin/card/x [ahead 2]\n M a.ts\n' }
      await startSession($, d, surface)
      await $.prompt.submit({ text: 'go' })
      await $.classic.SessionStart({ source: 'compact', cwd: '/work', session_id: OWN_SESSION.session_id })
      const tool = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
      const told = tool.context!.slice(1)
      expect(told).toHaveLength(1)
      const [registry, briefing] = told[0]!.split('\n')
      expect(registry).toBe(EVENT_TEXT('after_compaction'))
      expect(briefing).toContain('[50 ARMS] Your conversation was just compacted.')
      expect(briefing).toContain('Sub-agents still running (they carried on through the compaction): a1 (danxbot:worker-sonnet-high) Build the thing.')
      expect(briefing).not.toContain('a2')
      expect(briefing).toContain('(branch card/x): 1 uncommitted path, 2 unpushed commits.')
      // told once
      expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)).context).toHaveLength(1)
    })

    test('a briefing source that fails is named in the briefing and takes nothing else with it', async ($, on) => {
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      on('classic.SessionStart', () => ({}) as any)
      const d = dashboard(on)
      d.world.gitStatus = { exitCode: 128, stdout: '' }
      await startSession($, d, surface)
      await $.prompt.submit({ text: 'go' })
      await $.classic.SessionStart({ source: 'compact', cwd: '/work', session_id: OWN_SESSION.session_id })
      const told = (await $.tool.call({ tool: 'Bash', command: 'ls' } as any)).context!.slice(1)[0]!
      expect(told).toContain('Work not pushed: not known (git status exited 128).')
      expect(told).toContain('Sub-agents running: none.')
    })

    test('a startup or resume carries no briefing', async ($, on) => {
      on('classic.SessionStart', () => ({}) as any)
      const d = dashboard(on)
      await startSession($, d, surface)
      const first = await $.prompt.submit({ text: 'go', source: 'startup' } as any)
      expect(first.context!.join('\n')).not.toContain('Your conversation was just compacted')
    })
  })
}
