import type { HostKind } from './disk'

// On Windows 11 the window manager takes a reference on a security token for every process that attaches to a console and whose parent may
// not take the foreground, and never releases it (a kernel memory leak that lasts until a restart). It skips that path while the LIVE
// ForegroundLockTimeout is 0, and Windows stores 2147483647 there at every logon, so each logon session applies it again. A process started under
// the Claude app may make the call; one started by Task Scheduler is refused (error 87). Everything here is pure: `register.tsx` runs the process.

export const FOREGROUND_LOCK_TIMEOUT_MS = 20_000

const SPI_GETFOREGROUNDLOCKTIMEOUT = '0x2000'
const SPI_SETFOREGROUNDLOCKTIMEOUT = '0x2001'
// SPIF_UPDATEINIFILE | SPIF_SENDCHANGE
const SPIF_UPDATE_AND_BROADCAST = 3

// The one PowerShell program: read the live value, set it to 0 only when it is not 0, read it back. It prints `unchanged` (already 0) or
// `set <old value>` and exits 0, or throws (exit 1) naming the Win32 error. It contains no double quote, so no argv quoting rule can change it.
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$q = [char]34",
  "$sig = '[DllImport(' + $q + 'user32.dll' + $q + ', SetLastError=true)] public static extern bool SystemParametersInfo(uint a, uint b, ref uint c, uint d); [DllImport(' + $q + 'user32.dll' + $q + ', SetLastError=true)] public static extern bool SystemParametersInfo(uint a, uint b, IntPtr c, uint d);'",
  'Add-Type -Name Fg -Namespace W -MemberDefinition $sig',
  "function Fail($what) { throw ($what + ' failed with Win32 error ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }",
  '$v = [uint32]0',
  `if (-not [W.Fg]::SystemParametersInfo(${SPI_GETFOREGROUNDLOCKTIMEOUT}, 0, [ref]$v, 0)) { Fail 'reading the timeout' }`,
  "if ($v -eq 0) { 'unchanged'; return }",
  `if (-not [W.Fg]::SystemParametersInfo(${SPI_SETFOREGROUNDLOCKTIMEOUT}, 0, [IntPtr]::Zero, ${SPIF_UPDATE_AND_BROADCAST})) { Fail 'setting the timeout' }`,
  '$after = [uint32]0',
  `if (-not [W.Fg]::SystemParametersInfo(${SPI_GETFOREGROUNDLOCKTIMEOUT}, 0, [ref]$after, 0)) { Fail 'reading the timeout back' }`,
  "if ($after -ne 0) { throw ('the timeout reads ' + $after + ' after it was set to 0') }",
  "'set ' + $v",
].join('; ')

// Only a Windows host: macOS and Linux have no such window manager, and a WSL session's processes are not the leaking ones.
export function foregroundLockArgv(kind: HostKind | null): string[] | null {
  if (kind !== 'windows') return null
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', SCRIPT]
}

// The model's one-time notice for a refused call: names the error and what stays unfixed.
export function foregroundLockNotice(reason: string): string {
  const why = reason.replace(/\s+/g, ' ').trim().slice(0, 300)
  return `50 Arms could not set Windows' live ForegroundLockTimeout to 0 (${why || 'no error text'}). Until it is set, each background process started outside the Claude app leaks a kernel security token (the Windows foreground-launch token leak), which slows the machine until a restart. Tell the person once; do not retry.`
}

export function parseForegroundLockAnswer(exitCode: number, stdout: string, stderr: string): { ok: true } | { ok: false; reason: string } {
  const out = stdout.trim()
  if (exitCode === 0 && (out === 'unchanged' || /^set [0-9]+$/.test(out))) return { ok: true }
  return { ok: false, reason: exitCode === 0 ? `unexpected answer ${JSON.stringify(out.slice(0, 100))}` : (stderr.trim() || out || `powershell.exe exited ${exitCode}`) }
}
