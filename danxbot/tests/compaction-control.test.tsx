// DX-4993 (PLAN-42 rule R-4): the plugin's half of an operator session's compaction handshake, as pure rules (hooks/compaction/*) and as the engine runs the
// hooks: the window is armed from the control file the relay writes, an automatic compaction is refused until the agent said ready, a person's own
// /compact and the safety valve always pass, a release is honoured once, and the first turn after a compaction carries the resume briefing.
import { describe, expect } from 'claude-code/testing'

import { briefingText, parseGitStatus } from '../hooks/compaction/briefing'
import { HELD_REASON, USED_RELEASE_KEEP, USED_RELEASE_PREFIX, arming, controlPath, parseControlFile, staleUsedReleaseKeys, verdict } from '../hooks/compaction/control'
import type { ControlFile, GateControl, GateInput } from '../hooks/compaction/control'
import { CLOCK_START, EVENT_TEXT, HOME_DIR, OWN_SESSION, SURFACES, dashboard, startSession, test } from './plan-kit'

const CONTROL_FILE = `${HOME_DIR}/.config/danxbot/compaction/${OWN_SESSION.session_id}.json`
const NOW = Date.parse('2026-10-14T12:00:00.000Z')
const WINDOW = 1_000_000
// the pass-at size comes from the control file (50 Arms computes it); the plugin holds no margin of its own
const PASS_AT = 907_000

const gateControl = (over: Partial<GateControl> = {}): GateControl => ({ floorTokens: 250_000, passAtTokens: 907_000, releaseUntilMs: null, releaseId: null, ...over })
const fileText = (control: GateControl | null, askedAt: string | null = null): string => JSON.stringify({ v: 1, control, askedAt })
const withControl = (over: Partial<GateControl> = {}): ControlFile => ({ kind: 'control', control: gateControl(over) })

describe('the control file (pure)', () => {
  test('is named for the session under the danxbot config, the relay writes it', () => {
    expect(controlPath('/home/u', 's1')).toBe('/home/u/.config/danxbot/compaction/s1.json')
  })

  test('a missing file is absent, a null control is a session the handshake does not hold, a control is read whole', () => {
    expect(parseControlFile(null)).toEqual({ kind: 'absent' })
    expect(parseControlFile(fileText(null))).toEqual({ kind: 'control', control: null })
    expect(parseControlFile(fileText(gateControl({ releaseUntilMs: 5, releaseId: 'r' })))).toEqual(withControl({ releaseUntilMs: 5, releaseId: 'r' }))
  })

  test('anything the relay would not have written is bad, with the reason', () => {
    expect(parseControlFile('not json')).toEqual({ kind: 'bad', reason: 'not JSON' })
    expect(parseControlFile('[]')).toEqual({ kind: 'bad', reason: 'not a compaction file' })
    expect(parseControlFile(JSON.stringify({ v: 2, control: null }))).toEqual({ kind: 'bad', reason: 'not a compaction file' })
    expect(parseControlFile(JSON.stringify({ v: 1 }))).toEqual({ kind: 'bad', reason: 'not a compaction file' })
    expect(parseControlFile(fileText({ ...gateControl(), floorTokens: 1.5 }))).toEqual({ kind: 'bad', reason: 'floorTokens and passAtTokens must be whole numbers' })
    expect(parseControlFile(fileText({ ...gateControl(), passAtTokens: 250_000 }))).toEqual({ kind: 'bad', reason: 'passAtTokens must be above floorTokens' })
    expect(parseControlFile(fileText({ ...gateControl(), releaseUntilMs: 5 }))).toEqual({ kind: 'bad', reason: 'releaseUntilMs and releaseId are both set or both null' })
    expect(parseControlFile(fileText({ ...gateControl(), releaseUntilMs: 'x' as any, releaseId: 'r' }))).toEqual({ kind: 'bad', reason: 'releaseUntilMs must be a number or null' })
    expect(parseControlFile(fileText({ ...gateControl(), releaseUntilMs: 5, releaseId: '' }))).toEqual({ kind: 'bad', reason: 'releaseId must be a string or null' })
  })
})

