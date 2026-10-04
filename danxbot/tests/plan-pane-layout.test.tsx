// DX-4415: the Plan pane's layout, top to bottom: the top line (connection left, controls right), the events line,
// the plan title, the progress row (donut left, in-progress refs right), the Needs You block, and nothing else.
// Every test runs on both surfaces: a tree the engine refuses draws nothing and says nothing in the desktop app, so
// mounting and finding on each surface IS the check (R-3).
import { describe, expect, test } from 'claude-code/testing'

import {
  DANGER,
  DISCONNECT_GLYPH,
  DISCONNECT_TIP,
  NO_IN_PROGRESS,
  OPEN_LINK_GLYPH,
  OPEN_LINK_TIP,
  SWITCH_GLYPH,
  SWITCH_TIP,
  cardUrl,
  planUrl,
} from '../hooks/plan/config'
import { DASHBOARD_URL, SURFACES, dashboard, startSession } from './plan-kit'

const OTHER = 'https://other.example.org'
const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any

type Node = { type: string; props: Record<string, any>; children: any[] }
const isNode = (x: any): x is Node => x !== null && typeof x === 'object' && typeof x.type === 'string'
// every element of a drawn tree, document order
function flat(node: any, out: Node[] = []): Node[] {
  if (!isNode(node)) return out
  out.push(node)
  for (const child of node.children ?? []) flat(child, out)
  return out
}
// the text a node shows: its string children in document order
const shown = (n: Node) => (n.children ?? []).filter((c: any) => typeof c === 'string').join('')
const texts = (node: any) => flat(node).filter(n => n.type === 'Text').map(shown)
const elementChildren = (n: Node) => (n.children ?? []).filter(isNode)
const treeOf = async (pane: any): Promise<Node> => (await pane.drawn()) as Node
const mountPane = ($: any, surface: string) => $.ui.mount({ plugin: 'danxbot', surface, ...PANE })

