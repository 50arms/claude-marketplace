import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statfsSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { join } from 'node:path'

import type { DiskTold } from '../../types'

// The machine's free-space warning for every session. The Windows dev machine keeps two limits in one file, `<home>/.danxbot/machine-disk-floors`
// (floor_gib warns, hard_minimum_gib refuses host test runs), and a marker file `<home>/.danxbot/compaction-window` while Docker's data disks are
// being compacted. The plugin is the one reader that reaches every repo, sub-agent and autonomous turn. Pure parts take their inputs as arguments;
// `realHost` is the only code that touches the machine, and `diskNotice` fails loudly (one line naming the fault) instead of staying quiet.

const GIB = 1024 ** 3
const WSL_CALL_TIMEOUT_MS = 10_000
// a state that has not changed is told again on a tool call only after this long (a person's prompt always carries it)
export const DISK_REPEAT_MS = 10 * 60_000
export const SEED_COMMAND = 'make seed-machine-disk-floors'
export const FLOOR_ENV = 'DANXBOT_DISK_FLOOR_GIB'

export type Floors = { floorBytes: number; hardMinimumBytes: number }
export type Window = { openedAtMs: number; reason: string }

// The seams to the machine. Tests pass fakes; `realHost` is the real one.
export type DiskHost = {
  // 'windows' (win32), 'wsl' (a Microsoft kernel with C: mounted at /mnt/c), or null: any other host has no C: and is not this policy's concern
  kind: 'windows' | 'wsl' | null
  env: Record<string, string | undefined>
  home(): string
  freeBytes(root: string): number
  read(path: string): string | null
  windowsHome(): string
}

export function hostKind(platform: string, kernelRelease: string, hasDrvFs: boolean): DiskHost['kind'] {
  if (platform === 'win32') return 'windows'
  return platform === 'linux' && /microsoft/i.test(kernelRelease) && hasDrvFs ? 'wsl' : null
}

// The Windows system drive, never the root of the home directory (inside WSL the home is on the distro's own disk).
export function systemDriveRoot(kind: 'windows' | 'wsl', env: Record<string, string | undefined>): string {
  if (kind === 'wsl') return '/mnt/c'
  if (!env.SystemDrive) throw new Error('SystemDrive is not set, so the system drive cannot be located')
  return `${env.SystemDrive}\\`
}

function positiveGib(text: string | undefined, what: string): number {
  const n = Number(text)
  if (text === undefined || text === '' || !Number.isFinite(n) || n <= 0) throw new Error(`${what} must be a positive number of GiB, not ${JSON.stringify(text)}`)
  return n
}

// `floor_gib=40` / `hard_minimum_gib=15`, one key=value per line, '#' lines comments, both required.
export function parseFloors(text: string): Floors {
  const values = new Map<string, string>()
  for (const line of text.split('\n')) {
    const m = /^([a-z_]+)=(.*)$/.exec(line.trim())
    if (m) values.set(m[1], m[2].trim())
  }
  const floorGiB = positiveGib(values.get('floor_gib'), 'floor_gib')
  const hardMinimumGiB = positiveGib(values.get('hard_minimum_gib'), 'hard_minimum_gib')
  if (hardMinimumGiB > floorGiB) throw new Error(`the hard minimum (${hardMinimumGiB} GiB) must not exceed the floor (${floorGiB} GiB)`)
  return { floorBytes: floorGiB * GIB, hardMinimumBytes: hardMinimumGiB * GIB }
}

// first line: when the window opened (epoch seconds); the rest: why
export function parseWindow(text: string): Window {
  const [first, ...rest] = text.split('\n')
  const seconds = Number(first)
  if (!Number.isInteger(seconds)) throw new Error(`the compaction window marker must start with its opening time in epoch seconds, not ${JSON.stringify(first)}`)
  return { openedAtMs: seconds * 1000, reason: rest.join('\n').trim() }
}

