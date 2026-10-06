// DX-4340: the text prefixes the plan-workflow skill quotes ("Usage pacing: ..." on a refused spawn, "Usage pacing for your Claude account
// changed: ..." on a pacing message). The guard's refusal prefix lives once, as REFUSAL_PREFIX in hooks/plan/pacing-guard.ts, and
// pacing-guard.test.tsx proves a refusal starts with it; this proves the skill quotes both. A change to either text must update
// danxbot/skills/plan-workflow/SKILL.md in the same change.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const guard = readFileSync(join(root, 'hooks', 'plan', 'pacing-guard.ts'), 'utf8')
const skill = readFileSync(join(root, 'skills', 'plan-workflow', 'SKILL.md'), 'utf8')
const line = readFileSync(join(root, 'hooks', 'plan', 'pacing-line.ts'), 'utf8')

test('the skill quotes the guard\'s refusal prefix and danxbot\'s pacing message prefix', () => {
  const refusal = /export const REFUSAL_PREFIX = '([^']+)'/.exec(guard)
  assert.ok(refusal, 'pacing-guard.ts exports REFUSAL_PREFIX as a string literal')
  assert.ok(skill.includes(refusal[1]), `SKILL.md quotes the refusal prefix "${refusal[1]}"`)
  // the plugin recognises a delivered pacing message by this prefix (DX-4631), and the skill quotes the same one
  const message = /export const PACING_MESSAGE_PREFIX = '([^']+)'/.exec(line)
  assert.ok(message, 'pacing-line.ts exports PACING_MESSAGE_PREFIX as a string literal')
  assert.ok(skill.includes(message[1]), `SKILL.md quotes the pacing message prefix "${message[1]}"`)
})
