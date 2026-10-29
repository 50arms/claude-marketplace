import "./run-tests-with-npm-test.generated"
// DX-5222 (PLAN-42 section 141): an operator session's compaction handshake per SUB-AGENT. The pure rules (control.ts: the agents and valves of the control file, the percent,
// the per-agent verdict) and the engine wiring (register.tsx): `session.compact` names the proposing `agentId`, `turn.step` tells the plugin each sub-agent's context, the sub-agents' early-proposal percent is armed after `leftoverArmingCleared`. The main agent's own gate is compaction-control.test.tsx.
import { describe, expect } from 'claude-code/testing'

import { AGENT_FAULT_TOLD_KEEP, AGENT_HELD_REASON, AGENT_SIZES_KEEP, ENGINE_VERSION_NOTICE, HELD_REASON, agentVerdict, armedPercentOf, floorPercent, parseControlFile, sizeOfUsage, usedReleaseKey, verdict } from '../hooks/compaction/control'
import type { AgentControl, AgentGateInput, ControlFile, GateControl, ModelValves } from '../hooks/compaction/control'
import { CLOCK_START, HOME_DIR, OWN_SESSION, SURFACES, dashboard, startSession, test } from './plan-kit'

const CONTROL_FILE = `${HOME_DIR}/.config/danxbot/compaction/${OWN_SESSION.session_id}.json`
const NOW = Date.parse('2026-10-14T12:00:00.000Z')
const WINDOW = 1_000_000
const VALVES = { 'claude-haiku-5-5': 180_000, 'claude-sonnet-5-5': 600_000, 'claude-opus-4-8': 907_000 }
// what core answers a compaction that ran (a compaction leaves at least one message)
const COMPACTED = { messages: [{ role: 'user', text: 'the summary', toolUses: [] }] }
// the transcript a proposal runs over (a compaction needs at least one message)
const TRANSCRIPT = [{ role: 'user', text: 'go', toolUses: [], handle: 'm1' }]
const entry = (over: Partial<AgentControl> = {}): AgentControl => ({ passAtTokens: 600_000, ...over })
// DX-5314: the file's control as the relay writes it (`agents` and `valves` beside the main fields); the parsed GateControl groups the two as `subagents`
type WireControl = Omit<GateControl, 'subagents'> & { agents?: Record<string, AgentControl>; valves?: ModelValves }
const gateControl = (over: Partial<WireControl> = {}): WireControl => ({ floorTokens: 250_000, passAtTokens: 907_000, windowTokens: WINDOW, releaseUntilMs: null, releaseId: null, agents: {}, valves: VALVES, ...over })
const fileText = (control: WireControl | null): string => JSON.stringify({ v: 1, sessionId: OWN_SESSION.session_id, control, askedAt: null })
const parse = (text: string | null): ControlFile => parseControlFile(text, OWN_SESSION.session_id)
const withControl = (over: Partial<WireControl> = {}): ControlFile => {
  const { agents, valves, ...main } = gateControl(over)
  return { kind: 'control', control: { ...main, subagents: { agents: agents!, valves: valves! } } }
}

