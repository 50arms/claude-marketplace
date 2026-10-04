import type { ConnectedPlan, Draft, PlanView, StatusBreakdown } from '../../types'
import { donutMark } from './donut'
import type { Handlers } from './handlers'
import { iconControl } from './icon-control'
import { problemCard } from './problems'
import type { Ui } from './problems'
import {
  DANGER,
  DISCONNECTING_TIP,
  DISCONNECT_GLYPH,
  DISCONNECT_TIP,
  DONUT_PANE_PX,
  NO_EVENT_BRIDGE,
  NO_IN_PROGRESS,
  OPEN_LINK_GLYPH,
  OPEN_LINK_TIP,
  PICKER_PLAN_NAME_MAX,
  SUCCESS,
  SWITCH_GLYPH,
  SWITCH_TIP,
  WARNING,
  busyKey,
  cardUrl,
  planUrl,
} from './config'
import { cappedNote, cappedPlansNote, doneTotal, inProgressMore, planPercent, problemSplit } from './words'

// Everything the pane reads, gathered by register.tsx from $.state (reads need `$`).
export type PaneModel = {
  v: PlanView
  picked: string
  open: number | null
  working: string[]
  isSwitching: boolean
  draft: Draft | null
  talk: number | null
  now: number
  // The in-app browser exists on the desktop surface only.
  hasBrowser: boolean
  // DX-4374: the surface draws an Svg (the desktop); the terminal shows the donut as a glyph and text.
  hasSvg: boolean
}

// DX-4374: one status dot, in the colour that says what it means (green working, yellow warning).
function dot(E: any, color: string): any {
  const { Text } = E
  return <Text color={color}>●</Text>
}

// DX-4374: the progress donut with its percent and done / total: a real Svg on the desktop, the glyph and the
// same figures as text on the terminal. Only a ready, connected view has counts to show.
function progress(E: any, counts: StatusBreakdown, hasSvg: boolean): any {
  const { Box, Text } = E
  const percent = planPercent(counts)
  const { done, total } = doneTotal(counts)
  return (
    <Box key="progress" flexDirection="row" gap={1}>
      {donutMark(E, percent, hasSvg, DONUT_PANE_PX)}
      <Box flexDirection="column">
        <Text bold>{percent}%</Text>
        <Text dimColor>
          {done} / {total} done
        </Text>
      </Box>
    </Box>
  )
}

// DX-4374: the event bridge beside the connection line. Only the exact state `healthy` is the green dot and
// `events`; any other state is shown as the server names it, in the warning colour, with its next step
// verbatim; no status at all says so (never green).
function eventLine(E: any, v: PlanView): any {
  const { Box, Text } = E
  const l = v.listener
  if (l === null) {
    return (
      <Box key="events" flexDirection="row" gap={1}>
        {dot(E, WARNING)}
        <Text color={WARNING}>{NO_EVENT_BRIDGE}</Text>
      </Box>
    )
  }
  if (l.state === 'healthy') {
    return (
      <Box key="events" flexDirection="row" gap={1}>
        {dot(E, SUCCESS)}
        <Text>events</Text>
      </Box>
    )
  }
  return (
    <Box key="events" flexDirection="column">
      <Box flexDirection="row" gap={1}>
        {dot(E, WARNING)}
        <Text color={WARNING}>events: {l.state}</Text>
      </Box>
      {l.nextStep !== null && <Text color={WARNING}>{l.nextStep}</Text>}
    </Box>
  )
}

// The plan to connect to: the person's pick, else the first plan that is not the connected one.
function planPicker(hd: Handlers, E: any, m: PaneModel, isSwitch: boolean): any {
  const { Box, Text, Button, Select } = E
  const candidates = m.v.plans.filter(p => p.id !== m.v.connected?.id)
  const morePlans = cappedPlansNote(m.v)
  if (candidates.length === 0) {
    return <Text dimColor>{morePlans ? `No plans listed here. ${morePlans}.` : 'No plans found.'}</Text>
  }
  const plan = candidates.find(p => String(p.id) === m.picked) ?? candidates[0]
  return (
    <Box flexDirection="column" gap={1}>
      <Select
        key="plan-pick"
        label="Plan"
        options={candidates.map(p => ({
          value: String(p.id),
          label: `${p.ref} · ${p.name.slice(0, PICKER_PLAN_NAME_MAX)}${p.needsYou ? ` (${p.needsYou} needs you)` : ''}`,
        }))}
        value={String(plan.id)}
        onSelect={(value: string) => hd.pickPlan(value)}
      />
      {morePlans && <Text color={WARNING}>{morePlans}</Text>}
      <Box flexDirection="row" gap={1}>
        <Button key="connect" variant="primary" onPress={() => hd.connect(plan)}>
          {busyKey.isConnecting(m.working) ? 'Connecting…' : `${isSwitch ? 'Switch to' : 'Connect to'} ${plan.ref}`}
        </Button>
        {isSwitch && (
          <Button key="cancel-switch" dimColor onPress={() => hd.cancelSwitch()}>
            Cancel
          </Button>
        )}
      </Box>
    </Box>
  )
}

