// DX-4993 (PLAN-42 rule R-4): the plugin's half of an operator session's compaction handshake. Pure: no `$`, no clock, no files. register.tsx reads the
// file and the engine's answers, hands them here, and does what comes back.
//
// What the handshake is. 50 Arms decides when a session is worth compacting (cost saved against time lost), asks the session's agent to prepare, and only
// after the agent says ready does a compaction run. Nothing compacts by itself. This module decides the things the plugin owns:
//   - THE START (DX-5231): when the agent's ready is accepted, the control file carries a release (`releaseId`, `releaseUntilMs`). At the next main-loop turn end the
//     plugin runs Claude Code's own /compact (`$.command.run({ command: 'compact' })`, verified live on 2.1.299, DX-5217 comment 15740); `readyRelease` says
//     whether one is waiting. The compaction reaches PreCompact and `session.compact` as trigger `manual`. The plugin sets NO early-proposal variable for the
//     main agent, so the main loop proposes only at Claude Code's own threshold. It still unsets a CLAUDE_CODE_AUTO_COMPACT_WINDOW an older plugin left (that variable
//     also becomes the window the context meter measures against, so a 1M session showed 400k as its maximum, DX-5217).
//   - THE GATE: a `classic.PreCompact` hook refuses an automatic proposal while the session is under the handshake. A person's own /compact (trigger `manual`,
//     which the plugin's own start also is) always passes, and so does a proposal at the size where refusing would end the session (the SAFETY VALVE,
//     `passAtTokens`): a refused proposal there ends the turn with "Context limit reached" until a manual /compact (verified live, Haiku 4.5).
//
// The control is a local file the session's danx-dashboard MCP relay writes (`~/.config/danxbot/compaction/<sessionId>.json`, shape below): the gate
// never asks the network, because Claude Code proposes before every model request. A function hook that THROWS lets the compaction through (verified
// live), so every decision here returns a verdict.
//
// FAIL OPEN. Holding is a courtesy of 50 Arms' cost policy, never worth ending a session for: a session that refuses every proposal ends with "Context
// limit reached" (verified live), and the only escape, the safety valve's size, lives in the very file the gate may be unable to read. So whatever the gate
// cannot establish (a control file it cannot read, a read that throws, a context size it cannot see) lets Claude Code's own compaction apply and holds nothing.
// The person is told once that the control is unreadable (register.tsx).
//
// The shapes mirror the relay's `CompactionFile` (packages/danx-dashboard-mcp/src/compaction-control.ts in danxbot): a plugin cannot import it.
// A file this module cannot read is `bad`, never a guess.

// The safety valve's size is NOT computed here. 50 Arms computes it once, from the session's model (the model's window less Claude Code's blocking margin
// less the largest single step seen), and the relay writes it into the file as `passAtTokens`: the gate reads that number and holds no copy of the margin,
// so a change to the margin moves every gate (DX-4993). Pinned from both sides by the same literal (tests/compaction-control.test.tsx and, in danxbot,
// operator-session.test.ts and packages/danx-dashboard-mcp/__tests__/compaction-control.test.ts).

export const HELD_REASON = '[50 ARMS] automatic compaction is held: your agent compacts the session when it says ready'

// `windowTokens` is the context window 50 Arms assumed for the session's model line (its table lists a window per line, not per session variant); the floor and
// the valve were computed from it, so a session whose real window is smaller must not be held (`windowFits`).
export type GateControl = { floorTokens: number; passAtTokens: number; windowTokens: number; releaseUntilMs: number | null; releaseId: string | null }

// `absent`: no file (the relay has not written one yet). `control: null`: the session is not under the handshake.
export type ControlFile = { kind: 'absent' } | { kind: 'control'; control: GateControl | null } | { kind: 'bad'; reason: string }

// The spent releases are kept per session in $.store: the newest USED_RELEASE_KEEP sessions' records stay, so the store does not grow with every session ever held.
export const USED_RELEASE_PREFIX = 'compaction-used-release:'
export const USED_RELEASE_KEEP = 40
export type UsedRelease = { releaseId: string; at: number }
export const usedReleaseKey = (sessionId: string): string => `${USED_RELEASE_PREFIX}${sessionId}`
export const staleUsedReleaseKeys = (entries: { key: string; at: number }[]): string[] =>
  [...entries].sort((a, b) => b.at - a.at).slice(USED_RELEASE_KEEP).map(e => e.key)
// The release a stored record spent, null for none or a record that is not one.
export const spentReleaseId = (record: unknown): string | null => {
  const r = record as Partial<UsedRelease> | null | undefined
  return r !== null && r !== undefined && typeof r === 'object' && typeof r.releaseId === 'string' ? r.releaseId : null
}

export const controlPath = (home: string, sessionId: string): string => `${home}/.config/danxbot/compaction/${sessionId}.json`

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

