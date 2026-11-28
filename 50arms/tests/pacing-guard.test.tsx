import "./run-tests-with-npm-test.generated"
// DX-4340 (PLAN-29 R-10): the usage-pacing guard on `agent.spawn`. The decision table is pure; the handler answers from the session's
// pacing cache (GET /api/pacing/line, the account placed by 50 Arms), and denies, downgrades or lets the spawn through. It hooks
// `agent.spawn` only: no tool call is ever held, so an agent can still commit, push and write its card.
import { describe, expect } from 'claude-code/testing'

import { PACED_STOP, REFUSAL_PREFIX, designerFloor, agentFileEffort, agentFileModel, decideSpawn, denyReason, designerCardOf, designerRefusal, designerShortfall, isDesignerBrief, isTight, ownAgentFile, requestedModelOf, spawnGuard, tierOf } from '../hooks/plan/pacing-guard'
// boards' plan-design review grades the designer floor follows
const SONNET_MEDIUM = { model: 'sonnet', effort: 'medium' } as const
const OPUS_HIGH = { model: 'opus', effort: 'high' } as const

import { register } from '../hooks/register'
import { claimSlot, PACING_READ_DEADLINE_MS, PACING_REFRESH_MS, releaseClaim, resetPacing } from '../hooks/plan/pacing-line'
import type { PacingEnv } from '../hooks/plan/pacing-line'
import type { PacingVerdict } from '../types'
import { BLOCKED_LINE, DISPATCHED_SERVER, SERVER } from '../hooks/plan/config'
import { test, dashboard, startSession } from './plan-kit'
import { CONNECTED_TITLE_MARK, HOURGLASS_TITLE_MARK } from '../hooks/plan/words'

const RESET = '2026-10-08T12:00:00.000Z'
const v = (over: Partial<PacingVerdict> = {}): PacingVerdict => ({ level: 'on_pace', budget: null, resetsAt: RESET, mainAgents: 0, subAgents: 0, reservedAgents: 0, ...over })
const wire = (over: Record<string, unknown> = {}) => ({
  account: 'uuid:u1',
  level: 'on_pace',
  budget: null,
  resets_at: RESET,
  main_agents: 3,
  sub_agents: 1,
  reserved_agents: 0,
  line: 'Pacing line.',
  spend: null,
  limits: [{ limit: 'five_hour', level: 'on_pace', state: 'spare', headroom_minutes: 60, resets_in_minutes: 100, used_percent: 3, target_percent: 95, critical_percent: 99, resets_at: RESET }],
  worst_limit: 'five_hour',
  reason: null,
  ...over,
})
const UNKNOWN = { account: null, level: null, budget: null, resets_at: null, main_agents: null, sub_agents: null, reserved_agents: null, line: null, spend: null, limits: null, worst_limit: null, reason: 'no_usage_account' }

