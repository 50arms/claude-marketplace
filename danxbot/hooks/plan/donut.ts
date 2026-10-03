// The plan-progress donut as an SVG document (desktop only: the terminal has no Svg and shows
// the text glyph). A ring of circumference 100 so the arc length is the percent itself; a complete
// plan (100) draws the done mark (a filled disc with a tick) instead (DX-4257).
const GREEN = '#3fb950'
const TRACK = '#6e7681'

export function donutSvg(percent: number): string {
  if (percent >= 100) {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">' +
      `<circle cx="18" cy="18" r="16" fill="${GREEN}"/>` +
      '<path d="M10 18.5 L16 24 L26 12" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>'
    )
  }
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">' +
    `<circle cx="18" cy="18" r="15.9155" fill="none" stroke="${TRACK}" stroke-opacity="0.35" stroke-width="4"/>` +
    `<circle cx="18" cy="18" r="15.9155" fill="none" stroke="${GREEN}" stroke-width="4" stroke-dasharray="${percent} ${100 - percent}" stroke-dashoffset="25"/>` +
    '</svg>'
  )
}

// The alt text a reader that cannot see the drawing gets.
export function donutAlt(percent: number): string {
  return `${percent}% complete`
}
