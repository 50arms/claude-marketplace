import "./run-tests-with-npm-test.generated"
// DX-5344: whose compaction a resume briefing follows. Claude Code's classic SessionStart input never names the agent that compacted (2.1.299: its `agent_id` is always absent),
// so the plugin notes WHO compacts at the `session.compact` proposal that passed and reads that note when the `compact` start arrives. A sub-agent's compaction briefs THAT sub-agent
// (once, in its next tool result, never the main agent's prompt); the main agent's own compaction briefing is unchanged.
// CP-109 (DEC-832): a sub-agent briefed with a profile line (`work CP-109`, `research PLAN-122`) is told to fetch that profile's instruction again, since
// the compaction dropped the mantra and role text it carried; and every signed-in session's sub-agent is briefed, plan-connected or not.
import { describe, expect } from 'claude-code/testing'

import { subagentBriefingText } from '../hooks/compaction/briefing'
import { SURFACES, dashboard, startSession, test } from './plan-kit'

const COMPACTED = { messages: [{ role: 'user', text: 'the summary', toolUses: [] }] }
const TRANSCRIPT = [{ role: 'user', text: 'go', toolUses: [], handle: 'm1' }]
const AGENT = { id: 'a1', type: '50arms:worker-sonnet-high', description: 'build the thing', status: 'running' }
// the line only the main agent's briefing carries (a sub-agent's opens with the same words but names no plan; the running AGENT is listed in the main one, so the whole text is not pinned)
const MAIN = 'Your plan is PLAN-23 50 Arms plugin.'
const WORK = { profile: 'work', target: { kind: 'card' as const, id: 'CP-109' }, gate: null }
const RESEARCH = { profile: 'research', target: { kind: 'plan' as const, id: 'PLAN-122' }, gate: null }
const REVIEWER = { profile: 'gate-reviewer', target: { kind: 'card' as const, id: 'DX-9' }, gate: 'code-quality' }

