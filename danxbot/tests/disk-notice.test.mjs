import "./designated-test-container.mjs";
// CP-1: the machine's free-space notice, pure parts (hooks/context/disk.ts). The hooks that gather the facts and hand the notice to a prompt, a tool
// call, a sub-agent and a session start are driven through the hook kit's fake host in disk-notice-hooks.test.tsx.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DISK_REPEAT_MS,
  DISK_TOLD_KEEP,
  applyOverrides,
  diskDecision,
  diskNotice,
  freeSpaceArgv,
  hostKindOf,
  joinPath,
  parseFloors,
  parseFreeBytes,
  parseWindow,
  parseWindowsProfile,
  systemDriveRoot,
} from '../hooks/context/disk.ts'

const GIB = 1024 ** 3
const FLOORS_FILE = 'floor_gib=40\nhard_minimum_gib=15\n'
const FLOORS_PATH = 'C:\\Users\\dev\\.danxbot\\machine-disk-floors'

const facts = (over = {}) => ({ env: { SystemDrive: 'C:' }, freeBytes: 100 * GIB, floorsText: FLOORS_FILE, floorsPath: FLOORS_PATH, windowText: null, ...over })

test('the hooks module imports nothing from node: (the machine is reached only through $ in register.tsx)', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'context')
  assert.doesNotMatch(readFileSync(join(dir, 'disk.ts'), 'utf8'), /from 'node:/)
})

test('hostKindOf: WSL_DISTRO_NAME is wsl, SystemDrive is windows, anything else has no C:', () => {
  assert.equal(hostKindOf({ WSL_DISTRO_NAME: 'Ubuntu' }), 'wsl')
  assert.equal(hostKindOf({ WSL_DISTRO_NAME: 'Ubuntu', SystemDrive: 'C:' }), 'wsl')
  assert.equal(hostKindOf({ SystemDrive: 'C:' }), 'windows')
  assert.equal(hostKindOf({}), null)
})

test('the drive measured is the Windows system drive on win32 and /mnt/c inside WSL, never the home directory root', () => {
  assert.equal(systemDriveRoot('windows', { SystemDrive: 'C:' }), 'C:\\')
  assert.equal(systemDriveRoot('wsl', {}), '/mnt/c')
  assert.throws(() => systemDriveRoot('windows', {}), /SystemDrive is not set/)
  assert.deepEqual(freeSpaceArgv('wsl', {}), ['df', '-B1', '--output=avail', '/mnt/c'])
  const win = freeSpaceArgv('windows', { SystemDrive: 'D:' })
  assert.equal(win[0], 'powershell.exe')
  assert.match(win.at(-1), /DriveInfo 'D'/)
})

test('parseFreeBytes reads the last line as a byte count and refuses anything else', () => {
  assert.equal(parseFreeBytes('     Avail\n32212254720\n'), 32212254720)
  assert.equal(parseFreeBytes('32212254720\r\n'), 32212254720)
  assert.throws(() => parseFreeBytes('not a number'), /did not answer a byte count/)
  assert.throws(() => parseFreeBytes(''), /did not answer a byte count/)
})

test('parseWindowsProfile and joinPath', () => {
  assert.equal(parseWindowsProfile('C:\\Users\\dev\r\n'), 'C:\\Users\\dev')
  assert.throws(() => parseWindowsProfile('%USERPROFILE%\r\n'), /could not resolve the Windows home/)
  assert.throws(() => parseWindowsProfile(''), /could not resolve the Windows home/)
  assert.equal(joinPath('wsl', '/mnt/c/Users/dev/', '.danxbot', 'x'), '/mnt/c/Users/dev/.danxbot/x')
  assert.equal(joinPath('windows', 'C:\\Users\\dev', '.danxbot'), 'C:\\Users\\dev\\.danxbot')
})

test('enough free space and no window: silent', () => {
  assert.equal(diskNotice(facts({ freeBytes: 40 * GIB })), '')
})

