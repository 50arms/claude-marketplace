import "./run-tests-with-npm-test.generated"
// CP-146: the pure parts of the policy bundle: what a bundle read answers, when a held bundle may be used, how one plugin event is decided from it
// (matcher, frequency per agent context, slots, the over-cap pointer), the floor lines, the hold and the report queue. No host: each case hands the
// functions facts and reads their verdicts.
import { describe, expect, test } from 'claude-code/testing'

import { BundleShapeError, bundleFileOf, bundleQuery, changeSignalOf, compareVersions, contextKey, decide, deliveredText, fillSlots, floorIsStale, globMatches, isCurrent, matcherHolds, readBundleBody, relayStreams, startsNewContext } from '../hooks/bundle/bundle'
import type { Bundle, BundleAttachment, BundleEvent } from '../hooks/bundle/bundle'
import { HOLD_LINES, LOADING_LINE, SIGN_IN_INVITATION, TOLD_ON, floorBody, floorLines, floorText } from '../hooks/bundle/floor'
import { RETRY_WINDOW_MS, failureOf, holdOn, holdReport, leavesReadyList, phaseOf, refusalOf, release, reportStepOf, timeoutFailure } from '../hooks/bundle/hold'
import { settleOwed } from '../hooks/bundle/state'
import { EMPTY_QUEUE, RETRY_DELAYS_MS, dueRequests, enqueueDelivery, enqueueFloor, enqueueHold, hasFloorPending, settleFailure, settleOk, toTell, deliveryItem } from '../hooks/bundle/reports'

const V1 = 'a'.repeat(64)
const V2 = 'b'.repeat(64)
const RULE = { ref: 'BPR-1', content_hash: 'h1' }

const section = (text: string, rules = [RULE]) => ({ label: 'BP-1', kind: 'policy', text, chars: [...text].length, rules, slots: [] as string[] })
const attachment = (id: number, text: string, over: Partial<BundleAttachment> = {}): BundleAttachment => ({ attachment_id: id, mechanism: 'plugin.context', frequency: 'every', matcher: null, sections: [section(text)], ...over })
const event = (key: string, attachments: BundleAttachment[], over: Partial<BundleEvent> = {}): BundleEvent => ({
  event: key,
  matchers: [],
  hook_slots: [],
  mechanisms: [{ mechanism: 'plugin.context', cap: 100, over_cap_pointer: 'It is {{slot:chars}} characters: read {{slot:carrier_file}}.' }, { mechanism: 'plugin.subagent_start', cap: null, over_cap_pointer: null }],
  attachments,
  computed: [],
  ...over,
})
const bundle = (events: BundleEvent[], version = V1): Bundle => ({ version, min_plugin_version: '0.17.167', floor_lines_plugin_version: null, events })
const moment = (key: string, over = {}) => ({ event: key, matchers: {}, slots: {}, card: null as string | null, mechanisms: null as readonly string[] | null, ...over })

describe('reading a bundle answer', () => {
  const body = { version: V1, min_plugin_version: '0.17.167', floor_lines_plugin_version: null, events: [{ event: 'session.start', matchers: [], hook_slots: ['clock_time'], mechanisms: [{ mechanism: 'plugin.context', cap: 10000, over_cap_pointer: 'p' }], attachments: [{ attachment_id: 7, mechanism: 'plugin.context', frequency: 'once_per_session', matcher: null, sections: [section('hello')] }], computed: [] }] }

  test('reads a bundle', () => {
    const r = readBundleBody(body)
    expect(r.kind).toBe('bundle')
    if (r.kind === 'bundle') expect(r.bundle.events[0]?.attachments[0]?.attachment_id).toBe(7)
  })

  test('reads the unchanged answer with the floor version', () => {
    expect(readBundleBody({ version: V1, unchanged: true, floor_lines_plugin_version: '0.17.167' })).toEqual({ kind: 'unchanged', version: V1, floorLinesPluginVersion: '0.17.167' })
  })

  test('refuses an answer it cannot read, naming what is wrong', () => {
    expect(() => readBundleBody({ ...body, version: 'x' })).toThrow(BundleShapeError)
    expect(() => readBundleBody({ ...body, events: 'nope' })).toThrow(/events is not a list/)
    expect(() => readBundleBody({ version: V1, events: [] })).toThrow(/floor_lines_plugin_version/)
  })

  test('refuses a frequency it does not know instead of guessing every', () => {
    const odd = { ...body, events: [{ ...body.events[0], attachments: [{ ...body.events[0]!.attachments[0], frequency: 'weekly' }] }] }
    expect(() => readBundleBody(odd)).toThrow(/frequency "weekly"/)
  })

  test('the read names the plugin version, and the held version once there is one', () => {
    expect(bundleQuery('0.17.167', null)).toEqual({ plugin_version: '0.17.167' })
    expect(bundleQuery('0.17.167', V1)).toEqual({ plugin_version: '0.17.167', known_version: V1 })
  })
})

