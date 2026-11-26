// Shared stand-ins for the `claude plugin test 50arms` suites: a fake dashboard MCP server
// (50arms_api + session_connect), and recorders for the engine calls the
// plugin makes beneath it (toast, status, session.append, command.register).
import { expect, mock, test as baseTest } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DASHBOARD_SERVERS, SERVER, serverToolName, toolName } from '../hooks/plan/config'
import { CURSOR_PREFIX as RELAY_CURSOR_PREFIX, RELAY_MARKER } from '../hooks/relay/config'

// what the server reads of a `session_connect` target: `PLAN-n` is plan n, anything else a card's id
export const planNumberOf = (target: unknown): number | undefined => (typeof target === 'string' && /^PLAN-[1-9][0-9]*$/.test(target) ? Number(target.slice(5)) : undefined)

// DX-4883: the runner's default is 5000 ms of REAL time per test, and a case that drives the mocked clock pays real time to settle every timer
// it fires (about 1 s to start a session plus about 55 ms per mocked minute: the plugin's pacing and usage tickers run each minute). A
// 25-minute keepalive case takes 2-3.5 s on a quiet machine and crossed 5 s under load, refusing a publish. Every case built on this kit gets
// this bounded ceiling instead; it is a ceiling on machine load, not an assertion about speed (R-48), and a real hang still fails.
export const KIT_TEST_TIMEOUT_MS = 60_000
// The fixtures each test built, keyed by the `on` it was given: a test whose body returns with a one-shot hold (`apiHolds`, `processHolds`) never used fails, since a hold whose method, path or
// command no longer matches the plugin's call holds nothing, and the test would pass while testing nothing. A body that takes no `on` builds no fixture, so it runs as given.
const fixturesOf = new WeakMap<object, { apiHolds: { method: string; path: string }[]; processHolds: { command: string }[] }[]>()
export function assertHoldsUsed(on: object): void {
  const unused = (fixturesOf.get(on) ?? []).flatMap(world => [...world.apiHolds.map(h => `${h.method} ${h.path}`), ...world.processHolds.map(h => h.command)])
  if (unused.length > 0) throw new Error(`a one-shot hold the test set was never used, so it held nothing: ${unused.join(', ')}`)
}
// the body the kit's `test` runs: one that takes `on` ends with assertHoldsUsed
const kitBody = (body: (...args: any[]) => unknown): ((...args: any[]) => unknown) =>
  body.length < 2 ? body : async ($: any, on: any) => {
    await body($, on)
    assertHoldsUsed(on)
  }
// the kit's `test` on top of a runner's `test`: every body it is given runs as kitBody makes it
export const makeTest =
  (base: (name: string, options: object, body: (...args: any[]) => unknown) => void) =>
  (name: string, body: (...args: any[]) => unknown): void =>
    base(name, { timeoutMs: KIT_TEST_TIMEOUT_MS }, kitBody(body))
export const test = makeTest(baseTest as any)

// A path as the fixture's disk keys it: a Windows path (C:\Users\x) loses its drive letter and its backslashes, and the Linux test engine's resolution of it
// against its own working directory (/app/50arms/C:\Users\x) is undone, so a test holds the file at /Users/x
const fsKey = (path: string): string => path.replace(/^(?:.*\/)?[A-Za-z]:/, '').replaceAll('\\', '/')

export const SURFACES = ['terminal', 'desktop'] as const
// CP-67: the plugin's skills (one folder each under 50arms/skills). The test runtime refuses `node:fs` in a kit file ("a hooks module imports its own files by relative path and claude-code, nothing else"), so this list cannot be read from the folder and is kept by hand. The engine refuses a command named
// after one: `$.command.register: "/<name>" refused: it is the plugin's /50arms:<name>` (claude.exe 2.1.309), and the kit refuses it the same way.
export const PLUGIN_SKILLS = ['ready', 'fix-agent-behavior', 'issue-workflow', 'plan-workflow', 'prepare-for-compaction']

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false })
// DX-4317: the dashboard origin the fixture answers (`dashboard_url`): deliberately not the production
// one, so a link built on a constant instead of the answer fails every test that checks a href.
// DX-4234: the registry's effective text the fixture answers for an event (a distinct text per event, so a wrong event shows)
export const EVENT_TEXT = (event: string) => `The ${event} text.`
// CP-146: the words of the briefing a compaction (or a clear) is followed by are the bundle's, never the plugin's: the plugin only fills the slots (plan, cards, sub-agents, owed comments, git). The kit's own stand-in
// texts carry the slots and a mark each, so a test can find the briefing among the entries and check the values the plugin filled. `DEFAULT_BRIEFING` is the template filled for the fixture's plan (PLAN-23 50 Arms plugin),
// DX-9 in flight, no running sub-agent and a clean checkout of main. `TOLD(event)` is everything a start of that event is told on a connected session.
export const COMPACTED_MARK = 'Your conversation was just compacted'
export const CLEARED_MARK = 'Your conversation was just cleared'
export const BRIEFING_SLOTS = ['owed_list', 'plan_id', 'plan_name', 'card_list', 'agent_list', 'git_status']
export const BRIEFING_TEMPLATE = `[50 ARMS] ${COMPACTED_MARK}. Resume now, without asking the person. Comments you still owe an answer: {{slot:owed_list}}. Your plan is {{slot:plan_id}} {{slot:plan_name}}. Cards in flight on your plan: {{slot:card_list}}. Read each card before you act on it. Sub-agents running: {{slot:agent_list}}. Work not pushed, {{slot:git_status}}.`
export const CLEARED_TEMPLATE = `[50 ARMS] ${CLEARED_MARK}. Read each card before you act on it. Your plan is {{slot:plan_id}} {{slot:plan_name}}. Cards in flight on your plan: {{slot:card_list}}.`
export const SUB_BRIEFING_TEMPLATE = `[50 ARMS] ${COMPACTED_MARK}. You are sub-agent {{slot:sub_agent_id}} ({{slot:sub_agent_name}}).`
export const SUB_BRIEFING = (id: string, name: string) => `[50 ARMS] ${COMPACTED_MARK}. You are sub-agent ${id} (${name}).`
export const DEFAULT_BRIEFING = `[50 ARMS] ${COMPACTED_MARK}. Resume now, without asking the person. Comments you still owe an answer: none. Your plan is PLAN-23 50 Arms plugin. Cards in flight on your plan: DX-9 In flight card. Read each card before you act on it. Sub-agents running: none running. Work not pushed, in the session's own checkout (branch main): no uncommitted changes, nothing unpushed.`
export const TOLD = (event: string) => (event === 'after_compaction' ? `${EVENT_TEXT(event)}

${DEFAULT_BRIEFING}` : EVENT_TEXT(event))
// DX-4234: where the fixture's machine keeps the MCP server's connection record of a session (what makes a session locally known as plan-connected)
// CP-146: the stand-in dashboard's policy bundle (`GET /api/behavior-events/bundle`). Every plugin event the old registry route answered by name carries one attachment whose text is `EVENT_TEXT(name)`
// (or the text a test sets in `world.eventText`), so a suite that asserts on what a session is told keeps its words. A catalog key by the old event name:
export const BUNDLE_EVENT_KEY: Record<string, string> = {
  session_start: 'session.start',
  session_resume: 'session.resume',
  after_compaction: 'session.after_compaction',
  sub_agent_start: 'subagent.start',
  sub_agent_stop: 'subagent.stop',
  side_session_turn_end: 'side_session.turn_end',
}
export const BUNDLE_VERSION = `${'a'.repeat(63)}1`
export const NEXT_BUNDLE_VERSION = `${'b'.repeat(63)}2`
export const PLUGIN_VERSION = '0.17.170'
export const bundleFileText = (sessionId: string, version: string) => JSON.stringify({ v: 1, sessionId, version })
export const BUNDLE_FILE_PATH = (sessionId: string) => `${HOME_DIR}/.config/danxbot/behavior-bundle/${sessionId}.json`
/** One bundle event with one attachment per text: `texts` are the sections, by mechanism (`plugin.context` unless named). */
export const bundleEvent = (event: string, texts: string[], extra: { mechanism?: string; frequency?: string; matcher?: Record<string, string> | null; id?: number; slots?: string[]; hookSlots?: string[]; computed?: unknown[]; cap?: number; pointer?: string } = {}) => ({
  event,
  matchers: ['tool_name', 'tool_command', 'tool_path'],
  hook_slots: extra.hookSlots ?? [],
  mechanisms: [{ mechanism: extra.mechanism ?? 'plugin.context', cap: extra.cap ?? null, over_cap_pointer: extra.cap === undefined ? null : extra.pointer ?? 'It is {{slot:chars}} characters: read {{slot:carrier_file}}.' }],
  attachments: texts.map((text, i) => ({
    attachment_id: (extra.id ?? 1000) + i,
    mechanism: extra.mechanism ?? 'plugin.context',
    frequency: extra.frequency ?? 'every',
    matcher: extra.matcher ?? null,
    sections: [{ label: 'rule', kind: 'rule', text, chars: text.length, rules: [{ ref: `BPR-${(extra.id ?? 1000) + i}`, content_hash: 'c'.repeat(64) }], slots: extra.slots ?? [] }],
  })),
  computed: extra.computed ?? [],
})

/**
 * The wire shape of a bundle (DX-8225): each section and each mechanism listed once, an event naming its mechanisms by key and an attachment its sections by id. A test describes an event with `bundleEvent` (its sections inline);
 * this lists them once. Sections that are the same text with the same rules share one id, as the hosted bundle's do.
 */
export function assembleBundle(events: ReturnType<typeof bundleEvent>[]) {
  const sections: Record<string, unknown> = {}
  const ids = new Map<string, string>()
  const mechanisms: { mechanism: string; cap: number | null; over_cap_pointer: string | null }[] = []
  const wire = events.map(event => {
    // a mechanism has one cap in a bundle: the event a test gives a cap wins over the kit's uncapped default
    for (const m of event.mechanisms) {
      const listed = mechanisms.findIndex(x => x.mechanism === m.mechanism)
      if (listed === -1) mechanisms.push(m)
      else if (m.cap !== null) mechanisms[listed] = m
    }
    return {
      event: event.event,
      matchers: event.matchers,
      hook_slots: event.hook_slots,
      mechanism_keys: [...new Set([...event.attachments.map(a => a.mechanism), ...event.mechanisms.map(m => m.mechanism), ...(event.computed as { mechanism: string }[]).map(c => c.mechanism)])],
      attachments: event.attachments.map(a => ({
        attachment_id: a.attachment_id,
        mechanism: a.mechanism,
        frequency: a.frequency,
        matcher: a.matcher,
        section_ids: a.sections.map(section => {
          const key = JSON.stringify(section)
          if (!ids.has(key)) {
            ids.set(key, ids.size.toString(16).padStart(16, '0'))
            sections[ids.get(key) as string] = section
          }
          return ids.get(key) as string
        }),
      })),
      computed: event.computed,
    }
  })
  return { sections, mechanisms, events: wire }
}

/** SHA-256 of a text's UTF-8 bytes, as lowercase hex: the kit's own, so the check the plugin makes of a reply file is not made with the plugin's own code (a kit file may import nothing else). */
export function sha256Hex(textValue: string): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
    0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  const bytes = [...new TextEncoder().encode(textValue)]
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  for (let shift = 56; shift >= 0; shift -= 8) bytes.push(Math.floor(bitLength / 2 ** shift) & 0xff)
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  const w = new Array<number>(64)
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = ((bytes[offset + 4 * i] as number) << 24) | ((bytes[offset + 4 * i + 1] as number) << 16) | ((bytes[offset + 4 * i + 2] as number) << 8) | (bytes[offset + 4 * i + 3] as number)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15] as number, 7) ^ rotr(w[i - 15] as number, 18) ^ ((w[i - 15] as number) >>> 3)
      const s1 = rotr(w[i - 2] as number, 17) ^ rotr(w[i - 2] as number, 19) ^ ((w[i - 2] as number) >>> 10)
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number]
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (K[i] as number) + (w[i] as number)) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      hh = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    ;[a, b, c, d, e, f, g, hh].forEach((v, i) => void (h[i] = ((h[i] as number) + v) | 0))
  }
  return h.map(v => (v >>> 0).toString(16).padStart(8, '0')).join('')
}

/**
 * The stand-in bundle's texts for the events the plugin fires at moments it measures or a person causes: it fills the slots, the words are these. A suite that wants other words sets
 * `world.bundle.events[<key>]`, which wins.
 */
const slotted = (event: string, id: number, text: string, slots: string[], mechanism = 'plugin.context') => bundleEvent(event, [text], { id, slots, hookSlots: slots, mechanism })
const PERMISSION_SLOTS = ['permission_code', 'permissions_asked']
export const MOMENT_EVENTS = [
  slotted('disk.maintenance_window', 2000, 'MAINTENANCE WINDOW OPEN since {{slot:window_opened_at}}: {{slot:window_reason}}', ['window_opened_at', 'window_reason']),
  slotted('disk.low', 2010, 'LOW DISK: C: has {{slot:disk_free_amount}} free, under the {{slot:disk_floor_amount}} floor.', ['disk_free_amount', 'disk_floor_amount']),
  slotted('disk.below_hard_minimum', 2020, 'Under the {{slot:disk_hard_minimum_amount}} hard minimum: host test runs refuse.', ['disk_hard_minimum_amount']),
  slotted('checkout.behind', 2030, 'The app is at {{slot:dashboard_version}} and this checkout is at {{slot:checkout_version}}: rebase onto origin/main now.', ['dashboard_version', 'checkout_version']),
  slotted('band.disconnect', 2040, 'The operator disconnected this session from {{slot:left_ref}} "{{slot:left_name}}" with the band. It is still signed in. Do not call session_connect to join a plan or card, and do not write to /api/plans/mine routes, until the operator asks.', ['left_ref', 'left_name']),
  slotted('permission.granted_all', 2050, 'Permission request {{slot:permission_code}} (asked: {{slot:permissions_asked}}) was approved: granted {{slot:permissions_granted}}. Retry the call that was refused.', [...PERMISSION_SLOTS, 'permissions_granted'], 'plugin.prompt'),
  slotted('permission.granted_part', 2060, 'Permission request {{slot:permission_code}} (asked: {{slot:permissions_asked}}) was approved in part: granted {{slot:permissions_granted}}. Not granted: {{slot:permissions_not_granted}}. Retry the call that was refused.', [...PERMISSION_SLOTS, 'permissions_granted', 'permissions_not_granted'], 'plugin.prompt'),
  slotted('permission.granted_none', 2070, 'Permission request {{slot:permission_code}} (asked: {{slot:permissions_asked}}) was approved but granted none of it: do not retry the refused call.', PERMISSION_SLOTS, 'plugin.prompt'),
  slotted('permission.denied', 2080, 'Permission request {{slot:permission_code}} (asked: {{slot:permissions_asked}}) was denied: do not retry the refused call.', PERMISSION_SLOTS, 'plugin.prompt'),
  slotted('session.agent_changed', 2090, 'Your team agent lapsed and this session signed in again as {{slot:agent_name}}. Sign as {{slot:agent_name}} from now on.', ['agent_name'], 'plugin.prompt'),
  slotted('subagent.finished', 2100, 'Finished: {{slot:sub_agent_labels}}.', ['sub_agent_labels']),
]
/** What the stand-in says of an agent change. */
export const agentChangedText = (name: string) => `Your team agent lapsed and this session signed in again as ${name}. Sign as ${name} from now on.`
/** What a finish is told as: the `subagent.finished` text, then the `subagent.stop` text. */
export const finishedAgentsText = (labels: readonly string[], stopText: string) => `Finished: ${labels.join('; ')}.\n\n${stopText}`
/** The bundle event a test sets (`world.bundle.events['session.after_clear']`) so a clear is followed by the cleared briefing: a plain /clear tells nothing in the kit's default bundle. */
export const clearedEvent = () => bundleEvent('session.after_clear', [EVENT_TEXT('after_clear'), CLEARED_TEMPLATE], { id: 1200, slots: BRIEFING_SLOTS })
/** What the plugin reported delivering for one catalog event (`GET`-free: from the recorded `POST behavior-events` bodies); `await d.clock.settle()` first, the reports go out in the background. */
export const deliveredReports = (d: { world: { deliveryReports: { body: any }[] } }, event: string): any[] =>
  d.world.deliveryReports.flatMap(r => r.body.reports as any[]).filter(r => r.kind === 'delivery' && r.event === event)

/** A policy edit in a running session: the text of one old event name changes, the bundle names a new version, and the relay's session file says so (the plugin then reads the bundle again, with no restart). */
export function editEventText(d: { world: any }, name: string, text: string) {
  d.world.eventText[name] = text
  d.world.bundle.version = NEXT_BUNDLE_VERSION
  d.world.files[BUNDLE_FILE_PATH(d.world.sessionId)] = bundleFileText(d.world.sessionId, NEXT_BUNDLE_VERSION)
}

