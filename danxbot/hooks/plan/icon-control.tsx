import { tooltipCard } from './tooltip-card'

// DX-4415: an icon control is a one-glyph Button in a keyed Box with its tooltip card (tooltip-card.tsx) one row BELOW the glyph, ending at
// its right edge (the controls are right-aligned: a card growing rightwards would leave the pane).
export function iconControl(E: any, o: { key: string; tip: string; control: any; backgroundColor?: string }): any {
  const { Box } = E
  return (
    <Box key={`${o.key}-hover`} flexShrink={0} {...(o.backgroundColor ? { backgroundColor: o.backgroundColor } : {})}>
      {o.control}
      {tooltipCard(E, [o.tip], { right: 0 })}
    </Box>
  )
}
