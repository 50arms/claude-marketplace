import "./run-tests-with-npm-test.generated"
// CP-57: the pure half of the hook that posts a recorded test run (hooks/context/test-run.ts).
import { describe, expect, test } from 'claude-code/testing'

import { RECORD_MARKER as SCRIPT_MARKER } from '../scripts/lib/test-run.mjs'
import { RECORD_MARKER, testRunPost, testRunRecordPath } from '../hooks/context/test-run'

const record = (over: object = {}) => JSON.stringify({ card: 'DX-9', text: 'Tests passed.', metadata: { kind: 'test_run', commit_sha: 'a'.repeat(40) }, ...over })

describe('the marker', () => {
  test('the script prints the marker the hook reads', () => expect(SCRIPT_MARKER).toBe(RECORD_MARKER))
})

describe('testRunRecordPath', () => {
  test('finds the marker line in a result', () => expect(testRunRecordPath('ok\nDANXBOT_TEST_RUN_RECORD /tmp/a b.json\nmore')).toBe('/tmp/a b.json'))
  test('ignores text that only mentions the marker', () => expect(testRunRecordPath('echo DANXBOT_TEST_RUN_RECORD /tmp/x')).toBeNull())
  test('ignores a non-string', () => expect(testRunRecordPath(undefined)).toBeNull())
})

describe('testRunPost', () => {
  test('posts the note to the record card', () => {
    expect(testRunPost(record())).toEqual({ path: '/api/issues/DX-9/notes', body: { text: 'Tests passed.', metadata: { kind: 'test_run', commit_sha: 'a'.repeat(40) } } })
  })
  test('refuses a record that is not JSON, names no card, or is not a test_run', () => {
    expect(testRunPost('nope')).toHaveProperty('error')
    expect(testRunPost(record({ card: '../x' }))).toHaveProperty('error')
    expect(testRunPost(record({ metadata: { kind: 'other' } }))).toHaveProperty('error')
  })
})
