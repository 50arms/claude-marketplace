import type { Draft, ProblemRow, SolutionRow, StepRow } from '../../types'
import type { Handlers } from './handlers'
import { ACCENT, CARD_TITLE_MAX, DANGER, DASHBOARD, SUCCESS, WARNING, busyKey } from './config'
import { WORDS, age } from './words'

export type Ui = {
  draft: Draft | null
  busy: string | null
  talk: number | null
  planId: number
  now: number
  // The in-app browser exists on the desktop surface only.
  hasBrowser: boolean
}

function problemUrl(planId: number, p: ProblemRow): string {
  return `${DASHBOARD}/plans/${planId}/cards/${p.cardId}/problems/PBLM-${p.id}`
}

function countSteps(steps: StepRow[]): { done: number; total: number } {
  let done = 0
  let total = 0
  for (const s of steps) {
    if (s.steps.length > 0) {
      const inner = countSteps(s.steps)
      done += inner.done
      total += inner.total
    } else {
      total += 1
      if (s.checked) done += 1
    }
  }
  return { done, total }
}

function standing(E: any, p: ProblemRow): any {
  const { Text } = E
  return p.type === 'action' ? (
    <Text color={DANGER} bold>■ Action required</Text>
  ) : (
    <Text color={WARNING} bold>● Open question</Text>
  )
}

function stepList(hd: Handlers, E: any, p: ProblemRow, s: SolutionRow, steps: StepRow[], depth: number): any {
  const { Box, Text, Button, Markdown } = E
  return (
    <Box flexDirection="column" paddingLeft={depth === 0 ? 0 : 2}>
      {steps.map(step => {
        const group = step.steps.length > 0
        const inner = countSteps(step.steps)
        const allDone = group && inner.done === inner.total
        return (
          <Box key={`st-${step.id}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              {!group && (
                <Button key={`tick-${step.id}`} plain onPress={() => hd.checkStep(p, s, step)}>
                  {step.checked ? '☑' : '☐'}
                </Button>
              )}
              <Text dimColor>{step.label}.</Text>
              <Text bold={group}>{step.title}</Text>
              {allDone && <Text color={SUCCESS}>All done</Text>}
            </Box>
            {step.description && (
              <Box paddingLeft={4}>
                <Markdown key={`std-${step.id}`} text={step.description} dimColor />
              </Box>
            )}
            {group && stepList(hd, E, p, s, step.steps, depth + 1)}
          </Box>
        )
      })}
    </Box>
  )
}

function solutionCard(hd: Handlers, E: any, ui: Ui, p: ProblemRow, s: SolutionRow): any {
  const { Box, Text, Button, Input, Markdown } = E
  const w = WORDS[p.type]
  const isBusy = busyKey.isSaving(ui.busy, p.id)
  const d = ui.draft && ui.draft.problemId === p.id && ui.draft.solutionId === s.id ? ui.draft : null
  const progress = countSteps(s.steps)
  return (
    <Box
      key={`s-${s.id}`}
      flexDirection="column"
      borderStyle="round"
      borderColor={s.recommended ? ACCENT : undefined}
      borderDimColor={!s.recommended}
      paddingX={1}
      gap={1}
    >
      <Box flexDirection="column">
        {s.recommended && <Text color={ACCENT} bold>★ {w.recommended}</Text>}
        <Box flexDirection="row" gap={1}>
          <Text bold>{s.title}</Text>
          {progress.total > 0 && (
            <Text color={progress.done === progress.total ? SUCCESS : undefined} dimColor={progress.done !== progress.total}>
              {progress.done}/{progress.total} steps
            </Text>
          )}
        </Box>
      </Box>
      {s.body && (
        <Box flexDirection="column">
          <Text dimColor bold>{w.body}</Text>
          <Markdown key={`sb-${s.id}`} text={s.body} />
        </Box>
      )}
      {s.steps.length > 0 && stepList(hd, E, p, s, s.steps, 0)}
      {(s.pro || s.con) && (
        <Box flexDirection="column">
          <Text dimColor bold>{w.proCon}</Text>
          {s.pro && (
            <Box flexDirection="row" gap={1}>
              <Text color={SUCCESS} bold>+ {w.pro}:</Text>
              <Text>{s.pro}</Text>
            </Box>
          )}
          {s.con && (
            <Box flexDirection="row" gap={1}>
              <Text color={DANGER} bold>− {w.con}:</Text>
              <Text>{s.con}</Text>
            </Box>
          )}
        </Box>
      )}
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button
          key={`use-${s.id}`}
          variant={s.recommended ? 'primary' : 'secondary'}
          onPress={() => !isBusy && hd.useSolution(p, s)}
        >
          {w.use}
        </Button>
        <Button key={`note-${s.id}`} dimColor onPress={() => hd.toggleDraft(p, s.id, 'note')}>
          {w.useNote}
        </Button>
        {p.type === 'action' && (
          <Button key={`rej-${s.id}`} dimColor onPress={() => hd.toggleDraft(p, s.id, 'reject')}>
            Reject, with a note
          </Button>
        )}
      </Box>
      {d?.kind === 'note' && (
        <Input
          key={`note-in-${s.id}`}
          autoFocus
          placeholder="Your note (required)…"
          submitLabel={w.use}
          onSubmit={(text: string) => hd.useSolutionWithNote(p, s, text)}
        />
      )}
      {d?.kind === 'reject' && (
        <Input
          key={`rej-in-${s.id}`}
          autoFocus
          placeholder="Why you are rejecting this (required)…"
          submitLabel="Reject"
          onSubmit={(text: string) => hd.rejectSolution(p, s, text)}
        />
      )}
    </Box>
  )
}

function picker(hd: Handlers, E: any, ui: Ui, p: ProblemRow): any {
  const { Box, Input } = E
  const w = WORDS[p.type]
  return (
    <Box flexDirection="column" gap={1}>
      {p.solutions.map(s => solutionCard(hd, E, ui, p, s))}
      <Input
        key={`free-${p.id}`}
        placeholder={w.freeform}
        submitLabel={w.send}
        onSubmit={(text: string) => hd.answerFreeform(p, text)}
      />
    </Box>
  )
}

function discussion(hd: Handlers, E: any, ui: Ui, p: ProblemRow): any {
  const { Box, Text, Button, Input, Markdown } = E
  const isOpen = ui.talk === p.id
  return (
    <Box flexDirection="column">
      <Button key={`talk-${p.id}`} plain dimColor onPress={() => hd.toggleTalk(p.id)}>
        {`${isOpen ? '▾' : '▸'} Discussion (${p.comments.length}${p.moreComments > 0 ? '+' : ''})`}
      </Button>
      {isOpen && (
        <Box flexDirection="column" gap={1} paddingLeft={2}>
          {p.comments.length === 0 && p.moreComments === 0 && <Text dimColor>No comments yet.</Text>}
          {p.moreComments > 0 && (
            <Text dimColor>Up to {p.moreComments} more comment{p.moreComments === 1 ? '' : 's'} on this card in the browser.</Text>
          )}
          {p.comments.map(c => (
            <Box key={`c-${c.id}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text bold>{c.author}</Text>
                <Text dimColor>{age(c.at, ui.now)}</Text>
              </Box>
              <Markdown key={`cm-${c.id}`} text={c.text} />
            </Box>
          ))}
          <Input
            key={`comment-${p.id}`}
            placeholder="Add a comment…"
            submitLabel="Post comment"
            onSubmit={(text: string) => hd.comment(p, text)}
          />
        </Box>
      )}
    </Box>
  )
}