// The wire, relay to plugin: this literal is the file the relay writes for a released operator session (the relay's own test packages/danx-dashboard-mcp/__tests__/compaction-control.test.ts
// builds the same from the dashboard's frame, and danxbot's operator-session.test.ts feeds the dashboard's control through the relay). The plugin reads the pass-at size from it.
describe('the wire shape (pure)', () => {
  const RELAY_FILE = '{"v":1,"control":{"floorTokens":250000,"passAtTokens":907000,"releaseUntilMs":1800000000000,"releaseId":"2026-10-14T11:59:00.000Z"},"askedAt":null}'

  test('the file the relay writes is read whole, and its pass-at size is the safety valve (the plugin has no margin of its own)', () => {
    const file = parseControlFile(RELAY_FILE)
    expect(file).toEqual({ kind: 'control', control: { floorTokens: 250_000, passAtTokens: 907_000, releaseUntilMs: 1_800_000_000_000, releaseId: '2026-10-14T11:59:00.000Z' } })
    const input = { trigger: 'auto', armed: true, file, usedReleaseId: '2026-10-14T11:59:00.000Z', nowMs: 1_800_000_000_001 } as const
    expect(verdict({ ...input, tokens: 906_999 })).toEqual({ pass: false, reason: HELD_REASON })
    expect(verdict({ ...input, tokens: 907_000 })).toEqual({ pass: true, why: 'valve' })
    // a different pass-at size moves the valve: nothing else decides it
    const other = parseControlFile(RELAY_FILE.replace('907000', '500000'))
    expect(verdict({ ...input, file: other, tokens: 500_000 })).toEqual({ pass: true, why: 'valve' })
  })
})

describe('arming the window (pure)', () => {
  test('a control is set at its floor; a null control or a file that is gone takes the window back; an unreadable file changes nothing', () => {
    expect(arming(withControl())).toEqual({ kind: 'set', floorTokens: 250_000 })
    expect(arming({ kind: 'control', control: null })).toEqual({ kind: 'unset' })
    expect(arming({ kind: 'absent' })).toEqual({ kind: 'unset' })
    expect(arming({ kind: 'bad', reason: 'x' })).toEqual({ kind: 'keep' })
  })
})

