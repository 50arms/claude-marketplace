import type { Draft, PlanView } from '../../types'
import type { Handlers } from './handlers'
import { problemCard } from './problems'
import type { Ui } from './problems'
import { CARD_TITLE_MAX, DANGER, PICKER_PLAN_NAME_MAX, SUCCESS, WARNING, busyKey, cardUrl, planUrl } from './config'
import { age, cappedInProgressNote, cappedNote, cappedPlansNote, problemSplit, updatedText, viewPercent } from './words'

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

export function renderPane(E: any, hd: Handlers, m: PaneModel): any {
  const { Box, Text, Button, Link } = E
  const { v } = m

  const header = (
    <Box flexDirection="row" justifyContent="space-between">
      <Text bold>Danxbot plan</Text>
      <Button key="refresh" dimColor onPress={() => hd.refresh()}>
        {v.phase === 'loading' || m.working.length > 0 ? 'Working…' : 'Refresh'}
      </Button>
    </Box>
  )
  // the header over one column of body lines
  const shell = (...lines: any[]) => (
    <Box flexDirection="column" gap={1}>
      {header}
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
  const percent = viewPercent(v)

  return (
    <Box flexDirection="column" gap={1}>
      {header}
      <Box flexDirection="column">
        <Text color={SUCCESS}>● Connected: {plan.ref}</Text>
        <Text>{plan.name}</Text>
        <Text dimColor>
          {plan.status} · {percent}% complete · events {v.listener === 'healthy' ? 'live' : (v.listener ?? 'unknown')}
        </Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        {m.hasBrowser && (
          <Button key="open-plan" onPress={() => hd.openBrowserTab(planUrl(plan))}>
            {busyKey.isOpeningBrowser(m.working) ? 'Opening…' : 'Open in browser tab'}
          </Button>
        )}
        <Link href={planUrl(plan)} label="Open link" />
        <Button key="switch" dimColor onPress={() => hd.toggleSwitch()}>
          Switch plan
        </Button>
        <Button key="disconnect" dimColor onPress={() => hd.disconnect(plan)}>
          {busyKey.isDisconnecting(m.working) ? 'Disconnecting…' : 'Disconnect'}
        </Button>
      </Box>
      {m.isSwitching && planPicker(hd, E, m, true)}

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

      <Box flexDirection="row" gap={1}>
        <Text bold>In progress</Text>
        <Text dimColor>{v.inProgressTotal} not waiting on you</Text>
      </Box>
      {v.inProgress.length === 0 && <Text dimColor>No cards in progress that are not waiting on you.</Text>}
      {v.inProgress.map(row => (
        <Box key={`ip-${row.id}`} flexDirection="row" gap={1}>
          <Link href={cardUrl(plan, row.id)} label={row.id} />
          <Text>{row.title.slice(0, CARD_TITLE_MAX)}</Text>
          {row.agent && <Text dimColor>{row.agent}</Text>}
          <Text dimColor>updated {age(row.updatedAt, m.now)}</Text>
        </Box>
      ))}
      {cappedInProgressNote(v) && <Text color={WARNING}>{cappedInProgressNote(v)}</Text>}
      {v.refreshedAt && <Text dimColor>{updatedText(v.refreshedAt)}</Text>}
    </Box>
  )
}