describe('decideSpawn (the decision table)', () => {
  test('no verdict allows: pacing never blocks work it cannot see', () => {
    expect(decideSpawn(null, 'opus', false)).toEqual({ kind: 'allow' })
  })

  test('the refusal names level, budget and reset, and the pause, with no retry or pacing-message instruction', () => {
    for (const level of ['over_pace', 'critical'] as const) {
      const reason = denyReason(v({ level, budget: 0 }), 'level', null)
      expect(reason).toContain(level.replace('_', ' '))
      expect(reason).toContain('budget 0')
      expect(reason).toContain(RESET)
      expect(reason).toContain(PACED_STOP)
      expect(reason).not.toMatch(/retry/i)
    }
    expect(denyReason(v({ budget: 3, subAgents: 3 }), 'budget', null)).toContain('3 sub-agent(s) already run')
  })

  // DX-5595: slots held for woken sessions count as taken, and the refusal says so (not "already run")
  test('the held-slot refusal names the held slots and no freeing time', () => {
    const reason = denyReason(v({ budget: 3, subAgents: 2, reservedAgents: 1 }), 'reserved', null)
    expect(reason).toContain('2 sub-agent(s) run on this account and 1 slot(s) are held')
    expect(reason).not.toContain('within 60 seconds')
    expect(reason).toContain(PACED_STOP)
    expect(reason).not.toContain('already run')
  })

  // DX-8451 (DEC-3533 v4, DEC-3538 v2): a refusal that queued the session names its ticket, its place, the ready message and the 10-minute hold; no refusal
  // tells the session to wait for a pacing message that says slots are free, or to retry
  test('a queued refusal names its ticket, place, the ready message and the 10-minute hold, and never a pacing-message wait or a retry', () => {
    const waiting = { id: 'tkt-9', place: 2, state: 'waiting' as const }
    for (const reason of [
      denyReason(v({ level: 'over_pace', budget: 0 }), 'level', waiting),
      denyReason(v({ budget: 3, subAgents: 3 }), 'budget', waiting),
      denyReason(v({ budget: 3, subAgents: 2, reservedAgents: 1 }), 'reserved', waiting),
    ]) {
      expect(reason).toContain('ticket tkt-9, place 2')
      expect(reason).toContain('messages this session when the ticket is ready')
      expect(reason).toContain('10 minutes')
      expect(reason).toContain(PACED_STOP)
      expect(reason).not.toMatch(/retry/i)
      expect(reason).not.toContain('K free')
      expect(reason).not.toContain('start the waiting work at once')
      expect(reason.startsWith(REFUSAL_PREFIX)).toBe(true)
    }
  })

  test('a refusal of a ready ticket names the ticket and that 50 Arms returns it to the queue, with no figures', () => {
    const reason = denyReason(null, 'reserved', { id: 'tkt-3', place: 0, state: 'ready' })
    expect(reason).toContain('ticket tkt-3 is ready')
    expect(reason).toContain('messages this session when it is ready again')
    expect(reason).not.toContain('level')
  })

  test('a claimed verdict with room, or no cap, allows', () => {
    expect(decideSpawn(v({ budget: 3, subAgents: 1 }), 'haiku', false)).toEqual({ kind: 'allow' })
    expect(decideSpawn(v({ budget: null, subAgents: 40 }), 'opus', false)).toEqual({ kind: 'allow' })
  })

  test('a held slot counts toward tight: one free slot left after the hold downgrades', () => {
    expect(isTight(5, 2, 2)).toBe(true)
    expect(isTight(5, 2, 1)).toBe(false)
    expect(decideSpawn(v({ budget: 5, subAgents: 2, reservedAgents: 2 }), 'opus', false)).toEqual({ kind: 'downgrade', model: 'haiku' })
  })

  // CP-162 (DEC-2387): a designer start is never moved to a smaller model, however tight the budget
  test('a designer start that takes the last free slot keeps the model it asked for', () => {
    expect(decideSpawn(v({ budget: 3, subAgents: 2 }), 'opus', true)).toEqual({ kind: 'allow' })
  })

  test('tight (budget - running <= 1) downgrades to haiku, never upward and never an unknown model', () => {
    expect(isTight(3, 2, 0)).toBe(true)
    expect(isTight(3, 1, 0)).toBe(false)
    expect(isTight(null, 99, 0)).toBe(false)
    for (const model of ['opus', 'sonnet', 'claude-opus-4-8', 'fable']) {
      expect(decideSpawn(v({ budget: 3, subAgents: 2 }), model, false)).toEqual({ kind: 'downgrade', model: 'haiku' })
    }
    expect(decideSpawn(v({ budget: 3, subAgents: 2 }), 'haiku', false)).toEqual({ kind: 'allow' })
    expect(decideSpawn(v({ budget: 3, subAgents: 2 }), 'mystery-model', false)).toEqual({ kind: 'allow' })
    // a call that names no model runs on its agent type's model: moved to haiku, the lowest tier, with no agent file read
    expect(decideSpawn(v({ budget: 3, subAgents: 2 }), undefined, false)).toEqual({ kind: 'downgrade', model: 'haiku' })
    expect(decideSpawn(v({ budget: 5, subAgents: 2 }), undefined, false)).toEqual({ kind: 'allow' })
    expect(decideSpawn(v({ budget: 5, subAgents: 2 }), 'opus', false)).toEqual({ kind: 'allow' })
  })

  test('tierOf places aliases and ids', () => {
    expect(tierOf('claude-haiku-4-5')).toBe('haiku')
    expect(tierOf('OPUS')).toBe('opus')
    expect(tierOf('gpt')).toBeNull()
  })

  test('a designer is never downgraded, however tight the budget and whatever it asks for (DEC-2387)', () => {
    for (const model of ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-4-8', undefined]) {
      expect(decideSpawn(v({ budget: 3, subAgents: 2 }), model, true)).toEqual({ kind: 'allow' })
    }
    expect(decideSpawn(v({ budget: 1, subAgents: 1, reservedAgents: 0 }), 'opus', true)).toEqual({ kind: 'allow' })
  })

  test('a designer start is told by the first non-empty line of its brief naming the designer profile', () => {
    expect(isDesignerBrief('gate-designer CP-1\n\nDraw the screen.')).toBe(true)
    expect(isDesignerBrief('gate-designer CP-1')).toBe(true)
    // leading blank lines (and blank lines of spaces) are skipped, and CRLF line endings are read the same
    expect(isDesignerBrief('\n\n  \ngate-designer CP-1\r\nDraw.')).toBe(true)
    expect(isDesignerBrief('gate-designer\tCP-1')).toBe(false)
    expect(isDesignerBrief('Draw the screen with a gate-designer CP-1 brief.\ngate-designer CP-1')).toBe(false)
    expect(isDesignerBrief('work CP-1\ngate-designer CP-1')).toBe(false)
    expect(isDesignerBrief('gate-designerX CP-1')).toBe(false)
    expect(isDesignerBrief('gate-reviewer CP-1')).toBe(false)
    expect(isDesignerBrief('')).toBe(false)
    expect(isDesignerBrief('\n \n')).toBe(false)
  })

  test('a brief that is not a string is never a designer start', () => {
    for (const prompt of [undefined, null, 42, ['gate-designer CP-1'], { prompt: 'gate-designer CP-1' }]) {
      expect(isDesignerBrief(prompt)).toBe(false)
    }
  })

  // the floor is the board's plan-design review grade, never a fixed model

  test('a designer below the grade on model is refused with a reason naming the grade, what it runs on and what to change; it is not a pacing refusal', () => {
    for (const model of ['haiku', 'claude-haiku-5-5']) {
      const reason = designerShortfall(SONNET_MEDIUM, model, 'high', '50arms:worker-haiku-high')
      expect(reason).toContain('grade is sonnet at medium effort')
      expect(reason).toContain(`runs on ${model} at high effort`)
      expect(reason?.startsWith(REFUSAL_PREFIX)).toBe(false)
    }
    expect(designerShortfall(OPUS_HIGH, 'sonnet', 'high', 'x')).toContain('grade is opus at high effort')
  })

  test('a designer below the grade on effort only is refused, and one at or above the grade on both is not', () => {
    expect(designerShortfall(OPUS_HIGH, 'opus', 'medium', 'x')).toContain('runs on opus at medium effort')
    expect(designerShortfall(OPUS_HIGH, 'opus', 'high', 'x')).toBeNull()
    expect(designerShortfall(OPUS_HIGH, 'claude-opus-4-8', 'xhigh', 'x')).toBeNull()
    expect(designerShortfall(OPUS_HIGH, 'fable', 'max', 'x')).toBeNull()
  })

  test('the floor is the higher of Opus and the grade\'s model, at the grade\'s effort: a board naming Sonnet still refuses a designer below Opus', () => {
    expect(designerFloor(SONNET_MEDIUM)).toEqual({ model: 'opus', effort: 'medium' })
    expect(designerFloor({ model: 'haiku', effort: 'low' })).toEqual({ model: 'opus', effort: 'low' })
    expect(designerFloor({ model: 'fable', effort: 'high' })).toEqual({ model: 'fable', effort: 'high' })
    expect(designerShortfall(SONNET_MEDIUM, 'sonnet', 'high', 'x')).toContain('runs on opus or better at medium effort or higher')
    expect(designerShortfall(SONNET_MEDIUM, 'haiku', 'high', 'x')).not.toBeNull()
    expect(designerShortfall(SONNET_MEDIUM, 'opus', 'medium', 'x')).toBeNull()
    expect(designerShortfall(SONNET_MEDIUM, 'opus', 'low', 'x')).not.toBeNull()
    expect(designerShortfall({ model: 'fable', effort: 'high' }, 'opus', 'high', 'x')).not.toBeNull()
  })

  // what the plugin's agent files name, as the env lists them
  const TYPES = [
    { type: '50arms:worker-haiku-low', model: 'haiku', effort: 'low' },
    { type: '50arms:worker-fable-high', model: 'fable', effort: 'high' },
    { type: '50arms:worker-opus-high', model: 'opus', effort: 'high' },
    { type: '50arms:worker-sonnet-medium', model: 'sonnet', effort: 'medium' },
    { type: '50arms:worker-sonnet-high', model: 'sonnet', effort: 'high' },
  ]
  test('the refusal names the cheapest of the plugin own agent types that meets the floor, whatever order they are listed in, or says none does', () => {
    const word = (grade: any) => designerRefusal(grade, 'It is below.', TYPES)
    expect(word({ model: 'opus', effort: 'medium' })).toContain('50arms:worker-opus-high')
    expect(word(SONNET_MEDIUM)).toContain('50arms:worker-opus-high')
    expect(word({ model: 'fable', effort: 'high' })).toContain('50arms:worker-fable-high')
    expect(word({ model: 'opus', effort: 'max' })).toMatch(/None of the plugin's agent types runs at that floor/)
    expect(word(SONNET_MEDIUM).startsWith('It is below.')).toBe(true)
    expect(word(SONNET_MEDIUM).startsWith(REFUSAL_PREFIX)).toBe(false)
  })

  test('an effort the plugin cannot tell is refused; an unknown model name is left alone as before', () => {
    expect(designerShortfall(SONNET_MEDIUM, 'sonnet', null, 'general-purpose')).toMatch(/cannot tell which effort the agent type general-purpose runs on/)
    expect(designerShortfall(SONNET_MEDIUM, 'mystery-model', 'medium', 'x')).toBeNull()
    expect(designerShortfall(SONNET_MEDIUM, undefined, 'medium', 'x')).toBeNull()
  })

  test('the card a designer brief names is the word after the profile on its first line', () => {
    expect(designerCardOf('gate-designer ABC-12\n\nDraw.')).toBe('ABC-12')
    expect(designerCardOf('\n gate-designer  CP-1 extra')).toBe('CP-1')
    expect(designerCardOf('gate-designer ')).toBeNull()
    expect(designerCardOf('work CP-1')).toBeNull()
  })

  test('an agent file names its effort in the frontmatter only', () => {
    expect(agentFileEffort('---\nmodel: sonnet\neffort: high\n---\neffort: low')).toBe('high')
    expect(agentFileEffort('---\nmodel: sonnet\n---\n')).toBeUndefined()
  })

  // CP-162 fix pass (code-architecture round 1): the model a spawn runs on is the call's `model`, else the agent type's own model, else the parent's
  test('the model a spawn runs on is the call\'s model, else the agent type\'s own, else the parent\'s; a fork always inherits the parent\'s', () => {
    const base = { fork: false, parentModel: 'opus' }
    expect(requestedModelOf({ ...base, model: 'haiku' }, 'sonnet')).toBe('haiku')
    expect(requestedModelOf({ ...base, model: undefined }, 'sonnet')).toBe('sonnet')
    expect(requestedModelOf({ ...base, model: undefined }, null)).toBe('opus')
    expect(requestedModelOf({ fork: true, parentModel: 'opus', model: 'haiku' }, 'sonnet')).toBe('opus')
  })

  test('a plugin\'s own agent type is read from its agent file under the plugin root; any other type has none', () => {
    expect(ownAgentFile('50arms', '/p/50arms', '50arms:worker-sonnet-high')).toBe('/p/50arms/agents/worker-sonnet-high.md')
    expect(ownAgentFile('50arms', '/p/50arms', '50arms:team:worker-sonnet-high')).toBe('/p/50arms/agents/team/worker-sonnet-high.md')
    expect(ownAgentFile('50arms', '/p/50arms', 'general-purpose')).toBeNull()
    expect(ownAgentFile('50arms', '/p/50arms', 'Explore')).toBeNull()
    expect(ownAgentFile('50arms', '/p/50arms', 'other:worker-sonnet-high')).toBeNull()
  })

  test('the model an agent file names is read from its frontmatter; inherit or none names the parent\'s', () => {
    expect(agentFileModel('---\nname: worker-sonnet-high\nmodel: sonnet\neffort: high\n---\n\nbody model: haiku')).toBe('sonnet')
    expect(agentFileModel('---\r\nmodel: "claude-opus-4-8"\r\n---\r\n')).toBe('claude-opus-4-8')
    expect(agentFileModel('---\nmodel: inherit\n---\n')).toBeUndefined()
    expect(agentFileModel('---\nname: x\n---\n')).toBeUndefined()
    expect(agentFileModel('no frontmatter, model: sonnet')).toBeUndefined()
  })

  // a claim the plugin can make (the figures carry no cap), the board's grade (Opus at high) and an env whose agent file names `agentGrade`
  const guardEnv = (agentGrade: { model: string | null; effort: string | null } | undefined, call: () => Promise<unknown>): PacingEnv => ({
    now: () => Promise.resolve(0), within: (_ms, work) => work, reading: () => Promise.resolve(null), signedIn: () => Promise.resolve(true),
    call: ((method: string, path: string) =>
      path.endsWith('/quality-gates/plan-design/instruction') ? Promise.resolve({ ok: true, status: 200, body: OPUS_HIGH })
      : call()) as PacingEnv['call'],
    sleep: () => Promise.resolve(), toast: () => {}, agentGrade: () => Promise.resolve(agentGrade),
    ownAgentTypes: () => Promise.resolve([{ type: '50arms:worker-opus-high', model: 'opus', effort: 'high' }]),
  })
  const claimedBody = { account: 'uuid:u1', level: 'on_pace', budget: 3, resets_at: RESET, main_agents: 2, sub_agents: 2, reserved_agents: 0, line: 'Pacing line.', spend: null, limits: [], worst_limit: null, reason: null, claimed: true, claim_id: 'claim-1' }

  test('a designer whose agent type runs on Sonnet is refused under an Opus session when it names no model: no claim is made (CP-162 fix pass)', async () => {
    resetPacing()
    const env = guardEnv({ model: 'sonnet', effort: 'high' }, () => Promise.reject(new Error('never reached: a refused designer claims nothing')))
    const e = { prompt: 'gate-designer CP-1\n\nDraw.', subagentType: '50arms:worker-sonnet-high', description: 'd', tool_use_id: 't', fork: false, parentModel: 'opus', background: false } as any
    let started = false
    const r = await spawnGuard(env)(e, async () => { started = true; return { model: 'm', agentId: 'a' } as any })
    expect(started).toBe(false)
    expect(r.deny).toMatch(/runs on sonnet at high effort/)
    expect(r.deny?.startsWith(REFUSAL_PREFIX)).toBe(false)
  })

  test('a designer whose agent type runs on Opus is started under a Sonnet session when it names no model (CP-162 fix pass)', async () => {
    resetPacing()
    const env = guardEnv({ model: 'opus', effort: 'high' }, () => Promise.resolve({ ok: true, status: 200, body: claimedBody }))
    const e = { prompt: 'gate-designer CP-1\n\nDraw.', subagentType: '50arms:worker-opus-high', description: 'd', tool_use_id: 't', fork: false, parentModel: 'sonnet', background: false } as any
    let started: any = null
    const r = await spawnGuard(env)(e, async (x: any) => { started = x; return { model: 'opus', agentId: 'a' } as any })
    expect(r.deny).toBeUndefined()
    expect(started?.model).toBeUndefined()
  })

  test('a designer whose agent type is not the plugin\'s own, and names no model, is refused before any claim: the plugin cannot tell its model', async () => {
    resetPacing()
    const env = guardEnv(undefined, () => Promise.reject(new Error('never reached: a refused designer claims nothing')))
    const e = { prompt: 'gate-designer CP-1\n\nDraw.', subagentType: 'general-purpose', description: 'd', tool_use_id: 't', fork: false, parentModel: 'opus', background: false } as any
    let started = false
    const r = await spawnGuard(env)(e, async () => { started = true; return { model: 'm', agentId: 'a' } as any })
    expect(started).toBe(false)
    expect(r.deny).toMatch(/cannot tell which effort the agent type general-purpose runs on/)
    expect(r.deny?.startsWith(REFUSAL_PREFIX)).toBe(false)
  })
})

describe('the agent.spawn hook', () => {
  // what the cache holds, as a new sub-agent sees it: the line of the last answer, as an UNFORCED read serves it inside the minute after any read
  const subagentLine = async ($: any, d: any): Promise<string | null> => {
    const r = await $.classic.SubagentStart({ agent_id: 'a1', agent_type: '50arms:worker-sonnet-high' } as any)
    // DX-4686: the start's live check is detached from the hook; let it end before the test does
    await d.clock.settle()
    return (r.additionalContext ?? []).find((t: string) => t === 'Pacing line.') ?? null
  }
  // the engine's own answer beneath the guard: a started sub-agent
  const spawn = ($: any, over: Record<string, unknown> = {}) => $.agent.spawn({ prompt: 'work', subagentType: 'general-purpose', ...over })

  async function session($: any, on: any, options: Parameters<typeof dashboard>[1] = {}) {
    resetPacing()
    // the engine's own answer beneath the guard: a started sub-agent, or the host refusing (prompt 'refuse')
    // (prompt 'refuse-and-drop': the host refuses and the dashboard server drops before the claim is given back)
    on('agent.spawn', async (_$: any, e: any) => {
      if (e.prompt === 'refuse-and-drop') options.mcp = 'down'
      // DX-5593: the host throws while starting the spawn (after 50 Arms took the slot)
      if (e.prompt === 'throw') throw new Error('host crashed')
      return (e.prompt === 'refuse' || e.prompt === 'refuse-and-drop' ? { deny: 'host refused' } : { model: e.model ?? 'parent-model', agentId: 'new' }) as any
    })
    on('tool.call', () => ({ result: {}, text: 'ran', isError: false }) as any)
    on('classic.SubagentStart', () => ({}) as any)
    const d = dashboard(on, options)
    await startSession($, d, 'desktop')
    return d
  }
  // the toasts about pacing since `from` (a session start that reads a failing line toasts its own failure first)
  const claimToasts = (d: any, from = 0) => d.toasts.slice(from).filter((t: string) => t.startsWith('Usage pacing could not claim a slot'))
  const giveBackToasts = (d: any) => d.toasts.filter((t: string) => t.startsWith('Usage pacing could not give back a claimed slot'))

  test('denies on an over-pace verdict with the reason as the error, and starts nothing', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ level: 'over_pace', budget: 0 }) } })
    const r = await spawn($)
    expect(r.deny).toMatch(/Usage pacing: this account is over pace/)
    expect(r.deny).toContain(RESET)
    expect(d.claimsAllowed).toEqual([])
  })
  test('denies when the account is at its budget, by the live account count the claim carries', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ budget: 2, sub_agents: 2 }) } })
    expect((await spawn($)).deny).toMatch(/2 sub-agent\(s\) already run/)
  })

  test('a claim 50 Arms refused for held slots is worded as held slots, not as a full budget', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 3, sub_agents: 2, reserved_agents: 1 }) } })
    const r = await spawn($)
    expect(r.deny).toMatch(/1 slot\(s\) are held for sessions that waited longer/)
    expect(r.deny).not.toMatch(/already run/)
    expect(d.claimsAllowed).toEqual([])
  })

  test('allows with no cap, and leaves the model alone', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: null, sub_agents: 9 }) } })
    const r = await spawn($, { model: 'opus' })
    expect(r.deny).toBeUndefined()
    expect(r.model).toBe('opus')
    expect(d.claimsAllowed).toHaveLength(1)
  })

  test('rewrites the model down to haiku when the budget is tight, never up', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ budget: 3, sub_agents: 2 }) } })
    expect((await spawn($, { model: 'opus' })).model).toBe('haiku')
  })

  // CP-162 round 2: a plugin agent type's model and effort are read from its agent file under `$.plugin.root`, which the test runtime gives as /app/50arms (the
  // plugin folder holding agents/; plan-kit.tsx). The fixture's fs.read answers only the files seeded in `d.world.files`.
  const PLUGIN_ROOT = '/app/50arms'
  const agentFile = (name: string) => `${PLUGIN_ROOT}/agents/${name}.md`
  const agentReads = (d: any) => d.world.fsReads.filter((p: string) => p.includes('/agents/'))
  const DESIGN = { prompt: 'gate-designer CP-1\n\nDraw the screen.' }
  const seed = (d: any, name: string, model: string, effort: string) => { d.world.files[agentFile(name)] = `---\nname: ${name}\nmodel: ${model}\neffort: ${effort}\n---\n` }

  test('a designer whose agent type runs below the board grade on model is refused before any claim, reading that agent file and the board grade', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) }, designerGrade: OPUS_HIGH })
    seed(d, 'worker-sonnet-high', 'sonnet', 'high')
    const r = await spawn($, { ...DESIGN, subagentType: '50arms:worker-sonnet-high', parentModel: 'opus' })
    expect(r.deny).toMatch(/grade is opus at high effort/)
    expect(r.deny).toMatch(/runs on sonnet at high effort/)
    expect(r.deny?.startsWith(REFUSAL_PREFIX)).toBe(false)
    expect(agentReads(d)).toContain(agentFile('worker-sonnet-high'))
    expect(d.designerGradeReads).toEqual(['/api/issues/CP-1/quality-gates/plan-design/instruction'])
    expect(d.claimsAllowed).toEqual([])
  })

  test('a designer below the board grade on effort only is refused', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) }, designerGrade: OPUS_HIGH })
    seed(d, 'worker-opus-medium', 'opus', 'medium')
    const r = await spawn($, { ...DESIGN, subagentType: '50arms:worker-opus-medium' })
    expect(r.deny).toMatch(/runs on opus at medium effort/)
    expect(d.claimsAllowed).toEqual([])
  })

  test('a designer at the board grade is started, its agent file read', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) }, designerGrade: OPUS_HIGH })
    seed(d, 'worker-opus-high', 'opus', 'high')
    const r = await spawn($, { ...DESIGN, subagentType: '50arms:worker-opus-high', parentModel: 'sonnet' })
    expect(r.deny).toBeUndefined()
    expect(agentReads(d)).toEqual([agentFile('worker-opus-high')])
  })

  test('a board whose grade is Sonnet at medium still refuses a designer below Opus, and starts an Opus one at that effort', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) }, designerGrade: SONNET_MEDIUM })
    seed(d, 'worker-sonnet-medium', 'sonnet', 'medium')
    seed(d, 'worker-opus-high', 'opus', 'high')
    const refused = await spawn($, { ...DESIGN, subagentType: '50arms:worker-sonnet-medium' })
    expect(refused.deny).toMatch(/grade is sonnet at medium effort/)
    expect(refused.deny).toContain('50arms:worker-opus-high')
    expect(d.claimsAllowed).toEqual([])
    expect((await spawn($, { ...DESIGN, subagentType: '50arms:worker-opus-high' })).deny).toBeUndefined()
  })

  test('the refusal lists the agent files and names the cheapest that meets the floor; files that cannot be listed still refuse', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) }, designerGrade: SONNET_MEDIUM })
    seed(d, 'worker-sonnet-medium', 'sonnet', 'medium')
    seed(d, 'worker-opus-high', 'opus', 'high')
    seed(d, 'worker-fable-high', 'fable', 'high')
    const r = await spawn($, { ...DESIGN, subagentType: '50arms:worker-sonnet-medium' })
    expect(r.deny).toContain('Start the designer again on 50arms:worker-opus-high')
    delete d.world.files[agentFile('worker-opus-high')]
    delete d.world.files[agentFile('worker-fable-high')]
    expect((await spawn($, { ...DESIGN, subagentType: '50arms:worker-sonnet-medium' })).deny).toMatch(/None of the plugin's agent types runs at that floor/)
  })

  test('an agent folder that cannot be listed still refuses the start, naming that', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) }, designerGrade: SONNET_MEDIUM, agentListFails: true })
    seed(d, 'worker-sonnet-medium', 'sonnet', 'medium')
    const r = await spawn($, { ...DESIGN, subagentType: '50arms:worker-sonnet-medium' })
    expect(r.deny).toMatch(/agent types could not be listed (.*cannot be listed)/)
    expect(r.deny).toContain('at the floor above')
    expect(d.claimsAllowed).toEqual([])
  })

  test('a grade the plugin cannot read refuses the designer start, with no default floor and no claim', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) }, designerGrade: { status: 500 } })
    seed(d, 'worker-opus-high', 'opus', 'high')
    expect((await spawn($, { ...DESIGN, subagentType: '50arms:worker-opus-high' })).deny).toMatch(/plan-design review grade of the board of CP-1 could not be read/)
    d.setDesignerGrade({ model: 'mystery', effort: 'high' })
    expect((await spawn($, { ...DESIGN, subagentType: '50arms:worker-opus-high' })).deny).toMatch(/could not be read \(the grade names model "mystery"/)
    expect(d.claimsAllowed).toEqual([])
  })

  test('a designer whose agent file cannot be read is refused: what it runs on cannot be judged (fail closed)', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) } })
    const r = await spawn($, { ...DESIGN, subagentType: '50arms:worker-sonnet-high' })
    expect(r.deny).toMatch(/could not be read from its agent file/)
    expect(d.claimsAllowed).toEqual([])
  })

  test('a designer on a non-plugin agent type is refused before any claim, with the plugin unable to read its effort, even when it names a model', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) } })
    for (const extra of [{}, { model: 'opus' }]) {
      const r = await spawn($, { ...DESIGN, subagentType: 'general-purpose', parentModel: 'opus', ...extra })
      expect(r.deny).toMatch(/cannot tell which effort the agent type general-purpose runs on/)
      expect(r.deny?.startsWith(REFUSAL_PREFIX)).toBe(false)
    }
    expect(agentReads(d)).toEqual([])
    expect(d.claimsAllowed).toEqual([])
  })

  test('a non-designer on a non-plugin agent type is unchanged and reads no grade', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) } })
    expect((await spawn($, { subagentType: 'general-purpose', parentModel: 'sonnet' })).deny).toBeUndefined()
    expect(d.claimsAllowed).toHaveLength(1)
    expect(d.designerGradeReads).toEqual([])
  })

  test('a start with free slots reads no agent file, so an unreadable one cannot refuse it', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) } })
    expect((await spawn($, { subagentType: '50arms:worker-sonnet-high' })).deny).toBeUndefined()
    expect(d.claimsAllowed).toHaveLength(1)
    expect(agentReads(d)).toEqual([])
  })

  test('a signed-out session reads no agent file and lets the spawn through, however tight its verdict would be', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ level: 'critical', budget: 0 }) } })
    d.world.signedOut = 'lapsed'
    expect((await spawn($, { subagentType: '50arms:worker-sonnet-high' })).deny).toBeUndefined()
    expect(agentReads(d)).toEqual([])
  })

  test('a tight non-designer start on a plugin agent type is moved to Haiku and reads no agent file', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 3, sub_agents: 2 }) } })
    const r = await spawn($, { subagentType: '50arms:worker-sonnet-high', parentModel: 'opus' })
    expect(r.deny).toBeUndefined()
    expect(r.model).toBe('haiku')
    expect(d.claimsReleased).toEqual([])
    expect(agentReads(d)).toEqual([])
  })

  test('a designer start that takes the last free slot is started on the agent type it asked for, and is never moved to a smaller model (DEC-2387)', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 3, sub_agents: 2 }) } })
    seed(d, 'worker-opus-high', 'opus', 'high')
    const r = await spawn($, { ...DESIGN, subagentType: '50arms:worker-opus-high', model: 'opus' })
    expect(r.deny).toBeUndefined()
    expect(r.model).toBe('opus')
    expect(d.claimsAllowed).toHaveLength(1)
  })

  test('a non-designer start on Sonnet with the last free slot is still downgraded, and a brief that names the designer profile only on a later line is not a designer', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ budget: 3, sub_agents: 2 }) } })
    expect((await spawn($, { prompt: 'work CP-1\ngate-designer CP-1', model: 'sonnet' })).model).toBe('haiku')
  })

  test('a non-designer start on Sonnet with room is started on Sonnet: the model rule only moves a tight start', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ budget: 5, sub_agents: 1 }) } })
    const r = await spawn($, { prompt: 'gate-reviewer CP-1', model: 'sonnet' })
    expect(r.deny).toBeUndefined()
    expect(r.model).toBe('sonnet')
  })

  test('allows when 50 Arms answers unknown (the claim carries a reason): nothing is claimed, nothing is said', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: UNKNOWN } })
    expect((await spawn($)).deny).toBeUndefined()
    expect(d.toasts).toEqual([])
    expect(d.claimsAllowed).toEqual([])
  })

  // DX-5593 (N2): the first usage report is fire-and-forget, so the claim carries the session's latest reading and 50 Arms places the session on its account itself
  test("the claim carries the session's latest usage reading, the body the usage report sends", async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 5, sub_agents: 1 }) } })
    d.world.rateLimits = [{ kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-20T20:00:00.000Z' }, { kind: 'seven_day', percentUsed: 10, resetsAt: '2026-10-25T00:00:00.000Z' }]
    await spawn($)
    const sent = d.claimBodies.at(-1)
    expect(Object.keys(sent)).toEqual(['usage'])
    expect(sent.usage).toMatchObject({ fiveHour: { percentUsed: 42, resetsAt: '2026-10-20T20:00:00.000Z' }, sevenDay: { percentUsed: 10, resetsAt: '2026-10-25T00:00:00.000Z' } })
    expect(Date.parse(sent.usage.measuredAt)).toBeLessThanOrEqual(Date.parse(sent.usage.reportedAt))
  })

  test('a session with no reading to give claims without one', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 5, sub_agents: 1 }) } })
    d.world.rateLimits = []
    await spawn($)
    expect(d.claimBodies.at(-1)).toBeUndefined()
    expect(d.claimsAllowed).toHaveLength(1)
  })

  // DX-5593: the budget is a STRICT cap and the one count lives in 50arms: the plugin keeps no reservation. The cap itself is 50 Arms' (the fake dashboard
  // stands in for its answer), so what is asserted here is what the PLUGIN does with each answer: it asks 50 Arms every time and starts exactly the spawns it was given a claim for.
  const started = (results: { agentId?: string }[]) => results.filter(r => r.agentId !== undefined)

  test("every spawn asks 50 Arms for its slot, however long after the last, and starts exactly the spawns it was given a claim for", async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 3, sub_agents: 0 }) } })
    const first: any[] = []
    for (let i = 0; i < 3; i++) first.push(await spawn($, { model: 'haiku' }))
    expect(started(first)).toHaveLength(3)
    expect(d.claimsAllowed).toEqual(['claim-1', 'claim-2', 'claim-3'])
    const refused = await spawn($, { model: 'haiku' })
    expect(refused.deny).toMatch(/3 sub-agent\(s\) already run/)
    expect(started([refused])).toHaveLength(0)
    // nothing lapses or is remembered in the plugin: a minute and an hour on, the next spawn asks 50 Arms again and is told the same
    await d.clock.advance(PACING_REFRESH_MS + 1)
    const later = await spawn($, { model: 'haiku' })
    await d.clock.advance(60 * 60_000)
    const muchLater = await spawn($, { model: 'haiku' })
    expect([later.deny, muchLater.deny].every(deny => /already run/.test(deny ?? ''))).toBe(true)
    expect(started([later, muchLater])).toHaveLength(0)
    expect(d.claimAttempts.n).toBe(6)
    expect(d.claimsAllowed).toHaveLength(3)
  })

  test('a host-refused spawn gives its own claim back, and only its own', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 2, sub_agents: 0 }) } })
    expect((await spawn($, { model: 'haiku' })).deny).toBeUndefined()
    expect((await spawn($, { prompt: 'refuse', model: 'haiku' })).deny).toBe('host refused')
    expect(d.claimsReleased).toEqual(['claim-2'])
    expect([...d.heldClaims]).toEqual(['claim-1'])
    // the slot the refused spawn gave back is free again: one more fits, and then it is full
    expect((await spawn($, { model: 'haiku' })).deny).toBeUndefined()
    expect((await spawn($, { model: 'haiku' })).deny).toMatch(/already run/)
  })

  // DX-5593: a spawn the host throws on (not refuses) has also taken a slot; the claim is given back, and the throw still reaches the caller
  test('a spawn that throws while starting gives its own claim back, and the failure still propagates (the harness reports a throwing host as HooksError)', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 2, sub_agents: 0 }) } })
    await expect(spawn($, { prompt: 'throw', model: 'haiku' })).rejects.toThrow(/agent.spawn/)
    expect(d.claimsReleased).toEqual(['claim-1'])
    expect([...d.heldClaims]).toEqual([])
  })

  test("parallel spawns each make their own claim, and exactly the ones 50 Arms allowed start", async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 3, sub_agents: 0 }) } })
    const results = await Promise.all(Array.from({ length: 6 }, () => spawn($, { model: 'haiku' })))
    expect(d.claimAttempts.n).toBe(6)
    // whichever claims 50 Arms allowed (its count decides which), the plugin started those spawns and refused the others with the budget's reason
    expect(d.claimsAllowed.length).toBeGreaterThan(0)
    expect(started(results)).toHaveLength(d.claimsAllowed.length)
    for (const r of results.filter(r => r.agentId === undefined)) expect(r.deny).toMatch(/already run/)
    expect(d.claimsReleased).toEqual([])
  })

  test('a fork is denied like any spawn', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ level: 'critical', budget: 0 }) } })
    expect((await spawn($, { fork: true })).deny).toMatch(/critical/)
  })

  test('a tight fork is let through with its model untouched: a fork ignores the model', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ budget: 3, sub_agents: 2 }) } })
    expect((await spawn($, { fork: true, model: 'opus' })).model).toBe('opus')
  })

  // the claim asks 50 Arms now, every time: a verdict a tick has replaced is never decided on, in either direction
  test('the claim is decided on the answer as it is now: refused before, the very next spawn allowed after the dashboard changed', async ($, on) => {
    const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ level: 'critical', budget: 0 }) } }
    const d = await session($, on, options)
    expect((await spawn($)).deny).toMatch(/critical/)
    options.pacingLine = { body: wire({ budget: 12, sub_agents: 5 }) }
    await d.clock.advance(1_000)
    expect((await spawn($)).deny).toBeUndefined()
  })

  test('and the other way: allowed before, the very next spawn refused after the dashboard changed', async ($, on) => {
    const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) } }
    const d = await session($, on, options)
    expect((await spawn($)).deny).toBeUndefined()
    options.pacingLine = { body: wire({ budget: 3, sub_agents: 11 }) }
    await d.clock.advance(1_000)
    expect((await spawn($)).deny).toMatch(/sub-agent\(s\) already run on this account against budget 3/)
  })

  test('a relayed event never claims or reads the line: a slow dashboard cannot stall event delivery', async ($, on) => {
    const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ budget: 12 }) } }
    const d = await session($, on, options)
    const before = d.pacingReads.length
    d.relay.push({ cursor: 'c1', text: '[platform stream] Usage pacing for your Claude account changed: on pace.' })
    await d.clock.settle()
    expect(d.pacingReads).toHaveLength(before)
    expect(d.claimAttempts.n).toBe(0)
    expect(d.relay.delivered).toHaveLength(1)
  })

  test('the sub-agent that a claim started is handed the line of the answer that claimed it', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) } })
    await spawn($)
    expect(await subagentLine($, d)).toBe('Pacing line.')
  })

  // FAIL CLOSED (DX-5593): a signed-in session whose claim cannot be made is refused, because an allowed spawn there is an agent nobody counted
  describe('a claim that cannot be made refuses the spawn, and says why once', () => {
    test('a claim that outlasts its deadline: refused, told once; the late answer changes nothing', async ($, on) => {
      const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) } }
      const d = await session($, on, options)
      options.pacingHoldMs = PACING_READ_DEADLINE_MS + 1_000
      const pending = spawn($)
      await d.clock.advance(PACING_READ_DEADLINE_MS + 1)
      const r = await pending
      expect(r.deny).toMatch(/^Usage pacing: the spawn could not claim its slot/)
      expect(r.deny).toContain(`${PACING_READ_DEADLINE_MS} ms deadline`)
      expect(claimToasts(d)).toHaveLength(1)
      await d.clock.advance(1_000)
      options.pacingHoldMs = undefined
      expect((await spawn($)).deny).toBeUndefined()
    })

    test("an error answer (500) and the dashboard's 404: refused, told once however many spawns repeat it; the route recovering is seen at once", async ($, on) => {
      const options: Parameters<typeof dashboard>[1] = { pacingLine: { status: 500 } }
      const d = await session($, on, options)
      const from = d.toasts.length
      expect((await spawn($)).deny).toMatch(/answered 500/)
      expect((await spawn($)).deny).toMatch(/answered 500/)
      expect(claimToasts(d, from)).toHaveLength(1)
      options.pacingLine = { status: 404 }
      expect((await spawn($)).deny).toMatch(/answered 404/)
      expect(claimToasts(d, from)).toHaveLength(2)
      options.pacingLine = { body: wire({ budget: 12, sub_agents: 5 }) }
      expect((await spawn($)).deny).toBeUndefined()
    })

    test('a malformed answer is a failed claim, never an allow', async ($, on) => {
      const d = await session($, on, { pacingLine: { body: { nonsense: true } } })
      expect((await spawn($)).deny).toMatch(/could not claim its slot/)
      expect(claimToasts(d)).toHaveLength(1)
      expect(d.claimsAllowed).toEqual([])
    })

    test("a call auto mode's classifier refused is told as the person's sentence, never `answered 0`", async ($, on) => {
      const d = await session($, on, { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) } })
      d.setMcp('refused')
      expect((await spawn($)).deny).toContain(BLOCKED_LINE)
      expect(claimToasts(d)).toEqual([`Usage pacing could not claim a slot, so the spawn was refused (the budget is a strict cap): ${BLOCKED_LINE}`])
    })

    test('a call that never reached the server (status 0, no refusal) is told with its own reason', async ($, on) => {
      const d = await session($, on, { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) } })
      d.setMcp('flaky')
      expect((await spawn($)).deny).toContain('request timed out after 60000ms')
      expect(claimToasts(d)).toHaveLength(1)
      expect(claimToasts(d)[0]).toContain('mcp: 50arms: $.mcp.call: request timed out after 60000ms')
    })
  })

  // DX-5593 (C1): a claim the host's refusal gives back is told when the give-back fails; the 60 s lapse in 50 Arms stays the recovery
  describe('a claim that cannot be given back is told once per text, never silently', () => {
    test('an error answer (400): the host refusal still stands, told once however many repeat it', async ($, on) => {
      const d = await session($, on, { pacingLine: { body: wire({ budget: 9, sub_agents: 0 }) }, claimRelease: { status: 400 } })
      expect((await spawn($, { prompt: 'refuse' })).deny).toBe('host refused')
      expect((await spawn($, { prompt: 'refuse' })).deny).toBe('host refused')
      expect(giveBackToasts(d)).toHaveLength(1)
      expect(giveBackToasts(d)[0]).toContain('answered 400')
      expect(claimToasts(d)).toEqual([])
    })

    test('an error answer (500) is told once too, and a different text is told again', async ($, on) => {
      const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ budget: 9, sub_agents: 0 }) }, claimRelease: { status: 500 } }
      const d = await session($, on, options)
      await spawn($, { prompt: 'refuse' })
      await spawn($, { prompt: 'refuse' })
      expect(giveBackToasts(d)).toHaveLength(1)
      expect(giveBackToasts(d)[0]).toContain('answered 500')
      options.claimRelease = { status: 400 }
      await spawn($, { prompt: 'refuse' })
      expect(giveBackToasts(d)).toHaveLength(2)
    })

    test('{released:false} (a claim 50 Arms no longer holds) is normal: nothing is told', async ($, on) => {
      const d = await session($, on, { pacingLine: { body: wire({ budget: 9, sub_agents: 0 }) }, claimRelease: { body: { released: false } } })
      expect((await spawn($, { prompt: 'refuse' })).deny).toBe('host refused')
      expect(d.claimsReleased).toHaveLength(1)
      expect(giveBackToasts(d)).toEqual([])
    })

    test('an unreachable server of a signed-in session is told once', async ($, on) => {
      const d = await session($, on, { pacingLine: { body: wire({ budget: 9, sub_agents: 0 }) } })
      expect((await spawn($, { prompt: 'refuse-and-drop' })).deny).toBe('host refused')
      expect(giveBackToasts(d)).toHaveLength(1)
      expect(giveBackToasts(d)[0]).toContain('not reachable')
    })

    test('a give-back that throws or times out, for a signed-in session, is told once per text', async () => {
      for (const mode of ['throws', 'times out'] as const) {
        resetPacing()
        const toasts: string[] = []
        const env: PacingEnv = {
        agentGrade: () => Promise.resolve(undefined),
          now: () => Promise.resolve(0),
          within: mode === 'times out' ? (_ms, _work, onTimeout) => onTimeout() : (_ms, work) => work,
          call: mode === 'times out' ? () => new Promise<never>(() => {}) : () => Promise.reject(new Error('boom')),
          reading: () => Promise.resolve(null),
          signedIn: () => Promise.resolve(true),
          sleep: () => Promise.resolve(),
          toast: t => void toasts.push(t),
        }
        await releaseClaim(env, 'c1')
        await releaseClaim(env, 'c1')
        expect(toasts).toHaveLength(1)
        expect(toasts[0]).toContain('until it lapses')
      }
    })

    // DX-5593: a claim that crossed resetPacing (a new session start) is the old session's: it writes nothing into the new session's state. What it would
    // have written is observable on the next claim: hasSucceeded makes an unreachable server "known to be signed in", so that claim fails at once as unreachable.
    test('a claim still in flight across a new session start leaves the new session unmarked', async () => {
      resetPacing()
      const claimed = { account: 'uuid:u1', level: 'on_pace', budget: 5, resets_at: '2026-10-08T12:00:00.000Z', main_agents: 2, sub_agents: 0, reserved_agents: 0, line: 'Pacing line.', spend: null, limits: [{ limit: 'five_hour', level: 'on_pace', state: 'spare', headroom_minutes: 30, resets_in_minutes: 100, used_percent: 10, target_percent: 95, critical_percent: 99, resets_at: '2026-10-08T12:00:00.000Z' }], worst_limit: 'five_hour', reason: null, claimed: true, claim_id: 'claim-1' }
      let clock = 0
      let n = 0
      const env: PacingEnv = {
        agentGrade: () => Promise.resolve(undefined),
        now: () => Promise.resolve(clock),
        within: (_ms, work) => work,
        call: () => {
          n++
          if (n === 1) {
            resetPacing()
            return Promise.resolve({ ok: true, status: 200, body: claimed } as any)
          }
          return Promise.resolve({ unreachable: true } as any)
        },
        reading: () => Promise.resolve(null),
        signedIn: () => Promise.resolve(false),
        sleep: () => { clock += PACING_READ_DEADLINE_MS; return Promise.resolve() },
        toast: () => {},
      }
      expect((await claimSlot(env)).kind).toBe('claimed')
      const next = await claimSlot(env)
      expect(next.kind).toBe('failed')
      expect(next.kind === 'failed' && next.failure).not.toContain('not reachable')
    })

    // DX-5593: a give-back that crossed resetPacing (a new session start) is the old session's: it writes and tells nothing
    test('a give-back still in flight across a new session start tells nothing', async () => {
      resetPacing()
      const toasts: string[] = []
      const env: PacingEnv = { agentGrade: () => Promise.resolve(undefined), now: () => Promise.resolve(0), within: (_ms, work) => work, call: () => { resetPacing(); return Promise.reject(new Error('boom')) }, reading: () => Promise.resolve(null), signedIn: () => Promise.resolve(true), sleep: () => Promise.resolve(), toast: t => void toasts.push(t) }
      await releaseClaim(env, 'c1')
      expect(toasts).toEqual([])
    })

    test('a good give-back clears its slot: the same failure after it is told again', async () => {
      resetPacing()
      const toasts: string[] = []
      const answers = [{ ok: false, status: 500, body: { error: 'boom' } }, { ok: true, status: 200, body: { released: true } }, { ok: false, status: 500, body: { error: 'boom' } }]
      const env: PacingEnv = { agentGrade: () => Promise.resolve(undefined), now: () => Promise.resolve(0), within: (_ms, work) => work, call: () => Promise.resolve(answers.shift()!), reading: () => Promise.resolve(null), signedIn: () => Promise.resolve(true), sleep: () => Promise.resolve(), toast: t => void toasts.push(t) }
      await releaseClaim(env, 'c1')
      await releaseClaim(env, 'c2')
      await releaseClaim(env, 'c3')
      expect(toasts).toHaveLength(2)
      expect(toasts[0]).toBe(toasts[1])
      expect(toasts[0]).toContain('answered 500')
    })

    test('a good give-back tells nothing', async ($, on) => {
      const d = await session($, on, { pacingLine: { body: wire({ budget: 9, sub_agents: 0 }) } })
      await spawn($, { prompt: 'refuse' })
      expect(d.claimsReleased).toHaveLength(1)
      expect(giveBackToasts(d)).toEqual([])
    })
  })

  // a refusal told once is told again when it comes back after a good claim
  test('a good claim resets the once-per-text rule of the claim toasts', async ($, on) => {
    const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) } }
    const d = await session($, on, options)
    options.pacingLine = { status: 500 }
    expect((await spawn($)).deny).toMatch(/answered 500/)
    expect((await spawn($)).deny).toMatch(/answered 500/)
    expect(claimToasts(d)).toHaveLength(1)
    options.pacingLine = { body: wire({ budget: 12, sub_agents: 5 }) }
    expect((await spawn($)).deny).toBeUndefined()
    options.pacingLine = { status: 500 }
    expect((await spawn($)).deny).toMatch(/answered 500/)
    expect(claimToasts(d)).toHaveLength(2)
  })

  // DX-5593 (B1): whether a session is outside pacing is a fact about the session, never about the connection
  describe('a session known to be signed in whose server cannot be reached is refused', () => {
    test('the server drops after a good claim: the spawn is refused, one toast that says it was refused', async ($, on) => {
      const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) } }
      const d = await session($, on, options)
      expect((await spawn($)).deny).toBeUndefined()
      options.mcp = 'down'
      const r = await spawn($)
      expect(r.deny).toMatch(/^Usage pacing: the spawn could not claim its slot/)
      expect(r.deny).toContain('not reachable')
      expect(claimToasts(d)).toHaveLength(1)
      expect(claimToasts(d)[0]).not.toContain('not paced')
      expect(d.claimsAllowed).toHaveLength(1)
    })

    // the session-start read failed, so no read or claim has succeeded: only the plan view says the session is signed in (`env.signedIn()`)
    test('the session-start pacing read failed, the session is signed in, and the server then drops: refused, not looked for again', async ($, on) => {
      const options: Parameters<typeof dashboard>[1] = { pacingLine: { status: 500 } }
      const d = await session($, on, options)
      options.mcp = 'down'
      const pending = spawn($)
      await d.clock.advance(PACING_READ_DEADLINE_MS + 1)
      const r = await pending
      expect(r.deny).toMatch(/^Usage pacing: the spawn could not claim its slot/)
      expect(r.deny).toContain('not reachable')
      expect(d.claimsAllowed).toEqual([])
    })

    test('the server drops before any claim, with the plan view loaded: refused', async ($, on) => {
      const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) } }
      await session($, on, options)
      options.mcp = 'down'
      expect((await spawn($)).deny).toMatch(/^Usage pacing:/)
    })
  })

  // A 50 Arms-dispatched agent (the orchestrator profile) runs this plugin's hooks, but its clean-room MCP config (`--strict-mcp-config`) names the
  // dashboard server `platform` and loads no plugin server, so the claim must reach the server the session really has.
  describe('the claim reaches the dashboard server the session has', () => {
    const DISPATCHED = [DISPATCHED_SERVER]

    test('a dispatched session (only `platform`): the spawn is claimed through it and starts', async ($, on) => {
      const d = await session($, on, { servers: DISPATCHED, pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) } })
      const r = await spawn($)
      expect(r.deny).toBeUndefined()
      expect(d.claimsAllowed).toHaveLength(1)
      expect(claimToasts(d)).toEqual([])
      expect(d.serversCalled.has(DISPATCHED_SERVER)).toBe(true)
    })

    test("a dispatched session's claim is judged by 50 Arms like any other: a critical verdict still refuses", async ($, on) => {
      await session($, on, { servers: DISPATCHED, pacingLine: { body: wire({ level: 'critical', budget: 0 }) } })
      expect((await spawn($)).deny).toMatch(/critical/)
    })

    test("a dispatched session's give-back of a claim the host refused reaches the same server", async ($, on) => {
      const d = await session($, on, { servers: DISPATCHED, pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) } })
      expect((await spawn($, { prompt: 'refuse' })).deny).toBe('host refused')
      expect(d.claimsAllowed).toHaveLength(1)
      expect(d.claimsReleased).toEqual(d.claimsAllowed)
      expect(giveBackToasts(d)).toEqual([])
    })

    test('a dispatched session whose server connects after the first look is claimed against once it is listed', async ($, on) => {
      const options: Parameters<typeof dashboard>[1] = { servers: DISPATCHED, mcp: 'down', pacingLine: { body: wire({ level: 'critical', budget: 0 }) } }
      const d = await session($, on, options)
      const spawning = spawn($)
      await d.clock.settle()
      await d.clock.advance(1_000)
      options.mcp = 'up'
      await d.clock.advance(1_000)
      expect((await spawning).deny).toMatch(/critical/)
    })

    test("an operator session (the plugin's own server) keeps calling that name only", async ($, on) => {
      const d = await session($, on, { pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) } })
      expect((await spawn($)).deny).toBeUndefined()
      expect([...d.serversCalled]).toEqual([SERVER])
    })

    test('a session with both servers is claimed through the plugin\'s own', async ($, on) => {
      const d = await session($, on, { servers: [DISPATCHED_SERVER, SERVER], pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) } })
      expect((await spawn($)).deny).toBeUndefined()
      expect(d.serversCalled.has(DISPATCHED_SERVER)).toBe(false)
    })

    test('a session with neither server is still refused, the strict cap: nothing is claimed', async ($, on) => {
      const d = await session($, on, { servers: [], pacingLine: { body: wire({ budget: 12, sub_agents: 5 }) } })
      const pending = spawn($)
      await d.clock.advance(PACING_READ_DEADLINE_MS + 1)
      expect((await pending).deny).toMatch(/^Usage pacing: the spawn could not claim its slot from 50 Arms \(the dashboard MCP server never connected in this session\)/)
      expect(d.claimsAllowed).toEqual([])
    })
  })

  // outside pacing: 50 Arms counts none of the agents of a session it does not know, so it holds none of its spawns
  describe('a session outside pacing is allowed, silently, with nothing claimed', () => {
    test("no dashboard MCP server connected: every spawn looks again until the claim's own deadline, then is refused, told once", async ($, on) => {
      const options: Parameters<typeof dashboard>[1] = { mcp: 'down' }
      const d = await session($, on, options)
      // the fake clock runs past the plugin's own deadline, so it is that deadline that ends each spawn's wait, not the engine's hook budget
      for (let i = 0; i < 2; i++) {
        const pending = spawn($)
        await d.clock.advance(PACING_READ_DEADLINE_MS + 1)
        expect((await pending).deny).toMatch(/never connected/)
      }
      expect(d.toasts.filter(t => t.startsWith('Usage pacing'))).toHaveLength(1)
      // each spawn looked again more than once inside its deadline
      expect(d.claimAttempts.n).toBeGreaterThanOrEqual(4)
      options.mcp = 'up'
      options.pacingLine = { body: wire({ level: 'critical', budget: 0 }) }
      expect((await spawn($)).deny).toMatch(/critical/)
    })

    test('a server that never connects in the claim deadline: refused, nothing claimed (DX-5593 problem 2503: refuse it)', async ($, on) => {
      const d = await session($, on, { mcp: 'down' })
      const pending = spawn($)
      await d.clock.advance(PACING_READ_DEADLINE_MS + 1)
      expect((await pending).deny).toMatch(/^Usage pacing: the spawn could not claim its slot from 50 Arms \(the dashboard MCP server never connected in this session\)/)
      expect(d.claimsAllowed).toEqual([])
      expect(d.toasts.filter(t => t.startsWith('Usage pacing'))).toEqual([expect.stringContaining('never connected')])
    })

    test('a server that connects within the claim deadline is claimed against, not skipped', async ($, on) => {
      const options: Parameters<typeof dashboard>[1] = { mcp: 'down', pacingLine: { body: wire({ level: 'critical', budget: 0 }) } }
      const d = await session($, on, options)
      const spawning = spawn($)
      // the server is not up at the first look: it comes up between looks, and only the poll loop finds it
      await d.clock.settle()
      await d.clock.advance(1_000)
      options.mcp = 'up'
      await d.clock.advance(1_000)
      expect((await spawning).deny).toMatch(/critical/)
    })
    test('a signed-out session (never signed in, lapsed, revoked): allowed, nothing told', async ($, on) => {
      const d = await session($, on, { pacingLine: { body: wire({ level: 'critical', budget: 0 }) } })
      d.world.signedOut = 'lapsed'
      expect((await spawn($)).deny).toBeUndefined()
      expect(claimToasts(d)).toEqual([])
    })
  })

  test('reads the line at session start, and a spawn claims instead of reading it', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire() } })
    expect(d.pacingReads).toHaveLength(1)
    await spawn($)
    await spawn($)
    expect(d.pacingReads).toHaveLength(1)
    expect(d.claimAttempts.n).toBe(2)
  })

  test('critical stops sub-agents only (CP-13): the main thread is neither paused nor refused, however many main agents run', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ level: 'critical', budget: 0, main_agents: 40 }) } })
    expect((await spawn($)).deny).toMatch(/^Usage pacing: this account is critical/)
    expect(d.claimsAllowed).toEqual([])
    // the plugin writes no session pause of its own
    expect(d.calls.filter((c: any) => c.args?.method === 'PUT' && String(c.args?.path).includes('/pause'))).toEqual([])
  })

  test('the main agent count never decides a spawn: only the sub-agent count does (CP-13)', () => {
    expect(decideSpawn(v({ budget: 5, mainAgents: 99, subAgents: 1 }), 'opus', false)).toEqual({ kind: 'allow' })
  })

  test('a tool call of any tool is never denied under a critical verdict: saving work stays possible', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ level: 'critical', budget: 0 }) } })
    for (const tool of ['Bash', 'Write', 'mcp__plugin_50arms_platform__50arms_api']) {
      const r = await $.tool.call({ tool, command: 'git commit -m x' } as any)
      expect(r.deny).toBeUndefined()
      expect(r.isError).not.toBe(true)
      expect(r.text).toBe('ran')
    }
  })
})

