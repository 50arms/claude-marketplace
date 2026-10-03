import type { PlanView } from '../../types'
import { DANGER, DONUT_QUICK_PX, SUCCESS, WARNING, busyKey, planUrl } from './config'
import { donutAlt, donutSvg } from './donut'
import type { Handlers } from './handlers'
import { donutGlyph, planPercent, problemSplit } from './words'

const STATES = ['In Progress', 'ToDo', 'Backlog', 'Review', 'Done', 'Cancelled'] as const

// The quick view: a card in the band, directly above the prompt (the closest thing to a popover the
// app draws). A real Svg donut on the desktop, the glyph and percent as text on the terminal.
export function renderQuickView(E: any, hd: Handlers, v: PlanView, hasSvg: boolean, busy: string[]): any {
  const { Box, Text, Button, Link, Svg } = E
  const plan = v.connected
  const counts = v.statusBreakdown
  if (!plan || !counts) return null
  const percent = planPercent(counts)
  const { questions, actions } = problemSplit(v)
  const capped = v.cardsTotal > v.cardsRead ? '+' : ''
  return (
    <Box key="quick-view" flexDirection="column" borderStyle="round" paddingX={1}>
      <Box flexDirection="row" gap={1} justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          {hasSvg ? (
            <Svg source={donutSvg(percent)} alt={donutAlt(percent)} width={DONUT_QUICK_PX} height={DONUT_QUICK_PX} />
          ) : (
            <Text color={SUCCESS}>{donutGlyph(percent)}</Text>
          )}
          <Box flexDirection="column">
            <Text bold>
              {plan.ref} · {plan.name}
            </Text>
            <Text dimColor>
              {plan.status} · {percent}% complete
            </Text>
          </Box>
        </Box>
        <Button key="quick-close" role="dismiss" onPress={() => hd.closeQuick()}>
          ×
        </Button>
      </Box>
      <Text>{STATES.map(s => `${s} ${counts[s]}`).join(' · ')}</Text>
      <Box flexDirection="row" gap={1}>
        <Text color={WARNING} bold>
          {questions}
          {capped} open problem{questions === 1 && !capped ? '' : 's'}
        </Text>
        <Text color={actions > 0 ? DANGER : undefined}>
          {actions}
          {capped} action{actions === 1 && !capped ? '' : 's'}
        </Text>
      </Box>
      <Text dimColor>
        {v.inProgressTotal} in progress, not waiting on you · {v.listener === 'healthy' ? 'events live' : `events ${v.listener ?? 'unknown'}`} · connected
      </Text>
      <Box flexDirection="row" gap={1}>
        <Button key="quick-open-pane" onPress={() => hd.openPane()}>
          Plan
        </Button>
        {hasSvg && (
          <Button key="quick-open-tab" onPress={() => hd.openBrowserTab(planUrl(plan.id))}>
            {busyKey.isOpeningBrowser(busy) ? 'Opening…' : 'Browser tab'}
          </Button>
        )}
        <Link key="quick-link" href={planUrl(plan.id)} label="Open ↗" />
      </Box>
    </Box>
  )
}
