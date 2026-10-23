import type { Handlers } from './handlers'
import { linkMarkdown } from './links'

// The footer indicator in the `SessionMode` site. It sits beside whatever the engine and other plugins already put there
// (`rest`, the result of next(e)), so the existing mode labels survive.
// plain text, no chip. A Button is drawn by the desktop as a native button with a chip whatever `plain` says (ButtonProps.plain: "A desktop
// draws its native button either way"), and `Text` has no onPress. The one pressable that is not a button is a `Markdown` link answered by
// `onLinkPress` (MarkdownProps): drawn as text with no chip, so the desktop draws that. A Markdown link takes no colour, so the desktop's text is the
// link's own; the terminal, whose `plain` Button has no chrome, keeps the Button and its `Text` child carries the status colour. The href is only
// the link's address (nothing opens it: the press opens the band).
export const FOOTER_HREF = 'https://app.50arms.ai/'
// the surface name the app reports for its desktop host (the other is the terminal)
const DESKTOP_SURFACE = 'desktop'

export function renderFooter(E: any, hd: Handlers, label: string, tone: string | undefined, rest: any, surface: string): any {
  const { Box, Button, Markdown, Text } = E
  const indicator =
    surface === DESKTOP_SURFACE ? (
      <Markdown key="footer-plan" text={linkMarkdown(label, FOOTER_HREF)} pressableLinks={[FOOTER_HREF]} onLinkPress={() => void hd.showPlan()} />
    ) : (
      <Button key="footer-plan" plain onPress={() => hd.showPlan()}>
        <Text color={tone}>{label}</Text>
      </Button>
    )
  return (
    <Box flexDirection="row" gap={1}>
      {rest}
      {indicator}
    </Box>
  )
}