describe('versions', () => {
  test('compares by numeric parts, never as strings', () => {
    expect(compareVersions('0.17.9', '0.17.10')).toBe(-1)
    expect(compareVersions('0.17', '0.17.0')).toBe(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
  })

  test('the floor is stale when the team holds none or an older version', () => {
    expect(floorIsStale(null, '0.17.167')).toBe(true)
    expect(floorIsStale('0.17.9', '0.17.167')).toBe(true)
    expect(floorIsStale('0.17.167', '0.17.167')).toBe(false)
    expect(floorIsStale('0.18.0', '0.17.167')).toBe(false)
  })
})

describe('when a held bundle may be used', () => {
  const held = (confirmedAt: number) => ({ bundle: bundle([]), confirmedAt })
  const file = (version: string) => ({ kind: 'file' as const, version })
  const down = { kind: 'down' as const, why: null }

  test('current while the relay streams and its session file names its version', () => {
    expect(isCurrent(held(0), file(V1), 10 * 60_000)).toBe(true)
    expect(isCurrent(held(0), file(V2), 1)).toBe(false)
  })

  test('no change signal: current for 90 s after the answer that confirmed it, then not', () => {
    expect(isCurrent(held(1000), down, 1000 + 89_999)).toBe(true)
    expect(isCurrent(held(1000), down, 1000 + 90_000)).toBe(false)
    expect(isCurrent(held(1000), { kind: 'down', why: 'x' }, 1000 + 90_000)).toBe(false)
  })

  test('no bundle held is never current', () => {
    expect(isCurrent(null, file(V1), 0)).toBe(false)
  })

  test('the session file counts only while the plugin relay streams: the MCP never removes it when its stream stops', () => {
    expect(relayStreams('streaming')).toBe(true)
    expect(relayStreams('held')).toBe(true)
    for (const phase of ['off', 'retrying', 'stopped'] as const) expect(relayStreams(phase)).toBe(false)
    expect(changeSignalOf(true, { kind: 'version', version: V1 })).toEqual({ kind: 'file', version: V1 })
    expect(changeSignalOf(false, { kind: 'version', version: V1 })).toEqual({ kind: 'down', why: null })
    expect(changeSignalOf(true, { kind: 'absent' })).toEqual({ kind: 'down', why: null })
    expect(changeSignalOf(true, { kind: 'unreadable', reason: 'not JSON' })).toEqual({ kind: 'down', why: 'not JSON' })
  })

  test('reads the relay session file, and refuses one of another session or another shape', () => {
    expect(bundleFileOf(null, 's1')).toEqual({ kind: 'absent' })
    expect(bundleFileOf(JSON.stringify({ v: 1, sessionId: 's1', version: V1 }), 's1')).toEqual({ kind: 'version', version: V1 })
    expect(bundleFileOf(JSON.stringify({ v: 1, sessionId: 's2', version: V1 }), 's1').kind).toBe('unreadable')
    expect(bundleFileOf('{', 's1').kind).toBe('unreadable')
    expect(bundleFileOf(JSON.stringify({ v: 2, sessionId: 's1', version: V1 }), 's1').kind).toBe('unreadable')
  })
})

describe('owed start events', () => {
  const owed = { main: ['session.start', 'session.after_compaction'], a1: ['subagent.start'] }

  test('a prompt tells them with its own event, the refusal of a tool call tells only them, any other call leaves them owed', () => {
    expect(settleOwed(owed, 'main', 'prompt.submit', 'with')).toEqual({ events: ['session.start', 'session.after_compaction'], owed: { a1: ['subagent.start'] } })
    expect(settleOwed(owed, 'main', 'tool.before', 'only')).toEqual({ events: ['session.start', 'session.after_compaction'], owed: { a1: ['subagent.start'] } })
    expect(settleOwed(owed, 'main', 'turn.stop', 'none')).toEqual({ events: [], owed })
  })

  test('an owed event a call tells itself is told once: it leaves the list and is not told again with the owed ones', () => {
    expect(settleOwed(owed, 'main', 'session.start', 'none')).toEqual({ events: [], owed: { main: ['session.after_compaction'], a1: ['subagent.start'] } })
    expect(settleOwed(owed, 'main', 'session.start', 'with')).toEqual({ events: ['session.after_compaction'], owed: { a1: ['subagent.start'] } })
  })
})

describe('matching and slots', () => {
  test('globs: * any run, ? one character, the rest literal', () => {
    expect(globMatches('Bash', 'Bash')).toBe(true)
    expect(globMatches('mcp__*__50arms_api', 'mcp__plugin_50arms_platform__50arms_api')).toBe(true)
    expect(globMatches('git p?sh*', 'git push origin')).toBe(true)
    expect(globMatches('a.b', 'axb')).toBe(false)
  })

  test('a matcher holds when every field it names matches; none matches every call', () => {
    expect(matcherHolds(null, {})).toBe(true)
    expect(matcherHolds({ tool_name: 'Bash' }, { tool_name: 'Bash' })).toBe(true)
    expect(matcherHolds({ tool_name: 'Bash' }, { tool_name: 'Edit' })).toBe(false)
    expect(matcherHolds({ tool_name: 'Bash', tool_command: 'git *' }, { tool_name: 'Bash' })).toBe(false)
  })

  test('fills a slot and names one it cannot fill, never leaving a blank', () => {
    expect(fillSlots('It is {{slot:clock_time}}.', { clock_time: '12:00' })).toEqual({ text: 'It is 12:00.', missing: [] })
    const r = fillSlots('Hi {{slot:who}} and {{slot:who}}', {})
    expect(r.missing).toEqual(['who'])
    expect(r.text).toBe('Hi [who unavailable] and [who unavailable]')
  })
})

describe('deciding an event from the bundle', () => {
  test('delivers the attachments that match, joined per mechanism, and reports what the bundle named', () => {
    const b = bundle([event('tool.before', [attachment(1, 'one', { matcher: { tool_name: 'Bash' } }), attachment(2, 'two', { matcher: { tool_name: 'Edit' } }), attachment(3, 'three')])])
    const d = decide(b, moment('tool.before', { matchers: { tool_name: 'Bash' } }), {})
    expect(d.deliveries).toHaveLength(1)
    expect(d.deliveries[0]?.text).toBe('one\n\nthree')
    expect(d.deliveries[0]?.attachmentIds).toEqual([1, 3])
    expect(d.deliveries[0]?.chars).toBe(8)
    expect(d.deliveries[0]?.rules).toEqual([RULE])
  })

  test('an event the bundle does not list delivers nothing', () => {
    expect(decide(bundle([]), moment('session.start'), {}).deliveries).toEqual([])
  })

  test('a once_per_session text is told once per agent context, and a sub-agent is its own context', () => {
    const b = bundle([event('subagent.start', [attachment(1, 'mantra', { frequency: 'once_per_session' })])])
    const first = decide(b, moment('subagent.start'), {})
    expect(first.deliveries).toHaveLength(1)
    expect(decide(b, moment('subagent.start'), first.told).deliveries).toHaveLength(0)
    // another sub-agent holds its own record
    const told = { a1: first.told, a2: {} }
    expect(decide(b, moment('subagent.start'), told.a2).deliveries).toHaveLength(1)
    expect(contextKey(null)).toBe('main')
    expect(contextKey('a1')).toBe('a1')
  })

  test('a once_per_card_per_session text is told again for another card', () => {
    const b = bundle([event('prompt.submit', [attachment(1, 'card text', { frequency: 'once_per_card_per_session' })])])
    const one = decide(b, moment('prompt.submit', { card: 'X-1' }), {})
    expect(one.deliveries).toHaveLength(1)
    expect(decide(b, moment('prompt.submit', { card: 'X-1' }), one.told).deliveries).toHaveLength(0)
    expect(decide(b, moment('prompt.submit', { card: 'X-2' }), one.told).deliveries).toHaveLength(1)
  })

  test('a compaction or clear starts the context again: once-only texts are told again on the first event after it', () => {
    const b = bundle([event('session.after_compaction', [attachment(1, 'briefing', { frequency: 'once_per_session' })])])
    const first = decide(b, moment('session.after_compaction'), {})
    expect(first.deliveries).toHaveLength(1)
    // the same event again: the compaction itself restarts the count
    expect(decide(b, moment('session.after_compaction'), first.told).deliveries).toHaveLength(1)
    expect(startsNewContext('session.after_compaction')).toBe(true)
    expect(startsNewContext('session.after_clear')).toBe(true)
    expect(startsNewContext('subagent.compacted')).toBe(true)
    expect(startsNewContext('prompt.submit')).toBe(false)
  })

  test('computed sections follow the attachments, by the mechanism and frequency the bundle names, with no attachment id', () => {
    const b = bundle([event('session.after_compaction', [attachment(1, 'a')], { computed: [{ key: 'plan_event_text', mechanism: 'plugin.context', frequency: 'every', text: 'plan text', chars: 9, rules: [] }] })])
    const d = decide(b, moment('session.after_compaction'), {})
    expect(d.deliveries.map(x => [x.computedKey, x.text, x.attachmentIds])).toEqual([[null, 'a', [1]], ['plan_event_text', 'plan text', []]])
  })

  test('fills the slots the plugin owns, and a slot it cannot fill is a line naming the slot and the event', () => {
    const b = bundle([event('prompt.submit', [attachment(1, 'It is {{slot:clock_time}} and {{slot:mood}}.')])])
    const d = decide(b, moment('prompt.submit', { slots: { clock_time: '12:00' } }), {}).deliveries[0]!
    expect(d.text).toContain('It is 12:00 and [mood unavailable].')
    expect(d.text).toContain('"mood" of the "prompt.submit" event')
    expect(d.missingSlots).toEqual(['mood'])
  })

  test('an over-cap text is delivered as the bundle pointer with the length and the file it was written to', () => {
    const long = 'x'.repeat(150)
    const b = bundle([event('session.start', [attachment(1, long)])])
    const d = decide(b, moment('session.start'), {}).deliveries[0]!
    expect(d.overCap).toEqual({ cap: 100, pointer: 'It is {{slot:chars}} characters: read {{slot:carrier_file}}.', fullChars: 150 })
    expect(d.text).toBe(long)
    expect(deliveredText(d, '/tmp/full.txt')).toBe('It is 150 characters: read /tmp/full.txt.')
  })

  test('a text of a mechanism the hook does not carry is never decided: it is not counted told and not delivered', () => {
    const b = bundle([event('turn.stop', [attachment(1, 'context text'), attachment(2, 'stop text', { mechanism: 'plugin.subagent_start' })])])
    const first = decide(b, moment('turn.stop', { mechanisms: ['plugin.subagent_start'] }), {})
    expect(first.deliveries.map(d => d.text)).toEqual(['stop text'])
    expect(first.told['att:1']).toBeUndefined()
  })

  test('a mechanism the event does not list is a shape error, not a guess', () => {
    const b = bundle([event('session.start', [attachment(1, 'x', { mechanism: 'plugin.nope' })])])
    expect(() => decide(b, moment('session.start'), {})).toThrow(BundleShapeError)
  })
})

describe('the floor', () => {
  test('the set has one line per (reason, event), each at most 10,000 characters, with no value of one session baked in', () => {
    const lines = floorLines()
    const identities = lines.map(l => `${l.reason}/${l.event}`)
    expect(new Set(identities).size).toBe(identities.length)
    expect(lines.length).toBeLessThanOrEqual(100)
    for (const l of lines) expect([...l.text].length).toBeLessThanOrEqual(10_000)
    expect(lines.find(l => l.reason === 'signed_out')).toEqual({ reason: 'signed_out', event: 'signed_out', text: SIGN_IN_INVITATION })
    expect(lines.find(l => l.reason === 'key_revoked')?.event).toBe('key.revoked')
    expect(lines.find(l => l.reason === 'dashboard_unreachable')?.event).toBe('dashboard.unreachable')
    expect(lines.find(l => l.reason === 'relay_broken')?.event).toBe('relay.broken')
    expect(lines.filter(l => l.reason === 'loading').map(l => l.event)).toEqual([...TOLD_ON])
    expect(TOLD_ON).toContain('prompt.submit')
    expect(floorBody('0.17.167').plugin_version).toBe('0.17.167')
  })

  test('no floor line points at the reminders route', () => {
    for (const l of floorLines()) expect(l.text).not.toContain('/api/reminders')
  })

  test('a line is filled with this session values, and a missing one is named', () => {
    expect(floorText('loading', { reason: 'a 503' })).toContain('(a 503)')
    expect(floorText('plugin_outdated', { reason: 'r', since: 's' })).toContain('[need_version unknown]')
    expect(HOLD_LINES.key_revoked).toContain('sign in again')
    expect(LOADING_LINE).toContain('retry')
  })
})

describe('holds', () => {
  const fail = (over = {}) => ({ status: 0, body: {}, serverNotConnected: false, classifierRefused: false, keyRevoked: false, relayDown: null as { why: string | null } | null, ...over })

  test('reads why the fetch failed', () => {
    expect(failureOf(fail({ keyRevoked: true })).reason).toBe('key_revoked')
    expect(failureOf(fail({ classifierRefused: true })).reason).toBe('classifier_refused')
    expect(failureOf(fail({ serverNotConnected: true })).reason).toBe('dashboard_unreachable')
    const unreachable = failureOf(fail({ status: 503, body: { error: 'dashboard_unreachable', unreachable_since: '2026-01-01T00:00:00.000Z', detail: 'HTTP 503' } }))
    expect(unreachable.reason).toBe('dashboard_unreachable')
    expect(unreachable.values.unreachable_since).toBe('2026-01-01T00:00:00.000Z')
    const outdated = failureOf(fail({ status: 426, body: { error: 'mcp_outdated', plugin: { have: null, need: '0.17.167' } } }))
    expect(outdated.reason).toBe('plugin_outdated')
    expect(outdated.values.need_version).toBe('0.17.167')
    expect(failureOf(fail({ status: 500, body: { error: 'boom' } })).reason).toBe('fetch_failed')
  })

  test('a value the plugin does not know is left out of the hold line, so the line names it unknown', () => {
    const notConnected = failureOf(fail({ serverNotConnected: true }))
    expect(notConnected.values).toEqual({})
    expect(refusalOf(holdOn({}, 'main', notConnected, 'tool.before', 0).main!, RETRY_WINDOW_MS)).toContain('[unreachable_since unknown]')
    const noNeed = failureOf(fail({ status: 426, body: {} }))
    expect(noNeed.values).toEqual({})
    expect(refusalOf(holdOn({}, 'main', noNeed, 'tool.before', 0).main!, RETRY_WINDOW_MS)).toContain('[need_version unknown]')
    expect(failureOf(fail({ status: 503, body: { error: 'dashboard_unreachable' } })).values).toEqual({})
  })

  test('relay down while a bundle is held: a fetch that fails is the failed check for a change, the relay_broken hold, naming why when the session file could not be read', () => {
    const f = failureOf(fail({ status: 500, body: { error: 'boom' }, relayDown: { why: 'the session file is not JSON' } }))
    expect(f.reason).toBe('relay_broken')
    expect(f.detail).toContain('the session file is not JSON')
    expect(failureOf(fail({ serverNotConnected: true, relayDown: { why: null } })).reason).toBe('relay_broken')
    expect(timeoutFailure({ why: null }).reason).toBe('relay_broken')
    expect(timeoutFailure(null).reason).toBe('fetch_failed')
    // a failure whose own line tells the fix keeps its reason
    expect(failureOf(fail({ keyRevoked: true, relayDown: { why: null } })).reason).toBe('key_revoked')
    expect(failureOf(fail({ status: 426, body: { plugin: { need: '1.0.0' } }, relayDown: { why: null } })).reason).toBe('plugin_outdated')
    expect(failureOf(fail({ status: 503, body: { error: 'dashboard_unreachable' }, relayDown: { why: null } })).reason).toBe('dashboard_unreachable')
  })

  test('the loading line for the first 2 minutes, then the hold line naming the reason and since when', () => {
    const f = failureOf(fail({ status: 426, body: { plugin: { need: '0.17.200' } } }))
    const holds = holdOn({}, 'main', f, 'tool.before', 1_000)
    const hold = holds.main!
    expect(phaseOf(hold, 1_000 + RETRY_WINDOW_MS - 1)).toBe('loading')
    expect(refusalOf(hold, 1_000 + 30_000)).toContain('loading')
    expect(phaseOf(hold, 1_000 + RETRY_WINDOW_MS)).toBe('held')
    const line = refusalOf(hold, 1_000 + RETRY_WINDOW_MS)
    expect(line).toContain('critical 50 Arms bug')
    expect(line).toContain('0.17.200')
    expect(line).toContain(new Date(1_000).toISOString())
  })

  test('a later failure keeps the time the hold began and the event it began on', () => {
    const a = holdOn({}, 'main', failureOf(fail()), 'tool.before', 1_000)
    const b = holdOn(a, 'main', failureOf(fail({ keyRevoked: true })), 'prompt.submit', 50_000)
    expect(b.main?.since).toBe(1_000)
    expect(b.main?.event).toBe('tool.before')
    expect(b.main?.reason).toBe('key_revoked')
  })

  test("one context's hold holds no other", () => {
    const holds = holdOn({}, 'a1', failureOf(fail()), 'subagent.start', 1)
    expect(holds.main).toBeUndefined()
    expect(release(holds, 'a1').ended?.reason).toBe('fetch_failed')
    expect(release(holds, 'main').ended).toBeNull()
  })

  test('the ready list is left only once the hold line starts, never during the loading window', () => {
    const hold = holdOn({}, 'main', failureOf(fail()), 'tool.before', 0).main!
    expect(leavesReadyList(hold, 30_000)).toBe(false)
    expect(leavesReadyList(hold, RETRY_WINDOW_MS)).toBe(true)
    expect(leavesReadyList(undefined, RETRY_WINDOW_MS)).toBe(false)
  })

  test('the hold report: open once the hold line starts, the end once released, with agent_id null for the main conversation', () => {
    const hold = holdOn({}, 'main', failureOf(fail()), 'tool.before', 0).main!
    expect(reportStepOf(hold, 'loading', false)).toBe('none')
    expect(reportStepOf(hold, 'held', false)).toBe('open')
    expect(reportStepOf({ ...hold, reported: 'open' }, 'held', false)).toBe('none')
    expect(reportStepOf({ ...hold, reported: 'open' }, 'held', true)).toBe('ended')
    // a hold that ended inside the loading window was never reported open and needs no report
    expect(reportStepOf(hold, 'loading', true)).toBe('none')
    const item = holdReport(hold, null, '0.17.167', null)
    expect(item).toEqual({ kind: 'hold', reason: 'fetch_failed', event: 'tool.before', agent_id: null, plugin_version: '0.17.167', started_at: new Date(0).toISOString() })
    expect(holdReport(hold, 'a1', '0.17.167', '2026-01-01T00:00:00.000Z').ended_at).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('the report queue', () => {
  const delivery = (id: number) => deliveryItem(V1, { event: 'session.start', mechanism: 'plugin.context', text: 't', chars: 1, attachmentIds: [id], rules: [RULE], computedKey: null, missingSlots: [], overCap: null }, '2026-01-01T00:00:00.000Z')

  test('a delivery item is the route shape: the version, event, attachments, mechanism, rules and characters as the bundle named them', () => {
    expect(delivery(5)).toEqual({ kind: 'delivery', version: V1, event: 'session.start', attachment_ids: [5], mechanism: 'plugin.context', rules: [RULE], chars: 1, delivered_at: '2026-01-01T00:00:00.000Z' })
  })

  test('deliveries are batched; a hold and a floor send each go in a request of their own', () => {
    let q = enqueueDelivery(EMPTY_QUEUE, delivery(1), 'main', 0)
    q = enqueueDelivery(q, delivery(2), 'main', 0)
    q = enqueueHold(q, { kind: 'hold' }, 'main', 0)
    q = enqueueFloor(q, { plugin_version: '0.17.167', lines: [] }, 0)
    const requests = dueRequests(q, 0)
    expect(requests.map(r => [r.path, r.ids.length])).toEqual([['reports', 2], ['reports', 1], ['floor', 1]])
    expect(hasFloorPending(q)).toBe(true)
  })

  test('only the newest floor set is kept pending', () => {
    const q = enqueueFloor(enqueueFloor(EMPTY_QUEUE, { v: 1 }, 0), { v: 2 }, 0)
    expect(q.entries.filter(e => e.route === 'floor').map(e => e.item)).toEqual([{ v: 2 }])
  })

  test('a sent report leaves the queue', () => {
    const q = enqueueDelivery(EMPTY_QUEUE, delivery(1), 'main', 0)
    expect(settleOk(q, [1]).entries).toEqual([])
  })

  test('a failed report waits 1, 2 and 4 minutes and then fails loudly, naming the agent context once and sending report_failed on its own', () => {
    let q = enqueueDelivery(EMPTY_QUEUE, delivery(1), 'a1', 0)
    let now = 0
    for (const delay of RETRY_DELAYS_MS) {
      const s = settleFailure(q, [1], 503, 'unreachable', now, '0.17.167')
      expect(s.loud).toEqual([])
      q = s.queue
      expect(q.entries[0]?.nextAt).toBe(now + delay)
      expect(dueRequests(q, now + delay - 1)).toEqual([])
      now += delay
    }
    const last = settleFailure(q, [1], 503, 'unreachable', now, '0.17.167')
    expect(last.loud).toHaveLength(1)
    expect(last.loud[0]?.contexts).toEqual(['a1'])
    expect(last.queue.failed).toContain('delivery report failed')
    // the delivery is dropped; a report_failed is queued, in a request of its own
    expect(last.queue.entries.map(e => e.what)).toEqual(['report_failed report'])
    expect(dueRequests(last.queue, now)[0]?.body).toEqual({ reports: [{ kind: 'report_failed', reason: last.queue.failed, plugin_version: '0.17.167', at: new Date(now).toISOString() }] })
    const told = toTell(last.queue, last.loud)
    expect(told.contexts).toEqual(['a1'])
    expect(toTell(told.queue, last.loud).contexts).toEqual([])
  })

  test('a 400 is not retried: it fails loudly at once', () => {
    const q = enqueueDelivery(EMPTY_QUEUE, delivery(1), 'main', 0)
    const s = settleFailure(q, [1], 400, 'contract mismatch', 5, '0.17.167')
    expect(s.loud[0]?.reason).toContain('refused it (400)')
    expect(s.queue.entries.map(e => e.what)).toEqual(['report_failed report'])
  })

  test('a 428 (a sign-off the plugin never gives) fails loudly like a 400', () => {
    const q = enqueueDelivery(EMPTY_QUEUE, delivery(1), 'main', 0)
    expect(settleFailure(q, [1], 428, 'behavior_signoffs_required', 5, '0.17.167').loud).toHaveLength(1)
  })

  test('a hold report or a report_failed that fails loudly reports nothing further', () => {
    const hold = enqueueHold(EMPTY_QUEUE, { kind: 'hold' }, 'main', 0)
    const h = settleFailure(hold, [1], 400, 'no', 0, '0.17.167')
    expect(h.loud).toHaveLength(1)
    expect(h.queue.entries).toEqual([])
    const failed = settleFailure(enqueueDelivery(EMPTY_QUEUE, delivery(1), null, 0), [1], 400, 'no', 0, '0.17.167')
    const again = settleFailure(failed.queue, [2], 400, 'no', 0, '0.17.167')
    expect(again.loud).toHaveLength(1)
    expect(again.queue.entries).toEqual([])
  })

  test('a failed floor send follows the same bound', () => {
    const q = enqueueFloor(EMPTY_QUEUE, { plugin_version: '0.17.167', lines: [] }, 0)
    const s = settleFailure(q, [1], 400, 'refused', 0, '0.17.167')
    expect(s.loud[0]?.what).toBe('floor send')
    expect(s.queue.entries.map(e => e.what)).toEqual(['report_failed report'])
  })
})