export const HOME_DIR = '/home/u'
export const RECORD_PATH = (sessionId: string) => `${HOME_DIR}/.config/danxbot/plan-sessions/${sessionId}.json`
// CP-43: a session id that is not plain, and the one file every per-session kind would name for it. The runtime resolves `..` before a path reaches the fs hooks, so
// `<kind>/../other.json` arrives as `${HOME_DIR}/.config/danxbot/other.json`: a file a test plants for such an id must sit at this resolved path, or no read could ever find it
export const BAD_SESSION_ID = '../other'
export const BAD_SESSION_ID_PATH = `${HOME_DIR}/.config/danxbot/other.json`
export const DASHBOARD_URL = 'http://localhost:5555'
// `dashboardUrl: NO_DASHBOARD_URL` leaves the field out of the answer (a JSON null is sent as one)
export const NO_DASHBOARD_URL = Symbol('no dashboard_url')
// DX-4423 / DX-4418: what the dashboard MCP (0.1.225, session-access.ts and key-revoked-halt.ts) answers every tool but
// the connect tools while the session holds no key: an error result (the connect tools answer an approval request instead). SIGN_IN_HALT is a session that never signed in, KEY_LAPSED_HALT
// what the first call after a lapsed key's 401 answers (it ends in the sign-in sentence), and KEY_REVOKED_HALT the one stop halt
// for a key a PERSON revoked, which EVERY tool answers, session_connect included, with no access request. These are the server's
// words, for the agent: the plugin must never show them to the person.
// DX-4805: what the engine says when auto mode's classifier gave no verdict on a hook-initiated `$.mcp.call` (the incident's text)
export const CLASSIFIER_REFUSAL = 'The server-side auto mode classifier gave no verdict for mcp__plugin_50arms_platform__plan_events_wait'
export const SIGN_IN_HALT = "Not signed in to the 50 Arms dashboard. Call `session_connect` (with `title`: your session's own title) to request access; the user approves it in their browser, then this tool works."
export const KEY_LAPSED_HALT = `The dashboard no longer accepts this session's key (it lapsed after a day unused), so this session is signed out. ${SIGN_IN_HALT}`
export const REVOKER = 'dana'
export const REVOKED_AT = '2026-10-04T07:00:00.000Z'
export const KEY_REVOKED_HALT = `STOP ALL WORK NOW. ${REVOKER} revoked your access to the 50 Arms dashboard at ${REVOKED_AT}.\n\nCommit your work in progress now (commit what you have; do not run agent-finalize.sh and do not merge). Then end this session: tell the person what you committed and stop.\n\nDo not call session_connect or any other 50 Arms dashboard tool again, do not request access again and do not look for another route.`
// DX-5549: the MCP agent gate's answer to a dashboard call while the session holds no team agent: the sign-in's own block, as JSON
export const AGENT_GATE_HALT = (state: 'agent_needed' | 'agent_limit_reached') =>
  state === 'agent_needed'
    ? { state, instruction: 'You have no team agent to sign in as: none is free for this person. Propose one yourself.' }
    : { state, cap: 'member', limit: 1, held: 1, raised_by: 'a team owner or admin', instruction: 'No team agent is free. Tell the person.' }
export const APPROVAL_URL = 'http://localhost:5555/connect/abc123'
export const CONFIRM_CODE = 'WXYZ2345'
// the approval request session_connect answers while signed out, and what its next calls answer meanwhile (instruction text as the server words it)
export const APPROVAL_REQUIRED = { state: 'approval_required', approvalUrl: APPROVAL_URL, confirmCode: CONFIRM_CODE, expiresAt: '2026-10-03T08:10:00.000Z', instruction: 'Show the user the confirm code and open the approval URL in their browser; they check the code matches and approve. Then call `session_connect` again: it waits up to about 45 seconds for the approval.' }
export const REGISTRATION_URL = 'http://localhost:5555/register/xyz789'
export const CLAIM_CODE = 'CLAIM123'
// what session_connect answers an unregistered machine (the first call: required; the calls after it, while the registration is open: pending)
export const MACHINE_REQUIRED = { state: 'machine_registration_required', registrationUrl: REGISTRATION_URL, claimCode: CLAIM_CODE, instruction: 'Tell the user to open the registration URL and check the claim code.' }
export const MACHINE_PENDING = { ...MACHINE_REQUIRED, state: 'machine_registration_pending' }
export const APPROVAL_PENDING = { ...APPROVAL_REQUIRED, state: 'approval_pending', instruction: 'Still waiting for the user to approve. Remind them of the confirm code and the URL, then call `session_connect` again.' }

// the connected plan's counts: 4 / (3 + 5 + 1 + 3 + 4) = 25%; Cancelled (2) is not counted
export const DEFAULT_BREAKDOWN = { 'In Progress': 3, ToDo: 5, Backlog: 1, Review: 3, Done: 4, Cancelled: 2 }
// the dashboard's id of the session under test: its own row's `session_id`, and `session.sessionId` in a connect's answer
export const SESSION_ID = '41365fb5-6b43-443b-a01b-81245574f648'
const reply = (body: unknown, status = 200) => text({ ok: status < 400, status, body })

// DX-4458: the host refuses a tool result past its size limit, with a notice written for the model (captured 2026-10-04 from the
// session on DX-4443). The fixture's limit is lower than the real one so a fixture card can pass it.
export const HOST_LIMIT_CHARS = 60_000
export const HOST_OVERSIZE = (chars: number) => `Error: result (${chars.toLocaleString('en-US')} characters across 2,050 lines) exceeds maximum allowed tokens. Output has been saved to C:\tool-results\mcp-platform-50arms_api-1.txt
Format: JSON
Use offset and limit parameters to read specific portions of the file.`
function hostLimited(result: { content: { text: string }[]; isError: boolean }) {
  const chars = result.content[0].text.includes('"oversize":true') ? HOST_LIMIT_CHARS + 1 : result.content[0].text.length
  return chars > HOST_LIMIT_CHARS ? { content: [{ type: 'text', text: HOST_OVERSIZE(chars) }], isError: true } : result
}

// DX-3: 49 open questions on one card.
export function bigCard(): Card {
  return {
    id: 'DX-3',
    title: 'Big card',
    priority: 1,
    problems: Array.from({ length: 49 }, (_, i) => ({
      id: 300 + i,
      type: 'question' as const,
      statement: `Question ${i}?`,
      open: true,
    })),
  }
}

// The seven states the server answers for `sessionListenerAttached.state` (50 Arms src/issues/plan-session-listeners.ts
// ListenerHealthState). The fixture's next step for a state other than `healthy` is `NEXT_STEP(state)`.
export const LISTENER_STATES = ['unattached', 'stopped', 'reconnecting', 'credential_mismatch', 'plan_has_no_cards', 'inventory_unavailable', 'healthy'] as const
// The next step never contains the state's name, so a test that finds the state name cannot be satisfied by it.
export const NEXT_STEP = (state: string) => `Run session_connect again (step ${[...state].reduce((n, c) => n + c.charCodeAt(0), 0)}).`

export const CLOCK_START = Date.parse('2026-10-03T08:00:00.000Z')
export const OWN_SESSION = { session_id: 'sess-own', title: 'PLAN-23: 50 Arms plugin' }
// the engine's session id after the session under test is cleared once (its MCP server keeps SESSION_ID)
export const CLEARED_SESSION_ID = `${OWN_SESSION.session_id}-cleared-1`

// what answers the two engine events beneath the plugin when a /clear runs (claude.exe 2.1.317: see wipeState)
export const answerEngineClear = (on: any) => {
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
  on('classic.SessionStart', () => ({}) as any)
}

// a /clear as the engine runs it: the conversation ends, $.state is emptied, the next conversation starts under a new id
export const engineClears = async ($: any, d: any) => {
  await $.session.end({ reason: 'clear', sessionId: d.world.sessionId } as any)
  d.wipeState()
  d.world.sessionId = CLEARED_SESSION_ID
  await $.classic.SessionStart({ source: 'clear', cwd: '/work', session_id: CLEARED_SESSION_ID, transcript_path: '/work/cleared.jsonl' })
  await d.clock.settle()
}
export const OTHER_SESSION = { session_id: 'sess-other', title: 'PLAN-23: review pass' }
type Prob = { id: number; type: 'question' | 'action'; statement: string; open: boolean }
type Card = { id: string; title: string; priority: number; problems: Prob[] }

// DX-4448: the plan's every card id (all statuses, two boards): the fixture's own cards plus DX-30 (ToDo), DX-31 (Done) and SG-7 (gpt-manager)
const PLAN_CARD_IDS = ['DX-1', 'DX-2', 'DX-9', 'DX-30', 'DX-31', 'SG-7']

export type Dashboard = ReturnType<typeof dashboard>

