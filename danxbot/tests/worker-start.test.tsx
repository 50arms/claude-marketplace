import "./run-tests-with-npm-test.generated"
// A `danxbot:worker` start must pass its model and effort in the Agent call (the dashboard answers what to pass); the Agent tool's `tool.call` hook refuses one
// that leaves either out, because `agent.spawn` cannot see `effort` and a left-out effort follows the starting session's own.
//
// WHAT THESE TESTS ARE NOT: they run against the kit's stand-in for the engine (`claude-code/testing`). The event reaching the hook is whatever the test
// hands `$.tool.call`; nothing here shows that a real engine puts the Agent call's `model` and `effort` on the `tool.call` event. The live check is a
// session in which a small hook records the keys of an Agent call's `tool.call` event, then one Agent call that passes a model and an effort; until it has been
// made, the refusal is unproven on a real engine.
import { describe, expect } from 'claude-code/testing'

import { TIERS } from '../hooks/plan/pacing-guard'
import { EFFORTS, WORKER_REFUSAL_PREFIX, workerStartGuard, workerStartRefusal } from '../hooks/plan/worker-start'
import { test } from './plan-kit'

const call = { description: 'build the card', prompt: 'work CP-1' }

describe('workerStartRefusal', () => {
  test('a worker start with both a model and an effort is not refused', () => {
    expect(workerStartRefusal({ subagent_type: 'danxbot:worker', model: 'sonnet', effort: 'low' })).toBeNull()
  })

  test('a start with no model, no effort, or neither is refused, naming exactly what is missing', () => {
    expect(workerStartRefusal({ subagent_type: 'danxbot:worker', effort: 'high' })).toContain(`${WORKER_REFUSAL_PREFIX} its model.`)
    expect(workerStartRefusal({ subagent_type: 'danxbot:worker', model: 'opus' })).toContain(`${WORKER_REFUSAL_PREFIX} its effort.`)
    expect(workerStartRefusal({ subagent_type: 'danxbot:worker' })).toContain(`${WORKER_REFUSAL_PREFIX} its model and effort.`)
  })

  test('the refusal names every value that can be passed and says where the dashboard answers them', () => {
    const text = workerStartRefusal({ subagent_type: 'danxbot:worker' })!
    for (const v of [...TIERS, ...EFFORTS]) expect(text).toContain(v)
    expect(text).toContain('the card read for a builder')
    expect(text).toContain('the gate instruction route for a gate')
    expect(text).toContain('`GET /api/boards/<board>` with `fields.effort_ladder` for a sub-agent with no card')
  })

  test('every agent type other than the worker passes, with or without a model and effort', () => {
    for (const subagent_type of [undefined, 'general-purpose', 'Explore', 'fork', 'danxbot:other']) expect(workerStartRefusal({ subagent_type })).toBeNull()
  })

  test("only this plugin's type is the worker: a team's own agent named `worker` is left alone", () => {
    expect(workerStartRefusal({ subagent_type: 'worker' })).toBeNull()
  })
})

describe('workerStartGuard', () => {
  test('a refused start never reaches next; every other call does, unchanged', async () => {
    let reached = 0
    const next = async () => (reached++, { text: 'ran' } as { deny?: string; text?: string })
    expect(await workerStartGuard({ subagent_type: 'danxbot:worker', model: 'haiku' }, next)).toEqual({ deny: expect.stringContaining('its effort') })
    expect(reached).toBe(0)
    expect(await workerStartGuard({ subagent_type: 'danxbot:worker', model: 'haiku', effort: 'medium' }, next)).toEqual({ text: 'ran' })
    expect(await workerStartGuard({ subagent_type: 'general-purpose' }, next)).toEqual({ text: 'ran' })
    expect(reached).toBe(2)
  })
})

describe('what the plugin wires', () => {
  test('through the plugin, a worker start without its pair is denied and the same start with it reaches the engine', async ($, on) => {
    const reached: unknown[] = []
    on('tool.call', (_$: any, e: any) => (reached.push(e), { result: {}, text: 'ran', isError: false }) as any)
    const refused = await $.tool.call({ tool: 'Agent', ...call, subagent_type: 'danxbot:worker', model: 'sonnet' } as any)
    expect(refused.deny).toContain(`${WORKER_REFUSAL_PREFIX} its effort.`)
    const none = await $.tool.call({ tool: 'Agent', ...call, subagent_type: 'danxbot:worker' } as any)
    expect(none.deny).toContain('its model and effort.')
    expect(reached).toEqual([])
    const ran = await $.tool.call({ tool: 'Agent', ...call, subagent_type: 'danxbot:worker', model: 'sonnet', effort: 'low' } as any)
    expect(ran.deny).toBeUndefined()
    expect(ran.text).toBe('ran')
    expect(reached).toHaveLength(1)
  })

  test('only an Agent call is refused: a Bash call and a general-purpose Agent call go through', async ($, on) => {
    on('tool.call', () => ({ result: {}, text: 'ran', isError: false }) as any)
    expect((await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as any)).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Agent', ...call, subagent_type: 'general-purpose' } as any)).deny).toBeUndefined()
  })
})