describe('sub-agents in the control file (pure)', () => {
  const bad = (control: unknown, reason: string) => expect(parse(JSON.stringify({ v: 1, sessionId: OWN_SESSION.session_id, control, askedAt: null }))).toEqual({ kind: 'bad', reason })

  test('every sub-agent entry is read as its safety valve and every line valve whole; a key the relay does not write is ignored', () => {
    const agents = { a1: entry(), a2: entry({ passAtTokens: 400_000 }) }
    expect(parse(fileText(gateControl({ agents })))).toEqual(withControl({ agents }))
    expect(parse(fileText(gateControl({ valves: {} })))).toEqual(withControl({ valves: {} }))
    expect(parse(fileText(gateControl({ agents: { a1: { passAtTokens: 600_000, ask: { seq: 1, at: 'x', text: 'y' }, releaseUntilMs: 9, releaseId: 'r' } as any } })))).toEqual(withControl({ agents: { a1: entry() } }))
  })

  // DX-5314: a field the relay did not write is a relay older than the plugin (main handshake kept, sub-agent control off); a field it wrote wrongly is corruption
  test('a file with no agents or no valves keeps the main control and has no sub-agent control; a malformed one is bad', () => {
    const { agents: _a, valves: _v, ...main } = gateControl()
    const mainControl = (text: string) => (parse(text) as any).control
    expect(mainControl(JSON.stringify({ v: 1, sessionId: OWN_SESSION.session_id, control: { ...main }, askedAt: null }))).toEqual({ ...main, subagents: null })
    expect(mainControl(JSON.stringify({ v: 1, sessionId: OWN_SESSION.session_id, control: { ...main, agents: {} }, askedAt: null })).subagents).toBeNull()
    expect(mainControl(JSON.stringify({ v: 1, sessionId: OWN_SESSION.session_id, control: { ...main, valves: VALVES }, askedAt: null })).subagents).toBeNull()
    bad({ ...main, agents: 'x', valves: {} }, 'agents must be an object keyed by agent id')
    bad({ ...gateControl(), agents: [] }, 'agents must be an object keyed by agent id')
    bad({ ...gateControl(), agents: null }, 'agents must be an object keyed by agent id')
    bad({ ...gateControl(), valves: null }, 'valves must be an object keyed by model id')
    bad({ ...main, valves: 'x' }, 'valves must be an object keyed by model id')
  })

  test('anything the relay would not have written for a sub-agent or a valve is bad, with the reason', () => {
    bad({ ...gateControl(), agents: { '': entry() } }, 'agents has an empty agent id')
    bad({ ...gateControl(), agents: { a1: 3 } }, 'agents.a1 is not an object')
    bad({ ...gateControl(), agents: { a1: { ...entry(), passAtTokens: 1.5 } } }, 'agents.a1.passAtTokens must be a whole number')
    bad({ ...gateControl(), valves: { gpt: 5 } }, 'valves names "gpt", which is not an exact model id')
    bad({ ...gateControl(), valves: { 'claude-opus-4-8': 0 } }, 'valves.claude-opus-4-8 must be a positive whole number')
    bad({ ...gateControl(), valves: { 'claude-opus-4-8': 1.5 } }, 'valves.claude-opus-4-8 must be a positive whole number')
  })

  test('a valve keyed by a model line, not an exact model id, is refused', () => {
    bad({ ...gateControl(), valves: { haiku: 180_000 } }, 'valves names "haiku", which is not an exact model id')
    bad({ ...gateControl(), valves: { 'claude-haiku': 180_000 } }, 'valves names "claude-haiku", which is not an exact model id')
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

  test("the main agent's store record key is its session's", () => {
    expect(usedReleaseKey('s1')).toBe('compaction-used-release:s1')
  })
})

// One automatic proposal of a sub-agent. Its valve is its own: the main agent's valve and release never decide a sub-agent.
describe('the sub-agent gate (pure)', () => {
  const OPUS = { tokens: 300_000, model: 'claude-opus-4-8' }
  const withAgent = (a: Partial<AgentControl>, over: Partial<WireControl> = {}): ControlFile => withControl({ agents: { a1: entry(a) }, ...over })
  const ask = (over: Partial<AgentGateInput> = {}): AgentGateInput => ({ agentId: 'a1', file: withAgent({}), size: OPUS, ...over })

  test('a sub-agent under its valve is held, and not told', () => {
    expect(agentVerdict(ask())).toEqual({ pass: false, reason: AGENT_HELD_REASON, told: false })
  })

  test("a sub-agent passes at its OWN valve, whatever the main agent's valve is", () => {
    expect(agentVerdict(ask({ size: { ...OPUS, tokens: 600_000 } }))).toEqual({ pass: true, why: 'valve' })
    expect(agentVerdict(ask({ size: { ...OPUS, tokens: 599_999 } }))).toMatchObject({ pass: false })
    // the main valve (907,000) is far above: it does not decide a sub-agent
    expect(agentVerdict(ask({ file: withAgent({ passAtTokens: 400_000 }), size: { ...OPUS, tokens: 400_000 } }))).toEqual({ pass: true, why: 'valve' })
  })

  test("the main agent's release never passes a sub-agent, whether the control has an entry for it or not", () => {
    const file = withAgent({}, { releaseUntilMs: NOW + 60_000, releaseId: 'main-release' })
    expect(agentVerdict(ask({ file }))).toEqual({ pass: false, reason: AGENT_HELD_REASON, told: false })
    // a sub-agent with no entry is measured against its line's valve only; the main agent's unexpired release is not its release
    expect(agentVerdict(ask({ file, agentId: 'ghost' }))).toEqual({ pass: false, reason: AGENT_HELD_REASON, told: false })
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
    // DX-5314: a relay older than the plugin gives no sub-agent control: fail open, with or without a size
    const older: ControlFile = { kind: 'control', control: { ...gateControl(), subagents: null } as any }
    expect(agentVerdict(ask({ file: older }))).toEqual({ pass: true, why: 'subagents-off' })
    expect(agentVerdict(ask({ file: older, size: null }))).toEqual({ pass: true, why: 'subagents-off' })
  })

  test('a context size the plugin never saw is refused and told, never guessed', () => {
    expect(agentVerdict(ask({ size: null }))).toEqual({ pass: false, reason: `${AGENT_HELD_REASON} (sub-agent a1: its context size is not known)`, told: true })
  })

  describe('a sub-agent with no entry is measured against the valve of its exact model id', () => {
    const noEntry = (size: AgentGateInput['size']) => ask({ agentId: 'ghost', size })

    test("it passes at its model's valve, and is held under it", () => {
      expect(agentVerdict(noEntry({ tokens: 180_000, model: 'claude-haiku-5-5' }))).toEqual({ pass: true, why: 'valve' })
      expect(agentVerdict(noEntry({ tokens: 179_999, model: 'claude-haiku-5-5' }))).toEqual({ pass: false, reason: AGENT_HELD_REASON, told: false })
      // the same size on another model is under that model's valve
      expect(agentVerdict(noEntry({ tokens: 180_000, model: 'claude-opus-4-8' }))).toMatchObject({ pass: false })
      expect(agentVerdict(noEntry({ tokens: 907_000, model: 'claude-opus-4-8' }))).toEqual({ pass: true, why: 'valve' })
    })

    test("a model with no valve, even another version of a valved line, is refused and told: no line's valve, no guessed model, no default valve", () => {
      expect(agentVerdict(noEntry({ tokens: 900_000, model: 'gpt-5' }))).toEqual({
        pass: false,
        reason: `${AGENT_HELD_REASON} (sub-agent ghost: it has no compaction control yet and the control has no valve for its model "gpt-5")`,
        told: true,
      })
      expect(agentVerdict(noEntry({ tokens: 900_000, model: 'claude-fable-1-0' }))).toEqual({
        pass: false,
        reason: `${AGENT_HELD_REASON} (sub-agent ghost: it has no compaction control yet and the control has no valve for its model "claude-fable-1-0")`,
        told: true,
      })
      expect(agentVerdict(noEntry({ tokens: 900_000, model: 'claude-haiku-4-5' }))).toEqual({
        pass: false,
        reason: `${AGENT_HELD_REASON} (sub-agent ghost: it has no compaction control yet and the control has no valve for its model "claude-haiku-4-5")`,
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

    // DX-5562: `noteAgentStep` is an observer on every sub-agent model request; an id Claude Code never produces must not fail the request
    describe('noting a sub-agent request', () => {
      test('an id of the wrong form does not fail the request: the response stands and the id is told once', async ($, on) => {
        const k = await started($, on)
        const usage = AGENT_TURN_USAGE(700_000)
        for (const id of ['agent-bad', 'agent-bad']) {
          const response = await k.request(id, usage)
          expect(response).toMatchObject({ stopReason: 'end_turn' })
        }
        expect(k.d.toasts.filter(t => t.startsWith('Compaction could not note the context of sub-agent "agent-bad"'))).toHaveLength(1)
      })
    })

    describe('the told-once memory of sub-agent faults', () => {
      test('is bounded: past AGENT_FAULT_TOLD_KEEP distinct faults the oldest is forgotten, and is told again', async ($, on) => {
        const k = await started($, on)
        const toldOf = (id: string) => k.d.toasts.filter(t => t.startsWith(`Compaction could not note the context of sub-agent ${JSON.stringify(id)}`)).length
        await k.request('agent-bad-0', AGENT_TURN_USAGE(700_000))
        expect(toldOf('agent-bad-0')).toBe(1)
        for (let i = 1; i <= AGENT_FAULT_TOLD_KEEP; i++) await k.request(`agent-bad-${i}`, AGENT_TURN_USAGE(700_000))
        await k.request('agent-bad-0', AGENT_TURN_USAGE(700_000))
        expect(toldOf('agent-bad-0')).toBe(2)
      })
    })

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
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { 'agent-a1': entry() } }))
        await k.request('a1', AGENT_TURN_USAGE(300_000))
        expect(await k.propose('a1')).toEqual({ skip: AGENT_HELD_REASON })
        expect(k.core).toEqual([])
        await k.request('a1', AGENT_TURN_USAGE(600_000))
        // the main agent's size is far under its own valve and the classic gate cannot name an agent: the proposal still passes
        expect(await k.propose('a1')).toEqual(COMPACTED)
        expect(k.core).toEqual([{ agentId: 'a1', skipped: undefined }])
        expect(k.d.toasts).toContain('Compacting sub-agent agent-a1 now: its context reached the size where holding it would end its work.')
      })

      test('the size is the LAST response of that sub-agent: after it compacted and shrank, the next proposal is held', async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { 'agent-a1': entry() } }))
        await k.request('a1', AGENT_TURN_USAGE(650_000))
        expect(await k.propose('a1')).toEqual(COMPACTED)
        await k.request('a1', AGENT_TURN_USAGE(40_000))
        expect(await k.propose('a1')).toEqual({ skip: AGENT_HELD_REASON })
      })

      test("each sub-agent's size is its own", async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { 'agent-a1': entry(), 'agent-a2': entry() } }))
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

      test("a manual /compact is not this gate's: it is not matched, and the classic gate lets it through", async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { 'agent-a1': entry() } }))
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

      test('a precompute is judged per agent like an automatic proposal, and announces nothing: held under the valve, through at it', async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { 'agent-a1': entry() } }))
        await k.request('a1', AGENT_TURN_USAGE(300_000))
        expect(await k.propose('a1', 'precompute')).toEqual({ skip: AGENT_HELD_REASON })
        await k.request('a1', AGENT_TURN_USAGE(600_000))
        expect(await k.propose('a1', 'precompute')).toEqual(COMPACTED)
        expect(k.d.toasts.filter(t => t.startsWith('Compacting'))).toEqual([])
      })

      test('a sub-agent with no entry passes at the valve of its exact model id, read from its own responses', async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl())
        await k.request('h1', AGENT_TURN_USAGE(179_999, 'claude-haiku-5-5'))
        expect(await k.propose('h1')).toEqual({ skip: AGENT_HELD_REASON })
        await k.request('h1', AGENT_TURN_USAGE(180_000, 'claude-haiku-5-5'))
        expect(await k.propose('h1')).toEqual(COMPACTED)
        // the same size on another model is under that model's valve
        await k.request('o1', AGENT_TURN_USAGE(180_000, 'claude-opus-4-8'))
        expect(await k.propose('o1')).toEqual({ skip: AGENT_HELD_REASON })
      })

      test('a sub-agent with no entry and an unknown model, no valve for its model or no size is refused and told once, never guessed', async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = fileText(gateControl())
        await k.request('x1', AGENT_TURN_USAGE(900_000, 'gpt-5'))
        await k.request('f1', AGENT_TURN_USAGE(900_000, 'claude-fable-1-0'))
        for (let i = 0; i < 3; i++) {
          expect((await k.propose('x1')).skip).toContain('no valve for its model "gpt-5"')
          expect((await k.propose('f1')).skip).toContain('no valve for its model "claude-fable-1-0"')
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
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { 'agent-a1': entry() } }))
        await k.request('a1', AGENT_TURN_USAGE(300_000))
        expect(await k.propose('a1')).toEqual({ skip: AGENT_HELD_REASON })
        k.d.world.fsError = 'the disk is gone'
        expect(await k.propose('a1')).toEqual(COMPACTED)
        expect(await k.propose('a1')).toEqual(COMPACTED)
        expect(k.d.toasts.filter(t => t.startsWith('Compaction gate could not decide for sub-agent agent-a1, so Claude Code\'s own automatic compaction applies'))).toHaveLength(1)
        expect(k.core).toHaveLength(2)
      })

      test('the classic gate alone (a host that has run no session.compact) holds every automatic proposal like the main agent', async ($, on) => {
        const k = await started($, on, { engineVersion: { base: '2.1.298' } })
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { 'agent-a1': entry() } }))
        expect((await $.classic.PreCompact(PRE('auto'))).block).toBe(HELD_REASON)
        expect((await $.classic.PreCompact(PRE('manual'))).block).toBeUndefined()
      })

      test('once the host has run session.compact the classic gate leaves automatic proposals to it, including an isolated sub-agent the per-agent gate never sees', async ($, on) => {
        const k = await started($, on, { engineVersion: { base: '2.1.298' } })
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { 'agent-a1': entry() } }))
        expect((await $.classic.PreCompact(PRE('auto'))).block).toBe(HELD_REASON)
        await k.see()
        // a proposal that skips session.compact (an isolated delegatedObservation sub-agent, a model whose window source is auto, the in-process runner) reaches only the classic hook,
        // whose input never names the agent in 2.1.299: it passes there
        expect((await $.classic.PreCompact(PRE('auto'))).block).toBeUndefined()
        // the main agent's own proposal still goes through session.compact, where it is held
        expect(await k.propose()).toEqual({ skip: HELD_REASON })
        expect(k.core).toEqual([{ agentId: undefined, skipped: undefined }])
      })

      // DX-5365: the same answer that arms decides the classic gate, so a fresh 2.1.299 process (no event seen) does not hold the proposals that never reach session.compact
      test('a fresh process on an engine that runs session.compact passes an automatic proposal at the classic gate, with no event seen yet', async ($, on) => {
        const k = await started($, on, { engineVersion: { base: '2.1.299' } })
        k.d.world.files[CONTROL_FILE] = fileText(gateControl({ agents: { 'agent-a1': entry() } }))
        expect((await $.classic.PreCompact(PRE('auto'))).block).toBeUndefined()
        expect((await $.classic.PreCompact(PRE('manual'))).block).toBeUndefined()
        // the main agent's own proposal is still held at session.compact
        expect(await k.propose()).toEqual({ skip: HELD_REASON })
      })

      test('the engine release is read once per process, however many syncs and classic proposals follow', async ($, on) => {
        const k = await started($, on, { engineVersion: { base: '2.1.299' } })
        k.d.world.files[CONTROL_FILE] = fileText(gateControl())
        await $.turn.start(START)
        await $.turn.complete(TURN)
        await $.classic.PreCompact(PRE('auto'))
        await $.turn.start(START)
        expect(k.d.versionReads).toBe(1)
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

      // DX-5365: 2.1.299 is the engine release the per-agent `session.compact` gate was verified on (DX-5222), so a fresh process on it arms at the first sync, with no event seen yet
      test('a fresh process on an engine that runs session.compact arms at the first handshake sync, before any compaction event', async ($, on) => {
        const k = await started($, on, { engineVersion: { base: '2.1.299' } })
        k.d.world.files[CONTROL_FILE] = fileText(gateControl())
        await $.turn.start(START)
        expect(k.d.envSets).toEqual([{ name: PCT, value: '25' }])
        // the once-per-process clear ran before the first set (DX-5222 comment 15880)
        expect(k.d.envClearedAtSet).toEqual([true])
        expect(k.d.toasts).not.toContain(ENGINE_VERSION_NOTICE)
      })

      for (const base of ['2.1.300', '2.2.0', '3.0.0', '2.1.299-dev']) {
        test(`engine ${base} arms too, a later release or a development build of the floor`, async ($, on) => {
          const k = await started($, on, { engineVersion: { base } })
          k.d.world.files[CONTROL_FILE] = fileText(gateControl())
          await $.turn.start(START)
          expect(k.d.env(PCT)).toBe('25')
          expect(k.d.toasts).not.toContain(ENGINE_VERSION_NOTICE)
        })
      }

      // 2.0.999 has a higher patch than the floor's 299 and a lower minor: a field-by-field compare would arm it
      for (const base of ['2.1.298', '2.0.999', '1.9.999']) {
        test(`a fresh process on engine ${base}, below the floor, arms nothing until a session.compact event is seen`, async ($, on) => {
          const k = await started($, on, { engineVersion: { base } })
          k.d.world.files[CONTROL_FILE] = fileText(gateControl())
          await $.turn.start(START)
          await $.turn.complete(TURN)
          expect(k.d.envSets).toEqual([])
          expect(k.d.toasts).not.toContain(ENGINE_VERSION_NOTICE)
          await k.see()
          await $.turn.start(START)
          expect(k.d.envSets).toEqual([{ name: PCT, value: '25' }])
        })
      }

      for (const [name, engineVersion] of [['throws', 'throws'], ['names no release', { base: undefined }]] as const) {
        test(`a version reading that ${name} never arms, and the sync still runs`, async ($, on) => {
          const k = await started($, on, { engineVersion })
          k.d.world.files[CONTROL_FILE] = fileText(gateControl())
          await $.turn.start(START)
          await $.turn.complete(TURN)
          expect(k.d.envSets).toEqual([])
          expect(k.d.toasts.some(t => t.startsWith('Compaction handshake could not run'))).toBe(false)
          // the person is told once, however many syncs follow, and it was asked for the version once
          await $.turn.start(START)
          expect(k.d.toasts.filter(t => t === ENGINE_VERSION_NOTICE)).toHaveLength(1)
          expect(k.d.versionReads).toBe(1)
        })
      }

      // DX-5365: a session.compact event already proved the host runs it, so an unreadable release is no news to the person
      test('an unreadable engine release is not told once a session.compact event was seen', async ($, on) => {
        const k = await started($, on, { engineVersion: 'throws' })
        await k.see()
        k.d.world.files[CONTROL_FILE] = fileText(gateControl())
        await $.turn.start(START)
        expect(k.d.env(PCT)).toBe('25')
        expect(k.d.toasts).not.toContain(ENGINE_VERSION_NOTICE)
      })

      test('an unreadable engine release is not told to a session that is not under the handshake', async ($, on) => {
        const k = await started($, on, { engineVersion: 'throws' })
        await $.turn.start(START)
        await $.turn.complete(TURN)
        expect(k.d.toasts).not.toContain(ENGINE_VERSION_NOTICE)
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

      // fail open: nothing is armed, so a sub-agent's proposal only comes at Claude Code's own threshold, and refusing it would strand the agent at its window
      test("a sub-agent's proposal passes (fail open), with or without a known size, and the main agent keeps its own gate", async ($, on) => {
        const k = await started($, on)
        k.d.world.files[CONTROL_FILE] = OLDER
        expect(await k.propose('a1')).toEqual(COMPACTED)
        await k.request('a1', AGENT_TURN_USAGE(900_000))
        expect(await k.propose('a1')).toEqual(COMPACTED)
        expect(await k.propose('a1', 'precompute')).toEqual(COMPACTED)
        expect(k.core).toEqual([
          { agentId: 'a1', skipped: undefined },
          { agentId: 'a1', skipped: undefined },
          { agentId: 'a1', skipped: undefined },
        ])
        expect(k.d.toasts.some(t => t.startsWith(AGENT_HELD_REASON))).toBe(false)
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

    })
  })
}
