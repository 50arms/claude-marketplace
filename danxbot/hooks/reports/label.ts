// DX-4235 (PBLM-2121): the label a background shell's activity row carries: the shell call's own `description`, redacted. It is the
// label the old command hook sent (danxbot packages/danx-dashboard-mcp activity.ts: `description: labelOf(toolInput.description)`),
// byte for byte, so the dashboard's Plan pane keeps naming a background shell by what the agent said it does.
//
// PORTED, not imported: the plugin's hooks module cannot load the npm package (no Node, no package resolution), so this is a copy of
// `redactLabel` / `labelOf` from danxbot `packages/danx-session-telemetry/src/activity-observer.ts` at commit
// 7ed4e47fb9626cc91f61bc20f45491ce59217e91 (DX-4498). `danxbot/tests/reports-label.test.tsx` carries that package's own test cases so
// the two cannot drift apart unnoticed. A label is free text an agent wrote and it reaches every reader of the team, so every
// path-shaped token reads `[path]` and every secret-shaped token `[redacted]`; a command is never read at all. The row's
// `description` has no length cap of its own (the old hook sent none, and the wire sets none): the package's 120-character cap belongs
// to `describeToolCall`'s current-activity text, which the plugin does not send.

/** What `redactLabel` puts in place of a path-shaped token. */
const REDACTED_PATH = '[path]'
/** What `redactLabel` puts in place of a secret-shaped token, or an assignment's value. */
const REDACTED_SECRET = '[redacted]'
/** An `ENV_NAME=value` token: its value may be a credential. */
const ASSIGNMENT_TOKEN = /^([A-Za-z_][A-Za-z0-9_]*)=.+$/
/** The characters a key, token, hash or id is written in. */
const OPAQUE_TOKEN = /^[A-Za-z0-9_+.-]+$/
/** The shortest opaque run of letters and digits treated as a key, token, hash or id (a card id or short SHA is far shorter). */
const OPAQUE_TOKEN_MIN_CHARS = 20
/** Punctuation a token may be wrapped in, which never stops it from being read as opaque. */
const WRAPPING_PUNCTUATION = /^[("'`[]+|[)"'`\],.:;!?]+$/g

function redactToken(token: string): string {
  if (/[\\/]/.test(token)) return REDACTED_PATH
  const assignment = ASSIGNMENT_TOKEN.exec(token)
  if (assignment !== null) return `${assignment[1]}=${REDACTED_SECRET}`
  const bare = token.replace(WRAPPING_PUNCTUATION, '')
  const opaque = bare.length >= OPAQUE_TOKEN_MIN_CHARS && OPAQUE_TOKEN.test(bare) && /[0-9]/.test(bare) && /[A-Za-z]/.test(bare)
  return opaque ? REDACTED_SECRET : token
}

/**
 * An agent-written label as the stats wire may carry it: on one line, with every path-shaped token (any token holding a `/` or `\`) read
 * as `[path]`, and every secret-shaped token (an `ENV_NAME=value` value, or an opaque run of 20+ letters and digits such as a key, token
 * or full SHA) read as `[redacted]`. Empty for a blank label.
 */
export function redactLabel(label: string): string {
  return label
    .split(/\s+/)
    .filter(token => token !== '')
    .map(redactToken)
    .join(' ')
}

/** A value read as a label: `redactLabel`'s text, or null for a non-string or blank one. */
export function labelOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const label = redactLabel(value)
  return label === '' ? null : label
}
