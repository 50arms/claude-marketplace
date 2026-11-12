import type { Api } from '../plan/load'
import { errText } from '../plan/load'

// CP-76 (PLAN-116 G-8): the session's role (the `orchestrator` profile for a session on a plan, `work` for one holding a card, each with the card procedure) is
// 50 Arms' text, served by `GET /api/plan-sessions/me/role`. The plugin hands it to the model as hook context, of the standing a skill or system note has, and never
// asks the model to read it from a file (a tool result is weighed as data). This file words it and decides when it is owed; register.tsx does the reads.
export const ROLE_PATH = '/api/plan-sessions/me/role'

// the role the model was last handed, kept to tell a role that changed (another plan or card) from one it already holds
export type RoleTold = { profile: string; hash: string } | null

export type Role = { profile: string; text: string }

// FNV-1a over the text: a role is told again only when its text differs, and the state keeps the hash, never the (large) text
export function roleHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16)
}

// What the route answered: the role, nothing (a session on neither a plan nor a card, or a live orchestrator dispatch whose system prompt is the text: `roleInstruction: null`),
// or a failure whose reason names why. A `roleInstruction` that is not `{profile, text}` is a contract break, never nothing.
export function roleOf(r: Api): { kind: 'role'; role: Role } | { kind: 'nothing' } | { kind: 'failed'; reason: string } {
  if (!r.ok) return { kind: 'failed', reason: errText(r) }
  const given = r.body?.roleInstruction
  if (given === null) return { kind: 'nothing' }
  const { profile, text } = given ?? {}
  if (typeof profile !== 'string' || profile === '' || typeof text !== 'string' || text === '') {
    return { kind: 'failed', reason: 'bad_response: the dashboard answered a roleInstruction that is not {profile, text}' }
  }
  return { kind: 'role', role: { profile, text } }
}

// The role as the model reads it. `replaces`: the model held another role already (a connect to another plan or card), which this one takes the place of.
export function roleBlock(role: Role, replaces: boolean): string {
  const head = `Your role from 50 Arms is the "${role.profile}" profile, the workflow you work by.${replaces ? ' It replaces any role text given earlier in this conversation.' : ''}`
  return `${head}\n${role.text}`
}

export const roleFailureLine = (reason: string): string => `⚠ Could not load this session's role from 50 Arms (${reason}). Tell the operator this role fetch failed.`

// Whether a connect owes the role: the session holds none yet, or the one it holds differs. A start, resume or compaction owes it whatever was told before (the conversation lost it).
export const roleOwedOnConnect = (told: RoleTold, role: Role): boolean => told === null || told.profile !== role.profile || told.hash !== roleHash(role.text)