describe('failures of the guard itself', () => {
  test('a hook error (a rejecting clock) is told once per text, never a toast per spawn, and the spawn is refused: it could not claim its slot', async () => {
    resetPacing()
    const toasts: string[] = []
    const env: PacingEnv = { agentGrade: () => Promise.resolve(undefined), now: () => Promise.reject(new Error('clock down')), within: (_ms, work) => work, call: () => Promise.reject(new Error('never reached')), reading: () => Promise.resolve(null), signedIn: () => Promise.resolve(false), sleep: () => Promise.resolve(), toast: t => void toasts.push(t) }
    const started = { model: 'm', agentId: 'a' }
    const guard = spawnGuard(env)
    const e = { prompt: 'p', subagentType: 'general-purpose', background: false, fork: false, parentModel: 'opus' } as any
    for (let i = 0; i < 2; i++) expect((await guard(e, async () => started)).deny).toMatch(/^Usage pacing: the spawn could not claim its slot.*clock down/)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('clock down')
  })

  // DX-5595: 50 Arms refused the claim for held slots, but the verdict it answered with reads as room to the plugin's own order (the figures moved between the
  // judgment and the answer): the refusal still stands, worded as held slots, never as a full budget or a level
  test('a claim 50 Arms refused whose verdict the plugin would allow is still refused, worded as held slots', async () => {
    resetPacing()
    const refused = { account: 'uuid:u1', level: 'on_pace', budget: 3, resets_at: RESET, main_agents: 2, sub_agents: 1, reserved_agents: 1, line: 'Pacing line.', spend: null, limits: [{ limit: 'five_hour', level: 'on_pace', state: 'spare', headroom_minutes: 60, resets_in_minutes: 100, used_percent: 3, target_percent: 95, critical_percent: 99, resets_at: RESET }], worst_limit: 'five_hour', reason: null, claimed: false, claim_id: null, refusal: 'reserved' }
    const env: PacingEnv = { agentGrade: () => Promise.resolve(undefined), now: () => Promise.resolve(0), within: (_ms, work) => work, call: () => Promise.resolve({ ok: true, status: 200, body: refused } as any), reading: () => Promise.resolve(null), signedIn: () => Promise.resolve(true), sleep: () => Promise.resolve(), toast: () => {} }
    const e = { prompt: 'p', subagentType: 'general-purpose', background: false, fork: false, parentModel: 'opus' } as any
    let started = false
    const r = await spawnGuard(env)(e, async () => { started = true; return { model: 'm', agentId: 'a' } as any })
    expect(started).toBe(false)
    expect(r.deny).toMatch(/1 sub-agent\(s\) run on this account and 1 slot\(s\) are held for sessions that waited longer/)
    expect(r.deny).not.toMatch(/already run/)
  })

  // DX-8451 (DEC-3533 v4, DEC-3538 v2): the refusal of a queued session carries its ticket into the words; an old answer with no ticket keeps the old cause
  test('a claim refused with a queue ticket names the ticket; an answer with no ticket names none', async () => {
    resetPacing()
    const queued = { account: 'uuid:u1', level: 'on_pace', budget: 3, resets_at: RESET, main_agents: 2, sub_agents: 3, reserved_agents: 0, line: 'Pacing line.', spend: null, limits: [], worst_limit: null, reason: null, claimed: false, claim_id: null, refusal: 'budget', ticket: { id: 'tkt-7', place: 1, state: 'waiting' } }
    const env = (body: object): PacingEnv => ({ agentGrade: () => Promise.resolve(undefined), now: () => Promise.resolve(0), within: (_ms, work) => work, call: () => Promise.resolve({ ok: true, status: 200, body } as any), reading: () => Promise.resolve(null), signedIn: () => Promise.resolve(true), sleep: () => Promise.resolve(), toast: () => {} })
    const e = { prompt: 'p', subagentType: 'general-purpose', background: false, fork: false, parentModel: 'opus' } as any
    const started = async () => ({ model: 'm', agentId: 'a' }) as any
    const r = await spawnGuard(env(queued))(e, started)
    expect(r.deny).toContain('ticket tkt-7, place 1')
    expect(r.deny).not.toMatch(/retry/i)
    const old = await spawnGuard(env({ ...queued, ticket: undefined }))(e, started)
    expect(old.deny).toMatch(/^Usage pacing: 3 sub-agent\(s\) already run/)
    expect(old.deny).not.toContain('ticket')
  })

  // DX-8451 (DEC-3533): a granted ready ticket reads no figures: the spawn goes through with no client-side budget refusal, and a host refusal gives the claim back by its token
  test('a granted ready ticket (no figures) starts the spawn, and the host refusal gives its claim back by the token the claim carried', async () => {
    resetPacing()
    const tokens: string[] = []
    const granted = { account: null, level: null, budget: null, resets_at: null, main_agents: null, sub_agents: null, reserved_agents: null, line: null, spend: null, limits: null, worst_limit: null, reason: null, claimed: true, claim_id: 'claim-9', refusal: null, ticket: null }
    const env: PacingEnv = {
      agentGrade: () => Promise.resolve(undefined),
      now: () => Promise.resolve(0),
      within: (_ms, work) => work,
      call: (method: string, path: string, body?: object) => {
        if (method === 'POST') tokens.push((body as any).client_token)
        if (method === 'DELETE') expect(path).toBe(`/api/pacing/agents/claim?client_token=${encodeURIComponent(tokens[0]!)}`)
        return Promise.resolve({ ok: true, status: 200, body: method === 'DELETE' ? { released: true } : granted } as any)
      },
      reading: () => Promise.resolve(null),
      signedIn: () => Promise.resolve(true),
      sleep: () => Promise.resolve(),
      toast: () => {},
    }
    const e = { prompt: 'p', subagentType: 'general-purpose', background: false, fork: false, parentModel: 'opus' } as any
    let started = false
    const r = await spawnGuard(env)(e, async () => { started = true; return { deny: 'host refused' } as any })
    expect(started).toBe(true)
    expect(r.deny).toBe('host refused')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatch(/\S/)
  })

  // DX-5595: the refusal is worded from the cause 50 Arms names, not from the plugin's own reading of the figures it came with
  test('the wording follows the cause 50 Arms names, even when the figures read otherwise', async () => {
    resetPacing()
    const answer = (refusal: unknown) => ({ account: 'uuid:u1', level: 'on_pace', budget: 3, resets_at: RESET, main_agents: 2, sub_agents: 1, reserved_agents: 1, line: 'Pacing line.', spend: null, limits: [{ limit: 'five_hour', level: 'on_pace', state: 'spare', headroom_minutes: 60, resets_in_minutes: 100, used_percent: 3, target_percent: 95, critical_percent: 99, resets_at: RESET }], worst_limit: 'five_hour', reason: null, claimed: false, claim_id: null, refusal })
    const deny = async (refusal: unknown) => {
      resetPacing()
      const env: PacingEnv = { agentGrade: () => Promise.resolve(undefined), now: () => Promise.resolve(0), within: (_ms, work) => work, call: () => Promise.resolve({ ok: true, status: 200, body: answer(refusal) } as any), reading: () => Promise.resolve(null), signedIn: () => Promise.resolve(true), sleep: () => Promise.resolve(), toast: () => {} }
      const e = { prompt: 'p', subagentType: 'general-purpose', background: false, fork: false, parentModel: 'opus' } as any
      return (await spawnGuard(env)(e, async () => ({ model: 'm', agentId: 'a' }) as any)).deny
    }
    expect(await deny('budget')).toMatch(/1 sub-agent\(s\) already run on this account against budget 3/)
    expect(await deny('level')).toMatch(/this account is on pace/)
    expect(await deny('reserved')).toMatch(/slot\(s\) are held for sessions that waited longer/)
  })

  test('a refused claim that names no valid cause fails closed as a failed claim', async () => {
    for (const refusal of [undefined, null, 'full']) {
      resetPacing()
      const body = { account: 'uuid:u1', level: 'on_pace', budget: 3, resets_at: RESET, main_agents: 2, sub_agents: 1, reserved_agents: 1, line: 'Pacing line.', spend: null, limits: [{ limit: 'five_hour', level: 'on_pace', state: 'spare', headroom_minutes: 60, resets_in_minutes: 100, used_percent: 3, target_percent: 95, critical_percent: 99, resets_at: RESET }], worst_limit: 'five_hour', reason: null, claimed: false, claim_id: null, refusal }
      const env: PacingEnv = { agentGrade: () => Promise.resolve(undefined), now: () => Promise.resolve(0), within: (_ms, work) => work, call: () => Promise.resolve({ ok: true, status: 200, body } as any), reading: () => Promise.resolve(null), signedIn: () => Promise.resolve(true), sleep: () => Promise.resolve(), toast: () => {} }
      const e = { prompt: 'p', subagentType: 'general-purpose', background: false, fork: false, parentModel: 'opus' } as any
      expect((await spawnGuard(env)(e, async () => ({ model: 'm', agentId: 'a' }) as any)).deny).toMatch(/could not claim its slot.*without naming a valid cause/)
    }
  })

  test('a refusal starts with the prefix the skill quotes', () => {
    expect(denyReason(v({ level: 'critical', budget: 0 }), 'level', null).startsWith(REFUSAL_PREFIX)).toBe(true)
  })
})

