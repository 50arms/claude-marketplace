import "./run-tests-with-npm-test.generated"
// CP-1: the machine's free-space notice as the engine runs it: a person's prompt, an autonomous tool call, a sub-agent's tool call and a session start,
// on a fake host (hooks/context/disk.ts holds the pure parts, tests/disk-notice.test.mjs checks them). Everything the plugin learns of the machine
// comes through `$` (`$.env`, `$.fs`, `$.process.run`), which the kit fakes: files by path, a process's answer by program, every run recorded.
import { describe, expect } from 'claude-code/testing'

import { DISK_MEASURE_MS, DISK_REPEAT_MS } from '../hooks/context/disk'
import { test, SURFACES, dashboard, startSession } from './plan-kit'

const GIB = 1024 ** 3
const FLOORS_FILE = 'floor_gib=40\nhard_minimum_gib=15\n'
const LOW = /^LOW DISK: C: has 30\.0 GB free, under the 40\.0 GB floor\./

const WSL = { WSL_DISTRO_NAME: 'Ubuntu' }
const WINDOWS = { SystemDrive: 'C:', USERPROFILE: 'C:\\Users\\dev' }

// inside WSL: cmd.exe names the Windows home, wslpath converts it, df answers the free bytes of /mnt/c
function wslMachine(d: any, over: { freeGiB?: number; optedIn?: boolean; floors?: string | null; window?: string } = {}) {
  const { freeGiB = 30, optedIn = true, floors = FLOORS_FILE, window } = over
  d.world.processes['cmd.exe'] = { stdout: 'C:\\Users\\dev\r\n' }
  d.world.processes['wslpath'] = { stdout: '/mnt/c/Users/dev\n' }
  d.world.processes['df'] = { stdout: `     Avail\n${freeGiB * GIB}\n` }
  d.world.files['/mnt/c/Users/dev'] = ''
  if (optedIn) d.world.files['/mnt/c/Users/dev/.danxbot'] = ''
  if (floors !== null) d.world.files['/mnt/c/Users/dev/.danxbot/machine-disk-floors'] = floors
  if (window !== undefined) d.world.files['/mnt/c/Users/dev/.danxbot/compaction-window'] = window
}

const runsOf = (d: any, program: string) => d.runCalls.filter((argv: string[]) => argv[0] === program)
const noticeOf = (context: string[] | undefined) => (context ?? []).slice(1).join('\n')

