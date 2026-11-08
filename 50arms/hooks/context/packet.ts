import type { Api } from '../plan/load'
import { errText } from '../plan/load'
import { isText, type Told } from './events'

// A main session's start packet. The dashboard builds ONE packet for what the session holds (its role's workflow text, then the
// plan's in-flight cards with each newest agent note, the card it holds whole, and its running sub-agents), and the session's own dashboard server
// writes it to a local file, since a tool reply that large reaches the model as a 2 KB preview. The plugin makes the read at a session's start and
// after a compaction, so the agent makes no route call of its own, and tells the model the file to read once; a connect that binds the session
// answers the same `startPacket`, so a sign-in the plugin's own watch completes passes on that one (sign-in.ts). The packet's wording is the
// dashboard's; this file carries the pointer line and the failure line only.

export const START_PACKET_PATH = '/api/plan-sessions/me/start-packet'

// What the server answers in place of the packet's text (the dashboard MCP server's spill of the packet): where the file is,
// its size, and the one Read call that takes it whole (`allow_large`: a Read without it stops at 25,000 tokens, under the orchestrator's packet).
type StartPacketFile = { profile: string; path: string; bytes: number; instruction: string }

function asStartPacketFile(value: unknown): StartPacketFile | null {
  if (value === null || typeof value !== 'object') return null
  const { profile, path, bytes, instruction } = value as Record<string, unknown>
  return isText(profile) && isText(path) && typeof bytes === 'number' && Number.isInteger(bytes) && bytes >= 0 && isText(instruction) ? { profile, path, bytes, instruction } : null
}

// The read's answer (or a connect's envelope, which carries the same `startPacket` key) as a told line: the pointer to the file, nothing
// (the session holds no plan and no card, or a connect bound nothing new: `{startPacket: null}`), or a failure whose reason names why.
// A packet that came inline (`text`, no `path`) is a dashboard MCP older than the dashboard: the model would get a preview of it, so it
// is a failure that names the remedy, never a line built from the text.
export function startPacketTold(r: Api): Told {
  if (!r.ok) return { kind: 'failed', reason: errText(r) }
  const body = r.body
  if (body === null || typeof body !== 'object' || !('startPacket' in body)) return { kind: 'failed', reason: 'bad_response: the dashboard answered no startPacket' }
  if (body.startPacket === null) return { kind: 'nothing' }
  const file = asStartPacketFile(body.startPacket)
  if (file === null) {
    const inline = body.startPacket !== null && typeof body.startPacket === 'object' && typeof (body.startPacket as { text?: unknown }).text === 'string'
    return { kind: 'failed', reason: inline ? 'old_mcp: the dashboard MCP server answered the packet inline, with no file: reconnect it with /mcp or start a new session' : 'bad_response: startPacket is not {profile, path, bytes, instruction}' }
  }
  return { kind: 'text', text: `[50 ARMS] Your start packet is already fetched for you. File: ${file.path} (${file.bytes} bytes, the ${file.profile} role). ${file.instruction}` }
}

export const startPacketFailureLine = (reason: string) => `⚠ Could not load your start packet (${reason}). Tell the operator this start packet fetch failed.`
