// DX-4415: the Plan pane's layout, top to bottom: the top line (connection left, controls right), the pacing panel, the events
// line, the plan title, the progress row (donut left, in-progress refs right), the Needs You block, and then the sub-agent section.
// Every test runs on both surfaces: a tree the engine refuses draws nothing and says nothing in the desktop app, so mounting and
// finding on each surface IS the check (R-3).
import { describe, expect, test } from 'claude-code/testing'

import { DANGER, DISCONNECT_GLYPH, DISCONNECT_TIP, NO_IN_PROGRESS, SWITCH_GLYPH, SWITCH_TIP, cardUrl } from '../hooks/plan/config'
import { DASHBOARD_URL, SURFACES, dashboard, footerText, mountIndicator, startSession } from './plan-kit'

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
// a Markdown link node's label and href
const linkOf = (n: Node) => {
  const m = /^\[(.*)\]\((.*)\)$/s.exec(n.props.text)!
  return { label: m[1]!, href: m[2]! }
}

for (const surface of SURFACES) {
  describe(`the connected pane on ${surface}`, () => {
    test('top line: ONE row; `● Connected: PLAN-23` on the left; Open plan link, Switch plan, Disconnect on the right in order', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const root = await treeOf(await mountPane($, surface))
      const top = elementChildren(root)[0]!
      expect(top.type).toBe('Box')
      expect(top.props.key).toBe('top-line')
      expect(top.props.flexDirection).toBe('row')
      const [left, right] = elementChildren(top)
      expect(left!.type).toBe('Text')
      expect(shown(left!)).toBe('● Connected: PLAN-23')
      expect(left!.props.color).toBe('green')
      // DX-4630: no Link element, no browser-tab Button; the page control is a Markdown link
      const controls = flat(right).filter(n => n.type === 'Button' || n.type === 'Markdown' || n.type === 'Link')
      expect(controls.map(n => n.props.key)).toEqual(['open-plan', 'switch', 'disconnect'])
      expect(controls.map(n => n.type)).toEqual(['Markdown', 'Button', 'Button'])
      expect(linkOf(controls[0]!)).toEqual({ label: 'Open plan', href: `${DASHBOARD_URL}/plans/23` })
    })

    test('below the top line: events, title, progress row (donut + % + done / total, then the refs), Needs You, problem links', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const tree = flat(await treeOf(await mountPane($, surface)))
      const at = (pred: (n: Node) => boolean) => tree.findIndex(pred)
      const textAt = (t: string) => at(n => n.type === 'Text' && shown(n) === t)
      const events = textAt('events')
      const title = textAt('Danxbot plugin')
      const donut = at(n => (surface === 'desktop' ? n.type === 'Svg' : n.type === 'Text' && shown(n) === '◔'))
      const percent = textAt('25%')
      const done = textAt('4 / 16 done')
      const ref = at(n => n.type === 'Markdown' && linkOf(n).label === 'DX-9')
      const needs = textAt('Needs You')
      const problem = at(n => n.type === 'Markdown' && linkOf(n).href.endsWith('/problems/PBLM-11'))
      const order = [events, title, donut, percent, done, ref, needs, problem]
      expect(order.every(i => i >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
      // donut and refs are the two sides of ONE row
      const row = tree.find(n => n.props?.key === 'progress-row')!
      expect(row.props.flexDirection).toBe('row')
      expect(flat(row).some(n => n.type === 'Markdown')).toBe(true)
      expect(flat(row).some(n => n.type === 'Text' && shown(n) === '25%')).toBe(true)
    })

    for (const origin of [DASHBOARD_URL, OTHER]) {
      test(`refs on ${origin}: one Markdown link per In Progress card, label = id, href through cardUrl on the answered origin; no title, agent, age`, async ($, on) => {
        const d = dashboard(on, { dashboardUrl: origin })
        d.world.inProgress.push({ id: 'DX-12', title: 'Another in flight card' })
        await startSession($, d, surface)
        const root = await treeOf(await mountPane($, surface))
        const refs = flat(root).find(n => n.props?.key === 'refs')!
        const links = flat(refs)
          .filter(n => n.type === 'Markdown')
          .map(linkOf)
        expect(links).toEqual([
          { label: 'DX-9', href: `${origin}/plans/23/cards/DX-9` },
          { label: 'DX-12', href: `${origin}/plans/23/cards/DX-12` },
        ])
        expect(links[0]!.href).toBe(cardUrl({ dashboardUrl: origin, id: 23 } as any, 'DX-9'))
        const all = texts(root).join(' | ')
        expect(all).not.toContain('In flight card')
        expect(all).not.toContain('updated ')
      })
    }

    test('a bucket bigger than the load read ends its refs in +N', async ($, on) => {
      const d = dashboard(on, { inProgressTotal: 20 })
      await startSession($, d, surface)
      const refs = flat(await treeOf(await mountPane($, surface))).find(n => n.props?.key === 'refs')!
      expect(texts(refs)).toEqual(['+19'])
    })

    test('no card in progress: the right side is ONE dim Text saying so, no link; the donut and percent still draw', async ($, on) => {
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
      expect(texts(root)).toContain('25%')
    })

    test('the heading, Refresh button, plan status word, In progress section and Updated line are not drawn', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const pane = await mountPane($, surface)
      const all = texts(await treeOf(pane))
      for (const gone of ['Danxbot plan', 'Refresh', 'Working…', 'building']) expect(all).not.toContain(gone)
      const joined = all.join(' | ')
      for (const gone of ['In progress', 'not waiting on you', 'updated ', 'Updated ']) expect(joined).not.toContain(gone)
      expect(await pane.find({ key: 'refresh' })).toBeUndefined()
    })

    test('the switch picker, while open, sits directly under the top line', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const pane = await mountPane($, surface)
      await pane.press({ key: 'switch' })
      await d.clock.settle()
      const kids = elementChildren(await treeOf(pane))
      expect(kids[0]!.props.key).toBe('top-line')
      expect(flat(kids[1]!).some(n => n.props?.key === 'plan-pick')).toBe(true)
    })

    test('icon controls: plain one-glyph Buttons, each in a keyed Box with its hover-card tooltip; Disconnect on a red Box', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const pane = await mountPane($, surface)
      const tree = flat(await treeOf(pane))
      const boxOf = (hoverKey: string) => tree.find(n => n.type === 'Box' && n.props.key === hoverKey)!
      const cases: [string, string, string][] = [
        ['switch-hover', SWITCH_GLYPH, SWITCH_TIP],
        ['disconnect-hover', DISCONNECT_GLYPH, DISCONNECT_TIP],
      ]
      for (const [hoverKey, glyph, tip] of cases) {
        const box = boxOf(hoverKey)
        expect(box, hoverKey).toBeDefined()
        const [control, card] = elementChildren(box)
        expect(control!.type).toBe('Button')
        expect((await pane.find({ key: control!.props.key }))?.text).toBe(glyph)
        expect([...glyph]).toHaveLength(1)
        expect(card!.type).toBe('Box')
        expect(card!.props.position).toBe('absolute')
        expect(card!.props.display).toBe('none')
        expect((card as any).hover).toEqual({ display: 'flex' })
        expect(texts(card)).toEqual([` ${tip} `])
      }
      for (const key of ['switch', 'disconnect']) expect(tree.find(n => n.type === 'Button' && n.props.key === key)!.props.plain).toBe(true)
      // the engine drops unknown props silently, so only a test guards these
      for (const button of tree.filter(n => n.type === 'Button')) {
        for (const prop of ['title', 'tooltip', 'backgroundColor', 'icon']) expect(button.props[prop], `${button.props.key} ${prop}`).toBeUndefined()
        expect((button.children ?? []).every((c: any) => typeof c === 'string')).toBe(true)
      }
      expect(boxOf('disconnect-hover').props.backgroundColor).toBe(DANGER)
      expect(boxOf('switch-hover').props.backgroundColor).toBeUndefined()
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
      expect(texts(root)).not.toContain('Danxbot plan')
      expect(texts(root)).not.toContain('Refresh')
    })

    test('error: the error text in the danger colour, with no heading or Refresh', async ($, on) => {
      const d = dashboard(on)
      d.failList()
      await startSession($, d, surface)
      const pane = await mountPane($, surface)
      const all = await pane.findAll({ type: 'Text' })
      expect(all.find((t: any) => t.text.includes('500: boom'))!.props.color).toBe('red')
      expect(all.map((t: any) => t.text)).not.toContain('Refresh')
      expect(all.map((t: any) => t.text)).not.toContain('Danxbot plan')
    })
  })

  describe(`the in-progress read feeds the refs row on ${surface}`, () => {
    const callsTo = (d: any, bucket: string) => d.api.filter((a: any) => /^\/api\/plans\/23\/cards$/.test(a.path) && a.query?.bucket === bucket).length

    test('one load reads both buckets through danxbot_api, and no per-card issue read for a ref', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      expect(callsTo(d, 'needs-you')).toBe(1)
      expect(callsTo(d, 'in-progress')).toBe(1)
      expect(d.api.some((a: any) => a.path === '/api/issues/DX-9')).toBe(false)
      expect(d.calls.every((c: any) => c.server !== 'plugin:danxbot:danx-dashboard' || c.tool === 'danxbot_api' || c.tool === 'plan_connect' || c.tool === 'plan_events_wait')).toBe(true)
    })

    test('a failed in-progress call fails the load as an error shown in footer and pane, never a missing refs row', async ($, on) => {
      const d = dashboard(on, { inProgressFails: true })
      await startSession($, d, surface)
      expect(await footerText(await mountIndicator($, surface))).toBe('Danxbot · PLAN-23')
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
