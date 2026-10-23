import type { Handlers } from './handlers'
import { DESKTOP_SURFACE } from './config'

// The footer indicator in the `SessionMode` site: a Button, like the engine's own "Bypass permissions" and model buttons beside it. It sits
// beside whatever the engine and other plugins already put there (`rest`, the result of next(e)), so the existing mode labels survive.
// A button, never a link or plain text. The desktop draws its native button from the label text and ignores a
// child's colour, so it gets the label as text; the terminal's `plain` Button has no chrome and its `Text` child carries the status colour.
export function renderFooter(E: any, hd: Handlers, label: string, tone: string | undefined, rest: any, surface: string): any {
  const { Box, Button, Text } = E
  return (
    <Box flexDirection="row" gap={1}>
      {rest}
      <Button key="footer-plan" plain onPress={() => hd.showPlan()}>
        {surface === DESKTOP_SURFACE ? label : <Text color={tone}>{label}</Text>}
      </Button>
    </Box>
  )
}
