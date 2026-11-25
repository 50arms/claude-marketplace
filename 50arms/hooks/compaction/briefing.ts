// What a session's start after a compaction or a clear fills into the bundle's texts: the live data only the machine knows (the comments still owed an answer, the plan, the cards in
// flight, the sub-agents still running, the work not yet pushed), each the value of one slot. The words around a value are the bundle's. Pure: register.tsx reads each source (the plan
// view, the engine's agent list, git) and hands it here; a source that could not be read arrives as a failure with its reason, never as an empty one.

export type Source<T> = { ok: true; value: T } | { ok: false; reason: string }

export type BriefingCard = { id: string; title: string }
export type BriefingAgent = { id: string; type: string; description: string }
export type GitState = { branch: string | null; changed: number; ahead: number | null; upstream: string | null }

// One person comment the agent still owes an answer, as GET /api/plan-sessions/me/owed-comments (the dashboard's `OwedComment`) hands it over. Only the fields the briefing words.
export type OwedComment = { cardId: string; cardTitle: string; commentId: number; author: { name: string }; excerpt: { text: string }; state: 'sent' | 'seen'; waitedMs: number }

const CARDS_SHOWN = 8
const AGENTS_SHOWN = 8
const REASON_MAX = 120

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

// `git status --porcelain=v1 -b`: the first line is `## branch...upstream [ahead N, behind M]` (or `## No commits yet on x`, `## HEAD (no branch)`),
// every other line is one changed or untracked path. `ahead` is null when there is no upstream (nothing to be ahead of: every commit is unpushed).
export function parseGitStatus(out: string): GitState | null {
  const lines = out.split('\n').filter(l => l !== '')
  const head = lines[0]
  if (head === undefined || !head.startsWith('## ')) return null
  const changed = lines.length - 1
  const m = /^## (.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head)
  if (m === null) return null
  const branch = m[1] === 'HEAD (no branch)' || m[1]!.startsWith('No commits yet on ') ? null : m[1]!
  const upstream = m[2] ?? null
  const ahead = /ahead (\d+)/.exec(m[3] ?? '')
  return { branch, changed, upstream, ahead: upstream === null ? null : ahead === null ? 0 : Number(ahead[1]) }
}

const OWED_STATE_LABEL: Record<OwedComment['state'], string> = { sent: 'Sent', seen: 'Seen' }
const EXCERPT_MAX = 160
const TITLE_MAX = 60
const AUTHOR_MAX = 40
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

function waitedText(ms: number): string {
  if (ms < MINUTE_MS) return 'under a minute'
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} min`
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)} h`
  return `${Math.floor(ms / DAY_MS)} d`
}

// The `owed_list` slot: every comment still owed an answer, oldest first (the order the route answers), never capped (a comment dropped is a comment nobody answers). A failed read is said as a
// failure: an omitted list would read as "nothing owed".
export function owedListSlot(owed: Source<OwedComment[]>): string {
  if (!owed.ok) return `NOT KNOWN, the read failed (${oneLine(owed.reason, REASON_MAX)})`
  if (owed.value.length === 0) return 'none'
  return owed.value.map(c => `${c.cardId} ${oneLine(c.cardTitle, TITLE_MAX)}, comment ${c.commentId} from ${oneLine(c.author.name, AUTHOR_MAX)} [${OWED_STATE_LABEL[c.state]}, waiting ${waitedText(c.waitedMs)}]: "${oneLine(c.excerpt.text, EXCERPT_MAX)}"`).join('; ')
}

// The `card_list` slot: the cards in flight on the session's plan.
export function cardListSlot(cards: Source<BriefingCard[]>): string {
  if (!cards.ok) return `not known (${oneLine(cards.reason, REASON_MAX)})`
  if (cards.value.length === 0) return 'none on your plan'
  const shown = cards.value.slice(0, CARDS_SHOWN).map(c => `${c.id} ${oneLine(c.title, 60)}`)
  const more = cards.value.length - shown.length
  return `${shown.join('; ')}${more > 0 ? `, and ${more} more` : ''}`
}

// The `agent_list` slot: the sub-agents still running (they carry on through a compaction).
export function agentListSlot(agents: Source<BriefingAgent[]>): string {
  if (!agents.ok) return `not known (${oneLine(agents.reason, REASON_MAX)})`
  if (agents.value.length === 0) return 'none running'
  const shown = agents.value.slice(0, AGENTS_SHOWN).map(a => `${a.id} (${a.type}) ${oneLine(a.description, 60)}`)
  const more = agents.value.length - shown.length
  return `${shown.join('; ')}${more > 0 ? `, and ${more} more` : ''}`
}

// The `git_status` slot: the work not yet pushed, in the session's own checkout.
export function gitStatusSlot(git: Source<GitState>): string {
  if (!git.ok) return `not known (${oneLine(git.reason, REASON_MAX)})`
  const g = git.value
  const where = g.branch === null ? 'a detached checkout' : `branch ${g.branch}`
  const parts = [
    g.changed === 0 ? 'no uncommitted changes' : `${g.changed} uncommitted ${g.changed === 1 ? 'path' : 'paths'}`,
    g.upstream === null ? 'no upstream branch (nothing on it is pushed)' : g.ahead === 0 ? 'nothing unpushed' : `${g.ahead} unpushed ${g.ahead === 1 ? 'commit' : 'commits'}`,
  ]
  return `in the session's own checkout (${where}): ${parts.join(', ')}`
}

// The `plan_id` and `plan_name` slots: the plan the session is on, or that it is on none.
export const planIdSlot = (plan: { ref: string } | null): string => (plan === null ? 'none' : plan.ref)
export const planNameSlot = (plan: { name: string } | null): string => (plan === null ? 'no plan' : oneLine(plan.name, 80))

// How long the plugin keeps the note of an agent whose compaction proposal passed: a compaction that never delivered a start must not name the agent for a later, different compaction.
export const COMPACTING_NOTE_TTL_MS = 10 * 60_000
