import "./run-tests-with-npm-test.generated"
// CP-70: TEMPORARY dual name, removed with this file once installs have moved. A person who allowed `mcp__plugin_50arms_dashboard__*` (the server key of
// plugin 0.17.71) must not be asked on every call to the same tools under `mcp__plugin_50arms_platform__*`: the plugin cannot edit their settings, so its
// tool.check answers allow only when their own permissions.allow already holds the old rule, and never over a deny or ask rule on the new tools.
import { describe, expect } from 'claude-code/testing'

import { toolName } from '../hooks/plan/config'
import { legacyRuleCheck, legacySettingsPaths } from '../hooks/relay/legacy-rule'
import { test } from './plan-kit'

const NEW = toolName('50arms_api')
const OLD_ALL = 'mcp__plugin_50arms_dashboard__*'
const settings = (permissions: Record<string, string[]>) => JSON.stringify({ permissions })
const nextOf = (plugin: string, engine: 'allow' | 'ask' | 'deny' = 'ask') => Object.assign(async () => ({ decision: engine, reason: 'engine' }), { origin: { plugin } }) as any
const check = (tool: string, files: string[], plugin = 'engine', engine: 'allow' | 'ask' | 'deny' = 'ask', ceiling?: string) =>
  legacyRuleCheck({ tool, ceiling }, nextOf(plugin, engine), async () => files)

describe('CP-70 the old dashboard allow rule covers the platform tools (temporary dual name)', () => {
  test('the old wildcard rule present: the model call to a platform tool is allowed', async () => {
    expect((await check(NEW, [settings({ allow: [OLD_ALL] })])).decision).toBe('allow')
  })

  test('the bare old server rule and the old rule for that very tool allow it; the old rule for another tool does not', async () => {
    expect((await check(NEW, [settings({ allow: ['mcp__plugin_50arms_dashboard'] })])).decision).toBe('allow')
    expect((await check(NEW, [settings({ allow: ['mcp__plugin_50arms_dashboard__50arms_api'] })])).decision).toBe('allow')
    expect((await check(NEW, [settings({ allow: ['mcp__plugin_50arms_dashboard__plan_connect'] })])).reason).toBe('engine')
  })

  test('the rule can sit in any of the user, project and local settings', async () => {
    expect((await check(NEW, ['{}', '{}', settings({ allow: [OLD_ALL] })])).decision).toBe('allow')
  })

  test('no old rule: the engine keeps its verdict', async () => {
    expect((await check(NEW, [])).reason).toBe('engine')
    expect((await check(NEW, [settings({ allow: ['Bash', 'mcp__plugin_50arms_platform__*'] })])).reason).toBe('engine')
    expect((await check(NEW, ['not json', settings({})])).reason).toBe('engine')
  })

  test('a deny or ask rule on the new tool or prefix wins over the old allow, in any settings file', async () => {
    for (const rule of [NEW, 'mcp__plugin_50arms_platform__*', 'mcp__plugin_50arms_platform']) {
      expect((await check(NEW, [settings({ allow: [OLD_ALL] }), settings({ deny: [rule] })])).reason).toBe('engine')
      expect((await check(NEW, [settings({ allow: [OLD_ALL], ask: [rule] })])).reason).toBe('engine')
    }
    expect((await check(NEW, [settings({ allow: [OLD_ALL], deny: ['mcp__plugin_50arms_platform__plan_connect'] })])).decision).toBe('allow')
  })

  test("the engine's own deny and an organization ask ceiling stand", async () => {
    expect((await check(NEW, [settings({ allow: [OLD_ALL] })], 'engine', 'deny')).decision).toBe('deny')
    expect((await check(NEW, [settings({ allow: [OLD_ALL] })], 'engine', 'ask', 'ask')).decision).toBe('ask')
  })

  test('a non-plugin tool, another plugin server and a call the plugin raised itself keep the engine verdict', async () => {
    const files = [settings({ allow: [OLD_ALL] })]
    expect((await check('Bash', files)).reason).toBe('engine')
    expect((await check('mcp__plugin_other_platform__x', files)).reason).toBe('engine')
    expect((await check(NEW, files, '50arms')).reason).toBe('engine')
  })

  test('the settings files are the user one (CLAUDE_CONFIG_DIR, else HOME/.claude), the project one and the local one', () => {
    expect(legacySettingsPaths({ configDir: '/c', home: '/h', cwd: '/p' })).toEqual(['/c/settings.json', '/p/.claude/settings.json', '/p/.claude/settings.local.json'])
    expect(legacySettingsPaths({ configDir: undefined, home: '/h', cwd: '/p' })).toEqual(['/h/.claude/settings.json', '/p/.claude/settings.json', '/p/.claude/settings.local.json'])
  })
})