describe('a second session in the same process', () => {
  test('never inherits the previous session\'s last good answer or state', async ($, on) => {
    resetPacing()
    on('agent.spawn', (_$: any, e: any) => ({ model: e.model ?? 'm', agentId: 'new' }) as any)
    const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ level: 'critical', budget: 0 }) } }
    const d = dashboard(on, options)
    await startSession($, d, 'desktop')
    expect((await $.agent.spawn({ prompt: 'p', subagentType: 'general-purpose' })).deny).toMatch(/critical/)
    // the next session's claim fails: it is refused as a failed claim, never paced by the last session's critical answer
    options.pacingLine = { status: 500 }
    await startSession($, d, 'desktop')
    const next = (await $.agent.spawn({ prompt: 'p', subagentType: 'general-purpose' })).deny
    expect(next).toMatch(/could not claim its slot/)
    expect(next).not.toMatch(/critical/)
  })
})

describe('what register wires', () => {
  test('agent.spawn carries the pacing guard, and no tool.call handler can carry it', () => {
    const wired: { event: string; matcher: unknown }[] = []
    register(((event: string, ...rest: unknown[]) => void wired.push({ event, matcher: rest.length > 1 ? rest[0] : undefined })) as any, {} as any)
    expect(wired.filter(w => w.event === 'agent.spawn')).toHaveLength(1)
    // every tool.call hook is matched to one dashboard tool, but the time stamp (DX-4234), which only adds context to a finished call and
    // answers its result as it came (context-stamp.test.tsx): the guard is no tool.call handler, so none can sit on a commit, push or card write
    const toolCalls = wired.filter(w => w.event === 'tool.call')
    expect(toolCalls.filter(w => w.matcher === undefined)).toHaveLength(1)
    const matched = toolCalls.filter(w => w.matcher !== undefined)
    expect(matched.length).toBeGreaterThan(0)
    const toolOf = (w: { matcher: unknown }) => (w.matcher as { tool?: string })?.tool ?? ''
    // `Write` and `Skill` are the two other tools: onHandoffWrite and onReadySkill are pass-throughs that only append context after `next` (the skill's, only when the ready skill loads), so the guard never sits on them
    // CP-93: the desktop's `set_session_title` is the third: onModelSetTitle holds the title lock around the model's rename, a tool that writes no commit, push or card
    for (const w of matched.filter(w => !/__50arms_api$/.test(toolOf(w)) && toolOf(w) !== 'Write' && toolOf(w) !== 'Skill' && toolOf(w) !== 'mcp__ccd_session_mgmt__set_session_title')) expect(toolOf(w)).toMatch(/^mcp__(plugin_50arms_platform|platform)__(session_connect|request_permission)$/)
    // DX-5846: 50arms_api carries every card write, so exactly ONE handler may sit on it: onAckCall, a pass-through that acts only on the acknowledgement route
    // (POST /api/plan-sessions/me/events/<N>/ack); a second one would reach every card write, push and commit the guard must stay off
    expect(matched.filter(w => /__50arms_api$/.test(toolOf(w)))).toHaveLength(1)
  })
})

