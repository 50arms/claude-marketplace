import "./designated-test-container.mjs";
// CP-1: the machine's free-space warning (hooks/context/disk.ts). Pure parts and the host seam are exercised with fakes: the test container is
// Linux, so the real host answers `null` (no C: to judge) and the hooks add nothing there.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DISK_REPEAT_MS, diskDecision, diskNotice, hostKind, parseFloors, parseWindow, systemDriveRoot } from '../hooks/context/disk.ts'

const GIB = 1024 ** 3
const FLOORS_FILE = 'floor_gib=40\nhard_minimum_gib=15\n'

// A fake machine. `files` maps a path to its text; `reads` records every path asked for and `roots` every drive measured.
function fakeHost({ kind = 'windows', freeGiB = 100, files = {}, env = { SystemDrive: 'C:' }, home = 'C:\\Users\\dev', winHome = '/mnt/c/Users/dev' } = {}) {
  const reads = []
  const roots = []
  return {
    reads,
    roots,
    kind,
    env,
    home: () => home,
    windowsHome: () => winHome,
    freeBytes: root => {
      roots.push(root)
      return freeGiB * GIB
    },
    read: path => {
      reads.push(path)
      return path in files ? files[path] : null
    },
  }
}

const floorsAt = dir => join(dir, '.danxbot', 'machine-disk-floors')
const windowAt = dir => join(dir, '.danxbot', 'compaction-window')

test('hostKind: win32 is windows, a Microsoft kernel with C: mounted is wsl, anything else has no C:', () => {
  assert.equal(hostKind('win32', '10.0', false), 'windows')
  assert.equal(hostKind('linux', '5.15.1-microsoft-standard-WSL2', true), 'wsl')
  assert.equal(hostKind('linux', '5.15.1-microsoft-standard-WSL2', false), null)
  assert.equal(hostKind('linux', '6.1.0-generic', true), null)
  assert.equal(hostKind('darwin', '23.0', false), null)
})

test('the drive measured is the Windows system drive on win32 and /mnt/c inside WSL, never the home directory root', () => {
  assert.equal(systemDriveRoot('windows', { SystemDrive: 'C:' }), 'C:\\')
  assert.equal(systemDriveRoot('wsl', {}), '/mnt/c')
  assert.throws(() => systemDriveRoot('windows', {}), /SystemDrive is not set/)

  const win = fakeHost({ kind: 'windows', files: { [floorsAt('C:\\Users\\dev')]: FLOORS_FILE } })
  diskNotice(win)
  assert.deepEqual(win.roots, ['C:\\'])

  const wsl = fakeHost({ kind: 'wsl', home: '/home/dev', files: { [floorsAt('/mnt/c/Users/dev')]: FLOORS_FILE } })
  diskNotice(wsl)
  assert.deepEqual(wsl.roots, ['/mnt/c'])
})

test('inside WSL the limits are read from the Windows home, not the WSL one', () => {
  const wsl = fakeHost({ kind: 'wsl', home: '/home/dev', winHome: '/mnt/c/Users/dev', files: { [floorsAt('/mnt/c/Users/dev')]: FLOORS_FILE, [floorsAt('/home/dev')]: 'floor_gib=1\nhard_minimum_gib=1\n' }, freeGiB: 30 })
  assert.match(diskNotice(wsl), /LOW DISK: C: has 30\.0 GB free, under the 40\.0 GB floor/)
  assert.ok(wsl.reads.every(p => !p.startsWith('/home/dev')))
})

test('a host that is not the Windows dev machine says nothing and reads nothing', () => {
  const other = fakeHost({ kind: null, freeGiB: 1 })
  assert.equal(diskNotice(other), '')
  assert.deepEqual(other.reads, [])
  assert.deepEqual(other.roots, [])
})

test('enough free space and no window: silent', () => {
  assert.equal(diskNotice(fakeHost({ freeGiB: 40, files: { [floorsAt('C:\\Users\\dev')]: FLOORS_FILE } })), '')
})

test('under the floor: a LOW DISK notice naming the free space and the floor', () => {
  const notice = diskNotice(fakeHost({ freeGiB: 25, files: { [floorsAt('C:\\Users\\dev')]: FLOORS_FILE } }))
  assert.match(notice, /^LOW DISK: C: has 25\.0 GB free, under the 40\.0 GB floor\./)
  assert.doesNotMatch(notice, /hard minimum/)
})

test('under the hard minimum the notice also says host test runs refuse', () => {
  const notice = diskNotice(fakeHost({ freeGiB: 11, files: { [floorsAt('C:\\Users\\dev')]: FLOORS_FILE } }))
  assert.match(notice, /Under the 15\.0 GB hard minimum: host test runs refuse/)
})

