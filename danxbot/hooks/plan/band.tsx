import type { PlanView } from '../../types'
import { SUCCESS, WARNING, planUrl } from './config'
import type { Handlers } from './handlers'
import { bandLabel } from './words'

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

  const planId = v.connected?.id ?? null
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={planId === null ? WARNING : SUCCESS}>●</Text>
      <Text dimColor>{bandLabel(v)}</Text>
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
