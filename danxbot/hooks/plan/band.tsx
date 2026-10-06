import type { PlanView } from '../../types'
import { APPROVE_SIGN_IN_LABEL, signInCodeLabel } from './approval'
import type { ApprovalRequest } from './approval'
import { DANGER, DONUT_BAND_PX, SIGNING_IN_LABEL, SIGN_IN_LABEL, SUCCESS, WARNING, busyKey, needsYouUrl, planUrl, plansUrl } from './config'
import { donutMark } from './donut'
import type { Handlers } from './handlers'
import { permissionBadge } from './permission'
import { bandText } from './pacing-format'
import type { PanelModel } from './pacing-panel'
import { pacingBand } from './pacing-panel-view'
import { bandLabel, bandLabelCols, problemBadge, viewPercent } from './words'

// DX-4420: the band button that opens the pane (it read `Plan`), and the other controls' labels the width budget counts.
const OPEN_PANE_LABEL = 'Panel'
const OPEN_LINK_LABEL = 'Open ↗'
const CLOSE_LABEL = '×'

// The widest the Browser tab button reads (it flips to `Opening…`, shorter), for the label budget.
const BROWSER_TAB_LABEL = 'Browser tab'

// The band above the prompt: the plan line (indicator, label, then Panel / the open-problem count (DX-4420) / Browser tab / Open and a
// close control hugging the right edge, the label truncating first).
// `hasSvg`: the surface draws an Svg (the desktop; the terminal shows the glyph as text). `hasBrowser`: it has the
// in-app browser (also the desktop today, but a different fact).
export function renderBand(
  E: any,
  hd: Handlers,
  v: PlanView,
  hasSvg: boolean,
  hasBrowser: boolean,
  busy: string[],
  // DX-4435: how many of the model's permission requests are still open.
  permissionRequests: number,
  // DX-4630: the sign-in request waiting for the person: its Link and confirm code are drawn at once.
  signIn: ApprovalRequest | null,
  // The band's width in columns (`bodyColumns`); absent in a test mount or a surface that does not say it, then only the
  // layout's `truncate-end` on the label applies.
  columns?: number,
  // DX-4339: the pacing entries beside the controls: each enabled limit's usage against its target, coloured by level.
  pacing?: PanelModel,
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
  const plan = v.connected
  // DX-4420: a failed load reads Disconnected, so no (stale) problem count is drawn beside it.
  const badge = v.phase === 'error' ? '' : problemBadge(v)
  const permissionLabel = permissionBadge(permissionRequests)
  // DX-4420: the label takes the columns the controls leave (`columns`: the band's width, absent where the surface does not
  // say, then the layout's truncation alone applies), so the full plan name shows and only an overflowing one is cut.
  const showBadge = plan !== null && badge !== ''
  // DX-4423: a session with no dashboard key: the label says so in red and a Sign in button leads the controls.
  const signedOut = v.phase === 'signed-out'
  // DX-4418: a revoked key is red too, with no Sign in
  const revoked = v.phase === 'key-revoked'
  // DX-4521: both links are in every state: the plan's page when connected, else the dashboard's plans list. Only an origin never
  // seen (a first load, or a machine that has not yet reached its dashboard) leaves them out: there is no address to open.
  const linkUrl = plan !== null ? planUrl(plan) : v.dashboardUrl !== null ? plansUrl(v.dashboardUrl) : null
  const pacingLabel = pacing === undefined ? '' : bandText(pacing)
  const controls = [
    ...(pacingLabel !== '' ? [{ label: pacingLabel, isButton: false }] : []),
    ...(signedOut ? [{ label: SIGN_IN_LABEL, isButton: true }] : []),
    ...(signIn !== null ? [{ label: APPROVE_SIGN_IN_LABEL, isButton: false }, { label: signInCodeLabel(signIn), isButton: false }] : []),
    { label: OPEN_PANE_LABEL, isButton: true },
    ...(showBadge ? [{ label: badge, isButton: hasBrowser }] : []),
    ...(permissionLabel !== '' ? [{ label: permissionLabel, isButton: true }] : []),
    ...(linkUrl !== null && hasBrowser ? [{ label: BROWSER_TAB_LABEL, isButton: true }] : []),
    ...(linkUrl !== null ? [{ label: OPEN_LINK_LABEL, isButton: false }] : []),
    { label: CLOSE_LABEL, isButton: true },
  ]
  // DX-4626: the column model is the terminal's (a cell per character, `[ label ]` button chrome). The desktop draws proportional text
  // and native buttons, so the model over-counted and cut the name far short of the real space (`PLAN-17 · 50 …` beside a wide empty gap).
  // The desktop therefore passes the full name and lets the layout cut it: the label box shrinks (the controls never do) and its
  // `truncate-end` puts the … exactly where the name would run into them.
  const labelCols = columns === undefined || hasSvg ? undefined : bandLabelCols(columns, controls)
  const percent = viewPercent(v)
  // DX-4419: a failed load is red (the label says Disconnected); no plan is yellow; a loaded plan is green.
  const failed = v.phase === 'error' || signedOut || revoked
  const failedColor = failed ? DANGER : undefined
  const indicator =
    percent === null ? (
      <Text color={failedColor ?? (plan === null ? WARNING : SUCCESS)}>●</Text>
    ) : (
      donutMark(E, percent, hasSvg, DONUT_BAND_PX)
    )
  return (
    <Box key="band-line" flexDirection="row" gap={1} minWidth={0}>
      <Box flexShrink={0}>{indicator}</Box>
      {/* DX-4626: a flex item never shrinks below its content's width unless its min width is 0, so without minWidth={0} and the
          clip the full name pushed the controls off the band's edge instead of being cut by `truncate-end`. */}
      <Box flexShrink={1} minWidth={0} overflow="hidden">
        {/* DX-4419: a failed load is full-strength red, not dimmed: dim red washes out and reads as decoration. */}
        <Text color={failedColor} dimColor={!failed} wrap="truncate-end">
          {bandLabel(v, labelCols)}
        </Text>
      </Box>
      <Box flexGrow={1} />
      <Box flexDirection="row" gap={1} flexShrink={0}>
        {pacingBand(E, pacing)}
        {signedOut && (
          <Button key="sign-in" variant="primary" onPress={() => hd.signIn()}>
            {busyKey.isSigningIn(busy) ? SIGNING_IN_LABEL : SIGN_IN_LABEL}
          </Button>
        )}
        {signIn !== null && <Link key="approve-sign-in" href={signIn.url} label={APPROVE_SIGN_IN_LABEL} />}
        {signIn !== null && <Text key="sign-in-code">{signInCodeLabel(signIn)}</Text>}
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
        {permissionLabel !== '' && (
          <Button key="open-permission" variant="primary" onPress={() => hd.openPermissionRequest()}>
            {permissionLabel}
          </Button>
        )}
        {linkUrl !== null && hasBrowser && (
          <Button key="open-tab" onPress={() => hd.openBrowserTab(linkUrl)}>
            {busyKey.isOpeningBrowser(busy) ? 'Opening…' : BROWSER_TAB_LABEL}
          </Button>
        )}
        {linkUrl !== null && <Link href={linkUrl} label={OPEN_LINK_LABEL} />}
        {close}
      </Box>
    </Box>
  )
}
