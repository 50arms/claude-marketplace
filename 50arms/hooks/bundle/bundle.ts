// The policy bundle 50 Arms renders for one session (`GET /api/behavior-events/bundle`) and how the plugin evaluates one plugin event from it.
// Pure: every `$` call stays in register.tsx. The bundle is the ONE source of every text an agent is told at a hook moment (the mantra, the
// start, resume, compaction and sub-agent texts, the role pointer, the plan's own event text); this file composes none of them, it only
// decides which attachments apply to a moment, fills the slots the plugin owns, and keeps a once-only text from being told twice.

export type BundleRule = { ref: string; content_hash: string }
export type BundleSection = { label: string; kind: string; text: string; chars: number; rules: BundleRule[]; slots: string[] }
export type BundleAttachment = { attachment_id: number; mechanism: string; frequency: Frequency; matcher: Record<string, string> | null; sections: BundleSection[] }
export type BundleMechanism = { mechanism: string; cap: number | null; over_cap_pointer: string | null }
export type BundleComputed = { key: string; mechanism: string; frequency: Frequency; text: string; chars: number; rules: BundleRule[] }
export type BundleEvent = { event: string; matchers: string[]; hook_slots: string[]; mechanisms: BundleMechanism[]; attachments: BundleAttachment[]; computed: BundleComputed[] }
export type Bundle = { version: string; min_plugin_version: string; floor_lines_plugin_version: string | null; events: BundleEvent[] }

export const FREQUENCIES = ['every', 'once_per_session', 'once_per_card_per_session'] as const
export type Frequency = (typeof FREQUENCIES)[number]

// What a bundle read answered: the bundle, or `{unchanged: true}` for the `known_version` the call sent.
export type BundleRead = { kind: 'bundle'; bundle: Bundle } | { kind: 'unchanged'; version: string; floorLinesPluginVersion: string | null }

// The path and query of the read; the plugin names its own version (a call below the floor is refused 426) and, once it holds a bundle, that bundle's version.
export const BUNDLE_PATH = '/api/behavior-events/bundle'
export const REPORTS_PATH = '/api/plan-sessions/me/behavior-events'
export const FLOOR_PATH = '/api/plan-sessions/me/plugin-floor'
export const bundleQuery = (pluginVersion: string, knownVersion: string | null): Record<string, string> =>
  knownVersion === null ? { plugin_version: pluginVersion } : { plugin_version: pluginVersion, known_version: knownVersion }

// The numeric parts of a plain dotted version, trailing zeros dropped (`0.17` equals `0.17.0`); compared by parts, never as strings.
export function versionParts(version: string): number[] {
  const parts = version.split('.').map(Number)
  while (parts.length > 1 && parts[parts.length - 1] === 0) parts.pop()
  return parts
}

