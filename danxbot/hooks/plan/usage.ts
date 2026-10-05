import type { SessionRateLimit } from 'claude-code'

// DX-4336 (PLAN-29 R-1): what the session reports of its account's rate-limit windows. Pure (no `$`): register.tsx reads
// `$.session.usage().rateLimits`, hands them here and sends the result to danxbot (PUT /api/plan-sessions/me/usage).

export type UsageWindowBody = { percentUsed: number; resetsAt: string }
// The report's body: danxbot's parseSessionUsage (src/issues/db/plan-session-usage.ts) refuses any other key.
export type UsageBody = { reportedAt: string; measuredAt: string; accountUuid?: string; fiveHour?: UsageWindowBody; sevenDay?: UsageWindowBody }

// The windows the harness names `five_hour` and `seven_day`; a gateway's `spend_limit` is not a rate-limit window and is left out.
type WindowKind = 'five_hour' | 'seven_day'

function windowOf(limits: readonly SessionRateLimit[], kind: WindowKind): UsageWindowBody | null {
  const found = limits.find(l => l.kind === kind)
  if (found === undefined || found.resetsAt === undefined) return null
  const resets = Date.parse(found.resetsAt)
  // a window with no readable reset time cannot be placed on an account, so it is not reported (danxbot stores a window whole)
  if (Number.isNaN(resets)) return null
  return { percentUsed: found.percentUsed, resetsAt: new Date(resets).toISOString() }
}

// The report for `limits`, sent at `nowMs`, or null when there is nothing to report: off a subscription the harness has no windows, and
// until a response has been seen (`measuredAtMs` null) there is no figure whose age could be told. `measuredAtMs` is when the last API
// response the figure came from arrived (CAV-6): only a response advances it, never the tick that re-sends an idle session's frozen
// figure, so danxbot can tell the session that is working from the one that is only ticking. `accountUuid` is
// CLAUDE_CODE_ACCOUNT_UUID, set only by a desktop-hosted session.
export function usageBody(limits: readonly SessionRateLimit[], nowMs: number, measuredAtMs: number | null, accountUuid: string | undefined): UsageBody | null {
  if (measuredAtMs === null) return null
  const fiveHour = windowOf(limits, 'five_hour')
  const sevenDay = windowOf(limits, 'seven_day')
  if (fiveHour === null && sevenDay === null) return null
  return {
    reportedAt: new Date(nowMs).toISOString(),
    // a response cannot have arrived after this report is sent
    measuredAt: new Date(Math.min(measuredAtMs, nowMs)).toISOString(),
    ...(accountUuid === undefined || accountUuid === '' ? {} : { accountUuid }),
    ...(fiveHour === null ? {} : { fiveHour }),
    ...(sevenDay === null ? {} : { sevenDay }),
  }
}