describe('the hourglass on the desktop title', () => {
  const HOURGLASS = HOURGLASS_TITLE_MARK
  const GREEN = CONNECTED_TITLE_MARK

  test('a refused spawn shows the hourglass at once; an admitted spawn after a free slot clears it', async ($, on) => {
    resetPacing()
    on('agent.spawn', async (_$: any, e: any) => ({ model: e.model ?? 'parent-model', agentId: 'new' }) as any)
    on('tool.call', () => ({ result: {}, text: 'ran', isError: false }) as any)
    on('classic.SubagentStart', () => ({}) as any)
    const d = dashboard(on, { pacingLine: { body: wire({ level: 'over_pace', budget: 0 }) } })
    d.world.agent = { id: 9, name: 'Tendai', avatar_url: null }
    for (const c of d.world.cards) for (const p of c.problems) p.open = false
    await startSession($, d, 'desktop')
    const app = d.world.appSession
    expect(app.title).toBe(`${GREEN}Tendai: PLAN-23 Agent mode`)
    const refused = await $.agent.spawn({ prompt: 'work', subagentType: 'general-purpose' })
    await d.clock.settle()
    expect(refused.deny).toMatch(/Usage pacing/)
    expect(app.title).toBe(`${HOURGLASS}Tendai: PLAN-23 Agent mode`)
    // the account gets a free slot: the next spawn is admitted, and the title drops the hourglass for green
    d.setPacingLine({ body: wire({ budget: null, sub_agents: 0 }) })
    const admitted = await $.agent.spawn({ prompt: 'work', subagentType: 'general-purpose' })
    await d.clock.settle()
    expect(admitted.deny).toBeUndefined()
    expect(app.title).toBe(`${GREEN}Tendai: PLAN-23 Agent mode`)
  })
})
