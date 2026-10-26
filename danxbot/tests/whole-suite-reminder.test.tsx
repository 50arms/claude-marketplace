import "./run-tests-with-npm-test.generated"
// CP-16: a Bash call that starts a whole test suite gets the reminder; one that names test files, or is no test run, does not.
import { describe, expect } from 'claude-code/testing'

import { WHOLE_SUITE_REMINDER, wholeSuiteReminder } from '../hooks/context/whole-suite'
import { test, SURFACES, dashboard, startSession } from './plan-kit'

describe('wholeSuiteReminder (the command text)', () => {
  const whole = ['make test', 'make test PROJECT=site', 'make test-frontend', 'npm test', 'npm test --silent', 'npm run test', 'npm test --', 'pnpm test', 'yarn test', 'vitest', 'vitest run', 'npx vitest run --coverage', 'cd x && npm test', 'CI=1 make test', 'ls; make test | tail -5']
  const targeted = ['make test FILES=a.test.ts', 'make test AFFECTED=1', 'make test-frontend FILES=src/a.test.tsx', 'npm test -- a.test.mjs', 'npm test -- --silent b.test.mjs', 'vitest run src/a.test.ts', 'vitest run a.test.ts --coverage', 'vitest a.test.ts b.test.ts --watch', 'vitest --run a.test.ts --reporter=dot', 'npm test a.test.ts', 'pnpm test a.test.ts', 'npx vitest a.test.ts', 'yarn test a.test.ts']
  // heuristic misses, pinned: the make target is not the first operand, so no reminder is given
  const knownMisses = ['make -C dir test', 'make -j 4 test']
  const notTests = ['ls', 'make build', 'npm install', 'npm run build', 'git commit -m "make test"', '', 'echo vitest']

  for (const c of whole) test(`reminds: ${c}`, () => expect(wholeSuiteReminder(c)).toBe(WHOLE_SUITE_REMINDER))
  for (const c of [...targeted, ...notTests, ...knownMisses]) test(`quiet: ${c}`, () => expect(wholeSuiteReminder(c)).toBeNull())
  test('a command that is no string is quiet', () => expect(wholeSuiteReminder(undefined)).toBeNull())
})

for (const surface of SURFACES) {
  describe(`the whole-suite reminder hook on ${surface}`, () => {
    async function started($: any, on: any) {
      on('classic.SessionStart', () => ({}) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      await startSession($, dashboard(on, { connected: false }), surface)
    }
    const contextOf = async ($: any, command: string) => ((await $.tool.call({ tool: 'Bash', command } as any)).context ?? []) as string[]

    test('a whole-suite Bash call carries the reminder beside its result', async ($, on) => {
      await started($, on)
      expect(await contextOf($, 'make test')).toContain(WHOLE_SUITE_REMINDER)
    })

    test('a denied whole-suite call carries no reminder', async ($, on) => {
      on('classic.SessionStart', () => ({}) as any)
      on('tool.call', () => ({ deny: 'not allowed' }) as any)
      await startSession($, dashboard(on, { connected: false }), surface)
      expect(await contextOf($, 'make test')).not.toContain(WHOLE_SUITE_REMINDER)
    })

    test('a call naming test files, and any other call, carries none', async ($, on) => {
      await started($, on)
      expect(await contextOf($, 'make test FILES=a.test.ts')).not.toContain(WHOLE_SUITE_REMINDER)
      expect(await contextOf($, 'ls')).not.toContain(WHOLE_SUITE_REMINDER)
    })
  })
}