export function compareVersions(a: string, b: string): number {
  const x = versionParts(a)
  const y = versionParts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

// The floor lines are sent when the team holds none or holds an older plugin version's set.
export const floorIsStale = (teamVersion: string | null, own: string): boolean => teamVersion === null || compareVersions(teamVersion, own) < 0

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const HEX64 = /^[0-9a-f]{64}$/

export class BundleShapeError extends Error {}

function shape(why: string): never {
  throw new BundleShapeError(`bad_response: the bundle ${why}`)
}

const list = (v: unknown, where: string): unknown[] => (Array.isArray(v) ? v : shape(`${where} is not a list`))
const record = (v: unknown, where: string): Record<string, unknown> => (isRecord(v) ? v : shape(`${where} is not an object`))

function rulesOf(v: unknown, where: string): BundleRule[] {
  return list(v, `${where}.rules`).map(r => {
    const o = record(r, `${where}.rules[]`)
    if (!isString(o.ref) || !isString(o.content_hash)) shape(`${where}.rules[] has no ref and content_hash`)
    return { ref: o.ref, content_hash: o.content_hash }
  })
}

function frequencyOf(v: unknown, where: string): Frequency {
  // an unknown frequency is refused: guessing "every" would tell a once-only text on every call
  return (FREQUENCIES as readonly unknown[]).includes(v) ? (v as Frequency) : shape(`${where} has the frequency ${JSON.stringify(v)}, which this plugin does not know`)
}

function sectionOf(v: unknown, where: string): BundleSection {
  const o = record(v, where)
  if (!isString(o.text) || !isCount(o.chars)) shape(`${where} has no text and chars`)
  return { label: isString(o.label) ? o.label : '', kind: isString(o.kind) ? o.kind : '', text: o.text, chars: o.chars, rules: rulesOf(o.rules, where), slots: list(o.slots, `${where}.slots`).map(s => (isString(s) ? s : shape(`${where}.slots holds a non-text`))) }
}

function attachmentOf(v: unknown, where: string): BundleAttachment {
  const o = record(v, where)
  if (!isCount(o.attachment_id) || !isString(o.mechanism)) shape(`${where} has no attachment_id and mechanism`)
  let matcher: Record<string, string> | null = null
  if (o.matcher !== null && o.matcher !== undefined) {
    const m = record(o.matcher, `${where}.matcher`)
    matcher = {}
    for (const [k, g] of Object.entries(m)) matcher[k] = isString(g) ? g : shape(`${where}.matcher.${k} is not a glob`)
  }
  return { attachment_id: o.attachment_id, mechanism: o.mechanism, frequency: frequencyOf(o.frequency, where), matcher, sections: list(o.sections, `${where}.sections`).map((s, i) => sectionOf(s, `${where}.sections[${i}]`)) }
}

function computedOf(v: unknown, where: string): BundleComputed {
  const o = record(v, where)
  if (!isString(o.key) || !isString(o.mechanism) || !isString(o.text) || !isCount(o.chars)) shape(`${where} has no key, mechanism, text and chars`)
  return { key: o.key, mechanism: o.mechanism, frequency: frequencyOf(o.frequency, where), text: o.text, chars: o.chars, rules: rulesOf(o.rules, where) }
}

function eventOf(v: unknown, where: string): BundleEvent {
  const o = record(v, where)
  if (!isString(o.event)) shape(`${where} has no event key`)
  const strings = (x: unknown, name: string) => list(x, `${where}.${name}`).map(s => (isString(s) ? s : shape(`${where}.${name} holds a non-text`)))
  const mechanisms = list(o.mechanisms, `${where}.mechanisms`).map((m): BundleMechanism => {
    const mo = record(m, `${where}.mechanisms[]`)
    if (!isString(mo.mechanism)) shape(`${where}.mechanisms[] has no mechanism`)
    const cap = mo.cap === null || mo.cap === undefined ? null : isCount(mo.cap) ? mo.cap : shape(`${where}.mechanisms[].cap is not a count`)
    const pointer = mo.over_cap_pointer === null || mo.over_cap_pointer === undefined ? null : isString(mo.over_cap_pointer) ? mo.over_cap_pointer : shape(`${where}.mechanisms[].over_cap_pointer is not text`)
    return { mechanism: mo.mechanism, cap, over_cap_pointer: pointer }
  })
  return {
    event: o.event,
    matchers: strings(o.matchers, 'matchers'),
    hook_slots: strings(o.hook_slots, 'hook_slots'),
    mechanisms,
    attachments: list(o.attachments, `${where}.attachments`).map((a, i) => attachmentOf(a, `${where}.attachments[${i}]`)),
    computed: list(o.computed, `${where}.computed`).map((c, i) => computedOf(c, `${where}.computed[${i}]`)),
  }
}

// The body of a bundle read as the contract words it. Anything else throws a BundleShapeError naming what is wrong: a bundle the plugin cannot read is a failed fetch, never a guess.
export function readBundleBody(body: unknown): BundleRead {
  const o = record(body, 'answer')
  if (!isString(o.version) || !HEX64.test(o.version)) shape('answer has no version of 64 hex characters')
  if (o.floor_lines_plugin_version !== null && !isString(o.floor_lines_plugin_version)) shape('answer has no floor_lines_plugin_version (a version or null)')
  const floor = o.floor_lines_plugin_version as string | null
  if (o.unchanged === true) return { kind: 'unchanged', version: o.version, floorLinesPluginVersion: floor }
  if (!isString(o.min_plugin_version)) shape('answer has no min_plugin_version')
  return { kind: 'bundle', bundle: { version: o.version, min_plugin_version: o.min_plugin_version, floor_lines_plugin_version: floor, events: list(o.events, 'answer.events').map((e, i) => eventOf(e, `events[${i}]`)) } }
}

// ---- when a held bundle may be used ----

// The relay writes the session file `behavior-bundle/<session id>.json` (`{v: 1, sessionId, version}`) naming the bundle's current version. A file the plugin cannot read is a failure the caller tells, never "no file".
export type BundleFile = { kind: 'version'; version: string } | { kind: 'absent' } | { kind: 'unreadable'; reason: string }

export function bundleFileOf(text: string | null, sessionId: string): BundleFile {
  if (text === null) return { kind: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'unreadable', reason: 'the session file is not JSON' }
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !isString(parsed.sessionId) || !isString(parsed.version) || !HEX64.test(parsed.version)) return { kind: 'unreadable', reason: 'the session file is not a behavior bundle file' }
  // a file written for another session is not this session's: refused like any unreadable one
  if (parsed.sessionId !== sessionId) return { kind: 'unreadable', reason: 'the session file was written for another session' }
  return { kind: 'version', version: parsed.version }
}

