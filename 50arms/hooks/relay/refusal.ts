import { toolName } from '../plan/config'
import { isBrowserKeepaliveTool } from './browser'

// The plugin's name as the host stamps it on a call the plugin raised (`next.origin.plugin`).
export const PLUGIN_NAME = '50arms'

// The origin the host stamps on a call the model (or the engine itself) made; every call a plugin raises carries that plugin's name instead.
export const ENGINE_ORIGIN = 'engine'

// a call a plugin raised itself (`$.mcp.call`, `$.tool.call`), any plugin's, not the model's. Its result goes to the plugin, never the model.
export const raisedByPlugin = (origin: { plugin: string }): boolean => origin.plugin !== ENGINE_ORIGIN

// the model's own leave of a plan or card (`session_connect` with `disconnect: true`) is a natural break; the band's Disconnect is the plugin's own call, a person's press, and is never one.
export const isModelLeave = (e: { disconnect?: unknown }, target: unknown, origin: { plugin: string }): boolean => e.disconnect === true && target !== null && !raisedByPlugin(origin)

// in auto permission mode the engine puts a hook-initiated `$.mcp.call` to its classifier like any tool call, and a call the
// classifier "gave no verdict" on is refused: `$.mcp.call(<server>, <tool>) refused: The server-side auto mode classifier gave no verdict for
// <tool>`. The plugin's own tool.check hook allows the calls it raises on its own server (`ownServerCheck` below, seated by the `on('tool.check', ...)` in register.tsx); when one is
// refused anyway (an engine that gates it differently), nothing in the plugin can fix it, so the failure is told with the real words and the fix
// that works: an allow rule for the server's tools. A restart is not needed (observed: the relay attached and the band showed the plan
// minutes after the rule was added, in the same session), so the relay retries a refused call on its own and the plan load is retried by the
// session-start watch; a restart is the fallback when it does not clear.

// The permission rule that allows every tool of the plugin's own server.
export const CLASSIFIER_RULE = `${toolName('')}*`

export const CLASSIFIER_FIX = `the auto mode classifier refused the plugin's own call; updating the plugin does not change that: add the allow rule ${CLASSIFIER_RULE} to permissions.allow in ~/.claude/settings.json once the person says yes (or the person adds it themselves); it then resumes on its own (restart if not)`

// What the engine says of a call the auto mode classifier refused (any verdict of it: no verdict, or judged unsafe).
const CLASSIFIER_MARK = /auto mode classifier/i

export type Refusal = { detail: string; fix: string }

// The refusal in a failure message, or null when the message is none.
export function classifierRefusal(message: string): Refusal | null {
  return CLASSIFIER_MARK.test(message) ? { detail: message, fix: CLASSIFIER_FIX } : null
}

// What `api()` (register.tsx) puts in a 50arms_api call beyond the method, the path and `background`: the one list of them, so a key added to it is a key the stale-MCP check knows.
export type ApiExtra = { query?: object; body?: object; board?: number; reply_to_file?: boolean }
const API_EXTRA_KEYS: Record<keyof ApiExtra, true> = { query: true, body: true, board: true, reply_to_file: true }
const API_CALL_KEYS: readonly string[] = ['method', 'path', 'background', ...Object.keys(API_EXTRA_KEYS)]

// A 50 Arms MCP from before a release that added a key the hooks send with a 50arms_api call (`background`, `reply_to_file`, ...) refuses that key (a strict schema:
// MCP error -32602, `unrecognized_keys`, `keys: ["reply_to_file"]`). The call is not retried without the key (one path); the failure is STALE_MCP_LINE,
// short enough to stay whole in every toast this failure reaches. It is recognised by the keys the refusal names: any key `api()` sends makes it one, never one key by name;
// a refusal of a key the plugin does not send, or a message that is no unrecognized-keys refusal, is some other failure.
export const STALE_MCP_LINE = `50 Arms' MCP is older than the plugin: revert the plugin release, or restart the session.`

const KEYS_LIST = /"keys":\s*\[([^\]]*)\]/
const KEYS_SENTENCE = /Unrecognized keys?(?:\(s\))? in object:\s*((?:'[^']*'(?:,\s*)?)+)/i

export function isStaleMcpRefusal(message: string): boolean {
  if (!/unrecognized[_ ]keys?/i.test(message)) return false
  const named = message.match(KEYS_LIST)?.[1] ?? message.match(KEYS_SENTENCE)?.[1] ?? ''
  return [...named.matchAll(/["']([^"']+)["']/g)].some(m => API_CALL_KEYS.includes(m[1] as string))
}

// the plugin ships the permission its own hooks need. Auto permission mode puts a hook-initiated `$.mcp.call` to its classifier like any
// tool call, and a call the classifier gave no verdict on is refused, which left the relay dead. `tool.check` is the engine's permission decision,
// asked before the mode's decider (the classifier) and last-word-wins, so an `allow` here settles a call THIS plugin raised on its OWN server's
// tools (and the Browser pane tools above). `next.origin` is set by the host from where the call came from: the model's own call to the same tool arrives as `engine` and keeps the
// engine's verdict. The engine's verdict is asked first and a `deny` (a user's `permissions.deny`, an organization's rule) always stands; an
// organization `ceiling` of `ask` also stands, as the ceiling is the most permissive verdict it lets the tool reach.
// also the three tools of the desktop's Browser pane the plan-tab keepalive calls (relay/browser.ts): a look at the pane and the plan page opened
// again, raised by this plugin only; the model's own call to the same tool keeps the engine's verdict.
export function isOwnServerCall(origin: { plugin: string }, tool: string): boolean {
  return origin.plugin === PLUGIN_NAME && (tool.startsWith(toolName('')) || isBrowserKeepaliveTool(tool))
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
