import type { Handlers } from './handlers'
import { DESKTOP_SURFACE } from './config'

// The footer indicator in the `SessionMode` site: a Button, as close to the engine's own footer buttons ("Bypass permissions") as the plugin
// UI API allows. It sits beside whatever the engine and other plugins already put there (`rest`, the result of next(e)), so the existing mode
// labels survive.
// The desktop draws a plugin Button as its native chip whatever `plain` says (ButtonProps.plain), and ButtonProps has no padding or tooltip;
// a Markdown link in a hover Box was tried and the desktop neither pressed it nor drew the hover card as a card. So the desktop label is
// padded with non-breaking spaces inside the chip. The terminal's `plain` Button has no chrome; its `Text` child carries the status colour.
const PAD = ' '

export function renderFooter(E: any, hd: Handlers, label: string, tone: string | undefined, rest: any, surface: string): any {
  const { Box, Button, Text } = E
  return (
    <Box flexDirection="row" gap={1}>
      {rest}
      <Button key="footer-plan" plain onPress={() => hd.showPlan()}>
        {surface === DESKTOP_SURFACE ? `${PAD}${label}${PAD}` : <Text color={tone}>{label}</Text>}
      </Button>
    </Box>
  )
}