// While the relay is down a held bundle is current for this long after the last answer that confirmed it, and it is asked again no more often than the poll gap.
export const BUNDLE_CONFIRM_MS = 90_000
export const BUNDLE_POLL_MS = 60_000

export type Held = { bundle: Bundle; confirmedAt: number }

// Whether the bundle held is current: while the session file names its version (the relay is up, and says when a policy changes), else, relay down, for BUNDLE_CONFIRM_MS after the answer that confirmed it. A bundle that is not current is no bundle (the agent is not run on it).
export function isCurrent(held: Held | null, file: BundleFile, now: number): boolean {
  if (held === null) return false
  if (file.kind === 'version') return file.version === held.bundle.version
  return now - held.confirmedAt < BUNDLE_CONFIRM_MS
}

// Whether a read is due: nothing held, the file names another version, or (relay down) the poll gap has passed since the last answer.
export function readIsDue(held: Held | null, file: BundleFile, now: number): boolean {
  if (held === null) return true
  if (file.kind === 'version') return file.version !== held.bundle.version
  return now - held.confirmedAt >= BUNDLE_POLL_MS
}

// ---- evaluating one event ----

// What an agent context (the main conversation, or a sub-agent by its id) was already told: `told[key]` lists the cards a once-only text was told under (`''` for no card). A compaction or clear of the context empties it.
export type Told = Record<string, string[]>
export const NO_TOLD: Told = {}
export const mainContext = 'main'
export const contextKey = (agentId: string | null): string => agentId ?? mainContext

// The events that start a new context for the conversation they fire in: after a compaction or a clear it holds none of what it was told before. A sub-agent's own compaction does the same for that sub-agent.
export const CONTEXT_STARTS = ['session.after_compaction', 'session.after_clear', 'subagent.compacted'] as const
export const startsNewContext = (event: string): boolean => (CONTEXT_STARTS as readonly string[]).includes(event)

// The moment as the hook saw it: the matcher fields (`tool_name`, `tool_command`, `tool_path`), the slots the plugin fills, and the session's current card (for `once_per_card_per_session`).
export type Moment = { event: string; matchers: Record<string, string>; slots: Record<string, string>; card: string | null }