export function formatGiB(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`
}

// the window first (more urgent), then the free-space line. `floors` null: the limits file is missing, said loudly, free space not judged.
export function noticeText(input: { freeBytes: number; floors: Floors | null; floorsPath: string; window: Window | null }): string {
  const lines: string[] = []
  if (input.window) {
    lines.push(
      `MAINTENANCE WINDOW OPEN since ${new Date(input.window.openedAtMs).toISOString()}: ${input.window.reason}`,
      'Docker Desktop and WSL are about to be stopped to compact their data disks. Pause: start no test run, build, deploy or dispatch, finish or park what is running, write your state to the card, and tell the operator you are paused. The window stays open until `make compact-docker-disk STAGE=finish` closes it.',
    )
  }
  if (input.floors === null) {
    lines.push(`DISK FLOORS UNAVAILABLE: ${input.floorsPath} is missing, so C: is not judged against a floor. Run \`${SEED_COMMAND}\`.`)
    return lines.join('\n')
  }
  if (input.freeBytes < input.floors.floorBytes) {
    lines.push(
      `LOW DISK: C: has ${formatGiB(input.freeBytes)} free, under the ${formatGiB(input.floors.floorBytes)} floor.` +
        (input.freeBytes < input.floors.hardMinimumBytes ? ` Under the ${formatGiB(input.floors.hardMinimumBytes)} hard minimum: host test runs refuse.` : ''),
      'Tell the operator now. Start no image build or large install; `make machine-report` shows what is reclaimable and `make sweep-machine` reclaims it. The Docker data disk only returns space through a compaction window (`make compact-docker-disk STAGE=prepare`).',
    )
  }
  return lines.join('\n')
}

// Reads the machine. Returns '' for a host this policy does not concern or when all is well. A fault (unreadable drive, malformed file) is ONE line.
export function diskNotice(host: DiskHost): string {
  if (host.kind === null) return ''
  try {
    const home = host.kind === 'wsl' ? host.windowsHome() : host.home()
    const floorsPath = join(home, '.danxbot', 'machine-disk-floors')
    const floorsText = host.read(floorsPath)
    const parsed = floorsText === null ? null : parseFloors(floorsText)
    // an environment override of the floor, so a live check can force the warning without filling a disk
    const override = host.env[FLOOR_ENV]
    const floors = parsed && override ? { ...parsed, floorBytes: positiveGib(override, FLOOR_ENV) * GIB } : parsed
    if (floors && floors.hardMinimumBytes > floors.floorBytes) throw new Error(`${FLOOR_ENV} must not be under the hard minimum`)
    const windowText = host.read(join(home, '.danxbot', 'compaction-window'))
    return noticeText({
      freeBytes: host.freeBytes(systemDriveRoot(host.kind, host.env)),
      floors,
      floorsPath,
      window: windowText === null ? null : parseWindow(windowText),
    })
  } catch (err: any) {
    return `DISK CHECK FAILED: ${String(err?.message ?? err).slice(0, 300)}`
  }
}

// Whether to hand `text` to the model now. A person's prompt always carries a notice; a tool call (autonomous turns have no prompt) only on a
// state change or once DISK_REPEAT_MS has passed. Returns the line to add (or null) and the state to remember.
export function diskDecision(text: string, now: number, told: DiskTold, trigger: 'prompt' | 'tool'): { line: string | null; told: DiskTold } {
  if (text === '') return { line: null, told: null }
  const stale = told === null || told.text !== text || now - told.at >= DISK_REPEAT_MS
  if (trigger === 'tool' && !stale) return { line: null, told }
  return { line: text, told: { text, at: now } }
}

export function realHost(): DiskHost {
  const kind = hostKind(process.platform, release(), existsSync('/mnt/c/Users'))
  return {
    kind,
    env: process.env,
    home: () => homedir(),
    freeBytes: root => {
      const s = statfsSync(root)
      return s.bavail * s.bsize
    },
    read: path => {
      try {
        return readFileSync(path, 'utf8')
      } catch (err: any) {
        if (err.code === 'ENOENT') return null
        throw err
      }
    },
    windowsHome: () => {
      const raw = execFileSync('cmd.exe', ['/c', 'echo %USERPROFILE%'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: WSL_CALL_TIMEOUT_MS }).replace(/\r/g, '').trim()
      if (raw === '' || raw.includes('%')) throw new Error(`could not resolve the Windows home from cmd.exe (it said '${raw}')`)
      return execFileSync('wslpath', ['-u', raw], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: WSL_CALL_TIMEOUT_MS }).trim()
    },
  }
}
