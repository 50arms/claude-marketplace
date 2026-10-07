// Ready-cards Stop check — blocks a plan session's stop once while its plan has
// ready, unclaimed cards. Pure functions; $ code in register.tsx calls them through danxbot_api.

export interface ReadyCard {
  id: string;
  title: string;
}

const MAX_LISTED_CARDS = 5;
const MAX_TITLE_CHARS = 80;

/**
 * Format a ready card title for display, truncating at word boundaries if needed.
 */
function truncate(title: string): string {
  const points = Array.from(title.replace(/\s+/g, ' ').trim());
  if (points.length > MAX_TITLE_CHARS) {
    return `${points.slice(0, MAX_TITLE_CHARS).join('')}…`;
  }
  return points.join('');
}

/**
 * Generate the block reason when ready cards exist.
 * Lists the first 5 cards, then counts how many more exist.
 */
export function blockReasonForReadyCards(cards: ReadyCard[]): string {
  if (cards.length === 0) return '';

  const listed = cards.slice(0, MAX_LISTED_CARDS).map(c => `${c.id} ${truncate(c.title)}`);
  const more = cards.length > listed.length ? `, and ${cards.length - listed.length} more` : '';

  return (
    `Your plan has ${cards.length} ready, unblocked card${cards.length === 1 ? '' : 's'} nobody is working: ${listed.join('; ')}${more}. ` +
    'Dispatch each now, or record on the card why it cannot run (dependency, problem, block).'
  );
}

/**
 * Determine if a card is "ready" for work.
 * Ready: ToDo Story/Bug/Chore with no assigned agent, no live dispatch, no block, no open problem, no unmet depends_on.
 * This definition matches packages/danx-dashboard-mcp/src/ready-cards.ts in the package.
 */
export function isReadyCard(card: any): boolean {
  // Must be a story, bug, or chore
  if (!['Story', 'Bug', 'Chore'].includes(card?.type)) return false;

  // Must be in ToDo status
  if (card?.status !== 'ToDo') return false;

  // Must not have an assigned agent
  if (card?.assigned_agent !== null && card?.assigned_agent !== undefined) return false;

  // Must not have a live dispatch
  if (card?.live_dispatch_count && card.live_dispatch_count > 0) return false;

  // Must not be blocked
  if (card?.blocked !== null && card?.blocked !== undefined) return false;

  // Must not have an open problem
  if (card?.problem_id !== null && card?.problem_id !== undefined) return false;

  // Must not have unmet dependencies
  if (card?.has_unmet_dependencies) return false;

  return true;
}

/**
 * Filter a list of cards to those that are ready.
 */
export function filterReadyCards(cards: any[]): ReadyCard[] {
  if (!Array.isArray(cards)) return [];
  return cards.filter(isReadyCard).map(c => ({ id: c.id, title: c.title }));
}
