import "./run-tests-with-npm-test.generated"
// The hook that posts a builder's recorded test run: a Bash result whose stdout carries the recorder's marker line posts the record file as the card's note.
import { describe, expect } from 'claude-code/testing'

import { test, SURFACES, dashboard, startSession } from './plan-kit'

const FILE = '/tmp/danxbot-test-runs/DX-9-run.json'
const METADATA = { kind: 'test_run', commit_sha: 'a'.repeat(40), tree_id: 'b'.repeat(40), command: 'npm test', machine: 'm', tests: { passed: 3, failed: 0, skipped: 0, total: 3 }, test_files: null, files: null }
const RECORD = JSON.stringify({ card: 'DX-9', text: 'Tests passed.', metadata: METADATA })
const marked = (file = FILE) => ({ result: { stdout: `3 passed\nDANXBOT_TEST_RUN_RECORD ${file}\n`, stderr: '', interrupted: false }, text: 'ignored' })
const notes = (d: any) => d.api.filter((a: any) => a.method === 'POST' && a.path.endsWith('/notes'))

for (const surface of SURFACES) {
  describe(`the test-run record hook on ${surface}`, () => {
    async function started($: any, on: any, answer: () => any, file = RECORD) {
      on('tool.call', () => answer())
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      d.world.files[FILE] = file
      return d
    }

    test('a Bash result carrying the marker posts the record as the card note', async ($, on) => {
      const d = await started($, on, () => marked())
      await $.tool.call({ tool: 'Bash', command: 'node record-test-run.mjs -- npm test' } as any)
      await d.clock.settle()
      expect(notes(d)).toEqual([{ method: 'POST', path: '/api/issues/DX-9/notes', body: { text: 'Tests passed.', metadata: METADATA }, query: undefined }])
      expect(d.toasts).toEqual([])
    })

    test('a second result showing the same marker posts nothing', async ($, on) => {
      const d = await started($, on, () => marked())
      await $.tool.call({ tool: 'Bash', command: 'a' } as any)
      await d.clock.settle()
      await $.tool.call({ tool: 'Bash', command: 'b' } as any)
      await d.clock.settle()
      expect(notes(d)).toHaveLength(1)
    })

    test('a marker only in the result text, not stdout, posts nothing', async ($, on) => {
      const d = await started($, on, () => ({ result: { stdout: '' }, text: `DANXBOT_TEST_RUN_RECORD ${FILE}` }))
      await $.tool.call({ tool: 'Bash', command: 'a' } as any)
      await d.clock.settle()
      expect(notes(d)).toEqual([])
    })

    test('a result from another tool posts nothing', async ($, on) => {
      const d = await started($, on, () => marked())
      await $.tool.call({ tool: 'Read', path: '/x' } as any)
      await d.clock.settle()
      expect(notes(d)).toEqual([])
    })

    test("a sub-agent's Bash call posts too", async ($, on) => {
      const d = await started($, on, () => marked())
      await $.tool.call({ tool: 'Bash', command: 'a', agentId: 'sub-1' } as any)
      await d.clock.settle()
      expect(notes(d)).toHaveLength(1)
    })

    test('a refused post raises a toast and leaves the record to post again', async ($, on) => {
      const d = await started($, on, () => marked())
      d.setMcp('flaky')
      await $.tool.call({ tool: 'Bash', command: 'a' } as any)
      await d.clock.settle()
      expect(d.toasts.some((t: string) => t.startsWith('danxbot test-run record failed'))).toBe(true)
      expect(d.world.files[FILE]).toBe(RECORD)
    })

    test('a malformed record raises a toast and posts nothing', async ($, on) => {
      const d = await started($, on, () => marked(), 'not json')
      await $.tool.call({ tool: 'Bash', command: 'a' } as any)
      await d.clock.settle()
      expect(notes(d)).toEqual([])
      expect(d.toasts.some((t: string) => t.includes('the record file is not JSON'))).toBe(true)
    })

    describe('the recorder variable', () => {
      async function ran($: any, on: any, command: string, extra: object = {}, before?: (d: any) => void) {
        const seen: string[] = []
        on('tool.call', (_$: any, e: any) => (seen.push(e.command), { result: { stdout: '' }, text: '' }) as any)
        const d = dashboard(on, { connected: false })
        await startSession($, d, surface)
        before?.(d)
        await $.tool.call({ tool: 'Bash', command, ...extra } as any)
        await d.clock.settle()
        return seen
      }
      const SCRIPT = /^DANXBOT_TEST_RECORDER='[^']*\/scripts\/record-test-run\.mjs' /

      test('a command naming $DANXBOT_TEST_RECORDER runs with the variable defined as the plugin script', async ($, on) => {
        const [seen] = await ran($, on, 'node "$DANXBOT_TEST_RECORDER" --report /tmp/r -- npm test')
        expect(seen).toMatch(SCRIPT)
        expect(seen.endsWith(' node "$DANXBOT_TEST_RECORDER" --report /tmp/r -- npm test')).toBe(true)
      })

      test('the braced form gets it too', async ($, on) => {
        expect((await ran($, on, 'node "${DANXBOT_TEST_RECORDER}" -- x'))[0]).toMatch(SCRIPT)
      })

      test('a longer variable name runs unchanged', async ($, on) => {
        expect(await ran($, on, 'echo $DANXBOT_TEST_RECORDER_OTHER')).toEqual(['echo $DANXBOT_TEST_RECORDER_OTHER'])
      })

      test('a command that does not name the variable runs unchanged', async ($, on) => {
        expect(await ran($, on, 'make test')).toEqual(['make test'])
      })

      test('a session that already has the variable is left alone', async ($, on) => {
        const seen = await ran($, on, 'node "$DANXBOT_TEST_RECORDER" -- x', {}, d => d.setEnv('DANXBOT_TEST_RECORDER', '/dispatch/path.mjs'))
        expect(seen).toEqual(['node "$DANXBOT_TEST_RECORDER" -- x'])
      })

      test("a sub-agent's call gets it too", async ($, on) => {
        expect((await ran($, on, 'node "$DANXBOT_TEST_RECORDER" -- x', { agentId: 'sub-1' }))[0]).toMatch(SCRIPT)
      })
    })
  })
}