// `*` any run of characters, `?` one character; everything else literal.
export function globMatches(glob: string, value: string): boolean {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${re}$`, 's').test(value)
}

// An attachment's matcher holds when every field it names is on the moment and its glob matches; no matcher matches every call.
export function matcherHolds(matcher: Record<string, string> | null, fields: Record<string, string>): boolean {
  if (matcher === null) return true
  return Object.entries(matcher).every(([field, glob]) => fields[field] !== undefined && globMatches(glob, fields[field] as string))
}

const length = (text: string): number => [...text].length

const SLOT_NAMED = /\{\{slot:([a-z_][a-z0-9_]*)\}\}/g

// A text with each slot filled; a slot the plugin cannot fill is named inline and in `missing`, never left blank.
export function fillSlots(text: string, slots: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = []
  const filled = text.replace(SLOT_NAMED, (_all, name: string) => {
    const value = slots[name]
    if (value !== undefined) return value
    if (!missing.includes(name)) missing.push(name)
    return `[${name} unavailable]`
  })
  return { text: filled, missing }
}

export const missingSlotsLine = (event: string, missing: string[]): string => `⚠ 50 Arms: the plugin could not fill the slot${missing.length === 1 ? '' : 's'} ${missing.map(m => `"${m}"`).join(', ')} of the "${event}" event, so a value above is missing. Tell the person.`

// One text to tell on a moment: one per mechanism for the attachments (their sections joined), one per computed section. `overCap` is set when the filled text is longer than its mechanism carries: the caller writes `text` to a file and tells the pointer.
export type Delivery = {
  event: string
  mechanism: string
  text: string
  // the characters the bundle named for what is delivered (reported back as the bundle gave them)
  chars: number
  attachmentIds: number[]
  rules: BundleRule[]
  computedKey: string | null
  missingSlots: string[]
  overCap: { cap: number; pointer: string; fullChars: number } | null
}

export type Decision = { deliveries: Delivery[]; told: Told }

const mechanismOf = (event: BundleEvent, key: string): BundleMechanism => event.mechanisms.find(m => m.mechanism === key) ?? shape(`event "${event.event}" names no mechanism "${key}"`)

function applies(frequency: Frequency, key: string, card: string | null, told: Told): boolean {
  const seen = told[key]
  if (frequency === 'every') return true
  if (frequency === 'once_per_session') return seen === undefined
  return seen === undefined || !seen.includes(card ?? '')
}

function noted(told: Told, key: string, frequency: Frequency, card: string | null): void {
  if (frequency === 'every') return
  const seen = told[key] ?? []
  told[key] = frequency === 'once_per_session' || seen.includes(card ?? '') ? seen : [...seen, card ?? '']
}

function delivery(event: BundleEvent, mechanism: string, parts: { text: string; chars: number; rules: BundleRule[] }[], attachmentIds: number[], computedKey: string | null, slots: Record<string, string>): Delivery {
  const filled = fillSlots(parts.map(p => p.text).join('\n\n'), slots)
  const text = filled.missing.length === 0 ? filled.text : `${filled.text}\n${missingSlotsLine(event.event, filled.missing)}`
  const mech = mechanismOf(event, mechanism)
  const fullChars = length(text)
  let overCap: Delivery['overCap'] = null
  if (mech.cap !== null && fullChars > mech.cap) {
    if (mech.over_cap_pointer === null) shape(`mechanism "${mechanism}" of event "${event.event}" has a cap and no over_cap_pointer`)
    overCap = { cap: mech.cap, pointer: mech.over_cap_pointer, fullChars }
  }
  const seen = new Set<string>()
  const rules = parts.flatMap(p => p.rules).filter(r => (seen.has(`${r.ref}@${r.content_hash}`) ? false : (seen.add(`${r.ref}@${r.content_hash}`), true)))
  return { event: event.event, mechanism, text, chars: parts.reduce((n, p) => n + p.chars, 0), attachmentIds, rules, computedKey, missingSlots: filled.missing, overCap }
}

// What the moment delivers from the bundle, and what each context has now been told. A compaction or clear starts the context again BEFORE the event is decided, so a once-only text is told again after one.
// Decisions are made one at a time by the caller (two hooks firing together never both deliver a once-only text): this function only reads `told` and returns the next.
export function decide(bundle: Bundle, moment: Moment, told: Told): Decision {
  const event = bundle.events.find(e => e.event === moment.event)
  const base = startsNewContext(moment.event) ? NO_TOLD : told
  if (event === undefined) return { deliveries: [], told: base }
  const next: Told = { ...base }
  const deliveries: Delivery[] = []
  const groups = new Map<string, { parts: { text: string; chars: number; rules: BundleRule[] }[]; ids: number[] }>()
  for (const a of event.attachments) {
    if (!matcherHolds(a.matcher, moment.matchers)) continue
    const key = `att:${a.attachment_id}`
    if (!applies(a.frequency, key, moment.card, next)) continue
    noted(next, key, a.frequency, moment.card)
    const group = groups.get(a.mechanism) ?? { parts: [], ids: [] }
    group.parts.push({ text: a.sections.map(s => s.text).join('\n\n'), chars: a.sections.reduce((n, s) => n + s.chars, 0), rules: a.sections.flatMap(s => s.rules) })
    group.ids.push(a.attachment_id)
    groups.set(a.mechanism, group)
  }
  for (const [mechanism, group] of groups) deliveries.push(delivery(event, mechanism, group.parts, group.ids, null, moment.slots))
  // after the event's attachments: its computed sections (the plan's own text for it, the endpoints requested before a compaction), each by the mechanism and frequency the bundle names
  for (const c of event.computed) {
    const key = `computed:${c.key}`
    if (!applies(c.frequency, key, moment.card, next)) continue
    noted(next, key, c.frequency, moment.card)
    deliveries.push(delivery(event, c.mechanism, [{ text: c.text, chars: c.chars, rules: c.rules }], [], c.key, moment.slots))
  }
  return { deliveries, told: next }
}

// The text an over-cap delivery tells: the bundle's pointer sentence with the length and the file the full text was written to.
export const pointerText = (d: Delivery, file: string): string => {
  if (d.overCap === null) throw new Error('pointerText of a delivery that is not over its cap')
  return d.overCap.pointer.replace(/\{\{slot:chars\}\}/g, String(d.overCap.fullChars)).replace(/\{\{slot:carrier_file\}\}/g, file)
}

// What is told of a delivery once its full text, if it was over the cap, sits in `file`.
export const deliveredText = (d: Delivery, file: string | null): string => (d.overCap === null ? d.text : pointerText(d, file ?? shape('needs a file for an over-cap text')))
