// DX-5344: whose compaction a resume briefing follows. Claude Code's classic SessionStart input never names the agent that compacted (2.1.299: its `agent_id` is always absent),
// so the plugin notes WHO compacts at the `session.compact` proposal that passed and reads that note when the `compact` start arrives. A sub-agent's compaction briefs THAT sub-agent
// (once, in its next tool result, never the main agent's prompt); the main agent's own compaction briefing is unchanged.
import { describe, expect } from 'claude-code/testing'

import { subagentBriefingText } from '../hooks/compaction/briefing'
import { SURFACES, dashboard, startSession, test } from './plan-kit'

const COMPACTED = { messages: [{ role: 'user', text: 'the summary', toolUses: [] }] }
const TRANSCRIPT = [{ role: 'user', text: 'go', toolUses: [], handle: 'm1' }]
const AGENT = { id: 'a1', type: 'danxbot:worker-sonnet-high', description: 'build the thing', status: 'running' }
// what the main agent's briefing opens with (the running AGENT is listed in it, so the whole text is not pinned)
const MAIN = '[50 ARMS] Your conversation was just compacted. Resume from this briefing, then read your cards before acting. Your plan is PLAN-23 Danxbot plugin.'

describe('the sub-agent briefing text (pure)', () => {
  test('names the agent and its task, points at its own summary and progress notes, and carries no plan or card', () => {
    const text = subagentBriefingText({ id: 'a1', type: 'danxbot:worker-sonnet-high', description: 'build the thing' })
    expect(text).toMatch(/^\[50 ARMS\] Your conversation was just compacted\./)
    expect(text).toContain('a1 (danxbot:worker-sonnet-high) build the thing')
    expect(text).toMatch(/progress notes/)
    expect(text).not.toMatch(/Cards in flight|Your plan is/)
  })

  test('an agent the engine does not list is briefed by its id alone', () => {
    expect(subagentBriefingText({ id: 'a9', type: null, description: null })).toContain('You are sub-agent a9.')
  })
})

for (const surface of SURFACES) {
  describe(`whose compaction the briefing follows on ${surface}`, () => {
    async function started($: any, on: any) {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.PreCompact', () => ({}) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      on('session.compact', async () => COMPACTED as any)
      const d = dashboard(on, {})
      d.world.agents = [AGENT]
      await startSession($, d, surface)
      const propose = (agentId?: string, trigger = 'auto') => $.session.compact({ trigger, messages: TRANSCRIPT, ...(agentId === undefined ? {} : { agentId }) })
      const compactStart = () => $.classic.SessionStart({ source: 'compact', cwd: '/work', session_id: 'own', transcript_path: '/work/main.jsonl' })
      const prompt = async () => ((await $.prompt.submit({ text: 'hello' })).context ?? []) as string[]
      const toolResult = async (agentId?: string) => (((await $.tool.call({ tool: 'Bash', command: 'ls', ...(agentId === undefined ? {} : { agentId }) } as any)).context ?? []) as string[])
      return { d, propose, compactStart, prompt, toolResult }
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
      expect(own).toEqual([subagentBriefingText({ id: 'a1', type: AGENT.type, description: AGENT.description })])
      expect(briefings(await k.toolResult('a1'))).toEqual([])
      expect(briefings(await k.prompt())).toEqual([])
    })

    test("the main agent's own automatic compaction still briefs the main agent once, and no sub-agent", async ($, on) => {
      const k = await started($, on)
      await k.propose()
      await k.compactStart()
      expect(briefings(await k.toolResult('a1'))).toEqual([])
      const first = await k.prompt()
      expect(first.join('\n')).toContain(MAIN)
      expect(briefings(await k.prompt())).toEqual([])
    })

    test("a person's /compact (manual) after a sub-agent's compaction briefs the main agent, not the sub-agent", async ($, on) => {
      const k = await started($, on)
      await k.propose('a1')
      await k.propose(undefined, 'manual')
      await k.compactStart()
      expect(briefings(await k.toolResult('a1'))).toEqual([])
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

    test('a session that is on no plan briefs no sub-agent either', async ($, on) => {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.PreCompact', () => ({}) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      on('session.compact', async () => COMPACTED as any)
      const d = dashboard(on, { connected: false })
      d.world.agents = [AGENT]
      await startSession($, d, surface)
      await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT, agentId: 'a1' })
      await $.classic.SessionStart({ source: 'compact', cwd: '/work', session_id: 'own', transcript_path: '/work/main.jsonl' })
      const r = ((await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as any)).context ?? []) as string[]
      expect(briefings(r)).toEqual([])
    })
  })
}
