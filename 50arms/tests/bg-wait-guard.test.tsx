import "./run-tests-with-npm-test.generated"
// CP-175: the SubagentStop background-wait guard, ported with the cases of danxbot's subagent-bg-wait-guard.e2e.test.ts that apply (DX-3087, DX-3108, DX-3756, DX-8126), so both
// give the same verdict on the same transcripts; and the register.tsx wiring over the kit (the guard reads `agent_transcript_path`, and only it).
import { describe, expect } from 'claude-code/testing'

import { MAX_REFUSALS, belongsToAgent, bgWaitVerdict, countToolCalls, leftBehindLine, movedOutputPaths, parseTranscript } from '../hooks/reports/bg-wait-guard'
import type { Counts } from '../hooks/reports/bg-wait-guard'
import { SURFACES, dashboard, startSession, test } from './plan-kit'

const SID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const OUT = (id: string) => `/tmp/claude-1/x/${SID}/tasks/${id}.output`
const call = (id: string, name: string, input: object, extra: object = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] }, ...extra })
const result = (id: string, text: string, extra: object = {}) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] }, ...extra })
const say = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const notice = (id: string) => ({ type: 'user', message: { content: [{ type: 'text', text: `<task-notification><tool-use-id>${id}</tool-use-id><status>completed</status></task-notification>` }] } })
const queued = (prompt: string) => ({ type: 'attachment', attachment: { type: 'queued_command', prompt } })
const LAUNCH = (id: string) => `Command running in background with ID: ${id}. Output is being written to: ${OUT(id)}`
const MOVED = (id: string) => `Command did not complete within its 120s timeout and was moved to the background (ID: ${id}). Output is being written to: ${OUT(id)}. You will be notified when it completes.`

const decide = (lines: any[], extra: { existing?: Map<string, number>; counts?: Counts; stopHookActive?: boolean; agentId?: string } = {}) => {
  const texts = lines.map(l => JSON.stringify(l))
  return bgWaitVerdict({ lines, texts, agentId: 'a1', sessionId: 's1', stopHookActive: false, existing: new Map(), counts: {}, ...extra })
}
const kind = (lines: any[], extra = {}) => decide(lines, extra).verdict.kind
const reason = (lines: any[], extra = {}) => {
  const v = decide(lines, extra).verdict
  return v.kind === 'refuse' ? v.reason : v.kind
}

