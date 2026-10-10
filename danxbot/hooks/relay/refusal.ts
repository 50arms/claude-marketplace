import { toolName } from '../plan/config'

// The plugin's name as the host stamps it on a call the plugin raised (`next.origin.plugin`).
export const PLUGIN_NAME = 'danxbot'

// DX-4805: in auto permission mode the engine puts a hook-initiated `$.mcp.call` to its classifier like any tool call, and a call the
// classifier "gave no verdict" on is refused: `$.mcp.call(<server>, <tool>) refused: The server-side auto mode classifier gave no verdict for
// <tool>`. The plugin's own tool.check hook allows the calls it raises on its own server (`ownServerCheck` below, seated by the `on('tool.check', ...)` in register.tsx); when one is
// refused anyway (an engine that gates it differently), nothing in the plugin can fix it, so the failure is told with the real words and the fix
// that works: an allow rule for the server's tools, then a restart (the session's rules are read at start).

// The permission rule that allows every tool of the plugin's own server.
export const CLASSIFIER_RULE = `${toolName('')}*`

export const CLASSIFIER_FIX = `the auto mode classifier refused the plugin's own call, and updating the plugin does not change that: add the allow rule ${CLASSIFIER_RULE} to permissions.allow in ~/.claude/settings.json (or allow it in /permissions) and restart the session`

// What the engine says of a call the auto mode classifier refused (any verdict of it: no verdict, or judged unsafe).
const CLASSIFIER_MARK = /auto mode classifier/i

export type Refusal = { detail: string; fix: string }

// The refusal in a failure message, or null when the message is none.
export function classifierRefusal(message: string): Refusal | null {
  return CLASSIFIER_MARK.test(message) ? { detail: message, fix: CLASSIFIER_FIX } : null
}

// DX-4805: the plugin ships the permission its own hooks need. Auto permission mode puts a hook-initiated `$.mcp.call` to its classifier like any
// tool call, and a call the classifier gave no verdict on is refused, which left the relay dead. `tool.check` is the engine's permission decision,
// asked before the mode's decider (the classifier) and last-word-wins, so an `allow` here settles a call THIS plugin raised on its OWN server's
// tools. `next.origin` is set by the host from where the call came from: the model's own call to the same tool arrives as `engine` and keeps the
// engine's verdict. The engine's verdict is asked first and a `deny` (a user's `permissions.deny`, an organization's rule) always stands; an
// organization `ceiling` of `ask` also stands, as the ceiling is the most permissive verdict it lets the tool reach.
export function isOwnServerCall(origin: { plugin: string }, tool: string): boolean {
  return origin.plugin === PLUGIN_NAME && tool.startsWith(toolName(''))
}

type CheckInput = { tool: string; ceiling?: string }
type CheckVerdict = { decision: 'allow' | 'ask' | 'deny'; reason?: string }
type CheckNext = { (e: any): Promise<CheckVerdict>; origin: { plugin: string } }

export async function ownServerCheck(e: CheckInput, next: CheckNext): Promise<CheckVerdict> {
  if (!isOwnServerCall(next.origin, String(e.tool))) return next(e)
  const engine = await next(e)
  if (engine.decision === 'deny' || e.ceiling === 'ask') return engine
  return { decision: 'allow', reason: `${PLUGIN_NAME}'s own call to its own server` }
}
