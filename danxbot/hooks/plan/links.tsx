// DX-4630: every link the plugin draws is a link inside a `Markdown` element, never a `Link`. A Markdown link with no
// press handler (a handler would hand the click to the plugin, and the app would open nothing) takes the path a link in the conversation takes, which the app opens in its in-app browser at once; a `Link`
// element opens the external browser (proven live on the desktop, CLI 2.1.286). Both surfaces draw a Markdown link (an OSC 8
// span on the terminal, an anchor on the desktop).

// Markdown's own characters in a label are escaped so a problem's statement or a plan's name reads as written; the label is one
// line (a blank line would end the link).
const escapeLabel = (label: string) => label.replace(/\s+/g, ' ').replace(/[\\`*_[\]<>~|!&]/g, c => '\\' + c)

// A link's destination ends at an unescaped `)` or a space, so those are percent-encoded.
const encodeUrl = (url: string) => url.replace(/[()<>\s]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

export const linkMarkdown = (label: string, url: string) => `[${escapeLabel(label)}](${encodeUrl(url)})`

// One link, addressed by `key` (what a test finds it by). The wrapper keeps it from being squeezed in a row of controls.
export function mdLink(E: any, key: string, label: string, url: string): any {
  const { Box, Markdown } = E
  return (
    <Box key={`${key}-box`} flexShrink={0}>
      <Markdown key={key} text={linkMarkdown(label, url)} />
    </Box>
  )
}
