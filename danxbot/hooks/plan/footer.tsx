import type { Handlers } from './handlers'

export const FOOTER_PAD = '\u00A0' // a non-breaking space

// The footer button in the `SessionMode` site: ONE text button (the footer draws text buttons only:
// no Svg, nothing floating). It sits beside whatever the engine and other plugins already put there
// (`rest`, the result of next(e)), so the existing mode labels survive.
// `padded`: the desktop, whose native button takes no padding prop and draws `plain` as its chip all the same (the host's
// ButtonProps doc: "A desktop draws its native button either way"), so the label carries its own padding there.
export function renderFooter(E: any, hd: Handlers, label: string, rest: any, padded: boolean): any {
  const { Box, Button } = E
  return (
    <Box flexDirection="row" gap={1}>
      {rest}
      {/* DX-4420: the desktop's chip left the text touching its edges: pad the label with non-breaking spaces (a regular
          space would collapse); the terminal draws `plain` without chrome and needs none. */}
      <Button key="footer-plan" plain onPress={() => hd.showPlan()}>
        {padded ? `${FOOTER_PAD}${label}${FOOTER_PAD}` : label}
      </Button>
    </Box>
  )
}
