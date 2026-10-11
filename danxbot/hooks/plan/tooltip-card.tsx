import { TOOLTIP_BACKGROUND, TOOLTIP_MAX_COLS } from './config'

// DX-4415: the pane's hover cards. This engine's Button carries no tooltip, icon or colour prop (and refuses an Svg child), so a
// tooltip is the engine's hover card: an absolutely positioned `display: 'none'` Box that `hover: { display: 'flex' }` reveals while
// the pointer is over the nearest keyed Box (claude-code.d.ts, BoxProps.hover). A terminal without a pointer just never shows it; the same
// tree draws on every surface.
//
// DX-4854: an absolute Box is as wide as its parent unless it is given a width, and an icon control's parent is one glyph, so the
// card wrapped "Switch plan" over two rows. The card carries its own width: its longest line plus the one column of padding each side,
// at most TOOLTIP_MAX_COLS + 2 (a longer line wraps inside it). It is drawn on the theme's raised fill with the normal text colour
// (TOOLTIP_BACKGROUND), not inverse video, which painted a light block on a dark theme.
// One Text per line, `edge` the side it is anchored to: one row BELOW the keyed Box's top (the pane's first row has no room above it).
// DX-4854: no lines, no card (null): an empty card has no finite width and the engine refuses the whole Pane for a non-finite one.
export function tooltipCard(E: any, lines: readonly string[], edge: { left: 0 } | { right: 0 }): any {
  if (lines.length === 0) return null
  const { Box, Text } = E
  const width = Math.min(Math.max(...lines.map(l => l.length)), TOOLTIP_MAX_COLS) + 2
  return (
    <Box position="absolute" top={1} {...edge} width={width} flexShrink={0} flexDirection="column" paddingX={1} backgroundColor={TOOLTIP_BACKGROUND} display="none" hover={{ display: 'flex' }}>
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  )
}
