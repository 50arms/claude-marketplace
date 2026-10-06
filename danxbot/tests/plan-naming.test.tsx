import { describe, expect, test } from 'claude-code/testing'

import { NAMING_NEEDED, NAMING_OK, NO_NAMING, SURFACES, dashboard, expectRowCarries, startSession, toldModel } from './plan-kit'

// DX-4612: a pane Connect or Switch plan whose plan_connect answer says `naming: needed` tells the model the server's rename steps,
// because the pane made the call and the model never reads its answer.
const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any

async function connectFrom(
  $: any,
  d: ReturnType<typeof dashboard>,
  surface: (typeof SURFACES)[number],
  opts: { switchTo?: string } = {},
) {
  d.toasts.length = 0
  await startSession($, d, surface)
  const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
  if (opts.switchTo) {
    await pane.press({ key: 'switch' })
    await pane.select({ key: 'plan-pick', value: opts.switchTo })
  } else {
    await pane.select({ key: 'plan-pick', value: '23' })
  }
  await pane.press({ key: 'connect' })
  await d.clock.settle()
  await pane.unmount()
}

describe('the model note when the plan answers naming', () => {
  test('needed: the note carries the server instruction verbatim and the exact suggested title, on both surfaces', async ($, on) => {
    const d = dashboard(on, { connected: false, naming: NAMING_NEEDED })
    for (const surface of SURFACES) {
      d.world.planId = null
      await connectFrom($, d, surface)
      const rows = toldModel(d)
      expect(rows).toHaveLength(1)
      expectRowCarries(rows[0]!, ['PLAN-23', 'plan_id 23'])
      expect(rows[0]).toContain(NAMING_NEEDED.instruction)
      expect(rows[0]).toContain(`Suggested thread title: "${NAMING_NEEDED.suggestedTitle}".`)
      expect(d.toasts.some(t => /malformed/.test(t))).toBe(false)
    }
  })

  test('Switch plan: a needed answer carries the same instruction and title', async ($, on) => {
    const d = dashboard(on, { naming: NAMING_NEEDED })
    for (const surface of SURFACES) {
      d.world.planId = 23
      await connectFrom($, d, surface, { switchTo: '24' })
      const rows = toldModel(d)
      expect(rows).toHaveLength(1)
      expectRowCarries(rows[0]!, ['PLAN-24', 'plan_id 24'])
      expect(rows[0]).toContain(NAMING_NEEDED.instruction)
      expect(rows[0]).toContain(NAMING_NEEDED.suggestedTitle)
    }
  })

  test('needed with no free name (suggestedTitle null): the instruction is carried, no title line is invented', async ($, on) => {
    const d = dashboard(on, { connected: false, naming: { ...NAMING_NEEDED, suggestedName: null, suggestedTitle: null } })
    for (const surface of SURFACES) {
      d.world.planId = null
      await connectFrom($, d, surface)
      const rows = toldModel(d)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toContain(NAMING_NEEDED.instruction)
      expect(rows[0]).not.toContain('Suggested thread title')
      expect(rows[0]).not.toContain('null')
    }
  })

  test('ok: the note is the plain connect note, nothing about naming', async ($, on) => {
    const d = dashboard(on, { connected: false, naming: NAMING_OK })
    for (const surface of SURFACES) {
      d.world.planId = null
      await connectFrom($, d, surface)
      const rows = toldModel(d)
      expect(rows).toHaveLength(1)
      expectRowCarries(rows[0]!, ['PLAN-23', 'plan_id 23', 'plan_connect'])
      expect(rows[0]).not.toMatch(/nam|rename|title/i)
    }
  })

  const MALFORMED: [string, unknown][] = [
    ['absent', NO_NAMING],
    ['null', null],
    ['a string', 'ok'],
    ['an unknown status', { status: 'pending' }],
    ['needed without an instruction', { ...NAMING_NEEDED, instruction: undefined }],
    ['needed with an empty instruction', { ...NAMING_NEEDED, instruction: '  ' }],
    ['needed with a non-string suggestedTitle', { ...NAMING_NEEDED, suggestedTitle: 7 }],
    ['needed without suggestedTitle', { ...NAMING_NEEDED, suggestedTitle: undefined }],
  ]
  for (const [label, naming] of MALFORMED) {
    test(`malformed (${label}): an error toast, never a silent plain note; the connect stays shown and the model is told it`, async ($, on) => {
      const d = dashboard(on, { connected: false, naming })
      for (const surface of SURFACES) {
        d.world.planId = null
        await connectFrom($, d, surface)
        expect(d.toasts).toContain('Connected to PLAN-23')
        const error = d.toasts.find(t => t.startsWith("Connected, but the answer's naming block is malformed"))
        expect(error, `no malformed-naming toast in ${JSON.stringify(d.toasts)}`).toBeDefined()
        expect(error).toContain('the model was not told to rename its thread')
        const rows = toldModel(d)
        expect(rows).toHaveLength(1)
        expectRowCarries(rows[0]!, ['PLAN-23', 'plan_id 23'])
        expect(rows[0]).not.toContain('rename')
      }
    })
  }
})
