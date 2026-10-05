import type { SessionRateLimit } from 'claude-code'

// DX-4336 (PLAN-29 R-1): what the session reports of its account's rate-limit windows. Pure (no `$`): register.tsx reads
// `$.session.usage().rateLimits`, hands them here and posts the result on the session heartbeat.

export type UsageWindowBody = { percentUsed: number; resetsAt: string }
// The heartbeat's `usage` body: danxbot's parseHeartbeatUsage (src/issues/db/plan-session-usage.ts) refuses any other key.
export type UsageBody = { reportedAt: string; accountUuid?: string; fiveHour?: UsageWindowBody; sevenDay?: UsageWindowBody }

// The windows the harness names `five_hour` and `seven_day`; a gateway's `spend_limit` is not a rate-limit window and is left out.
function windowOf(limits: readonly SessionRateLimit[], kind: string): UsageWindowBody | null {
  const found = limits.find(l => l.kind === kind)
  if (found === undefined || found.resetsAt === undefined) return null
  const resets = Date.parse(found.resetsAt)
  // a window with no readable reset time cannot be placed on an account, so it is not reported (danxbot stores a window whole)
  if (Number.isNaN(resets)) return null
  return { percentUsed: found.percentUsed, resetsAt: new Date(resets).toISOString() }
}

// The report for `limits` read at `nowMs`, or null when there is nothing to report (off a subscription the harness has no windows,
// and before the first response it has none yet). `accountUuid` is CLAUDE_CODE_ACCOUNT_UUID, set only by a desktop-hosted session.
export function usageBody(limits: readonly SessionRateLimit[], nowMs: number, accountUuid: string | undefined): UsageBody | null {
  const fiveHour = windowOf(limits, 'five_hour')
  const sevenDay = windowOf(limits, 'seven_day')
  if (fiveHour === null && sevenDay === null) return null
  return {
    reportedAt: new Date(nowMs).toISOString(),
    ...(accountUuid === undefined || accountUuid === '' ? {} : { accountUuid }),
    ...(fiveHour === null ? {} : { fiveHour }),
    ...(sevenDay === null ? {} : { sevenDay }),
  }
}
