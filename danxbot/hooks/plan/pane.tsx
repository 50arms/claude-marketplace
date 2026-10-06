import type { LiveSubagents, PlanView, RelayState, StatusBreakdown } from '../../types'
import { APPROVE_SIGN_IN_LABEL, signInCodeLabel } from './approval'
import type { ApprovalRequest } from './approval'
import { donutMark } from './donut'
import type { Handlers } from './handlers'
import type { PanelModel } from './pacing-panel'
import { pacingPane } from './pacing-panel-view'
import { problemRow } from './problems'
import { subagentSection } from './subagent-cards'
import { CARD_TITLE_MAX, DANGER, DONUT_PANE_PX, NO_EVENT_STATUS, PICKER_PLAN_NAME_MAX, RESTART_LINE, KEY_REVOKED_LINE, SIGNED_OUT_LABEL, SIGNED_OUT_LINE, SIGNING_IN_LABEL, SIGN_IN_LABEL, SUCCESS, WARNING, busyKey, cardUrl, planUrl } from './config'
import { age, bandLabel, cappedInProgressNote, cappedNote, cappedPlansNote, doneTotal, planPercent, problemSplit, updatedText } from './words'

// Everything the pane reads, gathered by register.tsx from $.state (reads need `$`).
export type PaneModel = {
  v: PlanView
  picked: string
  working: string[]
  isSwitching: boolean
  now: number
  // The in-app browser exists on the desktop surface only.
  hasBrowser: boolean
  // DX-4374: the surface draws an Svg (the desktop); the terminal shows the donut as a glyph and text.
  hasSvg: boolean
  // DX-4508: the live child's numbers for this session's sub-agents
  live: LiveSubagents
  // DX-4339: the usage pacing panel, shown in every state the pane has (the session's usage does not depend on the plan)
  pacing: PanelModel
  // DX-4233: the plugin's own event relay (see RelayState)
  relay: RelayState
  // DX-4630: the sign-in request waiting for the person (its link and confirm code), or null
  signIn: ApprovalRequest | null
}

// DX-4374: one status dot, in the colour that says what it means (green working, yellow warning).
function dot(E: any, color: string): any {
  const { Text } = E
  return <Text color={color}>●</Text>
}

// DX-4374: the progress donut with its percent and done / total: a real Svg on the desktop, the glyph and the
// same figures as text on the terminal. Only a ready, connected view has counts to show.
function progress(E: any, counts: StatusBreakdown, hasSvg: boolean): any {
  const { Box, Text } = E
  const percent = planPercent(counts)
  const { done, total } = doneTotal(counts)
  return (
    <Box key="progress" flexDirection="row" gap={1}>
      {donutMark(E, percent, hasSvg, DONUT_PANE_PX)}
      <Box flexDirection="column">
        <Text bold>{percent}%</Text>
        <Text dimColor>
          {done} / {total} done
        </Text>
      </Box>
    </Box>
  )
}

