import "./run-tests-with-npm-test.generated"
// CP-105: a session start on Windows sets the live ForegroundLockTimeout to 0 through one detached powershell.exe run (hooks/context/foreground.ts).
// The kit fakes the process: its answer by program, every run recorded in `runCalls`, every row told to the model in `told`.
import { describe, expect } from 'claude-code/testing'

import { foregroundLockArgv, foregroundLockNotice, parseForegroundLockAnswer } from '../hooks/context/foreground'
import { test, SURFACES, dashboard, startSession } from './plan-kit'

const WINDOWS = { SystemDrive: 'C:', USERPROFILE: 'C:\Users\dev' }
const WSL = { WSL_DISTRO_NAME: 'Ubuntu' }
const lockRuns = (d: any) => d.runCalls.filter((argv: string[]) => argv[0] === 'powershell.exe' && argv.join(' ').includes('SystemParametersInfo'))

describe('the foreground lock timeout, pure parts', () => {
  test('only a Windows host gets a program, and the script holds the two SPI calls with no double quote', () => {
    expect(foregroundLockArgv('wsl')).toBeNull()
    expect(foregroundLockArgv(null)).toBeNull()
    const argv = foregroundLockArgv('windows')!
    const script = argv[argv.length - 1]
    expect(script).toContain('0x2000')
    expect(script).toContain('0x2001, 0, [IntPtr]::Zero, 3)')
    expect(script).not.toContain('"')
  })
  test('answers: unchanged and set are fine, anything else names its reason', () => {
    expect(parseForegroundLockAnswer(0, 'unchanged\r\n', '')).toEqual({ ok: true })
    expect(parseForegroundLockAnswer(0, 'set 2147483647\r\n', '')).toEqual({ ok: true })
    expect(parseForegroundLockAnswer(1, '', 'setting the timeout failed with Win32 error 87')).toEqual({ ok: false, reason: 'setting the timeout failed with Win32 error 87' })
    expect(parseForegroundLockAnswer(0, 'nope', '')).toEqual({ ok: false, reason: 'unexpected answer "nope"' })
  })
  test('the notice names the error and what stays unfixed', () => {
    expect(foregroundLockNotice('Win32 error 87')).toMatch(/\(Win32 error 87\).*leaks a kernel security token/)
  })
})

for (const surface of SURFACES) {
  describe(`the foreground lock timeout hook on ${surface}`, () => {
    async function started($: any, on: any, env: Record<string, string>, answer?: { exitCode?: number; stdout: string }) {
      on('classic.SessionStart', () => ({}) as any)
      const d = dashboard(on, { connected: false, env })
      if (answer !== undefined) d.world.processes['powershell.exe'] = answer
      await startSession($, d, surface)
      await d.clock.settle()
      return d
    }

    test('a Windows session start runs the one program and tells the model nothing when it worked', async ($, on) => {
      const d = await started($, on, WINDOWS, { stdout: 'set 2147483647\r\n' })
      expect(lockRuns(d)).toHaveLength(1)
      expect(d.relay.told.filter((t: string) => /ForegroundLockTimeout/.test(t))).toEqual([])
    })

    test('an already-zero timeout is fine and quiet', async ($, on) => {
      const d = await started($, on, WINDOWS, { stdout: 'unchanged\r\n' })
      expect(lockRuns(d)).toHaveLength(1)
      expect(d.relay.told.filter((t: string) => /ForegroundLockTimeout/.test(t))).toEqual([])
    })

    test('a refused call is told to the model once, naming the error', async ($, on) => {
      const d = await started($, on, WINDOWS, { exitCode: 1, stdout: '' })
      const told = d.relay.told.filter((t: string) => /ForegroundLockTimeout/.test(t))
      expect(told).toHaveLength(1)
      expect(told[0]).toContain('powershell.exe exited 1')
    })

    test('inside WSL nothing is run for it', async ($, on) => {
      const d = await started($, on, WSL)
      expect(lockRuns(d)).toEqual([])
    })

    test('a host with neither marker runs nothing', async ($, on) => {
      const d = await started($, on, {})
      expect(lockRuns(d)).toEqual([])
    })
  })
}
