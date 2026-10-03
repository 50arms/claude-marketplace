import type { PlanView } from '../../types'
import { DONUT_BAND_PX, SUCCESS, WARNING, busyKey, planUrl } from './config'
import { donutAlt, donutSvg } from './donut'
import type { Handlers } from './handlers'
import { renderQuickView } from './quick'
import { bandLabel, donutGlyph, viewPercent } from './words'

// The band above the prompt: the plan line (indicator, label, then Plan / Browser tab / Open and a
// close control hugging the right edge, the label truncating first) and, when open, the quick view.
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
  quickOpen: boolean,
): any {
  const { Box, Text, Button, Link, Svg } = E
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
  const indicator =
    percent === null ? (
      <Text color={plan === null ? WARNING : SUCCESS}>●</Text>
    ) : hasSvg ? (
      <Svg source={donutSvg(percent)} alt={donutAlt(percent)} width={DONUT_BAND_PX} height={DONUT_BAND_PX} />
    ) : (
      <Text color={SUCCESS}>{donutGlyph(percent)}</Text>
    )
  const line = (
    <Box key="band-line" flexDirection="row" gap={1}>
      <Box flexShrink={0}>{indicator}</Box>
      <Box flexShrink={1}>
        <Text dimColor wrap="truncate-end">
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
  const quick = quickOpen && percent !== null ? renderQuickView(E, hd, v, hasSvg, hasBrowser, busy) : null
  return quick ? (
    <Box flexDirection="column">
      {line}
      {quick}
    </Box>
  ) : (
    line
  )
}