// The fixture: two cards in priority order. DX-1 holds a question and an action; DX-2 holds one question.
export function dashboard(
  on: On,
  options: {
    connected?: boolean
    // DX-4420: PLAN-23's name, to try a name longer than the band
    planName?: string
    // `dashboard_url` on GET /api/plan-sessions/me: the default DASHBOARD_URL, an override (any value, so a bad one can
    // be tried), or NO_DASHBOARD_URL for an answer without the field
    dashboardUrl?: unknown
    // 'down': the engine's own "no such server" rejection; 'flaky': any other rejection
    mcp?: 'up' | 'down' | 'flaky' | 'refused' | 'strictKeys' | 'beforeReplyToFile'
    // the dashboard MCP servers this session really has (default: the plugin's own, the name an operator session has). A dispatched agent's clean-room
    // config names its server `platform` and loads no plugin server (`--strict-mcp-config`); a call to a name the session lacks is the engine's "no such server"
    servers?: string[]
    // `sessionListenerAttached` on GET /api/plan-sessions/me: a state (any string, so an unknown one can be tried; default
    // healthy, nextStep null) or null (the session has no listener row). A session on no plan always gets null,
    // as readCallerSessionOverlay does.
    listener?: string | null
    // ... and its `attached` flag when it should NOT follow the state (default: attached only when healthy)
    attached?: boolean
    // ... or the raw `sessionListenerAttached` value as sent, whatever its shape (overrides the two above)
    rawListener?: unknown
    // CP-43: the session's MCP relay is older than the clear handshake from its start (world.olderRelay)
    olderRelay?: boolean
    // the connected plan's status counts: the default, an override, or none at all
    breakdown?: Record<string, unknown>
    noBreakdown?: boolean
    // the in-progress bucket: how many cards it has, whether its call fails or answers no total, and whether the card has an agent
    inProgressTotal?: number
    inProgressFails?: boolean
    noInProgressTotal?: boolean
    // session_connect {disconnect: true}: the leave works (default), or the server refuses it a given way
    // ('rejected' is a THROWN call, the only error result; 'noLeftPlan' is a 200 without leftPlan)
    disconnect?: 'ok' | 'mismatch' | 'notConnected' | 'notFound' | 'rejected' | 'noLeftPlan'
    // the disconnect call takes this long on the fake clock
    disconnectTakesMs?: number
    sessionReadFails?: boolean
    // DX-4423: the session holds no dashboard key: every 50arms_api call is the MCP's error result (the first call after a revoke
    // answers KEY_LAPSED_HALT, a session that never signed in SIGN_IN_HALT; 'revoked' answers KEY_REVOKED_HALT to every tool and never asks) and the connect tools run the request-and-approve dance
    // (world.signIn): approval_required, then approval_pending after `waitMs` on the fake clock, until a test sets `approved`
    // (then the key is stored: the tools work again and session_connect connects to the plan it is given) or `answer`
    signedOut?: 'signed-out' | 'lapsed' | 'revoked'
    // CP-88: the machine has no registration yet
    unregistered?: boolean
    // session_connect refuses (ok: false, 409 plan_archived) / throws
    connectFails?: boolean
    connectThrows?: boolean
    // the first /api/plan-sessions/me call never settles until `release()`
    hangFirstLoad?: boolean
    // DX-5933: the plan read (GET /api/plans/:id) answers no bucket_counts
    planFieldsShape?: 'noNeedsYou'
    // ... and a plan holding this many more cards than the fixture's own (a large plan: 150 would have passed the host's limit with whole card rows)
    extraPlanCards?: number
    // DX-4458: DX-3, a needs-you card with 49 open problems (DX-4443's shape)
    bigCard?: boolean
    // DX-4458: GET /api/issues/<id> answers 500 for this card
    cardFails?: string | string[]
    // DX-4458: ... and the host refuses that card's answer as too large
    cardOversize?: string
    // DX-4336: the session's account uuid (CLAUDE_CODE_ACCOUNT_UUID, set only by a desktop-hosted session); none by default
    accountUuid?: string
    // DX-4806: the process's CLAUDE_CODE_ENTRYPOINT ('claude-desktop' for the desktop app, 'cli' for a terminal); none by default
    entrypoint?: string
    // Further process environment variables the session starts with (the Windows or WSL markers the disk notice reads)
    env?: Record<string, string>
    // DX-5217: CLAUDE_CODE_AUTO_COMPACT_WINDOW as the session's process starts with it (an older plugin version set it to the floor)
    autoCompactWindow?: string
    // DX-5231: a CLAUDE_AUTOCOMPACT_PCT_OVERRIDE an older plugin version left in the process
    autocompactPct?: string
    // DX-5365: what `$.session.version()` answers: the engine's `base` release (default 2.1.298, one under the floor that runs `session.compact` per agent), no `base` at all, or a call that throws
    engineVersion?: { base: string | undefined } | 'throws'
    // DX-5231: the reason the host refuses the plugin's own `/compact` run with (a handler that throws)
    compactRunFails?: string
    // ... what the usage route answers a report with: accepted (default), the dashboard's refusal of a session on no plan (409), a server
    // error (500) or an answer that names no usable cadence
    usageReply?: 'ok' | 'notConnected' | 'boom' | 'noCadence'
    // ... and the cadence it asks for (`report_every_ms`; default 60 s, 50 Arms' own)
    usageEveryMs?: number
    // ... or `$.session.usage()` rejecting with this reason (a host that has no usage reading)
    usageReadFails?: string
    // DX-4340: what GET /api/pacing/line answers (the session's pacing verdict and line): a body (any shape) or an error status; the dashboard's 404 (unrouted) by default
    pacingLine?: { body: unknown } | { status: number }
    // the board's plan-design review grade the gate instruction route answers (model and effort; opus at high by default), or an error status
    designerGrade?: { model: unknown; effort: unknown } | { status: number }
    // the plugin's agent folder cannot be listed
    agentListFails?: boolean
    // DX-4631: each pacing line read answers only after this long on the harness clock (a slow or hung dashboard); the read is counted when it starts
    pacingHoldMs?: number
    // DX-5593 (C1): what DELETE /api/pacing/agents/claim (the claim given back) answers instead of the real release: an error status, or any body (a 200)
    claimRelease?: { status: number } | { body: unknown }
    // DX-4952: the test puts steps before reads of $.state (`beforeNextRead`), which needs the `state.get` hook from the start
    stateSteps?: boolean
  } = {},
) {
  // DX-4952: the machine asleep. A suspend moves the wall clock (`clock.now`, Date.now) on while no timer runs, which is what a relative
  // setTimeout does across a sleep (the engine's `clock.after` is one): `d.suspend(ms)` moves only what `$.clock.now()` reads, no wait resolves.
  // A hook name registers once, so the kit's own `clock.now` answer is wrapped as mock.clock registers it.
  let asleepMs = 0
  const clockOn = ((event: string, ...rest: any[]) => {
    if (event !== 'clock.now') return (on as any)(event, ...rest)
    const answer = rest.pop()
    return (on as any)(event, ...rest, async (...args: any[]) => {
      const r = await answer(...args)
      return typeof r === 'number' ? r + asleepMs : { ...r, value: r.value + asleepMs }
    })
  }) as typeof on
  // the fake clock starts at 2026-10-03T08:00:00Z, so an `updatedAt` reads as a real age
  const clock = mock.clock(clockOn, { now: Date.parse('2026-10-03T08:00:00.000Z') })
  // DX-4586: a call that never settles (hangFirstLoad) waits on this, not on an hour of fake clock: advancing an hour fires every
  // timer in it (a poll a minute, a report a minute), real time that times a test out under machine load. `release()` lets it answer.
  const hung = (() => { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } })()
  // DX-3900: the surfaces the session draws on, as `$.session.surfaces()` reads them: terminal first under the REPL, then each client in the
  // order it attached. startSession fills it the way the engine does (the desktop app joins AFTER session.start, by session.attach).
  const roster: string[] = []
  on('session.surfaces', () => ({ value: [...roster] }) as any)
  on('session.attach', (_$: any, e: any) => ({ clientId: e.clientId }) as any)
  on('session.detach', (_$: any, e: any) => ({ clientId: e.clientId }) as any)
  const calls: { server: string; tool: string; args: any }[] = []
  const api: { method: string; path: string; body?: any; query?: any }[] = []
  const toasts: string[] = []
  // DX-5365: how many times the plugin asked the engine for its version
  let versionReads = 0
  const toastTimeouts: number[] = []
  const statuses: (string | undefined)[] = []
  const stateWrites: { plugin: string; key: string; value: unknown }[] = []
  const commands: string[] = []
  // DX-5231: the arguments of each `/compact` the plugin ran itself
  const compactRuns: unknown[] = []
  const world = {
    // CP-43: the session's ready mark, every repo a PUT named, how many DELETEs came, a scripted answer to the repo list, the team's repos (GET /api/repos with github_remote),
    // the status a card read answers, what the plan read adds to its answer, and what the /clear command does
    readyMark: null as string | null,
    loseAgentAtMark: false,
    agentClaim: null as object | null,
    readyMarks: [] as string[],
    readyCleared: 0,
    // what happens between the session's look and its mark: the card it took, a hold of the write
    cardAtMark: null as { id: string; title: string } | null,
    markHold: null as Promise<void> | null,
    // a hold of the ready DELETE, so a person's leave of the list can be slower than the loop's own leave
    readyClearHold: null as Promise<void> | null,
    // the agent the next plan-less claim hands out, when not the one it held
    agentNext: null as { id: number; name: string; avatar_url: null } | null,
    // how many claims went through `session_connect`; a leave that throws in the engine; what refuses the mark; what holds the plan read and the card read
    leaveDeny: null as string | null,
    markRefusal: null as { status: number; body: any } | null,
    planReadHold: null as Promise<void> | null,
    cardReadHold: null as Promise<void> | null,
    // what the plan leave answers instead, as the MCP's tool result; what holds `request_permission` on its way
    planLeaveAnswer: null as { text: string; isError: boolean } | null,
    permissionAskHold: null as Promise<void> | null,
    // a `request_permission` that throws in the engine (a classifier refusal, say), after its hold
    permissionAskDeny: null as string | null,
    // what `request_permission` answers instead of an approval request, and how many were asked
    permissionAskRefused: null as string | null,
    permissionAsks: 0,
    claimsByConnect: 0,
    reposAnswer: null as { status: number; body: any } | null,
    repos: [] as { name: string; github_remote: { owner: string; repo: string } | null }[],
    cardStatus: {} as Record<string, string>,
    // card id -> the acceptance-criteria counts GET /api/issues/<id> answers when `fields` names them (none seeded: a card with no criteria),
    // or any object to answer as is; and a switch that makes that read answer 500
    cardAc: {} as Record<string, Record<string, unknown>>,
    cardAcFails: false,
    planRead: {} as Record<string, unknown>,
    clearFails: undefined as string | undefined,
    // a /clear that answers but changes nothing
    clearDoesNothing: false,
    // a test can hold the reset's /clear (it waits for the session to be idle, and then runs) and act meanwhile; `clearsStarted` counts the /clears begun, held or not
    clearHold: null as Promise<void> | null,
    clearsStarted: 0,
    // one-shot holds: the next 50arms_api call of that method and path, and the next `$.process.run` of that command line, waits on `hold`; and what holds the plan leave on its way
    // `early`: the answer is made when the call arrives and held on its way back, so it says what the dashboard held then
    apiHolds: [] as { method: string; path: string; hold: Promise<void>; early?: boolean }[],
    processHolds: [] as { command: string; hold: Promise<void> }[],
    planLeaveHold: null as Promise<void> | null,
    // every step of a job's end, in the order the plugin took it: `leave <card>`, `clear`, and `mark <repo>` for a mark the dashboard took (a /compact the plugin ran shows here too, as `compact`)
    readySteps: [] as string[],
    // the session id the engine answers: another one after a /clear or a resume
    sessionId: OWN_SESSION.session_id,
    // CP-43 / DX-6692: the server's ready loop as `GET /api/plan-sessions/me` answers it (`ready_loop`), and whether the session agreed to clear (`POST /api/plan-sessions/me/clear-ready`), which lets the
    // rejoin's `PUT /api/plan-sessions/me/ready` leave the ended job the session still holds
    readyLoop: null as { repo: string; job: { kind: 'card'; id: string } | { kind: 'plan'; id: number } | null; ended: boolean } | null,
    clearAgreed: false,
    // CP-55: the release 50 Arms stands behind (`ready_loop.release_id`); the answers name it only while the job has ended
    releaseId: null as string | null,
    // DX-4400: the 50arms_api paths whose answer the MCP sends as `reply_file`, with the body written whole to a local file (a call that asks for one, `reply_to_file`, gets it whatever its path; an answer over the MCP's 40,000-character inline limit comes as one too)
    replyFilePaths: [] as string[],
    // the reply file is gone before the plugin reads it (a cleaned temp folder, say)
    replyFileLost: false,
    // the session's MCP relay is older than the clear handshake (0.1.426 or older): it writes no clear file. A current one writes it at every stream connect, nothing released included
    olderRelay: options.olderRelay === true,
    // every file path the plugin read, in order
    fsReads: [] as string[],
    // every file path the plugin checked for existence, in order
    fsExists: [] as string[],
    // CP-43: runs after each existence check is answered, so a test can land a write between two checks of one look
    afterExists: undefined as ((path: string) => void) | undefined,
    listener: (options.listener === undefined ? 'healthy' : options.listener) as string | null,
    inProgress: [{ id: 'DX-9', title: 'In flight card' }] as { id: string; title: string }[],
    planId: options.connected === false ? (null as number | null) : 23,
    // DX-5554: the team agent the session signs in as (GET /api/plan-sessions/me `session.agent`), and the stand-alone card it holds instead of a plan
    // (`session.card_id` / `card_title`); neither by default. A session with none of a plan, a card and an agent has no session row (`session: null`).
    agent: null as { id: number; name: string; avatar_url: string | null } | null,
    card: null as { id: string; title: string } | null,
    // CP-149: the session holds a queued job (its plan_sessions row exists with no plan and no card)
    holdsQueuedJob: false,
    // what DELETE /api/plan-sessions/me/card (the band's leave of a held card) answers: the leave works (default), a 500, or a 200 that names no card left
    cardLeave: 'ok' as 'ok' | 'boom' | 'noLeftCard',
    // the order the band's leaves and Revoke ran in: `plan`, `card`, `person-disconnect`, `release` of the team agent
    leaveOrder: [] as string[],
    // DX-5554: what DELETE /api/plan-sessions/me/agent (the release at session exit) answers: `{released}` by default (true while an agent is held), an
    // error status, the engine's refusal (`deny`), or an answer that comes only after `delayMs` on the harness clock / never (`hangs`)
    release: {} as { status?: number; deny?: string; delayMs?: number; hangs?: boolean },
    // DX-5549 / DX-5554: the MCP's agent gate. After a session_connect answered that no team agent is free, every 50arms_api call but the two
    // proposal routes answers that same block (AGENT_GATE_HALT) as an error result, until a session_connect holds an agent
    agentGate: null as 'agent_needed' | 'agent_limit_reached' | 'agent_not_held' | null,
    // DX-4234: the context reads never answer (a hung dashboard), or answer after this many ms of the fake clock
    contextHangs: false,
    contextDelayMs: 0,
    // DX-3421: GET /api/plan-sessions/me (the session-plan read) answers this status (a dashboard fault) instead of the session
    sessionReadStatus: undefined as number | undefined,
    // DX-4234: whether the engine has bound the session. A desktop or headless startup, resume and fork run their SessionStart hook BEFORE it
    // binds (claude.exe: the session holder is empty until the session is built), where `$.mcp.call` and `$.tool.list` throw; `unbind()` /
    // `bind()` model that. Every kit session is bound unless a test unbinds it.
    bound: true,
    plansBody: undefined as unknown,
    // DX-5093: the desktop's Browser pane server (`Claude_Browser`) as the plan-tab keepalive reaches it: whether the session has the server, whether the
    // pane is open, the origins of its tabs, the failures of each tool (the text of an `isError` answer), how long `tabs_context` takes, and the calls made
    // (`tabs_context`, `tabs_create`, `navigate <url> <tabId|->`). Default: the pane holds a tab on the dashboard's site, so a look changes nothing.
    browser: {
      present: true,
      open: true,
      tabs: [new URL(DASHBOARD_URL).origin] as string[],
      errors: {} as Partial<Record<'tabs_context' | 'tabs_create' | 'navigate', string>>,
      rejects: undefined as string | undefined,
      // `tabs_create` hands back a tab that already existed
      reuses: false,
      delayMs: 0,
      calls: [] as string[],
    },
    // the desktop app's session server (`ccd_session_mgmt`) as the title mark reaches it: the app's title of this session and each title the
    // plugin set, in order
    // `afterRead`: one function per get_session, in order, run right after that read answered (the app is renamed between a reader's read and its write, as a model's set_session_title does)
    appSession: { title: 'Tendai: PLAN-23 Agent mode', set: [] as string[], reads: 0, afterRead: [] as (() => void)[], failSet: undefined as string | undefined, setDelayMs: 0 },
    // CP-169: the desktop app's connectors server (`ccd_connectors`): each `reconnect_session_connector` call's `server`, in order; `absent` is a session with no such server (a dispatched agent, a command-line session)
    connectors: { reconnects: [] as string[], absent: false },
    // DX-4233: the plugin server's tools the session lists (see toolListAnswer)
    tools: 'full' as 'full' | 'old' | 'none',
    // DX-4234: the engine's file-exists check rejects with this text (a disk fault), when set
    fsError: undefined as string | undefined,
    // DX-4234: other sessions that hold a connection record on disk (a session a /clear ended that was on a plan)
    records: [] as string[],
    // DX-4234: whether this session has a connection record on disk (a connected session does; a signed-out or unconnected one does not)
    localRecord: options.connected !== false,
    // DX-4234: what GET /api/reminders/event/<event> answers: the default EVENT_TEXT(event), a text, or a status
    eventText: {} as Record<string, string>,
    // CP-146: the policy bundle the stand-in serves: its version, the lowest plugin version it accepts, the version of the floor lines the team holds, the events a test adds or replaces by catalog key,
    // and a whole-answer override (an error status with its body). a bundle has no per-event failure: a failed read is `bundle.override`.
    bundle: { version: BUNDLE_VERSION, minPlugin: '0.17.0', floorVersion: null as string | null, events: {} as Record<string, ReturnType<typeof bundleEvent>>, override: undefined as undefined | { status: number; body?: unknown } },
    pluginVersion: PLUGIN_VERSION,
    // CP-146: what the plugin read and sent: each bundle read's query, each POST /api/plan-sessions/me/behavior-events body (`{reports: [...]}`), each PUT /api/plan-sessions/me/plugin-floor body
    bundleReads: [] as { plugin_version?: string; known_version?: string }[],
    deliveryReports: [] as { body: any }[],
    // DX-8225: what the requested-endpoints read answers as its `computed` (null: the session read no spec), each read's query and whether it asked for a file, and a whole-answer override
    requestedEndpoints: null as unknown,
    requestedEndpointReads: [] as { plugin_version?: string; reply_to_file?: boolean }[],
    requestedEndpointsOverride: undefined as undefined | { status: number; body?: unknown },
    // CP-166: what the role read (`GET /api/plan-sessions/me/role`) answers as its `computed` (null: a session on neither a plan nor a card), each read's query and whether it asked for a file, and a whole-answer override
    role: null as unknown,
    roleReads: [] as { plugin_version?: string; reply_to_file?: boolean }[],
    roleOverride: undefined as undefined | { status: number; body?: unknown },
    // DX-8226: the stand-in MCP answers a `reply_to_file` call inline instead of with the file form (a broken MCP), or names a sha256 that is not the file's
    inlineReplies: false,
    // the paths the stand-in MCP answered with the file form, in order; and whether the machine refuses the plugin's write of an over-cap text's carrier file
    repliedAsFile: [] as string[],
    carrierWriteFails: false,
    // only the carrier files whose path holds this text (an event's name) cannot be written
    carrierWriteFailsFor: null as string | null,
    replySha256: undefined as string | undefined,
    floorSends: [] as { body: any }[],
    // DX-4234: what the server's `restart_notice` tool answers (DX-4632): `{notice: null}` unless a test sets a JSON answer (`json`), a raw
    // result (`raw`), or a rejection (`deny`). `delayMs` / `hangs`: it answers late / never.
    restart: {} as { json?: unknown; raw?: unknown; deny?: string; delayMs?: number; hangs?: boolean },
    // DX-4508: this session's sub-agents as `$.agent.list()` answers them (the engine's own list), none by default
    agents: [] as { id: string; type: string; description: string; status: string; parentId?: string }[],
    titleSeen: undefined as string | undefined,
    // DX-4235: the boards GET /api/plans/mine names for the session's plan, each board's ToDo card rows as GET /api/issues answers them
    // (the ready-cards check), and a per-route override of a report or ready-cards answer (`<METHOD> <path>`): an error status (with
    // its body), the engine's refusal (`deny`), or an answer that comes only after `delayMs` on the harness clock
    planBoards: [7] as number[],
    readyRows: {} as Record<string, unknown[]>,
    // CP-34: the cards GET /api/plans/<id>/connected-session/detail answers as `detail.cards` (each with the `activity` on it now)
    heldRows: [] as unknown[],
    // DX-4997: what GET /api/plan-sessions/me/pause answers as `pause` (null, an agent pause, a usage pause)
    pause: null as unknown,
    // DX-5692: what GET /api/plan-sessions/me/owed-comments answers as `owedComments` (the comments the session still owes an answer)
    owedComments: [] as unknown[],
    reportReplies: {} as Record<string, { status?: number; body?: unknown; deny?: string; delayMs?: number }>,
    // DX-4993: the context `$.session.usage()` answers (tokens now, the model's window): none by default, a session before its first response
    context: {} as { tokens?: number; window?: number },
    // DX-4993: files on the fixture's disk by path (the compaction control the relay writes), as `$.fs.exists` / `$.fs.read` see them
    files: {} as Record<string, string>,
    // DX-4993: what `git status --porcelain=v1 -b` prints in the session's directory (the resume briefing), or its exit code when it fails
    gitStatus: { exitCode: 0, stdout: '## main...origin/main\n' } as { exitCode: number; stdout: string },
    // What a `$.process.run` answers by its program (argv[0], for example `df` or `cmd.exe`); a program with no entry answers the git status above
    processes: {} as Record<string, { exitCode?: number; stdout: string; stderr?: string; throws?: string }>,
    // A queued job's take (POST /api/dispatch-queue/<id>/take) answers this by item id (an item with no entry: the 403 a take of an offer this session does not hold gets),
    // and its leave (DELETE, the same path) answers `leaveReply`, by default the route's 200 {id}
    takeReplies: {} as Record<number, { status?: number; body: unknown }>,
    leaveReply: undefined as { status: number; body: unknown } | undefined,
    // DX-4336: the rate-limit windows `$.session.usage()` answers (none by default: a session off a subscription, or before its first response)
    rateLimits: [] as { kind: string; percentUsed: number; resetsAt?: string }[],
    // DX-4423: null while the session holds a key
    signedOut: (options.signedOut ?? null) as 'signed-out' | 'lapsed' | 'revoked' | null,
    signIn: { requested: false, approved: false, waitMs: 45_000, expireAfterCalls: undefined as number | undefined, answer: undefined as { text: string; isError?: boolean; waits?: boolean } | undefined, calls: [] as any[] },
    // CP-88: the machine's registration. Registered by default; `unregistered` opens it. A `registration_only` call is kept out of `calls` (the suites that count the
    // sign-in's session_connect calls stay about their own subject) and recorded here: the first answers required, the next ones wait `waitMs` and answer pending until `registered` is set
    machine: { registered: !options.unregistered, requested: false, waitMs: 45_000, refuse: false as false | 'deny' | 'error', active: 0, maxActive: 0, calls: [] as any[] },
    // DX-4435: what the key's own claim route (POST /api/permission-requests/:publicId/claim) answers: a status, or 'notFound'
    // DX-4686: the key's claim route answers only after this long on the harness clock (a step after the plan load that holds the refresh lock)
    permissionClaimDelayMs: 0,
    permissionClaim: 'pending' as 'pending' | 'approved' | 'claimed' | 'denied' | 'expired' | 'notFound' | 'boom',
    // DX-4530: the subset the owner granted, which the claim answers once approved (and on every later, `claimed`, claim)
    permissionGranted: ['team.members.view'] as string[],
    cards: [
      {
        id: 'DX-1',
        title: 'First card',
        priority: 5,
        problems: [
          { id: 11, type: 'question', statement: 'Which route?', open: true },
          { id: 12, type: 'action', statement: 'Allow the site', open: true },
        ],
      },
      {
        id: 'DX-2',
        title: 'Second card',
        priority: 3,
        problems: [{ id: 21, type: 'question', statement: 'Second one?', open: true }],
      },
    ] as Card[],
  }
  if (options.bigCard) world.cards.push(bigCard())
  // CP-55: the ready loop as the server answers it, with the release it stands behind only while the job has ended
  const readyLoopView = () => (world.readyLoop === null ? null : { ...world.readyLoop, release_id: world.readyLoop.ended ? world.releaseId : null })
  // DX-5232: every card of the plan (any status, either board): the fixture's own cards and the others
  const planCardIds = [...new Set([...PLAN_CARD_IDS, ...world.cards.map(c => c.id), ...Array.from({ length: options.extraPlanCards ?? 0 }, (_, i) => `DX-${1000 + i}`)])]
  // the plan's Needs You bucket counts CARDS holding an open problem, on the plan read
  const needsYouCards = () => world.cards.filter(c => c.problems.some(p => p.open)).length
  const plans = [
    { id: 23, ref: 'PLAN-23', name: options.planName ?? '50 Arms plugin', status: 'building', archived_at: null, get bucket_counts() { return { 'needs-you': needsYouCards() } } },
    { id: 24, ref: 'PLAN-24', name: 'Agent mode', status: 'building', archived_at: null, bucket_counts: { 'needs-you': 0 } },
    { id: 25, ref: 'PLAN-25', name: 'Archived', status: 'done', archived_at: 'x', bucket_counts: {} },
  ]

  fixturesOf.set(on, [...(fixturesOf.get(on) ?? []), world])

  function route(method: string, path: string, body: any, query: any) {
    if (method === 'GET' && path === '/api/plan-sessions/me') {
      // DX-4233: GET /api/plan-sessions/me answers this as its body, whatever its shape (a string makes the plugin's session read throw)
      if (world.plansBody !== undefined) return reply(world.plansBody)
      if (world.sessionReadStatus !== undefined) return reply({ error: 'session boom' }, world.sessionReadStatus)
      if (options.sessionReadFails) return reply({ error: 'boom' }, 500)
      return reply({
        // DX-5551 / DX-5553: the session row as the plan_session resource projects it, for any registered session (on a plan, holding a card, or
        // on neither); null only for a session with no row
        session:
          world.planId === null && world.card === null && world.agent === null
            ? null
            : {
                session_id: SESSION_ID,
                plan_id: world.planId,
                plan_name: world.planId === null ? null : (plans.find(p => p.id === world.planId)?.name ?? 'Far plan'),
                card_id: world.card?.id ?? null,
                card_title: world.card?.title ?? null,
                agent: world.agent,
                ready: world.readyMark === null ? null : { repo: world.readyMark, since: '2026-10-03T08:00:00.000Z' },
              },
        // DX-5553: a session holding a card is bound to work and keeps its health, as one on a plan does
        sessionListenerAttached:
          options.rawListener !== undefined
            ? options.rawListener
            : (world.planId === null && world.card === null) || world.listener === null
            ? null
            : { attached: options.attached ?? world.listener === 'healthy', state: world.listener, nextStep: world.listener === 'healthy' ? null : NEXT_STEP(world.listener) },
        // DX-6692: the session's ready loop and whether its job has ended, as the server judges it
        ready_loop: readyLoopView(),
        ...(options.dashboardUrl === NO_DASHBOARD_URL ? {} : { dashboard_url: options.dashboardUrl === undefined ? DASHBOARD_URL : options.dashboardUrl }),
      })
    }
    const planOne = /^\/api\/plans\/(\d+)$/.exec(path)
    if (method === 'GET' && planOne) {
      const p = plans.find(x => x.id === Number(planOne[1]))
      if (!p) return reply({ error: 'nope' }, 404)
      return reply({
        id: p.id,
        ref: p.ref,
        name: p.name,
        status: p.status,
        card_count: planCardIds.length,
        ...(options.noBreakdown ? {} : { status_breakdown: options.breakdown ?? DEFAULT_BREAKDOWN }),
        // as the real route answers: `bucket_counts` always (the needs-you bucket counts CARDS holding an open problem)
        ...(options.planFieldsShape === 'noNeedsYou' ? {} : { bucket_counts: { 'needs-you': needsYouCards() } }),
        ...world.planRead,
      })
    }
    // CP-135: the plan's card-list route answers whole card rows (measured on PLAN-129: about 4.6 KB each, 14 In Progress cards = 64,825 characters), which the
    // host refuses past its limit; the issues list answers the compact row (about 0.5 KB) and takes the plan and status as its filter.
    // CP-135: the In Progress cards come from the issues list (the compact row, about 0.5 KB each), with the plan and status as its filter; the plan's card-list route answers whole rows (about 4.6 KB each: 14 cards went over the host's limit)
    if (method === 'GET' && path === '/api/issues' && query?.filter?.plan_id !== undefined) {
      if (options.inProgressFails) return reply({ error: 'in-progress boom' }, 500)
      return reply({
        issues: world.inProgress.slice(0, query.limit).map(c => ({ id: c.id, type: 'Story', title: c.title, status: 'In Progress', parent_id: null, priority: 4, rev: 1, created_at: 1, updated_at: 1, assigned_agent: null, content_hash: 'h'.repeat(64) })),
        ...(options.noInProgressTotal ? {} : { total: options.inProgressTotal ?? world.inProgress.length }),
      })
    }
    const issue = /^\/api\/issues\/([A-Z]+-\d+)$/.exec(path)
    if (method === 'GET' && issue && [options.cardFails ?? []].flat().includes(issue[1])) return reply({ error: 'boom' }, 500)
    if (method === 'GET' && issue && options.cardOversize === issue[1]) return text({ oversize: true })
    // the held card's progress read (the band's donut): the acceptance-criteria counts the test seeded for the card; none seeded is a card with no criteria
    if (method === 'GET' && issue && query?.fields?.ac_total) {
      if (world.cardAcFails) return reply({ error: 'progress boom' }, 500)
      return reply({ id: issue[1], title: 'x', ...(world.cardAc[issue[1]] ?? { ac_total: 0, ac_done: 0 }) })
    }
    if (method === 'GET' && issue) {
      const c = world.cards.find(x => x.id === issue[1])
      if (!c) return reply({ error: 'nope' }, 404)
      // as the real route answers: scalars always, a relation only when `fields` names it
      return reply({ id: c.id, title: c.title, ...(world.cardStatus[c.id] === undefined ? {} : { status: world.cardStatus[c.id] }), ...(query?.fields?.problems ? { problems: c.problems } : {}), ...(query?.fields?.open_problem_count ? { open_problem_count: c.problems.filter(p => p.open).length } : {}) })
    }
    // DX-4336: the usage route as it answers a report (50 Arms handleUsage's view)
    if (method === 'PUT' && path === '/api/plan-sessions/me/usage') {
      if (options.usageReply === 'boom') return reply({ error: 'usage boom' }, 500)
      if (options.usageReply === 'notConnected') return reply({ error: 'session_not_connected', message: 'This session is not connected to a plan.' }, 409)
      if (options.usageReply === 'noCadence') return reply({ applied: true })
      return reply({ applied: true, report_every_ms: options.usageEveryMs ?? 60_000 })
    }
    if (method === 'POST' && /^\/api\/permission-requests\/[^/]+\/claim$/.test(path)) {
      if (world.permissionClaim === 'notFound') return reply({ error: 'Not found' }, 404)
      if (world.permissionClaim === 'boom') return reply({ error: 'boom' }, 500)
      const decided = world.permissionClaim === 'approved' || world.permissionClaim === 'claimed'
      return reply({ status: world.permissionClaim, granted: decided ? world.permissionGranted : null })
    }
    // CP-43: the ready list (50 Arms DX-6610, plan-sessions-routes handleMarkReady / handleClearReady) and the team's repos
    if (method === 'PUT' && path === '/api/plan-sessions/me/ready') {
      world.readyMarks.push(body.repo)
      if (world.markRefusal !== null) return reply(world.markRefusal.body, world.markRefusal.status)
      // the agent lapses between the session's look and its mark: from here the hold gate refuses every gated route
      if (world.loseAgentAtMark) {
        world.loseAgentAtMark = false
        world.agent = null
        world.agentGate = 'agent_not_held'
        return reply({ error: 'agent_not_held', state: 'agent_not_held', instruction: 'You hold no team agent: call session_connect to claim one.' }, 403)
      }
      if (world.cardAtMark !== null) {
        world.card = world.cardAtMark
        world.cardAtMark = null
      }
      if (!world.repos.some(r => r.name === body.repo)) return reply({ error: 'repo_not_found' }, 404)
      // DX-6692: the rejoin after an agreed clear leaves the ended job the session still holds, as its own leave (the agent is kept), in the same transaction as the mark. DX-6697: decided
      // before anything is written, so a job that reopened (or an agreement emptied) since is no leave: nothing is undone, and the call joins as below
      const heldJob = () => (world.planId !== null ? { kind: 'plan' as const, id: world.planId } : world.card !== null ? { kind: 'card' as const, id: world.card.id } : null)
      const held = heldJob()
      const job = world.readyLoop?.job ?? null
      if (held !== null && world.clearAgreed && world.readyLoop?.ended === true && job?.kind === held.kind && job.id === held.id) {
        world.readySteps.push(`leave ${held.id}`)
        world.planId = null
        world.card = null
      }
      // DX-6697: a session that holds work is marked nothing: it joins the ready loop with that work as its job (a card Done or Cancelled has ended at once), and joining again on the same job
      // and repo changes nothing
      const work = heldJob()
      if (work !== null) {
        const same = world.readyLoop !== null && world.readyLoop.repo === body.repo && world.readyLoop.job?.kind === work.kind && world.readyLoop.job.id === work.id
        if (!same) {
          world.readyLoop = { repo: body.repo, job: work, ended: work.kind === 'card' && ['Done', 'Cancelled'].includes(world.cardStatus[work.id]) }
          world.clearAgreed = false
        }
        // DX-6697 (50 Arms readJoinedReadyLoop): a join on the loop's own job while it has not ended empties the handshake, so a job that reopened after an agreement starts a fresh one
        // instead of riding that agreement into the next rejoin. On an ended job an agreement stays
        if (!world.readyLoop!.ended) world.clearAgreed = false
        world.readySteps.push(`join ${work.id}`)
        return reply({ ready: null, repo: body.repo, since: null, ready_loop: readyLoopView() })
      }
      world.readyMark = body.repo
      // the rejoin ends the handshake: the loop keeps its repo and has no job
      world.clearAgreed = false
      if (world.readyLoop !== null) world.readyLoop = { repo: body.repo, job: null, ended: false }
      world.readySteps.push(`mark ${body.repo}`)
      return reply({ ready: true, repo: body.repo, since: '2026-10-03T08:00:00.000Z', ready_loop: readyLoopView() })
    }
    // the plan-less claim: an open route, so the hold gate lets it through, and a no-agent answer is a 200
    if (method === 'POST' && path === '/api/plan-sessions/me/agent') {
      if (world.agentClaim !== null) return reply(world.agentClaim)
      world.agent = world.agentNext ?? world.agent ?? { id: 6, name: 'Tendai', avatar_url: null }
      world.agentGate = null
      return reply({ state: 'agent_held', agent: world.agent, instruction: 'Use this name.' })
    }
    if (method === 'DELETE' && path === '/api/plan-sessions/me/ready') {
      const cleared = world.readyMark !== null || world.readyLoop !== null
      world.readyMark = null
      // DX-6692: the one way the server's loop ends
      world.readyLoop = null
      world.clearAgreed = false
      world.readyCleared++
      return reply({ cleared })
    }
    // as the real routes answer: the list pages (50 by default), one repo by name is its bare row, and `github_remote` is opt-in on both: a read whose `fields` does not name it gets none
    const repoRow = (r: (typeof world.repos)[number]) => (query?.fields?.github_remote === true ? r : { name: r.name })
    if (method === 'GET' && path === '/api/repos') {
      if (world.reposAnswer !== null) return reply(world.reposAnswer.body, world.reposAnswer.status)
      const from = query?.offset ?? 0
      return reply({ repos: world.repos.slice(from, from + (query?.limit ?? 50)).map(repoRow), total: world.repos.length })
    }
    // a queued job's take and its leave (50 Arms dispatch-queue-routes): as each test scripts them
    const queueTake = /^\/api\/dispatch-queue\/(\d+)\/take$/.exec(path)
    if (method === 'POST' && queueTake) {
      const scripted = world.takeReplies[Number(queueTake[1])]
      return scripted === undefined ? reply({ error: 'dispatch_queue_take_not_offered' }, 403) : reply(scripted.body, scripted.status ?? 200)
    }
    if (method === 'DELETE' && queueTake) return world.leaveReply === undefined ? reply({ id: Number(queueTake[1]) }) : reply(world.leaveReply.body, world.leaveReply.status)
    const repoOne = /^\/api\/repos\/([^/]+)$/.exec(path)
    if (method === 'GET' && repoOne) {
      const row = world.repos.find(r => r.name === repoOne[1])
      return row === undefined ? reply({ error: 'Not found' }, 404) : reply(repoRow(row))
    }
    return reply({ error: `unrouted ${method} ${path}` }, 404)
  }

  // DX-4233: the dashboard server's `plan_events_wait` as the contract words it (50 Arms packages/platform-mcp): answers
  // the records after the call's cursor (those at or below it are dropped; an answer itself is never a drain), or an empty list
  // when `timeout_ms` passes on the fake clock; or {stopped}. A test scripts one-off answers (`script`) and feeds events (`push`).
  const server = {
    calls: [] as { plan_id: number; cursor: string | null; timeout_ms: number; transcript_path?: string }[],
    buffer: [] as { cursor: string; text: string; urgent: boolean; acks: { eventId: number; attempt: number }[]; offer?: unknown }[],
    plan: undefined as number | undefined,
    script: [] as (() => any)[],
    stopped: undefined as { reason: string; detail: string; fix: string } | undefined,
    wake: null as (() => void) | null,
    // a call that finds nothing waits until an event is pushed and never on the fake clock, so a test that moves the clock a long way
    // (a 30-minute cache, a sub-agent's life) does not also run a 20 s wait per step. A test of the wait itself sets how long it lasts
    // on the fake clock: the call's own `timeout_ms`, or this many ms.
    holdMs: undefined as number | 'timeout_ms' | undefined,
    // DX-5398: waits in flight now and the most there ever were together (the relay holds exactly one wait loop)
    inFlight: 0,
    maxInFlight: 0,
    dropped: 0,
  }
  async function planEventsWait(args: any) {
    server.inFlight++
    server.maxInFlight = Math.max(server.maxInFlight, server.inFlight)
    try {
      return await planEventsWaitOnce(args)
    } finally {
      server.inFlight--
    }
  }
  async function planEventsWaitOnce(args: any) {
    server.calls.push(args)
    // DX-4993 / DX-6692: the stream's first frames on a connect are the session's compaction control, then its clear control. Every relay the plugin serves writes the compaction file, and
    // only a current one the clear file, each `control: null` while nothing is asked. Neither is written while the stream is not up (`world.listener`)
    if (world.listener === 'healthy') {
      const compactionFile = `${HOME_DIR}/.config/danxbot/compaction/${SESSION_ID}.json`
      if (!(compactionFile in world.files)) world.files[compactionFile] = JSON.stringify({ v: 1, sessionId: SESSION_ID, control: null, askedAt: null })
      const clearFile = `${HOME_DIR}/.config/danxbot/clear/${SESSION_ID}.json`
      if (!world.olderRelay && !(clearFile in world.files)) world.files[clearFile] = JSON.stringify({ v: 1, sessionId: SESSION_ID, control: null, askedAt: null })
    }
    const scripted = server.script.shift()
    if (scripted) return scripted()
    if (server.stopped) return { value: text({ stopped: server.stopped }) }
    // one plan: a call naming another plan than the last starts clean
    if (server.plan !== args.plan_id) server.buffer = []
    server.plan = args.plan_id
    // one cursor, opaque: what follows the record that carries it. An answer is never a drain (records stay until a LATER call presents their cursor), but
    // DX-5398: the real server DROPS every record at or below the cursor a call presents (the cursor acknowledges them), so a record the caller took and has
    // not delivered is gone from the server once the next poll presents its cursor; `dropped` counts them. A cursor the buffer does not hold (one the test
    // seeded) drops nothing and leaves every record
    if (args.cursor !== null) {
      const at = server.buffer.findIndex(r => r.cursor === args.cursor)
      if (at !== -1) {
        server.dropped += at + 1
        server.buffer = server.buffer.slice(at + 1)
      }
    }
    const ready = () => server.buffer
    if (ready().length === 0) {
      const woken = new Promise<void>(resolve => (server.wake = resolve))
      await (server.holdMs === undefined ? woken : Promise.race([clock.sleep(server.holdMs === 'timeout_ms' ? args.timeout_ms : server.holdMs), woken]))
      server.wake = null
    }
    return { value: text({ events: ready() }) }
  }
  // what the plugin handed the session as a prompt (the relayed events only: a test's own prompts are not recorded), and the rows it
  // appended to the conversation with $.session.append (DX-4793: since Claude Code 2.1.293 the kit lets the append through and calls the
  // test's session.append hook with the row; what the live engine then does with the row is proved on a live session)
  const delivered: { text: string }[] = []
  // DX-5093: every prompt the plugin submitted, marked or not (`delivered` holds only the plan-event ones)
  const submitted: string[] = []
  // every prompt submit the plugin made, refused ones too, with the fake-clock time it was made at (a retry is one of these; the outbox tests count them)
  const attempts: { at: number; text: string }[] = []
  const told: string[] = []
  const deliveryFlags = {
    submitDrops: undefined as string | undefined,
    submitRejects: undefined as string | undefined,
    duringPrompt: undefined as undefined | (() => Promise<void>),
    appendRejects: undefined as string | undefined,
    // DX-5398: while set, a prompt submit settles only when this resolves (see relay.holdPrompts)
    promptGate: undefined as undefined | Promise<void>,
    promptsHeld: 0,
  }
  // DX-4793: the row a plugin appends is one user message of text blocks; a test sets appendRejects to make the engine refuse it
  on('session.append', (_$: any, e: any, next: any) => {
    if (deliveryFlags.appendRejects !== undefined) return { deny: deliveryFlags.appendRejects } as any
    told.push(e.message.content.map((block: any) => block.text).join(''))
    return next(e)
  })
  // the engine answers a turn's start with its id
  on('turn.start', () => ({ turnId: 't1' }) as any)
  on('prompt.submit', async (_$: any, e: any) => {
    attempts.push({ at: clock.now(), text: e.text })
    await deliveryFlags.duringPrompt?.()
    // DX-5398: the engine (claude.exe 2.1.299) settles a plugin's `$.prompt.submit` only when the queued prompt ENTERS the session, which behind a
    // running turn is when the turn ends. The prompt is then recorded as submitted at that moment, not at the call.
    const gate = deliveryFlags.promptGate
    if (gate !== undefined) {
      deliveryFlags.promptsHeld++
      try {
        await gate
      } finally {
        deliveryFlags.promptsHeld--
      }
    }
    if (deliveryFlags.submitRejects !== undefined) throw new Error(deliveryFlags.submitRejects)
    if (deliveryFlags.submitDrops !== undefined) return { drop: deliveryFlags.submitDrops } as any
    submitted.push(e.text)
    if (e.text.startsWith(RELAY_MARKER)) delivered.push({ text: e.text })
    // core answers the context it was given beside the text
    return { text: e.text, context: e.context } as any
  })

  // DX-4340: the pacing line is read by every session at start and by each spawn: kept out of `calls` and `api` so the suites that count a
  // load's reads stay about their own subject, and answered unknown (pacing off) unless a test gives `pacingLine`
  // DX-4234: the engine's own refusal of an engine call made before the session is bound (claude.exe 2.1.286, the `Yu()` guard), and the calls
  // that hit it: a test asserts a hook made none
  const unboundCalls: string[] = []
  const unboundCall = (call: string) => {
    unboundCalls.push(call)
    return { deny: `${call} is not available in this mode: no session is bound in this process (the REPL has not mounted and no headless session is built); catch it and carry on` } as any
  }
  const notConnected = () => options.mcp === 'down'
  const sessionServers = () => options.servers ?? [SERVER]
  // every dashboard server name a hook called, whichever the session has
  const serversCalled = new Set<string>()
  const pacingReads: number[] = []
  // DX-5593: the spawn claim (POST /api/pacing/agents/claim) and its give-back (DELETE ...?claim_id=): every attempt, the ids 50 Arms allowed, the ids given back
  const claimAttempts = { n: 0 }
  const designerGradeReads: string[] = []
  const claimsAllowed: string[] = []
  const claimsReleased: string[] = []
  // DX-5593 (N2): the body of every claim POST, to see what reading it carried
  const claimBodies: any[] = []
  const heldClaims = new Set<string>()
  // DX-4234: the paths of the context reads (see isContextRead), in order
  const contextReads: string[] = []
  // DX-4632: the arguments of each `restart_notice` call
  const restartCalls: unknown[] = []
  // DX-5554: each release of the session's team agent (DELETE /api/plan-sessions/me/agent), kept out of `calls` and `api` like the context reads
  const releaseCalls: { method: string; path: string; background: unknown }[] = []
  // CP-89: each call of the band's Revoke route (POST /api/plan-sessions/me/person-disconnect), kept out of `calls` and `api` like the release
  const personDisconnects: { method: string; path: string; background: unknown }[] = []
  // DX-4997 / DX-5033: the dashboard's rule for the agent pause. A `50arms_api` call marked `background: true` (the plugin's own work) never ends it;
  // an unmarked one (the agent's own call) does, except the route that manages the pause itself.
  const serverPauseRule = (args: any) => {
    const managesPause = args.path === '/api/plan-sessions/me/pause'
    if (!managesPause && args.background !== true && (world.pause as { limit?: string } | null)?.limit === 'agent') world.pause = null
  }
  // DX-4997: every 50arms_api call the plugin made WITHOUT `background: true` (there must be none)
  const unmarked: string[] = []
  // DX-5062: the calls an MCP in `strictKeys` mode (one older than the DX-5033 release) refused for carrying `background`
  const backgroundRefusals: string[] = []
  const replyToFileRefusals: string[] = []
  // DX-4235: the fields every GET /api/issues row carries without being asked for (the issue resource's compact row)
  const ISSUE_ROW_FIELDS = ['id', 'type', 'title', 'status', 'parent_id', 'priority', 'created_at', 'updated_at', 'assigned_agent', 'content_hash']
  // DX-4235: the reports' calls and the ready-cards reads, in order, kept out of `calls` and `api` like the context reads (every suite that
  // counts a load's reads or a session's writes stays about its own subject)
  const reportCalls: { method: string; path: string; body?: any; query?: any; board?: string }[] = []
  // DX-5694: the turn activity sends, in order
  const turnActivityCalls: { activity: string; since: string }[] = []
  // DX-4235: the report calls and the plugin server's tool calls in the order they were made (`report <METHOD> <path>`, `tool <name>`)
  const sequence: string[] = []
  const isReportCall = (a: any) =>
    (a.method === 'POST' && a.path === '/api/plan-sessions/me/activity') ||
    (a.method === 'GET' && (a.path === '/api/plans/mine' || (a.path === '/api/issues' && a.board !== undefined) || a.path === '/api/plan-sessions/me/pause' || a.path === '/api/plan-sessions/me/owed-comments' || /^\/api\/plans\/\d+\/connected-session\/detail$/.test(a.path)))
  // ... answered as the real routes answer them (50 Arms plan-sessions-routes, plans/mine, the issues list)
  function reportAnswer(a: any) {
    if (a.path === '/api/plan-sessions/me/activity') return reply({ runningActivities: 1 })
    if (a.path === '/api/plan-sessions/me/pause') return reply({ pause: world.pause })
    if (/\/connected-session\/detail$/.test(a.path)) return reply({ detail: { cards: world.heldRows } })
    if (a.path === '/api/plan-sessions/me/owed-comments') return reply({ owedComments: world.owedComments })
    if (a.path === '/api/plans/mine') return world.planId === null ? reply({ error: 'session_not_connected' }, 409) : reply({ id: world.planId, boards: world.planBoards })
    // as the issues list answers: the always-returned row, plus only the fields the `fields` tree names
    const rows = (world.readyRows[a.board] ?? []).map((row: any) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => ISSUE_ROW_FIELDS.includes(key) || a.query?.fields?.[key] === true)),
    )
    return reply({ issues: rows, total: rows.length })
  }
  const isContextRead = (a: any) => a.method === 'GET' && a.path === '/api/behavior-events/bundle'
  // the bundle: one attachment per old registry event (its text a test may set), the events a test adds or replaces by catalog key, `{version, unchanged: true}` for the known version, and a 426 below the floor
  function contextAnswer(a: any) {
    const query = a.query ?? {}
    world.bundleReads.push({ plugin_version: query.plugin_version, known_version: query.known_version })
    if (world.bundle.override !== undefined) return reply(world.bundle.override.body ?? { error: 'bundle boom' }, world.bundle.override.status)
    if (typeof query.plugin_version === 'string' && query.plugin_version.localeCompare(world.bundle.minPlugin, undefined, { numeric: true }) < 0) return reply({ error: 'mcp_outdated', plugin: { have: query.plugin_version, need: world.bundle.minPlugin } }, 426)
    if (query.known_version === world.bundle.version) return reply({ version: world.bundle.version, unchanged: true, floor_lines_plugin_version: world.bundle.floorVersion })
    const names = Object.keys(BUNDLE_EVENT_KEY)
    // a session on a plan is followed by the briefing after a compaction, and its sub-agent by the sub-agent's own: the bundle is rendered for the session, and a session on no plan carries neither
    const named = names.map(name => {
      const given = world.eventText[name]
      const texts = [typeof given === 'string' ? given : EVENT_TEXT(name)]
      const id = 100 * (names.indexOf(name) + 1)
      if (name === 'after_compaction' && world.planId !== null) return bundleEvent(BUNDLE_EVENT_KEY[name], [...texts, BRIEFING_TEMPLATE], { id, slots: BRIEFING_SLOTS })
      return bundleEvent(BUNDLE_EVENT_KEY[name], texts, { id })
    })
    if (world.planId !== null) named.push(bundleEvent('subagent.compacted', [SUB_BRIEFING_TEMPLATE], { id: 1100, slots: ['sub_agent_id', 'sub_agent_name'] }))
    // the time stamp is the `clock_time` slot of a prompt's text (CP-146): the stand-in's `prompt.submit` text is the slot alone, as the plugin used to hand it
    const prompt = bundleEvent('prompt.submit', ['{{slot:clock_time}}'], { id: 900, slots: ['clock_time'], hookSlots: ['clock_time'] })
    const events = [...[...named, prompt, ...MOMENT_EVENTS].filter(e => !(e.event in world.bundle.events)), ...Object.values(world.bundle.events)]
    return reply({ version: world.bundle.version, min_plugin_version: world.bundle.minPlugin, floor_lines_plugin_version: world.bundle.floorVersion, ...assembleBundle(events) })
  }
  const isRoleRead = (a: any) => a.method === 'GET' && a.path === '/api/plan-sessions/me/role'
  function roleAnswer(a: any) {
    const query = a.query ?? {}
    world.roleReads.push({ plugin_version: query.plugin_version, reply_to_file: a.reply_to_file })
    if (world.roleOverride !== undefined) return reply(world.roleOverride.body ?? { error: 'role boom' }, world.roleOverride.status)
    return reply({ computed: world.role })
  }
  const isRequestedEndpointsRead =(a: any) => a.method === 'GET' && a.path === '/api/behavior-events/requested-endpoints'
  function requestedEndpointsAnswer(a: any) {
    const query = a.query ?? {}
    world.requestedEndpointReads.push({ plugin_version: query.plugin_version, reply_to_file: a.reply_to_file })
    if (world.requestedEndpointsOverride !== undefined) return reply(world.requestedEndpointsOverride.body ?? { error: 'requested endpoints boom' }, world.requestedEndpointsOverride.status)
    return reply({ computed: world.requestedEndpoints })
  }
  // DX-8226: the stand-in MCP's answer to a call that asked for a reply file (`reply_to_file`) or whose path a test lists in `replyFilePaths`: `{ok, status, reply_file: {path, bytes, chars, sha256}}` and no body, the body written whole to the file named from its hash.
  // Any other result is held to the host's size limit, as Claude Code holds a tool result.
  function replied(args: any, answered: { content: { text: string }[]; isError: boolean }) {
    const asked = args.reply_to_file === true && !world.inlineReplies
    if (!asked && !world.replyFilePaths.includes(args.path)) return hostLimited(answered)
    world.repliedAsFile.push(args.path)
    const whole = JSON.parse(answered.content[0].text)
    const body = JSON.stringify(whole.body)
    const sha256 = sha256Hex(body)
    const file = `${HOME_DIR}/tmp/danx-api/${sha256.slice(0, 16)}.json`
    if (!world.replyFileLost) world.files[file] = body
    return text({ ok: whole.ok, status: whole.status, reply_file: { path: file, bytes: new TextEncoder().encode(body).length, chars: body.length, sha256: world.replySha256 ?? sha256, instruction: 'The reply was over the inline limit, so its body is this file, whole.' } })
  }
  // ... every attempt, including the ones the MCP being down refuses
  const pacingAttempts = { n: 0 }
  // DX-4578: the pacing reads are kept out of `calls` and `api`; the plugin's server is the one every call goes to
  const pacingPath = (e: any, path: string) => e.server === 'plugin:50arms:platform' && e.tool === '50arms_api' && e.args.path === path
  on('mcp.call', async (_$: any, e: any) => {
    if (!world.bound) return unboundCall('$.mcp.call')
    // DX-5093: the Browser pane's server, as the real one answers (tabs_context: `{browserOpen, tabs: [{tabId, origin, isActive}]}`; tabs_create: `{serverId,
    // tabId, reused, type}`)
    if (e.server === 'Claude_Browser') {
      const browser = world.browser
      if (!browser.present) return { deny: `$.mcp.call: no connected MCP tool "${e.tool}" on a server named "Claude_Browser"` }
      if (browser.rejects !== undefined) return { deny: browser.rejects }
      if (browser.delayMs > 0) await clock.sleep(browser.delayMs)
      const failed = browser.errors[e.tool as 'tabs_context']
      if (e.tool === 'tabs_context') {
        browser.calls.push('tabs_context')
        if (failed !== undefined) return { value: { content: [{ type: 'text', text: failed }], isError: true } }
        // DX-5093: the real answer is ONE text block: the pretty-printed object, a newline, then a sentence (read from a live trace)
        const body = { browserOpen: browser.open, tabs: browser.open ? browser.tabs.map((origin, i) => ({ tabId: `tab-${i}`, origin, isActive: i === 0 })) : [] }
        const sentence = browser.open ? 'The Browser pane is currently hidden.' : "The Browser pane isn't open yet, so there are no tabs. Call preview_start or navigate with {\"url\": \"https://…\"} to open it."
        return { value: { content: [{ type: 'text', text: `${JSON.stringify(body, null, 2)}\n${sentence}` }], isError: false } }
      }
      if (e.tool === 'tabs_create') {
        browser.calls.push('tabs_create')
        if (failed !== undefined) return { value: { content: [{ type: 'text', text: failed }], isError: true } }
        return { value: text({ serverId: 'preview-local_x', tabId: `tab-${browser.tabs.length}`, reused: browser.reuses, type: 'browser' }) }
      }
      if (e.tool === 'navigate') {
        browser.calls.push(`navigate ${e.args.url} ${e.args.tabId ?? '-'}`)
        if (failed !== undefined) return { value: { content: [{ type: 'text', text: failed }], isError: true } }
        browser.open = true
        browser.tabs.push(new URL(e.args.url).origin)
        return { value: { content: [{ type: 'text', text: `Navigated to ${e.args.url}` }], isError: false } }
      }
      return { deny: `unknown Browser tool ${e.tool}` }
    }
    // the dashboard servers a session can have: a call to one it lacks is the engine's "no such server"; one it has is served by the handlers below, which key on the plugin's name
    if (DASHBOARD_SERVERS.includes(e.server)) {
      serversCalled.add(e.server)
      if (!sessionServers().includes(e.server)) return { deny: `$.mcp.call: no connected MCP tool "${e.tool}" on a server named "${e.server}"` }
      e = { ...e, server: SERVER }
    }
    // DX-4997 / DX-5033: the dashboard's rule for the agent pause, applied to every 50arms_api call the plugin makes
    if (e.server === SERVER && e.tool === '50arms_api') {
      if (options.mcp === 'strictKeys' && 'background' in e.args) {
        backgroundRefusals.push(`${e.args.method} ${e.args.path}`)
        return { deny: `MCP error -32602: Input validation error: Invalid arguments for tool 50arms_api: [ { "code": "unrecognized_keys", "keys": [ "background" ], "path": [], "message": "Unrecognized key(s) in object: 'background'" } ]` }
      }
      // an MCP from before DX-8226 accepts `background` and refuses `reply_to_file` as an unknown key
      if (options.mcp === 'beforeReplyToFile' && 'reply_to_file' in e.args) {
        replyToFileRefusals.push(`${e.args.method} ${e.args.path}`)
        return { deny: `MCP error -32602: Input validation error: Invalid arguments for tool 50arms_api: [ { "code": "unrecognized_keys", "keys": [ "reply_to_file" ], "path": [], "message": "Unrecognized key(s) in object: 'reply_to_file'" } ]` }
      }
      if (e.args.background !== true) unmarked.push(`${e.args.method} ${e.args.path}`)
      serverPauseRule(e.args)
    }
    // what the spawn guard reads to learn a designer's floor: the plan-design review grade of the card's board
    if (e.server === SERVER && e.tool === '50arms_api' && e.args.method === 'GET' && /^\/api\/issues\/[^/]+\/quality-gates\/plan-design\/instruction$/.test(e.args.path)) {
      designerGradeReads.push(e.args.path)
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "50arms_api" on a server named "plugin:50arms:platform"' }
      const given = options.designerGrade ?? { model: 'opus', effort: 'high' }
      if ('status' in given) return { value: reply({ error: 'grade boom' }, given.status) }
      return { value: reply({ gate: 'plan-design', board: 9, review_grade: 'high', ...given }) }
    }
    if (pacingPath(e, '/api/pacing/line')) {
      pacingAttempts.n++
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "50arms_api" on a server named "plugin:50arms:platform"' }
      if (options.mcp === 'flaky') return { deny: 'request timed out after 60000ms' }
      if (options.mcp === 'refused') return { deny: CLASSIFIER_REFUSAL }
      pacingReads.push(pacingReads.length + 1)
      // the answer is fixed when the read starts: a dashboard change during the hold belongs to the next read
      const given = options.pacingLine ?? { body: { account: null, level: null, budget: null, resets_at: null, main_agents: null, sub_agents: null, reserved_agents: null, line: null, reason: 'no_usage_account' } }
      if (options.pacingHoldMs !== undefined) await clock.sleep(options.pacingHoldMs)
      return { value: 'status' in given ? reply({ error: 'line boom' }, given.status) : reply(given.body) }
    }
    // CP-89 / DX-7026: the band's Revoke, an open route of the agent gate (a session holding no agent must still be revocable). It frees the agent and revokes the
    // presented key, so every later call answers the revoked halt and only session_connect with person_sign_in leaves it; it answers {released, revoked: true}. world.release shapes it as it shapes the exit-time release.
    if (e.server === SERVER && e.tool === '50arms_api' && e.args.method === 'POST' && e.args.path === '/api/plan-sessions/me/person-disconnect') {
      personDisconnects.push({ method: e.args.method, path: e.args.path, background: e.args.background })
      if (world.release.hangs) await hung.promise
      if (world.release.delayMs !== undefined) await clock.sleep(world.release.delayMs)
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "50arms_api" on a server named "plugin:50arms:platform"' }
      if (world.release.deny !== undefined) return { deny: world.release.deny }
      if (world.signedOut !== null) return { value: { content: [{ type: 'text', text: world.signedOut === 'revoked' ? KEY_REVOKED_HALT : world.signedOut === 'lapsed' ? KEY_LAPSED_HALT : SIGN_IN_HALT }], isError: true } }
      if (world.release.status !== undefined) return { value: reply({ error: 'release boom' }, world.release.status) }
      const released = world.agent !== null
      world.leaveOrder.push('person-disconnect')
      world.agent = null
      world.agentGate = null
      world.signedOut = 'revoked'
      return { value: reply({ released, revoked: true }) }
    }
    // DX-5549: the agent gate closes every 50arms_api call but the proposal routes (packages/platform-mcp agent-gate.ts); each refused call is still
    // recorded where its suite counts it
    if (e.server === SERVER && e.tool === '50arms_api' && world.agentGate !== null && !(e.args.method === 'POST' && e.args.path.startsWith('/api/team/agent-proposals')) && !(world.agentGate === 'agent_not_held' && e.args.method === 'POST' && e.args.path === '/api/plan-sessions/me/agent')) {
      if (isContextRead(e.args)) contextReads.push(e.args.path)
      else if (e.args.method === 'DELETE' && e.args.path === '/api/plan-sessions/me/agent') releaseCalls.push({ method: e.args.method, path: e.args.path, background: e.args.background })
      else calls.push({ server: e.server, tool: e.tool, args: e.args })
      // the dashboard's own refusal for a session whose agent was released: a 403 envelope, not the MCP's error result
      if (world.agentGate === 'agent_not_held') return { value: replied(e.args, reply({ error: 'agent_not_held', state: 'agent_not_held', instruction: 'You hold no team agent: call session_connect to claim one.' }, 403)) }
      return { value: { content: [{ type: 'text', text: JSON.stringify(AGENT_GATE_HALT(world.agentGate)) }], isError: true } }
    }
    // DX-5593: the spawn claim, decided like 50 Arms does under its lock: refuse when the level is not on pace or the live count (the line's
    // `sub_agents` plus the claims held) has reached the budget; unknown (a `reason`, no level) claims nothing. The answer is the line plus {claimed, claim_id}.
    if (e.server === 'plugin:50arms:platform' && e.tool === '50arms_api' && typeof e.args.path === 'string' && e.args.path.startsWith('/api/pacing/agents/claim')) {
      if (e.args.method === 'POST') {
        claimAttempts.n++
        claimBodies.push(e.args.body)
      }
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "50arms_api" on a server named "plugin:50arms:platform"' }
      if (options.mcp === 'flaky') return { deny: 'request timed out after 60000ms' }
      if (options.mcp === 'refused') return { deny: CLASSIFIER_REFUSAL }
      if (world.signedOut !== null) return { value: { content: [{ type: 'text', text: world.signedOut === 'revoked' ? KEY_REVOKED_HALT : world.signedOut === 'lapsed' ? KEY_LAPSED_HALT : SIGN_IN_HALT }], isError: true } }
      if (e.args.method === 'DELETE') {
        const id = new URL(e.args.path, 'http://dashboard.local').searchParams.get('claim_id') as string
        claimsReleased.push(id)
        if (options.claimRelease !== undefined) return { value: 'status' in options.claimRelease ? reply({ error: 'release boom' }, options.claimRelease.status) : reply(options.claimRelease.body) }
        return { value: reply({ released: heldClaims.delete(id) }) }
      }
      const given = options.pacingLine ?? { body: { account: null, level: null, budget: null, resets_at: null, main_agents: null, sub_agents: null, reserved_agents: null, line: null, reason: 'no_usage_account' } }
      if (options.pacingHoldMs !== undefined) await clock.sleep(options.pacingHoldMs)
      if ('status' in given) return { value: reply({ error: 'claim boom' }, given.status) }
      const line = given.body as any
      if (line === null || typeof line !== 'object') return { value: reply(line) }
      const known = line.level !== null && line.level !== undefined
      const live = known && Number.isInteger(line.sub_agents) ? line.sub_agents + heldClaims.size : line.sub_agents
      // DX-5595: the slots held for woken sessions (`reserved_agents`) count as taken, as 50 Arms' claim counts them
      const room = known && line.level === 'on_pace' && (line.budget === null || live + (line.reserved_agents ?? 0) < line.budget)
      // DX-5595: the cause 50 Arms' `refusalOf` names, in its order: the level, the budget against the live count, then the budget against the count plus the held slots
      const refusal = !known ? null : line.level !== 'on_pace' ? 'level' : line.budget !== null && live >= line.budget ? 'budget' : 'reserved'
      if (!room) return { value: reply({ ...line, sub_agents: live, claimed: false, claim_id: null, refusal }) }
      const id = `claim-${claimsAllowed.length + 1}`
      claimsAllowed.push(id)
      heldClaims.add(id)
      return { value: reply({ ...line, sub_agents: live, claimed: true, claim_id: id, refusal: null }) }
    }
    // DX-4234 / DX-4632: the restart notice is the server's own tool, named without arguments; kept out of `calls` like the context reads
    if (e.server === SERVER && e.tool === 'restart_notice') {
      restartCalls.push(e.args)
      if (world.restart.hangs) await hung.promise
      if (world.restart.delayMs !== undefined) await clock.sleep(world.restart.delayMs)
      if (world.restart.deny !== undefined) return { deny: world.restart.deny }
      if (world.restart.raw !== undefined) return { value: world.restart.raw }
      return { value: text(world.restart.json ?? { notice: null }) }
    }
    // DX-5554: the release of the session's team agent at session exit, answered as the real route answers (`{released}`)
    if (e.server === SERVER && e.tool === '50arms_api' && e.args.method === 'DELETE' && e.args.path === '/api/plan-sessions/me/agent') {
      releaseCalls.push({ method: e.args.method, path: e.args.path, background: e.args.background })
      if (world.release.hangs) await hung.promise
      if (world.release.delayMs !== undefined) await clock.sleep(world.release.delayMs)
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "50arms_api" on a server named "plugin:50arms:platform"' }
      if (world.release.deny !== undefined) return { deny: world.release.deny }
      if (world.signedOut !== null) return { value: { content: [{ type: 'text', text: world.signedOut === 'revoked' ? KEY_REVOKED_HALT : world.signedOut === 'lapsed' ? KEY_LAPSED_HALT : SIGN_IN_HALT }], isError: true } }
      if (world.release.status !== undefined) return { value: reply({ error: 'release boom' }, world.release.status) }
      const released = world.agent !== null
      world.leaveOrder.push('release')
      world.agent = null
      return { value: reply({ released }) }
    }
    // DX-4234: the reads the context hooks make (is the session on a plan, the registry's event text, an earlier session's restart notice) are
    // kept out of `calls` and `api` like the pacing reads, so the suites that count a load's reads stay about their own subject
    if (e.server === SERVER && e.tool === '50arms_api' && isContextRead(e.args)) {
      contextReads.push(e.args.path)
      if (world.contextHangs) await hung.promise
      if (world.contextDelayMs > 0) await clock.sleep(world.contextDelayMs)
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "50arms_api" on a server named "plugin:50arms:platform"' }
      if (options.mcp === 'flaky') return { deny: 'request timed out after 60000ms' }
      if (options.mcp === 'refused') return { deny: CLASSIFIER_REFUSAL }
      if (world.signedOut !== null) return { value: { content: [{ type: 'text', text: world.signedOut === 'revoked' ? KEY_REVOKED_HALT : world.signedOut === 'lapsed' ? KEY_LAPSED_HALT : SIGN_IN_HALT }], isError: true } }
      return { value: replied(e.args, contextAnswer(e.args)) }
    }
    // DX-8225: the requested endpoints a compaction is followed by, read only then: kept out of `calls` and of the context reads
    if (e.server === SERVER && e.tool === '50arms_api' && isRequestedEndpointsRead(e.args)) {
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "50arms_api" on a server named "plugin:50arms:platform"' }
      if (options.mcp === 'flaky') return { deny: 'request timed out after 60000ms' }
      if (world.signedOut !== null) return { value: { content: [{ type: 'text', text: world.signedOut === 'revoked' ? KEY_REVOKED_HALT : world.signedOut === 'lapsed' ? KEY_LAPSED_HALT : SIGN_IN_HALT }], isError: true } }
      return { value: replied(e.args, requestedEndpointsAnswer(e.args)) }
    }
    // CP-166: the session's role, read only when `session.bind` is told: kept out of `calls` and of the context reads
    if (e.server === SERVER && e.tool === '50arms_api' && isRoleRead(e.args)) {
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "50arms_api" on a server named "plugin:50arms:platform"' }
      if (options.mcp === 'flaky') return { deny: 'request timed out after 60000ms' }
      if (world.signedOut !== null) return { value: { content: [{ type: 'text', text: world.signedOut === 'revoked' ? KEY_REVOKED_HALT : world.signedOut === 'lapsed' ? KEY_LAPSED_HALT : SIGN_IN_HALT }], isError: true } }
      return { value: replied(e.args, roleAnswer(e.args)) }
    }
    // CP-146: the plugin's reports of what it delivered and held (POST behavior-events) and its floor lines (PUT plugin-floor), kept in their own lists; a `reportReplies` entry for the route answers an error or a delay
    if (e.server === SERVER && e.tool === '50arms_api' && ((e.args.method === 'POST' && e.args.path === '/api/plan-sessions/me/behavior-events') || (e.args.method === 'PUT' && e.args.path === '/api/plan-sessions/me/plugin-floor'))) {
      const floor = e.args.method === 'PUT'
      const over = world.reportReplies[`${e.args.method} ${e.args.path}`]
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "50arms_api" on a server named "plugin:50arms:platform"' }
      if (over?.delayMs !== undefined) await clock.sleep(over.delayMs)
      if (over?.deny !== undefined) return { deny: over.deny }
      ;(floor ? world.floorSends : world.deliveryReports).push({ body: e.args.body })
      if (over?.status !== undefined) return { value: reply(over.body ?? { error: 'report boom' }, over.status) }
      return { value: floor ? reply({ plugin_version: e.args.body.plugin_version }) : reply({ recorded: e.args.body.reports?.length ?? 0 }) }
    }
    // DX-5694: the turn activity sends (PUT /api/plan-sessions/me/turn-activity), kept in their own list so every suite that asserts on `reports` stays about its own subject
    if (e.server === SERVER && e.tool === '50arms_api' && e.args.method === 'PUT' && e.args.path === '/api/plan-sessions/me/turn-activity') {
      const over = world.reportReplies[`PUT ${e.args.path}`]
      if (notConnected()) {
        turnActivityCalls.push({ activity: e.args.body.activity, since: e.args.body.since })
        return { deny: '$.mcp.call: no connected MCP tool "50arms_api" on a server named "plugin:50arms:platform"' }
      }
      // CP-149: a session on no plan and no card has no plan_sessions row unless the test says it holds a queued job (`holdsQueuedJob`): the dashboard answers 404 and records nothing
      if (world.planId === null && world.card === null && world.holdsQueuedJob !== true) return { value: reply({ error: 'session_not_found' }, 404) }
      turnActivityCalls.push({ activity: e.args.body.activity, since: e.args.body.since })
      if (over?.deny !== undefined) return { deny: over.deny }
      if (over?.status !== undefined) return { value: reply(over.body ?? { error: 'turn activity boom' }, over.status) }
      return { value: reply({ status: 'updated' }) }
    }
    if (e.server === SERVER && e.tool === '50arms_api' && isReportCall(e.args)) {
      reportCalls.push({ method: e.args.method, path: e.args.path, body: e.args.body, query: e.args.query, board: e.args.board })
      sequence.push(`report ${e.args.method} ${e.args.path}`)
      const over = world.reportReplies[`${e.args.method} ${e.args.path}`]
      if (over?.delayMs !== undefined) await clock.sleep(over.delayMs)
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "50arms_api" on a server named "plugin:50arms:platform"' }
      if (options.mcp === 'flaky') return { deny: 'request timed out after 60000ms' }
      if (options.mcp === 'refused') return { deny: CLASSIFIER_REFUSAL }
      if (world.signedOut !== null) return { value: { content: [{ type: 'text', text: world.signedOut === 'revoked' ? KEY_REVOKED_HALT : world.signedOut === 'lapsed' ? KEY_LAPSED_HALT : SIGN_IN_HALT }], isError: true } }
      if (over?.deny !== undefined) return { deny: over.deny }
      if (over?.status !== undefined) return { value: reply(over.body ?? { error: 'report boom' }, over.status) }
      return { value: reportAnswer(e.args) }
    }
    // the desktop app's session server, as the real one answers (kept out of `calls` and `sequence`, which are the dashboard's): get_session is one text block, the session's metadata as JSON
    if (e.server === 'ccd_session_mgmt') {
      const app = world.appSession
      if (e.tool === 'get_session') app.reads++
      if (e.tool === 'get_session') {
        const answer = { value: { content: [{ type: 'text', text: JSON.stringify({ sessionId: 'local_test', title: app.title }, null, 2) }], isError: false } }
        app.afterRead.shift()?.()
        return answer
      }
      if (e.tool === 'set_session_title' && app.failSet !== undefined) return { value: { content: [{ type: 'text', text: app.failSet }], isError: true } }
      if (e.tool === 'set_session_title') {
        // the app takes the title only after this long (a write in flight while another caller acts)
        if (app.setDelayMs > 0) await clock.sleep(app.setDelayMs)
        app.set.push(e.args.title)
        const was = app.title
        app.title = e.args.title
        return { value: { content: [{ type: 'text', text: `Renamed this session to "${app.title}" (was "${was}").` }], isError: false } }
      }
    }
    if (e.server === 'ccd_connectors') {
      if (world.connectors.absent) return { deny: `$.mcp.call: no connected MCP tool "${e.tool}" on a server named "${e.server}"` }
      if (e.tool === 'reconnect_session_connector') {
        world.connectors.reconnects.push(e.args.server)
        return { value: { content: [{ type: 'text', text: `Reconnect of ${e.args.server} queued.` }], isError: false } }
      }
    }
    if (e.server === SERVER && e.tool === 'session_connect' && e.args.registration_only === true) {
      const machine = world.machine
      machine.calls.push(e.args)
      // an MCP older than the flag refuses it: every tool's input schema is strict
      if (machine.refuse === 'deny') return { deny: 'session_connect: unrecognized key registration_only' }
      if (machine.refuse === 'error') return { value: { content: [{ type: 'text', text: 'MCP error -32602: Invalid arguments: unrecognized key registration_only' }], isError: true } }
      if (machine.registered) return { value: text({ state: 'machine_registered' }) }
      const first = !machine.requested
      machine.requested = true
      // the calls in flight at once (the watch is one at a time)
      machine.active++
      machine.maxActive = Math.max(machine.maxActive, machine.active)
      try {
        if (!first) {
          await clock.sleep(machine.waitMs)
          if (machine.registered) return { value: text({ state: 'machine_registered' }) }
        }
      } finally {
        machine.active--
      }
      return { value: text(first ? MACHINE_REQUIRED : MACHINE_PENDING) }
    }
    calls.push({ server: e.server, tool: e.tool, args: e.args })
    if (e.tool !== '50arms_api') sequence.push(`tool ${e.tool}`)
    if (e.server === 'plugin:50arms:platform') {
      // a deny reaches the plugin as a rejection that carries the reason
      if (notConnected()) return { deny: '$.mcp.call: no connected MCP tool "50arms_api" on a server named "plugin:50arms:platform"' }
      if (options.mcp === 'flaky') return { deny: 'request timed out after 60000ms' }
      if (options.mcp === 'refused') return { deny: CLASSIFIER_REFUSAL }
      const haltText = () => (world.signedOut === 'revoked' ? KEY_REVOKED_HALT : world.signedOut === 'lapsed' ? KEY_LAPSED_HALT : SIGN_IN_HALT)
      // DX-4233: a scripted wait answer is the engine's own (a refusal it makes before the server sees the call: not connected, not bound), so it
      // comes first, whatever the key's state
      if (e.tool === 'plan_events_wait' && server.script.length > 0) return planEventsWait(e.args)
      // a revoked key stops EVERY tool, session_connect included, and asks for nothing; only session_connect with person_sign_in clears it and asks
      if (world.signedOut === 'revoked' && e.tool === 'session_connect' && e.args.person_sign_in === true) world.signedOut = 'signed-out'
      if (world.signedOut === 'revoked' || (world.signedOut !== null && e.tool !== 'session_connect')) {
        return { value: { content: [{ type: 'text', text: haltText() }], isError: true } }
      }
      // an unregistered machine answers a plain session_connect with its registration, and makes no access request
      if (world.signedOut !== null && e.tool === 'session_connect' && !world.machine.registered) {
        world.machine.requested = true
        return { value: text(MACHINE_REQUIRED) }
      }
      if (world.signedOut !== null && e.tool === 'session_connect') {
        const dance = world.signIn
        dance.calls.push(e.args)
        // `waits`: the answer comes after the MCP's wait, as a still-pending request's does (a repeating caller must not spin)
        if (dance.answer?.waits) await clock.sleep(dance.waitMs)
        if (dance.answer) return { value: { content: [{ type: 'text', text: dance.answer.text }], isError: dance.answer.isError ?? false } }
        // approved: the key is stored, and the call goes on to connect the plan it was given (or answers signed_in)
        const approvedAnswer = () => {
          world.signedOut = null
          if (e.args.target === undefined) return { value: text({ state: 'signed_in', instruction: 'This session is signed in. Call `session_connect` with `target` to connect it to a plan or a card.' }) }
          world.titleSeen = e.args.title
          if (planNumberOf(e.args.target) === undefined) return { value: text({ ok: true, status: 200, body: { session: { cardId: e.args.target } } }) }
          world.planId = planNumberOf(e.args.target)
          return { value: text({ ok: true, status: 200, body: { session: { planId: world.planId } } }) }
        }
        if (dance.approved) return approvedAnswer()
        if (!dance.requested) {
          dance.requested = true
          return { value: text(APPROVAL_REQUIRED) }
        }
        // the call waits for the approval (the MCP's ~45 s), and answers the moment it comes; one that outlives the request
        // (`expireAfterCalls` calls in) answers a NEW request, as session-access.ts does after an expiry
        await clock.sleep(dance.waitMs)
        if (dance.approved) return approvedAnswer()
        if (dance.expireAfterCalls !== undefined && dance.calls.length >= dance.expireAfterCalls) {
          return { value: text({ ...APPROVAL_REQUIRED, approvalUrl: `${APPROVAL_URL}-renewed`, confirmCode: 'NEWCODE9', note: 'The previous request expired before it was approved.' }) }
        }
        return { value: text(APPROVAL_PENDING) }
      }
      if (e.tool === 'plan_events_wait') return planEventsWait(e.args)
      // the real envelope (packages/platform-mcp jsonResult, the server's leave routes): pretty-printed JSON text, and a refusal is `ok: false`, never an error result
      const envelope = (ok: boolean, status: number, body: unknown) => ({
        value: { content: [{ type: 'text', text: JSON.stringify({ ok, status, body }, null, 2) }], isError: false },
      })
      // a leave with no `target`, or one that is not a string or is empty: the server's 400 (`DELETE /me/connect` with no `?target=`), whichever kind it would have been
      if (e.tool === 'session_connect' && e.args.disconnect && (typeof e.args.target !== 'string' || e.args.target === '')) {
        return envelope(false, 400, {
          error: 'target is required: the plan (PLAN-n) or the card the session believes it holds (?target=)',
          message_id: 'issues.connectTargetQueryRequired',
        })
      }
      // the leave of a held card, from the model or the band's Disconnect: `session_connect` with a card's id as `target` and `disconnect: true`, guarded on that id (409 card_mismatch / session_holds_no_card), answering {session, leftCard}
      if (e.tool === 'session_connect' && e.args.disconnect && planNumberOf(e.args.target) === undefined) {
        if (world.leaveDeny !== null) return { deny: world.leaveDeny }
        if (world.cardLeave === 'boom') return envelope(false, 500, { error: 'card boom' })
        if (world.card === null) return envelope(false, 409, { error: 'session_holds_no_card', message: `Session ${SESSION_ID} holds no card, so there is nothing to leave.` })
        if (world.card.id !== e.args.target) return envelope(false, 409, { error: 'card_mismatch', message: `Session ${SESSION_ID} holds ${world.card.id}, not ${e.args.target}; nothing was changed.` })
        const leftCard = world.card
        world.leaveOrder.push('card')
        world.card = null
        if (world.cardLeave === 'noLeftCard') return envelope(true, 200, { session: { sessionId: SESSION_ID, cardId: null } })
        return envelope(true, 200, { session: { sessionId: SESSION_ID, cardId: null }, leftCard: { id: leftCard.id, title: leftCard.title } })
      }
      if (e.tool === 'request_permission') {
        world.permissionAsks++
        if (world.permissionAskHold !== null) await world.permissionAskHold
        if (world.permissionAskDeny !== null) return { deny: world.permissionAskDeny }
        return { value: text(world.permissionAskRefused === null ? APPROVAL_REQUIRED : { ok: false, status: 403, body: { error: world.permissionAskRefused } }) }
      }
      if (e.tool === 'session_connect' && e.args.disconnect) {
        if (world.leaveDeny !== null) return { deny: world.leaveDeny }
        if (world.planLeaveHold !== null) await world.planLeaveHold
        if (world.planLeaveAnswer !== null) return { value: { content: [{ type: 'text', text: world.planLeaveAnswer.text }], isError: world.planLeaveAnswer.isError } }
        if (options.disconnect === 'rejected') return { deny: 'session_connect is not available' }
        if (options.disconnectTakesMs) await clock.sleep(options.disconnectTakesMs)
        if (options.disconnect === 'mismatch') {
          world.planId = 24
          return envelope(false, 409, {
            error: 'plan_mismatch',
            session_id: SESSION_ID,
            expected_plan_id: planNumberOf(e.args.target),
            actual_plan: { id: 24, name: 'Agent mode' },
            message: `Session ${SESSION_ID} is on plan 24, not plan ${planNumberOf(e.args.target)}; nothing was changed.`,
          })
        }
        if (options.disconnect === 'notConnected' || world.planId === null) {
          world.planId = null
          return envelope(false, 409, {
            error: 'session_not_connected',
            session_id: SESSION_ID,
            message: `Session ${SESSION_ID} is not connected to a plan, so there is nothing to leave.`,
          })
        }
        if (options.disconnect === 'notFound') return envelope(false, 404, { error: 'Not found' })
        const left = plans.find(p => p.id === world.planId)
        world.planId = null
        world.leaveOrder.push('plan')
        // the fake's plan leave keeps the session's key and its team agent because the server rule now keeps them: the dashboard frees an agent only on a revoke or the session's end
        if (options.disconnect === 'noLeftPlan') return envelope(true, 200, { session: { sessionId: SESSION_ID, planId: null } })
        return envelope(true, 200, {
          session: { sessionId: SESSION_ID, planId: null },
          leftPlan: { id: left?.id, name: left?.name },
        })
      }
      if (e.tool === 'session_connect') {
        // a THROWN call (argument validation, an outdated MCP): the one error-result path
        if (options.connectThrows) return { deny: 'session_connect: the MCP server is outdated' }
        // refusals are `ok: false` envelopes (handleConnect / lockPlanForConnect / planArchivedError)
        if (options.connectFails) {
          return {
            value: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      ok: false,
                      status: 409,
                      body: {
                        error: 'PLAN-24 is archived. Restore it before doing this: an archived plan connects no sessions and runs no lifecycle behaviour.',
                        code: 'plan_archived',
                      },
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: false,
            },
          }
        }
        // CP-43: a session_connect with no target claims a team agent and connects nothing (the agent gate's answers are the kit's `agentClaim`)
        if (e.args.target === undefined) {
          world.claimsByConnect++
          if (world.agentClaim !== null) return { value: text(world.agentClaim) }
          world.agent = world.agentNext ?? world.agent ?? { id: 6, name: 'Tendai', avatar_url: null }
          world.agentGate = null
          return { value: text({ state: 'agent_held', agent: world.agent, instruction: 'Use this name.' }) }
        }
        world.titleSeen = e.args.title
        if (planNumberOf(e.args.target) === undefined) {
          world.card = { id: e.args.target, title: 'x' }
          return { value: text({ ok: true, status: 200, body: { session: { cardId: e.args.target } } }) }
        }
        world.planId = planNumberOf(e.args.target)
        return { value: text({ ok: true, status: 200, body: { session: { planId: world.planId } } }) }
      }
      api.push({ method: e.args.method, path: e.args.path, body: e.args.body, query: e.args.query })
      const apiHold = world.apiHolds.findIndex(h => h.method === e.args.method && h.path === e.args.path)
      if (apiHold !== -1) {
        const h = world.apiHolds.splice(apiHold, 1)[0]
        if (h.early) {
          const answered = route(e.args.method, e.args.path, e.args.body, e.args.query)
          await h.hold
          return { value: hostLimited(answered) }
        }
        await h.hold
      }
      if (e.args.method === 'PUT' && e.args.path === '/api/plan-sessions/me/ready' && world.markHold !== null) await world.markHold
      if (e.args.method === 'DELETE' && e.args.path === '/api/plan-sessions/me/ready' && world.readyClearHold !== null) await world.readyClearHold
      if (e.args.method === 'GET' && /^\/api\/plans\/\d+$/.test(String(e.args.path)) && world.planReadHold !== null) await world.planReadHold
      if (e.args.method === 'GET' && /^\/api\/issues\/[^/]+$/.test(String(e.args.path)) && world.cardReadHold !== null) await world.cardReadHold
      if (options.hangFirstLoad && e.args.path === '/api/plan-sessions/me' && api.filter(a => a.path === '/api/plan-sessions/me').length === 2) {
        return hung.promise.then(() => ({ value: route(e.args.method, e.args.path, e.args.body, e.args.query) }))
      }
      // DX-5232: the plan read is one path now (load and session probe alike), so a slow dashboard slows it as it slows a context read
      if (e.args.path === '/api/plan-sessions/me' && world.contextDelayMs > 0) await clock.sleep(world.contextDelayMs)
      if (world.permissionClaimDelayMs > 0 && /\/claim$/.test(String(e.args.path))) await clock.sleep(world.permissionClaimDelayMs)
      // DX-4635: every 50arms_api read answers after `apiHoldMs` on the harness clock (a slow dashboard), and the card reads in flight together are counted
      const isIssueRead = String(e.args.path).startsWith('/api/issues/')
      if (isIssueRead) {
        issueReads.active++
        issueReads.max = Math.max(issueReads.max, issueReads.active)
      }
      try {
        if (flags.apiHoldMs > 0) await clock.sleep(flags.apiHoldMs)
      } finally {
        if (isIssueRead) issueReads.active--
      }
      const answered = route(e.args.method, e.args.path, e.args.body, e.args.query)
      // DX-4400, DX-8226: an answer the MCP sends as a file (asked for, or listed in `replyFilePaths`), any other held to the host's limit
      return { value: replied(e.args, answered) }
    }
    return { deny: `no stand-in for ${e.server}` }
  })
  // what the plugin keeps in $.state (a test has no `$.state` of its own to read back)
  const flags = { viewWriteFails: false, refusedViewWrites: 0, apiHoldMs: 0 }
  // keys whose next write the host refuses (once each): the way a plugin's own bookkeeping call throws after the engine call it follows worked
  const refuseNextWrite = new Set<string>()
  const issueReads = { active: 0, max: 0 }
  let seededPending: string[] | undefined
  let seededRelay: { phase: string; planId: number | null; detail: string | null } | undefined
  // DX-4952: a step of the test that runs exactly between two steps of the plugin, once, before the next host read / write of a $.state key
  // reaches the host: the way a test makes a turn start, a plan disconnect or a long wait land at one precise point of an async function
  const beforeStateRead = new Map<string, () => Promise<void>>()
  const beforeStateWrite = new Map<string, () => Promise<void>>()
  const takeStep = async (steps: Map<string, () => Promise<void>>, key: string) => {
    const step = steps.get(key)
    if (step === undefined) return
    steps.delete(key)
    await step()
  }
  on('state.set', async (_$: any, e: any, next: any) => {
    if (beforeStateWrite.size > 0) await takeStep(beforeStateWrite, e.key)
    if (refuseNextWrite.delete(e.key)) return { deny: `${e.key} write refused` } as any
    // a write of the plugin's view that the host refuses: the one way a refresh can throw past its own catch
    if (flags.viewWriteFails && e.key === 'view') {
      flags.refusedViewWrites++
      return { deny: 'view write refused' } as any
    }
    // DX-4721: the next write of a running turn carries these urgent notes as appended and not yet read (a note the plugin appends can never
    // succeed under `claude plugin test`, so the state it would leave is seeded)
    if (e.key === 'turn' && e.value?.isRunning === true && seededPending !== undefined) {
      e = { ...e, value: { ...e.value, pending: seededPending } }
      seededPending = undefined
    }
    // DX-4233: the next write of the relay's state is this one instead (a state left behind by a run on another plan)
    if (e.key === 'relay' && seededRelay !== undefined) {
      e = { ...e, value: seededRelay }
      seededRelay = undefined
    }
    stateWrites.push({ plugin: e.plugin, key: e.key, value: e.value })
    const set = await next(e)
    if (stateWiped) rewrittenSinceWipe.add(e.key)
    return set
  })
  // claude.exe 2.1.317 empties the plugin's whole $.state when a /clear starts the new conversation (measured with a probe module): `wipeState()` is that moment, and from it every
  // key reads as never written until the plugin writes it again. The engine's version of a key is kept, so a write made from such a read lands.
  let stateWiped = false
  const rewrittenSinceWipe = new Set<string>()
  const wipeState = () => {
    if (!stateGetHooked) throw new Error('wipeState needs dashboard(on, { stateSteps: true })')
    stateWiped = true
    rewrittenSinceWipe.clear()
  }
  // DX-4806: a value the host already holds when the module loads (what a reload of the module finds: $.state outlives it). It is read until the
  // plugin writes the key.
  const seededState = new Map<string, unknown>()
  // the one `state.get` hook: the seeds, and the steps a test puts before a read. It is added by the first seed or by the option `stateSteps`
  // (before the test's first call), so a test that needs neither has no extra hook on its reads: an extra hook is an extra turn of the event
  // loop on every read, enough to reorder the unawaited report writes of the reports suites.
  let stateGetHooked = false
  const hookStateGet = () => {
    if (stateGetHooked) return
    stateGetHooked = true
    on('state.get', async (_$: any, e: any, next: any) => {
      if (beforeStateRead.size > 0) await takeStep(beforeStateRead, e.key)
      const read = await next(e)
      if (stateWiped && !rewrittenSinceWipe.has(e.key)) return { ...read, value: { ...read.value, value: undefined } }
      return seededState.has(e.key) && !stateWrites.some(w => w.key === e.key) ? { ...read, value: { ...read.value, value: seededState.get(e.key) } } : read
    })
  }
  if (options.stateSteps === true) hookStateGet()
  const seedState = (key: string, value: unknown) => {
    hookStateGet()
    seededState.set(key, value)
  }
  // DX-4521: the plugin's $.store (what survives the session), one fresh map per fixture
  const stored = new Map<string, unknown>()
  let storeSetFails: string | undefined
  const storeSets: string[] = []
  // DX-5577: a broken store: every store call is refused with this reason. The runner hands the plugin a fake's refusal as `<plugin>: $.store.<op>: <reason>`, never the bare
  // message the real program throws, so this kit can only stand in for store errors the plugin must NOT recover; the recovery itself is tested through hooks/store/recover.ts
  let storeBroken: string | undefined
  const storeRefusal = () => (storeBroken === undefined ? undefined : ({ deny: storeBroken } as any))
  on('store.get', (_$: any, e: any) => storeRefusal() ?? ({ value: stored.get(e.key) }) as any)
  on('store.set', (_$: any, e: any) => {
    if (storeBroken !== undefined) return storeRefusal()
    if (storeSetFails !== undefined && String(e.key).startsWith(RELAY_CURSOR_PREFIX)) return { deny: storeSetFails } as any
    storeSets.push(String(e.key))
    return (stored.set(e.key, e.value), { value: undefined }) as any
  })
  // DX-4233: a test can hold `store.keys` (the relay's first await after its first word) until it releases it
  let storeKeysHold: Promise<void> | undefined
  on('store.keys', async () => {
    await storeKeysHold
    return storeRefusal() ?? ({ value: [...stored.keys()] }) as any
  })
  on('store.delete', (_$: any, e: any) => storeRefusal() ?? (stored.delete(e.key), { value: undefined }) as any)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  // the tools the session lists: the plugin's when its server is connected
  // DX-4234: how many times the session's tool list was read (a poll for the plugin's server that outlives its deadline keeps counting)
  const toolLists = { n: 0 }
  // DX-4233: which of the plugin server's tools the session lists: all of them (default), the ones an old pinned server has (no plan_events_wait),
  // or none (the server is not connected)
  const toolListAnswer = () => {
    const tool = (server: string, name: string) => ({ name: serverToolName(server, name), description: '', mcp: true })
    if (notConnected() || world.tools === 'none') return { value: [] } as any
    return { value: sessionServers().flatMap(server => (world.tools === 'old' ? [tool(server, '50arms_api')] : [tool(server, '50arms_api'), tool(server, 'plan_events_wait')])) } as any
  }
  on('tool.list', () => (toolLists.n++, world.bound ? toolListAnswer() : unboundCall('$.tool.list')))
  // the engine's per-session path as the OS spells it (C:\home\u\... on Windows)
  on('fs.exists', (_$: any, e: any) => {
    if (world.fsError !== undefined) return { deny: world.fsError } as any
    const path = fsKey(e.path)
    world.fsExists.push(path)
    const value = (world.localRecord && path === RECORD_PATH(world.sessionId)) || world.records.some(id => path === RECORD_PATH(id)) || path in world.files || Object.keys(world.files).some(file => file.startsWith(path + '/'))
    world.afterExists?.(path)
    return { value } as any
  })
  // DX-4993: the compaction control file, the window the plugin arms, and the git status of the resume briefing
  on('fs.read', (_$: any, e: any) => {
    const path = fsKey(e.path)
    world.fsReads.push(path)
    // CP-146: the plugin names its own version from its manifest (`<plugin root>/.claude-plugin/plugin.json`), whatever the root is
    if (path.endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify({ name: '50arms', version: world.pluginVersion }) } as any
    return (path in world.files ? { value: world.files[path] } : { deny: `ENOENT: no such file ${path}` }) as any
  })
  // a directory listing from the fixture's disk: the first path segment under it of every file held there. An entry is a dir when something lies deeper or its text is empty
  on('fs.list', (_$: any, e: any) => {
    if (options.agentListFails && fsKey(e.path).endsWith('/agents')) return { deny: 'EIO: the agent folder cannot be listed' } as any
    const dir = fsKey(e.path).replace(/\/$/, '')
    const kinds = new Map<string, 'file' | 'dir'>()
    for (const [path, text] of Object.entries(world.files)) {
      if (!path.startsWith(dir + '/')) continue
      const rest = path.slice(dir.length + 1)
      const name = rest.split('/')[0]
      const dirLike = rest.includes('/') || text === ''
      kinds.set(name, dirLike || kinds.get(name) === 'dir' ? 'dir' : 'file')
    }
    return { value: [...kinds].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) } as any
  })
  // a file the plugin writes lands in `world.files`
  on('fs.write', (_$: any, e: any) => {
    if ((world.carrierWriteFails || (world.carrierWriteFailsFor !== null && fsKey(e.path).includes(world.carrierWriteFailsFor))) && fsKey(e.path).includes('/behavior-text/')) return { deny: 'EACCES: permission denied' } as any
    world.files[fsKey(e.path)] = e.text
    return { value: undefined } as any
  })
  // DX-5217: the process environment is live: a set changes what the next get answers, as in the engine (an undefined value unsets)
  const liveEnv: Record<string, string> = {
    HOME: HOME_DIR,
    ...(options.env ?? {}),
    ...(options.entrypoint === undefined ? {} : { CLAUDE_CODE_ENTRYPOINT: options.entrypoint }),
    ...(options.accountUuid === undefined ? {} : { CLAUDE_CODE_ACCOUNT_UUID: options.accountUuid }),
    ...(options.autoCompactWindow === undefined ? {} : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: options.autoCompactWindow }),
    ...(options.autocompactPct === undefined ? {} : { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: options.autocompactPct }),
  }
  const envSets: { name: string; value: string | undefined }[] = []
  // DX-5222: whether the plugin had already written `leftoverArmingCleared` true when each set in `envSets` happened (the arming order)
  const envClearedAtSet: boolean[] = []
  on('env.set', (_$: any, e: any) => {
    envSets.push({ name: e.name, value: e.value })
    envClearedAtSet.push(stateWrites.some(w => w.key === 'leftoverArmingCleared' && w.value === true))
    if (e.value === undefined) delete liveEnv[e.name]
    else liveEnv[e.name] = e.value
    return { value: undefined } as any
  })
  on('env.get', (_$: any, e: any) => ({ value: liveEnv[e.name] }) as any)
  on('session.cwd', () => ({ value: '/work/repo' }) as any)
  // Every `$.process.run` the plugin makes, as its argv
  const runCalls: string[][] = []
  on('process.run', async (_$: any, e: any) => {
    runCalls.push([...e.argv])
    const processHold = world.processHolds.findIndex(h => h.command === e.argv.join(' '))
    if (processHold !== -1) await world.processHolds.splice(processHold, 1)[0].hold
    const answer: { exitCode?: number; stdout: string; stderr?: string; throws?: string } = world.processes[e.argv[0]] ?? world.gitStatus
    if (answer.throws !== undefined) return { deny: answer.throws } as any
    return { value: { exitCode: answer.exitCode ?? 0, stdout: answer.stdout, stderr: answer.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } } as any
  })
  on('session.id', () => ({ value: world.sessionId }) as any)
  // DX-5222: every `$.session.send` the plugin makes (the recipient as the engine spells it, and the text), and how the host answers it: delivered, refused or a rejection
  const sends: { to: string; text: string }[] = []
  const sendMode = { current: 'delivered' as 'delivered' | 'refused' | 'throws' }
  // a test can hold the host's answer to a send (the plugin is then in the middle of it) until it releases it
  const sendHold: { gate?: Promise<void>; entered?: () => void } = {}
  // a recipient whose sends the host drops at once, whatever the others get (DX-5222)
  const sendFails = new Set<string>()
  on('session.send', async (_$: any, e: any) => {
    sends.push({ to: e.to, text: e.text })
    if ([...sendFails].some(id => String(e.to).includes(id))) throw new Error('the host dropped the send')
    sendHold.entered?.()
    await sendHold.gate
    if (sendMode.current === 'throws') throw new Error('the host dropped the send')
    return (sendMode.current === 'refused' ? { isDelivered: false, reason: 'nobody by that name' } : { isDelivered: true }) as any
  })
  on('agent.list', async () => {
    return { value: world.agents } as any
  })
  // every `$.process.spawn` the plugin makes, as its argv: the plugin spawns no child, and a test says so by reading this
  const spawns: string[][] = []
  on('process.spawn', async function* (_$: any, e: any) {
    spawns.push([...e.argv])
    return { value: { code: 0, signal: null } }
  } as any)
  // what the engine draws above the prompt when no plugin does: nothing
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  // what the engine draws in the footer when no plugin does: its mode labels
  on('ui.render', { component: 'SessionMode' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{e.props.modes.join(' & ')}</Text>
  })
  // DX-4448: what the engine draws for an assistant reply when no plugin rewrites it: the text as it is
  on('ui.render', { component: 'AssistantMessage' }, ($: any, e: any) => {
    const { Box, Text } = $.ui.resolve(e)
    // the other props are shown too, so a test sees that a rewrite carried them on
    return (
      <Box flexDirection="column">
        <Text>{e.props.text}</Text>
        <Text key="meta">{`first=${e.props.isFirstOfReply} onScreen=${JSON.stringify(e.props.onScreen ?? null)}`}</Text>
      </Box>
    )
  })
  // DX-5365: the engine's version, as the plugin reads it to know the host runs `session.compact` before any event
  on('session.version', () => {
    versionReads++
    const v = options.engineVersion ?? { base: '2.1.298' }
    if (v === 'throws') return { deny: 'no version reading' } as any
    return { value: { version: v.base ?? 'custom-build', ...(v.base === undefined ? {} : { base: v.base }) } } as any
  })
  // DX-4336: what the harness knows of the account's windows
  on('session.usage', () => (options.usageReadFails === undefined ? { value: { startedAt: 0, context: world.context, rateLimits: world.rateLimits } } : { deny: options.usageReadFails }) as any)
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(e.text)
    if (e.timeoutMs !== undefined) toastTimeouts.push(e.timeoutMs)
    return { value: undefined }
  })
  on('ui.status', (_$: any, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('command.run', { command: 'compact' }, async (_$: any, e: any) => {
    world.readySteps.push('compact')
    compactRuns.push(e.args ?? null)
    if (options.compactRunFails !== undefined) throw new Error(options.compactRunFails)
    return { value: undefined } as any
  })
  // CP-43: the plugin's /clear, only as far as another session id answers afterwards (measured, claude.exe 2.1.309). The engine also raises `session.end`, empties the plugin's $.state
  // (claude.exe 2.1.317) and raises `classic.SessionStart`; a kit fake's `$` cannot raise an event, so a test that needs those holds this /clear (`clearHold`) and plays them itself
  // (`$.session.end`, `wipeState`, `$.classic.SessionStart`). The kit keeps no conversation.
  const clearRuns: string[] = []
  on('command.run', { command: 'clear' }, async (_$: any, _e: any) => {
    world.clearsStarted++
    if (world.clearHold !== null) await world.clearHold
    if (world.clearFails !== undefined) throw new Error(world.clearFails)
    if (world.clearDoesNothing) return { value: { text: '' } } as any
    world.readySteps.push('clear')
    clearRuns.push(world.sessionId)
    world.sessionId = `${OWN_SESSION.session_id}-cleared-${clearRuns.length}`
    return { value: { text: '' } } as any
  })
  on('command.register', (_$: any, e: any) => {
    if (PLUGIN_SKILLS.includes(e.name)) throw new Error(`50 Arms: $.command.register: "/${e.name}" refused: it is the plugin's /50arms:${e.name}`)
    commands.push(e.name)
    return { value: { isRegistered: true } } as any
  })

  const relay = {
    server,
    delivered,
    submitted,
    attempts,
    // the plan_events_wait calls the plugin made
    calls: server.calls,
    // events appear on the dashboard: a held wait answers at once
    // (DX-4721: every record the server answers carries a boolean `urgent`; a test that does not say is a not-urgent record)
    // (DX-5846: so does `acks`, the events the record asks the session to acknowledge; a test that does not say asks for none)
    // (a queued job offered to the session carries `offer`; a test that does not say sends a record with none, as an older server does)
    push: (...events: { cursor: string; text: string; urgent?: boolean; acks?: { eventId: number; attempt: number }[]; offer?: unknown }[]) => {
      server.buffer.push(...events.map(e => ({ urgent: false, acks: [], ...e })))
      server.wake?.()
    },
    // every key the plugin wrote to $.store, in order
    storeSets,
    // holds the plugin's next `store.keys` reads until the returned function is called
    holdStoreKeys: () => {
      let release!: () => void
      storeKeysHold = new Promise<void>(resolve => (release = resolve))
      return release
    },
    // the relay's cursor writes to $.store are refused with this reason (a failure that is none of the relay's own)
    failCursorWrites: (reason: string) => void (storeSetFails = reason),
    // DX-5577: every store call is refused with `reason` (see storeBroken)
    breakStore: (reason: string) => void (storeBroken = reason),
    // runs inside the next prompt submit, before it answers: a plan move at the very moment an event is delivered
    duringPrompt: (fn: () => Promise<void>) => void (deliveryFlags.duringPrompt = fn),
    dropPrompts: (reason: string) => void (deliveryFlags.submitDrops = reason),
    rejectPrompts: (reason: string) => void (deliveryFlags.submitRejects = reason),
    // DX-4793: the rows the plugin appended with $.session.append (the kit's session.append hook records them); the engine refuses the next appends
    // with this reason (the plugin shows its "Could not tell the model" toast)
    told,
    rejectAppends: (reason: string) => void (deliveryFlags.appendRejects = reason),
    // DX-5398: every prompt submitted from now on is queued behind a running turn: its submit does not settle (and the prompt is not recorded in
    // `submitted` or `delivered`) until `release()`, which is the turn ending. `held()` counts the submits still queued.
    holdPrompts: () => {
      let open!: () => void
      deliveryFlags.promptGate = new Promise<void>(resolve => (open = resolve))
      return {
        release: () => {
          deliveryFlags.promptGate = undefined
          open()
        },
        held: () => deliveryFlags.promptsHeld,
      }
    },
    acceptPrompts: () => {
      deliveryFlags.submitDrops = undefined
      deliveryFlags.submitRejects = undefined
    },
  }
  return { clearRuns, envSets, envClearedAtSet, sends, failSendsTo: (id: string) => void sendFails.add(id), setSendMode: (mode: 'delivered' | 'refused' | 'throws') => void (sendMode.current = mode), holdSends: () => {
      let release!: () => void
      let entered!: () => void
      sendHold.gate = new Promise<void>(r => (release = r))
      const reached = new Promise<void>(r => (entered = r))
      sendHold.entered = entered
      return { reached, release: () => release() }
    }, suspend: (ms: number) => void (asleepMs += ms), wipeState, beforeNextRead: (key: string, step: () => Promise<void>) => {
      if (!stateGetHooked) throw new Error('beforeNextRead needs dashboard(on, { stateSteps: true })')
      beforeStateRead.set(key, step)
    }, serversCalled, beforeNextWrite:(key: string, step: () => Promise<void>) => void beforeStateWrite.set(key, step), refuseNextWrite: (key: string) => void refuseNextWrite.add(key), reports: reportCalls, turnActivity: turnActivityCalls, loadPauseReads: [] as typeof reportCalls, unmarked, backgroundRefusals, replyToFileRefusals, agentCall: (method: string, path: string) => { serverPauseRule({ method, path }) }, sequence, unbind: () => void (world.bound = false), bind: () => void (world.bound = true), unboundCalls, holdApi: (ms: number) => void (flags.apiHoldMs = ms), issueReads, stored, relay, seedPending: (texts: string[]) => void (seededPending = texts), seedState, seedRelay: (state: { phase: string; planId: number | null; detail: string | null }) => void (seededRelay = state), release: hung.release, ageLiveAgent: (id: string, ms: number) => void aged.set(id, ms), pacingReads, claimAttempts, designerGradeReads, setDesignerGrade: (given: typeof options.designerGrade) => void (options.designerGrade = given), claimsAllowed, claimsReleased, claimBodies, heldClaims, contextReads, restartCalls, releaseCalls, personDisconnects, toolLists, pacingAttempts, setPacingLine: (given: { body: unknown } | { status: number } | undefined) => void (options.pacingLine = given), setEnv: (name: string, value: string) => void (liveEnv[name] = value), env: (name: string) => liveEnv[name], failUsage: (reason: string | undefined) => void (options.usageReadFails = reason), spawns, runCalls, toastTimeouts, setMcp: (mode: 'up' | 'down' | 'flaky' | 'refused' | 'stale' | 'strictKeys' | 'beforeReplyToFile') => void (options.mcp = mode), failInProgress: (on = true) => void (options.inProgressFails = on), failViewWrite: (on = true) => void (flags.viewWriteFails = on), setListener: (state: string | null) => void (world.listener = state), refusedViewWrites: () => flags.refusedViewWrites, stateWrites, viewClaims: () => new Set(stateWrites.filter(w => w.key === 'gate' && (w.value as any)?.inFlight === true).map(w => (w.value as any).at)).size, failList: (on = true) => void (options.sessionReadFails = on), roster, calls, api, toasts, get versionReads() { return versionReads }, statuses, commands, compactRuns, world, clock, writes: () => api.filter(a => a.method !== 'GET') }
}

// DX-5605: the session's stored events warning (the text its one toast is built from): the latest value the plugin wrote, null while events flow.
// The band draws none of it; this is where a test reads the fact that the band text used to carry.
export const eventsWarned = (d: { stateWrites: { key: string; value: unknown }[] }): string | null =>
  (d.stateWrites.filter(w => w.key === 'eventsWarned').at(-1)?.value as string | undefined) ?? null

// DX-5605: the band draws no events or relay status, whatever the relay or the listener is doing: none of its Text mentions either.
export const bandSilent = async (band: any): Promise<void> => {
  const all = (await band.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
  if (/events|relay/i.test(all)) throw new Error(`the band drew events or relay text: ${all}`)
}

// DX-5605: the relay's stored phase ('off', 'running', 'retrying', 'stopped', ...) as the plugin last wrote it; null before its first write.
export const relayPhase = (d: { stateWrites: { key: string; value: unknown }[] }): string | null =>
  ((d.stateWrites.filter(w => w.key === 'relay').at(-1)?.value as { phase?: string } | undefined)?.phase) ?? null

// DX-4880: the prompts the plugin submitted to the session through the plan event bridge (each carries the relay marker): what wakes an
// idle session, as opposed to `relay.told`, the rows only a later turn reads
export const woken = (d: { relay: { delivered: { text: string }[] } }): string[] => d.relay.delivered.map(x => x.text)

// The model must be able to act on a row: it carries every one of these fields, each as a whole
// token (DX-1 is not found inside DX-12).
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function expectRowCarries(row: string, fields: string[]) {
  for (const field of fields) {
    const token = new RegExp(`(?<![\\w-])${escapeRegExp(field)}(?![\\w-])`)
    expect(token.test(row), `the model row lacks "${field}": ${row}`).toBe(true)
  }
}

// session.start as the engine raises it (the plugin loads the plan, registers its command and
// starts its pacing poll and the relay), then lets the load it kicked off finish.
export async function startSession($: any, d: Dashboard, surface: string) {
  // DX-3900: the engine's order, as a live desktop session logged it. Under the REPL the terminal is the session's first surface. The desktop
  // app hosts a session headless: session.start has surface null (and isInteractive false) with surfaces() already ['desktop'], and the app
  // detaches about 5 s later (surfaces() is [] from then); it attaches again only while the person views the session (viewSession / leaveSession).
  if (surface === 'terminal') {
    d.roster.push('terminal')
    await $.session.start({ cwd: '/work', surface, isInteractive: true })
  } else {
    d.roster.push(surface)
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await leaveSession($, d, surface)
  }
  await d.clock.settle()
  takeLoadPauseReads(d)
}

// CP-8: every plan load reads the agent pause (the title's pause mark). The reports suites count the pause reads of the hooks they test (the Stop
// check), so the start's loads are taken out of `reports` and `sequence` and kept in `loadPauseReads`, like the context reads.
const PAUSE_REPORT = '/api/plan-sessions/me/pause'
export function takeLoadPauseReads(d: Dashboard) {
  for (let i = d.reports.length - 1; i >= 0; i--) if (d.reports[i].path === PAUSE_REPORT) d.loadPauseReads.push(...d.reports.splice(i, 1))
  for (let i = d.sequence.length - 1; i >= 0; i--) if (d.sequence[i] === `report GET ${PAUSE_REPORT}`) d.sequence.splice(i, 1)
}

export async function viewSession($: any, d: Dashboard, surface: string) {
  d.roster.push(surface)
  await $.session.attach({ surface, clientId: `${surface}-2`, viewport: { columns: 71, rows: 44, isFullscreen: true } })
}

export async function leaveSession($: any, d: Dashboard, surface: string) {
  d.roster.splice(d.roster.indexOf(surface), 1)
  await $.session.detach({ surface, clientId: `${surface}-2`, reason: 'detach' })
}

// DX-4234: a session start reaches the model on the FIRST PROMPT's context, beside its time stamp (SessionStart is recorded only: the engine
// has not bound the session then). The stamp is the `clock_time` slot of the bundle's `prompt.submit` text, so a prompt of a session that cannot read the bundle (signed out) has none.
// `startLines` is what the start added: the prompt's context without the stamp line, or undefined when it added nothing.
export const STAMP_LINE = /^(\d\d\/\d\d\/\d{4} )?\d\d:\d\d:\d\d [+-]\d\d:\d\d \+\S/
export async function firstPrompt($: any, source: string, input: Record<string, unknown> = {}): Promise<{ startLines: string[] | undefined; context: string[] }> {
  await $.classic.SessionStart({ source, cwd: '/work', session_id: OWN_SESSION.session_id, transcript_path: '/work/main.jsonl', ...input })
  const r = await $.prompt.submit({ text: 'hello' })
  const context: string[] = r.context ?? []
  const rest = context.filter(line => !STAMP_LINE.test(line))
  return { startLines: rest.length > 0 ? rest : undefined, context }
}

export function expectText(found: { text: string } | undefined, pattern: string | RegExp) {
  expect(found).toBeDefined()
  expect(found!.text).toMatch(pattern)
}

// The footer is one plan button; every test mounts it here, so the site is one line.
export async function mountIndicator($: any, surface: string, modes: string[] = []) {
  return $.ui.mount({ plugin: '50arms', surface, component: 'SessionMode', props: { modes } } as any)
}

// The footer button's text (the one `SessionMode` button), and the band's progress indicator: an Svg whose alt
// carries `N% complete` on the desktop, the text glyph on the terminal (no Svg there).
// DX-4420: the desktop pads the footer label with non-breaking spaces (footer.tsx); the label is what is compared.
export const FOOTER_PAD = / /g
// DX-5605: the indicator is a plain Button keyed `footer-plan` on every surface.
export const footerText = async (ui: any): Promise<string | undefined> => (await ui.find({ key: 'footer-plan' }))?.text?.replace(FOOTER_PAD, '')
export const pressFooter = async (ui: any) => ui.press({ key: 'footer-plan' })

// DX-5605: the team agent the model's session_connect answer carries (PLAN-51), and the band's label read back: the plan id is the link keyed
// `open-plan`, the name the Text after it.
export const AGENT_NAME = 'Katya'
export async function bandLabelOf(ui: any): Promise<string> {
  const ref = (await linksOf(ui)).find(l => l.key === 'open-plan')?.label ?? ''
  const name = ((await ui.find({ type: 'Text', text: /^ · / }))?.text as string | undefined) ?? ''
  return `${ref}${name}`
}

export async function expectIndicator(band: any, surface: string, percent: number) {
  const GLYPHS: [number, string][] = [[0, '○'], [37, '◔'], [62, '◑'], [99, '◕'], [100, '●']]
  const glyph = GLYPHS.find(([max]) => percent <= max)![1]
  if (surface === 'desktop') {
    expect((await band.find({ type: 'Svg' }))?.props.alt).toBe(`${percent}% complete`)
  } else {
    expect(await band.find({ type: 'Svg' })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: glyph })).toBeDefined()
  }
}

