// DX-4993 (PLAN-42 rule R-4): the plugin's half of an operator session's compaction handshake. Pure: no `$`, no clock, no files. register.tsx reads the
// file and the engine's answers, hands them here, and does what comes back.
//
// What the handshake is. 50 Arms decides when a session is worth compacting (cost saved against time lost), asks the session's agent to prepare, and only
// after the agent says ready does a compaction pass. Nothing compacts by itself. This module decides the two things the plugin owns:
//   - ARMING: Claude Code proposes an automatic compaction before every model request once the context passes its auto-compact window. The plugin sets
//     that window to the session's FLOOR (the smallest size at which the policy could ever ask), through `$.env.set`, on a session the board's switch
//     covers. Verified live on a running interactive session (DX-4993): a plugin's `$.env.set(CLAUDE_CODE_AUTO_COMPACT_WINDOW, n)` takes effect at
//     once, in the session's running process, and overrides a settings file.
//   - THE GATE: a `classic.PreCompact` hook refuses an automatic proposal until the agent said ready. A person's own /compact (trigger `manual`) always
//     passes, and so does a proposal at the size where refusing would end the session (the SAFETY VALVE, `passAtTokens`): a refused proposal there
//     ends the turn with "Context limit reached" until a manual /compact (verified live, Haiku 4.5).
//
// The control is a local file the session's danx-dashboard MCP relay writes (`~/.config/danxbot/compaction/<sessionId>.json`, shape below): the gate
// never asks the network, because Claude Code proposes before every model request. A function hook that THROWS lets the compaction through (verified
// live), so every decision here returns a verdict and register.tsx turns anything unexpected into a refusal.
//
// The shapes mirror the relay's `CompactionFile` (packages/danx-dashboard-mcp/src/compaction-control.ts in danxbot): a plugin cannot import it.
// A file this module cannot read is `bad`, never a guess.

// The gate passes any automatic proposal once the context is within this many tokens of the model's window: Claude Code's blocking margin
// (min(max output, 20000) + 3000) plus the largest single step seen (68000). Mirrors danxbot's `gatePassAtTokens` (src/dispatch/compaction/handshake.ts).
export const BLOCKING_MARGIN_TOKENS = 23_000
export const LARGE_STEP_TOKENS = 70_000
export const GATE_MARGIN_TOKENS = BLOCKING_MARGIN_TOKENS + LARGE_STEP_TOKENS

export const passAtTokens = (windowTokens: number): number => windowTokens - GATE_MARGIN_TOKENS

export const HELD_REASON = '[50 ARMS] automatic compaction is held until your agent says ready'

export type GateControl = { floorTokens: number; passAtTokens: number; releaseUntilMs: number | null; releaseId: string | null }

// `absent`: no file (the relay has not written one yet). `control: null`: the session is not under the handshake.
export type ControlFile = { kind: 'absent' } | { kind: 'control'; control: GateControl | null } | { kind: 'bad'; reason: string }

export const controlPath = (home: string, sessionId: string): string => `${home}/.config/danxbot/compaction/${sessionId}.json`

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

// The file's text (`null`: no file) as a control. Anything the relay would not have written is `bad` with the reason.
export function parseControlFile(text: string | null): ControlFile {
  if (text === null) return { kind: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'bad', reason: 'not JSON' }
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !('control' in parsed)) return { kind: 'bad', reason: 'not a compaction file' }
  const c = parsed.control
  if (c === null) return { kind: 'control', control: null }
  if (!isRecord(c) || !isCount(c.floorTokens) || !isCount(c.passAtTokens)) return { kind: 'bad', reason: 'floorTokens and passAtTokens must be whole numbers' }
  if ((c.releaseUntilMs === null) !== (c.releaseId === null)) return { kind: 'bad', reason: 'releaseUntilMs and releaseId are both set or both null' }
  if (c.releaseUntilMs !== null && !(typeof c.releaseUntilMs === 'number' && Number.isFinite(c.releaseUntilMs))) return { kind: 'bad', reason: 'releaseUntilMs must be a number or null' }
  if (c.releaseId !== null && (typeof c.releaseId !== 'string' || c.releaseId === '')) return { kind: 'bad', reason: 'releaseId must be a string or null' }
  return {
    kind: 'control',
    control: { floorTokens: c.floorTokens, passAtTokens: c.passAtTokens, releaseUntilMs: c.releaseUntilMs as number | null, releaseId: c.releaseId as string | null },
  }
}

// What to do with the session's auto-compact window.
// `set`: arm it at `floorTokens`. `unset`: take it back (the board no longer holds the session, or its floor cannot be held in this session's window).
// `keep`: change nothing (no file yet, an unreadable one, or the session's window is not known yet).
export type Arming = { kind: 'set'; floorTokens: number } | { kind: 'unset' } | { kind: 'keep' }

// `windowTokens` is the session's real context window (`$.session.usage().context.window`), `null` before its first response. A floor at or above the
// size where the gate passes anything would never be held: the session would hit its own limit first, so it is not armed (the board's capability
// table can name a bigger window than the session really has).
export function arming(file: ControlFile, windowTokens: number | null): Arming {
  if (file.kind !== 'control') return { kind: 'keep' }
  if (file.control === null) return { kind: 'unset' }
  if (windowTokens === null) return { kind: 'keep' }
  return file.control.floorTokens < passAtTokens(windowTokens) ? { kind: 'set', floorTokens: file.control.floorTokens } : { kind: 'unset' }
}

export type GateInput = {
  trigger: unknown
  // whether this session's window is armed by the plugin (a session the board does not cover is never held)
  armed: boolean
  // the context size now and the session's window (`$.session.usage().context`); null when the engine could not say
  tokens: number | null
  windowTokens: number | null
  file: ControlFile
  // the release the gate last honoured (a release is honoured once)
  usedReleaseId: string | null
  nowMs: number
}

export type Verdict = { pass: true; why: 'manual' | 'not-armed' | 'valve' | 'released'; spend?: string } | { pass: false; reason: string }

// The decision, in order:
//   a person's own /compact always passes; anything that is not exactly `auto` is refused;
//   a session this plugin did not arm is not held;
//   at the safety valve's size the proposal passes whatever the handshake says;
//   an unexpired release the gate has not used passes ONCE (`spend` names it, for the caller to remember);
//   otherwise it is refused, and so is anything the gate could not establish (an unknown size, a missing or unreadable file).
export function verdict(input: GateInput): Verdict {
  if (input.trigger === 'manual') return { pass: true, why: 'manual' }
  if (input.trigger !== 'auto') return { pass: false, reason: `${HELD_REASON} (unexpected PreCompact trigger ${JSON.stringify(input.trigger)})` }
  if (!input.armed) return { pass: true, why: 'not-armed' }
  if (input.tokens === null || input.windowTokens === null) return { pass: false, reason: `${HELD_REASON} (the context size is not known)` }
  if (input.tokens >= passAtTokens(input.windowTokens)) return { pass: true, why: 'valve' }
  if (input.file.kind === 'bad') return { pass: false, reason: `${HELD_REASON} (${input.file.reason})` }
  if (input.file.kind === 'control' && input.file.control !== null) {
    const c = input.file.control
    if (c.releaseUntilMs !== null && c.releaseUntilMs > input.nowMs && c.releaseId !== input.usedReleaseId) return { pass: true, why: 'released', spend: c.releaseId as string }
  }
  return { pass: false, reason: HELD_REASON }
}
