// DX-5222 (PLAN-42 section 141): an operator session's compaction handshake per SUB-AGENT. The pure rules (control.ts: the agents and valves of the control file, the percent,
// the per-agent verdict) and the engine wiring (register.tsx): `session.compact` names the proposing `agentId`, `turn.step` tells the plugin each sub-agent's context, `$.session.send`
// delivers each sub-agent's request, and the sub-agents' early-proposal percent is armed after `leftoverArmingCleared`. The main agent's own gate is compaction-control.test.tsx.
import { describe, expect } from 'claude-code/testing'

import { AGENT_HELD_REASON, AGENT_SIZES_KEEP, ASK_SENT_PREFIX, HELD_REASON, USED_RELEASE_KEEP, agentVerdict, armedPercentOf, askSentKey, floorPercent, modelLineOf, parseControlFile, sizeOfUsage, usedReleaseKey, verdict } from '../hooks/compaction/control'
import type { AgentControl, AgentGateInput, ControlFile, GateControl, LineValves } from '../hooks/compaction/control'
import { CLOCK_START, HOME_DIR, OWN_SESSION, SURFACES, dashboard, startSession, test } from './plan-kit'

const CONTROL_FILE = `${HOME_DIR}/.config/danxbot/compaction/${OWN_SESSION.session_id}.json`
const NOW = Date.parse('2026-10-14T12:00:00.000Z')
const WINDOW = 1_000_000
const VALVES = { haiku: 180_000, sonnet: 600_000, opus: 907_000 }
const ASK = { seq: 2, at: '2026-10-14T11:58:00.000Z', text: 'Prepare for compaction, then say ready.' }
// what core answers a compaction that ran (a compaction leaves at least one message)
const COMPACTED = { messages: [{ role: 'user', text: 'the summary', toolUses: [] }] }
// the transcript a proposal runs over (a compaction needs at least one message)
const TRANSCRIPT = [{ role: 'user', text: 'go', toolUses: [], handle: 'm1' }]
const entry = (over: Partial<AgentControl> = {}): AgentControl => ({ passAtTokens: 600_000, ask: null, releaseUntilMs: null, releaseId: null, ...over })
// DX-5314: the file's control as the relay writes it (`agents` and `valves` beside the main fields); the parsed GateControl groups the two as `subagents`
type WireControl = Omit<GateControl, 'subagents'> & { agents?: Record<string, AgentControl>; valves?: LineValves }
const gateControl = (over: Partial<WireControl> = {}): WireControl => ({ floorTokens: 250_000, passAtTokens: 907_000, windowTokens: WINDOW, releaseUntilMs: null, releaseId: null, agents: {}, valves: VALVES, ...over })
const fileText = (control: WireControl | null): string => JSON.stringify({ v: 1, sessionId: OWN_SESSION.session_id, control, askedAt: null })
const parse = (text: string | null): ControlFile => parseControlFile(text, OWN_SESSION.session_id)
const withControl = (over: Partial<WireControl> = {}): ControlFile => {
  const { agents, valves, ...main } = gateControl(over)
  return { kind: 'control', control: { ...main, subagents: { agents: agents!, valves: valves! } } }
}

