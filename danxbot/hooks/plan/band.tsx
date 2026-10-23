import type { PlanView } from '../../types'
import { APPROVE_SIGN_IN_LABEL, codeLabel } from './approval'
import type { ApprovalRequest } from './approval'
import { BLOCKED_LINE, DANGER, DISCONNECTING_LABEL, DISCONNECT_GLYPH, DONUT_BAND_PX, SIGNING_IN_LABEL, boardCardUrl, SIGN_IN_LABEL, SUCCESS, WARNING, busyKey, needsYouUrl, planUrl } from './config'
import { donutMark } from './donut'
import type { Handlers } from './handlers'
import { mdLink } from './links'
import { permissionBadge } from './permission'
import { bandContent, bandLabelCols, bandNameText, needsYouBadge, viewPercent } from './words'

// The controls' labels the width budget counts.
const CLOSE_LABEL = '×'

// Where the band's id link goes: the plan's page, else the held card's page; null with neither, or while no dashboard origin is known.
function idUrl(plan: PlanView['connected'], card: PlanView['card'], dashboardUrl: string | null): string | null {
  if (plan !== null) return planUrl(plan)
  return card !== null && dashboardUrl !== null ? boardCardUrl({ dashboardUrl }, card.id) : null
}

// The band above the prompt: the plan line (indicator, label, then the open-problem count / the permission
// request / Disconnect and a close control hugging the right edge, the label truncating first). Every control that
// opens a page is a Markdown link (links.tsx), so the app opens it in the in-app browser the way it opens a link in the thread.
// The held plan's `PLAN-NN` (or a card-only session's card id) in the label is that link: there is no separate Open control.
// `hasSvg`: the surface draws an Svg (the desktop; the terminal shows the glyph as text).
export function renderBand(
  E: any,
  hd: Handlers,
  v: PlanView,
  hasSvg: boolean,
  busy: string[],
  // the model's permission requests still open: how many, and the newest (its approval link and code are drawn); null when none.
  permission: { count: number; newest: ApprovalRequest } | null,
  // the sign-in request waiting for the person: its link and confirm code are drawn at once.
  signIn: ApprovalRequest | null,
  // The band's width in columns (`bodyColumns`); undefined in a test mount or a surface that does not say it, then only the
  // layout's `truncate-end` on the label applies.
  columns: number | undefined,
): any {
  const { Box, Text, Button } = E
  const close = (
    <Button key="band-close" role="dismiss" onPress={() => hd.dismissBand()}>
      {CLOSE_LABEL}
    </Button>
  )
  const plan = v.connected
  // a failed load reads Disconnected, so no (stale) problem count is drawn beside it.
  const badge = v.phase === 'error' || v.phase === 'blocked' ? '' : needsYouBadge(v)
  const permissionLabel = permission === null ? '' : permissionBadge(permission.count)
  // the label takes the columns the controls leave (`columns`: the band's width, absent where the surface does not
  // say, then the layout's truncation alone applies), so the full plan name shows and only an overflowing one is cut.
  const showBadge = plan !== null && badge !== ''
  // a session with no dashboard key: the label says so in red and a Sign in button leads the controls.
  const signedOut = v.phase === 'signed-out'
  // the sign-in request's link and code show while signed out
  const approve = signedOut ? signIn : null
  // a revoked key is red too, with no Sign in
  const revoked = v.phase === 'key-revoked'
  const linkUrl = idUrl(plan, v.card, v.dashboardUrl)
  // Disconnect is the only way off a plan from the UI (connecting or switching a plan is the model's `plan_connect`). The band draws no events
  // status: the band is sign-in, the plan and Disconnect (operator, 2026-10-22); a relay fault reaches the person as its toast.
  const disconnecting = busyKey.isDisconnecting(busy)
  // Disconnect is the glyph in the theme's error color. A Button's `label`, when set, is what the desktop draws (ButtonProps.label), so it carries
  // none: the `Text` child is its text (children of strings and Text are drawn in the label's place) and the Button is keyed instead.
  const disconnectShown = disconnecting ? DISCONNECTING_LABEL : DISCONNECT_GLYPH
  const controls = [
    ...(signedOut ? [{ label: SIGN_IN_LABEL, isButton: true }] : []),
    ...(approve !== null ? [{ label: APPROVE_SIGN_IN_LABEL, isButton: false }, { label: codeLabel(approve), isButton: false }] : []),
    ...(showBadge ? [{ label: badge, isButton: false }] : []),
    ...(permission !== null ? [{ label: permissionLabel, isButton: false }] : []),
    ...(permission !== null ? [{ label: codeLabel(permission.newest), isButton: false }] : []),
    ...(plan !== null ? [{ label: disconnectShown, isButton: true }] : []),
    { label: CLOSE_LABEL, isButton: true },
  ]
  // the column model is the terminal's (a cell per character, `[ label ]` button chrome). The desktop draws proportional text
  // and native buttons, so the model over-counted and cut the name far short of the real space (`PLAN-NN · 50 …` beside a wide empty gap).
  // The desktop therefore passes the full name and lets the layout cut it: the label box shrinks (the controls never do) and its
  // `truncate-end` puts the … exactly where the name would run into them.
  const labelCols = columns === undefined || hasSvg ? undefined : bandLabelCols(columns, controls)
  const percent = viewPercent(v)
  // a failed load is red (the label says Disconnected); no plan is yellow; a loaded plan is green.
  const failed = v.phase === 'error' || signedOut || revoked
  // auto mode blocking the plugin's calls is not a failure of the plan: yellow, with the sentence and fix on a line of its own (full width, wrapped)
  const blocked = v.phase === 'blocked'
  const failedColor = failed ? DANGER : blocked ? WARNING : undefined
  const indicator =
    percent === null ? (
      <Text color={failedColor ?? (plan === null ? WARNING : SUCCESS)}>●</Text>
    ) : (
      donutMark(E, percent, hasSvg, DONUT_BAND_PX)
    )
  const content = bandContent(v, labelCols)
  const parts = 'parts' in content ? content.parts : null
  const line = (
    <Box key="band-line" flexDirection="row" gap={1} minWidth={0}>
      <Box flexShrink={0}>{indicator}</Box>
      {/* the Needs You card count leads the plan link: a call to action that opens the plan's Needs You tab. */}
      {showBadge && plan !== null && <Box flexShrink={0}>{mdLink(E, 'needs-you', badge, needsYouUrl(plan))}</Box>}
      {/* a flex item never shrinks below its content's width unless its min width is 0, so without minWidth={0} and the
          clip the full name pushed the controls off the band's edge instead of being cut by `truncate-end`. */}
      <Box flexShrink={1} minWidth={0} overflow="hidden" flexDirection="row">
        {/* a held plan or card reads `<id> · <name>`, the id the link that opens the plan (or the card of a plan-less session). */}
        {parts !== null && linkUrl !== null && mdLink(E, plan !== null ? 'open-plan' : 'open-card', parts.ref, linkUrl)}
        {parts !== null && linkUrl === null && <Text dimColor wrap="truncate-end">{parts.ref}</Text>}
        {/* a failed load is full-strength red, not dimmed: dim red washes out and reads as decoration. */}
        <Text color={failedColor} dimColor={!failed} wrap="truncate-end">
          {'parts' in content ? bandNameText(content.parts) : content.state}
        </Text>
      </Box>
      <Box flexGrow={1} />
      <Box flexDirection="row" gap={1} flexShrink={0}>
        {signedOut && (
          <Button key="sign-in" variant="primary" onPress={() => hd.signIn()}>
            {busyKey.isSigningIn(busy) ? SIGNING_IN_LABEL : SIGN_IN_LABEL}
          </Button>
        )}
        {approve !== null && mdLink(E, 'approve-sign-in', APPROVE_SIGN_IN_LABEL, approve.url)}
        {approve !== null && <Text key="sign-in-code">{codeLabel(approve)}</Text>}
        {/* the newest open permission request: its approval page, with the code to check against the page. */}
        {permission !== null && mdLink(E, 'open-permission', permissionLabel, permission.newest.url)}
        {permission !== null && <Text key="permission-code">{codeLabel(permission.newest)}</Text>}
        {plan !== null && (
          <Button key="disconnect" plain dimColor={disconnecting} onPress={() => hd.disconnect(plan)}>
            <Text color="error">{disconnectShown}</Text>
          </Button>
        )}
        {close}
      </Box>
    </Box>
  )
  if (!blocked) return line
  return (
    <Box key="band-blocked" flexDirection="column" minWidth={0}>
      {line}
      <Text color={WARNING}>{BLOCKED_LINE}</Text>
    </Box>
  )
}
