// the plugin's half of an operator session's compaction handshake. Pure: no `$`, no clock, no files. register.tsx reads the
// file and the engine's answers, hands them here, and does what comes back.
//
// What the handshake is. 50 Arms decides when a session is worth compacting (cost saved against time lost), asks the session's agent to prepare, and only
// after the agent says ready does a compaction run. Nothing compacts by itself. This module decides the things the plugin owns:
//   - THE START: when the agent's ready is accepted, the control file carries a release (`releaseId`, `releaseUntilMs`). At the next main-loop turn end the
//     plugin runs Claude Code's own /compact (`$.command.run({ command: 'compact' })`, verified live on 2.1.299); `readyRelease` says
//     whether one is waiting. The compaction reaches PreCompact and `session.compact` as trigger `manual`. The plugin sets NO early-proposal variable for the
//     main agent, so the main loop proposes only at Claude Code's own threshold. It still unsets a CLAUDE_CODE_AUTO_COMPACT_WINDOW an older plugin left (that variable
//     also becomes the window the context meter measures against, so a 1M session showed 400k as its maximum).
//   - THE GATE: a `classic.PreCompact` hook refuses an automatic proposal while the session is under the handshake. A person's own /compact (trigger `manual`,
//     which the plugin's own start also is) always passes, and so does a proposal at the size where refusing would end the session (the SAFETY VALVE,
//     `passAtTokens`): a refused proposal there ends the turn with "Context limit reached" until a manual /compact (verified live, Haiku 4.5).
//
// SUB-AGENTS: a sub-agent is gated by its own `agents[id]` entry on Claude Code's `session.compact` event, which names the proposing `agentId`. Its context
// size is NOT in the event and `$.session.usage()` is the main conversation's, so register.tsx records each sub-agent's last model response (`turn.step`'s usage and
// model) and hands it here as `AgentSize`. `agentVerdict` decides one automatic proposal. A sub-agent with no entry is measured against the valve of ITS exact model id
// (`valves`, keyed by exact model id, one entry per active version; the dashboard writes it from the board's model capabilities: the same per-version limits a dispatched worker gets), never a guessed model.
//
// The control is a local file the session's danx-dashboard MCP relay writes (`~/.config/danxbot/compaction/<sessionId>.json`, shape below): the gate
// never asks the network, because Claude Code proposes before every model request. A function hook that THROWS lets the compaction through (verified
// live), so every decision here returns a verdict.
//
// FAIL OPEN, with ONE exception. Holding is a courtesy of 50 Arms' cost policy, never worth ending a session for: a session that refuses every proposal ends with "Context
// limit reached" (verified live), and the only escape, the safety valve's size, lives in the very file the gate may be unable to read. So whatever the gate
// cannot establish (a control file it cannot read, a read that throws, the MAIN agent's context size) lets Claude Code's own compaction apply and holds nothing.
// The person is told once that the control is unreadable (register.tsx). The exception is a SUB-AGENT whose context size or model the plugin never saw
// (`agentVerdict`): that proposal is refused and told, never guessed; the agent's next model response (`turn.step`) fills its size, and the next
// proposal is judged on it.
//
// The shapes mirror the `CompactionFile` the relay (the danx-dashboard MCP server) writes: a plugin cannot import it.
// A file this module cannot read is `bad`, never a guess.

// The safety valve's size is NOT computed here. 50 Arms computes it once, from the session's model (the model's window less Claude Code's blocking margin
// less the largest single step seen), and the relay writes it into the file as `passAtTokens`: the gate reads that number and holds no copy of the margin,
// so a change to the margin moves every gate. Pinned by the same literal in this plugin's tests and in the relay's own tests.

export const HELD_REASON = '[50 ARMS] automatic compaction is held: your agent compacts the session when it says ready'

// `windowTokens` is the context window 50 Arms assumed for the session's model (its table lists a window per exact model version); the floor and
// the valve were computed from it, so a session whose real window is smaller must not be held (`windowFits`).
export type GateControl = {
  floorTokens: number
  passAtTokens: number
  windowTokens: number
  releaseUntilMs: number | null
  releaseId: string | null
  // null when the relay that wrote the file is older than this plugin and wrote no `agents` or no `valves` (relay 0.1.311 wrote neither, 0.1.315-0.1.317 only `agents`): the
  // MAIN agent's handshake above is complete without them, and every sub-agent feature (arming, asks, the per-agent gate) is off. Claude Code hot-loads a new plugin version into a
  // live session but the session's MCP relay keeps its version until the server restarts, so a plugin must work beside an older relay.
  subagents: SubagentControl | null
}