for (const surface of SURFACES) {
  describe(`the disk notice hooks on ${surface}`, () => {
    async function started($: any, on: any, env: Record<string, string>, arrange: (d: any) => void) {
      on('classic.SessionStart', () => ({}) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      const d = dashboard(on, { connected: false, env })
      arrange(d)
      await startSession($, d, surface)
      return d
    }
    const tool = async ($: any, agentId?: string) => ((await $.tool.call({ tool: 'Bash', command: 'ls', ...(agentId === undefined ? {} : { agentId }) } as any)).context ?? []) as string[]

    test('a prompt carries the LOW DISK notice, every time, beside the time stamp', async ($, on) => {
      const d = await started($, on, WSL, wslMachine)
      const first = await $.prompt.submit({ text: 'hello' })
      expect(first.context).toHaveLength(2)
      expect(noticeOf(first.context)).toMatch(LOW)
      const second = await $.prompt.submit({ text: 'again' })
      expect(noticeOf(second.context)).toMatch(LOW)
      expect(d.runCalls.length).toBeGreaterThan(0)
    })

    test('an autonomous tool call tells once, stays quiet, and tells again after the repeat interval', async ($, on) => {
      const d = await started($, on, WSL, wslMachine)
      expect(noticeOf(await tool($))).toMatch(LOW)
      expect(await tool($)).toHaveLength(1)
      await d.clock.advance(DISK_REPEAT_MS)
      expect(noticeOf(await tool($))).toMatch(LOW)
    })

    test('a changed notice is told at once', async ($, on) => {
      const d = await started($, on, WSL, wslMachine)
      expect(noticeOf(await tool($))).toMatch(LOW)
      d.world.processes['df'] = { stdout: `Avail\n${10 * GIB}\n` }
      await d.clock.advance(DISK_MEASURE_MS)
      expect(noticeOf(await tool($))).toMatch(/Under the 15\.0 GB hard minimum: host test runs refuse/)
    })

    test('a sub-agent started after the main loop was told still hears it once', async ($, on) => {
      await started($, on, WSL, wslMachine)
      expect(noticeOf(await tool($))).toMatch(LOW)
      expect(noticeOf(await tool($, 'a1'))).toMatch(LOW)
      expect(await tool($, 'a1')).toHaveLength(1)
      expect(await tool($)).toHaveLength(1)
    })

    test('a session start clears what was told, so the next tool call tells again', async ($, on) => {
      await started($, on, WSL, wslMachine)
      expect(noticeOf(await tool($))).toMatch(LOW)
      await $.classic.SessionStart({ source: 'startup', cwd: '/work', session_id: 'sess-own', transcript_path: '/work/main.jsonl' })
      expect(noticeOf(await tool($))).toMatch(LOW)
    })

    test('the Windows home is resolved once per session, and a tool call within a minute measures nothing again', async ($, on) => {
      const d = await started($, on, WSL, wslMachine)
      await tool($)
      await tool($)
      await tool($, 'a1')
      expect(runsOf(d, 'cmd.exe')).toHaveLength(1)
      expect(runsOf(d, 'wslpath')).toHaveLength(1)
      expect(runsOf(d, 'df')).toHaveLength(1)
      await d.clock.advance(DISK_MEASURE_MS)
      await tool($)
      expect(runsOf(d, 'df')).toHaveLength(2)
      await $.prompt.submit({ text: 'fresh' })
      expect(runsOf(d, 'df')).toHaveLength(3)
      expect(runsOf(d, 'cmd.exe')).toHaveLength(1)
    })

    test('a Windows home that could not be resolved is one DISK CHECK FAILED line and is not tried again', async ($, on) => {
      const d = await started($, on, WSL, m => {
        wslMachine(m)
        m.world.processes['cmd.exe'] = { exitCode: 1, stdout: '' }
      })
      expect(noticeOf(await tool($))).toMatch(/^DISK CHECK FAILED: cmd\.exe exited 1/)
      await $.prompt.submit({ text: 'again' })
      await d.clock.advance(DISK_MEASURE_MS)
      await tool($)
      expect(runsOf(d, 'cmd.exe')).toHaveLength(1)
    })

    test('a machine that has not opted in (no ~/.danxbot directory) is told nothing and nothing is measured', async ($, on) => {
      const d = await started($, on, WSL, m => wslMachine(m, { optedIn: false, floors: null }))
      const prompt = await $.prompt.submit({ text: 'hello' })
      expect(prompt.context).toHaveLength(1)
      expect(await tool($)).toHaveLength(1)
      expect(runsOf(d, 'df')).toEqual([])
    })

    test('an opted-in machine with no limits file is told DISK FLOORS UNAVAILABLE, never a built-in default', async ($, on) => {
      await started($, on, WSL, m => wslMachine(m, { floors: null, freeGiB: 1 }))
      const notice = noticeOf((await $.prompt.submit({ text: 'hello' })).context)
      expect(notice).toMatch(/^DISK FLOORS UNAVAILABLE: .*machine-disk-floors is missing/)
      expect(notice).not.toMatch(/LOW DISK/)
    })

    test('enough free space is silent', async ($, on) => {
      await started($, on, WSL, m => wslMachine(m, { freeGiB: 100 }))
      expect((await $.prompt.submit({ text: 'hello' })).context).toHaveLength(1)
      expect(await tool($)).toHaveLength(1)
    })

    test('an open compaction window tells the session to pause', async ($, on) => {
      await started($, on, WSL, m => wslMachine(m, { freeGiB: 100, window: '1792728384\ncompacting docker\n' }))
      const notice = noticeOf((await $.prompt.submit({ text: 'hello' })).context)
      expect(notice).toMatch(/^MAINTENANCE WINDOW OPEN since 2026-10-22T.*: compacting docker/)
      expect(notice).toMatch(/start no test run, build, deploy or dispatch/)
      expect(notice).toMatch(/run from the danxbot checkout/)
    })

    test('both overrides apply, then the limits are checked against each other', async ($, on) => {
      await started($, on, { ...WSL, DANXBOT_DISK_FLOOR_GIB: '500' }, wslMachine)
      expect(noticeOf((await $.prompt.submit({ text: 'hello' })).context)).toMatch(/under the 500\.0 GB floor/)
    })

    test('the hard-minimum override forces the hard-minimum path', async ($, on) => {
      await started($, on, { ...WSL, DANXBOT_DISK_HARD_MINIMUM_GIB: '35' }, wslMachine)
      expect(noticeOf((await $.prompt.submit({ text: 'hello' })).context)).toMatch(/Under the 35\.0 GB hard minimum/)
    })

    test('an override that puts the hard minimum over the floor is one DISK CHECK FAILED line', async ($, on) => {
      await started($, on, { ...WSL, DANXBOT_DISK_FLOOR_GIB: '10' }, wslMachine)
      expect(noticeOf((await $.prompt.submit({ text: 'hello' })).context)).toMatch(/^DISK CHECK FAILED: the hard minimum/)
    })

    test('a malformed limits file is one DISK CHECK FAILED line', async ($, on) => {
      await started($, on, WSL, m => wslMachine(m, { floors: 'floor_gib=abc\nhard_minimum_gib=15\n' }))
      expect(noticeOf((await $.prompt.submit({ text: 'hello' })).context)).toMatch(/^DISK CHECK FAILED: floor_gib must be a positive number/)
    })

    test('on Windows the system drive is measured from USERPROFILE, with no WSL interop', async ($, on) => {
      const d = await started($, on, WINDOWS, m => {
        m.world.processes['powershell.exe'] = { stdout: `${30 * GIB}\r\n` }
        m.world.files['/Users/dev/.danxbot'] = ''
        m.world.files['/Users/dev/.danxbot/machine-disk-floors'] = FLOORS_FILE
      })
      expect(noticeOf((await $.prompt.submit({ text: 'hello' })).context)).toMatch(LOW)
      expect(runsOf(d, 'powershell.exe')).toHaveLength(1)
      expect(runsOf(d, 'powershell.exe')[0].join(' ')).toContain("DriveInfo 'C'")
      expect(runsOf(d, 'cmd.exe')).toEqual([])
    })

    test('inside WSL the drive measured is /mnt/c, never the WSL home', async ($, on) => {
      const d = await started($, on, WSL, wslMachine)
      await $.prompt.submit({ text: 'hello' })
      expect(runsOf(d, 'df')).toEqual([['df', '-B1', '--output=avail', '/mnt/c']])
    })

    test('a host with neither marker (no C:) is told nothing and nothing is run', async ($, on) => {
      const d = await started($, on, {}, m => wslMachine(m))
      expect((await $.prompt.submit({ text: 'hello' })).context).toHaveLength(1)
      expect(await tool($)).toHaveLength(1)
      expect(runsOf(d, 'df')).toEqual([])
      expect(runsOf(d, 'cmd.exe')).toEqual([])
    })
  })
}
