// Activity reporting — tells the dashboard when a plan-connected session's sub-agents
// and background Bash calls start and finish, so the running count closes when they end.
// Pure functions; $ code in register.tsx calls them through danxbot_api.

export interface ActivityChange {
  key: string;
  status: 'running' | 'finished';
  eventAt?: string;
  lastActivityAt?: string;
}

/**
 * ActivityChange for a sub-agent start. The key names it uniquely for the session.
 */
export function subagentStartActivity(agentId: string, eventAt: string): ActivityChange {
  return {
    key: `agent-${agentId}`,
    status: 'running',
    eventAt,
  };
}

/**
 * ActivityChange for a sub-agent stop (clean or failed).
 */
export function subagentStopActivity(agentId: string, eventAt: string): ActivityChange {
  return {
    key: `agent-${agentId}`,
    status: 'finished',
    eventAt,
  };
}

/**
 * ActivityChange for a background Bash call start.
 * The key is the background task id from the Bash result.
 */
export function backgroundBashStartActivity(taskId: string, eventAt: string): ActivityChange {
  return {
    key: `shell-${taskId}`,
    status: 'running',
    eventAt,
  };
}

/**
 * Close background Bash tasks that are no longer running.
 * Called at each Stop/SubagentStop with the current background_tasks snapshot.
 */
export function finishStoppedBackgroundTasks(
  backgroundTasks: any[] | undefined,
  eventAt: string,
): ActivityChange[] {
  if (!Array.isArray(backgroundTasks)) return [];

  const changes: ActivityChange[] = [];
  for (const task of backgroundTasks) {
    if (task?.type === 'shell' && task?.id && task?.status !== 'running') {
      changes.push({
        key: `shell-${task.id}`,
        status: 'finished',
        eventAt,
      });
    }
  }
  return changes;
}

/**
 * Heartbeat activity update for a running sub-agent to prevent it from reading as silent.
 * Re-posts its row with a fresh lastActivityAt, at most once per 60 s per sub-agent.
 */
export function subagentHeartbeatActivity(agentId: string, eventAt: string): ActivityChange {
  return {
    key: `agent-${agentId}`,
    status: 'running',
    lastActivityAt: eventAt,
  };
}
