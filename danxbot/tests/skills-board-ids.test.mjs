// DX-5515 AC 1: the plugin's skills name a board by its per-team ref number, never by the retired repo:slug form.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const skills = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
function skillFiles(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? skillFiles(path) : name === 'SKILL.md' ? [path] : []
  })
}

test('no SKILL.md names a board as repo:slug', () => {
  const files = skillFiles(skills)
  assert.ok(files.length > 0)
  const hits = files.filter(f => /repo:slug|<repo>:<slug>/.test(readFileSync(f, 'utf8')))
  assert.deepEqual(hits, [])
})
