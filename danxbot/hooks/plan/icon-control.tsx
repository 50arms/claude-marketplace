// DX-4415: the pane's icon controls. This engine's Button and Link carry no tooltip, icon or colour prop (and refuse
// an Svg child), so an icon is a one-glyph control and its tooltip is the engine's hover card: a keyed Box holding
// the control plus an absolutely positioned `display: 'none'` Box that `hover: { display: 'flex' }` reveals while
// the pointer is over the keyed Box (claude-code.d.ts, BoxProps.hover). The card sits one row BELOW the glyph and
// ends at its right edge: the top line is the pane's first row (a card above it is clipped by the pane) and its
// controls are right-aligned (a card growing rightwards would leave the pane). The same tree draws on every surface;
// the surface applies the hover wherever it has a pointer, and a terminal without one just shows the glyph.
export function iconControl(E: any, o: { key: string; tip: string; control: any; backgroundColor?: string }): any {
  const { Box, Text } = E
  return (
    <Box key={`${o.key}-hover`} {...(o.backgroundColor ? { backgroundColor: o.backgroundColor } : {})}>
      {o.control}
      <Box position="absolute" top={1} right={0} display="none" hover={{ display: 'flex' }}>
        <Text inverse>{` ${o.tip} `}</Text>
      </Box>
    </Box>
  )
}
