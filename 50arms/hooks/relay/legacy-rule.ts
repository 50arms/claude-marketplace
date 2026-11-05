import { toolName } from '../plan/config'
import { raisedByPlugin } from './refusal'

// CP-70: TEMPORARY dual name, to be removed with its tests once installs have moved (a card is filed for it). Plugin 0.17.71 named its server `dashboard`; a person who
// allowed `mcp__plugin_50arms_dashboard__*` would now be asked on every call to the same tools under `mcp__plugin_50arms_platform__*`, and a plugin cannot edit
// their settings. So the model's call to a platform tool is allowed here exactly when the person's own permissions.allow (user, project, local) holds the old
// rule covering that tool, and no deny or ask rule names the new tool or its prefix. This mirrors a grant the person made; it never widens one.
const OLD_SERVER = 'mcp__plugin_50arms_dashboard'

type CheckInput = { tool: string; ceiling?: string }
type CheckVerdict = { decision: 'allow' | 'ask' | 'deny'; reason?: string }
type CheckNext = { (e: any): Promise<CheckVerdict>; origin: { plugin: string } }

// The three files whose permissions Claude Code merges: the user's (CLAUDE_CONFIG_DIR, else HOME/.claude), the project's and the project's local one.
export function legacySettingsPaths(where: { configDir: string | undefined; home: string; cwd: string }): string[] {
  const user = where.configDir !== undefined && where.configDir !== '' ? where.configDir : `${where.home}/.claude`
  return [`${user}/settings.json`, `${where.cwd}/.claude/settings.json`, `${where.cwd}/.claude/settings.local.json`]
}

const rulesOf = (texts: string[], kind: 'allow' | 'deny' | 'ask'): string[] =>
  texts.flatMap(text => {
    try {
      const list = JSON.parse(text)?.permissions?.[kind]
      return Array.isArray(list) ? list.filter((r: unknown): r is string => typeof r === 'string') : []
    } catch {
      // a settings file that is not JSON holds no rule we can read
      return []
    }
  })

export async function legacyRuleCheck(e: CheckInput, next: CheckNext, readSettings: () => Promise<string[]>): Promise<CheckVerdict> {
  const tool = String(e.tool)
  const prefix = toolName('')
  if (!tool.startsWith(prefix) || raisedByPlugin(next.origin)) return next(e)
  const engine = await next(e)
  if (engine.decision !== 'ask' || e.ceiling === 'ask') return engine
  const texts = await readSettings()
  const bare = tool.slice(prefix.length)
  const newServer = prefix.slice(0, -2)
  const named = (r: string) => r === newServer || r === `${prefix}*` || r === tool
  if ([...rulesOf(texts, 'deny'), ...rulesOf(texts, 'ask')].some(named)) return engine
  const covers = (r: string) => r === OLD_SERVER || r === `${OLD_SERVER}__*` || r === `${OLD_SERVER}__${bare}`
  return rulesOf(texts, 'allow').some(covers) ? { decision: 'allow', reason: `the person's allow rule for ${OLD_SERVER} covers this tool (CP-70)` } : engine
}
