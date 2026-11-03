import "./run-tests-with-npm-test.generated"
// CP-57: the pure half of the hook that posts a recorded test run (hooks/context/test-run.ts).
import { describe, expect, test } from 'claude-code/testing'

import { RECORD_MARKER as SCRIPT_MARKER } from '../scripts/lib/test-run.mjs'
import { pathOfFileUrl, recorderPath, withRecorderVar } from '../scripts/lib/recorder-var.mjs'
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

describe('pathOfFileUrl', () => {
  test('a Windows file URL becomes a drive path with forward slashes and decoded spaces', () => {
    expect(pathOfFileUrl('file:///C:/Users/a%20b/plugin/scripts/record-test-run.mjs')).toBe('C:/Users/a b/plugin/scripts/record-test-run.mjs')
  })
  test('a POSIX file URL keeps its path', () => expect(pathOfFileUrl('file:///app/danxbot/scripts/x.mjs')).toBe('/app/danxbot/scripts/x.mjs'))
})

describe('recorderPath', () => {
  test('names the recorder script in the scripts folder beside lib, decoded', () => {
    expect(recorderPath()).toMatch(/\/scripts\/record-test-run\.mjs$/)
    expect(recorderPath()).not.toContain('%')
    expect(recorderPath()).toBe(pathOfFileUrl(new URL('../scripts/record-test-run.mjs', import.meta.url).href))
  })
})

describe('withRecorderVar', () => {
  const CMD = 'node "$DANXBOT_TEST_RECORDER" -- true'
  test('exports the variable first, quoting a path with a space and an apostrophe', () => {
    expect(withRecorderVar(CMD, "/p/it's here.mjs", false)).toBe(`export DANXBOT_TEST_RECORDER='/p/it'\\''s here.mjs'; ${CMD}`)
  })
  test('a non-string command comes back as it is', () => expect(withRecorderVar(undefined, '/p.mjs', false)).toBeUndefined())
  const exported = (command: string) => (withRecorderVar(command, '/p.mjs', false) as string).startsWith('export DANXBOT_TEST_RECORDER=/p.mjs; ')
  test('the braced form is matched', () => expect(exported('node "${DANXBOT_TEST_RECORDER}" -- x')).toBe(true))
  test('the fail-loud form with a colon is matched', () => expect(exported('node "${DANXBOT_TEST_RECORDER:?DANXBOT_TEST_RECORDER is not set}" -- x')).toBe(true))
  test('the fail-loud form without a colon is matched', () => expect(exported('node "${DANXBOT_TEST_RECORDER?not set}" -- x')).toBe(true))
  test('a longer name is not matched', () => expect(withRecorderVar('echo "${DANXBOT_TEST_RECORDER_X}"', '/p.mjs', false)).toBe('echo "${DANXBOT_TEST_RECORDER_X}"'))
  test('a session that has the variable is left alone', () => expect(withRecorderVar(CMD, '/p.mjs', true)).toBe(CMD))
})
