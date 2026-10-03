import type { PlanRow, ProblemRow } from '../../types'

// The rows the operator's pane actions append for the model (R-4): the model did not make
// these calls, so it is told. The person never reads them.
export function connectNote(plan: PlanRow): string {
  return `[danxbot plan] The operator connected this session to ${plan.ref} "${plan.name}" (plan_id ${plan.id}) from the Plan pane. Before doing plan work, call plan_connect with plan_id ${plan.id} yourself to read its briefing and start the event bridge.`
}

export function answerNote(p: ProblemRow, label: string): string {
  return `[danxbot plan] The operator answered ${p.cardId} PBLM-${p.id} "${p.statement}" from the Plan pane: ${label}. Read the card's problems before acting on it.`
}
