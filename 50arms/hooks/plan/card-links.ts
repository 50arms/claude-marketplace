// 50 Arms refs in an assistant reply drawn as markdown links to the dashboard's ref redirect (`/api/ref/<ref>`), which sends any kind of ref
// (card, problem, decision, design, plan, feedback) to its page. Pure: text + dashboard origin in, text out. No call is made here (the draw path never touches
// the network), so a look-alike (UTF-8, SHA-256) is drawn as a link the redirect answers not found.

// Markdown the ids must never be rewritten inside. One alternation, scanned left to right, so the earliest construct wins:
// a code span (a run of N backticks to the next run of N), an inline or reference link or image, a reference definition,
// an autolink `<scheme:...>`, a bare URL. String.raw keeps every backslash for the RegExp. It must stay the FIRST group of the
// final pattern: the code-span alternative's `\1` backreference counts on it being group 1.
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

// CP-157, DX-8089: plan record numbers restart in every plan, so a bare `RULE-27` names no plan. In a session connected to a plan, a ref with one of
// these prefixes is drawn with that plan (`?plan=PLAN-<n>`); every other kind of ref is plan-free.
const PLAN_RECORD_PREFIXES = new Set(['RULE', 'GOAL', 'CAV'])

// Every `PREFIX-123` (1 to 4 capital letters, a dash, digits) becomes `[PREFIX-123](<dashboard>/api/ref/PREFIX-123)`, with no list of known prefixes, so a new
// kind of ref needs no change here. Anything inside code, fences, links or URLs is left as written.
export function linkRefs(text: string, dashboardUrl: string, planId: number | null): string {
  // a word char, `-`, `/` or `.` before it, or a word char after it, makes it part of something else (a path, an id with a longer prefix); a `-suffix` after the digits
  // leaves the ref linked (ABC-12-IMPORTED links ABC-12)
  const ref = String.raw`(?<![A-Za-z0-9_\-/.])(?<ref>[A-Z]{1,4}-\d+)(?![A-Za-z0-9_])`
  const re = new RegExp(`${PROTECTED}|${ref}`, 'gm')
  let out = ''
  for (const seg of segments(text)) {
    out += seg.prose
      ? seg.text.replace(re, (hit: string, ...rest: any[]) => {
          // the named group is the last argument; it is set only when the ref alternative matched (a protected construct is kept)
          const found: string | undefined = rest[rest.length - 1].ref
          if (found === undefined) return hit
          const plan = planId !== null && PLAN_RECORD_PREFIXES.has(found.slice(0, found.indexOf('-'))) ? `?plan=PLAN-${planId}` : ''
          return `[${found}](${dashboardUrl}/api/ref/${found}${plan})`
        })
      : seg.text
  }
  return out
}