// DX-4374: the event listener beside the connection line. Only the exact state `healthy` is the green dot and
// `events`; any other state is shown as the server names it, in the warning colour, with its next step
// verbatim; no status at all says so (never green).
// DX-4233: the relay is this plugin's own loop, so when it is not streaming its own failure is shown first, in the warning
// colour with its cause or fix: a relay that retries or stopped is never drawn green, whatever the dashboard last read.
function eventLine(E: any, v: PlanView, relay: RelayState): any {
  const { Box, Text } = E
  // the relay's state belongs to the plan it serves: one left over from another plan says nothing about this one
  if ((relay.phase === 'retrying' || relay.phase === 'stopped') && v.connected !== null && relay.planId === v.connected.id) {
    return (
      <Box key="events" flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {dot(E, WARNING)}
          <Text color={WARNING}>events: {relay.phase === 'stopped' ? 'relay stopped' : 'relay retrying'}</Text>
        </Box>
        {relay.detail !== null && <Text color={WARNING}>{relay.detail}</Text>}
      </Box>
    )
  }
  const l = v.listener
  if (l === null) {
    return (
      <Box key="events" flexDirection="row" gap={1}>
        {dot(E, WARNING)}
        <Text color={WARNING}>{NO_EVENT_STATUS}</Text>
      </Box>
    )
  }
  if (l.state === 'healthy') {
    return (
      <Box key="events" flexDirection="row" gap={1}>
        {dot(E, SUCCESS)}
        <Text>events</Text>
      </Box>
    )
  }
  return (
    <Box key="events" flexDirection="column">
      <Box flexDirection="row" gap={1}>
        {dot(E, WARNING)}
        <Text color={WARNING}>events: {l.state}</Text>
      </Box>
      {l.nextStep !== null && <Text color={WARNING}>{l.nextStep}</Text>}
    </Box>
  )
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
      {pacingPane(E, m.pacing, m.now)}
      {lines}
    </Box>
  )

  // DX-4423: the server's own text for this is written for the agent; the person reads this and presses Sign in.
  if (v.phase === 'signed-out') {
    return shell(
      <Text key="signed-out" color={DANGER} bold>
        ● {SIGNED_OUT_LABEL}
      </Text>,
      <Text>{SIGNED_OUT_LINE}</Text>,
      ...(m.signIn === null
        ? []
        : [
            <Box key="approve-sign-in" flexDirection="row" gap={1}>
              <Link href={m.signIn.url} label={APPROVE_SIGN_IN_LABEL} />
              <Text>{signInCodeLabel(m.signIn)}</Text>
            </Box>,
          ]),
      <Button key="sign-in" variant="primary" onPress={() => hd.signIn()}>
        {busyKey.isSigningIn(m.working) ? SIGNING_IN_LABEL : SIGN_IN_LABEL}
      </Button>,
    )
  }
  // DX-4418: a person revoked the key: who, and that the session must stop. No Sign in: a revoked agent must stop.
  if (v.phase === 'key-revoked') {
    return shell(
      <Text key="key-revoked" color={DANGER} bold>
        ● {bandLabel(v)}
      </Text>,
      <Text>{KEY_REVOKED_LINE}</Text>,
    )
  }
  if (v.phase === 'error') {
    return shell(<Text color={DANGER}>{v.staleServer ? RESTART_LINE : (v.error ?? 'Unknown error')}</Text>)
  }
  if (v.phase === 'loading' && !v.refreshedAt) {
    return shell(<Text dimColor>Loading…</Text>)
  }

  if (!v.connected) {
    return shell(<Text color={WARNING}>● Not connected to a plan</Text>, planPicker(hd, E, m, false))
  }

  const plan = v.connected
  const { questions, actions } = problemSplit(v)

  return (
    <Box flexDirection="column" gap={1}>
      {header}
      {pacingPane(E, m.pacing, m.now)}
      <Box flexDirection="column">
        <Text color={SUCCESS}>● Connected: {plan.ref}</Text>
        <Text>{plan.name}</Text>
        <Text dimColor>{plan.status}</Text>
        {eventLine(E, v, m.relay)}
      </Box>
      {/* a connected view always has its breakdown (loadPlan errors without one); the guard only narrows the type */}
      {v.statusBreakdown && progress(E, v.statusBreakdown, m.hasSvg)}
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
      {v.problems.length === 0 && v.cardErrors.length === 0 && <Text dimColor>Nothing needs you on this plan.</Text>}
      {v.problems.map(p => problemRow(E, plan, p))}
      {v.cardErrors.map(line => (
        <Text key={`err-${line}`} color={WARNING}>
          {line}
        </Text>
      ))}
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

      {/* DX-4499: after the cards they work on, so a sub-agent's card ref sits under the In progress list it belongs to */}
      {subagentSection(E, v, plan, m.now, m.live)}
      {/* DX-4448: the plan loaded, but the card links did not: say why replies show plain card ids, never silently */}
      {v.links.state === 'error' && <Text color={WARNING}>Card ids in replies are not linked: {v.links.message}</Text>}
      {v.refreshedAt && <Text dimColor>{updatedText(v.refreshedAt)}</Text>}
    </Box>
  )
}
