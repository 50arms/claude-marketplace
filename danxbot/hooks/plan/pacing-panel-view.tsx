import { DANGER, ORANGE, SUCCESS, WARNING } from './config'
import type { PacingLevel } from '../../types'
import { bandSegments } from './pacing-format'
import type { Tone } from './pacing-format'
import type { PanelModel } from './pacing-panel'

// DX-4339: the pacing panel's drawing. The colour says the level (green on pace, yellow over pace, red critical); no level (no target known, or
// no figure) is dim.
const LEVEL_COLOR: Record<PacingLevel, string> = { on_pace: SUCCESS, over_pace: WARNING, critical: DANGER }
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
