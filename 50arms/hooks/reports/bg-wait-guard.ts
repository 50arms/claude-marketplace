// CP-175: the SubagentStop guard that refuses a sub-agent ending its turn while background work it started has no result yet. Ported from danxbot's
// `subagent-bg-wait-guard.mjs` and `background-bash-runs.mjs` (DX-3087, DX-3108, DX-3756, DX-8126), which stay there until DX-8306 removes them.
// Pure over the sub-agent's own transcript lines: register.tsx reads the file (`agent_transcript_path`), asks which moved-run output files exist, and
// turns a verdict into the stop's `block`.
//
// WHY: a background task's completion notice reaches the session that spawned it only while that session's turn is live. Once a sub-agent's turn ends there is
// nothing to inject it into, so the result is lost (or surfaces in the wrong session). Two rules, both over structure and never over the agent's wording:
//   - a background BASH run (`run_in_background: true`, or a foreground call the harness moved to the background after its timeout) is closed only by a
//     completion notice the agent was live for, or a TaskStop of its id. A read of its output closes nothing. Refusals are bounded to MAX_REFUSALS in a row
//     with no tool call between them, so a refusal followed by a real wait starts the count again.
//   - a background Agent/Task spawn is consumed once its harness-issued id or output path reappears in a later user/assistant line (a `queued_command`
//     attachment is proof of the opposite and never counts). It is refused once per stop attempt (`stop_hook_active` lets the second stop through).
// Never read: `last_assistant_message`. An unrecognized confirmation shape is skipped, never refused (an ambiguous read must not manufacture a block).

export const MAX_REFUSALS = 3

// The harness's own launch messages (a Bash call that asked for `run_in_background` has the first; a call moved after its timeout has the second).
const LAUNCHED = /^\s*Command running in background with ID:\s*([^\s.,)]+)(?:\.\s+Output is being written to:\s*(.+?\.output)\.?(?:\s|$))?/
const MOVED = /Command did not complete within its \d+s timeout and was moved to the background \(ID:\s*([^)\s]+)\)\.\s+Output is being written to:\s*(.+?\.output)\.?(?:\s|$)/g
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Agent/Task confirmations: "agentId: <id>" and "output_file: <path>"; a Bash one: its id and path.
const ID_PATTERNS = [/running in background with ID:\s*([^\s.,)]+)/i, /agentId:\s*([^\s.,)]+)/i]
const PATH_PATTERNS = [/Output is being written to:\s*(\S+)/i, /output_file:\s*(\S+)/i]

export const WAIT_ADVICE =
  'Do your other available work first. With none left, stay in the turn with foreground Bash calls bounded by a timeout, ' +
  '`timeout 100 tail -n 40 -f <its output file>` (repeat it; each read also shows whether the run is stuck), until its completion notice reaches you, ' +
  'then read its final result. A Read of the file mid-run does not close the run. Stop it with TaskStop only when you mean to end it. ' +
  "Never hand the wait to a background sub-agent: `claude -p` stops waiting for one after 10 idle minutes."

export type Line = any
export type OpenRun = { toolUseId: string; names: string[] }
export type Unconsumed = { toolName: string; identifiers: string[] }

/** True when `path` is a harness task output file `<...>/claude[-<uid>]/<...>/<session uuid>/tasks/<id>.output` for this run. */
function isHarnessTaskOutput(path: string, id: string): boolean {
  const parts = path.split(/[\\/]/)
  const [session, dir, file] = parts.slice(-3)
  return dir === 'tasks' && file === `${id}.output` && SESSION_UUID.test(session ?? '') && parts.slice(0, -3).some(part => /^claude(-\d+)?$/i.test(part))
}

export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((c: any) => (c && typeof c.text === 'string' ? c.text : '')).join('')
}

function lineText(line: Line): string {
  const content = line.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b: any) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('')
}

/** The notices in a line: a user line's text, or a queued_command attachment's prompt, split into `<task-notification>` bodies. */
function noticesIn(line: Line): string[] {
  let text = ''
  if (line.type === 'user') text = lineText(line)
  else if (line.type === 'attachment' && line.attachment?.type === 'queued_command') text = String(line.attachment.prompt ?? '')
  return text.split('<task-notification>').slice(1)
}

/** A line is the stopping agent's own work unless it is a root-session line or tagged for another sidechain (DX-3108). Untagged lines count. */
export function belongsToAgent(line: Line, agentId: string): boolean {
  if (line.isSidechain === false) return false
  if (typeof line.agentId === 'string' && line.agentId !== agentId) return false
  return true
}

