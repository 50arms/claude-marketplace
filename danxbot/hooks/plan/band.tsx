import type { PlanView } from '../../types'
import { DANGER, DONUT_BAND_PX, SIGNING_IN_LABEL, SIGN_IN_LABEL, SUCCESS, WARNING, busyKey, needsYouUrl, planUrl } from './config'
import { donutMark } from './donut'
import type { Handlers } from './handlers'
import { bandLabel, bandLabelCols, problemBadge, viewPercent } from './words'

// DX-4420: the band button that opens the pane (it read `Plan`), and the other controls' labels the width budget counts.
const OPEN_PANE_LABEL = 'Panel'
const OPEN_LINK_LABEL = 'Open ↗'
const CLOSE_LABEL = '×'

// The widest the Browser tab button reads (it flips to `Opening…`, shorter), for the label budget.
const BROWSER_TAB_LABEL = 'Browser tab'

// The band above the prompt: the plan line (indicator, label, then Panel / the open-problem count (DX-4420) / Browser tab / Open and a
// close control hugging the right edge, the label truncating first).
// With no danx-dashboard MCP server in the session it is only the Panel button: no label, no error.
// `hasSvg`: the surface draws an Svg (the desktop; the terminal shows the glyph as text). `hasBrowser`: it has the
// in-app browser (also the desktop today, but a different fact).
export function renderBand(
  E: any,
  hd: Handlers,
  v: PlanView,
  hasSvg: boolean,
  hasBrowser: boolean,
  busy: string[],
  // The band's width in columns (`bodyColumns`); absent in a test mount or a surface that does not say it, then only the
  // layout's `truncate-end` on the label applies.
  columns?: number,
): any {
  const { Box, Text, Button, Link } = E
  const openPane = (
    <Button key="open-pane" onPress={() => hd.openPane()}>
      {OPEN_PANE_LABEL}
    </Button>
  )
  const close = (
    <Button key="band-close" role="dismiss" onPress={() => hd.dismissBand()}>
      {CLOSE_LABEL}
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
  // DX-4420: a failed load reads Disconnected, so no (stale) problem count is drawn beside it.
  const badge = v.phase === 'error' ? '' : problemBadge(v)
  // DX-4420: the label takes the columns the controls leave (`columns`: the band's width, absent where the surface does not
  // say, then the layout's truncation alone applies), so the full plan name shows and only an overflowing one is cut.
  const showBadge = plan !== null && badge !== ''
  // DX-4423: a session with no dashboard key: the label says so in red and a Sign in button leads the controls.
  const signedOut = v.phase === 'signed-out'
  const controls = [
    ...(signedOut ? [{ label: SIGN_IN_LABEL, isButton: true }] : []),
    { label: OPEN_PANE_LABEL, isButton: true },
    ...(showBadge ? [{ label: badge, isButton: hasBrowser }] : []),
    ...(plan !== null && hasBrowser ? [{ label: BROWSER_TAB_LABEL, isButton: true }] : []),
    ...(plan !== null ? [{ label: OPEN_LINK_LABEL, isButton: false }] : []),
    { label: CLOSE_LABEL, isButton: true },
  ]
  const labelCols = columns === undefined ? undefined : bandLabelCols(columns, controls)
  const percent = viewPercent(v)
  // DX-4419: a failed load is red (the label says Disconnected); no plan is yellow; a loaded plan is green.
  const failed = v.phase === 'error' || signedOut
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
          {bandLabel(v, labelCols)}
        </Text>
      </Box>
      <Box flexGrow={1} />
      <Box flexDirection="row" gap={1} flexShrink={0}>
        {signedOut && (
          <Button key="sign-in" variant="primary" onPress={() => hd.signIn()}>
            {busyKey.isSigningIn(busy) ? SIGNING_IN_LABEL : SIGN_IN_LABEL}
          </Button>
        )}
        {openPane}
        {/* DX-4420: the open-problem count is a call to action that opens the plan's Needs You tab: a Button into the
            in-app browser where there is one (the Browser tab path), a Link elsewhere. A Button carries no colour, so
            the primary variant stands in for the warning tone. */}
        {showBadge &&
          plan !== null &&
          (hasBrowser ? (
            <Button key="open-problems" variant="primary" onPress={() => hd.openBrowserTab(needsYouUrl(plan))}>
              {badge}
            </Button>
          ) : (
            <Link href={needsYouUrl(plan)} label={badge} />
          ))}
        {plan !== null && hasBrowser && (
          <Button key="open-tab" onPress={() => hd.openBrowserTab(planUrl(plan))}>
            {busyKey.isOpeningBrowser(busy) ? 'Opening…' : BROWSER_TAB_LABEL}
          </Button>
        )}
        {plan !== null && <Link href={planUrl(plan)} label={OPEN_LINK_LABEL} />}
        {close}
      </Box>
    </Box>
  )
}
