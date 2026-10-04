import type { ConnectedPlan, LiveSubagents, PlanView, SubagentRow } from '../../types'
import { LIVE_REASON_MAX, SUBAGENTS_UNAVAILABLE_LINE, SUBAGENT_ACTIVITY_MAX, SUBAGENT_CARD_BACKGROUND, SUBAGENT_LABEL_MAX, SUBAGENT_STATE_COLOR, SUBAGENT_UNTITLED, WARNING, boardCardUrl, cardUrl, liveUnavailableLine } from './config'
import { withLive } from './live'
import { compactCount, dollars, nestSubagents, runtime, visibleSubagents } from './subagents'
import type { SubagentNode } from './subagents'
import { ellipsize } from './words'

// DX-4499: the pane's Sub-agents section: every running sub-agent of the plan's live sessions, each its own card, and the ones
// that ended in the last minutes, dimmed, until the server's `visibleUntil` passes on this pane's clock (`now`).
// DX-4508: the card is drawn as Claude Code's own background task cards are: a raised fill (SUBAGENT_CARD_BACKGROUND) with rounded
// corners and no visible border (a Box rounds only by drawing a `round` border, so it draws one in the fill's own colour), padding,
// colour only on the small status dot, the name in the primary text colour and every metadata line muted. This session's rows carry
// the live child's numbers (withLive).

// The card's link: the plan's own card page when the plan holds the card, else the card's own board page (the plan-free route),
// as a card id in a reply is linked (card-links.ts). With the links unread (v.links in error) the id is not known to be the plan's, so it
// takes the board page, which exists for every card.
function cardHref(v: PlanView, plan: ConnectedPlan, id: string): string {
  return v.links.state === 'ready' && v.links.planCardIds.includes(id) ? cardUrl(plan, id) : boardCardUrl(plan, id)
}

// "danxbot:worker-sonnet-high · claude-sonnet-5-5 · high": whatever of the three the dashboard knows.
function runsAs(row: SubagentRow): string {
  return [row.agentType, row.model, row.effort].filter((x): x is string => x !== null).join(' · ')
}

// DX-4508: its description, else its agent type; never its id.
function titleOf(row: SubagentRow): string {
  return row.label ?? row.agentType ?? SUBAGENT_UNTITLED
}

function card(E: any, v: PlanView, plan: ConnectedPlan, now: number, node: SubagentNode): any {
  const { Box, Text, Link } = E
  const { row, children } = node
  const ended = row.state !== 'running'
  const runs = runsAs(row)
  return (
    <Box
      key={`sa-${row.id}`}
      flexDirection="column"
      borderStyle="round"
      borderColor={SUBAGENT_CARD_BACKGROUND}
      backgroundColor={SUBAGENT_CARD_BACKGROUND}
      paddingX={1}
    >
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Box flexDirection="row" gap={1} flexShrink={1}>
          <Text color={SUBAGENT_STATE_COLOR[row.state]} dimColor={ended}>
            ●
          </Text>
          <Text bold dimColor={ended} wrap="truncate-end">
            {ellipsize(titleOf(row), SUBAGENT_LABEL_MAX)}
          </Text>
        </Box>
        {/* never shrunk: a narrow pane cuts the title, not the runtime (a shrunk Text would wrap its words onto two rows) */}
        <Box flexShrink={0}>
          <Text dimColor>{row.state === 'running' ? runtime(row, now) : `${row.state} ${runtime(row, now)}`}</Text>
        </Box>
      </Box>
      {runs !== '' && (
        <Text dimColor wrap="truncate-end">
          {runs}
        </Text>
      )}
      <Box flexDirection="row" gap={1}>
        {row.card === null && <Text dimColor>no card</Text>}
        {row.card !== null && (
          <Box flexShrink={0}>
            <Link href={cardHref(v, plan, row.card.id)} label={row.card.id} />
          </Box>
        )}
        {row.card !== null && row.card.title !== null && (
          <Text dimColor wrap="truncate-end">
            {ellipsize(row.card.title, SUBAGENT_LABEL_MAX)}
          </Text>
        )}
      </Box>
      <Text dimColor>
        {compactCount(row.tokensTotal)} tokens · {dollars(row.costUsd)} · {row.toolCalls} tool call{row.toolCalls === 1 ? '' : 's'}
      </Text>
      {row.activity !== null && (
        <Text dimColor wrap="truncate-end">
          {`▸ ${ellipsize(row.activity, SUBAGENT_ACTIVITY_MAX)}`}
        </Text>
      )}
      {children.length > 0 && (
        <Box flexDirection="column" gap={1} marginTop={1}>
          {children.map(child => card(E, v, plan, now, child))}
        </Box>
      )}
    </Box>
  )
}

// The rows the section draws at `now`: the dashboard's with this session's live numbers over them, the visible ones only.
export function shownSubagents(v: PlanView, live: LiveSubagents, now: number): SubagentRow[] {
  return visibleSubagents(withLive(v, live).rows, now)
}

// The section: its header with the counts, then a card per root, or the empty line. Read errors and the cap note follow.
export function subagentSection(E: any, v: PlanView, plan: ConnectedPlan, now: number, live: LiveSubagents): any {
  const { Box, Text } = E
  const { errors, sessionsCapped, unavailable } = v.subagents
  const merged = withLive(v, live)
  const shown = visibleSubagents(merged.rows, now)
  const running = shown.filter(r => r.state === 'running').length
  const ended = shown.length - running
  const lines = [...errors, ...merged.errors.map(e => `Couldn't draw a live sub-agent: ${e}`)]
  return (
    <Box key="subagents" flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1}>
        <Text bold>Sub-agents</Text>
        {!unavailable && (
          <Text dimColor>
            {running} running{ended > 0 ? `, ${ended} ended` : ''}
          </Text>
        )}
      </Box>
      {/* DX-4508: the live numbers failed; the dashboard's stand, and the one line says why */}
      {live.warning !== null && (
        <Text key="sa-live-warning" dimColor wrap="truncate-end">
          {liveUnavailableLine(ellipsize(live.warning, LIVE_REASON_MAX))}
        </Text>
      )}
      {unavailable && <Text dimColor>{SUBAGENTS_UNAVAILABLE_LINE}</Text>}
      {!unavailable && shown.length === 0 && lines.length === 0 && <Text dimColor>No sub-agents running.</Text>}
      {nestSubagents(shown).map(node => card(E, v, plan, now, node))}
      {lines.map(line => (
        <Text key={`sa-err-${line}`} color={WARNING}>
          {line}
        </Text>
      ))}
      {sessionsCapped && <Text color={WARNING}>Showing the most recently active sessions only: the plan has more live sessions than one load reads.</Text>}
    </Box>
  )
}