export function problemCard(hd: Handlers, E: any, ui: Ui, p: ProblemRow, isOpen: boolean): any {
  const { Box, Text, Button, Link, Markdown } = E
  return (
    <Box key={`p-${p.id}`} flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap={1}>
            <Button key={`open-${p.id}`} plain onPress={() => hd.toggleExpanded(p.id)}>
              {isOpen ? '▾' : '▸'}
            </Button>
            {standing(E, p)}
            <Link href={problemUrl(ui.planId, p)} label={`PBLM-${p.id}`} />
          </Box>
          <Text dimColor>{age(p.updatedAt, ui.now)}</Text>
        </Box>
        <Text dimColor>
          {p.cardId} · {p.cardTitle.slice(0, CARD_TITLE_MAX)}
        </Text>
      </Box>
      <Text bold>{p.statement}</Text>
      {p.type === 'action' && p.summary && <Text>{p.summary}</Text>}

      {isOpen && p.type === 'question' && p.summary && (
        <Box flexDirection="column">
          <Text dimColor bold>Why it matters</Text>
          <Text>{p.summary}</Text>
        </Box>
      )}
      {isOpen && p.context && (
        <Box flexDirection="column">
          <Text dimColor bold>Details</Text>
          <Markdown key={`ctx-${p.id}`} text={p.context} />
        </Box>
      )}

      {isOpen && picker(hd, E, ui, p)}

      {isOpen && discussion(hd, E, ui, p)}
      {isOpen && (
        <Box flexDirection="row" gap={1}>
          {ui.hasBrowser && (
            <Button key={`tab-${p.id}`} dimColor onPress={() => hd.openBrowserTab(problemUrl(ui.planId, p))}>
              Open in browser tab
            </Button>
          )}
          {busyKey.isSaving(ui.busy, p.id) && <Text dimColor>Saving…</Text>}
        </Box>
      )}
    </Box>
  )
}
