// DX-4234 (DX-3928): a session that is not on a plan but replaced one that was is told which plan it was on and how many events wait. The
// earlier session is found from the connection records the danx-dashboard MCP server writes (hooks/context/predecessor.ts mirrors its reader);
// the notice is the registry's `plan_restart.waiting_events` text, read through the session's own server.
import { describe, expect, test } from 'claude-code/testing'

import { RESTART_NOTICE_KEY, restartFailureLine } from '../hooks/context/events'
import { SURFACES, dashboard, startSession } from './plan-kit'

const NOTICE = 'This session replaced one on PLAN-23; 3 events wait.'
const noticeBody = { restart: { planId: 23, planName: 'Danxbot plugin', waiting: 3 }, reminders: [{ key: RESTART_NOTICE_KEY, text: NOTICE }] }
// the clock starts 2026-10-03T08:00:00Z
const record = (sessionId: string, over: Record<string, unknown> = {}) => ({ schemaVersion: 3, sessionId, projectKey: '/work', dashboardUrl: 'http://localhost:5555', source: 'session-key', fingerprint: 'f', connectedAt: '2026-10-03T07:00:00.000Z', ...over })
const RESTART_READS = (reads: string[]) => reads.filter(p => p.endsWith('/restart-notice'))

for (const surface of SURFACES) {
  describe(`the restart notice on ${surface}`, () => {
    async function started($: any, on: any, records: Record<string, unknown> | undefined, options: Parameters<typeof dashboard>[1] = { connected: false }) {
      on('classic.SessionStart', () => ({}) as any)
      const d = dashboard(on, options)
      d.world.records = records
      await startSession($, d, surface)
      d.contextReads.length = 0
      return d
    }

    for (const source of ['startup', 'resume'] as const) {
      test(`a not-connected ${source} is told the notice of the earlier session of its project`, async ($, on) => {
        const d = await started($, on, { 'earlier.json': record('earlier') })
        d.world.restart.earlier = { body: noticeBody }
        const r = await $.classic.SessionStart({ source, cwd: '/work' })
        expect(r.additionalContext).toEqual([NOTICE])
        expect(RESTART_READS(d.contextReads)).toEqual(['/api/plan-sessions/earlier/restart-notice'])
      })
    }

    test('after a compaction, and on clear or fork, nothing is read or told', async ($, on) => {
      const d = await started($, on, { 'earlier.json': record('earlier') })
      d.world.restart.earlier = { body: noticeBody }
      for (const source of ['compact', 'clear', 'fork'] as const) {
        expect((await $.classic.SessionStart({ source, cwd: '/work' })).additionalContext).toBeUndefined()
      }
      expect(RESTART_READS(d.contextReads)).toEqual([])
    })

    test('a connected session is told its event text, never the restart notice', async ($, on) => {
      const d = await started($, on, { 'earlier.json': record('earlier') }, {})
      d.world.restart.earlier = { body: noticeBody }
      const r = await $.classic.SessionStart({ source: 'resume', cwd: '/work' })
      expect(r.additionalContext).toEqual(['The session_resume text.'])
      expect(RESTART_READS(d.contextReads)).toEqual([])
    })

    test('no earlier session of the project: quiet (a project that never connected a plan hears nothing)', async ($, on) => {
      const d = await started($, on, { 'other.json': record('other', { projectKey: '/elsewhere' }) })
      expect((await $.classic.SessionStart({ source: 'startup', cwd: '/work' })).additionalContext).toBeUndefined()
      expect(RESTART_READS(d.contextReads)).toEqual([])
    })

    test('no record directory at all: quiet', async ($, on) => {
      const d = await started($, on, undefined)
      expect((await $.classic.SessionStart({ source: 'startup', cwd: '/work' })).additionalContext).toBeUndefined()
      expect(RESTART_READS(d.contextReads)).toEqual([])
    })

    test('an earlier session whose answer is `restart: null` leaves it to the next one', async ($, on) => {
      const d = await started($, on, { 'a.json': record('a', { connectedAt: '2026-10-03T07:30:00.000Z' }), 'b.json': record('b') })
      d.world.restart.b = { body: noticeBody }
      const r = await $.classic.SessionStart({ source: 'startup', cwd: '/work' })
      expect(r.additionalContext).toEqual([NOTICE])
      // newest first: a answered nothing, then b spoke
      expect(RESTART_READS(d.contextReads)).toEqual(['/api/plan-sessions/a/restart-notice', '/api/plan-sessions/b/restart-notice'])
    })

    test('every earlier session answering nothing is quiet', async ($, on) => {
      await started($, on, { 'a.json': record('a'), 'b.json': record('b') })
      expect((await $.classic.SessionStart({ source: 'resume', cwd: '/work' })).additionalContext).toBeUndefined()
    })

    test('a failed lookup is one warning line when no earlier session answered', async ($, on) => {
      const d = await started($, on, { 'a.json': record('a') })
      d.world.restart.a = { status: 500 }
      const r = await $.classic.SessionStart({ source: 'startup', cwd: '/work' })
      expect(r.additionalContext).toEqual([restartFailureLine('no earlier session answered (1 of 1 failed): a: 500: restart boom')])
      expect(r.additionalContext![0]).toMatch(/^⚠ Could not load the restart notice \(.*\)\. Tell the operator if this session should be plan-connected\.$/)
    })

    test('one failing and one answering: the answer speaks, no warning', async ($, on) => {
      const d = await started($, on, { 'a.json': record('a', { connectedAt: '2026-10-03T07:30:00.000Z' }), 'b.json': record('b') })
      d.world.restart.a = { status: 500 }
      d.world.restart.b = { body: noticeBody }
      expect((await $.classic.SessionStart({ source: 'startup', cwd: '/work' })).additionalContext).toEqual([NOTICE])
    })

    test('a notice whose registry row is missing is a failure, never papered over', async ($, on) => {
      const d = await started($, on, { 'a.json': record('a') })
      d.world.restart.a = { body: { restart: { planId: 23 }, reminders: [] } }
      const r = await $.classic.SessionStart({ source: 'startup', cwd: '/work' })
      expect(r.additionalContext![0]).toContain('without its registry text')
    })

    test('a signed-out session is quiet', async ($, on) => {
      const d = await started($, on, { 'a.json': record('a') }, { connected: false, signedOut: 'signed-out' })
      d.world.restart.a = { body: noticeBody }
      expect((await $.classic.SessionStart({ source: 'startup', cwd: '/work' })).additionalContext).toBeUndefined()
    })

    test('records that are not records (other schema, unreadable text) are skipped', async ($, on) => {
      const d = await started($, on, { 'old.json': record('old', { schemaVersion: 2 }), 'junk.json': 'not json', 'ok.json': record('ok') })
      d.world.restart.ok = { body: noticeBody }
      expect((await $.classic.SessionStart({ source: 'startup', cwd: '/work' })).additionalContext).toEqual([NOTICE])
      expect(RESTART_READS(d.contextReads)).toEqual(['/api/plan-sessions/ok/restart-notice'])
    })
  })
}