test('under the floor: a LOW DISK notice naming the free space and the floor, saying the make targets run from the danxbot checkout', () => {
  const notice = diskNotice(facts({ freeBytes: 25 * GIB }))
  assert.match(notice, /^LOW DISK: C: has 25\.0 GB free, under the 40\.0 GB floor\./)
  assert.doesNotMatch(notice, /hard minimum/)
  assert.match(notice, /From the danxbot checkout, `make machine-report`/)
})

test('under the hard minimum the notice also says host test runs refuse', () => {
  assert.match(diskNotice(facts({ freeBytes: 11 * GIB })), /Under the 15\.0 GB hard minimum: host test runs refuse/)
})

test('the limits have one source: a missing file is DISK FLOORS UNAVAILABLE, never a built-in default', () => {
  const notice = diskNotice(facts({ floorsText: null, freeBytes: 1 * GIB }))
  assert.match(notice, /^DISK FLOORS UNAVAILABLE: .*machine-disk-floors is missing/)
  assert.match(notice, /from the danxbot checkout/)
  assert.doesNotMatch(notice, /LOW DISK/)
})

test('a malformed limits file or window marker is one DISK CHECK FAILED line, never silence', () => {
  assert.match(diskNotice(facts({ floorsText: 'floor_gib=abc\nhard_minimum_gib=15\n' })), /^DISK CHECK FAILED: floor_gib must be a positive number/)
  assert.match(diskNotice(facts({ floorsText: 'floor_gib=40\n' })), /^DISK CHECK FAILED: hard_minimum_gib/)
  assert.match(diskNotice(facts({ windowText: 'soon\n' })), /^DISK CHECK FAILED: the compaction window marker/)
})

test('both of danxbot overrides apply, and the two limits are checked against each other AFTER the overrides', () => {
  const floors = parseFloors(FLOORS_FILE)
  assert.deepEqual(applyOverrides(floors, { DANXBOT_DISK_FLOOR_GIB: '500' }), { floorBytes: 500 * GIB, hardMinimumBytes: 15 * GIB })
  assert.deepEqual(applyOverrides(floors, { DANXBOT_DISK_HARD_MINIMUM_GIB: '35' }), { floorBytes: 40 * GIB, hardMinimumBytes: 35 * GIB })
  assert.deepEqual(applyOverrides(floors, { DANXBOT_DISK_FLOOR_GIB: '50', DANXBOT_DISK_HARD_MINIMUM_GIB: '45' }), { floorBytes: 50 * GIB, hardMinimumBytes: 45 * GIB })
  // a file whose limits disagree is fixed by an override that makes them agree: the check runs after
  assert.deepEqual(applyOverrides({ floorBytes: 10 * GIB, hardMinimumBytes: 15 * GIB }, { DANXBOT_DISK_FLOOR_GIB: '20' }), { floorBytes: 20 * GIB, hardMinimumBytes: 15 * GIB })
  assert.throws(() => applyOverrides(floors, { DANXBOT_DISK_FLOOR_GIB: '10' }), /the hard minimum .* must not exceed the floor/)
  assert.throws(() => applyOverrides(floors, { DANXBOT_DISK_FLOOR_GIB: 'lots' }), /DANXBOT_DISK_FLOOR_GIB must be a positive number/)
  assert.match(diskNotice(facts({ env: { DANXBOT_DISK_FLOOR_GIB: '500' } })), /LOW DISK: C: has 100\.0 GB free, under the 500\.0 GB floor/)
})

test('an open compaction window tells the session to pause, before the disk line', () => {
  const notice = diskNotice(facts({ freeBytes: 25 * GIB, windowText: '1792728384\ncompacting docker\n' }))
  const lines = notice.split('\n')
  assert.match(lines[0], /^MAINTENANCE WINDOW OPEN since 2026-10-22T.*: compacting docker$/)
  assert.match(lines[1], /start no test run, build, deploy or dispatch/)
  assert.match(lines[1], /run from the danxbot checkout/)
  assert.ok(notice.indexOf('MAINTENANCE WINDOW') < notice.indexOf('LOW DISK'))
})

