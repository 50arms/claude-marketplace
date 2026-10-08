// DX-4235 (PBLM-2121): the drift pin for hooks/reports/label.ts, the plugin's port of the background-shell row label.
//
// SOURCE: danxbot `src/agent/activity-observer.test.ts` at commit 7ed4e47fb9626cc91f61bc20f45491ce59217e91, the tests of
// `redactLabel` / `labelOf` / `describeToolCall` in `packages/danx-session-telemetry/src/activity-observer.ts` at the same commit. Every
// case below is copied from those tests' shell-label cases: the `redactLabel` table as it stands, and the `describeToolCall` cases for
// Bash and PowerShell, read through `labelOf` (the label part of `describeToolCall`, and exactly what the old command hook sent as a
// shell row's `description`: `labelOf(toolInput.description)`). When the package's cases change, these change with them, in the same
// card. The 120-character cap of `describeToolCall` is not ported: it caps the current-activity text, never a row's description.
import { describe, expect, test } from 'claude-code/testing'

import { labelOf, redactLabel } from '../hooks/reports/label'

describe('redactLabel (ported from danxbot DX-4498)', () => {
  const cases: [string, string][] = [
    ['Inspect C:\\Users\\newms\\projects\\danx', 'Inspect [path]'],
    ['List C:/tmp directly', 'List [path] directly'],
    ['Audit global ~/.claude config', 'Audit global [path] config'],
    ['Breakdown of /var/lib and /danxbot/repos', 'Breakdown of [path] and [path]'],
    ['Inspect deploy/workers.ts for host targeting', 'Inspect [path] for host targeting'],
    ['Probe the share (\\\\wsl.localhost\\Ubuntu)', 'Probe the share [path]'],
    ['Export NPM_TOKEN=npm_abc123 first', 'Export NPM_TOKEN=[redacted] first'],
    ['Use key sk-ant-api03-AbCdEf1234567890XyZ now', 'Use key [redacted] now'],
    ['Read commit e81093e1b7fbbfda2ece65762468564dc9358492', 'Read commit [redacted]'],
  ]
  for (const [label, expected] of cases) {
    test(`${JSON.stringify(label)} -> ${JSON.stringify(expected)}`, () => {
      expect(redactLabel(label)).toBe(expected)
    })
  }

  for (const label of ['Run the tests', 'Review DX-4498 at e81093e1b', 'Check records.ts for definitions', 'Load danxbot:issue-workflow', 'Count internationalization-friendly strings']) {
    test(`leaves a label with nothing path- or secret-shaped as it is: ${JSON.stringify(label)}`, () => {
      expect(redactLabel(label)).toBe(label)
    })
  }

  test('collapses whitespace onto one line', () => {
    expect(redactLabel('a\n  b\tc')).toBe('a b c')
  })
})

describe("a shell call's label (describeToolCall's Bash / PowerShell cases, through labelOf)", () => {
  test('labels a shell call with its description', () => {
    expect(labelOf('Run the tests')).toBe('Run the tests')
    expect(labelOf('List files')).toBe('List files')
  })

  test('NEVER carries a command: only the description is read', () => {
    // describeToolCall("Bash", { command: "cat ~/.ssh/id_rsa" }) -> "Bash": a call with no description has no label
    expect(labelOf(undefined)).toBeNull()
    // describeToolCall("Bash", { command: "cat ~/.ssh/id_rsa", description: "Check a file" }) -> "Bash: Check a file"
    expect(labelOf('Check a file')).toBe('Check a file')
  })

  test('a blank or non-string label is no label', () => {
    expect(labelOf('   ')).toBeNull()
    expect(labelOf(42)).toBeNull()
  })

  test('collapses whitespace in a label onto one line', () => {
    expect(labelOf('a\n  b\tc')).toBe('a b c')
  })

  test("a shell call's description reaches the row redacted", () => {
    expect(labelOf('Inspect C:\\Users\\newms\\danx')).toBe('Inspect [path]')
  })
})