/** The task output paths a moved-to-background message names in the agent's Bash results: the host is asked which of them exist (the harness writes the file when it moves the run). */
export function movedOutputPaths(lines: Line[]): string[] {
  const found = new Set<string>()
  for (const line of lines) {
    const content = line.type === 'user' ? line.message?.content : null
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'tool_result') continue
      for (const m of resultText(block.content).matchAll(MOVED)) if (isHarnessTaskOutput(m[2], m[1])) found.add(m[2])
    }
  }
  return [...found]
}

function parseLaunch(text: string, explicit: boolean, line: Line, existing: ReadonlySet<string>): { id: string; path?: string } | null {
  if (explicit) {
    const match = text.match(LAUNCHED)
    return match ? { id: match[1], path: match[2] } : null
  }
  const last = [...text.matchAll(MOVED)].at(-1)
  if (!last || !isHarnessTaskOutput(last[2], last[1])) return null
  // the harness vouches with the result line's own `toolUseResult.backgroundTaskId` (printed output cannot set it); a line with none (a desktop sub-agent's file) is vouched
  // by the task output file existing on this host (a quote of another machine's or another run's message names a file this host does not have)
  const result = line.toolUseResult
  const vouched = result === undefined || result === null ? existing.has(last[2]) : typeof result === 'object' && result.backgroundTaskId === last[1]
  return vouched ? { id: last[1], path: last[2] } : null
}

/** The background Bash runs started in `lines` (the agent's turn so far, in order) that are still open. */
export function openBackgroundRuns(lines: Line[], belongs: (line: Line) => boolean, existing: ReadonlySet<string>): OpenRun[] {
  type Run = { id?: string; path?: string; launched: boolean; stopped: boolean }
  const runs = new Map<string, Run>()
  const bashCalls = new Set<string>()
  const notices: { index: number; toolUseId?: string; taskId?: string }[] = []
  let lastAssistantIndex = -1
  lines.forEach((line, index) => {
    for (const note of noticesIn(line)) {
      notices.push({ index, toolUseId: note.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1].trim(), taskId: note.match(/<task-id>([^<]+)<\/task-id>/)?.[1].trim() })
    }
    if (!belongs(line)) return
    if (line.type === 'assistant') lastAssistantIndex = index
    const content = line.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!block) continue
      if (line.type === 'assistant' && block.type === 'tool_use' && block.name === 'Bash') {
        bashCalls.add(block.id)
        if (block.input?.run_in_background === true) runs.set(block.id, { launched: false, stopped: false })
      } else if (line.type === 'user' && block.type === 'tool_result') {
        if (!bashCalls.has(block.tool_use_id)) continue
        let run = runs.get(block.tool_use_id)
        const launch = parseLaunch(resultText(block.content), Boolean(run), line, existing)
        // a foreground call the harness moved to the background is a run too
        if (!run && launch) {
          run = { launched: false, stopped: false }
          runs.set(block.tool_use_id, run)
        }
        if (!run || run.launched) continue
        run.launched = true
        run.id = launch?.id
        run.path = launch?.path
      } else if (line.type === 'assistant' && block.type === 'tool_use' && block.name === 'TaskStop') {
        const input = JSON.stringify(block.input ?? {})
        for (const run of runs.values()) if (run.launched && run.id && input.includes(run.id)) run.stopped = true
      }
    }
  })
  const open: OpenRun[] = []
  for (const [toolUseId, run] of runs) {
    if (run.stopped) continue
    // a notice closes the run only with a later assistant line of the agent's own: with none, it landed as the turn ended and the model never saw it
    const noticed = notices.some(n => n.index < lastAssistantIndex && (n.toolUseId === toolUseId || (run.id !== undefined && n.taskId === run.id)))
    if (noticed) continue
    open.push({ toolUseId, names: [run.id, run.path].filter((x): x is string => x !== undefined) })
  }
  return open
}

export function nameRuns(open: readonly OpenRun[]): string {
  return open.map(run => (run.names.length > 0 ? run.names.join(', ') : `the run started by tool call ${run.toolUseId}`)).join('; ')
}

/** How many tool calls the agent's own lines made: a refusal counts as a loop only while this stays the same. */
export function countToolCalls(lines: Line[], belongs: (line: Line) => boolean): number {
  let calls = 0
  for (const line of lines) {
    if (line.type !== 'assistant' || !belongs(line)) continue
    const content = line.message?.content
    if (Array.isArray(content)) calls += content.filter((b: any) => b && b.type === 'tool_use').length
  }
  return calls
}

/** Refusals in a row so far for `key`, counting this one; a tool call since the last refusal starts the count again. `store` is the caller's. */
export function refusalsInARow(store: Map<string, { n: number; calls: number }>, key: string, toolCalls: number): number {
  const before = store.get(key)
  const n = before !== undefined && before.calls === toolCalls ? before.n + 1 : 1
  store.set(key, { n, calls: toolCalls })
  return n
}