describe('background Bash runs', () => {
  const started = [call('t1', 'Bash', { command: 'make test', run_in_background: true }), result('t1', LAUNCH('b1'))]

  test('an open run is refused, and a read of its output closes nothing', () => {
    expect(reason(started)).toMatch(/b1/)
    expect(reason([...started, call('t2', 'Read', { file_path: OUT('b1') }), result('t2', 'partial')])).toMatch(/b1/)
  })

  test('a live completion notice (with a later assistant line) or a TaskStop closes it; a notice at the very end does not', () => {
    expect(kind([...started, notice('t1'), say('done')])).toBe('pass')
    expect(kind([...started, queued('<task-notification><task-id>b1</task-id></task-notification>'), say('done')])).toBe('pass')
    expect(kind([...started, call('t3', 'TaskStop', { task_id: 'b1' })])).toBe('pass')
    expect(reason([...started, say('waiting'), notice('t1')])).toMatch(/b1/)
  })

  test('the wording of the agent plays no role: a final message saying it waited, or saying it did not, decides nothing', () => {
    expect(kind([...started, say('I waited for it and it finished.')])).toBe('refuse')
    expect(kind([...started, say('I did not wait for it.')])).toBe('refuse')
    expect(kind([...started, notice('t1'), say('I did not wait for it.')])).toBe('pass')
  })

  test('refusals are bounded to MAX_REFUSALS in a row, the next stop goes through as left_behind naming the run, and a tool call between starts the count again', () => {
    let counts: Counts = {}
    for (let i = 0; i < MAX_REFUSALS; i++) {
      const d = decide(started, { counts })
      expect(d.verdict.kind).toBe('refuse')
      counts = d.counts
    }
    const last = decide(started, { counts })
    expect(last.verdict).toEqual({ kind: 'left_behind', runs: `b1, ${OUT('b1')}` })
    expect(last.counts).toEqual({})
    expect(leftBehindLine('b1')).toMatch(/left behind: b1\./)
    const moved = decide([...started, call('t9', 'Bash', { command: 'tail' }), result('t9', 'x')], { counts })
    expect(moved.verdict.kind).toBe('refuse')
    expect(Object.values(moved.counts)[0].n).toBe(1)
  })

  test('a stop that goes through drops its count, and the other agents keep theirs', () => {
    const counts: Counts = { 's1-a1': { n: 2, calls: 1 }, 's1-a2': { n: 1, calls: 5 } }
    expect(decide([call('t1', 'Bash', { command: 'ls' })], { counts }).counts).toEqual({ 's1-a2': { n: 1, calls: 5 } })
  })

  test('stop_hook_active never lets a Bash run through', () => {
    expect(kind(started, { stopHookActive: true })).toBe('refuse')
  })

  test('a background run whose confirmation shape is unrecognized, or has not landed yet, is still refused', () => {
    expect(kind([call('t1', 'Bash', { command: 'make test', run_in_background: true }), result('t1', 'started somehow')])).toBe('refuse')
    expect(reason([call('t1', 'Bash', { command: 'make test', run_in_background: true })])).toMatch(/the run started by tool call t1/)
  })

  test('a foreground Bash call is no spawn, and a Bash call that quotes the launch message is no run', () => {
    expect(kind([call('t1', 'Bash', { command: 'ls' }), result('t1', 'file.txt')])).toBe('pass')
    expect(kind([call('t1', 'Bash', { command: 'cat log' }), result('t1', LAUNCH('b1'))])).toBe('pass')
  })

  describe('a moved run counts only with the harness vouching', () => {
    const lines = (extra: object, text = MOVED('m1')) => [call('t1', 'Bash', { command: 'sleep 999' }, { timestamp: '2026-11-26T10:00:00.000Z' }), result('t1', text, extra)]
    const CALL = Date.parse('2026-11-26T10:00:00.000Z')

    test("its toolUseResult.backgroundTaskId, equal to the message's id, vouches; a different id, an empty object or a string does not", () => {
      expect(reason(lines({ toolUseResult: { backgroundTaskId: 'm1' } }))).toMatch(/m1/)
      expect(kind(lines({ toolUseResult: { backgroundTaskId: 'other' } }))).toBe('pass')
      expect(kind(lines({ toolUseResult: {} }))).toBe('pass')
      // a string toolUseResult (an error result) beside a quoted message naming an existing file is no run
      expect(kind(lines({ toolUseResult: 'Error: boom' }), { existing: new Map([[OUT('m1'), CALL + 1000]]) })).toBe('pass')
    })

    test('with no toolUseResult the output file must exist and have been written at or after the call: an older file named by a quote is no run', () => {
      expect(movedOutputPaths(lines({}))).toEqual([OUT('m1')])
      expect(reason(lines({}), { existing: new Map([[OUT('m1'), CALL + 5]]) })).toMatch(/m1/)
      expect(reason(lines({}), { existing: new Map([[OUT('m1'), CALL]]) })).toMatch(/m1/)
      expect(kind(lines({}), { existing: new Map([[OUT('m1'), CALL - 1]]) })).toBe('pass')
      expect(kind(lines({}))).toBe('pass')
    })

    test('a path without the harness shape is no run, whatever the file', () => {
      const text = 'Command did not complete within its 120s timeout and was moved to the background (ID: m1). Output is being written to: /home/u/notes/m1.output.'
      expect(movedOutputPaths(lines({}, text))).toEqual([])
      expect(kind(lines({ toolUseResult: { backgroundTaskId: 'm1' } }, text))).toBe('pass')
    })

    test("a moved run with the command's own output in front of the message is still refused, and the LAST message counts", () => {
      const printed = `partial output line\n${MOVED('m1')}\nmore output\n[cwd: /work]`
      expect(reason(lines({ toolUseResult: { backgroundTaskId: 'm1' } }, printed))).toMatch(/m1/)
      const two = `${MOVED('old')}\n${MOVED('m1')}`
      expect(reason(lines({ toolUseResult: { backgroundTaskId: 'm1' } }, two))).toMatch(/m1/)
    })
  })
})

describe('background Agent spawns', () => {
  const spawned = [call('s1', 'Agent', { run_in_background: true }), result('s1', 'agentId: ag9\noutput_file: /o/ag9.output')]

  test('an id never referenced again is refused once; a later reference, or a second stop, passes', () => {
    expect(reason(spawned)).toMatch(/ag9/)
    expect(kind(spawned, { stopHookActive: true })).toBe('pass')
    expect(kind([...spawned, call('s2', 'Bash', { command: 'tail /o/ag9.output' })])).toBe('pass')
    expect(kind([...spawned, notice('s1'), { type: 'user', message: { content: [{ type: 'text', text: 'agentId: ag9 done' }] } }])).toBe('pass')
  })

  test('an unrecognized confirmation, or one not landed yet, is skipped, never refused', () => {
    expect(kind([call('s1', 'Agent', { run_in_background: true }), result('s1', 'launched')])).toBe('pass')
    expect(kind([call('s1', 'Agent', { run_in_background: true })])).toBe('pass')
  })

  test('a confirmation in two text blocks reads its id from the block it is in, not glued to the next block', () => {
    const lines = [call('s1', 'Agent', { run_in_background: true }), { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: [{ type: 'text', text: 'agentId: ag9' }, { type: 'text', text: 'tail' }] }] } }]
    expect(reason(lines)).toMatch(/\(ag9\)/)
  })

  test('a foreground Agent call is no spawn', () => {
    expect(kind([call('s1', 'Agent', { prompt: 'x' }), result('s1', 'agentId: ag9')])).toBe('pass')
  })

  test("another agent's or the root session's spawn is not this agent's", () => {
    expect(kind([{ ...spawned[0], isSidechain: false }, spawned[1]])).toBe('pass')
    expect(kind([{ ...spawned[0], agentId: 'other' }, spawned[1]])).toBe('pass')
    expect(belongsToAgent({}, 'a1')).toBe(true)
    expect(countToolCalls(spawned, () => true)).toBe(1)
  })

  test('a queued_command attachment is no consumption: the real DX-3751 shape of five spawns confirmed only by attachments is refused naming all five', () => {
    const ids = ['a1x', 'a2x', 'a3x', 'a4x', 'a5x']
    const lines: any[] = []
    ids.forEach((id, i) => lines.push(call(`s${i}`, 'Agent', { run_in_background: true }), result(`s${i}`, `agentId: ${id}\noutput_file: /o/${id}.output`)))
    for (const id of ids) lines.push(queued(`<task-notification><task-id>${id}</task-id><tool-use-id>${id}</tool-use-id><status>completed</status></task-notification>`))
    const refused = reason(lines)
    for (const id of ids) expect(refused).toContain(id)
    // one spawn then read by the agent after the attachment passes for that spawn only
    const read = [...lines, call('r', 'Bash', { command: 'cat /o/a3x.output' })]
    const after = reason(read)
    expect(after).not.toContain('a3x')
    expect(after).toContain('a1x')
  })
})

