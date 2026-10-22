import type { Handlers } from './handlers'

// The footer button in the `SessionMode` site: ONE text button (the footer draws text buttons only:
// no Svg, nothing floating). It sits beside whatever the engine and other plugins already put there
// (`rest`, the result of next(e)), so the existing mode labels survive.
// plain text, no chip. `plain` is the Button's no-chrome form (ButtonProps: "Drawn without chrome"); the nbsp padding that
// insetted the label inside the chip is gone. The API notes that a desktop draws its native button either way: only a live check shows
// whether the desktop adds a background of its own.
export function renderFooter(E: any, hd: Handlers, label: string, rest: any): any {
  const { Box, Button } = E
  return (
    <Box flexDirection="row" gap={1}>
      {rest}
      <Button key="footer-plan" plain onPress={() => hd.showPlan()}>
        {label}
      </Button>
    </Box>
  )
}
