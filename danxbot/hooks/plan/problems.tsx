import type { ConnectedPlan, ProblemRow } from '../../types'
import { problemUrl } from './config'
import { mdLink } from './links'

// DX-4609: the pane is for status and calls to action; every interaction with a problem is in the browser. One row per open
// problem: a link titled with the card's ref and the problem's statement, opening that problem on its card.
// The title's separator between the card ref and the statement.
const REF_SEP = ' · '

export function problemRow(E: any, plan: ConnectedPlan, p: ProblemRow): any {
  return mdLink(E, `p-${p.id}`, `${p.cardId}${REF_SEP}${p.statement}`, problemUrl(plan, p.cardId, p.id))
}