// DX-4630: every link the band draws is a Markdown link `[label](url)` (no `Link` element). The one finder: each Markdown
// element's link, as {key, label, href}, the label as written in the markdown (escapes included).
export async function linksOf(ui: any): Promise<{ key: string | undefined; label: string; href: string }[]> {
  return (await ui.findAll({ type: 'Markdown' })).map((m: any) => {
    const match = /^\[(.*)\]\((.*)\)$/s.exec(m.props.text)
    if (match === null) throw new Error(`a Markdown that is not one link: ${m.props.text}`)
    return { key: m.key as string | undefined, label: match[1]!, href: match[2]! }
  })
}

// the band's Needs You badge: its text, or undefined when none is drawn
export async function needsYouBadgeOf(ui: any): Promise<string | undefined> {
  return (await linksOf(ui)).find(l => l.key === 'needs-you')?.label
}

// DX-4630: the plugin opens no page itself: every call the fake dashboard host saw for the in-app browser's server, which stays empty
export const browserCalls = (d: { calls: { server: string }[] }) => d.calls.filter(c => c.server === 'Claude_Browser')

// The model's session_connect as the host runs it (the engine has no implementation of its own): the dashboard connects the plan the call names,
// and the call answers. Registered before the test first uses `$`, like every hook.
export function answerPlanConnect(on: On, d: { world: { planId: number | null } }) {
  on('tool.call', { tool: toolName('session_connect') }, (_$: any, e: any, next: any) => {
    const named = planNumberOf(e.target)
    // a call naming a card is another answerer's (the test's own)
    if (named === undefined && e.target !== undefined) return next(e)
    if (named !== undefined) d.world.planId = named
    // the real answer's envelope (the server's handleConnect): the plan the session is on now
    const text = JSON.stringify({ ok: true, status: 200, body: { session: { planId: d.world.planId } } })
    return { result: {}, text, isError: false } as any
  })
}

