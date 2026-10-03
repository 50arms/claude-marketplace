import type { Draft, PlanView } from '../../types'
import type { Handlers } from './handlers'
import { problemCard } from './problems'
import type { Ui } from './problems'
import { DANGER, SUCCESS, WARNING, planUrl } from './config'

// Everything the pane reads, gathered by register.tsx from $.state (reads need `$`).
export type PaneModel = {
  v: PlanView
  picked: string
  open: number | null
  working: string | null
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
  const candidates = m.v.plans.filter(p => p.id !== m.v.connectedPlanId)
  if (candidates.length === 0) return <Text dimColor>No plans found.</Text>
  const plan = candidates.find(p => String(p.id) === m.picked) ?? candidates[0]
  return (
    <Box flexDirection="column" gap={1}>
      <Select
        key="plan-pick"
        label="Plan"
        options={candidates.map(p => ({
          value: String(p.id),
          label: `${p.ref} · ${p.name.slice(0, 60)}${p.needsYou ? ` (${p.needsYou} needs you)` : ''}`,
        }))}
        value={String(plan.id)}
        onSelect={(value: string) => hd.pickPlan(value)}
      />
      <Box flexDirection="row" gap={1}>
        <Button key="connect" variant="primary" onPress={() => hd.connect(plan)}>
          {m.working?.startsWith('connect') ? 'Connecting…' : `${isSwitch ? 'Switch to' : 'Connect to'} ${plan.ref}`}
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
        {v.phase === 'loading' || m.working ? 'Working…' : 'Refresh'}
      </Button>
    </Box>
  )

  if (v.phase === 'no-mcp') {
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Text dimColor>The danx-dashboard MCP server is not connected in this session, so there is no plan to show.</Text>
      </Box>
    )
  }
  if (v.phase === 'error') {
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Text color={DANGER}>{v.error ?? 'Unknown error'}</Text>
      </Box>
    )
  }
  if (v.phase === 'loading' && !v.refreshedAt) {
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Text dimColor>Loading…</Text>
      </Box>
    )
  }

  if (v.connectedPlanId === null) {
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Text color={WARNING}>● Not connected to a plan</Text>
        {planPicker(hd, E, m, false)}
      </Box>
    )
  }

  const planId = v.connectedPlanId
  const plan = v.plans.find(p => p.id === planId)
  const ui: Ui = { draft: m.draft, busy: m.working, talk: m.talk, planId, now: m.now, hasBrowser: m.hasBrowser }
  const actions = v.problems.filter(p => p.type === 'action').length
  const questions = v.problems.length - actions

  return (
    <Box flexDirection="column" gap={1}>
      {header}
      <Box flexDirection="column">
        <Text color={SUCCESS}>● Connected: {plan?.ref ?? `PLAN-${planId}`}</Text>
        <Text>{plan?.name ?? ''}</Text>
        <Text dimColor>
          {plan?.status ?? ''} · events {v.listener === 'healthy' ? 'live' : (v.listener ?? 'unknown')}
        </Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        {m.hasBrowser && (
          <Button key="open-plan" onPress={() => hd.openBrowserTab(planUrl(planId))}>
            Open in browser tab
          </Button>
        )}
        <Link href={planUrl(planId)} label="Open link" />
        <Button key="switch" dimColor onPress={() => hd.toggleSwitch()}>
          Switch plan
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
      {v.refreshedAt && <Text dimColor>Updated {v.refreshedAt.slice(11, 19)}Z</Text>}
    </Box>
  )
}