describe('the gate (pure)', () => {
  const input = (over: Partial<GateInput> = {}): GateInput => ({
    trigger: 'auto',
    armed: true,
    tokens: 300_000,
    file: withControl(),
    usedReleaseId: null,
    nowMs: NOW,
    ...over,
  })
  const release = (over: Partial<GateControl> = {}) => withControl({ releaseUntilMs: NOW + 60_000, releaseId: '2026-10-14T11:59:00.000Z', ...over })

  test("a person's own /compact always passes, whatever else is true", () => {
    expect(verdict(input({ trigger: 'manual', file: { kind: 'bad', reason: 'x' }, tokens: null }))).toEqual({ pass: true, why: 'manual' })
  })

  test('anything that is not exactly auto is refused', () => {
    for (const trigger of [undefined, 'Auto', 'idle', 7]) {
      expect(verdict(input({ trigger }))).toEqual({ pass: false, reason: `${HELD_REASON} (unexpected PreCompact trigger ${JSON.stringify(trigger)})` })
    }
  })

  test('a session the plugin did not arm is not held', () => {
    expect(verdict(input({ armed: false, file: { kind: 'absent' }, tokens: null }))).toEqual({ pass: true, why: 'not-armed' })
  })

  test('without the agent\'s ready an automatic proposal is held', () => {
    expect(verdict(input())).toEqual({ pass: false, reason: HELD_REASON })
  })

  test('a file with no control, or no file, holds nothing: there is no handshake to wait for', () => {
    expect(verdict(input({ file: { kind: 'control', control: null } }))).toEqual({ pass: true, why: 'no-control' })
    expect(verdict(input({ file: { kind: 'absent' }, tokens: null }))).toEqual({ pass: true, why: 'no-control' })
  })

  test('an unexpired release lets ONE proposal through, and a spent or expired one lets none', () => {
    expect(verdict(input({ file: release() }))).toEqual({ pass: true, why: 'released', spend: '2026-10-14T11:59:00.000Z' })
    expect(verdict(input({ file: release(), usedReleaseId: '2026-10-14T11:59:00.000Z' }))).toEqual({ pass: false, reason: HELD_REASON })
    expect(verdict(input({ file: release({ releaseUntilMs: NOW }) }))).toEqual({ pass: false, reason: HELD_REASON })
    expect(verdict(input({ file: release({ releaseUntilMs: NOW - 1 }) }))).toEqual({ pass: false, reason: HELD_REASON })
    // a later release is a new one
    expect(verdict(input({ file: release({ releaseId: 'newer' }), usedReleaseId: '2026-10-14T11:59:00.000Z' }))).toMatchObject({ pass: true, spend: 'newer' })
  })

  test("the safety valve passes at the pass-at size the control names, whatever the session's window", () => {
    expect(verdict(input({ tokens: PASS_AT - 1 }))).toEqual({ pass: false, reason: HELD_REASON })
    expect(verdict(input({ tokens: PASS_AT }))).toEqual({ pass: true, why: 'valve' })
    expect(verdict(input({ tokens: 107_000, file: withControl({ passAtTokens: 107_000 }) }))).toEqual({ pass: true, why: 'valve' })
  })

  test('what the gate cannot establish is refused, never passed: an unknown size, an unreadable file', () => {
    expect(verdict(input({ tokens: null }))).toEqual({ pass: false, reason: `${HELD_REASON} (the context size is not known)` })
    expect(verdict(input({ file: { kind: 'bad', reason: 'not JSON' } }))).toEqual({ pass: false, reason: `${HELD_REASON} (not JSON)` })
  })
})

