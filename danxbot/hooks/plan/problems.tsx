import type { ConnectedPlan, ProblemRow } from '../../types'
import { cardUrl } from './config'

// DX-4609: the pane is for status and calls to action; every interaction with a problem is in the browser. One row per open
// problem: a link titled with the card's ref and the problem's statement, opening that problem on its card.
export function problemRow(E: any, plan: ConnectedPlan, p: ProblemRow): any {
  const { Link } = E
  return <Link key={`p-${p.id}`} href={`${cardUrl(plan, p.cardId)}/problems/PBLM-${p.id}`} label={`${p.cardId} · ${p.statement}`} />
}