describe('the stop envelope', () => {
  test('the transcript is parsed once with each line kept beside its raw text; a malformed line is skipped', () => {
    const parsed = parseTranscript(`${JSON.stringify(say('a'))}\nnot json\n\n${JSON.stringify(say('b'))}\n`)
    expect(parsed.lines).toHaveLength(2)
    expect(parsed.texts).toEqual([JSON.stringify(say('a')), JSON.stringify(say('b'))])
  })
})

const JSONL = (lines: any[]) => lines.map(l => JSON.stringify(l)).join('\n')

for (const surface of SURFACES) {
  describe(`the sub-agent stop hook on ${surface}`, () => {
    const open = JSONL([call('t1', 'Bash', { command: 'make test', run_in_background: true }), result('t1', LAUNCH('b1'))])
    const clean = JSONL([call('t1', 'Bash', { command: 'ls' }), result('t1', 'x')])
    const ENVELOPE = { agent_id: 'a1', session_id: 's1', agent_type: 'x', stop_hook_active: false }
    async function started($: any, on: any) {
      on('classic.SubagentStop', () => ({}) as any)
      const d = dashboard(on, {})
      await startSession($, d, surface)
      return d
    }

    test("it reads the sub-agent's own file, `agent_transcript_path`, and never the main session's `transcript_path`", async ($, on) => {
      const d = await started($, on)
      // the main transcript holds the open run, the sub-agent's own file is clean: the stop goes through
      d.world.files['/work/main.jsonl'] = open
      d.world.files['/work/agent.jsonl'] = clean
      expect((await $.classic.SubagentStop({ ...ENVELOPE, transcript_path: '/work/main.jsonl', agent_transcript_path: '/work/agent.jsonl' }))?.block).toBeUndefined()
      // the reverse: the sub-agent's own file holds the open run, whatever the main one says
      d.world.files['/work/main.jsonl'] = clean
      d.world.files['/work/agent.jsonl'] = open
      expect((await $.classic.SubagentStop({ ...ENVELOPE, transcript_path: '/work/main.jsonl', agent_transcript_path: '/work/agent.jsonl' }))?.block).toMatch(/b1/)
    })

    test('a missing agent_transcript_path, or a file that is not there, lets the stop go with one toast naming it, told once', async ($, on) => {
      const d = await started($, on)
      d.world.files['/work/main.jsonl'] = open
      const mine = () => d.toasts.filter((t: string) => t.startsWith('50 Arms sub-agent background-wait check skipped'))
      expect((await $.classic.SubagentStop({ ...ENVELOPE, transcript_path: '/work/main.jsonl' }))?.block).toBeUndefined()
      expect((await $.classic.SubagentStop({ ...ENVELOPE, transcript_path: '/work/main.jsonl' }))?.block).toBeUndefined()
      expect(mine()).toEqual(['50 Arms sub-agent background-wait check skipped: the SubagentStop event has no agent_transcript_path'])
      expect((await $.classic.SubagentStop({ ...ENVELOPE, agent_transcript_path: '/work/gone.jsonl' }))?.block).toBeUndefined()
      expect(mine()).toHaveLength(2)
      expect(mine()[1]).toContain('/work/gone.jsonl')
    })

    test('the third refusal in a row is the last: the next stop goes through with a toast naming the run left behind', async ($, on) => {
      const d = await started($, on)
      d.world.files['/work/agent.jsonl'] = open
      const stop = () => $.classic.SubagentStop({ ...ENVELOPE, agent_transcript_path: '/work/agent.jsonl' })
      for (let i = 0; i < MAX_REFUSALS; i++) expect((await stop())?.block).toMatch(/b1/)
      expect((await stop())?.block).toBeUndefined()
      expect(d.toasts.filter((t: string) => t.includes('left behind'))).toEqual([leftBehindLine(`b1, ${OUT('b1')}`)])
      // its count is gone with that stop: the next one is refused again
      expect((await stop())?.block).toMatch(/b1/)
    })
  })
}
