// DX-4234: the reader of the MCP server's connection records (hooks/context/predecessor.ts), which must apply the rules of danxbot's
// `findPredecessorCandidates` and `projectKeyOf` (packages/danx-dashboard-mcp/src/session-connection.ts).
import { describe, expect, test } from 'claude-code/testing'

import { MAX_CANDIDATES, STALE_RECORD_MS, asRecord, predecessors, projectKeyOf } from '../hooks/context/predecessor'

const NOW = Date.parse('2026-10-03T08:00:00.000Z')
const rec = (sessionId: string, over: Record<string, unknown> = {}) => asRecord({ schemaVersion: 3, sessionId, projectKey: '/work', connectedAt: '2026-10-03T07:00:00.000Z', ...over })!

describe('projectKeyOf', () => {
  test('a Windows path takes forward slashes and a lower-case drive: every spelling of one directory is one key', () => {
    expect(projectKeyOf('C:\\Work\\p')).toBe('c:/Work/p')
    expect(projectKeyOf('c:/Work/p')).toBe('c:/Work/p')
    expect(projectKeyOf('C:\\Work\\p\\')).toBe('c:/Work/p')
    expect(projectKeyOf('C:\\Work\\x\\..\\p')).toBe('c:/Work/p')
  })

  test('a POSIX path is normalised without a drive', () => {
    expect(projectKeyOf('/work/p/')).toBe('/work/p')
    expect(projectKeyOf('/work//p/./q/..')).toBe('/work/p')
  })
})

describe('asRecord', () => {
  test('reads schema 3 and nothing else', () => {
    expect(asRecord({ schemaVersion: 3, sessionId: 's', projectKey: '/w', connectedAt: 'x' })).toEqual({ sessionId: 's', projectKey: '/w', connectedAt: 'x' })
    expect(asRecord({ schemaVersion: 2, sessionId: 's', projectKey: '/w', connectedAt: 'x' })).toBeNull()
    expect(asRecord({ schemaVersion: 3, sessionId: '', projectKey: '/w', connectedAt: 'x' })).toBeNull()
    expect(asRecord({ schemaVersion: 3, sessionId: 's', connectedAt: 'x' })).toBeNull()
    expect(asRecord(null)).toBeNull()
    expect(asRecord('text')).toBeNull()
  })
})

describe('predecessors', () => {
  test('the same project only, in either spelling of a Windows path', () => {
    const records = [rec('a', { projectKey: 'c:/Work/p' }), rec('b', { projectKey: '/elsewhere' })]
    expect(predecessors(records, 'C:\\Work\\p', 'me', NOW)).toEqual(['a'])
  })

  test('never the asking session', () => {
    expect(predecessors([rec('me'), rec('a')], '/work', 'me', NOW)).toEqual(['a'])
  })

  test('never a record older than seven days; exactly seven days is still in', () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString()
    const records = [rec('old', { connectedAt: at(STALE_RECORD_MS + 1) }), rec('edge', { connectedAt: at(STALE_RECORD_MS) }), rec('bad', { connectedAt: 'not a date' })]
    expect(predecessors(records, '/work', 'me', NOW)).toEqual(['edge'])
  })

  test('newest connection first, at most ten', () => {
    const records = Array.from({ length: 14 }, (_, i) => rec(`s${i}`, { connectedAt: new Date(NOW - (i + 1) * 60_000).toISOString() }))
    const found = predecessors([...records].reverse(), '/work', 'me', NOW)
    expect(found).toHaveLength(MAX_CANDIDATES)
    expect(found[0]).toBe('s0')
    expect(found[9]).toBe('s9')
  })
})
