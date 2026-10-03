import type { PlanRow, ProblemRow } from '../../types'

// The rows the operator's pane actions append for the model (R-4): the model did not make
// these calls, so it is told. The person never reads them.
export function connectNote(plan: PlanRow): string {
  return `[danxbot plan] The operator connected this session to ${plan.ref} "${plan.name}" (plan_id ${plan.id}) from the Plan pane. Before doing plan work, call plan_connect with plan_id ${plan.id} yourself to read its briefing and start the event bridge.`
}

// The plan left is named by ref and name: the session is on no plan now, and must not write to the
// plan routes until it connects again.
export function disconnectNote(plan: { ref: string; name: string }): string {
  return `[danxbot plan] The operator disconnected this session from ${plan.ref} "${plan.name}" from the Plan pane. This session is on no plan; do not write to /api/plans/mine routes until it connects again.`
}

export function answerNote(p: ProblemRow, label: string): string {
  return `[danxbot plan] The operator answered ${p.cardId} PBLM-${p.id} "${p.statement}" from the Plan pane: ${label}. Read the card's problems before acting on it.`
}
