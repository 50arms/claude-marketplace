import { DANGER, ORANGE, SUCCESS, WARNING } from './config'
import type { PacingLevel } from '../../types'
import { tooltipCard } from './tooltip-card'
import { LEVEL_LABEL, LIMIT_LABEL, NEEDS_DANXBOT, SPEND_LABEL, SPEND_UNJUDGED_SHORT, bandSegments, entryTip, spendTip, untilText, verdictLines } from './pacing-format'
import type { Tone } from './pacing-format'
import type { PanelEntry, PanelModel, SpendEntry } from './pacing-panel'
import { age } from './words'

// DX-4339: the pacing panel's drawing. The colour says the level (green on pace, yellow over pace, red critical); no level (no target known, or
// no figure) is dim.
export const LEVEL_COLOR: Record<PacingLevel, string> = { on_pace: SUCCESS, over_pace: WARNING, critical: DANGER }
// DX-4656: the server's states: spare green, short yellow, hold orange, stop red.
export const TONE_COLOR: Record<Tone, string> = { ...LEVEL_COLOR, spare: SUCCESS, short: WARNING, hold: ORANGE, stop: DANGER }
const colorOf = (level: Tone | null): string | undefined => (level === null ? undefined : TONE_COLOR[level])

// The band's pacing segments, one short Text each. null when there is nothing to show.
export function pacingBand(E: any, m: PanelModel | undefined): any {
  const segments = m === undefined ? [] : bandSegments(m)
  if (segments.length === 0) return null
  const { Box, Text } = E
  return (
    <Box key="band-pacing" flexDirection="row" gap={1} flexShrink={0}>
      {segments.map(s => (
        <Text key={s.key} color={colorOf(s.tone)} dimColor={s.tone === null}>
          {s.text}
        </Text>
      ))}
    </Box>
  )
}

// DX-4854: ONE compact line per limit: the dot, the name, the used figure, the level, and when it resets. The detail the line leaves out
// (the server's sentence, target, critical, mode, the reset clock) is the row's hover card, drawn hidden until the pointer is on the row.
function limitRow(E: any, o: { key: string; name: string; color: string | undefined; figure: string; level: PacingLevel | null; resetsAt: number | null; tip: string[]; now: number }): any {
  const { Box, Text } = E
  return (
    <Box key={o.key}>
      <Box flexDirection="row" gap={1}>
        <Text color={o.color} dimColor={o.level === null}>
          ●
        </Text>
        <Text bold>{o.name}</Text>
        <Text color={o.color} dimColor={o.level === null}>
          {o.figure}
        </Text>
        {o.level !== null && <Text color={o.color}>{LEVEL_LABEL[o.level]}</Text>}
        {o.resetsAt !== null && <Text dimColor>{`resets in ${untilText(o.resetsAt, o.now)}`}</Text>}
      </Box>
      {tooltipCard(E, o.tip, { left: 0 })}
    </Box>
  )
}

function entryRow(E: any, e: PanelEntry, m: PanelModel, now: number): any {
  return limitRow(E, {
    key: `pace-${e.limit}`,
    name: LIMIT_LABEL[e.limit].pane,
    color: colorOf(e.level),
    figure: e.used === null ? 'no reading yet' : `${e.used}% used`,
    level: e.level,
    resetsAt: e.resetsAt,
    tip: entryTip(e, m.readout),
    now,
  })
}

// DX-4595: the spend limit: the server's figure, or why there is none.
function spendRow(E: any, s: SpendEntry, m: PanelModel, now: number): any {
  return limitRow(E, {
    key: 'pace-spend',
    name: SPEND_LABEL,
    color: colorOf(s.level),
    figure: s.state === 'needs_danxbot' ? NEEDS_DANXBOT : s.state === 'unjudged' ? SPEND_UNJUDGED_SHORT : `${s.used}% used`,
    level: s.level,
    resetsAt: s.resetsAt,
    tip: spendTip(s, m.readout),
    now,
  })
}

// The pane's pacing section: each enabled limit on one line, then the account's verdict (level, budget, running agents, and the hold until the
// reset). While the settings read is not working the section is marked local: quietly when there is no danxbot to read (silent), and with the
// named error when danxbot answered and the answer was unusable. null when there is nothing to show.
export function pacingPane(E: any, m: PanelModel, now: number): any {
  // a real settings error shows even with no window figures: it is the one thing the pane can say
  if (m.entries.length === 0 && m.spend === null && m.readout === null && m.error === null) return null
  const { Box, Text } = E
  const targets = m.settingsAt === null ? 'no known targets' : `the targets last read ${age(new Date(m.settingsAt).toISOString(), now)}`
  return (
    <Box key="pane-pacing" flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold>Usage pacing</Text>
        {m.local && <Text dimColor>local</Text>}
      </Box>
      {m.entries.map(e => entryRow(E, e, m, now))}
      {m.spend !== null && spendRow(E, m.spend, m, now)}
      {m.verdict !== null && verdictLines(m.verdict, now).map(line => <Text key={line}>{line}</Text>)}
      {m.error !== null && (
        <Text color={WARNING}>
          Pacing settings could not be read: {m.error}.{m.entries.length > 0 && ` These are this session's own figures against ${targets}, with no verdict.`}
        </Text>
      )}
    </Box>
  )
}
