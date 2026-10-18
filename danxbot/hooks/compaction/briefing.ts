// DX-4993 (PLAN-42 rule R-4): the resume briefing an operator session reads in its first turn after a compaction. A compaction replaces the
// conversation with a summary; this hands back what the summary tends to lose and what only the machine knows: the plan, the cards in flight, the
// sub-agents still running (they carry on through a compaction) and the work not yet pushed. Pure: register.tsx reads each source (the plan view, the
// engine's agent list, git) and hands them here; a source that could not be read arrives as `unavailable` with its reason, never as an empty one.

export type Source<T> = { ok: true; value: T } | { ok: false; reason: string }

export type BriefingCard = { id: string; title: string }
export type BriefingAgent = { id: string; type: string; description: string }
export type GitState = { branch: string | null; changed: number; ahead: number | null; upstream: string | null }

export type BriefingInput = {
  plan: { ref: string; name: string } | null
  cards: Source<BriefingCard[]>
  agents: Source<BriefingAgent[]>
  git: Source<GitState>
}

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

function cardsLine(cards: Source<BriefingCard[]>): string {
  if (!cards.ok) return `Cards in flight: not known (${oneLine(cards.reason, REASON_MAX)}).`
  if (cards.value.length === 0) return 'Cards in flight: none on your plan.'
  const shown = cards.value.slice(0, CARDS_SHOWN).map(c => `${c.id} ${oneLine(c.title, 60)}`)
  const more = cards.value.length - shown.length
  return `Cards in flight on your plan: ${shown.join('; ')}${more > 0 ? `, and ${more} more` : ''}. Read each card before you act on it.`
}

function agentsLine(agents: Source<BriefingAgent[]>): string {
  if (!agents.ok) return `Sub-agents: not known (${oneLine(agents.reason, REASON_MAX)}).`
  if (agents.value.length === 0) return 'Sub-agents running: none.'
  const shown = agents.value.slice(0, AGENTS_SHOWN).map(a => `${a.id} (${a.type}) ${oneLine(a.description, 60)}`)
  const more = agents.value.length - shown.length
  return `Sub-agents still running (they carried on through the compaction): ${shown.join('; ')}${more > 0 ? `, and ${more} more` : ''}.`
}

function gitLine(git: Source<GitState>): string {
  if (!git.ok) return `Work not pushed: not known (${oneLine(git.reason, REASON_MAX)}).`
  const g = git.value
  const where = g.branch === null ? 'a detached checkout' : `branch ${g.branch}`
  const parts = [
    g.changed === 0 ? 'no uncommitted changes' : `${g.changed} uncommitted ${g.changed === 1 ? 'path' : 'paths'}`,
    g.upstream === null ? 'no upstream branch (nothing on it is pushed)' : g.ahead === 0 ? 'nothing unpushed' : `${g.ahead} unpushed ${g.ahead === 1 ? 'commit' : 'commits'}`,
  ]
  return `Work not pushed, in the session's own checkout (${where}): ${parts.join(', ')}.`
}

// DX-5385: how the main agent picks up after a compaction, in order; the resume prompt (register.tsx resumeAfterCompaction) carries it inside the briefing.
export const RESUME_PROCEDURE = "Resume now, without asking the person, in this order: (1) re-invoke every skill you had loaded, because the compaction truncated their bodies; (2) read the newest handoff agent note on your plan's in-flight cards; (3) re-read each In Progress card you hold; (4) check the sub-agents listed below and wait for their notifications, never starting a duplicate; (5) continue the step that was in progress."

export function briefingText(input: BriefingInput): string {
  const plan = input.plan === null ? 'You are on no plan.' : `Your plan is ${input.plan.ref} ${oneLine(input.plan.name, 80)}.`
  return `[50 ARMS] Your conversation was just compacted. ${RESUME_PROCEDURE} ${plan} ${cardsLine(input.cards)} ${agentsLine(input.agents)} ${gitLine(input.git)}`
}

// DX-5344: a sub-agent's own compaction is followed by its own briefing, never the main agent's (the plan, the cards and the checkout belong to the session that spawned it). A sub-agent resumes
// from its summary and the progress notes it kept before compacting, so the briefing names who it is and points at them. `type` and `description` are null when the engine no longer lists the agent.
export type SubagentBriefingInput = { id: string; type: string | null; description: string | null }

// How long the plugin keeps the note of an agent whose compaction proposal passed: a compaction that never delivered a start must not name the agent for a later, different compaction.
export const COMPACTING_NOTE_TTL_MS = 10 * 60_000

export function subagentBriefingText(input: SubagentBriefingInput): string {
  const label = `${input.id}${input.type === null ? '' : ` (${input.type})`}${input.description === null ? '' : ` ${oneLine(input.description, 80)}`}`
  return `[50 ARMS] Your conversation was just compacted. You are sub-agent ${label}. Resume from your summary and from the progress notes you kept before compacting, then carry on with the task you were given and report back to the session that spawned you. The plan and cards are your parent's, not yours.`
}
