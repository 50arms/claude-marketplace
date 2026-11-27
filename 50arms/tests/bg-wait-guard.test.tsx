import "./run-tests-with-npm-test.generated"
// CP-175: the SubagentStop background-wait guard, pure (ported from danxbot's subagent-bg-wait-guard, DX-3087/3108/3756/8126).
import { describe, expect, test } from 'claude-code/testing'

import { MAX_REFUSALS, bgWaitRefusal, countToolCalls, belongsToAgent, movedOutputPaths } from '../hooks/reports/bg-wait-guard'

const call = (id: string, name: string, input: object, extra: object = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] }, ...extra })
const result = (id: string, text: string, extra: object = {}) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] }, ...extra })
const say = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const notice = (id: string) => ({ type: 'user', message: { content: [{ type: 'text', text: `<task-notification><tool-use-id>${id}</tool-use-id><status>completed</status></task-notification>` }] } })
const LAUNCH = (id: string) => `Command running in background with ID: ${id}. Output is being written to: /tmp/claude-1/x/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/tasks/${id}.output`
const base = { agentId: 'a1', sessionId: 's1', stopHookActive: false, existing: new Set<string>() }
const run = (lines: any[], extra: object = {}) => bgWaitRefusal({ ...base, lines, refusals: new Map(), ...extra })

describe('background Bash runs', () => {
  const started = [call('t1', 'Bash', { command: 'make test', run_in_background: true }), result('t1', LAUNCH('b1'))]
  test('an open run is refused, and a read of its output closes nothing', () => {
    expect(run(started)).toMatch(/b1/)
    expect(run([...started, call('t2', 'Read', { file_path: '/tmp/claude-1/x/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/tasks/b1.output' }), result('t2', 'partial')])).toMatch(/b1/)
  })
  test('a live completion notice (with a later assistant line) or a TaskStop closes it; a notice at the very end does not', () => {
    expect(run([...started, notice('t1'), say('done')])).toBeNull()
    expect(run([...started, call('t3', 'TaskStop', { task_id: 'b1' })])).toBeNull()
    expect(run([...started, say('waiting'), notice('t1')])).toMatch(/b1/)
  })
  test('refusals are bounded to MAX_REFUSALS in a row, and a tool call between starts the count again', () => {
    const refusals = new Map()
    for (let i = 0; i < MAX_REFUSALS; i++) expect(run(started, { refusals })).not.toBeNull()
    expect(run(started, { refusals })).toBeNull()
    expect(run([...started, call('t9', 'Bash', { command: 'tail' }), result('t9', 'x')], { refusals })).not.toBeNull()
  })
  test('stop_hook_active never lets a Bash run through', () => {
    expect(run(started, { stopHookActive: true })).toMatch(/b1/)
  })
  test('a moved run counts only with the harness vouching: its toolUseResult id, or (none) the output file existing', () => {
    const out = '/tmp/claude-1/x/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/tasks/m1.output'
    const text = `Command did not complete within its 120s timeout and was moved to the background (ID: m1). Output is being written to: ${out}. `
    const lines = (extra: object) => [call('t1', 'Bash', { command: 'sleep 999' }), result('t1', text, extra)]
    expect(movedOutputPaths(lines({}))).toEqual([out])
    expect(run(lines({ toolUseResult: { backgroundTaskId: 'm1' } }))).toMatch(/m1/)
    expect(run(lines({ toolUseResult: {} }))).toBeNull()
    expect(run(lines({}), { existing: new Set([out]) })).toMatch(/m1/)
    expect(run(lines({}))).toBeNull()
  })
})

describe('background Agent spawns', () => {
  const spawned = [call('s1', 'Agent', { run_in_background: true }), result('s1', 'agentId: ag9\noutput_file: /o/ag9.output')]
  test('an id never referenced again is refused once; a later reference, or a second stop, passes', () => {
    expect(run(spawned)).toMatch(/ag9/)
    expect(run(spawned, { stopHookActive: true })).toBeNull()
    expect(run([...spawned, call('s2', 'Bash', { command: 'tail /o/ag9.output' })])).toBeNull()
  })
  test('a queued_command attachment is no consumption; an unrecognized confirmation is skipped', () => {
    expect(run([...spawned, { type: 'attachment', attachment: { type: 'queued_command', prompt: 'agentId: ag9' } }])).toMatch(/ag9/)
    expect(run([call('s1', 'Agent', { run_in_background: true }), result('s1', 'launched')])).toBeNull()
  })
  test("another agent's or the root session's spawn is not this agent's", () => {
    expect(run([{ ...spawned[0], isSidechain: false }, spawned[1]])).toBeNull()
    expect(run([{ ...spawned[0], agentId: 'other' }, spawned[1]])).toBeNull()
    expect(belongsToAgent({}, 'a1')).toBe(true)
    expect(countToolCalls(spawned, () => true)).toBe(1)
  })
})