describe('spent releases in the store (pure)', () => {
  test('the oldest past the keep count are stale', () => {
    const entries = Array.from({ length: USED_RELEASE_KEEP + 2 }, (_, i) => ({ key: `k${i}`, at: i }))
    expect(staleUsedReleaseKeys(entries)).toEqual(['k1', 'k0'])
    expect(staleUsedReleaseKeys(entries.slice(2))).toEqual([])
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
    const windowSets = (d: any) => d.envSets.filter((s: any) => s.name === 'CLAUDE_CODE_AUTO_COMPACT_WINDOW')

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

    test('a session with no control file is not armed, and nothing is held', async ($, on) => {
      const d = await started($, on)
      await $.turn.start(START)
      expect(windowSets(d)).toEqual([])
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBeUndefined()
    })

    test('the window is set to the floor at the start of a turn, once however many turns follow', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
      await $.turn.complete(TURN)
      await $.turn.start(START)
      expect(windowSets(d)).toEqual([{ name: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', value: '250000' }])
    })

    test('a leftover file cannot arm a later session once the relay has pruned it: the window is taken back and nothing is held', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBe(HELD_REASON)
      delete d.world.files[CONTROL_FILE]
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBeUndefined()
      await $.turn.complete(TURN)
      expect(windowSets(d)).toEqual([{ name: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', value: '250000' }, { name: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', value: undefined }])
    })

    test('an armed session holds an automatic proposal, and lets its own /compact through', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBe(HELD_REASON)
      expect((await $.classic.PreCompact(PRE('manual'))).block).toBeUndefined()
    })

    test('the agent\'s ready lets one automatic compaction through, then holds again until the next ready', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
      const now = CLOCK_START
      d.world.files[CONTROL_FILE] = fileText(gateControl({ releaseUntilMs: now + 60_000, releaseId: 'ready-1' }))
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBeUndefined()
      expect(d.toasts).toContain('Compacting now: your agent said it is ready.')
      // the same release is spent: the dashboard's next write of the control still names it
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBe(HELD_REASON)
      d.world.files[CONTROL_FILE] = fileText(gateControl({ releaseUntilMs: now + 60_000, releaseId: 'ready-2' }))
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBeUndefined()
    })

    test('a spent release is kept in the plugin store, with when it was spent, so it is not honoured again', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
      d.world.files[CONTROL_FILE] = fileText(gateControl({ releaseUntilMs: CLOCK_START + 60_000, releaseId: 'ready-1' }))
      await $.classic.PreCompact(PRE('auto'))
      expect(d.stored.get(`${USED_RELEASE_PREFIX}${OWN_SESSION.session_id}`)).toEqual({ releaseId: 'ready-1', at: expect.any(Number) })
    })

    test("the store keeps the newest sessions' spent releases only", async ($, on) => {
      const d = await started($, on)
      for (let i = 0; i < USED_RELEASE_KEEP + 5; i++) d.stored.set(`${USED_RELEASE_PREFIX}old-${i}`, { releaseId: 'r', at: 100 + i })
      d.stored.set('relayCursor:not-ours', { planId: 1, cursor: 'c', at: 1 })
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
      d.world.files[CONTROL_FILE] = fileText(gateControl({ releaseUntilMs: CLOCK_START + 60_000, releaseId: 'ready-1' }))
      await $.classic.PreCompact(PRE('auto'))
      const kept = [...d.stored.keys()].filter(k => k.startsWith(USED_RELEASE_PREFIX))
      expect(kept).toHaveLength(USED_RELEASE_KEEP)
      expect(kept).toContain(`${USED_RELEASE_PREFIX}${OWN_SESSION.session_id}`)
      expect(kept).not.toContain(`${USED_RELEASE_PREFIX}old-0`)
      expect(d.stored.has('relayCursor:not-ours')).toBe(true)
    })

    test('the safety valve passes an automatic proposal at the size where holding would end the session', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
      d.world.context = { tokens: PASS_AT, window: WINDOW }
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBeUndefined()
      expect(d.toasts).toContain('Compacting now: the context reached the size where holding it would end the session.')
    })

    test('a control that cannot be read holds the armed session and is told once; a gate that cannot establish the size holds too', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
      d.world.files[CONTROL_FILE] = 'not json'
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBe(`${HELD_REASON} (not JSON)`)
      await $.turn.complete(TURN)
      await $.turn.start(START)
      expect(d.toasts.filter(t => t.startsWith('Compaction control unreadable (not JSON)'))).toHaveLength(1)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      d.world.context = {}
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBe(`${HELD_REASON} (the context size is not known)`)
    })

    test('a read that throws is a refusal, never a pass (a hook that throws lets the compaction through)', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
      d.failUsage('the engine has no usage reading')
      const r = await $.classic.PreCompact(PRE('auto'))
      expect(r.block).toContain(`${HELD_REASON} (the gate failed closed:`)
    })

    test('the switch going off takes the window back, and the session is held no more', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
      d.world.files[CONTROL_FILE] = fileText(null)
      await $.turn.complete(TURN)
      expect(windowSets(d)).toEqual([{ name: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', value: '250000' }, { name: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', value: undefined }])
      expect((await $.classic.PreCompact(PRE('auto'))).block).toBeUndefined()
    })

    test('a session the plugin never armed never takes a window back', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(null)
      await $.turn.start(START)
      expect(windowSets(d)).toEqual([])
    })

    test('a sub-agent proposal is held with the main session (it cannot be told apart, and the agent prepares for both)', async ($, on) => {
      const d = await started($, on)
      d.world.files[CONTROL_FILE] = fileText(gateControl())
      await $.turn.start(START)
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