export type SubagentControl = {
  // each sub-agent's own control by agent id; `{}` while none has been recommended
  agents: Record<string, AgentControl>
  // the safety-valve size of each active model version, keyed by exact model id: the valve of a sub-agent that has no `agents` entry
  valves: ModelValves
}

// the notice for a control whose relay is older than the plugin (`subagents: null`); register.tsx shows it once per session, and again if it changes.
export const RELAY_OLDER_NOTICE =
  'The danxbot dashboard MCP relay of this session is older than the danxbot plugin, so sub-agent compaction is off (the main agent still compacts when it says ready). Reconnect the danxbot dashboard MCP server (/mcp) or start a new session to fix it.'

// the notice for an engine release the plugin could not read; register.tsx shows it once per process, when the handshake would arm the sub-agents.
export const ENGINE_VERSION_NOTICE =
  'The Claude Code release could not be read, so sub-agent compaction stays off until this session has compacted once (the main agent still compacts when it says ready).'

// one sub-agent's control as the relay writes it: its own safety valve and nothing else. A sub-agent is never released in place: 50 Arms proposes its
// handover to the orchestrator, which asks the sub-agent, so the relay writes no request or release for a sub-agent. Extra keys are ignored, not rejected.
export type AgentControl = { passAtTokens: number }

// the safety-valve size by exact model id (`claude-<line>-...`, e.g. `claude-haiku-5-5`); a version not active is absent
export type ModelValves = Record<string, number>
const MODEL_ID = /^claude-[a-z]+-\S+$/

// `absent`: no file (the relay has not written one yet). `control: null`: the session is not under the handshake.
export type ControlFile = { kind: 'absent' } | { kind: 'control'; control: GateControl | null } | { kind: 'bad'; reason: string }

// The spent main-agent releases are kept in $.store, one record per session. The newest USED_RELEASE_KEEP SESSIONS' records stay, so the store does not grow with
// every session ever held.
export const USED_RELEASE_PREFIX = 'compaction-used-release:'
export const USED_RELEASE_KEEP = 40
export type UsedRelease = { releaseId: string; at: number }
export const usedReleaseKey = (sessionId: string): string => `${USED_RELEASE_PREFIX}${sessionId}`
// The session a per-session record key belongs to (a session id holds no ':').
const sessionOfKey = (key: string, prefix: string): string => key.slice(prefix.length).split(':')[0]
export function staleSessionKeys(entries: { key: string; at: number }[], prefix: string): string[] {
  const newest = new Map<string, number>()
  for (const e of entries) {
    const session = sessionOfKey(e.key, prefix)
    newest.set(session, Math.max(newest.get(session) ?? 0, e.at))
  }
  const stale = new Set([...newest].sort((a, b) => b[1] - a[1]).slice(USED_RELEASE_KEEP).map(([session]) => session))
  return entries.filter(e => stale.has(sessionOfKey(e.key, prefix))).map(e => e.key)
}
export const staleUsedReleaseKeys = (entries: { key: string; at: number }[]): string[] => staleSessionKeys(entries, USED_RELEASE_PREFIX)
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
  const release = releaseProblem(c)
  if (release !== null) return { kind: 'bad', reason: release }
  // a field that is absent means a relay older than this plugin (the main handshake stays whole); one that is present but malformed is real corruption and stays `bad`
  const agents = c.agents === undefined ? null : parseAgents(c.agents)
  if (typeof agents === 'string') return { kind: 'bad', reason: agents }
  const valves = c.valves === undefined ? null : parseValves(c.valves)
  if (typeof valves === 'string') return { kind: 'bad', reason: valves }
  return {
    kind: 'control',
    control: {
      floorTokens: c.floorTokens,
      passAtTokens: c.passAtTokens,
      windowTokens: c.windowTokens,
      releaseUntilMs: c.releaseUntilMs as number | null,
      releaseId: c.releaseId as string | null,
      subagents: agents === null || valves === null ? null : { agents, valves },
    },
  }
}

// Why a release pair (the main agent's or a sub-agent's) cannot be read, or null when it can.
function releaseProblem(c: Record<string, unknown>): string | null {
  if ((c.releaseUntilMs === null) !== (c.releaseId === null)) return 'releaseUntilMs and releaseId are both set or both null'
  if (c.releaseUntilMs !== null && !(typeof c.releaseUntilMs === 'number' && Number.isFinite(c.releaseUntilMs))) return 'releaseUntilMs must be a number or null'
  if (c.releaseId !== null && (typeof c.releaseId !== 'string' || c.releaseId === '')) return 'releaseId must be a string or null'
  return null
}

