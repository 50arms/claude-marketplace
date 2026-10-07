// Background-work reporting — tells the dashboard how many background shell/subagent/workflow
// tasks are running, so it suppresses the idle nudge while real work is in flight.
// Pure functions; $ code in register.tsx calls them through danxbot_api.

/**
 * Count running background tasks of counted types from the snapshot.
 * Counted types: 'shell', 'subagent', 'workflow'.
 * Uncounted (skipped): 'monitor', 'teammate', 'cloud session', 'MCP task'.
 */
export function countBackgroundWork(backgroundTasks: any[] | undefined, excludeAgentId?: string): number | null {
  if (!Array.isArray(backgroundTasks)) return null;

  // Verify all task types are known
  const KNOWN_TYPES = new Set(['shell', 'subagent', 'monitor', 'workflow', 'teammate', 'cloud session', 'MCP task']);
  if (backgroundTasks.some(task => !KNOWN_TYPES.has(task?.type))) {
    return null; // Unknown snapshot, do not trust it
  }

  const COUNTED_TYPES = new Set(['shell', 'subagent', 'workflow']);
  let count = 0;

  for (const task of backgroundTasks) {
    if (!COUNTED_TYPES.has(task?.type)) continue;
    if (task?.status !== 'running') continue;
    if (excludeAgentId && task?.id === excludeAgentId) continue; // Exclude the sub-agent itself if specified
    count++;
  }

  return count;
}

/**
 * Clears the background work count (used at session start and stop failures).
 * Returns null to signal "clear" to the dashboard.
 */
export function clearBackgroundWork(): null {
  return null;
}
