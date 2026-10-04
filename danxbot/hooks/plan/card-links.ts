import type { ConnectedPlan } from '../../types'
import { boardCardUrl, cardUrl } from './config'

// DX-4448: card ids in an assistant reply drawn as markdown links. Pure: text + known prefixes + connected plan + the plan's
// loaded card ids in, text out. No call is made here (the draw path never touches the network); the prefixes come from the
// `view` atom, filled at refresh.

// Markdown the ids must never be rewritten inside. One alternation, scanned left to right, so the earliest construct wins:
// a code span (a run of N backticks to the next run of N), an inline or reference link or image, a reference definition,
// an autolink `<scheme:...>`, a bare URL. String.raw keeps every backslash for the RegExp.
const PROTECTED = [
  String.raw`(?<!\x60)(\x60+)(?!\x60)[\s\S]*?(?<!\x60)\1(?!\x60)`,
  String.raw`!?\[(?:[^\[\]]|\[[^\]]*\])*\]\([^)]*\)`,
  String.raw`!?\[[^\]]*\]\[[^\]]*\]`,
  String.raw`^[ ]{0,3}\[[^\]]+\]:.*$`,
  String.raw`<[a-zA-Z][a-zA-Z0-9+.-]*:[^>\s]*>`,
  String.raw`\b(?:https?|ftp):\/\/[^\s<>]+`,
].join('|')

const FENCE = /^ {0,3}(`{3,}|~{3,})/

// the text split into fenced blocks (kept verbatim) and prose; an unclosed fence runs to the end, as markdown reads it
function* segments(text: string): Generator<{ prose: boolean; text: string }> {
  const lines = text.split('\n')
  let fence: string | null = null
  let buf: string[] = []
  const flush = function* (prose: boolean) {
    if (buf.length) yield { prose, text: buf.join('') }
    buf = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] + (i < lines.length - 1 ? '\n' : '')
    const m = FENCE.exec(line)
    if (fence === null && m) {
      yield* flush(true)
      fence = m[1]
      buf.push(line)
    } else if (fence !== null) {
      buf.push(line)
      // a closing fence: the same character, at least as long, nothing else on the line
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) {
        yield* flush(false)
        fence = null
      }
    } else buf.push(line)
  }
  yield* flush(fence === null)
}

// Every `PREFIX-123` with a known prefix becomes `[PREFIX-123](url)`. A card in `planCardIds` links to its page on the connected
// plan; any other known-prefix card to the plan-free board route. Unknown prefixes (UTF-8, SHA-256) and anything inside code,
// fences, links or URLs are left as written. No prefixes known: the text comes back unchanged.
export function linkCardIds(text: string, prefixes: string[], plan: ConnectedPlan, planCardIds: ReadonlySet<string>): string {
  if (prefixes.length === 0) return text
  // prefixes are capital letters only (readPrefixes in load.ts), so they need no regex escaping
  const alt = [...prefixes].sort((a, b) => b.length - a.length).join('|')
  // a word char, `-`, `/` or `.` before it, or a word char or `-` after it, makes it part of something else (a path, UTF-8-1)
  const id = String.raw`(?<![A-Za-z0-9_\-/.])(?:${alt})-\d+(?![A-Za-z0-9_\-])`
  const re = new RegExp(`${PROTECTED}|${id}`, 'gm')
  let out = ''
  for (const seg of segments(text)) {
    out += seg.prose
      ? seg.text.replace(re, hit => {
          // anything else the pattern matched is a protected construct: kept as written
          if (!/^[A-Z]+-\d+$/.test(hit)) return hit
          return `[${hit}](${planCardIds.has(hit) ? cardUrl(plan, hit) : boardCardUrl(plan, hit)})`
        })
      : seg.text
  }
  return out
}
