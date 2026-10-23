import type { DiskTold } from '../../types'

// CP-1: the machine's free-space warning for every session. The Windows dev machine keeps two limits in one file, `<home>/.danxbot/machine-disk-floors`
// (floor_gib warns, hard_minimum_gib refuses host test runs), and a marker file `<home>/.danxbot/compaction-window` while Docker's data disks are
// being compacted. Everything here is pure: it takes facts as arguments and never reaches the machine. `register.tsx` gathers the facts through `$`
// (`$.fs`, `$.env`, `$.process.run`), so the hook kit's fake host drives the wiring and no `node:` import enters the hooks module.

const GIB = 1024 ** 3
// a tool call asks for the cached notice for this long; a person's prompt always measures again
export const DISK_MEASURE_MS = 60_000
// an unchanged notice is told again to the same agent on a tool call only after this long (a person's prompt always carries it)
export const DISK_REPEAT_MS = 10 * 60_000
// the agents remembered as told; the oldest is forgotten past it (the same bound as the other per-agent maps)
export const DISK_TOLD_KEEP = 256
export const MAIN_AGENT = 'main'
export const SEED_COMMAND = 'make seed-machine-disk-floors'
export const FLOOR_ENV = 'DANXBOT_DISK_FLOOR_GIB'
export const HARD_MINIMUM_ENV = 'DANXBOT_DISK_HARD_MINIMUM_GIB'

export type Floors = { floorBytes: number; hardMinimumBytes: number }
export type Window = { openedAtMs: number; reason: string }
export type HostKind = 'windows' | 'wsl'
export type DiskEnv = Record<string, string | undefined>

// 'windows' (SystemDrive is set), 'wsl' (WSL_DISTRO_NAME is set, C: is mounted at /mnt/c), or null: any other host has no C: and is not this policy's concern
export function hostKindOf(env: DiskEnv): HostKind | null {
  if (env.WSL_DISTRO_NAME) return 'wsl'
  return env.SystemDrive ? 'windows' : null
}

// The Windows system drive, never the root of the home directory (inside WSL the home is on the distro's own disk).
export function systemDriveRoot(kind: HostKind, env: DiskEnv): string {
  if (kind === 'wsl') return '/mnt/c'
  if (!env.SystemDrive) throw new Error('SystemDrive is not set, so the system drive cannot be located')
  return `${env.SystemDrive}\\`
}

export function joinPath(kind: HostKind, home: string, ...parts: string[]): string {
  const sep = kind === 'windows' ? '\\' : '/'
  return [home.replace(/[\\/]+$/, ''), ...parts].join(sep)
}

// the command whose stdout is the free bytes of the system drive. `$` has no statfs, so the drive is asked of a process: `df` in WSL, .NET's DriveInfo on Windows.
export function freeSpaceArgv(kind: HostKind, env: DiskEnv): string[] {
  const root = systemDriveRoot(kind, env)
  if (kind === 'wsl') return ['df', '-B1', '--output=avail', root]
  const letter = /^([A-Za-z]):/.exec(root)?.[1]
  if (!letter) throw new Error(`SystemDrive ${JSON.stringify(env.SystemDrive)} is not a drive letter`)
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `(New-Object System.IO.DriveInfo '${letter}').AvailableFreeSpace`]
}

export function parseFreeBytes(stdout: string): number {
  const last = stdout.trim().split(/\r?\n/).pop() ?? ''
  const n = Number(last.trim())
  if (!Number.isInteger(n) || n < 0) throw new Error(`the free-space command did not answer a byte count (it said ${JSON.stringify(stdout.trim().slice(0, 100))})`)
  return n
}

// `echo %USERPROFILE%` from cmd.exe, as the Windows path it names
export function parseWindowsProfile(cmdStdout: string): string {
  const raw = cmdStdout.replace(/\r/g, '').trim()
  if (raw === '' || raw.includes('%')) throw new Error(`could not resolve the Windows home from cmd.exe (it said '${raw}')`)
  return raw
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
  return { floorBytes: positiveGib(values.get('floor_gib'), 'floor_gib') * GIB, hardMinimumBytes: positiveGib(values.get('hard_minimum_gib'), 'hard_minimum_gib') * GIB }
}

