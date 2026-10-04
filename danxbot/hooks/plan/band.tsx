import type { PlanView } from '../../types'
import { DANGER, DONUT_BAND_PX, SUCCESS, WARNING, busyKey, planUrl } from './config'
import { donutMark } from './donut'
import type { Handlers } from './handlers'
import { bandLabel, viewPercent } from './words'

// The band above the prompt: the plan line (indicator, label, then Plan / Browser tab / Open and a
// close control hugging the right edge, the label truncating first).
// With no danx-dashboard MCP server in the session it is only the Plan button: no label, no error.
// `hasSvg`: the surface draws an Svg (the desktop; the terminal shows the glyph as text). `hasBrowser`: it has the
// in-app browser (also the desktop today, but a different fact).
export function renderBand(
  E: any,
  hd: Handlers,
  v: PlanView,
  hasSvg: boolean,
  hasBrowser: boolean,
  busy: string[],
): any {
  const { Box, Text, Button, Link } = E
  const openPane = (
    <Button key="open-pane" onPress={() => hd.openPane()}>
      Plan
    </Button>
  )
  const close = (
    <Button key="band-close" role="dismiss" onPress={() => hd.dismissBand()}>
      ×
    </Button>
  )
  if (v.phase === 'no-mcp') {
    return (
      <Box flexDirection="row">
        {openPane}
        <Box flexGrow={1} />
        {close}
      </Box>
    )
  }

  const plan = v.connected
  const percent = viewPercent(v)
  // DX-4419: a failed load is red (the label says Disconnected); no plan is yellow; a loaded plan is green.
  const failed = v.phase === 'error'
  const failedColor = failed ? DANGER : undefined
  const indicator =
    percent === null ? (
      <Text color={failedColor ?? (plan === null ? WARNING : SUCCESS)}>●</Text>
    ) : (
      donutMark(E, percent, hasSvg, DONUT_BAND_PX)
    )
  return (
    <Box key="band-line" flexDirection="row" gap={1}>
      <Box flexShrink={0}>{indicator}</Box>
      <Box flexShrink={1}>
        {/* DX-4419: a failed load is full-strength red, not dimmed: dim red washes out and reads as decoration. */}
        <Text color={failedColor} dimColor={!failed} wrap="truncate-end">
          {bandLabel(v)}
        </Text>
      </Box>
      <Box flexGrow={1} />
      <Box flexDirection="row" gap={1} flexShrink={0}>
        {openPane}
        {plan !== null && hasBrowser && (
          <Button key="open-tab" onPress={() => hd.openBrowserTab(planUrl(plan))}>
            {busyKey.isOpeningBrowser(busy) ? 'Opening…' : 'Browser tab'}
          </Button>
        )}
        {plan !== null && <Link href={planUrl(plan)} label="Open ↗" />}
        {close}
      </Box>
    </Box>
  )
}