describe('sub-agents in the control file (pure)', () => {
  const bad = (control: unknown, reason: string) => expect(parse(JSON.stringify({ v: 1, sessionId: OWN_SESSION.session_id, control, askedAt: null }))).toEqual({ kind: 'bad', reason })

  test('every sub-agent entry and every line valve is read whole', () => {
    const agents = { a1: entry({ ask: ASK }), a2: entry({ releaseUntilMs: 9, releaseId: 'r' }) }
    expect(parse(fileText(gateControl({ agents })))).toEqual(withControl({ agents }))
    expect(parse(fileText(gateControl({ valves: {} })))).toEqual(withControl({ valves: {} }))
  })

  // DX-5314: a field the relay did not write is a relay older than the plugin (main handshake kept, sub-agent control off); a field it wrote wrongly is corruption
  test('a file with no agents or no valves keeps the main control and has no sub-agent control; a malformed one is bad', () => {
    const { agents: _a, valves: _v, ...main } = gateControl()
    const mainControl = (text: string) => (parse(text) as any).control
    expect(mainControl(JSON.stringify({ v: 1, sessionId: OWN_SESSION.session_id, control: { ...main }, askedAt: null }))).toEqual({ ...main, subagents: null })
    expect(mainControl(JSON.stringify({ v: 1, sessionId: OWN_SESSION.session_id, control: { ...main, agents: {} }, askedAt: null })).subagents).toBeNull()
    expect(mainControl(JSON.stringify({ v: 1, sessionId: OWN_SESSION.session_id, control: { ...main, valves: VALVES }, askedAt: null })).subagents).toBeNull()
    bad({ ...gateControl(), agents: [] }, 'agents must be an object keyed by agent id')
    bad({ ...gateControl(), agents: null }, 'agents must be an object keyed by agent id')
    bad({ ...gateControl(), valves: null }, 'valves must be an object keyed by model line')
    bad({ ...main, valves: 'x' }, 'valves must be an object keyed by model line')
  })

  test('anything the relay would not have written for a sub-agent or a valve is bad, with the reason', () => {
    bad({ ...gateControl(), agents: { '': entry() } }, 'agents has an empty agent id')
    bad({ ...gateControl(), agents: { a1: 3 } }, 'agents.a1 is not an object')
    bad({ ...gateControl(), agents: { a1: { ...entry(), passAtTokens: 1.5 } } }, 'agents.a1.passAtTokens must be a whole number')
    bad({ ...gateControl(), agents: { a1: { ...entry(), ask: { seq: 1, at: '', text: 'x' } } } }, 'agents.a1.ask must be null or {seq, at, text}')
    bad({ ...gateControl(), agents: { a1: { ...entry(), ask: { seq: 1, at: 'x', text: ' ' } } } }, 'agents.a1.ask must be null or {seq, at, text}')
    bad({ ...gateControl(), agents: { a1: { ...entry(), ask: undefined } } }, 'agents.a1.ask must be null or {seq, at, text}')
    bad({ ...gateControl(), agents: { a1: entry({ releaseUntilMs: 5 }) } }, 'agents.a1: releaseUntilMs and releaseId are both set or both null')
    bad({ ...gateControl(), agents: { a1: { ...entry(), releaseUntilMs: 'x', releaseId: 'r' } } }, 'agents.a1: releaseUntilMs must be a number or null')
    bad({ ...gateControl(), valves: { gpt: 5 } }, 'valves names "gpt", which is not a model line')
    bad({ ...gateControl(), valves: { opus: 0 } }, 'valves.opus must be a positive whole number')
    bad({ ...gateControl(), valves: { opus: 1.5 } }, 'valves.opus must be a positive whole number')
  })

  test('a model id is in the line its name carries, and no other', () => {
    expect(modelLineOf('claude-opus-4-8')).toBe('opus')
    expect(modelLineOf('claude-haiku-5-5')).toBe('haiku')
    expect(modelLineOf('claude-sonnet-5-5')).toBe('sonnet')
    expect(modelLineOf('claude-fable-1-0')).toBe('fable')
    expect(modelLineOf('gpt-5')).toBeNull()
    expect(modelLineOf('claude-opus')).toBeNull()
    expect(modelLineOf(undefined)).toBeNull()
  })

  test('the context size is the whole prompt of the last response; a response that reported nothing says nothing', () => {
    expect(sizeOfUsage({ input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, model: 'claude-opus-4-8' })).toEqual({ tokens: 240, model: 'claude-opus-4-8' })
    expect(sizeOfUsage({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-4-8' })).toBeNull()
  })

  // DX-5217: the percent is the floor as a share of the window, rounded DOWN to two decimals (danxbot's floorPercent)
  test('the armed percent is the floor as a share of the window, floored to two decimals, and none without a handshake', () => {
    expect(floorPercent(250_000, 1_000_000)).toBe(25)
    expect(floorPercent(333_333, 1_000_000)).toBe(33.33)
    expect(floorPercent(100_001, 3_000_000)).toBe(3.33)
    // rounding to the nearest would give 33.34 and 66.67: the percent is never above the floor
    expect(floorPercent(333_336, 1_000_000)).toBe(33.33)
    expect(floorPercent(333_350, 1_000_000)).toBe(33.33)
    expect(floorPercent(666_667, 1_000_000)).toBe(66.66)
    expect(armedPercentOf(withControl())).toBe(25)
    expect(armedPercentOf({ kind: 'control', control: null })).toBeNull()
    expect(armedPercentOf({ kind: 'absent' })).toBeNull()
    expect(armedPercentOf({ kind: 'bad', reason: 'x' })).toBeNull()
  })

  test('each key of a store record is its own: the main agent, a sub-agent, and a delivered request', () => {
    expect(usedReleaseKey('s1')).toBe('compaction-used-release:s1')
    expect(usedReleaseKey('s1', 'a1')).toBe('compaction-used-release:s1:a1')
    expect(askSentKey('s1', 'a1')).toBe('compaction-ask-sent:s1:a1')
  })
})

// One automatic proposal of a sub-agent. Its valve and its release are its own: a main-agent release never passes a sub-agent and a sub-agent's never passes the main agent.
describe('the sub-agent gate (pure)', () => {
  const OPUS = { tokens: 300_000, model: 'claude-opus-4-8' }
  const withAgent = (a: Partial<AgentControl>, over: Partial<WireControl> = {}): ControlFile => withControl({ agents: { a1: entry(a) }, ...over })
  const ask = (over: Partial<AgentGateInput> = {}): AgentGateInput => ({ agentId: 'a1', file: withAgent({}), size: OPUS, usedReleaseId: null, nowMs: NOW, ...over })

  test('a sub-agent under its valve with no release is held, and not told', () => {
    expect(agentVerdict(ask())).toEqual({ pass: false, reason: AGENT_HELD_REASON, told: false })
  })

  test("a sub-agent passes at its OWN valve, whatever the main agent's valve is", () => {
    expect(agentVerdict(ask({ size: { ...OPUS, tokens: 600_000 } }))).toEqual({ pass: true, why: 'valve' })
    expect(agentVerdict(ask({ size: { ...OPUS, tokens: 599_999 } }))).toMatchObject({ pass: false })
    // the main valve (907,000) is far above: it does not decide a sub-agent
    expect(agentVerdict(ask({ file: withAgent({ passAtTokens: 400_000 }), size: { ...OPUS, tokens: 400_000 } }))).toEqual({ pass: true, why: 'valve' })
  })

  test("a sub-agent's unexpired release passes it; a spent, expired or other agent's release does not", () => {
    const released = (over: Partial<AgentControl> = {}) => ask({ file: withAgent({ releaseUntilMs: NOW + 60_000, releaseId: 'ra', ...over }) })
    expect(agentVerdict(released())).toEqual({ pass: true, why: 'release', releaseId: 'ra' })
    expect(agentVerdict({ ...released(), usedReleaseId: 'ra' })).toMatchObject({ pass: false })
    expect(agentVerdict({ ...released(), usedReleaseId: 'older' })).toEqual({ pass: true, why: 'release', releaseId: 'ra' })
    expect(agentVerdict(released({ releaseUntilMs: NOW }))).toMatchObject({ pass: false })
    expect(agentVerdict(released({ releaseUntilMs: NOW - 1 }))).toMatchObject({ pass: false })
    // another sub-agent has no entry here, and a release in a1's entry is not its
    expect(agentVerdict({ ...released(), agentId: 'a2' })).toMatchObject({ pass: false })
  })

  test("the main agent's release never passes a sub-agent, whether the control has an entry for it or not", () => {
    const file = withAgent({}, { releaseUntilMs: NOW + 60_000, releaseId: 'main-release' })
    expect(agentVerdict(ask({ file }))).toEqual({ pass: false, reason: AGENT_HELD_REASON, told: false })
    // a sub-agent with no entry is measured against its line's valve only; the main agent's unexpired release is not its release
    expect(agentVerdict(ask({ file, agentId: 'ghost' }))).toEqual({ pass: false, reason: AGENT_HELD_REASON, told: false })
    expect(agentVerdict(ask({ file, agentId: 'ghost', usedReleaseId: 'older' }))).toEqual({ pass: false, reason: AGENT_HELD_REASON, told: false })
  })

  test('a precompute is judged like an automatic proposal: held under the valve, through at it', () => {
    const precompute = (tokens: number) => verdict({ trigger: 'precompute', tokens, window: WINDOW, file: withControl() })
    expect(precompute(300_000)).toEqual({ pass: false, reason: HELD_REASON })
    expect(precompute(907_000)).toEqual({ pass: true, why: 'valve' })
    expect(verdict({ trigger: 'precompute', tokens: 300_000, window: WINDOW, file: { kind: 'bad', reason: 'x' } })).toEqual({ pass: true, why: 'unreadable' })
  })

  test('a session with no control, or a file the gate cannot read, holds no sub-agent (fail open, like the main agent)', () => {
    expect(agentVerdict(ask({ file: { kind: 'control', control: null } }))).toEqual({ pass: true, why: 'no-control' })
    expect(agentVerdict(ask({ file: { kind: 'absent' }, size: null }))).toEqual({ pass: true, why: 'no-control' })
    expect(agentVerdict(ask({ file: { kind: 'bad', reason: 'x' }, size: null }))).toEqual({ pass: true, why: 'unreadable' })
  })

  test('a context size the plugin never saw is refused and told, never guessed', () => {
    expect(agentVerdict(ask({ size: null }))).toEqual({ pass: false, reason: `${AGENT_HELD_REASON} (sub-agent a1: its context size is not known)`, told: true })
  })

  describe('a sub-agent with no entry is measured against the valve of its own model line', () => {
    const noEntry = (size: AgentGateInput['size']) => ask({ agentId: 'ghost', size })

    test("it passes at its line's valve, and is held under it", () => {
      expect(agentVerdict(noEntry({ tokens: 180_000, model: 'claude-haiku-5-5' }))).toEqual({ pass: true, why: 'valve' })
      expect(agentVerdict(noEntry({ tokens: 179_999, model: 'claude-haiku-5-5' }))).toEqual({ pass: false, reason: AGENT_HELD_REASON, told: false })
      // the same size on a bigger line is under that line's valve
      expect(agentVerdict(noEntry({ tokens: 180_000, model: 'claude-opus-4-8' }))).toMatchObject({ pass: false })
      expect(agentVerdict(noEntry({ tokens: 907_000, model: 'claude-opus-4-8' }))).toEqual({ pass: true, why: 'valve' })
    })

    test('a model in no line, or a line with no valve, is refused and told: no guessed model, no default valve', () => {
      expect(agentVerdict(noEntry({ tokens: 900_000, model: 'gpt-5' }))).toEqual({
        pass: false,
        reason: `${AGENT_HELD_REASON} (sub-agent ghost: it has no compaction control yet and its model "gpt-5" is in no model line)`,
        told: true,
      })
      expect(agentVerdict(noEntry({ tokens: 900_000, model: 'claude-fable-1-0' }))).toEqual({
        pass: false,
        reason: `${AGENT_HELD_REASON} (sub-agent ghost: it has no compaction control yet and the control has no valve for the fable line)`,
        told: true,
      })
    })

    test('an entry decides, not the line: a sub-agent with an entry ignores the valves', () => {
      expect(agentVerdict(ask({ size: { tokens: 180_000, model: 'claude-haiku-5-5' } }))).toMatchObject({ pass: false, told: false })
    })
  })
})

for (const surface of SURFACES) {
  describe(`the sub-agent handshake on ${surface}`, () => {
    const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
    const START = { prompt: 'go', turnId: 't1' } as any
    const PRE = (trigger: string) => ({ trigger, session_id: OWN_SESSION.session_id, transcript_path: '/work/main.jsonl', cwd: '/work', custom_instructions: null }) as any
    const AGENT_TURN_USAGE = (tokens: number, model = 'claude-opus-4-8') => ({ input_tokens: 1, output_tokens: 5, cache_read_input_tokens: tokens - 1, cache_creation_input_tokens: 0, model })

    // The engine's core under the plugin: a `session.compact` that reaches it runs the classic PreCompact hooks (the plugin's classic gate among them), and a block is a skip.
    async function started($: any, on: any, options: Parameters<typeof dashboard>[1] = {}) {
      const core: { agentId: string | undefined; skipped: string | undefined }[] = []
      const step = { usage: null as unknown }
      on('turn.complete', () => ({ text: 'done' }) as any)
      on('classic.PreCompact', () => ({}) as any)
      on('session.compact', async (_$: any, e: any) => {
        // the classic hook's trigger is only manual or auto: a precompute (the same compaction computed ahead) runs no PreCompact
        const classic = e.trigger === 'precompute' ? {} : await $.classic.PreCompact({ trigger: e.trigger, custom_instructions: null })
        core.push({ agentId: e.agentId, skipped: classic.block })
        return (classic.block === undefined ? COMPACTED : { skip: classic.block }) as any
      })
      on('turn.step', async function* (_$: any, e: any) {
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: step.usage }
      } as any)
      const d = dashboard(on, options)
      d.world.context = { tokens: 120_000, window: WINDOW }
      await startSession($, d, surface)
      return {
        d,
        core,
        // one model request of `agentId` (the main loop with none), answered with `usage`
        async request(agentId: string | undefined, usage: unknown) {
          step.usage = usage
          const stream = $.turn.step({ turnId: 't9', index: 0, model: 'claude-opus-4-8', messageCount: 4, ...(agentId === undefined ? {} : { agentId }) })
          for (;;) {
            const next = await stream.next()
            if (next.done) return next.value
          }
        },
        // Claude Code's own automatic proposal (or, with `trigger`, a precompute) of `agentId` (the main agent with none)
        propose: (agentId?: string, trigger = 'auto') => $.session.compact({ trigger, messages: TRANSCRIPT, ...(agentId === undefined ? {} : { agentId }) }),
        // a compaction event of any trigger: this host runs session.compact (a person's own /compact is the cheapest)
        see: () => $.session.compact({ trigger: 'manual', messages: TRANSCRIPT }),
      }
    }
    const running = (d: any, ...ids: string[]) => void (d.world.agents = ids.map(id => ({ id, type: 'danxbot:worker-sonnet-high', description: `agent ${id}`, status: 'running' })))

    describe('the gate on session.compact', () => {
      test('the main agent keeps its own verdict: held under its valve, through at it; the proposal never reaches core while held', async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl())
        expect(await k.propose()).toEqual({ skip: HELD_REASON })
        expect(k.core).toEqual([])
        k.d.world.context = { tokens: 907_000, window: WINDOW }
        expect(await k.propose()).toEqual(COMPACTED)
        expect(k.core).toEqual([{ agentId: undefined, skipped: undefined }])
      })

      test("a sub-agent's proposal is judged on ITS context: held under its valve, through at it, and the classic gate does not hold what the per-agent gate passed", async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry() } }))
        await k.request('a1', AGENT_TURN_USAGE(300_000))
        expect(await k.propose('a1')).toEqual({ skip: AGENT_HELD_REASON })
        expect(k.core).toEqual([])
        await k.request('a1', AGENT_TURN_USAGE(600_000))
        // the main agent's size is far under its own valve and the classic gate cannot name an agent: the proposal still passes
        expect(await k.propose('a1')).toEqual(COMPACTED)
        expect(k.core).toEqual([{ agentId: 'a1', skipped: undefined }])
        expect(k.d.toasts).toContain('Compacting sub-agent a1 now: its context reached the size where holding it would end its work.')
      })

      test('the size is the LAST response of that sub-agent: after it compacted and shrank, the next proposal is held', async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry() } }))
        await k.request('a1', AGENT_TURN_USAGE(650_000))
        expect(await k.propose('a1')).toEqual(COMPACTED)
        await k.request('a1', AGENT_TURN_USAGE(40_000))
        expect(await k.propose('a1')).toEqual({ skip: AGENT_HELD_REASON })
      })

      test("each sub-agent's size is its own", async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry(), a2: entry() } }))
        await k.request('a1', AGENT_TURN_USAGE(700_000))
        await k.request('a2', AGENT_TURN_USAGE(100_000))
        expect(await k.propose('a2')).toEqual({ skip: AGENT_HELD_REASON })
        expect(await k.propose('a1')).toEqual(COMPACTED)
      })

      test("the model's response reaches the engine exactly as the model gave it, for a sub-agent's request and the main loop's", async ($, on) => {
        const k = await started($, on)
        for (const agentId of ['a1', undefined]) {
          const usage = AGENT_TURN_USAGE(300_000)
          const got = await k.request(agentId, usage)
          expect(got).toEqual({ turnId: 't9', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage })
        }
      })

      // the main loop's every streamed request would otherwise take a slot: AGENT_SIZES_KEEP sub-agents are kept, the oldest goes first, and a main-loop request is none of them
      test("only a sub-agent's request is noted: a main-loop request takes no slot, and the oldest sub-agent goes at AGENT_SIZES_KEEP", async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl())
        for (let i = 0; i < AGENT_SIZES_KEEP; i++) await k.request(`s${i}`, AGENT_TURN_USAGE(300_000))
        await k.request(undefined, AGENT_TURN_USAGE(900_000))
        expect((await k.propose('s0')).skip).toBe(AGENT_HELD_REASON)
        await k.request('one-more', AGENT_TURN_USAGE(300_000))
        expect((await k.propose('s0')).skip).toContain('its context size is not known')
        expect((await k.propose('s1')).skip).toBe(AGENT_HELD_REASON)
      })

      // eviction goes by recency of the last note, not by when an agent first appeared
      test('a sub-agent that responds again is the newest: the least recently heard one goes at AGENT_SIZES_KEEP, not the first to appear', async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl())
        for (let i = 0; i < AGENT_SIZES_KEEP; i++) await k.request(`s${i}`, AGENT_TURN_USAGE(300_000))
        await k.request('s0', AGENT_TURN_USAGE(310_000))
        await k.request('one-more', AGENT_TURN_USAGE(300_000))
        expect((await k.propose('s0')).skip).toBe(AGENT_HELD_REASON)
        expect((await k.propose('s1')).skip).toContain('its context size is not known')
      })

      test("a sub-agent's release passes ONCE, is spent for that sub-agent only, and a new release passes again", async ($, on) => {
        const k = await started($, on)
        const release = (id: string) => fileText(gateControl({ agents: { a1: entry({ releaseUntilMs: CLOCK_START + 60_000, releaseId: id }), a2: entry({ releaseUntilMs: CLOCK_START + 60_000, releaseId: id }) } }))
        k.d.world.files[CONTROL_FILE] = release('r1')
        await k.request('a1', AGENT_TURN_USAGE(300_000))
        await k.request('a2', AGENT_TURN_USAGE(300_000))
        expect(await k.propose('a1')).toEqual(COMPACTED)
        expect(k.d.stored.get(usedReleaseKey(OWN_SESSION.session_id, 'a1'))).toEqual({ releaseId: 'r1', at: expect.any(Number) })
        // the dashboard writes the same release again: spent
        expect(await k.propose('a1')).toEqual({ skip: AGENT_HELD_REASON })
        // a2's release is its own, though it has the same id
        expect(await k.propose('a2')).toEqual(COMPACTED)
        k.d.world.files[CONTROL_FILE] = release('r2')
        expect(await k.propose('a1')).toEqual(COMPACTED)
        expect(k.d.toasts).toContain('Compacting sub-agent a1 now: it said it is ready.')
      })

      test("the main agent's release never passes a sub-agent and a sub-agent's release never passes the main agent", async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ releaseUntilMs: CLOCK_START + 60_000, releaseId: 'main-r', agents: { a1: entry() } }))
        await k.request('a1', AGENT_TURN_USAGE(300_000))
        expect(await k.propose('a1')).toEqual({ skip: AGENT_HELD_REASON })
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry({ releaseUntilMs: CLOCK_START + 60_000, releaseId: 'a1-r' }) } }))
        expect(await k.propose()).toEqual({ skip: HELD_REASON })
        expect(k.core).toEqual([])
      })

      test("a manual /compact is not this gate's: it is not matched, and the classic gate lets it through", async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry() } }))
        expect(await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })).toEqual(COMPACTED)
        expect(k.core).toEqual([{ agentId: undefined, skipped: undefined }])
      })

      // once the host has run session.compact the classic gate waves automatic proposals through; a manual one must still reach its branch and spend the waiting ready
      test("a manual /compact on a host that has run session.compact still spends a waiting ready, so the plugin runs no second compaction", async ($, on) => {
        const k = await started($, on)
        await k.see()
        k.d.world.files[CONTROL_FILE] = fileText(gateControl())
        await $.turn.start(START)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ releaseUntilMs: CLOCK_START + 60_000, releaseId: 'r1' }))
        expect(await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })).toEqual(COMPACTED)
        await $.turn.complete(TURN)
        expect(k.d.compactRuns).toEqual([])
      })

      test("a precompute is judged per agent like an automatic proposal, and spends no release or announcement: the compaction that follows is the one that does", async ($, on) => {
        const k = await started($, on)
        const release = { releaseUntilMs: CLOCK_START + 60_000, releaseId: 'r1' }
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry(release), a2: entry() } }))
        await k.request('a1', AGENT_TURN_USAGE(300_000))
        await k.request('a2', AGENT_TURN_USAGE(300_000))
        // held for the agent with no release, through for the one whose release is waiting, and the main agent under its valve is held
        expect(await k.propose('a2', 'precompute')).toEqual({ skip: AGENT_HELD_REASON })
        expect(await k.propose('a1', 'precompute')).toEqual(COMPACTED)
        expect(await k.propose(undefined, 'precompute')).toEqual({ skip: HELD_REASON })
        expect(k.d.stored.has(usedReleaseKey(OWN_SESSION.session_id, 'a1'))).toBe(false)
        expect(k.d.toasts.filter(t => t.startsWith('Compacting'))).toEqual([])
        // the release is still a1's for the automatic proposal that follows
        expect(await k.propose('a1')).toEqual(COMPACTED)
        expect(k.d.stored.has(usedReleaseKey(OWN_SESSION.session_id, 'a1'))).toBe(true)
        // at the main valve a precompute passes with no announcement
        k.d.world.context = { tokens: 907_000, window: WINDOW }
        expect(await k.propose(undefined, 'precompute')).toEqual(COMPACTED)
        expect(k.d.toasts.filter(t => t.startsWith('Compacting now'))).toEqual([])
      })

      test('a sub-agent with no entry passes at the valve of its own model line, read from its own responses', async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl())
        await k.request('h1', AGENT_TURN_USAGE(179_999, 'claude-haiku-5-5'))
        expect(await k.propose('h1')).toEqual({ skip: AGENT_HELD_REASON })
        await k.request('h1', AGENT_TURN_USAGE(180_000, 'claude-haiku-5-5'))
        expect(await k.propose('h1')).toEqual(COMPACTED)
        // the same size on another line is under that line's valve
        await k.request('o1', AGENT_TURN_USAGE(180_000, 'claude-opus-4-8'))
        expect(await k.propose('o1')).toEqual({ skip: AGENT_HELD_REASON })
      })

      test('a sub-agent with no entry and an unknown model, no valve for its line or no size is refused and told once, never guessed', async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl())
        await k.request('x1', AGENT_TURN_USAGE(900_000, 'gpt-5'))
        await k.request('f1', AGENT_TURN_USAGE(900_000, 'claude-fable-1-0'))
        for (let i = 0; i < 3; i++) {
          expect((await k.propose('x1')).skip).toContain('is in no model line')
          expect((await k.propose('f1')).skip).toContain('no valve for the fable line')
          expect((await k.propose('never-seen')).skip).toContain('its context size is not known')
        }
        expect(k.d.toasts.filter(t => t.startsWith(AGENT_HELD_REASON))).toHaveLength(3)
        expect(k.core).toEqual([])
      })

      test('a session with no control, and one whose control file cannot be read, hold no sub-agent and the person is told once of the second', async ($, on) => {
        const k = await started($, on)
        expect(await k.propose('a1')).toEqual(COMPACTED)
        k.d.world.files[CONTROL_FILE] = fileText(null)
        expect(await k.propose('a1')).toEqual(COMPACTED)
        k.d.world.files[CONTROL_FILE] = 'not json'
        expect(await k.propose('a1')).toEqual(COMPACTED)
        expect(await k.propose('a1')).toEqual(COMPACTED)
        expect(k.core).toHaveLength(4)
        // the gate holds nothing; the person hears of the unreadable file once, from the syncs of the main loop
        await $.turn.start(START)
        await $.turn.complete(TURN)
        await $.turn.start(START)
        expect(k.d.toasts.filter(t => t.startsWith('Compaction control unreadable (not JSON)'))).toHaveLength(1)
      })

      test('a gate that cannot decide for a sub-agent holds nothing and tells the person once (fail open)', async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry() } }))
        await k.request('a1', AGENT_TURN_USAGE(300_000))
        expect(await k.propose('a1')).toEqual({ skip: AGENT_HELD_REASON })
        k.d.world.fsError = 'the disk is gone'
        expect(await k.propose('a1')).toEqual(COMPACTED)
        expect(await k.propose('a1')).toEqual(COMPACTED)
        expect(k.d.toasts.filter(t => t.startsWith('Compaction gate could not decide for sub-agent a1, so Claude Code\'s own automatic compaction applies'))).toHaveLength(1)
        expect(k.core).toHaveLength(2)
      })

      test('the classic gate alone (a host that has run no session.compact) holds every automatic proposal like the main agent', async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry() } }))
        expect((await $.classic.PreCompact(PRE('auto'))).block).toBe(HELD_REASON)
        expect((await $.classic.PreCompact(PRE('manual'))).block).toBeUndefined()
      })

      test('once the host has run session.compact the classic gate leaves automatic proposals to it, including an isolated sub-agent the per-agent gate never sees', async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry() } }))
        expect((await $.classic.PreCompact(PRE('auto'))).block).toBe(HELD_REASON)
        await k.see()
        // a proposal that skips session.compact (an isolated delegatedObservation sub-agent, a model whose window source is auto, the in-process runner) reaches only the classic hook,
        // whose input never names the agent in 2.1.299: it passes there
        expect((await $.classic.PreCompact(PRE('auto'))).block).toBeUndefined()
        // the main agent's own proposal still goes through session.compact, where it is held
        expect(await k.propose()).toEqual({ skip: HELD_REASON })
        expect(k.core).toEqual([{ agentId: undefined, skipped: undefined }])
      })
    })

    describe("delivering each sub-agent's request", () => {
      test("a request reaches only that sub-agent, once per ask.at, as the dashboard worded it; the main agent never gets one", async ($, on) => {
        const k = await started($, on)
        running(k.d, 'a1', 'a2')
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry({ ask: ASK }), a2: entry() } }))
        await $.turn.start(START)
        expect(k.d.sends).toHaveLength(1)
        expect(k.d.sends[0].to).toContain('a1')
        expect(k.d.sends[0].text).toBe(ASK.text)
        // the same request, however many syncs follow, is not sent again
        await $.turn.complete(TURN)
        await $.turn.start(START)
        await $.turn.complete(TURN)
        expect(k.d.sends).toHaveLength(1)
        expect(k.d.stored.get(askSentKey(OWN_SESSION.session_id, 'a1'))).toEqual({ at: ASK.at, sentAt: expect.any(Number) })
        // a later request (a new `at`) is a new one
        const later = { ...ASK, seq: 3, at: '2026-10-14T12:30:00.000Z', text: 'Prepare again.' }
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry({ ask: later }), a2: entry() } }))
        await $.turn.start(START)
        expect(k.d.sends.map(s => s.text)).toEqual([ASK.text, 'Prepare again.'])
        expect(k.d.sends.every(s => s.to.includes('a1'))).toBe(true)
      })

      test('a request is delivered while the main turn is running, at the idle check, not only at a turn boundary', async ($, on) => {
        const k = await started($, on)
        running(k.d, 'a1')
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry() } }))
        await $.turn.start(START)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry({ ask: ASK }) } }))
        await k.d.clock.advance(5_000)
        expect(k.d.sends).toHaveLength(1)
        await $.turn.complete(TURN)
      })

      test('a failed send is not recorded and is sent again at the next sync, and the person hears of it once', async ($, on) => {
        const k = await started($, on)
        running(k.d, 'a1')
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry({ ask: ASK }) } }))
        for (const mode of ['refused', 'throws'] as const) {
          k.d.setSendMode(mode)
          await $.turn.start(START)
          await $.turn.complete(TURN)
        }
        expect(k.d.sends).toHaveLength(4)
        expect(k.d.stored.has(askSentKey(OWN_SESSION.session_id, 'a1'))).toBe(false)
        expect(k.d.toasts.filter(t => t.startsWith('Compaction request for sub-agent a1 was not delivered'))).toHaveLength(2)
        k.d.setSendMode('delivered')
        await $.turn.start(START)
        expect(k.d.sends).toHaveLength(5)
        expect(k.d.stored.has(askSentKey(OWN_SESSION.session_id, 'a1'))).toBe(true)
        await $.turn.complete(TURN)
        expect(k.d.sends).toHaveLength(5)
      })

      // a1's send is still in the host's hands while a second sync finds a2's send failing: a2's claim goes back and a1's stays, so a third sync does not send a1 again
      test("a failed send gives back only its own claim: another sub-agent's send in flight is not sent twice", async ($, on) => {
        const k = await started($, on)
        running(k.d, 'a1', 'a2')
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry({ ask: ASK }), a2: entry({ ask: ASK }) } }))
        k.d.failSendsTo('a2')
        const hold = k.d.holdSends()
        const first = $.turn.start(START)
        await hold.reached
        const sentTo = (id: string) => k.d.sends.filter(s => String(s.to).includes(id)).length
        expect(sentTo('a1')).toBe(1)
        await $.turn.complete(TURN)
        await $.turn.start(START)
        expect(sentTo('a1')).toBe(1)
        // a2's claim was given back each time, so each sync tried it again
        expect(sentTo('a2')).toBeGreaterThan(1)
        hold.release()
        await first
        expect(sentTo('a1')).toBe(1)
        expect(k.d.stored.has(askSentKey(OWN_SESSION.session_id, 'a1'))).toBe(true)
        expect(k.d.stored.has(askSentKey(OWN_SESSION.session_id, 'a2'))).toBe(false)
      })

      test('only a running sub-agent is sent to: a finished one would be resumed by the message', async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry({ ask: ASK }) } }))
        k.d.world.agents = [{ id: 'a1', type: 'danxbot:worker-sonnet-high', description: 'agent a1', status: 'completed' }] as any
        await $.turn.start(START)
        expect(k.d.sends).toEqual([])
        running(k.d, 'a1')
        await $.turn.complete(TURN)
        expect(k.d.sends).toHaveLength(1)
      })

      test('a request to a finished sub-agent is not sent while another sub-agent runs', async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry({ ask: ASK }), a2: entry({ ask: ASK }) } }))
        k.d.world.agents = [
          { id: 'a1', type: 'danxbot:worker-sonnet-high', description: 'agent a1', status: 'completed' },
          { id: 'a2', type: 'danxbot:worker-sonnet-high', description: 'agent a2', status: 'running' },
        ] as any
        await $.turn.start(START)
        await $.turn.complete(TURN)
        expect(k.d.sends.map(s => s.to)).toHaveLength(1)
        expect(k.d.sends[0].to).toContain('a2')
        expect(k.d.stored.has(askSentKey(OWN_SESSION.session_id, 'a1'))).toBe(false)
      })

      // the first sync is in the middle of its send (the host has not answered) when a second one reads the same request as unsent
      test('two syncs racing each other send a request once', async ($, on) => {
        const k = await started($, on)
        running(k.d, 'a1')
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry({ ask: ASK }) } }))
        const hold = k.d.holdSends()
        const first = $.turn.start(START)
        await hold.reached
        await $.turn.complete(TURN)
        expect(k.d.sends).toHaveLength(1)
        hold.release()
        await first
        expect(k.d.sends).toHaveLength(1)
        expect(k.d.stored.has(askSentKey(OWN_SESSION.session_id, 'a1'))).toBe(true)
      })

      test("the store keeps the newest sessions' delivered requests only", async ($, on) => {
        const k = await started($, on)
        running(k.d, 'a1')
        for (let i = 0; i < USED_RELEASE_KEEP + 5; i++) k.d.stored.set(`${ASK_SENT_PREFIX}old-${i}:a1`, { at: 'x', sentAt: 100 + i })
        k.d.stored.set('relayCursor:not-ours', { planId: 1, cursor: 'c', at: 1 })
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { a1: entry({ ask: ASK }) } }))
        await $.turn.start(START)
        const kept = [...k.d.stored.keys()].filter(key => key.startsWith(ASK_SENT_PREFIX))
        expect(kept).toHaveLength(USED_RELEASE_KEEP)
        expect(kept).toContain(askSentKey(OWN_SESSION.session_id, 'a1'))
        expect(kept).not.toContain(`${ASK_SENT_PREFIX}old-0:a1`)
        expect(k.d.stored.has('relayCursor:not-ours')).toBe(true)
      })

      test('a session with no handshake, or an unreadable file, sends nothing', async ($, on) => {
        const k = await started($, on)
        running(k.d, 'a1')
        await $.turn.start(START)
        k.d.world.files[CONTROL_FILE] = fileText(null)
        await $.turn.complete(TURN)
        k.d.world.files[CONTROL_FILE] = 'not json'
        await $.turn.start(START)
        expect(k.d.sends).toEqual([])
      })
    })

    describe("arming the sub-agents' early proposal", () => {
      const PCT = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'

      test('nothing is armed until the host has run session.compact: a host without it is never armed', async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl())
        await $.turn.start(START)
        await $.turn.complete(TURN)
        await k.d.clock.advance(5_000)
        expect(k.d.envSets).toEqual([])
        expect(k.d.env(PCT)).toBeUndefined()
        // the host's first session.compact event of any trigger arms it at the next sync
        await k.see()
        await $.turn.start(START)
        expect(k.d.envSets).toEqual([{ name: PCT, value: '25' }])
        // leftoverArmingCleared was true before the percent was first set, so the once-per-process clear cannot wipe the value
        expect(k.d.envClearedAtSet).toEqual([true])
        // the clear never ran again: later turns leave the value alone
        await $.turn.complete(TURN)
        await $.turn.start(START)
        expect(k.d.env(PCT)).toBe('25')
        expect(k.d.envSets).toHaveLength(1)
      })

      test('a percent an older plugin version left is replaced, after the flag, by the value armed now', async ($, on) => {
        const k = await started($, on, { autocompactPct: '40', autoCompactWindow: '400000' })
        await k.see()
        k.d.world.files[CONTROL_FILE] = fileText(gateControl())
        await $.turn.start(START)
        expect(k.d.env(PCT)).toBe('25')
        expect(k.d.env('CLAUDE_CODE_AUTO_COMPACT_WINDOW')).toBeUndefined()
        expect(k.d.envClearedAtSet.at(-1)).toBe(true)
      })

      test('the percent follows the floor, and is taken back when the handshake ends or the file cannot be read', async ($, on) => {
        const k = await started($, on)
        await k.see()
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ floorTokens: 333_333 }))
        await $.turn.start(START)
        expect(k.d.env(PCT)).toBe('33.33')
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ floorTokens: 400_000 }))
        await $.turn.complete(TURN)
        expect(k.d.env(PCT)).toBe('40')
        k.d.world.files[CONTROL_FILE] = fileText(null)
        await $.turn.start(START)
        expect(k.d.env(PCT)).toBeUndefined()
        k.d.world.files[CONTROL_FILE] = fileText(gateControl())
        await $.turn.complete(TURN)
        expect(k.d.env(PCT)).toBe('25')
        k.d.world.files[CONTROL_FILE] = 'not json'
        await $.turn.start(START)
        expect(k.d.env(PCT)).toBeUndefined()
      })

      test('a session with no control file arms nothing and keeps a variable it did not set', async ($, on) => {
        const k = await started($, on, { autocompactPct: '25' })
        await $.turn.start(START)
        await $.turn.complete(TURN)
        expect(k.d.envSets).toEqual([])
        expect(k.d.env(PCT)).toBe('25')
      })
    })

    // DX-5314: a plugin hot-loaded beside an older relay: the file has no `agents`/`valves`, the sub-agent features are off, and the main handshake is untouched
    describe('beside a relay older than the plugin', () => {
      const PCT = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'
      const { agents: _a, valves: _v, ...MAIN } = gateControl()
      const OLDER = JSON.stringify({ v: 1, sessionId: OWN_SESSION.session_id, control: MAIN, askedAt: null })

      test("a sub-agent's proposal is refused and told once, and the main agent keeps its own gate", async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = OLDER
        await k.request('a1', AGENT_TURN_USAGE(900_000))
        const first = await k.propose('a1')
        expect(first.skip).toContain('the dashboard MCP relay is older than this plugin, so sub-agent compaction is off')
        expect((await k.propose('a1')).skip).toBe(first.skip)
        expect(k.d.toasts.filter(t => t === first.skip)).toHaveLength(1)
        expect(k.core).toEqual([])
        expect(await k.propose()).toEqual({ skip: HELD_REASON })
        k.d.world.context = { tokens: 907_000, window: WINDOW }
        expect(await k.propose()).toEqual(COMPACTED)
      })

      test('nothing is armed, and a percent armed under a whole file is taken back', async ($, on) => {
        const k = await started($, on)
        await k.see()
        k.d.world.files[CONTROL_FILE] = OLDER
        await $.turn.start(START)
        expect(k.d.envSets).toEqual([])
        k.d.world.files[CONTROL_FILE] = fileText(gateControl())
        await $.turn.complete(TURN)
        expect(k.d.env(PCT)).toBe('25')
        k.d.world.files[CONTROL_FILE] = OLDER
        await $.turn.start(START)
        expect(k.d.env(PCT)).toBeUndefined()
      })

      test('no request is delivered to a running sub-agent', async ($, on) => {
        const k = await started($, on)
        running(k.d, 'a1')
        k.d.world.files[CONTROL_FILE] = OLDER
        await $.turn.start(START)
        await $.turn.complete(TURN)
        expect(k.d.sends).toEqual([])
      })
    })
  })
}