// DX-4415: the top line of a connected pane. Left: the connection dot and `Connected: PLAN-NN`. Right: the Browser tab
// button (desktop only), then three icon controls (Open link, Switch plan, Disconnect on a red background), each
// a one-glyph control with its hover-card tooltip.
function topLine(hd: Handlers, E: any, m: PaneModel, plan: ConnectedPlan): any {
  const { Box, Text, Button, Link } = E
  const disconnecting = busyKey.isDisconnecting(m.working)
  return (
    <Box key="top-line" flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row" gap={1}>
        <Text color={SUCCESS}>●</Text>
        <Text>Connected: {plan.ref}</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        {m.hasBrowser && (
          <Button key="open-plan" onPress={() => hd.openBrowserTab(planUrl(plan))}>
            {busyKey.isOpeningBrowser(m.working) ? 'Opening…' : 'Open in browser tab'}
          </Button>
        )}
        {iconControl(E, { key: 'open-link', tip: OPEN_LINK_TIP, control: <Link href={planUrl(plan)} label={OPEN_LINK_GLYPH} /> })}
        {iconControl(E, {
          key: 'switch',
          tip: SWITCH_TIP,
          control: (
            <Button key="switch" plain onPress={() => hd.toggleSwitch()}>
              {SWITCH_GLYPH}
            </Button>
          ),
        })}
        {iconControl(E, {
          key: 'disconnect',
          tip: disconnecting ? DISCONNECTING_TIP : DISCONNECT_TIP,
          backgroundColor: DANGER,
          control: (
            <Button key="disconnect" plain dimColor={disconnecting} onPress={() => hd.disconnect(plan)}>
              {DISCONNECT_GLYPH}
            </Button>
          ),
        })}
      </Box>
    </Box>
  )
}

// DX-4415: the cards In Progress as refs, each a link to its card page on the dashboard the plan list answered; a
// bucket larger than the load read ends in `+N`; an empty one says so in dim text.
function refs(E: any, v: PlanView, plan: ConnectedPlan): any {
  const { Box, Text, Link } = E
  const more = inProgressMore(v)
  return (
    <Box key="refs" flexDirection="row" flexWrap="wrap" gap={1}>
      {v.inProgress.length === 0 && <Text dimColor>{NO_IN_PROGRESS}</Text>}
      {v.inProgress.map(id => (
        <Link key={`ip-${id}`} href={cardUrl(plan, id)} label={id} />
      ))}
      {more && <Text dimColor>{more}</Text>}
    </Box>
  )
}

export function renderPane(E: any, hd: Handlers, m: PaneModel): any {
  const { Box, Text } = E
  const { v } = m

  // the lines of a pane with no connected plan, in one column
  const shell = (...lines: any[]) => (
    <Box flexDirection="column" gap={1}>
      {lines}
    </Box>
  )

  if (v.phase === 'no-mcp') {
    return shell(<Text dimColor>The danx-dashboard MCP server is not connected in this session, so there is no plan to show.</Text>)
  }
  if (v.phase === 'error') {
    return shell(<Text color={DANGER}>{v.error ?? 'Unknown error'}</Text>)
  }
  if (v.phase === 'loading' && !v.refreshedAt) {
    return shell(<Text dimColor>Loading…</Text>)
  }

  if (!v.connected) {
    return shell(<Text color={WARNING}>● Not connected to a plan</Text>, planPicker(hd, E, m, false))
  }

  const plan = v.connected
  const ui: Ui = { draft: m.draft, busy: m.working, talk: m.talk, plan, now: m.now, hasBrowser: m.hasBrowser }
  const { questions, actions } = problemSplit(v)

  // DX-4415, top to bottom: the top line, the events line, the plan title, the progress row (donut left, refs
  // right), the Needs You block. Nothing else (the switch picker, while open, sits under the top line).
  return (
    <Box flexDirection="column" gap={1}>
      {topLine(hd, E, m, plan)}
      {m.isSwitching && planPicker(hd, E, m, true)}
      {eventLine(E, v)}
      <Text>{plan.name}</Text>
      <Box key="progress-row" flexDirection="row" justifyContent="space-between" gap={2}>
        {/* a connected view always has its breakdown (loadPlan errors without one); the guard only narrows the type */}
        {v.statusBreakdown && progress(E, v.statusBreakdown, m.hasSvg)}
        {refs(E, v, plan)}
      </Box>
      <Box key="needs-you" flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text bold>Needs You</Text>
          <Text dimColor>{v.problems.length} open</Text>
          {actions > 0 && (
            <Text color={DANGER} bold>
              {actions} action{actions === 1 ? '' : 's'}
            </Text>
          )}
          {questions > 0 && (
            <Text color={WARNING} bold>
              {questions} question{questions === 1 ? '' : 's'}
            </Text>
          )}
        </Box>
        {v.problems.length === 0 && <Text dimColor>Nothing needs you on this plan.</Text>}
        {v.problems.map(p => problemCard(hd, E, ui, p, m.open === p.id))}
        {cappedNote(v) && <Text color={WARNING}>{cappedNote(v)}</Text>}
      </Box>
    </Box>
  )
}