test('the limits have one source: a missing file is DISK FLOORS UNAVAILABLE, never a built-in default', () => {
  const notice = diskNotice(fakeHost({ freeGiB: 1 }))
  assert.match(notice, /^DISK FLOORS UNAVAILABLE: .*machine-disk-floors is missing/)
  assert.doesNotMatch(notice, /LOW DISK/)
})

test('a malformed limits file is one DISK CHECK FAILED line, never silence', () => {
  const dir = 'C:\\Users\\dev'
  assert.match(diskNotice(fakeHost({ files: { [floorsAt(dir)]: 'floor_gib=abc\nhard_minimum_gib=15\n' } })), /^DISK CHECK FAILED: floor_gib must be a positive number/)
  assert.match(diskNotice(fakeHost({ files: { [floorsAt(dir)]: 'floor_gib=10\nhard_minimum_gib=15\n' } })), /^DISK CHECK FAILED: the hard minimum/)
  assert.match(diskNotice(fakeHost({ env: {}, files: { [floorsAt(dir)]: FLOORS_FILE } })), /^DISK CHECK FAILED: SystemDrive is not set/)
})

test('DANXBOT_DISK_FLOOR_GIB forces the floor for a live check', () => {
  const host = fakeHost({ freeGiB: 100, env: { SystemDrive: 'C:', DANXBOT_DISK_FLOOR_GIB: '500' }, files: { [floorsAt('C:\\Users\\dev')]: FLOORS_FILE } })
  assert.match(diskNotice(host), /LOW DISK: C: has 100\.0 GB free, under the 500\.0 GB floor/)
})

test('an open compaction window tells the session to pause, before the disk line', () => {
  const dir = 'C:\\Users\\dev'
  const notice = diskNotice(fakeHost({ freeGiB: 25, files: { [floorsAt(dir)]: FLOORS_FILE, [windowAt(dir)]: '1792728384\ncompacting docker\n' } }))
  const lines = notice.split('\n')
  assert.match(lines[0], /^MAINTENANCE WINDOW OPEN since 2026-10-22T.*: compacting docker$/)
  assert.match(lines[1], /start no test run, build, deploy or dispatch/)
  assert.match(notice, /LOW DISK/)
  assert.ok(notice.indexOf('MAINTENANCE WINDOW') < notice.indexOf('LOW DISK'))
})

test('the window alone (plenty of space) is still told', () => {
  const dir = 'C:\\Users\\dev'
  const notice = diskNotice(fakeHost({ freeGiB: 200, files: { [floorsAt(dir)]: FLOORS_FILE, [windowAt(dir)]: '1792728384\nwhy\n' } }))
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
  const first = diskDecision('LOW', t0, null, 'prompt')
  assert.equal(first.line, 'LOW')
  assert.equal(diskDecision('LOW', t0 + 1000, first.told, 'prompt').line, 'LOW')
})

test('diskDecision: a tool call tells once per state change, then at most once per DISK_REPEAT_MS', () => {
  const t0 = 1_000_000
  const first = diskDecision('LOW', t0, null, 'tool')
  assert.equal(first.line, 'LOW')
  const quiet = diskDecision('LOW', t0 + 5_000, first.told, 'tool')
  assert.equal(quiet.line, null)
  assert.deepEqual(quiet.told, first.told)
  const changed = diskDecision('LOW and worse', t0 + 6_000, quiet.told, 'tool')
  assert.equal(changed.line, 'LOW and worse')
  const again = diskDecision('LOW and worse', t0 + 6_000 + DISK_REPEAT_MS, changed.told, 'tool')
  assert.equal(again.line, 'LOW and worse')
})

test('diskDecision: an all-clear forgets, so the next warning is told at once', () => {
  const t0 = 1_000_000
  const told = diskDecision('LOW', t0, null, 'tool').told
  const clear = diskDecision('', t0 + 1000, told, 'tool')
  assert.equal(clear.line, null)
  assert.equal(clear.told, null)
  assert.equal(diskDecision('LOW', t0 + 2000, clear.told, 'tool').line, 'LOW')
})

test('the module hands the notice on a prompt, a tool call (sub-agents included) and clears its memory at a session start', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'hooks', 'register.tsx'), 'utf8')
  assert.match(src, /stampEntries\(\$, true, 'prompt'\)/)
  assert.match(src, /stampEntries\(\$, e\.agentId === undefined, 'tool'\)/)
  assert.match(src, /diskNotice\(realHost\(\)\)/)
  assert.match(src, /await update\(\$, diskTold, \(\) => null\)/)
})