// the `agents` map, or (a string) why it cannot be read.
function parseAgents(value: unknown): Record<string, AgentControl> | string {
  if (!isRecord(value)) return 'agents must be an object keyed by agent id'
  const agents: Record<string, AgentControl> = {}
  for (const [id, a] of Object.entries(value)) {
    if (id === '') return 'agents has an empty agent id'
    if (!isRecord(a)) return `agents.${id} is not an object`
    if (!isCount(a.passAtTokens)) return `agents.${id}.passAtTokens must be a whole number`
    agents[id] = { passAtTokens: a.passAtTokens }
  }
  return agents
}

// the per-version valves, or (a string) why they cannot be read: exact model ids only (`claude-<line>-...`), each a positive whole number.
function parseValves(value: unknown): ModelValves | string {
  if (!isRecord(value)) return 'valves must be an object keyed by model id'
  const valves: ModelValves = {}
  for (const [model, tokens] of Object.entries(value)) {
    if (!MODEL_ID.test(model)) return `valves names ${JSON.stringify(model)}, which is not an exact model id`
    if (!isCount(tokens) || tokens === 0) return `valves.${model} must be a positive whole number`
    valves[model] = tokens
  }
  return valves
}

// Whether the control's floor and valve can be reached in this session. 50 Arms computed them from the window it assumed for the model; when the session's
// real window (`$.session.usage().context.window`, null when the engine cannot say yet) is smaller, a proposal could come before the floor and the valve would
// never be reached. Held only when the real window is not known to be smaller.
export const windowFits = (control: GateControl, realWindow: number | null): boolean => realWindow === null || realWindow >= control.windowTokens

// the session is under the handshake exactly when its file carries a control; only such a session can be given a ready.
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
//   a person's own /compact (and the plugin's own start of a ready compaction) always passes; anything that is not exactly `auto` (or `precompute`, judged the same) is refused;
//   a file with no control (the switch went off, or the file is gone - a week's pruning by the relay) holds nothing: there is no handshake to wait for;
//   a file the gate cannot read, a window smaller than the one the control assumed, and an unknown context size hold nothing either (fail open, above);
//   at the safety valve's size (the file's `passAtTokens`) the proposal passes whatever the handshake says;
//   otherwise it is refused: a ready agent is compacted by the plugin's own /compact, never by releasing a proposal.
export function verdict(input: GateInput): Verdict {
  if (input.trigger === 'manual') return { pass: true, why: 'manual' }
  // a `precompute` (a compaction computed ahead of time, installed by nothing) is judged exactly like an automatic proposal
  if (input.trigger !== 'auto' && input.trigger !== 'precompute') return { pass: false, reason: `${HELD_REASON} (unexpected PreCompact trigger ${JSON.stringify(input.trigger)})` }
  if (input.file.kind === 'bad') return { pass: true, why: 'unreadable' }
  if (input.file.kind === 'absent' || input.file.control === null) return { pass: true, why: 'no-control' }
  if (!windowFits(input.file.control, input.window)) return { pass: true, why: 'no-control' }
  if (input.tokens === null) return { pass: true, why: 'unknown-size' }
  if (input.tokens >= input.file.control.passAtTokens) return { pass: true, why: 'valve' }
  return { pass: false, reason: HELD_REASON }
}

// ---- the sub-agents -----------------------------------------------------------------------------------------------------------------------------------

// The percent of `windowTokens` that `floorTokens` is, rounded DOWN to two decimals: the value of CLAUDE_AUTOCOMPACT_PCT_OVERRIDE that makes Claude Code propose from the floor
// (the same rule the dashboard applies: a proposal a little below the floor is held and costs a hook call, one above it could leave an
// agent that said ready with no proposal to release). Integer arithmetic, so 250000 of 1000000 is exactly 25.
export const floorPercent = (floorTokens: number, windowTokens: number): number => Math.floor((floorTokens * 100 * 100) / windowTokens) / 100

// the engine release whose `session.compact` is known to judge each sub-agent's automatic proposal by agent (verified live, Claude Code 2.1.299). The types of every
// release from 2.1.286 declare the event, but none tells whether an engine serves it per agent, and the runtime exposes no capability flag, so this floor is a verified fact, not a
// guess: a later release can lower it once an older engine is tried. `base` is `$.session.version()`'s release (`2.1.299`, or `2.1.299-dev` for a development build of it); no `base` is no release.
export const SESSION_COMPACT_FLOOR = [2, 1, 299] as const
export function runsSessionCompact(base: string | undefined): boolean {
  const m = base === undefined ? null : /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(base)
  if (m === null) return false
  for (let i = 0; i < 3; i++) {
    const part = Number(m[i + 1])
    if (part !== SESSION_COMPACT_FLOOR[i]) return part > SESSION_COMPACT_FLOOR[i]
  }
  return true
}