function extractIdentifiers(text: string): string[] {
  const found: string[] = []
  for (const re of [...ID_PATTERNS, ...PATH_PATTERNS]) {
    const m = re.exec(text)
    if (m && m[1]) found.push(m[1])
  }
  return found
}

/** Every backgrounded Agent/Task spawn of the stopping agent whose harness-issued id or output path never reappears in a later user/assistant line. */
export function findUnconsumedSpawns(lines: Line[], agentId: string): Unconsumed[] {
  const spawns: { toolName: string; toolUseId: string; lineIndex: number }[] = []
  lines.forEach((raw, i) => {
    if (raw.type !== 'assistant' || !belongsToAgent(raw, agentId)) return
    const content = raw.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block?.type !== 'tool_use') continue
      const name = String(block.name ?? '')
      if ((name === 'Task' || name === 'Agent') && block.input?.run_in_background === true) spawns.push({ toolName: name, toolUseId: String(block.id ?? ''), lineIndex: i })
    }
  })
  const unconsumed: Unconsumed[] = []
  for (const spawn of spawns) {
    let confirmedAt = -1
    let confirmation = ''
    for (let i = spawn.lineIndex + 1; i < lines.length && confirmedAt === -1; i++) {
      if (lines[i].type !== 'user' || !Array.isArray(lines[i].message?.content)) continue
      for (const block of lines[i].message.content) {
        if (block?.type === 'tool_result' && String(block.tool_use_id ?? '') === spawn.toolUseId) {
          confirmedAt = i
          confirmation = resultText(block.content)
        }
      }
    }
    // no confirmation yet, or a shape we do not know: ambiguous, never a block
    if (confirmedAt === -1) continue
    const identifiers = extractIdentifiers(confirmation)
    if (identifiers.length === 0) continue
    // consumption search is deliberately NOT scoped to the agent (DX-3108): scoping detection removes false blocks, scoping this would add them
    const consumed = lines.slice(confirmedAt + 1).some(l => (l.type === 'user' || l.type === 'assistant') && identifiers.some(id => JSON.stringify(l).includes(id)))
    if (!consumed) unconsumed.push({ toolName: spawn.toolName, identifiers })
  }
  return unconsumed
}

export function bashRunReason(open: readonly OpenRun[]): string {
  return (
    `subagent-bg-wait-guard: a background Bash command you started has no completion notice yet, and ending your turn now loses its result: ` +
    `nothing surfaces it anywhere once your turn ends. Open: ${nameRuns(open)}. ` +
    WAIT_ADVICE
  )
}

export function spawnReason(unconsumed: readonly Unconsumed[]): string {
  const items = unconsumed.map(u => `${u.toolName} (${u.identifiers.join(', ')})`).join('; ')
  return (
    `subagent-bg-wait-guard: you spawned a background task and never referenced its result again before ending your turn: structurally unconsumed: ${items}. ` +
    `A background task's completion notification is only delivered into a LIVE, ongoing turn; the moment your own turn ends there is nothing left to inject it into. ` +
    `Before ending your turn: either check it yourself right now (poll its output, read its file, or otherwise verify it directly) and continue, ` +
    `or explicitly note the still-outstanding background item in your final report so the orchestrator (who WILL receive its notification) can relay it.`
  )
}

/** The refusal for a stopping sub-agent, or null to let the stop through. `refusals` is the caller's counter store; `existing` the moved-run output files that exist. */
export function bgWaitRefusal(args: {
  lines: Line[]
  agentId: string
  sessionId: string
  stopHookActive: boolean
  existing: ReadonlySet<string>
  refusals: Map<string, { n: number; calls: number }>
}): string | null {
  const own = (line: Line) => belongsToAgent(line, args.agentId)
  const open = openBackgroundRuns(args.lines, own, args.existing)
  if (open.length > 0) {
    // bounded: MAX_REFUSALS in a row with no tool call between, then the stop goes through (the run is lost)
    return refusalsInARow(args.refusals, `${args.sessionId}-${args.agentId}`, countToolCalls(args.lines, own)) > MAX_REFUSALS ? null : bashRunReason(open)
  }
  // an Agent/Task spawn is refused once per stop attempt: the harness's own anti-loop signal
  if (args.stopHookActive) return null
  const unconsumed = findUnconsumedSpawns(args.lines, args.agentId)
  return unconsumed.length === 0 ? null : spawnReason(unconsumed)
}

/** The transcript text as parsed lines; a malformed line is skipped, never aborts the scan. */
export function parseTranscript(text: string): Line[] {
  const lines: Line[] = []
  for (const l of text.split(/\r?\n/)) {
    if (!l.trim()) continue
    try {
      lines.push(JSON.parse(l))
    } catch {
      // skip
    }
  }
  return lines
}