export function formatGiB(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`
}

// danxbot's two overrides (a live check forces a warning or the hard-minimum path without filling a disk), then the two limits are checked against each other.
export function applyOverrides(floors: Floors, env: DiskEnv): Floors {
  const floorOverride = env[FLOOR_ENV]
  const hardOverride = env[HARD_MINIMUM_ENV]
  const out = {
    floorBytes: floorOverride ? positiveGib(floorOverride, FLOOR_ENV) * GIB : floors.floorBytes,
    hardMinimumBytes: hardOverride ? positiveGib(hardOverride, HARD_MINIMUM_ENV) * GIB : floors.hardMinimumBytes,
  }
  if (out.hardMinimumBytes > out.floorBytes) throw new Error(`the hard minimum (${formatGiB(out.hardMinimumBytes)}) must not exceed the floor (${formatGiB(out.floorBytes)})`)
  return out
}

// first line: when the window opened (epoch seconds); the rest: why
export function parseWindow(text: string): Window {
  const [first, ...rest] = text.split('\n')
  const seconds = Number(first)
  if (!Number.isInteger(seconds)) throw new Error(`the compaction window marker must start with its opening time in epoch seconds, not ${JSON.stringify(first)}`)
  return { openedAtMs: seconds * 1000, reason: rest.join('\n').trim() }
}

// the window first (more urgent), then the free-space line. `floors` null: the limits file is missing, said loudly, free space not judged.
// The make targets exist only in the danxbot checkout and this notice appears in every repo, so it says where to run them.
export function noticeText(input: { freeBytes: number; floors: Floors | null; floorsPath: string; window: Window | null }): string {
  const lines: string[] = []
  if (input.window) {
    lines.push(
      `MAINTENANCE WINDOW OPEN since ${new Date(input.window.openedAtMs).toISOString()}: ${input.window.reason}`,
      'Docker Desktop and WSL are about to be stopped to compact their data disks. Pause: start no test run, build, deploy or dispatch, finish or park what is running, write your state to the card, and tell the operator you are paused. The window stays open until `make compact-docker-disk STAGE=finish` (run from the danxbot checkout) closes it.',
    )
  }
  if (input.floors === null) {
    lines.push(`DISK FLOORS UNAVAILABLE: ${input.floorsPath} is missing, so C: is not judged against a floor. Run \`${SEED_COMMAND}\` from the danxbot checkout.`)
    return lines.join('\n')
  }
  if (input.freeBytes < input.floors.floorBytes) {
    lines.push(
      `LOW DISK: C: has ${formatGiB(input.freeBytes)} free, under the ${formatGiB(input.floors.floorBytes)} floor.` +
        (input.freeBytes < input.floors.hardMinimumBytes ? ` Under the ${formatGiB(input.floors.hardMinimumBytes)} hard minimum: host test runs refuse.` : ''),
      'Tell the operator now. Start no image build or large install. From the danxbot checkout, `make machine-report` shows what is reclaimable and `make sweep-machine` reclaims it; the Docker data disk only returns space through a compaction window (`make compact-docker-disk STAGE=prepare`).',
    )
  }
  return lines.join('\n')
}

export function diskFault(err: unknown): string {
  return `DISK CHECK FAILED: ${String((err as any)?.message ?? err).slice(0, 300)}`
}

// The facts register.tsx gathered. `floorsText` / `windowText` null: the file is absent. A fault (unparseable file, unreadable drive) is ONE line.
export function diskNotice(input: { env: DiskEnv; freeBytes: number; floorsText: string | null; floorsPath: string; windowText: string | null }): string {
  try {
    const floors = input.floorsText === null ? null : applyOverrides(parseFloors(input.floorsText), input.env)
    return noticeText({ freeBytes: input.freeBytes, floors, floorsPath: input.floorsPath, window: input.windowText === null ? null : parseWindow(input.windowText) })
  } catch (err: any) {
    return diskFault(err)
  }
}

// Whether to hand `text` to `agent` now. A person's prompt always carries a notice; a tool call (autonomous turns have no prompt) only on a state change
// or once DISK_REPEAT_MS has passed since THAT agent was told, so a sub-agent started right after the main loop was told still hears it once.
// Returns the line to add (or null) and the state to remember.
export function diskDecision(text: string, now: number, told: DiskTold, trigger: 'prompt' | 'tool', agent: string): { line: string | null; told: DiskTold } {
  const rest = { ...told }
  delete rest[agent]
  if (text === '') return { line: null, told: rest }
  const was = told[agent]
  const stale = was === undefined || was.text !== text || now - was.at >= DISK_REPEAT_MS
  if (trigger === 'tool' && !stale) return { line: null, told }
  const next: DiskTold = { ...rest, [agent]: { text, at: now } }
  const keys = Object.keys(next)
  if (keys.length > DISK_TOLD_KEEP) delete next[keys[0]]
  return { line: text, told: next }
}