// The percent the plugin arms the sub-agents with, null when the session is not under the handshake (nothing is armed, and an armed value is taken back).
// also null while sub-agent control is unavailable (an older relay): nothing the plugin arms could be gated.
export const armedPercentOf = (file: ControlFile): number | null => (file.kind === 'control' && file.control !== null && file.control.subagents !== null ? floorPercent(file.control.floorTokens, file.control.windowTokens) : null)

// A sub-agent's context as its last model response reported it: the whole prompt it was answered over (uncached, cache-read and cache-written input) and the model that answered.
export type AgentSize = { tokens: number; model: string }
export const sizeOfUsage = (usage: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string }): AgentSize | null => {
  const tokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  // a failed turn ("Prompt is too long") reports no usage at all; it says nothing about the context
  return tokens > 0 ? { tokens, model: usage.model } : null
}

// how many sub-agents' last responses the plugin keeps (the oldest goes first)
export const AGENT_SIZES_KEEP = 256
// how many distinct sub-agent faults the told-once memory holds; the oldest is forgotten past it
export const AGENT_FAULT_TOLD_KEEP = 256
// the told-once memory keeps this many characters of a fault, since the text can embed an id of any length
export const AGENT_FAULT_KEY_MAX = 200

export const AGENT_HELD_REASON = '[50 ARMS] automatic compaction is held: this sub-agent compacts when it says ready'

export type AgentGateInput = {
  agentId: string
  file: ControlFile
  // the sub-agent's last model response; null when the plugin has seen none from it
  size: AgentSize | null
}

// `told: true` is a refusal the person should hear once (the gate cannot establish something it needs), unlike the ordinary hold.
export type AgentVerdict = { pass: true; why: 'no-control' | 'unreadable' | 'valve' | 'subagents-off' } | { pass: false; reason: string; told: boolean }

// The decision for one AUTOMATIC proposal of the sub-agent `agentId` (a person's own /compact is the main agent's and never reaches this), in order:
//   a file with no control holds nothing, and neither does one the gate cannot read (fail open, above): there is no handshake to wait for, or none that can be kept;
//   a control with no sub-agent control (a relay older than the plugin) holds nothing either;
//   a context size the plugin never saw is refused and told: a size it cannot read is never guessed;
//   a sub-agent with an entry passes at ITS valve (`passAtTokens`) and is otherwise held: a sub-agent is never compacted in place, only at its valve or by a person's /compact;
//   a sub-agent with no entry (not placed yet, or one the dashboard cannot place) passes at the valve of ITS exact model id, read from its own responses; a model
//   the control has no valve for is refused and told, never given a line's valve, a guessed model or a default valve.
export function agentVerdict(input: AgentGateInput): AgentVerdict {
  const { file, size, agentId } = input
  if (file.kind === 'bad') return { pass: true, why: 'unreadable' }
  if (file.kind === 'absent' || file.control === null) return { pass: true, why: 'no-control' }
  const refuse = (why: string): AgentVerdict => ({ pass: false, reason: `${AGENT_HELD_REASON} (sub-agent ${agentId}: ${why})`, told: true })
  // a relay older than the plugin gives no sub-agent control. Fail open: the plugin arms nothing then, so the proposal only comes at Claude Code's own threshold
  // (the behaviour before the handshake), and refusing it would strand the sub-agent at its window. The person was told by RELAY_OLDER_NOTICE.
  const subagents = file.control.subagents
  if (subagents === null) return { pass: true, why: 'subagents-off' }
  if (size === null) return refuse('its context size is not known')
  const entry = subagents.agents[agentId]
  if (entry !== undefined) {
    if (size.tokens >= entry.passAtTokens) return { pass: true, why: 'valve' }
    return { pass: false, reason: AGENT_HELD_REASON, told: false }
  }
  const valve = subagents.valves[size.model]
  if (valve === undefined) return refuse(`it has no compaction control yet and the control has no valve for its model ${JSON.stringify(size.model)}`)
  if (size.tokens >= valve) return { pass: true, why: 'valve' }
  return { pass: false, reason: AGENT_HELD_REASON, told: false }
}