// DX-5605: the server holds a team agent for the session (GET /api/plan-sessions/me answers it as `session.agent`); the view is read again so the footer shows it.
export async function holdAgent($: any, d: Dashboard) {
  d.world.agent = { id: 7, name: AGENT_NAME, avatar_url: null }
  await forceRefresh($, d)
}

// DX-4233: there is no polling timer any more, so a refresh a test used to wait 60 s of the fake clock for is asked for here: the
// `/50arms-plan` command forces one, and the load is let to finish.
export async function forceRefresh($: any, d: Dashboard) {
  await $.command.run({ command: '50arms-plan' })
  await d.clock.settle()
}

// DX-4235: what the reports sent, read off the kit's `reports` list: every activity row posted, in order
export const activityRows = (d: Dashboard): any[] => d.reports.filter(r => r.path === '/api/plan-sessions/me/activity').flatMap(r => r.body.activities)
// ... and the finished ones among them
export const finishes = (d: Dashboard): any[] => activityRows(d).filter(r => r.finishedAt !== null)

// DX-4235: the engine's own answers to the events the reports ride (nothing beneath the plugins answers a classic event or a turn's end
// in a test): registered before the test first uses `$`, like every hook.
export function answerReportEvents(on: On) {
  for (const event of ['classic.SubagentStart', 'classic.SubagentStop', 'classic.Stop'] as const) on(event, () => ({}) as any)
  on('turn.complete', () => ({ text: 'done' }) as any)
}

// A drawn tree (`ui.drawn()`): every element in document order, an element's direct element children, the text one element shows (its
// string children) and the texts of every Text beneath a node.
