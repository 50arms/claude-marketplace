import type { PlanView } from '../../types'
import type { Handlers } from './handlers'
import { SUCCESS, WARNING, planUrl } from './config'

// Always-visible band above the prompt: connection status plus buttons for the pane and the
// plan page. With no danx-dashboard MCP server in the session it is only the Plan button:
// no label, no error.
export function renderBand(E: any, hd: Handlers, v: PlanView, hasBrowser: boolean): any {
  const { Box, Text, Button, Link } = E
  const openPane = (
    <Button key="open-pane" onPress={() => hd.openPane()}>
      Plan
    </Button>
  )
  if (v.phase === 'no-mcp') return <Box flexDirection="row">{openPane}</Box>

  const plan = v.plans.find(p => p.id === v.connectedPlanId)
  const n = v.problems.length
  const label =
    v.phase === 'error'
      ? 'plan: error'
      : v.phase === 'loading' && !v.refreshedAt
        ? 'plan: loading…'
        : v.connectedPlanId === null
          ? 'Not connected to a plan'
          : `${plan?.ref ?? `PLAN-${v.connectedPlanId}`} · ${(plan?.name ?? '').slice(0, 50)}${n ? ` · ${n} open problem${n === 1 ? '' : 's'}` : ''}`
  const planId = v.connectedPlanId
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={planId === null ? WARNING : SUCCESS}>●</Text>
      <Text dimColor>{label}</Text>
      {openPane}
      {planId !== null && hasBrowser && (
        <Button key="open-tab" onPress={() => hd.openBrowserTab(planUrl(planId))}>
          Browser tab
        </Button>
      )}
      {planId !== null && <Link href={planUrl(planId)} label="Open ↗" />}
    </Box>
  )
}
