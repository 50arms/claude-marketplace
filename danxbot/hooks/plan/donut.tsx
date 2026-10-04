import { SUCCESS } from './config'
import { donutGlyph } from './words'

// The plan-progress donut as an SVG document (desktop only: the terminal has no Svg and shows
// the text glyph). A ring of circumference 100 so the arc length is the percent itself; a complete
// plan (100) draws the done mark (a filled disc with a tick) instead (DX-4257).
// A ring of circumference 100 has radius 100 / (2 * PI) = 15.9155, so a dash of `percent` is exactly
// that percent of the way round. Strokes start at 3 o'clock; the offset of 25 (a quarter of the 100
// circumference) turns the start to 12 o'clock.
const RING_RADIUS = 15.9155
const QUARTER_TURN = 25
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
    `<circle cx="18" cy="18" r="${RING_RADIUS}" fill="none" stroke="${TRACK}" stroke-opacity="0.35" stroke-width="4"/>` +
    `<circle cx="18" cy="18" r="${RING_RADIUS}" fill="none" stroke="${GREEN}" stroke-width="4" stroke-dasharray="${percent} ${100 - percent}" stroke-dashoffset="${QUARTER_TURN}"/>` +
    '</svg>'
  )
}

// The alt text a reader that cannot see the drawing gets.
export function donutAlt(percent: number): string {
  return `${percent}% complete`
}

// DX-4374: the one donut mark: a real Svg of `px` CSS pixels where the surface draws one (the desktop), the
// glyph as text elsewhere. The band line (small) and the pane header (large) both draw it.
export function donutMark(E: any, percent: number, hasSvg: boolean, px: number): any {
  const { Text, Svg } = E
  return hasSvg ? (
    <Svg source={donutSvg(percent)} alt={donutAlt(percent)} width={px} height={px} />
  ) : (
    <Text color={SUCCESS}>{donutGlyph(percent)}</Text>
  )
}
