import type { Handlers } from './handlers'

// The footer button in the `SessionMode` site: ONE text button (the footer draws text buttons only:
// no Svg, nothing floating). It sits beside whatever the engine and other plugins already put there
// (`rest`, the result of next(e)), so the existing mode labels survive.
export function renderFooter(E: any, hd: Handlers, label: string, rest: any): any {
  const { Box, Button } = E
  return (
    <Box flexDirection="row" gap={1}>
      {rest}
      {/* DX-4420: a Button takes no padding, so its background left the text touching its edges: `plain` draws the label
          without chrome. */}
      <Button key="footer-plan" plain onPress={() => hd.showPlan()}>
        {label}
      </Button>
    </Box>
  )
}
