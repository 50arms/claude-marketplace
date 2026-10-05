import type { GuardEnv } from './pacing-guard'

// DX-4340 (PLAN-29 section 3): the pacing line a new sub-agent is handed. danxbot renders it (GET /api/pacing/line: the registry text
// `pacing.sub_agent_line` filled with the session's account's level, budget and reset; the account is placed server-side from the
// calling session's own id), so this module only fetches, checks the answer and hands the text on. Unknown is explicit on the wire:
// `reason` set and `line` null (no session, no usage report, no verdict, pacing off), and then the sub-agent is told nothing.

export const LINE_PATH = '/api/pacing/line'
const ERROR_MAX = 200

// The line in `body`, null when danxbot has none for this session, or an error string when the answer is not the contract.
export function parseLine(body: any): string | null | { error: string } {
  if (body === null || typeof body !== 'object') return { error: 'the pacing line answer is not an object' }
  if (body.line === null) return typeof body.reason === 'string' ? null : { error: 'the pacing line answer has no line and no reason' }
  if (typeof body.line !== 'string' || body.line.trim() === '') return { error: 'the pacing line answer has no readable line' }
  return body.line
}

let lastError: string | null = null
export function resetPacingLine(): void {
  lastError = null
}

// The line for this session, or null (nothing to say). Never throws: a failed read is a toast once per distinct text, and the
// sub-agent starts without a line, as it did before pacing existed.
export async function pacingLine(env: Pick<GuardEnv, 'call' | 'toast'>): Promise<string | null> {
  let failure: string | null = null
  let line: string | null = null
  try {
    const r = await env.call('GET', LINE_PATH)
    // another repo's session has no danxbot dashboard: nothing to say, nothing to complain about
    if (r.unreachable) return null
    if (!r.ok) failure = `the pacing line read answered ${r.status}`
    else {
      const parsed = parseLine(r.body)
      if (parsed !== null && typeof parsed === 'object') failure = parsed.error
      else line = parsed
    }
  } catch (err: any) {
    failure = String(err?.message ?? err)
  }
  failure = failure === null ? null : failure.slice(0, ERROR_MAX)
  if (failure !== lastError) {
    lastError = failure
    if (failure !== null) env.toast(`Usage pacing line not read (the sub-agent starts without it): ${failure}`)
  }
  return line
}

// `result` of the SubagentStart chain with the line appended to its additionalContext (one entry per hook).
export function withLine<R extends { additionalContext?: string[] }>(result: R, line: string | null): R {
  return line === null ? result : { ...result, additionalContext: [...(result.additionalContext ?? []), line] }
}
