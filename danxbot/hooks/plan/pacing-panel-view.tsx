import { DANGER, SUCCESS, WARNING } from './config'
import type { PacingLevel } from '../../types'
import { LEVEL_LABEL, LIMIT_LABEL, MODE_LABEL, bandSegments, clockText, untilText, verdictLines } from './pacing-format'
import type { PanelEntry, PanelModel } from './pacing-panel'
import { age } from './words'

// DX-4339: the pacing panel's drawing. The colour says the level (green on pace, yellow over pace, red critical); no level (no target known, or
// no figure) is dim.
export const LEVEL_COLOR: Record<PacingLevel, string> = { on_pace: SUCCESS, over_pace: WARNING, critical: DANGER }
const colorOf = (level: PacingLevel | null): string | undefined => (level === null ? undefined : LEVEL_COLOR[level])

// The band's pacing segments, one short Text each. null when there is nothing to show.
export function pacingBand(E: any, m: PanelModel | undefined): any {
  const segments = m === undefined ? [] : bandSegments(m)
  if (segments.length === 0) return null
  const { Box, Text } = E
  return (
    <Box key="band-pacing" flexDirection="row" gap={1} flexShrink={0}>
      {segments.map(s => (
        <Text key={s.key} color={colorOf(s.level)} dimColor={s.level === null}>
          {s.text}
        </Text>
      ))}
    </Box>
  )
}

function entryLines(E: any, e: PanelEntry, now: number): any {
  const { Box, Text } = E
  const color = colorOf(e.level)
  const detail = [
    e.settings === null ? null : `target ${e.settings.targetPercent}%`,
    e.settings === null ? null : `critical ${e.settings.criticalPercent}%`,
    e.settings === null ? null : MODE_LABEL[e.settings.mode],
    e.resetsAt === null ? null : `resets in ${untilText(e.resetsAt, now)} (${clockText(e.resetsAt)})`,
  ].filter(Boolean)
  return (
    <Box key={`pace-${e.limit}`} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={color} dimColor={e.level === null}>
          ●
        </Text>
        <Text bold>{LIMIT_LABEL[e.limit].pane}</Text>
        <Text color={color}>{e.used === null ? 'no reading yet' : `${e.used}% used`}</Text>
        {e.level !== null && <Text color={color}>{LEVEL_LABEL[e.level]}</Text>}
      </Box>
      {detail.length > 0 && <Text dimColor>{detail.join(' · ')}</Text>}
    </Box>
  )
}

// The pane's pacing section: each enabled limit in full, then the account's verdict (level, budget, running agents, and the hold until the
// reset). While the settings read is not working the section is marked local: quietly when there is no danxbot to read (silent), and with the
// named error when danxbot answered and the answer was unusable. null when there is nothing to show.
export function pacingPane(E: any, m: PanelModel, now: number): any {
  // a real settings error shows even with no window figures: it is the one thing the pane can say
  if (m.entries.length === 0 && m.error === null) return null
  const { Box, Text } = E
  const targets = m.settingsAt === null ? 'no known targets' : `the targets last read ${age(new Date(m.settingsAt).toISOString(), now)}`
  return (
    <Box key="pane-pacing" flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold>Usage pacing</Text>
        {m.local && <Text dimColor>local</Text>}
      </Box>
      {m.entries.map(e => entryLines(E, e, now))}
      {m.verdict !== null && verdictLines(m.verdict, now).map(line => <Text key={line}>{line}</Text>)}
      {m.error !== null && (
        <Text color={WARNING}>
          Pacing settings could not be read: {m.error}.{m.entries.length > 0 && ` These are this session's own figures against ${targets}, with no verdict.`}
        </Text>
      )}
    </Box>
  )
}
