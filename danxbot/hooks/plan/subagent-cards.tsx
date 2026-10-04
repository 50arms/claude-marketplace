import type { ConnectedPlan, PlanView, SubagentRow } from '../../types'
import { SUBAGENTS_UNAVAILABLE_LINE, SUBAGENT_ACTIVITY_MAX, SUBAGENT_CARD_BACKGROUND, SUBAGENT_LABEL_MAX, SUBAGENT_SESSION_MAX, SUBAGENT_STATE_COLOR, WARNING, boardCardUrl, cardUrl } from './config'
import { compactCount, dollars, nestSubagents, runtime, visibleSubagents } from './subagents'
import type { SubagentNode } from './subagents'
import { ellipsize } from './words'

// DX-4499: the pane's Sub-agents section: every running sub-agent of the plan's live sessions, each its own card, and the ones
// that ended in the last minutes, dimmed, until the server's `visibleUntil` passes on this pane's clock (`now`). The card is
// the same tree on every surface: a rounded border in the state's colour, the theme's boxed-message fill, padding, a status dot.

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

function card(E: any, v: PlanView, plan: ConnectedPlan, now: number, node: SubagentNode, isRoot: boolean): any {
  const { Box, Text, Link } = E
  const { row, children } = node
  const ended = row.state !== 'running'
  const color = SUBAGENT_STATE_COLOR[row.state]
  const runs = runsAs(row)
  return (
    <Box
      key={`sa-${row.id}`}
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      borderDimColor={ended}
      backgroundColor={SUBAGENT_CARD_BACKGROUND}
      paddingX={1}
    >
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Box flexDirection="row" gap={1} flexShrink={1}>
          <Text color={color}>●</Text>
          <Text bold dimColor={ended} wrap="truncate-end">
            {ellipsize(row.label ?? row.id, SUBAGENT_LABEL_MAX)}
          </Text>
        </Box>
        {/* never shrunk: a narrow pane cuts the label, not the runtime (a shrunk Text would wrap its words onto two rows) */}
        <Box flexShrink={0}>
          <Text color={color} dimColor={ended}>
            {row.state === 'running' ? runtime(row, now) : `${row.state} ${runtime(row, now)}`}
          </Text>
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
        {row.card !== null && (
          <Text dimColor={ended} wrap="truncate-end">
            {ellipsize(row.card.title, SUBAGENT_LABEL_MAX)}
          </Text>
        )}
      </Box>
      {/* a spawned sub-agent runs under the same session as the one that spawned it: the title is said once, on the root */}
      {isRoot && (
        <Text dimColor wrap="truncate-end">
          session: {ellipsize(row.sessionTitle, SUBAGENT_SESSION_MAX)}
        </Text>
      )}
      <Text dimColor={ended}>
        {compactCount(row.tokensTotal)} tokens · {dollars(row.costUsd)} · {row.toolCalls} tool call{row.toolCalls === 1 ? '' : 's'}
      </Text>
      {row.activity !== null && (
        <Text dimColor wrap="truncate-end">
          {`▸ ${ellipsize(row.activity, SUBAGENT_ACTIVITY_MAX)}`}
        </Text>
      )}
      {children.length > 0 && (
        <Box flexDirection="column" gap={1} marginTop={1}>
          {children.map(child => card(E, v, plan, now, child, false))}
        </Box>
      )}
    </Box>
  )
}

// The section: its header with the counts, then a card per root, or the empty line. Read errors and the cap note follow.
export function subagentSection(E: any, v: PlanView, plan: ConnectedPlan, now: number): any {
  const { Box, Text } = E
  const { rows, errors, sessionsCapped, unavailable } = v.subagents
  const shown = visibleSubagents(rows, now)
  const running = shown.filter(r => r.state === 'running').length
  const ended = shown.length - running
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
      {unavailable && <Text dimColor>{SUBAGENTS_UNAVAILABLE_LINE}</Text>}
      {!unavailable && shown.length === 0 && errors.length === 0 && <Text dimColor>No sub-agents running.</Text>}
      {nestSubagents(shown).map(node => card(E, v, plan, now, node, true))}
      {errors.map(line => (
        <Text key={`sa-err-${line}`} color={WARNING}>
          {line}
        </Text>
      ))}
      {sessionsCapped && <Text color={WARNING}>Showing the most recently active sessions only: the plan has more live sessions than one load reads.</Text>}
    </Box>
  )
}