test('the window alone (plenty of space) is still told', () => {
  const notice = diskNotice(facts({ windowText: '1792728384\nwhy\n' }))
  assert.match(notice, /^MAINTENANCE WINDOW OPEN/)
  assert.doesNotMatch(notice, /LOW DISK/)
})

test('parsers: limits file and window marker', () => {
  assert.deepEqual(parseFloors('# c\nfloor_gib=40\nhard_minimum_gib=15\n'), { floorBytes: 40 * GIB, hardMinimumBytes: 15 * GIB })
  assert.throws(() => parseFloors('floor_gib=40\n'), /hard_minimum_gib/)
  assert.deepEqual(parseWindow('1000\nreason line\nmore'), { openedAtMs: 1_000_000, reason: 'reason line\nmore' })
  assert.throws(() => parseWindow('soon\nx'), /epoch seconds/)
})

test('diskDecision: a prompt always carries the notice', () => {
  const t0 = 1_000_000
  const first = diskDecision('LOW', t0, {}, 'prompt', 'main')
  assert.equal(first.line, 'LOW')
  assert.equal(diskDecision('LOW', t0 + 1000, first.told, 'prompt', 'main').line, 'LOW')
})

test('diskDecision: a tool call tells once per state change, then at most once per DISK_REPEAT_MS', () => {
  const t0 = 1_000_000
  const first = diskDecision('LOW', t0, {}, 'tool', 'main')
  assert.equal(first.line, 'LOW')
  const quiet = diskDecision('LOW', t0 + 5_000, first.told, 'tool', 'main')
  assert.equal(quiet.line, null)
  assert.deepEqual(quiet.told, first.told)
  const changed = diskDecision('LOW and worse', t0 + 6_000, quiet.told, 'tool', 'main')
  assert.equal(changed.line, 'LOW and worse')
  const again = diskDecision('LOW and worse', t0 + 6_000 + DISK_REPEAT_MS, changed.told, 'tool', 'main')
  assert.equal(again.line, 'LOW and worse')
})

test('diskDecision: told per agent, so a sub-agent hears it once after the main loop was told', () => {
  const t0 = 1_000_000
  const main = diskDecision('LOW', t0, {}, 'tool', 'main')
  const sub = diskDecision('LOW', t0 + 1000, main.told, 'tool', 'a1')
  assert.equal(sub.line, 'LOW')
  assert.equal(diskDecision('LOW', t0 + 2000, sub.told, 'tool', 'a1').line, null)
  assert.equal(diskDecision('LOW', t0 + 2000, sub.told, 'tool', 'main').line, null)
})

test('diskDecision: an all-clear forgets that agent, so its next warning is told at once', () => {
  const t0 = 1_000_000
  const told = diskDecision('LOW', t0, {}, 'tool', 'main').told
  const clear = diskDecision('', t0 + 1000, told, 'tool', 'main')
  assert.equal(clear.line, null)
  assert.deepEqual(clear.told, {})
  assert.equal(diskDecision('LOW', t0 + 2000, clear.told, 'tool', 'main').line, 'LOW')
})

test('diskDecision: the agents remembered are bounded, the oldest forgotten first', () => {
  let told = {}
  for (let i = 0; i < DISK_TOLD_KEEP + 5; i++) told = diskDecision('LOW', 1000 + i, told, 'tool', `a${i}`).told
  const keys = Object.keys(told)
  assert.equal(keys.length, DISK_TOLD_KEEP)
  assert.ok(!keys.includes('a0'))
  assert.ok(keys.includes(`a${DISK_TOLD_KEEP + 4}`))
})