for (const surface of SURFACES) {
  describe(`the connected pane on ${surface}`, () => {
    test('top line: ONE row; the dot and exactly `Connected: PLAN-23` on the left; the controls on the right in order', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const root = await treeOf(await mountPane($, surface))
      const top = elementChildren(root)[0]!
      expect(top.type).toBe('Box')
      expect(top.props.key).toBe('top-line')
      expect(top.props.flexDirection).toBe('row')
      const [left, right] = elementChildren(top)
      const leftTexts = flat(left).filter(n => n.type === 'Text')
      expect(leftTexts.map(shown)).toEqual(['●', 'Connected: PLAN-23'])
      expect(leftTexts[0]!.props.color).toBe('green')
      // right side, document order: Browser tab (desktop only), Open link, Switch plan, Disconnect
      const controls = flat(right)
        .filter(n => n.type === 'Button' || n.type === 'Link')
        .map(n => (n.type === 'Link' ? 'Link' : n.props.key))
      expect(controls).toEqual(surface === 'desktop' ? ['open-plan', 'Link', 'switch', 'disconnect'] : ['Link', 'switch', 'disconnect'])
      const link = flat(right).find(n => n.type === 'Link')!
      expect(link.props.href).toBe(`${DASHBOARD_URL}/plans/23`)
    })

    test('below the top line: events, title, progress row (donut + % + done / total, then the refs), Needs You, problem cards', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const root = await treeOf(await mountPane($, surface))
      const all = texts(root)
      const at = (t: string) => all.findIndex(x => x === t)
      const marks = [at('events'), at('Danxbot plugin'), at('25%'), at('4 / 16 done'), at('Needs You')]
      expect(marks.every(i => i >= 0)).toBe(true)
      expect([...marks].sort((a, b) => a - b)).toEqual(marks)
      // the donut mark is drawn before its percent (an Svg on the desktop, the glyph on the terminal)
      const tree = flat(root)
      const donut = tree.findIndex(n => (surface === 'desktop' ? n.type === 'Svg' : n.type === 'Text' && shown(n) === '◔'))
      const percent = tree.findIndex(n => n.type === 'Text' && shown(n) === '25%')
      const ref = tree.findIndex(n => n.type === 'Link' && n.props.label === 'DX-9')
      const needs = tree.findIndex(n => n.type === 'Text' && shown(n) === 'Needs You')
      const problem = tree.findIndex(n => n.props?.key === 'open-11')
      expect(donut).toBeGreaterThan(-1)
      expect(donut).toBeLessThan(percent)
      expect(percent).toBeLessThan(ref)
      expect(ref).toBeLessThan(needs)
      expect(needs).toBeLessThan(problem)
      // donut and refs are the two sides of ONE row
      const row = tree.find(n => n.props?.key === 'progress-row')!
      expect(row.props.flexDirection).toBe('row')
      expect(flat(row).some(n => n.type === 'Link')).toBe(true)
      expect(flat(row).some(n => n.type === 'Text' && shown(n) === '25%')).toBe(true)
    })

    for (const origin of [DASHBOARD_URL, OTHER]) {
      test(`refs on ${origin}: one Link per In Progress card, label = id, href through cardUrl on the answered origin; no title, agent, age`, async ($, on) => {
        const d = dashboard(on, { dashboardUrl: origin })
        d.world.inProgress.push({ id: 'DX-12', title: 'Another in flight card', updatedAt: '2026-10-03T07:00:00.000Z' })
        await startSession($, d, surface)
        const pane = await mountPane($, surface)
        const refs = flat(await treeOf(pane)).find(n => n.props?.key === 'refs')!
        const links = flat(refs).filter(n => n.type === 'Link')
        expect(links.map(l => [l.props.label, l.props.href])).toEqual([
          ['DX-9', `${origin}/plans/23/cards/DX-9`],
          ['DX-12', `${origin}/plans/23/cards/DX-12`],
        ])
        expect(links[0]!.props.href).toBe(cardUrl({ dashboardUrl: origin, id: 23 } as any, 'DX-9'))
        const all = texts(await treeOf(pane)).join(' | ')
        expect(all).not.toContain('In flight card')
        expect(all).not.toContain('PLAN-23: danxbot plugin')
        expect(all).not.toContain('updated ')
      })
    }

    test('a bucket bigger than the load read ends its refs in +N', async ($, on) => {
      const d = dashboard(on, { inProgressTotal: 20 })
      await startSession($, d, surface)
      const refs = flat(await treeOf(await mountPane($, surface))).find(n => n.props?.key === 'refs')!
      expect(texts(refs)).toEqual(['+19'])
    })

    test('no card in progress: the right side is ONE dim Text saying so, no Link; the donut and percent still draw', async ($, on) => {
      const d = dashboard(on)
      d.world.inProgress.length = 0
      await startSession($, d, surface)
      const root = await treeOf(await mountPane($, surface))
      const refs = flat(root).find(n => n.props?.key === 'refs')!
      expect(elementChildren(refs)).toHaveLength(1)
      const only = elementChildren(refs)[0]!
      expect(only.type).toBe('Text')
      expect(shown(only)).toBe(NO_IN_PROGRESS)
      expect(only.props.dimColor).toBe(true)
      expect(flat(refs).some(n => n.type === 'Link')).toBe(false)
      expect(texts(root)).toContain('25%')
    })

    test('removed things are GONE, and NOTHING ELSE is drawn: the children are exactly top line, events, title, progress row, Needs You', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const pane = await mountPane($, surface)
      const root = await treeOf(pane)
      const all = texts(root)
      for (const gone of ['Danxbot plan', 'Refresh', 'Working…', 'building']) expect(all).not.toContain(gone)
      const joined = all.join(' | ')
      for (const gone of ['In progress', 'not waiting on you', 'updated ', 'Updated ']) expect(joined).not.toContain(gone)
      expect(await pane.find({ key: 'refresh' })).toBeUndefined()
      const kids = elementChildren(root)
      expect(kids).toHaveLength(5)
      expect(kids.map(k => k.props?.key)).toEqual(['top-line', 'events', undefined, 'progress-row', 'needs-you'])
      expect(shown(kids[2]!)).toBe('Danxbot plugin')
    })

    test('the switch picker, while open, sits under the top line and adds nothing else', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const pane = await mountPane($, surface)
      await pane.press({ key: 'switch' })
      await d.clock.settle()
      const kids = elementChildren(await treeOf(pane))
      expect(kids).toHaveLength(6)
      expect(kids[0]!.props.key).toBe('top-line')
      expect(flat(kids[1]!).some(n => n.props?.key === 'plan-pick')).toBe(true)
    })

    test('icon controls: plain one-glyph Buttons and a one-glyph Link, each in a keyed Box with its hover-card tooltip; Disconnect on a red Box', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const tree = flat(await treeOf(await mountPane($, surface)))
      const tipBoxOf = (hoverKey: string) => tree.find(n => n.type === 'Box' && n.props.key === hoverKey)!
      const cases: [string, string, string][] = [
        ['open-link-hover', OPEN_LINK_GLYPH, OPEN_LINK_TIP],
        ['switch-hover', SWITCH_GLYPH, SWITCH_TIP],
        ['disconnect-hover', DISCONNECT_GLYPH, DISCONNECT_TIP],
      ]
      for (const [hoverKey, glyph, tip] of cases) {
        const box = tipBoxOf(hoverKey)
        expect(box, hoverKey).toBeDefined()
        const [control, card] = elementChildren(box)
        expect(control!.props.label ?? shown(control!)).toBe(glyph)
        expect([...glyph]).toHaveLength(1)
        expect(card!.type).toBe('Box')
        expect(card!.props.position).toBe('absolute')
        expect(card!.props.display).toBe('none')
        expect((card as any).hover).toEqual({ display: 'flex' })
        expect(texts(card)).toEqual([` ${tip} `])
      }
      for (const key of ['switch', 'disconnect']) {
        const button = tree.find(n => n.type === 'Button' && n.props.key === key)!
        expect(button.props.plain).toBe(true)
      }
      // the engine drops unknown props silently, so only a test guards these
      for (const button of tree.filter(n => n.type === 'Button')) {
        for (const prop of ['title', 'tooltip', 'backgroundColor', 'icon']) expect(button.props[prop], `${button.props.key} ${prop}`).toBeUndefined()
        expect((button.children ?? []).every((c: any) => typeof c === 'string')).toBe(true)
      }
      // Disconnect is red: its wrapping Box carries the danger colour, the other two controls none
      expect(tipBoxOf('disconnect-hover').props.backgroundColor).toBe(DANGER)
      expect(tipBoxOf('switch-hover').props.backgroundColor).toBeUndefined()
      expect(tipBoxOf('open-link-hover').props.backgroundColor).toBeUndefined()
      // Open link is a Link with the glyph as its label, on the plan's page
      const link = tree.find(n => n.type === 'Link' && n.props.label === OPEN_LINK_GLYPH)!
      expect(link.props.href).toBe(planUrl({ dashboardUrl: DASHBOARD_URL, id: 23 } as any))
    })
  })

  describe(`the panes with no connected plan on ${surface}`, () => {
    test('not connected: the warning line and the picker, no right-hand group, no heading or Refresh', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const pane = await mountPane($, surface)
      const root = await treeOf(pane)
      expect(texts(root)).toContain('● Not connected to a plan')
      expect(await pane.find({ key: 'plan-pick' })).toBeDefined()
      expect(await pane.find({ key: 'connect' })).toBeDefined()
      expect(await pane.find({ key: 'switch' })).toBeUndefined()
      expect(await pane.find({ key: 'disconnect' })).toBeUndefined()
      expect(await pane.find({ key: 'refresh' })).toBeUndefined()
      expect(texts(root)).not.toContain('Danxbot plan')
      expect(texts(root)).not.toContain('Refresh')
    })

    test('error: the error text in the danger colour, nothing else', async ($, on) => {
      const d = dashboard(on)
      d.failList()
      await startSession($, d, surface)
      const pane = await mountPane($, surface)
      const text = (await pane.findAll({ type: 'Text' }))[0]!
      expect(text.text).toContain('500: boom')
      expect(text.props.color).toBe('red')
      expect(await pane.findAll({ type: 'Text' })).toHaveLength(1)
      expect(await pane.find({ key: 'refresh' })).toBeUndefined()
    })

    test('loading: `Loading…` alone', async ($, on) => {
      dashboard(on)
      const pane = await mountPane($, surface)
      expect(texts(await treeOf(pane))).toEqual(['Loading…'])
    })

    test('no MCP: the one sentence, nothing else', async ($, on) => {
      const d = dashboard(on, { mcp: 'down' })
      await startSession($, d, surface)
      const pane = await mountPane($, surface)
      expect(texts(await treeOf(pane))).toEqual(['The danx-dashboard MCP server is not connected in this session, so there is no plan to show.'])
    })
  })

  describe(`the in-progress read feeds the refs row on ${surface}`, () => {
    const callsTo = (d: any, bucket: string) =>
      d.api.filter((a: any) => /^\/api\/plans\/23\/cards$/.test(a.path) && a.query?.bucket === bucket).length

    test('one refresh loads both buckets, a 60 s tick adds exactly one load of each, through danxbot_api; no per-card issue read for a ref', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      expect(callsTo(d, 'needs-you')).toBe(1)
      expect(callsTo(d, 'in-progress')).toBe(1)
      expect(d.api.some(a => a.path === '/api/issues/DX-9')).toBe(false)
      await d.clock.advance(60_000)
      expect(callsTo(d, 'needs-you')).toBe(2)
      expect(callsTo(d, 'in-progress')).toBe(2)
      expect(d.calls.every(c => c.server !== 'danx-dashboard' || c.tool === 'danxbot_api' || c.tool === 'plan_connect')).toBe(true)
    })

    test('a failed in-progress call fails the load as an error shown in the pane, never a missing refs row', async ($, on) => {
      const d = dashboard(on, { inProgressFails: true })
      await startSession($, d, surface)
      const pane = await mountPane($, surface)
      expect(texts(await treeOf(pane)).join(' | ')).toContain('in-progress boom')
      expect(await pane.find({ key: 'refs' })).toBeUndefined()
    })

    test('an in-progress answer with no total is the same error', async ($, on) => {
      const d = dashboard(on, { noInProgressTotal: true })
      await startSession($, d, surface)
      const pane = await mountPane($, surface)
      expect(texts(await treeOf(pane)).join(' | ')).toContain('answered no total')
      expect(await pane.find({ key: 'refs' })).toBeUndefined()
    })
  })
}
