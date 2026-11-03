// The pure half of the hook that posts a builder's recorded test run. The recorder script prints a marker line naming a record file after a
// passing run; the hook reads that file and posts it as the card's `test_run` agent note.

export const RECORD_MARKER = 'DANXBOT_TEST_RUN_RECORD'

const MARKER_LINE = new RegExp(`^${RECORD_MARKER} (\\S.*?)\\s*$`, 'm')

/** The record file a Bash result names, or null. Only a line that is the marker itself counts. */
export function testRunRecordPath(text: unknown): string | null {
  if (typeof text !== 'string') return null
  return MARKER_LINE.exec(text)?.[1] ?? null
}

export type TestRunPost = { path: string; body: { text: string; metadata: Record<string, unknown> } }

/** The note call for a record file's text, or a reason it cannot be posted. The server checks the metadata whole; this only checks it is a test_run for a card. */
export function testRunPost(fileText: string): TestRunPost | { error: string } {
  let record: any
  try {
    record = JSON.parse(fileText)
  } catch {
    return { error: 'the record file is not JSON' }
  }
  const metadata = record?.metadata
  if (typeof record?.card !== 'string' || !/^[A-Za-z0-9]+-\d+$/.test(record.card)) return { error: 'the record names no card' }
  if (typeof record.text !== 'string' || record.text === '' || metadata?.kind !== 'test_run') return { error: 'the record is not a test_run note' }
  return { path: `/api/issues/${record.card}/notes`, body: { text: record.text, metadata } }
}

export const RECORDER_VAR = 'DANXBOT_TEST_RECORDER'

const RECORDER_USE = /\$(?:\{DANXBOT_TEST_RECORDER\}|DANXBOT_TEST_RECORDER(?![A-Za-z0-9_]))/

/** One word written so a POSIX shell reads it back as that word. */
const quoted = (word: string): string => `'${word.split("'").join("'\''")}'`

/** The recorder script's absolute path, from the URL of a file beside it (this module's own location), in the forward-slash form bash and node both read. */
export function recorderPath(moduleUrl: string): string {
  const path = decodeURIComponent(new URL('../scripts/record-test-run.mjs', moduleUrl).pathname)
  return path.replace(/^\/([A-Za-z]:)/, '$1')
}

/** The Bash command with the recorder variable defined for it, when it names the variable and the session has not set it; every other command comes back unchanged. */
export function withRecorderVar(command: unknown, scriptPath: string, alreadySet: boolean): unknown {
  if (typeof command !== 'string' || alreadySet || !RECORDER_USE.test(command)) return command
  return `${RECORDER_VAR}=${quoted(scriptPath)} ${command}`
}