// The file's text (`null`: no file) as a control, for session `sessionId`. Anything the relay would not have written is `bad` with the reason, and so is a file
// written for another session (the relay names the session in the file: a leftover must not hold a different one).
export function parseControlFile(text: string | null, sessionId: string): ControlFile {
  if (text === null) return { kind: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'bad', reason: 'not JSON' }
  }
  if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.sessionId !== 'string' || !('control' in parsed)) return { kind: 'bad', reason: 'not a compaction file' }
  if (parsed.sessionId !== sessionId) return { kind: 'bad', reason: 'written for another session' }
  const c = parsed.control
  if (c === null) return { kind: 'control', control: null }
  if (!isRecord(c) || !isCount(c.floorTokens) || !isCount(c.passAtTokens) || !isCount(c.windowTokens)) return { kind: 'bad', reason: 'floorTokens, passAtTokens and windowTokens must be whole numbers' }
  if (c.passAtTokens <= c.floorTokens) return { kind: 'bad', reason: 'passAtTokens must be above floorTokens' }
  if (c.windowTokens <= c.passAtTokens) return { kind: 'bad', reason: 'windowTokens must be above passAtTokens' }
  if ((c.releaseUntilMs === null) !== (c.releaseId === null)) return { kind: 'bad', reason: 'releaseUntilMs and releaseId are both set or both null' }
  if (c.releaseUntilMs !== null && !(typeof c.releaseUntilMs === 'number' && Number.isFinite(c.releaseUntilMs))) return { kind: 'bad', reason: 'releaseUntilMs must be a number or null' }
  if (c.releaseId !== null && (typeof c.releaseId !== 'string' || c.releaseId === '')) return { kind: 'bad', reason: 'releaseId must be a string or null' }
  return {
    kind: 'control',
    control: { floorTokens: c.floorTokens, passAtTokens: c.passAtTokens, windowTokens: c.windowTokens, releaseUntilMs: c.releaseUntilMs as number | null, releaseId: c.releaseId as string | null },
  }
}

// Whether the control's floor and valve can be reached in this session. 50 Arms computed them from the window it assumed for the model line; when the session's
// real window (`$.session.usage().context.window`, null when the engine cannot say yet) is smaller, a proposal could come before the floor and the valve would
// never be reached. Held only when the real window is not known to be smaller.
export const windowFits = (control: GateControl, realWindow: number | null): boolean => realWindow === null || realWindow >= control.windowTokens

// DX-5231: the session is under the handshake exactly when its file carries a control; only such a session can be given a ready.
export const underHandshake = (file: ControlFile): boolean => file.kind === 'control' && file.control !== null

// The release waiting to be acted on: the control's release when it has not expired and the plugin has not spent it, else null. A release is acted on once.
export function readyRelease(file: ControlFile, usedReleaseId: string | null, nowMs: number): string | null {
  if (file.kind !== 'control' || file.control === null) return null
  const c = file.control
  if (c.releaseUntilMs === null || c.releaseId === null || c.releaseUntilMs <= nowMs || c.releaseId === usedReleaseId) return null
  return c.releaseId
}

export type GateInput = {
  trigger: unknown
  // the context size now (`$.session.usage().context.tokens`) and the session's real window (`.context.window`); null when the engine could not say
  tokens: number | null
  window: number | null
  file: ControlFile
}

export type Verdict = { pass: true; why: 'manual' | 'no-control' | 'unreadable' | 'unknown-size' | 'valve' } | { pass: false; reason: string }

// The decision, in order:
//   a person's own /compact (and the plugin's own start of a ready compaction) always passes; anything that is not exactly `auto` is refused;
//   a file with no control (the switch went off, or the file is gone - a week's pruning by the relay) holds nothing: there is no handshake to wait for;
//   a file the gate cannot read, a window smaller than the one the control assumed, and an unknown context size hold nothing either (fail open, above);
//   at the safety valve's size (the file's `passAtTokens`) the proposal passes whatever the handshake says;
//   otherwise it is refused: a ready agent is compacted by the plugin's own /compact, never by releasing a proposal.
export function verdict(input: GateInput): Verdict {
  if (input.trigger === 'manual') return { pass: true, why: 'manual' }
  if (input.trigger !== 'auto') return { pass: false, reason: `${HELD_REASON} (unexpected PreCompact trigger ${JSON.stringify(input.trigger)})` }
  if (input.file.kind === 'bad') return { pass: true, why: 'unreadable' }
  if (input.file.kind === 'absent' || input.file.control === null) return { pass: true, why: 'no-control' }
  if (!windowFits(input.file.control, input.window)) return { pass: true, why: 'no-control' }
  if (input.tokens === null) return { pass: true, why: 'unknown-size' }
  if (input.tokens >= input.file.control.passAtTokens) return { pass: true, why: 'valve' }
  return { pass: false, reason: HELD_REASON }
}