describe('the sub-agent briefing text (pure)', () => {
  test('names the agent and its task, points at its own summary and progress notes, and carries no plan or card', () => {
    const text = subagentBriefingText({ id: 'a1', type: '50arms:worker-sonnet-high', description: 'build the thing', profile: null })
    expect(text).toMatch(/^\[50 ARMS\] Your conversation was just compacted\./)
    expect(text).toContain('a1 (50arms:worker-sonnet-high) build the thing')
    expect(text).toMatch(/progress notes/)
    expect(text).not.toMatch(/Cards in flight|Your plan is/)
  })

  test('an agent the engine does not list is briefed by its id alone', () => {
    expect(subagentBriefingText({ id: 'a9', type: null, description: null, profile: null })).toContain('You are sub-agent a9.')
  })

  test("a card profile brief is told to fetch that profile's instruction for the card again, before it resumes, and its card is not called its parent's", () => {
    const text = subagentBriefingText({ id: 'a1', type: '50arms:worker-sonnet-high', description: 'build the thing', profile: WORK })
    expect(text).toMatch(/^\[50 ARMS\] Your conversation was just compacted\./)
    expect(text).toContain('a1 (50arms:worker-sonnet-high) build the thing')
    expect(text).toContain("your brief's first line is `work CP-109`")
    expect(text).toContain('`GET /api/agent-profiles/work/instruction?card=CP-109`')
    expect(text).toMatch(/mantra/)
    expect(text.indexOf('/api/agent-profiles/')).toBeLessThan(text.indexOf('progress notes'))
    expect(text).not.toMatch(/your parent's, not yours/)
  })

  test("a plan profile brief fetches with ?plan=, and a gate reviewer's names its gate", () => {
    const plan = subagentBriefingText({ id: 'a2', type: null, description: null, profile: RESEARCH })
    expect(plan).toContain("your brief's first line is `research PLAN-122`")
    expect(plan).toContain('`GET /api/agent-profiles/research/instruction?plan=PLAN-122`')
    const gate = subagentBriefingText({ id: 'a3', type: null, description: null, profile: REVIEWER })
    expect(gate).toContain("your brief's first line is `gate-reviewer DX-9 code-quality`")
    expect(gate).toContain('`GET /api/agent-profiles/gate-reviewer/instruction?card=DX-9&gate=code-quality`')
  })

  test('a brief with no profile line names no fetch', () => {
    expect(subagentBriefingText({ id: 'a1', type: null, description: null, profile: null })).not.toMatch(/agent-profiles/)
  })
})

for (const surface of SURFACES) {
  describe(`whose compaction the briefing follows on ${surface}`, () => {
    async function started($: any, on: any) {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.PreCompact', () => ({}) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      // what core does with a proposal that passed: by agent ('main' for the main agent), compact, answer a skip, or throw
      const core = new Map<string, 'skip' | 'throw'>()
      const hold = new Map<string, Promise<void>>()
      on('session.compact', async (_$: any, e: any) => {
        await hold.get(e.agentId ?? 'main')
        const mode = core.get(e.agentId ?? 'main')
        if (mode === 'throw') throw new Error('compaction failed')
        return (mode === 'skip' ? { skip: 'no' } : COMPACTED) as any
      })
      on('classic.SubagentStop', () => ({}) as any)
      on('agent.spawn', () => ({ model: 'm', agentId: 'new' }) as any)
      on('classic.SubagentStart', () => ({}) as any)
      const d = dashboard(on, {})
      d.world.agents = [AGENT, { ...AGENT, id: 'a2', description: 'the other task' }]
      await startSession($, d, surface)
      const propose = (agentId?: string, trigger = 'auto') => $.session.compact({ trigger, messages: TRANSCRIPT, ...(agentId === undefined ? {} : { agentId }) })
      const compactStart = () => $.classic.SessionStart({ source: 'compact', cwd: '/work', session_id: 'own', transcript_path: '/work/main.jsonl' })
      const prompt = async () => ((await $.prompt.submit({ text: 'hello' })).context ?? []) as string[]
      const toolResult = async (agentId?: string) => (((await $.tool.call({ tool: 'Bash', command: 'ls', ...(agentId === undefined ? {} : { agentId }) } as any)).context ?? []) as string[])
      return { d, core, hold, propose, compactStart, prompt, toolResult, stop: (id: string) => $.classic.SubagentStop({ agent_id: id, agent_type: AGENT.type }) }
    }
    const briefings = (lines: string[]) => lines.filter(l => l.includes('Your conversation was just compacted'))

    test("a sub-agent's compaction adds no briefing to the main agent's next prompt", async ($, on) => {
      const k = await started($, on)
      await k.propose('a1')
      await k.compactStart()
      expect(briefings(await k.prompt())).toEqual([])
    })

    test("the sub-agent that compacted gets its own briefing in its next tool result, once, and no other agent or the main loop gets it", async ($, on) => {
      const k = await started($, on)
      await k.propose('a1')
      await k.compactStart()
      expect(briefings(await k.toolResult('a2'))).toEqual([])
      expect(briefings(await k.toolResult())).toEqual([])
      const own = briefings(await k.toolResult('a1'))
      expect(own).toEqual([subagentBriefingText({ id: 'a1', type: AGENT.type, description: AGENT.description, profile: null })])
      expect(briefings(await k.toolResult('a1'))).toEqual([])
    })

    test("the main agent's own automatic compaction still briefs the main agent once, and no sub-agent", async ($, on) => {
      const k = await started($, on)
      await k.propose()
      await k.compactStart()
      expect(briefings(await k.toolResult('a1'))).toEqual([])
      const first = await k.prompt()
      expect(first.join('\n')).toContain(MAIN)
    })

    test("a person's /compact (manual) beside a sub-agent's compaction: the main agent is briefed for it, the sub-agent for its own", async ($, on) => {
      const k = await started($, on)
      await k.propose('a1')
      await k.propose(undefined, 'manual')
      await k.compactStart()
      expect(briefings(await k.toolResult('a1'))).toHaveLength(1)
      expect((await k.prompt()).join('\n')).toContain(MAIN)
    })

    test('a proposal that was only computed ahead (precompute) names nobody: a start after it is the main agent\'s', async ($, on) => {
      const k = await started($, on)
      await k.propose('a1', 'precompute')
      await k.compactStart()
      expect(briefings(await k.toolResult('a1'))).toEqual([])
      expect((await k.prompt()).join('\n')).toContain(MAIN)
    })

    test("a sub-agent's note that is not followed by a start within the window is dropped: a later start is the main agent's", async ($, on) => {
      const k = await started($, on)
      await k.propose('a1')
      await k.d.clock.advance(11 * 60_000)
      await k.compactStart()
      expect(briefings(await k.toolResult('a1'))).toEqual([])
      expect((await k.prompt()).join('\n')).toContain(MAIN)
    })

    test("two sub-agents compacting together each get their own briefing and the main agent gets none (both restarts first, then each tool call, in the opposite order of the proposals)", async ($, on) => {
      const k = await started($, on)
      await Promise.all([k.propose('a1'), k.propose('a2')])
      await k.compactStart()
      await k.compactStart()
      expect(briefings(await k.prompt())).toEqual([])
      expect(briefings(await k.toolResult('a2'))).toEqual([subagentBriefingText({ id: 'a2', type: AGENT.type, description: 'the other task', profile: null })])
      expect(briefings(await k.toolResult('a1'))).toEqual([subagentBriefingText({ id: 'a1', type: AGENT.type, description: AGENT.description, profile: null })])
      expect(briefings(await k.toolResult('a1'))).toEqual([])
      expect(briefings(await k.toolResult('a2'))).toEqual([])
    })

    test("a sub-agent compacting while the main agent does: the main agent is briefed once, the sub-agent once", async ($, on) => {
      const k = await started($, on)
      await Promise.all([k.propose('a1'), k.propose()])
      await k.compactStart()
      await k.compactStart()
      expect((await k.prompt()).filter(l => l.includes(MAIN))).toHaveLength(1)
      expect(briefings(await k.prompt())).toEqual([])
      expect(briefings(await k.toolResult('a1'))).toHaveLength(1)
      expect(briefings(await k.toolResult('a1'))).toEqual([])
    })

    test("a sub-agent is not briefed before its own compaction finished", async ($, on) => {
      const k = await started($, on)
      let release: () => void = () => {}
      const held = new Promise<void>(r => void (release = r))
      k.hold.set('a1', held)
      const proposal = k.propose('a1')
      await k.d.clock.settle()
      expect(briefings(await k.toolResult('a1'))).toEqual([])
      release()
      await proposal
      await k.compactStart()
      expect(briefings(await k.toolResult('a1'))).toHaveLength(1)
    })

    test("a compaction that was skipped or failed leaves no note: a later unattributable start is the main agent's", async ($, on) => {
      const k = await started($, on)
      k.core.set('a1', 'skip')
      await k.propose('a1')
      k.core.set('a1', 'throw')
      await k.propose('a1').catch(() => undefined)
      await k.compactStart()
      expect(briefings(await k.toolResult('a1'))).toEqual([])
      expect((await k.prompt()).join('\n')).toContain(MAIN)
    })

    test('a sub-agent that stopped before its start came leaves no note either', async ($, on) => {
      const k = await started($, on)
      await k.propose('a1')
      await k.stop('a1')
      await k.compactStart()
      expect((await k.prompt()).join('\n')).toContain(MAIN)
    })

    test("a sub-agent spawned with a profile line is told to fetch that profile's instruction again (CP-109)", async ($, on) => {
      const k = await started($, on)
      await $.agent.spawn({ prompt: 'research PLAN-122\nread the plan and report', subagentType: AGENT.type })
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: AGENT.type })
      await k.propose('a1')
      await k.compactStart()
      expect(briefings(await k.toolResult('a1'))).toEqual([subagentBriefingText({ id: 'a1', type: AGENT.type, description: AGENT.description, profile: RESEARCH })])
    })

    // a session on no plan: its sub-agent is spawned (with a profile line or not), started, compacted, and read back in its next tool result
    async function noPlanSession($: any, on: any, options: Parameters<typeof dashboard>[1]) {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.PreCompact', () => ({}) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      on('session.compact', async () => COMPACTED as any)
      on('agent.spawn', () => ({ model: 'm', agentId: 'new' }) as any)
      on('classic.SubagentStart', () => ({}) as any)
      const d = dashboard(on, options)
      d.world.agents = [AGENT]
      return d
    }
    async function compactedResult($: any): Promise<string[]> {
      await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT, agentId: 'a1' })
      await $.classic.SessionStart({ source: 'compact', cwd: '/work', session_id: 'own', transcript_path: '/work/main.jsonl' })
      return briefings(((await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as any)).context ?? []) as string[])
    }

    test('a signed-in session holding only a card, on no plan, briefs its sub-agent with the profile fetch (CP-109)', async ($, on) => {
      const d = await noPlanSession($, on, { connected: false })
      d.world.card = { id: 'CP-109', title: 'A sub-agent fetches its profile instruction again after its conversation is compacted' }
      await startSession($, d, surface)
      await $.agent.spawn({ prompt: 'work CP-109\nbuild it in your own worktree', subagentType: AGENT.type })
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: AGENT.type })
      expect(await compactedResult($)).toEqual([subagentBriefingText({ id: 'a1', type: AGENT.type, description: AGENT.description, profile: WORK })])
    })

    test('a session with no dashboard key briefs no sub-agent', async ($, on) => {
      const d = await noPlanSession($, on, { connected: false, signedOut: 'signed-out' })
      await startSession($, d, surface)
      await $.classic.SubagentStart({ agent_id: 'a1', agent_type: AGENT.type })
      expect(await compactedResult($)).toEqual([])
    })
  })
}
