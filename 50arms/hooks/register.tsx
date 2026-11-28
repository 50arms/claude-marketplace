import { atom, read, update } from 'claude-code'
import type { Register, SessionRateLimit } from 'claude-code'

import type { DiskFacts, AckInFlight, CompactingState, ConnectedPlan, PendingEvent, PlanView, PendingStart, PermissionRequest, ReadyLoop, RefreshGate, RelayState, ReportState, StampState, TurnState, AppVersionState, DiskHome, DiskMeasured, DiskTold } from '../types'
import { CONTEXT_DEADLINE_MS, DEADLINE_REASON, SERVER_NOT_CONNECTED_REASON, isSideSessionNotice, restartAsk, restartFailureLine, restartNoticeText, RESTART_NOTICE_TOOL, SIGN_IN_SOURCE, sessionEvent } from './context/events'
import type { RestartAsk, Told } from './context/events'
import { sha256Hex } from './bundle/sha256'
import { BUNDLE_PATH, BUNDLE_POLL_MS, BundleShapeError, FLOOR_PATH, REPORTS_PATH, REQUESTED_ENDPOINTS_PATH, ROLE_PATH, bundleFileOf, bundleQuery, changeSignalOf, decide, deliveredText, entriesOf, floorIsStale, isCurrent, mainContext, namedSlots, readBundleBody, readRequestedEndpointsBody, readRoleBody, relayStreams, requestedEndpointsQuery, rewindTold, roleQuery, startsNewContext } from './bundle/bundle'
import type { Bundle, BundleComputed, BundleFile, BundleRead, ChangeSignal, Decision, Delivery, Entry, Told } from './bundle/bundle'
import { SIGN_IN_INVITATION, floorBody } from './bundle/floor'
import { OWED_ARRIVED, dropRetell, failureOf as fetchFailureOf, holdOn, holdReport, leavesQueue, leavesReadyList, phaseOf, refusalOf, release, reportStepOf, timeoutFailure } from './bundle/hold'
import type { Failure, Hold, Retell } from './bundle/hold'
import { dueRequests, deliveryItem, enqueueDelivery, enqueueFloor, enqueueHold, failureLine, bandLine, hasFloorPending, settleFailure, settleOk, toTell } from './bundle/reports'
import type { Loud } from './bundle/reports'
import { NO_BEHAVIOR, owe, settleOwed } from './bundle/state'
import type { Behavior, OwedTaking } from './bundle/state'
import { stamp as nextStamp } from './context/stamp'
import { announcedBy, endedWithParent, finishedAgentLabel, isRecordWrite, spawnedAfter } from './context/record'
import type { FinishedAgent, SpawnedAgents } from './context/record'
import { FOREGROUND_LOCK_TIMEOUT_MS, foregroundLockArgv, foregroundLockNotice, parseForegroundLockAnswer } from './context/foreground'
import { heldReason, nextWakeMs, receive, releasedText, splitDue, taskNoticeOf } from './context/interim-notice'
import type { HeldNotice, TaskNotice } from './context/interim-notice'
import { DISK_MEASURE_MS, MAIN_AGENT, NO_DISK_FACTS, diskDecision, diskFault, diskKey, diskNotice, freeSpaceArgv, hostKindOf, joinPath, parseFreeBytes, parseWindowsProfile } from './context/disk'
import type { DiskEnv, HostKind } from './context/disk'
import { APP_VERSION_FILE, checkoutBehind, versionFaultLine } from './context/app-version'
import { COMPACTING_NOTE_TTL_MS, agentListSlot, cardListSlot, gitStatusSlot, owedListSlot, parseGitStatus, planIdSlot, planNameSlot } from './compaction/briefing'
import type { BriefingAgent, BriefingCard, GitState, OwedComment, Source } from './compaction/briefing'
import { AGENT_FAULT_KEY_MAX, AGENT_FAULT_TOLD_KEEP, AGENT_SIZES_KEEP, CLEAR_MARK_TTL_MS, ENGINE_VERSION_NOTICE, clearMarkOf, compactionClearMarkKey, HELD_REASON, RELAY_OLDER_NOTICE, USED_RELEASE_PREFIX, agentVerdict, armedPercentOf, parseControlFile, readyRelease, runsSessionCompact, sizeOfUsage, spentReleaseId, staleReleaseKeys, staleSessionKeys, underHandshake, usedReleaseKey, verdict } from './compaction/control'
import type { AgentSize, AgentVerdict, ControlFile, Verdict } from './compaction/control'
import { machineRegisteredNote, registrationFailedToast, registrationOf, registrationShownNote, registrationStep } from './plan/registration'
import { approvalRequestOf, permissionShownNote, signInShownNote } from './plan/approval'
import type { ApprovalRequest } from './plan/approval'
import { renderBand } from './plan/band'
import { CLEAR_SPENT_PREFIX, READY_DISCONNECTED, READY_JOINING, READY_JUDGE_PROMPT, READY_JUDGED_PREFIX, READY_NOT_GITHUB, READY_NOT_REGISTERED, READY_NO_AGENT_AGAIN, READY_NO_ORIGIN, READY_OFF, READY_PATH, READY_PERMISSION_ENDED, READY_REPOS_PAGE, READY_REVOKED, READY_SHELL_HOLDS_RESET, READY_SIGN_IN_ENDED, READY_SKILL, READY_STOPPED, READY_TICK_MS, READY_USAGE, READY_RELAY_OLDER, REPOS_PERMISSION, REPOS_PERMISSION_REASON, clearSpentKey, holdsWork, joiningLoop, markAnswerOf, parseGithubOrigin, readyAdopted, readyAgentRefusalNote, readyFailed, readyJoined, readyJudgedKey, readyJoinedOnWork, readyLoopUnread, readyMarkRefused, readyNoAgentYet, readyPermissionRefused, readyRejoined, readyRevoked, readyWorkTaken, remoteIs, repoNameCandidates, repoNameFor, serverLoopOf, sessionIdOf, stoppedByPerson } from './ready/loop'
import type { GithubOrigin, MarkAnswer, ServerLoop } from './ready/loop'
import { sessionFilePath } from './relay/session-file'
import { asApproval, claimPath, permissionRequestOf, publicIdOf, settle } from './plan/permission'
import type { Telling } from './plan/permission'
import { linkRefs } from './plan/card-links'
import { settleDetached } from './plan/detached'
import { renderFooter } from './plan/footer'
import type { Handlers } from './plan/handlers'
import { eventsReason, eventsWarning, footerLabel, footerTone, needsYouShown, sessionTitle, unmarkedTitle, type TitleActivity } from './plan/words'
import {
  CALL_ERROR_MAX,
  COMMAND,
  FAILURE_TOAST_MAX,
  EMPTY,
  LOAD_DEADLINE_MS,
  LOAD_ORPHAN_WAIT_MS,
  LOCK_STALE_MS,
  MIN_GAP_MS,
  PERMISSION_POLL_MS,
  PERMISSION_TOLD_MAX,
  SIGN_IN_DENIED_TOAST,
  SIGN_IN_MIN_ROUND_MS,
  MIN_USAGE_TICK_MS,
  USAGE_PATH,
  USAGE_TICK_MS,
  signInFailedToast,
  BLOCKED_LINE,
  SERVER,
  NOT_CONNECTED_RETRY_MS,
  SERVER_POLL_MS,
  toolName,
  NOTE_MARKER,
  TOAST_ERROR_MAX,
  planUrl,
  busyKey,
  DESKTOP_SURFACE,
} from './plan/config'
import { serverOf } from './plan/server'
import { errText, loadPlan } from './plan/load'
import { blockedOrigin, optionDashboardUrl } from './plan/origin'
import type { Api } from './plan/load'
import { agentBlockOf, agentRefusalOf, connectToolOutcome, connectedPlanOf, isServerNotConnected, isSignedOut, outcomeRevokedBy, refusalText, textOutcome, toolOutcome } from './plan/mcp'
import { AGENT_RELEASE_DEADLINE_MS, AGENT_RELEASE_PATH, AGENT_RELEASE_TIMEOUT_REASON, PERSON_DISCONNECT_PATH, releaseFailureToast, revokeFailure } from './plan/agent'
import { connectTargetOf, planTarget } from './plan/target'
import { holdKey } from './plan/hold'
import type { BandHold } from './plan/hold'
import type { ToolOutcome } from './plan/mcp'
import { revokeNote, signInApprovedNote, signInDeniedNote, signInExpiredNote, signInNote } from './plan/notes'
import { NO_AGENT, signInStep } from './plan/sign-in'
import { classifyText, readWaitAnswer, waitArgs } from './relay/answer'
import type { RelayEvent, WaitAnswer } from './relay/answer'
import { busyToast, claimHoldsNothing, claimUnreadToast, claimedItemOf, commandFailed, failureWasTold, jobBusyHandedBack, jobHandedBack, jobPrompt, leaveFailedToast, leftToast, markWritable, notTakenToast, NOT_HOLDER, OWNER_SILENT_MS, PROMPT_REFUSED, takePath, takePlanOf, takeoverOf, takingJobOf, withFailureTold, withHandedBack, withoutFailuresOf, withoutHandedBack, withoutTakenOver, withTakenOver, lostToTakeover, unionJobsTold, unionTakenOver, withJobTold, withoutJobTold, WORKTREE_COMMAND_TIMEOUT_MS, worktreePathOf, type FailureTold, type Hand, type Judged, type Offer, type TakenOver, type TakingJob, type Watch } from './ready/offer'
import { CURSOR_PREFIX, MIN_ROUND_MS, OLD_SERVER_AFTER_FAILURES, OLD_SERVER_AFTER_MS, RELAY_OFF, RELAY_READ_DEADLINE_MS, RELAY_STALL_CHECK_MS, RELAY_STALL_MS, RELAY_START_RETRY_MS, RELAY_TOOL, backoffMs } from './relay/config'
import { BROWSER_MISSING_LINE, BROWSER_SERVER, createdTab, failureOf, holdsPlanTab, paneState, type BrowserResult, type BrowserTool } from './relay/browser'
import { KEEPALIVE_GIVE_UP_MS, KEEPALIVE_IDLE_MS, KEEPALIVE_RETRY_MS, KEEPALIVE_RETRY_WINDOW_MS, KEEPALIVE_WAKE_CHECK_MS } from './relay/keepalive'
import { IDLE, deliveryMode, noteAppended, relayLine, repeatLine, toolResultSent, turnEnded, turnStarted } from './relay/delivery'
import { cursorFor, cursorKey, staleCursorKeys } from './relay/cursor'
import { StalePendingError, ackedEventId, clearInFlight, fromPending, isLateTick, isStalled, markInFlight, onlyPlan, pollCursor, putBack, shouldDropResend, toPending } from './relay/outbox'
import type { Queued } from './relay/outbox'
import { legacyRuleCheck, legacySettingsPaths } from './relay/legacy-rule'
import { classifierRefusal, isStaleMcpRefusal, STALE_MCP_LINE, ownServerCheck, isModelLeave, raisedByPlugin, type ApiExtra, type Refusal } from './relay/refusal'
import { HELD_FOR_INPUT_BAND, HELD_FOR_INPUT_NOTICE, OLD_SERVER_DETAIL, OLD_SERVER_FIX, RELAY_ERROR_FIX, STALE_PENDING_DETAIL, STALE_PENDING_FIX, delayedLine, heldForInput, notTakenLine, refusedLine, stalledLine, stalledNotice, stoppedLine } from './relay/text'
import { usageBody } from './plan/usage'
import type { UsageBody } from './plan/usage'
import { agentFileEffort, agentFileModel, ownAgentFile, spawnGuard } from './plan/pacing-guard'
import { bugEvidenceGuard } from './plan/bug-evidence-guard'
import { pacingLevel, pacingLine, refreshPacing, resetPacing, slotWaiting, withLine } from './plan/pacing-line'
import { TURN_ACTIVITY_PATH, afterCompaction, nextSince, turnActivityBody } from './reports/turn-activity'
import type { TurnActivity } from './reports/turn-activity'
import { bgWaitVerdict, leftBehindLine, movedOutputPaths, parseTranscript } from './reports/bg-wait-guard'
import type { Counts as BgWaitCounts, Verdict } from './reports/bg-wait-guard'
import { ACTIVITY_PATH, LEAVE_CLOSE_DEADLINE_MS, LIVENESS_MS, agentRow, endedShells, shellRow } from './reports/activity'
import { subagentKey } from './compaction/subagent-key'
import type { ActivityChange } from './reports/activity'
import { labelOf } from './reports/label'
import { READY_CARDS_DEADLINE_MS, blockReason, issuesQuery, planOf, readyCardsOf, reviewReason, skippedLine } from './reports/ready-cards'
import type { ReadyCard, ReviewableCard } from './reports/ready-cards'
import { NO_BRIEFS, NO_RECENT, briefClaimed, briefEnded, briefRecent, briefSpawned, briefedCards, workedCards, detailPath, heldIdleOf, heldIdleReason, heldSkippedLine } from './reports/held-idle'
import type { Briefs, HeldCard, RecentBriefs } from './reports/held-idle'
import { OLDER_DASHBOARD_LINE, PAUSE_PATH, isUnregisteredSession, pauseOf } from './reports/pause'
import type { PauseRead } from './reports/pause'
import { storeDoor, type StoreCall, type StoreIo } from './store/recover'

// $.state atoms: the engine's scan reads an atom's plugin and key only from a const in the file that
// uses it, so they are declared here, not in ./plan/config.
const view = atom({ plugin: '50arms', key: 'view' } as const, EMPTY)
const gate = atom({ plugin: '50arms', key: 'gate' } as const, { inFlight: false, again: false, at: null } as RefreshGate)
// the band is hidden for the session: its own atom, since refresh replaces `view` whole
const dismissed = atom({ plugin: '50arms', key: 'dismissed' } as const, false)
const busy = atom({ plugin: '50arms', key: 'busy' } as const, [] as string[])
const title = atom({ plugin: '50arms', key: 'title' } as const, null as string | null)
// the plan the model's own successful session_connect named, kept for the `blocked` view (the plugin's own reads are refused by auto mode's
// classifier, so nothing else names the plan); null after any leave, a /clear or a resume, a session start, and every loaded view.
const modelPlan = atom({ plugin: '50arms', key: 'modelPlan' } as const, null as { id: number; name: string } | null)
// the sign-in request waiting for the person (its link and confirm code), set the moment it exists and cleared when it
// ends (approved, denied, expired and renewed, or the conversation ended). The band draws it as a Markdown link and the
// code the moment it exists. Also what tells a watch is running.
const signInRequest = atom({ plugin: '50arms', key: 'signInRequest' } as const, null as ApprovalRequest | null)
// the machine's registration while the person has not accepted it (its link and claim code, drawn by the band; `noted`: the model was told to send the person to it,
// so it is woken once when the person accepts). The same answer on every session of the machine. Cleared when the machine is registered or the conversation ended.
const machineRegistration = atom({ plugin: '50arms', key: 'machineRegistration' } as const, null as { url: string; code: string; noted: boolean } | null)
// the model's `request_permission` requests not yet decided, oldest first; the band counts them.
const permissionRequests = atom({ plugin: '50arms', key: 'permissionRequests' } as const, [] as PermissionRequest[])
// the main session's transcript path (the classic events carry it).
const transcript = atom({ plugin: '50arms', key: 'transcript' } as const, null as string | null)
// the text of the last usage report's failure (null while the reports are accepted), so a failure that repeats every tick is
// shown once, not every minute.
const usageError = atom({ plugin: '50arms', key: 'usageError' } as const, null as string | null)
// when the last API response arrived (epoch ms), the age of the usage figure; null until the session has seen one.
const measuredAt = atom({ plugin: '50arms', key: 'measuredAt' } as const, null as number | null)
// the plan event relay's state (what the events warning is built from). And the main loop's turn (TurnState).
const relay = atom({ plugin: '50arms', key: 'relay' } as const, RELAY_OFF as RelayState)
// the session's place in the ready-agent loop. $.state, so a module reload keeps it; a new process starts without, and takes the loop up again from the mark or the dashboard loop its row still holds (adoptReadyMark).
const readyLoop = atom({ plugin: '50arms', key: 'readyLoop' } as const, null as ReadyLoop | null)
// Each stopping sub-agent's refusals in a row (reports/bg-wait-guard.ts), per `<session>-<agent>`; an entry goes once its stop goes through. $.state, so a module reload keeps the count.
const bgWaitCounts = atom({ plugin: '50arms', key: 'bgWaitCounts' } as const, {} as BgWaitCounts)
const readyShells = atom({ plugin: '50arms', key: 'readyShells' } as const, [] as string[])
// the events warning last stored (null: none), so its reason is told once on the transition into it.
const eventsWarned = atom({ plugin: '50arms', key: 'eventsWarned' } as const, null as string | null)
// the start (epoch ms) of the last turn activity sent to the dashboard, so the next one starts strictly later (it keeps only the newest start). $.state, so a reload keeps it.
const turnReportedAt = atom({ plugin: '50arms', key: 'turnReportedAt' } as const, null as number | null)
// The id the session's MCP server runs under, by the id the engine answers now. A /clear gives the session a new id while its MCP server keeps the id it booted with, and the server writes its
// per-session files (compaction control, connection record) under its own. `{id}`: the server's id as its row names it; `{failedAt, fault}`: the ask failed (`fault` names why, null when the dashboard answered with no row for the session), retried after MCP_ID_RETRY_MS.
type McpIds = Record<string, { id: string } | { failedAt: number; fault: string | null }>
const mcpIds = atom({ plugin: '50arms', key: 'mcpIds' } as const, {} as McpIds)
const MCP_ID_RETRY_MS = 30_000
// the id the engine answered at the session's own start (a startup, resume or compaction; a /clear start reports the NEW id, so it is not one): the server booted under it, so it needs no ask
const bootEngineId = atom({ plugin: '50arms', key: 'bootEngineId' } as const, null as string | null)

const turn = atom({ plugin: '50arms', key: 'turn' } as const, IDLE as TurnState)
// the sub-agents (named by description, id and brief cards) that finished and whose finish the main session has not been told yet: it rides the main loop's next tool result or prompt, one text however many finished.
const finishedAgents = atom({ plugin: '50arms', key: 'finishedAgentRecords' } as const, [] as FinishedAgent[])
// the last time stamp handed to the model (a prompt's), which the next one counts its +delta and its date from.
const lastStamp = atom({ plugin: '50arms', key: 'lastStamp' } as const, null as StampState)
// a session start the model has not been told about. On a desktop or headless startup, resume and fork the engine has not bound the
// session when SessionStart runs, so `$.mcp.call` and `$.tool.list` throw there: SessionStart only records the start here, and the next
// prompt.submit or tool result (bound) takes it and tells the model what the start has to say.
const pendingStart = atom({ plugin: '50arms', key: 'pendingStart' } as const, null as PendingStart)
// the start texts this conversation is still owed: a start that found the session without a usable key (signed out, or its key revoked) could not ask 50 Arms for them. The first load that finds the
// session signed in turns this into a pending start (`source: 'sign-in'`), so the start texts reach the model on its next prompt or tool result, from the moment it signs in.
const mantraOwed = atom({ plugin: '50arms', key: 'mantraOwed' } as const, false)
// the interim sub-agent notices held back from the model (hooks/context/interim-notice.ts), kept by $.state across a reload of the module
const heldNotices = atom({ plugin: '50arms', key: 'heldNotices' } as const, [] as HeldNotice[])
// The machine's free-space notice (hooks/context/disk.ts). Told per agent (the main thread and each sub-agent), so a tool call repeats an unchanged
// notice to the same agent only after DISK_REPEAT_MS; measured at most once per DISK_MEASURE_MS; the Windows home found once per session.
const diskTold = atom({ plugin: '50arms', key: 'diskTold' } as const, {} as DiskTold)
const diskMeasured = atom({ plugin: '50arms', key: 'diskFacts' } as const, null as DiskMeasured)
const diskHome = atom({ plugin: '50arms', key: 'diskHome' } as const, null as DiskHome)
// the dashboard's app version (from its answers' `app_version`) and the version/folder pair whose checkout was last compared with it (hooks/context/app-version.ts). Carried across a /clear or a /resume like every atom; the start that opens the next conversation resets the comparison, so that conversation is told afresh.
const appVersion = atom({ plugin: '50arms', key: 'appVersion' } as const, { dashboard: null, checked: null } as AppVersionState)
// the session a /clear just ended: the session.end hook records its id and the SessionStart that follows takes it, so the restart notice
// asks about exactly that predecessor.
const endedSession = atom({ plugin: '50arms', key: 'endedSession' } as const, null as string | null)
// the desktop app hosts this session (see the keepalive); sticky for the session, raised by CLAUDE_CODE_ENTRYPOINT=claude-desktop or
// surfaces() at session.start, or by session.attach.
const desktopHosted = atom({ plugin: '50arms', key: 'desktopHosted' } as const, false)
// when the current keepalive idle period began (epoch ms): the last main-loop turn end, or the start of the plan connection. A reload
// of the module arms from it, so the period is not restarted by the reload; null while no plan is followed.
const idleSince = atom({ plugin: '50arms', key: 'idleSince' } as const, null as number | null)
// the person was told once that this dashboard has no agent-pause route (a plugin newer than the dashboard).
const olderDashboardTold = atom({ plugin: '50arms', key: 'olderDashboardTold' } as const, false)
// the person was told once that the Browser pane is not reachable from the plugin, so the plan tab is not kept open (a reload keeps it).
const browserMissingTold = atom({ plugin: '50arms', key: 'browserMissingTold' } as const, false)
// the leftover compaction-trigger variables an older plugin version armed were cleared in this process. $.state because the variables live in the process: a module reload keeps both.
const leftoverArmingCleared = atom({ plugin: '50arms', key: 'leftoverArmingCleared' } as const, false)
// the percent CLAUDE_AUTOCOMPACT_PCT_OVERRIDE holds because the plugin armed it for the sub-agents (null: the plugin armed none). $.state because the variable lives in the process: a module reload keeps both.
const armedPercent = atom({ plugin: '50arms', key: 'armedPercent' } as const, null as number | null)
// this host runs `session.compact`: raised by the first such event of the session. $.state, so a module reload keeps it (a reload that forgot it would take the armed percent back
// until the next compaction event). It is one of two inputs to `hostRunsSessionCompact` (the other is the engine release from 2.1.299, `engineCompact`); when that holds, the classic PreCompact gate
// leaves an automatic proposal to `session.compact` (which judged it per agent) and the sub-agents' percent is armed (a host with neither has only the classic gate, which cannot tell the agents apart, so an early proposal there would hold every agent).
const sessionCompactSeen = atom({ plugin: '50arms', key: 'sessionCompactSeen' } as const, false)
// what the engine's release says about `session.compact`, read once per process (`$.session.version()`), $.state like the flag above: 'unread' until the first question, then 'runs' (a
// release from SESSION_COMPACT_FLOOR), 'older' (an earlier release), or 'unreadable' (the call threw or named no release: not known to run it, and the person is told once, `engineVersionTold`).
const engineCompact = atom({ plugin: '50arms', key: 'engineCompact' } as const, 'unread' as 'unread' | 'runs' | 'older' | 'unreadable')
// the release the plugin has claimed to start a compaction with. The claim is one compare-and-set on this atom, made before any other await of the start, so a turn's end, an idle
// check and a person's own /compact racing each other start (or spend) a ready exactly once.
const claimedRelease = atom({ plugin: '50arms', key: 'claimedRelease' } as const, null as string | null)
// the targets the session held, while the plugin's own clear for a session that still holds work (a compaction by clear, a natural-break clear) runs its /clear, null otherwise: the conversation that opens inside it is the one to resume (a person's own /clear, or the ready loop's, is not). $.state, like the ready loop's
// phase, so a reload of the module at the turn's end cannot lose it
const compactionClear = atom({ plugin: '50arms', key: 'compactionClear' } as const, null as string[] | null)
// whether a session start has been seen by this process: false in a NEW process (it starts with no $.state), which is what makes its first start the one that may find a predecessor's clear mark; a reload
// of the module keeps it, and a /clear carries it
const startSeen = atom({ plugin: '50arms', key: 'startSeen' } as const, false)
// who is compacting, one entry per agent so overlapping compactions (parallel sub-agents crossing the one process-wide threshold together, or a main-agent compaction among them) never
// overwrite each other. Claude Code's classic SessionStart input names no agent (2.1.299), so a `session.compact` proposal that passed enters its agent here and the `compact` restart reads the
// entries to decide whether the MAIN agent is briefed. `main` is the main agent's entry (epoch ms of its proposal) or null. An agent's entry is `done` once core finished its compaction (the
// `session.compact` result), and its own briefing is then told on its first tool result; a proposal that was skipped or failed removes its entry. An entry older than COMPACTING_NOTE_TTL_MS, or of
// a sub-agent that stopped, is dropped. Residual risk, UNVERIFIED live: a compaction whose result never comes back (the engine dies mid-way) keeps its entry for up to the age bound, during which a restart
// that cannot be attributed (the three kinds in CLAUDE.md) is read as that sub-agent's and does not brief the main agent. The same holds while a sub-agent has finished compacting but has not yet made its next
// tool call (its entry stays until that call). Rare case: when the main agent and a sub-agent compact together, the sub-agent's restart can use up the main entry; if the main compaction then fails,
// the main agent gets a stray briefing.
const compacting = atom({ plugin: '50arms', key: 'compacting' } as const, { main: null, agents: {} } as CompactingState)
// the bare ids of the sub-agents running now: from a sub-agent's start until its stop or the end of its turn (a failed one raises no stop). The session title's building mark shows while it is not empty.
const runningAgents = atom({ plugin: '50arms', key: 'runningAgents' } as const, [] as string[])
// the reports' memory between events (see ReportState).
const reports = atom({ plugin: '50arms', key: 'reports' } as const, { agents: {}, shells: [], planId: null } as ReportState)
// the briefs of the sub-agents that ended in the last few minutes; the held-idle Stop check counts their cards as worked for that long (reports/held-idle.ts).
const recentBriefs = atom({ plugin: '50arms', key: 'recentBriefs' } as const, NO_RECENT as RecentBriefs)
// the relay's undelivered events, kept beside the module's own outbox (relay/outbox.ts says why): $.state outlives a reload of this module, the module variable does not.
// the card ids each admitted sub-agent spawn was briefed on, claimed by the sub-agent that starts (reports/held-idle.ts); the held-idle Stop check counts a card a running sub-agent was briefed on as worked.
const agentBriefs = atom({ plugin: '50arms', key: 'agentBriefs' } as const, NO_BRIEFS as Briefs)
// what the plugin kept of each sub-agent when it spawned: its description, whether it runs in the background, whether the main loop spawned it (context/record.ts); the finish notice reads it.
const spawnedAgents = atom({ plugin: '50arms', key: 'spawnedAgents' } as const, {} as SpawnedAgents)
// the policy bundle's state: the bundle held, what each agent context was told, the holds, the owed start events and the report queue (hooks/bundle/state.ts)
const behavior = atom({ plugin: '50arms', key: 'behavior' } as const, NO_BEHAVIOR as Behavior)
const relayOutbox = atom({ plugin: '50arms', key: 'relayOutbox' } as const, [] as PendingEvent[])
// the queued job in hand (ready/offer.ts, TakingJob), with the instance that owns it: $.state outlives a reload, and so does the old instance's work. A reloaded module acts on a mark only once its owner has been silent too long
const queueJobTaking = atom({ plugin: '50arms', key: 'queueJobTaking' } as const, null as TakingJob | null)
// the failures of a taken job already told to the model (ready/offer.ts, FailureTold): a repeat of the same job's identical failure wakes the session no more
const queueFailuresTold = atom({ plugin: '50arms', key: 'queueFailuresTold' } as const, [] as FailureTold[])
// the queued jobs this session handed back, by item id (ready/offer.ts, withHandedBack): the model's claim of one of them is the session's to prepare; a claim of any other job (a holder reading its job back) is left alone
const queueHandedBack = atom({ plugin: '50arms', key: 'queueHandedBack' } as const, [] as number[])
// the queued jobs a module instance took over from another, with the taker (ready/offer.ts, TakenOver): a copy that finds its mark missing stops only for a job another instance took over from it
const queueTakenOver = atom({ plugin: '50arms', key: 'queueTakenOver' } as const, [] as TakenOver[])
// the job items already told to the model (ready/offer.ts, withJobTold): visible to every module instance, so an item on it is never claimed or told again, whichever instance's mark comes back through a restore
const queueJobsTold = atom({ plugin: '50arms', key: 'queueJobsTold' } as const, [] as number[])
// the events issued to the session that asked to be acknowledged and whose acknowledgement call has not succeeded (relay/outbox.ts, shouldDropResend). $.state, so a reload keeps it.
const ackInFlight = atom({ plugin: '50arms', key: 'ackInFlight' } as const, [] as AckInFlight)

// Every $.state value of the plugin is carried across a /clear (a scan test holds the two lists below to the atoms declared above). claude.exe 2.1.317 empties a plugin's
// whole $.state when a /clear opens the next conversation (measured with a probe module: `session.end` still reads the ending conversation's values, `classic.SessionStart` (source `clear`)
// reads none, and what it writes stays), while the process, its MCP server, its loops and its timers go on. Each value belongs to the process: what a new conversation must not inherit is
// reset by the clear's own steps (onSessionEnd, onClassicSessionStart), as it was while $.state lived through a /clear. So one step carries them all, in a module variable: the clear's
// `session.end` reads every value (carryAcrossConversation) and the start that opens the next conversation writes every one back before anything else (restoreCarried). A /resume in the
// same process takes the same step. Each read and write names its atom, since the engine's scan lists a module's values only from such literal calls (a list of atoms refuses to load).

// what the ending conversation's `session.end` read, for the `classic.SessionStart` that opens the next one (restoreCarried); null at every other moment
let carriedState: Record<string, any> | null = null

// The last step of a /clear's or a /resume's `session.end`, after its own writes: every value the conversation holds, read while the engine still keeps them.
async function carryAcrossConversation($: any): Promise<void> {
  const reads: Record<string, Promise<unknown>> = {
    view: read($, view),
    gate: read($, gate),
    dismissed: read($, dismissed),
    busy: read($, busy),
    title: read($, title),
    modelPlan: read($, modelPlan),
    signInRequest: read($, signInRequest),
    machineRegistration: read($, machineRegistration),
    permissionRequests: read($, permissionRequests),
    transcript: read($, transcript),
    usageError: read($, usageError),
    measuredAt: read($, measuredAt),
    relay: read($, relay),
    readyLoop: read($, readyLoop),
    readyShells: read($, readyShells),
    bgWaitCounts: read($, bgWaitCounts),
    eventsWarned: read($, eventsWarned),
    turnReportedAt: read($, turnReportedAt),
    mcpIds: read($, mcpIds),
    bootEngineId: read($, bootEngineId),
    turn: read($, turn),
    finishedAgents: read($, finishedAgents),
    lastStamp: read($, lastStamp),
    pendingStart: read($, pendingStart),
    mantraOwed: read($, mantraOwed),
    diskTold: read($, diskTold),
    diskMeasured: read($, diskMeasured),
    diskHome: read($, diskHome),
    endedSession: read($, endedSession),
    desktopHosted: read($, desktopHosted),
    idleSince: read($, idleSince),
    olderDashboardTold: read($, olderDashboardTold),
    appVersion: read($, appVersion),
    browserMissingTold: read($, browserMissingTold),
    leftoverArmingCleared: read($, leftoverArmingCleared),
    armedPercent: read($, armedPercent),
    sessionCompactSeen: read($, sessionCompactSeen),
    engineCompact: read($, engineCompact),
    claimedRelease: read($, claimedRelease),
    compactionClear: read($, compactionClear),
    startSeen: read($, startSeen),
    compacting: read($, compacting),
    runningAgents: read($, runningAgents),
    reports: read($, reports),
    recentBriefs: read($, recentBriefs),
    heldNotices: read($, heldNotices),
    agentBriefs: read($, agentBriefs),
    spawnedAgents: read($, spawnedAgents),
    relayOutbox: read($, relayOutbox),
    ackInFlight: read($, ackInFlight),
    queueJobTaking: read($, queueJobTaking),
    queueFailuresTold: read($, queueFailuresTold),
    queueHandedBack: read($, queueHandedBack),
    queueTakenOver: read($, queueTakenOver),
    queueJobsTold: read($, queueJobsTold),
    behavior: read($, behavior),
  }
  carriedState = Object.fromEntries(await Promise.all(Object.entries(reads).map(async ([key, value]) => [key, await value] as const)))
}

// The first step of a `classic.SessionStart`: a /clear's or a /resume's start writes back every value the ending conversation's `session.end` carried, then loads the view afresh. Taken
// once: any other start drops what was carried. A write some loop made in the moment between the engine emptying $.state and this start is overwritten by the value read just before
// (the module's own copies, such as the relay's outbox, write theirs again at their next change).
async function restoreCarried($: any, source: unknown): Promise<void> {
  const carried = carriedState
  carriedState = null
  if (carried === null || (source !== 'clear' && source !== 'resume')) return
  // the module's own mark is the authority over the value read at session.end: a mark this instance wrote in the gap (the first mark of an offer) stays, and a mark it dropped in the gap stays dropped
  carried.queueJobTaking = markToRestore(carried.queueJobTaking)
  // what the gap wrote joins what the conversation held, never replaced by it: a takeover entry is only evidence to keep, and a job told in the gap stays told (one handed back in the gap stays out)
  carried.queueTakenOver = unionTakenOver(carried.queueTakenOver, await read($, queueTakenOver))
  carried.queueJobsTold = unionJobsTold(carried.queueJobsTold, await read($, queueJobsTold), jobsLeft)
  await Promise.all([
    update($, view, () => carried.view),
    update($, gate, () => carried.gate),
    update($, dismissed, () => carried.dismissed),
    update($, busy, () => carried.busy),
    update($, title, () => carried.title),
    update($, modelPlan, () => carried.modelPlan),
    update($, signInRequest, () => carried.signInRequest),
    update($, machineRegistration, () => carried.machineRegistration),
    update($, permissionRequests, () => carried.permissionRequests),
    update($, transcript, () => carried.transcript),
    update($, usageError, () => carried.usageError),
    update($, measuredAt, () => carried.measuredAt),
    update($, relay, () => carried.relay),
    update($, readyLoop, () => carried.readyLoop),
    update($, readyShells, () => carried.readyShells),
    update($, bgWaitCounts, () => carried.bgWaitCounts),
    update($, eventsWarned, () => carried.eventsWarned),
    update($, turnReportedAt, () => carried.turnReportedAt),
    update($, mcpIds, () => carried.mcpIds),
    update($, bootEngineId, () => carried.bootEngineId),
    update($, turn, () => carried.turn),
    update($, finishedAgents, () => carried.finishedAgents),
    update($, lastStamp, () => carried.lastStamp),
    update($, pendingStart, () => carried.pendingStart),
    update($, mantraOwed, () => carried.mantraOwed),
    update($, diskTold, () => carried.diskTold),
    update($, diskMeasured, () => carried.diskMeasured),
    update($, diskHome, () => carried.diskHome),
    update($, endedSession, () => carried.endedSession),
    update($, desktopHosted, () => carried.desktopHosted),
    update($, idleSince, () => carried.idleSince),
    update($, olderDashboardTold, () => carried.olderDashboardTold),
    update($, appVersion, () => carried.appVersion),
    update($, browserMissingTold, () => carried.browserMissingTold),
    update($, leftoverArmingCleared, () => carried.leftoverArmingCleared),
    update($, armedPercent, () => carried.armedPercent),
    update($, sessionCompactSeen, () => carried.sessionCompactSeen),
    update($, engineCompact, () => carried.engineCompact),
    update($, claimedRelease, () => carried.claimedRelease),
    update($, compactionClear, () => carried.compactionClear),
    update($, startSeen, () => carried.startSeen),
    update($, compacting, () => carried.compacting),
    update($, runningAgents, () => carried.runningAgents),
    update($, reports, () => carried.reports),
    update($, recentBriefs, () => carried.recentBriefs),
    update($, heldNotices, () => carried.heldNotices),
    update($, agentBriefs, () => carried.agentBriefs),
    update($, spawnedAgents, () => carried.spawnedAgents),
    update($, relayOutbox, () => carried.relayOutbox),
    update($, ackInFlight, () => carried.ackInFlight),
    update($, queueJobTaking, () => carried.queueJobTaking),
    update($, queueFailuresTold, () => carried.queueFailuresTold),
    update($, queueHandedBack, () => carried.queueHandedBack),
    update($, queueTakenOver, () => carried.queueTakenOver),
    update($, queueJobsTold, () => carried.queueJobsTold),
    update($, behavior, () => carried.behavior),
  ])
  // a fresh conversation (or another session taking this one's place) in the same process: what the dashboard shows may have moved while they were in the old one. Loaded from here, so
  // the load and its lock live in the new conversation's $.state, never across the emptying
  detach($, 'Plan refresh', refresh($, true))
}

// the engine follows `$` only into a function declared in the SAME file (`claude plugin
// validate` refuses it across an import), and refuses a closure that receives `$` declared
// inside `register`. So every function that takes `$` is a top-level declaration here; the
// drawing, shaping and constants live in ./plan/* as pure code, and this file hands the
// drawings their handlers (handlers()).

// the plan event relay's loop, at most one (a handle, so a module variable: a reload cancels the old environment's
// waits, ends its loop, and session.start starts the new one). `dead` ends a loop at its next step and makes whatever its pending
// call answers late be ignored.
// `told`: the last failure line told to the session by this run (the same text is told once until a wait succeeds): per run, so an ended run
// can never clear or set what the new run has told.
// `lacking`: the run's failed waits in a row whose evidence is "the plugin server lists tools but not plan_events_wait" (count, and when the first came).
// `planId: null` is the relay of a signed-in session on no plan (session records only: pacing, auto-resume).
// `beat` is the wall-clock time of the loop's last step (0 before the first), what the stall watch judges.
type RelayRun = { planId: number | null; dead: boolean; told: string | null; lacking: { count: number; since: number } | null; beat: number }
let relayRun: RelayRun | null = null
// the events the poll loop has taken and the pump has not delivered yet (relay/outbox.ts says why they are not delivered by the loop). Handles
// (the delivery promises), so a module variable: a reload starts with none, and `restoreOutbox` rebuilds it from the `relayOutbox` atom, the copy $.state keeps.
let outbox: Queued[] = []
// the stall watch, one per process (a handle), the run it last saw with the time it first saw it, and when its last tick ran.
let stallTicker: { cancel: () => void } | null = null
let stallSeen: { run: RelayRun; since: number } | null = null
let stallTickAt: number | null = null
// The plan whose relay the server stopped, or that is signed out: it is not started again until something asks (a connect, the
// model's session_connect, a sign-in), so a refresh cannot restart a stopped relay in a loop.
// boxed, because a halt on no plan (`planId: null`) is a halt too.
let relayHalted: { planId: number | null } | null = null
// the usage report's timer, one per session.
let usageTicker: { cancel: () => void } | null = null
// the idle check for an agent's ready that lands while no main turn is running (see idleCompactionCheck).
let compactionTicker: { cancel: () => void } | null = null
// the fast claim poll, running only while a permission request is open (syncPermissionPoll).
let permissionTicker: { cancel: () => void } | null = null
// a fast tick is skipped while the last one's claims are still out (slow answers must not stack claim traffic). A
// module variable: a reload starts with no claim of its own in flight.
let permissionTickBusy = false

// a dashboard call has succeeded in this session. Module state, cleared at every session start.
let dashboardAnswered = false

// One dashboard call through the session's own dashboard MCP server (the plugin's, SERVER, unless a caller names the one its session has: the pacing calls do, liveServer): same credential, same
// x-danx-session-id header. EVERY call here is the plugin's background work, never the agent's own, so it carries
// `background: true` (the MCP turns it into a request header): the dashboard keeps the session registered and live for it but does not take it as
// the agent acting, which would end the agent's pause. The agent's own 50arms_api calls never pass through here. Any rejection (including the engine's "no such server") is an error shown as one.
async function api($: any, method: string, path: string, extra: ApiExtra = {}, server: string = SERVER): Promise<Api> {
  let res
  try {
    res = await $.mcp.call(server, '50arms_api', { method, path, ...extra, background: true })
  } catch (err: any) {
    return failedCall(err)
  }
  const outcome = await wholeAnswer($, toolOutcome(res), extra.reply_to_file === true)
  // a dashboard call that succeeded proves the session signed in; the spawn claim then refuses when the server is later unreachable
  if (outcome.ok) dashboardAnswered = true
  return outcome
}

// A 50arms_api answer comes as `reply_file` with no body when the call asked for a file (`reply_to_file`) or the answer was over the MCP's 40,000-character inline limit: its body is read from that file and checked against
// the file's sha256 the answer names, so every reader of an answer reads the whole of it and exactly what the MCP wrote. A file that cannot be read, or whose hash differs, is a failure that names it, never an answer with no body.
// A call that asked for a file and got a body inline (a dashboard answer with status; status 0 is the MCP's own failure text) is a failure too: the plugin never takes a bundle from a tool result, which Claude Code refuses above its size limit.
async function wholeAnswer($: any, outcome: Api, askedForFile: boolean): Promise<Api> {
  if (outcome.replyFile === undefined) {
    if (!askedForFile || outcome.status === 0) return outcome
    return { ok: false, status: outcome.status, body: { error: 'the answer carried its body inline although the call asked for a reply file' } }
  }
  const failed = (why: string): Api => ({ ok: false, status: outcome.status, body: { error: `the answer's reply file ${outcome.replyFile} could not be read (${why})` } })
  if (outcome.replySha256 === undefined) return failed('the answer names no sha256')
  let text: string | null
  try {
    text = await $.fs.read(outcome.replyFile)
  } catch (err: any) {
    return failed(errMessage(err))
  }
  if (typeof text !== 'string') return failed('no such file')
  const sha = sha256Hex(text)
  if (sha !== outcome.replySha256) return failed(`its sha256 ${sha} is not the ${outcome.replySha256} the answer names`)
  try {
    return { ok: outcome.ok, status: outcome.status, body: JSON.parse(text) }
  } catch {
    return failed('not JSON')
  }
}

// what a thrown call to the plugin's server means, never in the engine's raw words
function failedCall(err: any): Api {
  const message = String(err?.message ?? err)
  // `unreachable` is the engine's "no such server" and nothing else: the plugin's own server is not connected (yet). The plan
  // load carries it on its error view (`serverNotConnected`, which the session-start retry waits out); the pacing and usage readers
  // stay quiet about it until a read has succeeded.
  const notConnected = isServerNotConnected(message)
  // a classifier refusal shows the person's sentence and fix wherever the error is shown (toasts, lines), never the engine's raw words; those are kept whole on `refusal` for the relay's start and the load's blocked view
  const refusal = classifierRefusal(message)
  // a 50 Arms MCP older than the plugin refuses a key the hooks send; its failure is one whole sentence naming the fix (`sentence`, so errText adds no prefix)
  const failed: Api =
    refusal !== null ? { ok: false, status: 0, body: { error: BLOCKED_LINE }, refusal, sentence: true }
    : isStaleMcpRefusal(message) ? { ok: false, status: 0, body: { error: STALE_MCP_LINE }, sentence: true, staleMcp: true }
    : { ok: false, status: 0, body: { error: message.slice(0, CALL_ERROR_MAX) } }
  if (!notConnected) return failed
  failed.unreachable = true
  return failed
}

const DASHBOARD_ORIGIN_KEY = 'dashboardOrigin'

// the one door to $.store (hooks/store/recover.ts holds the recovery of a zeroed store file; this is its only wiring to the engine's `$`). Every `$.store`
// call of the plugin is made here, in `storeIo`, and reached through `storeOp`.
function storeIo($: any): StoreIo {
  return {
    run: async call => {
      if (call.op === 'get') return $.store.get(call.key)
      if (call.op === 'set') return $.store.set(call.key, call.value)
      if (call.op === 'delete') return $.store.delete(call.key)
      return $.store.keys()
    },
    probe: async () => void (await $.store.keys()),
    readBase64: async path => ((await $.fs.read(path, { as: 'bytes' })) as { base64: string }).base64,
    write: (path, text) => $.fs.write(path, text),
    now: async () => $.clock.now(),
    toast: text => void $.ui.toast(text),
  }
}

async function storeOp($: any, call: StoreCall): Promise<any> {
  return storeDoor(storeIo($), call)
}

async function loadView($: any) {
  const refreshedAt = await isoNow($)
  const loaded = await loadPlan((method, path, extra) => api($, method, path, extra), refreshedAt)
  // the band's links need the dashboard origin even when this load could not read it (signed out, a failed call, a
  // session just started): the last origin a plan list answered is kept in $.store (across sessions) and stands in for it.
  if (loaded.dashboardUrl !== null) {
    await storeOp($, { op: 'set', key: DASHBOARD_ORIGIN_KEY, value: loaded.dashboardUrl })
    return loaded
  }
  const seen = await storeOp($, { op: 'get', key: DASHBOARD_ORIGIN_KEY })
  return typeof seen === 'string' ? { ...loaded, dashboardUrl: seen } : loaded
}

// the plan the session was on is kept through every view that does not know it (a failed load, a signed-out one) for Sign in to ask
// for again; a loaded view knows its own.
async function applyLoaded($: any, loaded: any): Promise<void> {
  // each failure is told once, on the load that makes it appear; the change is decided inside the update, so overlapping loads toast once
  let told: string[] = []
  // the plan the model's own session_connect named stands in for what the refused reads could not say
  const named = loaded.phase === 'blocked' ? await read($, modelPlan) : null
  // a link is never built on a null origin: the load's (or the stored) one, else DANXBOT_DASHBOARD_URL, else the plugin's dashboard_url option; with none, the plan is not named
  const origin = named === null ? null : blockedOrigin({ loaded: loaded.dashboardUrl, env: await $.env.get('DANXBOT_DASHBOARD_URL'), option: dashboardOption })
  // a loaded view knows the plan itself: what the model named is stale from here
  if (loaded.phase === 'ready') await update($, modelPlan, () => null)
  await update($, view, cur => {
    told = []
    if (loaded.phase === 'load-failed' && cur.phase !== 'load-failed') told.push(`Plan load failed: ${loaded.error}`)
    if (loaded.needsYouError && cur.needsYouError !== loaded.needsYouError) told.push(`Plan cards unavailable: ${loaded.needsYouError}`)
    if (loaded.phase === 'ready') return loaded
    const base = { ...loaded, resumePlan: cur.connected?.id ?? cur.resumePlan }
    return named === null || origin === null ? base : { ...base, dashboardUrl: origin, connected: { id: named.id, ref: `PLAN-${named.id}`, name: named.name, dashboardUrl: origin } }
  })
  for (const t of told) $.ui.toast(t.slice(0, TOAST_ERROR_MAX))
  // the app's title follows the count as each load lands, not only at the next prompt
  detach($, 'The session title mark', syncTitleMark($))
  // a write path, never the draw: the events warning's reason is told on the change into it
  await noteEventsWarning($)
  // the view says which plan this session is on, so it says whether a relay runs and for which
  await syncRelay($)
  // a signed-out session reads the machine's registration (registration_only: the call makes no access request); a working connection has none to show
  // a watch that stopped on an error is not started again by every load: each restart would toast the failure again
  if (loaded.phase === 'signed-out' && !(await registrationRecentlyStopped($))) detach($, 'Machine registration', watchRegistration($))
  else if (loaded.phase === 'ready') await abortRegistrationWatch($)
  // signed in, with its team agent: whatever the session's start could not tell it, it is told now
  if (isSignedInWithAgent(loaded)) await giveOwedMantra($)
}

// A conversation whose start found the session without a usable key is owed the mantra once the session is signed in (and can ask for it). The owing is taken
// here and becomes a pending start, told with the next prompt or tool result like a session start: a sign-in the person made at the band, the model's own approved
// `session_connect` and a ready command's all end in a load, so this is the one place they meet.
async function giveOwedMantra($: any): Promise<void> {
  let owed = false
  await update($, mantraOwed, cur => {
    owed = cur
    return false
  })
  if (!owed) return
  const start: NonNullable<PendingStart> = { sessionId: String(await $.session.id()), source: SIGN_IN_SOURCE, transcriptPath: null, predecessorId: null }
  await update($, pendingStart, cur => cur ?? start)
}

// a load that failed outside the load itself (its deadline, a throw): the view goes to the error phase, told once on the change into it.
async function failView($: any, error: string): Promise<void> {
  let first = false
  await update($, view, cur => {
    first = cur.phase !== 'load-failed'
    return { ...cur, phase: 'load-failed', error }
  })
  if (first) $.ui.toast(`Plan load failed: ${error}`.slice(0, TOAST_ERROR_MAX))
  detach($, 'The session title mark', syncTitleMark($))
}

// The desktop app keeps its own session title, which a hook's `sessionTitle` (onTitle) does not reach: the app's own session server renames it.
// The title carries the connection mark and the Needs You mark as the view and the relay say (sessionTitle); a title already right is left alone.
// A terminal session has no such server, so its title follows at each prompt only.
async function syncTitleMark($: any): Promise<void> {
  if (!(await read($, desktopHosted))) return
  await underTitleLock(async () => {
    let held = await readAppTitle($)
    // The title is read again right before the write, and a title that changed in between (a rename racing this sync) is the new base. Bounded: a
    // title that keeps changing is left to the next sync.
    for (let tries = 0; held !== null && tries < TITLE_WRITE_TRIES; tries++) {
      await rememberTitle($, held)
      const want = sessionTitle(held, await read($, view), await read($, relay), await titleActivity($))
      if (want === held) return
      const again = await readAppTitle($)
      if (again !== held) {
        held = again
        continue
      }
      await setAppTitle($, want)
      return
    }
  })
}

const TITLE_WRITE_TRIES = 3

// Every writer of the desktop app's title runs one at a time, so a sync and a rename never interleave their read and write. A failure of one
// step reaches its own caller only.
let titleChain: Promise<unknown> = Promise.resolve()
function underTitleLock<T>(step: () => Promise<T>): Promise<T> {
  const run = titleChain.then(step)
  titleChain = run.catch(() => undefined)
  return run
}

// the desktop app's title of this session, trimmed; null when it is empty or unreadable as a title
async function readAppTitle($: any): Promise<string | null> {
  const got = await $.mcp.call(DESKTOP_SESSION_SERVER, 'get_session', { session_id: 'self' })
  if (got.isError) throw new Error(`get_session: ${mcpText(got)}`)
  const held = JSON.parse(mcpText(got))?.title
  return typeof held === 'string' && held.trim() !== '' ? held.trim() : null
}

async function setAppTitle($: any, to: string): Promise<void> {
  const set = await $.mcp.call(DESKTOP_SESSION_SERVER, 'set_session_title', { session_id: 'self', title: to })
  if (set.isError) throw new Error(`set_session_title: ${mcpText(set)}`)
  await rememberTitle($, to)
}

// the plugin's remembered title (the one a later sign-in sends to session_connect) is the app's latest, never a name from before a rename
async function rememberTitle($: any, held: string): Promise<void> {
  const bare = unmarkedTitle(held)
  if (bare) await update($, title, () => bare)
}

// A connect answer (a session_connect, or a pickup that connected) whose `naming` block is `needed` carries the exact thread title. On a desktop
// session the plugin sets it itself (with the state mark), then connects again with that title so the server records it. A terminal session has
// no title tool and keeps the model's instruction. Returns the title set, or null when nothing was done.
async function applyNaming($: any, target: unknown, naming: any): Promise<string | null> {
  if (naming?.status !== 'needed' || typeof naming.title !== 'string' || naming.title.trim() === '') return null
  if (!(await read($, desktopHosted))) return null
  const exact = naming.title.trim()
  // the model's connect already succeeded on the server: a failure here is told, never thrown out of the hook
  // The connect just succeeded, so the session holds the agent the title names: the exact title is set as 50 Arms gave it, never run through
  // the view (which can still read signed out when this same call signed the session in, e.g. a launched session's first connect, which signs in by its grant). The mark
  // follows from the sync the connect's own view refresh runs.
  try {
    await underTitleLock(() => setAppTitle($, exact))
  } catch (err) {
    $.ui.toast(`Setting the thread title failed: ${errMessage(err)}`.slice(0, TOAST_ERROR_MAX))
    return null
  }
  try {
    const again = answerOf(await $.mcp.call(SERVER, 'session_connect', { ...(typeof target === 'string' && target !== '' ? { target } : {}), title: exact }))
    if (!again.ok) $.ui.toast(`Telling 50 Arms the thread title failed: ${errMessage(again.body?.error ?? again.status)}`.slice(0, TOAST_ERROR_MAX))
  } catch (err) {
    $.ui.toast(`Telling 50 Arms the thread title failed: ${errMessage(err)}`.slice(0, TOAST_ERROR_MAX))
  }
  return exact
}

// the model is told the plugin named the thread, so it does not rename it as the connect answer's naming block asks
const withNamedNote = (ran: any, named: string) => ({ ...ran, context: [...(ran.context ?? []), `The plugin set this thread's title to "${named}" and connected again with it; do not rename the thread.`] })

// The model's own rename of the desktop thread runs under the same lock as the plugin's title writers, so a title-mark sync's read and write
// never straddle it, and the plugin remembers the title the model set. The sync that follows puts the state mark back. The plugin's own calls to the
// tool pass straight through: they already hold the lock.
async function onModelSetTitle($: any, e: any, next: any) {
  if (raisedByPlugin(next.origin)) return next(e)
  const ran = await underTitleLock(async () => {
    const done = await next(e)
    if (done.isError !== true && done.deny === undefined && typeof e.title === 'string') await rememberTitle($, e.title.trim())
    return done
  })
  detach($, 'The session title mark', syncTitleMark($))
  return ran
}

// the desktop app's session server (its `get_session` / `set_session_title` tools)
const DESKTOP_SESSION_SERVER = 'ccd_session_mgmt'

function mcpText(r: any): string {
  return (Array.isArray(r?.content) ? r.content : []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('')
}

// One load in flight at a time, at least MIN_GAP_MS apart unless forced. A forced refresh asked
// while one runs makes it run once more, so a write's result is never left unread. The gate is
// $.state, not module variables (lost on reload).
async function refresh($: any, force = false): Promise<void> {
  const now = await $.clock.now()
  let go = false
  await update($, gate, cur => {
    // a lock held past LOCK_STALE_MS belongs to a step that never settled: any request, forced or not, takes it over
    const stale = cur.inFlight && cur.at !== null && now - cur.at > LOCK_STALE_MS
    if (cur.inFlight && !stale) {
      go = false
      return force ? { ...cur, again: true } : cur
    }
    go = force || cur.at === null || now - cur.at >= MIN_GAP_MS
    return go ? { inFlight: true, again: false, at: now } : cur
  })
  if (!go) return
  // The lock is released in `finally`, so a throw out of any step below cannot leave it held and
  // stop every later refresh.
  try {
    let again = true
    while (again) {
      try {
        // EVERY load (not only the first) is an error shown at LOAD_DEADLINE_MS, so a hung call does not hold the view's state or the relay's
        // start. The call itself is not abandoned to run beside the next load: this refresh keeps the lock for up to LOAD_ORPHAN_WAIT_MS more and
        // applies its answer if it comes then, so at most one load runs (through that wait; past it the call is given up).
        const load = loadView($)
        let v = await withinDeadline($, LOAD_DEADLINE_MS, load, () => null)
        if (v === null) {
          await failView($, `the plan did not load within ${LOAD_DEADLINE_MS / 1000}s`)
          v = await withinDeadline($, LOAD_ORPHAN_WAIT_MS, load, () => null)
        }
        if (v !== null) await applyLoaded($, v)
      } catch (err: any) {
        await failView($, String(err?.message ?? err))
      }
      await settlePermissionRequests($)
      await update($, gate, cur => {
        // `at` is this claim's token: a load whose stale lock was taken over must not touch the new holder's
        if (cur.at !== now) {
          again = false
          return cur
        }
        again = cur.again
        return { ...cur, again: false }
      })
    }
  } finally {
    await update($, gate, cur => (cur.at === now ? { ...cur, inFlight: false, again: false } : cur))
  }
}

// a request leaves the list once its claim (the key's own route) decides it (settle): granted, denied,
// expired, unknown to the dashboard, or the session lost its key. A claim that fails for any other reason keeps it for the next
// poll: a request has no expiry clock of its own. The model is told each decision once, waking it when it is idle (tellModelAwake).
async function settlePermissionRequests($: any): Promise<void> {
  const tellings = new Map<string, Telling | null>()
  const granted = new Map<string, string[]>()
  for (const r of await read($, permissionRequests)) {
    const settled = settle(r, await api($, 'POST', claimPath(r)))
    if (settled.kind === 'drop') tellings.set(r.publicId, settled.telling)
    if (settled.kind === 'drop' && settled.granted !== undefined) granted.set(r.publicId, settled.granted)
  }
  // only what this run takes out of the list is told by it: a settle running beside it (the fast poll and a refresh) takes
  // none of the same requests
  let taken: PermissionRequest[] = []
  await update($, permissionRequests, cur => {
    taken = cur.filter(r => tellings.has(r.publicId))
    return cur.filter(r => !tellings.has(r.publicId))
  })
  const readyPermission = (await read($, readyLoop))?.permissionId
  for (const r of taken) {
    // the ready-agent loop's own request: the model made no such call, so the decision is the loop's
    if (r.publicId === readyPermission) {
      if (granted.get(r.publicId)?.includes(REPOS_PERMISSION) === true) detach($, 'Ready list', syncReady($))
      else await leaveReady($, READY_PERMISSION_ENDED)
      continue
    }
    const telling = tellings.get(r.publicId)
    if (telling === null || telling === undefined || !(await markToldOnce($, r.publicId))) continue
    if (telling.kind === 'note') await tellModelAwake($, telling.text)
    else await tellEventToModel($, telling.event, telling.extra, 'plugin.prompt')
  }
  await syncPermissionPoll($)
}

// one fast-poll tick; skipped while the last one is still out (permissionTickBusy).
async function permissionTick($: any): Promise<void> {
  if (permissionTickBusy) return
  permissionTickBusy = true
  try {
    await settlePermissionRequests($)
  } finally {
    permissionTickBusy = false
  }
}

// the told-once guard, in $.store so it outlives a reload and a restart (the request list itself may come back, or the
// model may be answered the same request again): true the first time a request's decision is to be told, false ever after.
// Marked before the telling, so a telling that fails is toasted (notToldToast) and never repeated. The read-then-write is not atomic:
// two settles marking different ids at once can lose one id, which only matters if that request comes back into the list later.
// Each telling is exclusive anyway: a settle tells only the requests its own `update` took out of the list.
const PERMISSION_TOLD_KEY = 'permissionTold'

async function markToldOnce($: any, publicId: string): Promise<boolean> {
  const seen = await storeOp($, { op: 'get', key: PERMISSION_TOLD_KEY })
  const told: string[] = Array.isArray(seen) ? seen.filter((id: unknown): id is string => typeof id === 'string') : []
  if (told.includes(publicId)) return false
  await storeOp($, { op: 'set', key: PERMISSION_TOLD_KEY, value: [...told, publicId].slice(-PERMISSION_TOLD_MAX) })
  return true
}

// the claim is polled every PERMISSION_POLL_MS while a request is open, so the model hears the decision within
// seconds; the timer stops once none is (the refresh tick's own settle is all that runs then, and it claims nothing).
async function syncPermissionPoll($: any): Promise<void> {
  const open = (await read($, permissionRequests)).length > 0
  if (open && permissionTicker === null) permissionTicker = $.clock.every(PERMISSION_POLL_MS, () => permissionTick($))
  else if (!open && permissionTicker !== null) {
    permissionTicker.cancel()
    permissionTicker = null
  }
}

// A user-role row the model reads and the person does not see typed ($.session.append's argument).
const modelRow = (text: string) => ({ message: { type: 'user' as const, content: [{ type: 'text' as const, text }] } })

// The model did not make this call, so tell it (it reads this, the person does not).
async function tellModel($: any, text: string): Promise<void> {
  try {
    const r = await $.session.append(modelRow(text))
    if (r.deny) throw new Error(r.deny)
  } catch (err: any) {
    notToldToast($, err?.message ?? err, text)
  }
}

// tell the model something it must ACT on while the person types nothing (a permission decision, a sign-in's outcome): by the plan event
// bridge's own delivery (deliverEvent), not urgent: a prompt, which wakes an idle session and queues behind a running turn.
// `tellModel`'s append is only read on the session's next turn, which an idle agent waiting on the person never starts.
async function tellModelAwake($: any, text: string): Promise<void> {
  const failure = await deliverEvent($, text, false)
  if (failure !== null) notToldToast($, failure, text)
}

// What a moment the model did not cause (a person's button, a decided request, a changed agent) tells it: the bundle's texts for the event, each told the way the event's mechanism
// carries it. A `plugin.prompt` text wakes an idle session; a `plugin.context` one is a row the model reads on its next turn. A hold line, or a session no bundle can be read for, is a toast
// that carries what the model was not told, never silence.
async function tellEventToModel($: any, event: string, extra: Record<string, string>, mechanism: 'plugin.prompt' | 'plugin.context'): Promise<void> {
  const outcome = await tellEvent($, event, null, await hookBudget($), { extra, mechanisms: [mechanism] })
  if (outcome.kind === 'signed-out' || outcome.kind === 'abandoned') {
    notToldToast($, `the "${event}" text was not told: ${outcome.kind}`, '')
    return
  }
  if (outcome.kind === 'refused') {
    notToldToast($, `the "${event}" text could not be read`, outcome.text)
    return
  }
  for (const text of outcome.entries) await (mechanism === 'plugin.prompt' ? tellModelAwake($, text) : tellModel($, text))
}

// The write the operator asked for already happened: say the model was not told, and carry the row it was meant to read (the
// operator can paste it), never hide it.
function notToldToast($: any, cause: unknown, text: string): void {
  $.ui.toast(`Could not tell the model: ${String(cause).slice(0, TOAST_ERROR_MAX)}${NOTE_MARKER}${text}`)
}

// the tool answer, with the note that the person already has the link and code, as context the model reads after the result.
const withPermissionNote = (ran: any, approval: ApprovalRequest) => ({ ...ran, context: [...(ran.context ?? []), permissionShownNote(approval)] })

// a sign-in request, drawn the moment it exists: the band reads it from $.state and draws its link and confirm
// code (the band is the only place they show, never a toast). The plugin opens no page: the person follows the link.
async function showSignInRequest($: any, approval: ApprovalRequest): Promise<void> {
  await update($, signInRequest, () => approval)
}

// the machine registration watch, one at a time and shared by whoever asks (the load, the model's session_connect, a press of Sign in, the ready loop's sign-in): it
// repeats `session_connect` with `registration_only: true` (a call that makes no access request and claims no team agent, and waits about 45 s while the
// registration is open) until the answer is `machine_registered`. Nothing else calls session_connect without that flag from a timer.
let registrationGeneration = 0
let registrationWatchRun: Promise<'registered' | 'stopped'> | null = null

// the registration is drawn by the band the moment it exists; `noted`: the model was told to send the person to it (never unset by a later look)
async function showRegistration($: any, request: { url: string; code: string }, noted: boolean): Promise<void> {
  await update($, machineRegistration, cur => ({ url: request.url, code: request.code, noted: noted || (cur !== null && cur.code === request.code && cur.noted) }))
}

// When the watch last stopped on an error. A load starts no watch for REGISTRATION_RETRY_MS after it (long enough for a rate limit to pass); a press of Sign in,
// the end of the conversation (a new MCP starts with the next one) or a registered machine clears it.
const REGISTRATION_RETRY_MS = 5 * 60_000
let registrationStoppedAt: number | null = null

async function registrationRecentlyStopped($: any): Promise<boolean> {
  return registrationStoppedAt !== null && (await $.clock.now()) - registrationStoppedAt < REGISTRATION_RETRY_MS
}

async function markRegistrationStopped($: any): Promise<void> {
  registrationStoppedAt = await $.clock.now()
}

// ends the watch that is running, if any, and draws no registration
async function abortRegistrationWatch($: any): Promise<void> {
  registrationStoppedAt = null
  registrationGeneration++
  registrationWatchRun = null
  await update($, machineRegistration, () => null)
}

// the person accepted: the link goes from this session's band, and the model that was told about it is woken. The telling is taken out of this session's own
// atom in the same update that clears it, so it is per session and per telling: another session's model is woken by its own watch, and a later registration
// (the server keeps the claim code) wakes a model that was told about it again.
async function onMachineRegistered($: any): Promise<void> {
  let shown = null as { url: string; code: string; noted: boolean } | null
  await update($, machineRegistration, cur => {
    shown = cur
    return null
  })
  if (shown === null) return
  const { code, noted } = shown
  if (noted) await tellModelAwake($, machineRegisteredNote(code))
  await refresh($, true)
}

// One `session_connect` round of a watch (the sign-in's and the registration's): the call, and null when it threw (`onFailure` says so, unless the watch ended meanwhile)
// or the watch ended while it waited. `startedAt` is for holdMinRound.
async function watchCall($: any, args: object, ended: () => boolean, onFailure: (err: any) => void | Promise<void>): Promise<{ r: any; startedAt: number } | null> {
  const startedAt = await $.clock.now()
  let r
  try {
    r = await $.mcp.call(SERVER, 'session_connect', args)
  } catch (err: any) {
    if (!ended()) await onFailure(err)
    return null
  }
  return ended() ? null : { r, startedAt }
}

// an answer that came back sooner than the MCP's own wait must not turn a watch into a tight loop
async function holdMinRound($: any, startedAt: number): Promise<void> {
  const took = (await $.clock.now()) - startedAt
  if (took < SIGN_IN_MIN_ROUND_MS) await $.clock.sleep(SIGN_IN_MIN_ROUND_MS - took)
}

// The shared watch: its outcome is 'registered', or 'stopped' (it failed, or the conversation ended it).
function watchRegistration($: any): Promise<'registered' | 'stopped'> {
  if (registrationWatchRun === null) {
    const generation = registrationGeneration
    const run: Promise<'registered' | 'stopped'> = runRegistrationWatch($, () => generation !== registrationGeneration).finally(() => {
      // an aborted watch's slot was freed at the abort; a new watch may hold it by now
      if (registrationWatchRun === run) registrationWatchRun = null
    })
    registrationWatchRun = run
  }
  return registrationWatchRun
}

async function runRegistrationWatch($: any, ended: () => boolean): Promise<'registered' | 'stopped'> {
  for (;;) {
    const round = await watchCall($, { registration_only: true }, ended, async err => {
      $.ui.toast(registrationFailedToast(String(err?.message ?? err)))
      await markRegistrationStopped($)
    })
    if (round === null) return 'stopped'
    const step = registrationStep(round.r)
    if (step.kind === 'registered') {
      await onMachineRegistered($)
      return 'registered'
    }
    if (step.kind === 'stop') {
      $.ui.toast(registrationFailedToast(step.message))
      await markRegistrationStopped($)
      await update($, machineRegistration, () => null)
      return 'stopped'
    }
    await showRegistration($, step.request, false)
    await holdMinRound($, round.startedAt)
    if (ended()) return 'stopped'
  }
}

// the tool answer, with the note that the person already has the link and code, as context the model reads after the result.
const withSignInNote = (ran: any, approval: ApprovalRequest) => ({ ...ran, context: [...(ran.context ?? []), signInShownNote(approval)] })

// One write per key at a time: the claim is a compare-and-set on $.state, so two presses landing
// together (a double click, a key repeat) cannot both win. The loser does nothing.
// `release`: false when something else already freed the key and a newer holder may own it now (an aborted sign-in watch)
async function withBusy($: any, key: string, work: () => Promise<void>, release: () => boolean = () => true): Promise<void> {
  let won = false
  await update($, busy, cur => {
    won = !cur.includes(key)
    return won ? [...cur, key] : cur
  })
  if (!won) return
  try {
    await work()
  } finally {
    if (release()) await update($, busy, cur => cur.filter(k => k !== key))
  }
}

// a leave pressed on a band that went stale: the key is gone since the band drew. The person is told
// in the view's words, never the server's (a revoked key's answer is the agent's stop order), and the view reloads to say so.
// True when that was the answer.
async function accessEnded($: any, outcome: ToolOutcome): Promise<boolean> {
  const by = outcomeRevokedBy(outcome)
  if (by === null && !isSignedOut(outcome)) return false
  detach($, 'Plan refresh', refresh($, true))
  return true
}

// the one way to run a task apart from the event that started it (a press, a hook, a tick). A press ends as soon as its own
// outcome is known and shown; what follows (the model's note, the full refresh with its relay and live syncs, a second forced pass)
// runs here, so the busy label never waits on reads that are not the action's own. The task's failures are shown, never swallowed: a
// refresh reports its own load failures in the view, and anything it throws past that is a toast. Only the environment ending under
// it escapes (settleDetached). `what` names the task in that toast.
function detach($: any, what: string, task: Promise<unknown>): void {
  void settleDetached(task).catch(err => $.ui.toast(`${what} failed: ${String(err?.message ?? err).slice(0, FAILURE_TOAST_MAX)}`))
}

// a call the plugin raised itself failed: a classifier refusal is told in the person's words (cause and fix) and the view reloads to
// show the same state; any other failure keeps its own words.
function toastCallFailedAndReload($: any, what: string, err: any): void {
  const message = String(err?.message ?? err)
  if (classifierRefusal(message) === null) {
    $.ui.toast(`${what}: ${message.slice(0, FAILURE_TOAST_MAX)}`)
    return
  }
  $.ui.toast(BLOCKED_LINE)
  detach($, 'Plan refresh', refresh($, true))
}

const isoNow = async ($: any): Promise<string> => new Date(await $.clock.now()).toISOString()

// what a session_connect answer for a plan settles, drawn at once from EMPTY, so nothing of the plan the session was on (its cards,
// listener) stays under the new one. Kept: what is not plan-specific (the dashboard origin, the session's team agent). A leave puts the session on no plan.
const planIndependent = (cur: any) => ({ ...EMPTY, dashboardUrl: cur.dashboardUrl, agent: cur.agent })
function leftView(cur: any): any {
  return { ...planIndependent(cur), phase: 'ready', refreshedAt: cur.refreshedAt }
}

// The band's Disconnect: takes the session off the plan or the card it holds and nothing else. The session stays signed in with its team agent, so no sign-in is asked of the person and
// no call of the plugin's own joins anything again. `session_connect` with `disconnect: true`, its `target` the guard: the plan or card we think we are on. It runs under its own busy key, and not while a Revoke runs.
// A refusal is shown, never swallowed: a 409 means the band was stale (the server names what the session really holds), so it also refreshes; a 404 or any other failure carries its status and message.
function disconnect($: any, hold: BandHold): Promise<void> {
  return withBusy($, busyKey.disconnect(holdKey(hold)), async () => {
    if (busyKey.isRevoking(await read($, busy))) return
    const left = hold.plan !== null ? await leavePlan($, hold.plan) : hold.card !== null ? await leaveCard($, hold.card) : null
    if (left === null) {
      $.ui.toast('Disconnect failed: the session holds no plan or card')
      return
    }
    if (left === 'refused') return
    // the band goes to no work at once (the agent stays), then reads the truth; the model, which did not make the call, is told in its chat
    await update($, view, cur => leftView(cur))
    detach($, 'Plan update', tellEventToModel($, 'band.disconnect', { left_ref: left.ref, left_name: left.name }, 'plugin.context').then(() => refresh($, true)))
  })
}

// The band's Revoke: ends the session's sign-in with `POST /me/person-disconnect`, which frees the team agent and revokes the key, so no call of the session's own reconnects it; only the person's Sign in does.
// It makes no leave call: the revoke alone is its job. It runs under its own busy key, and not while a Disconnect runs. A failed call changes nothing and is shown.
function revoke($: any, hold: BandHold): Promise<void> {
  return withBusy($, busyKey.revoke, async () => {
    if (busyKey.isDisconnecting(await read($, busy))) return
    const ended = await personDisconnectCall($)
    // a key that is already gone (signed out, revoked) leaves nothing to end: the refreshed view says which
    const done = ended.ok || endUnneeded(ended)
    if (!done) {
      $.ui.toast(revokeFailure(errText(ended)).slice(0, FAILURE_TOAST_MAX))
      return
    }
    // a sign-in watch running now (the model's own connect, begun before the person pressed Revoke) must not hold "Signing in…" on a band that offers Sign in
    await abortSignInWatch($)
    // the band goes to no work at once, then reads the truth (a revoked key reads "access revoked" and offers Sign in)
    await update($, view, cur => ({ ...leftView(cur), agent: null }))
    detach($, 'Plan update', tellModel($, revokeNote({ ended: true })).then(() => refresh($, true)))
  })
}

// One leave call: `session_connect` with `disconnect: true` and the `target` the band shows, which the server checks against what the session really holds. It closes what the session
// opened first; a leave that does not happen takes that back. The answer of a leave that happened, or 'refused' once the refusal is shown (and the view reloaded where it was stale).
async function leaveCall($: any, target: string): Promise<ToolOutcome | 'refused'> {
  const why = `leaving ${target}`
  const closes = await closeOwedBeforeLeave($, why)
  let r
  try {
    r = await $.mcp.call(SERVER, 'session_connect', { target, disconnect: true })
  } catch (err: any) {
    await settleLeave($, closes, false, why)
    toastCallFailedAndReload($, 'Disconnect failed', err)
    return 'refused'
  }
  const outcome = connectToolOutcome(r)
  await settleLeave($, closes, outcome.ok, why)
  if (await accessEnded($, outcome)) return 'refused'
  if (!outcome.ok) {
    $.ui.toast(`Disconnect refused: ${refusalText(outcome)}`.slice(0, FAILURE_TOAST_MAX))
    // plan_mismatch / session_not_connected / card_mismatch / session_holds_no_card: the band was stale (the server names what the session really holds)
    if (outcome.status === 409) detach($, 'Plan refresh', refresh($, true))
    return 'refused'
  }
  return outcome
}

// Leaves the plan; the plan's ref and name, or 'refused' once the refusal is shown.
async function leavePlan($: any, plan: ConnectedPlan): Promise<{ ref: string; name: string } | 'refused'> {
  const outcome = await leaveCall($, planTarget(plan.id))
  if (outcome === 'refused') return 'refused'
  const left = outcome.body?.leftPlan
  if (typeof left?.name !== 'string') {
    // a 200 that names no plan left cannot be told to the model as fact: show it, and read the truth
    $.ui.toast('Disconnect failed: the answer named no plan left')
    detach($, 'Plan refresh', refresh($, true))
    return 'refused'
  }
  return { ref: plan.ref, name: left.name }
}

// Leaves the stand-alone card the band shows (the server refuses a card id the session does not hold); the card's id and title, or 'refused' once the refusal is shown.
async function leaveCard($: any, card: NonNullable<BandHold['card']>): Promise<{ ref: string; name: string } | 'refused'> {
  const outcome = await leaveCall($, card.id)
  if (outcome === 'refused') return 'refused'
  if (outcome.body?.leftCard === null || typeof outcome.body?.leftCard !== 'object') {
    $.ui.toast('Disconnect failed: the answer named no card left')
    detach($, 'Plan refresh', refresh($, true))
    return 'refused'
  }
  return { ref: card.id, name: card.title }
}

// the wait on a sign-in request, one at a time. A session with no dashboard key asks for one through
// `session_connect`; the MCP answers with the approval request, drawn at once (showSignInRequest: the band's link and code). Each call waits
// there (about 45 s) for the person's approval, so the calls repeat until one answers something final, with no round limit: a
// request stays open for as long as its session lives. The status of the request cannot be read any other way: its
// claim needs a secret only the MCP process holds (and a claim would take the key from it), and reading it by id needs a
// person's login. A call that answers a DIFFERENT request than the one watched means the first expired while it waited: the
// model is told, and the renewed request is shown and watched in its place, so nobody has to relay it.
//
// Two starts: the Sign in button (`byPress`: the person is waiting, and the model is told once that it is
// signed in), and the model's own `session_connect` answering `approval_required` (`known`: the request already shown; the model is
// told the outcome once, approved, denied or expired, so the person never has to type "approved"). The whole watch holds the
// sign-in busy key (the buttons read "Signing in…", a second start does nothing).
// bumped when the conversation (or the process) ends; a watch of an older generation stops at its next step, so it
// never calls session_connect with the old conversation's arguments or tells the new conversation about a request it never made
let signInGeneration = 0

// `forReadyLoop`: the ready-agent loop's own sign-in. The model did not ask for it and is told nothing; a sign-in that ends without a key takes the session off the list.
// `wasSignedOut` (a press): the view the press found had no working sign-in (signed out, a revoked key, or the agent gate), so a sign-in that lands is a real change the model is told of;
// a press on a session that was signed in all along (an unreachable server) tells it nothing.
type SignInWatch = { args: object } & ({ byPress: true; wasSignedOut: boolean; forReadyLoop?: true } | { byPress: false; known: ApprovalRequest })

async function watchSignIn($: any, watch: SignInWatch): Promise<void> {
  const generation = signInGeneration
  // False while the ready loop waits on a registration without the busy key (a person may take as long as they like), so the finally frees nothing then
  let holdsBusy = true
  await withBusy($, busyKey.signIn, async () => {
    const ended = () => generation !== signInGeneration
    let shown: ApprovalRequest | null = watch.byPress ? null : watch.known
    await update($, signInRequest, () => shown)
    // each outcome is told once (the told-once guard, keyed by the request). The model's request always has an id
    // (onPlanConnect and the renewal below refuse one without); only the press may see one with none, and it tells once per watch.
    // told as a waking prompt (tellModelAwake), on both paths: the session sits idle while the person approves, and an
    // appended row is read only on a turn nobody starts, so the person had to type "approved" for the model to go on.
    const tell = async (request: ApprovalRequest | null, text: string) => {
      if ('forReadyLoop' in watch) return
      const key = request === null ? undefined : publicIdOf(request.url)
      if (key === undefined ? watch.byPress : await markToldOnce($, key)) await tellModelAwake($, text)
    }
    const shownRequest = (): ApprovalRequest => {
      if (shown === null) throw new Error('sign-in watch: the model path has no shown request')
      return shown
    }
    try {
      for (;;) {
        const round = await watchCall($, watch.args, ended, err => toastCallFailedAndReload($, 'Sign in failed', err))
        if (round === null) return
        const { r, startedAt } = round
        const step = signInStep(r)
        // any answer but "still waiting" (or the registration the ready loop waits through) ends the request: the band stops drawing its link and code now, not after the tells and the refresh below
        if (step.kind !== 'waiting' && step.kind !== 'registration' && !ended()) await update($, signInRequest, () => null)
        if (step.kind === 'waiting') {
          if (shown !== null && step.request.url !== shown.url) {
            // the request watched is over without a decision reaching this call: it lapsed, and this answer is its renewal
            if (!watch.byPress) await tell(shown, signInExpiredNote(shown.code))
            if (!watch.byPress && publicIdOf(step.request.url) === undefined) {
              $.ui.toast(signInFailedToast('the renewed approval request had no id'))
              return
            }
          }
          if (shown === null || step.request.url !== shown.url) await showSignInRequest($, step.request)
          shown = step.request
          await holdMinRound($, startedAt)
          if (ended()) return
          continue
        }
        if (step.kind === 'registration') {
          // the machine is not registered, so there is no sign-in to wait on: the band shows the link, and the registration watch tells when the person accepts
          await showRegistration($, step.request, false)
          if ('forReadyLoop' in watch) {
            // the ready-agent loop stays waiting for the person's accept and then asks to sign in again, so it moves on without being told
            // the wait is the person's, however long: the buttons do not read "Signing in…" meanwhile
            holdsBusy = false
            await update($, busy, cur => cur.filter(k => k !== busyKey.signIn))
            if ((await watchRegistration($)) === 'registered' && !ended()) {
              await update($, busy, cur => (cur.includes(busyKey.signIn) ? cur : [...cur, busyKey.signIn]))
              holdsBusy = true
              await holdMinRound($, startedAt)
              if (ended()) return
              continue
            }
            if (!ended()) await leaveReady($, READY_SIGN_IN_ENDED)
            return
          }
          detach($, 'Machine registration', watchRegistration($))
          return
        }
        if (step.kind === 'revoked') {
          if ('forReadyLoop' in watch) await leaveReady($, readyRevoked(step.by))
          await refresh($, true)
          return
        }
        if (step.kind === 'denied') {
          $.ui.toast(SIGN_IN_DENIED_TOAST)
          if ('forReadyLoop' in watch) await leaveReady($, READY_SIGN_IN_ENDED)
          if (!watch.byPress) await tell(shown, signInDeniedNote(shownRequest().code))
          return
        }
        if (step.kind === 'stop') {
          // the key exists and only an agent is missing: the loop stays, and only another /50arms:ready can claim one, since the MCP's own gate is closed now
          if ('forReadyLoop' in watch && step.signedIn === true) {
            await tellReadyOnce($, readyNoAgentYet(step.message))
            if (step.refusal !== undefined) await tellAgentRefusal($, step.refusal)
            await refresh($, true)
            return
          }
          $.ui.toast(step.message)
          if ('forReadyLoop' in watch) await leaveReady($, READY_SIGN_IN_ENDED)
          return
        }
        // signed in (even if the plan was refused): the view reads the truth
        if (step.kind !== 'done') $.ui.toast(step.message)
        // the model did not press Sign in, so it is told it is signed in (and where), as connect tells it
        const target = typeof (watch.args as any).target === 'string' ? (watch.args as any).target : null
        if (!watch.byPress) await tell(shown, signInApprovedNote(shownRequest().code, target))
        else if (watch.wasSignedOut) await tell(shown, signInNote(target, step.kind === 'done'))
        await refresh($, true)
        if ('forReadyLoop' in watch) detach($, 'Ready list', syncReady($))
        return
      }
    } finally {
      if (!ended()) await update($, signInRequest, () => null)
    }
    // an aborted watch's key was freed at the abort (onSessionEnd); a new watch may hold it by now, so this one never frees it
  }, () => holdsBusy && generation === signInGeneration)
}

// The button's press returns at once: the sign-in waits minutes for a person, and a press must not. A watch already running
// (the model's own sign-in) leaves the band showing its link and code: the press does nothing instead of starting a second wait.
async function startSignIn($: any): Promise<void> {
  const waiting = await read($, signInRequest)
  if (waiting !== null) return
  registrationStoppedAt = null
  const args = await signInArgs($)
  const found = await read($, view)
  const wasSignedOut = found.phase === 'signed-out' || found.phase === 'key-revoked' || found.agentBlock !== null
  void watchSignIn($, { args, byPress: true, wasSignedOut }).catch(err => toastCallFailedAndReload($, 'Sign in failed', err))
}

// The sign-in's own `session_connect` arguments: the session's title, and the plan it was on (its `target`). On a revoked key the press also says a person
// is signing in (`person_sign_in`), the one flag that makes the MCP leave its stop and ask; no other call sends it.
async function signInArgs($: any): Promise<object> {
  const sessionTitle = await read($, title)
  const current = await read($, view)
  const resume = current.resumePlan
  return {
    ...(resume !== null ? { target: planTarget(resume) } : {}),
    ...(sessionTitle ? { title: sessionTitle } : {}),
    ...(current.phase === 'key-revoked' ? { person_sign_in: true } : {}),
  }
}

// the one way back to the plan UI, for the footer button and /50arms-plan alike: bring the band back (clear
// `dismissed`). It tells the model nothing (only actions that change plan state tell it something; this changes none).
async function showPlan($: any): Promise<void> {
  await update($, dismissed, () => false)
}

// The band's close control: the band hides until the footer button or /50arms-plan is used.
async function dismissBand($: any): Promise<void> {
  await update($, dismissed, () => true)
}

function handlers($: any): Handlers {
  return {
    showPlan: () => showPlan($),
    dismissBand: () => dismissBand($),
    disconnect: hold => personDisconnect($, hold),
    revoke: hold => personRevoke($, hold),
    signIn: () => startSignIn($),
  }
}

// ---- hooks ----------------------------------------------------------------

// The first load can run before the plugin's MCP server connects. A view that failed on exactly that at session start is retried
// after each wait in NOT_CONNECTED_RETRY_MS (on the clock, so a test moves it) and then left as the error.
async function retryWhileNotConnected($: any): Promise<void> {
  for (const wait of NOT_CONNECTED_RETRY_MS) {
    try {
      await $.clock.sleep(wait)
    } catch {
      // the wait rejects when the plugin's environment is unloaded (a reload): the retries end with it
      return
    }
    const cur = await read($, view)
    if (cur.phase !== 'unreachable') return
    await refresh($, true)
  }
  // the retries ran out: the reason is told once, here (applyLoaded stays quiet while a retry may still connect)
  const last = await read($, view)
  if (last.phase === 'unreachable') $.ui.toast(`Plan load failed: ${last.error}`.slice(0, TOAST_ERROR_MAX))
}

// v0.10.0 pinned a status line; the footer is the PLAN-NN button alone, so unpin anything an older loaded version left.
async function unpinStatus($: any): Promise<void> {
  await $.ui.status(undefined)
}

function errMessage(err: any): string {
  return String(err?.message ?? err)
}

async function noteTranscript($: any, e: any): Promise<void> {
  const path = typeof e.transcript_path === 'string' ? e.transcript_path : ''
  if (path !== '') await update($, transcript, cur => (cur === path ? cur : path))
}

// What the session's usage reading came to: its windows, or why they could not be read (the tick reads them itself).
type UsageReading = { limits: readonly SessionRateLimit[] } | { error: string }

// THE signed-in test for the relay and the usage report: a loaded view (ready), or a refresh of a connected session (loading with the
// plan still set: a refresh runs at every turn end, as session.measure fires). Signed-out and revoked views, an unloaded one and an error say no.
const isSignedIn = (v: any): boolean => v.phase === 'ready' || (v.phase === 'loading' && v.connected !== null)

// THE test for 50 Arms talking to the model about its work: signed in AND holding its team agent. The mantra's owing (applyLoaded) and every record/card
// reminder (the sub-agent and side-session reminders, the handoff and no-recent-write ones) ask it, so a session that is not signed in hears only the sign-in invitation.
const isSignedInWithAgent = (v: any): boolean => v.phase === 'ready' && v.agentBlock === null
const signedInWithAgent = async ($: any): Promise<boolean> => isSignedInWithAgent(await read($, view))

// send this session's rate-limit windows to 50 Arms. Every signed-in session reports, on a plan or not
// (50 Arms places the session on an account from this report, then paces and resumes it); a session that is not signed in reports nothing and
// toasts nothing. The whole agent tree's burn is in the session's own figure, so there is one report per session and none per sub-agent. The
// report says when the figure was MEASURED (the last API response, `measuredAt`): a session that is only ticking re-sends a frozen figure, and 50 Arms must tell it from one that is working.
// A failed reading, a failed report or a failure of the plugin's own state is a toast, never a hook that threw and was skipped silently: toasted
// once per distinct text (`usageError`), cleared when a report is accepted again or there is nothing to report.
async function reportUsage($: any, reading: UsageReading): Promise<void> {
  try {
    // only a signed-in session (isSignedIn) reports; a signed-out, revoked, lapsed or unloaded view sends and says nothing
    if (!isSignedIn(await read($, view))) return
    let failure: string | null = null
    try {
      // `{error}` is the session's own usage reading failing (the tick read it): the failure is toasted like any other
      if ('error' in reading) failure = reading.error
      else {
        const now = await $.clock.now()
        const body = usageBody(reading.limits, now, await read($, measuredAt), await $.env.get('CLAUDE_CODE_ACCOUNT_UUID'))
        if (body !== null) {
          const r = await api($, 'PUT', USAGE_PATH, { body })
          if (r.unreachable) return
          if (!r.ok) failure = errText(r)
          else {
            const every = r.body?.report_every_ms
            if (!Number.isInteger(every) || every < MIN_USAGE_TICK_MS) failure = `the answer named no usable report_every_ms (${JSON.stringify(every)})`
            else if (every !== usageEveryMs) startUsageTicker($, every)
          }
        }
      }
    } catch (err: any) {
      failure = errMessage(err)
    }
    failure = failure === null ? null : failure.slice(0, TOAST_ERROR_MAX)
    if (failure === (await read($, usageError))) return
    await update($, usageError, () => failure)
    if (failure !== null) $.ui.toast(`Usage not reported to 50 Arms: ${failure}`)
  } catch (err: any) {
    // only reading or writing the plugin's own state can land here: nothing is left to report it through but the toast
    $.ui.toast(`Usage not reported to 50 Arms: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`)
  }
}

// The clock tick's (and the first) report: what `$.session.usage()` says now, never an earlier event's figure. A reading that fails is
// toasted by the report for a signed-in session.
async function reportUsageNow($: any): Promise<void> {
  let reading: UsageReading
  try {
    reading = { limits: (await $.session.usage()).rateLimits }
  } catch (err: any) {
    reading = { error: errMessage(err) }
  }
  return reportUsage($, reading)
}

// reads the account verdict into the pacing cache at session start (the spawn guard and the sub-agent line read it); a throw here is
// toasted, never an unhandled rejection.
async function primePacing($: any): Promise<void> {
  try {
    await refreshPacing(pacingEnv($), true)
  } catch (err: any) {
    $.ui.toast(`Usage pacing could not refresh: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`)
  }
}

// 50 Arms says how often to report in every answer (its expiry is derived from that cadence), so the plugin carries only a first guess
// (USAGE_TICK_MS) and takes the server's value as soon as one answer arrives.
let usageEveryMs = USAGE_TICK_MS
function startUsageTicker($: any, everyMs: number): void {
  usageTicker?.cancel()
  usageEveryMs = everyMs
  usageTicker = $.clock.every(everyMs, () => reportUsageNow($))
}

// An API response arrived: the figure the harness holds is current as of now. Called when `session.measure` fires (after every main-thread
// turn and whenever a window moves) and when a sub-agent finishes (its burn moves the parent's figure), never from the tick.
async function markMeasured($: any): Promise<void> {
  const now = await $.clock.now()
  await update($, measuredAt, cur => (cur === null || now > cur ? now : cur))
}

// A window moved (or a turn ended): the event carries the windows as the harness has them.
async function onMeasure($: any, e: any, next: any) {
  await markMeasured($)
  // a measure that does not carry `rateLimits` says nothing about the windows: the last values stand (an empty array is the harness saying
  // there are none, and clears them)
  if (Array.isArray(e.rateLimits)) {
    void reportUsage($, { limits: e.rateLimits })
  }
  return next(e)
}

// ---- the plan event relay -------------------------------------------------------------------------------------------------
// The module's own loop on the session's dashboard MCP server's `plan_events_wait` tool (the in-process event relay): the
// server keeps the dashboard's stream open and answers each call with the events after the cursor (or none, when the wait ends);
// each event is handed to the session and the cursor of each delivered record stored. Nothing is spawned and no file is written: the
// loop is this module's code, so it lives as long as the process, through /clear and compaction, and ends with it. The server
// heartbeats the dashboard only while calls keep coming, so a dead or unloaded module reads as not healthy there.

// Which relay to run, from the view the last refresh read: the connected plan's, or the session's own (plan_id null) when signed in on no plan; none
// when signed out or revoked.
// A view that failed to load (`unreachable`, `load-failed`, `loading`) changes nothing: a read blip must not stop a working relay.
async function syncRelay($: any): Promise<void> {
  const v = await read($, view)
  // a blocked load says nothing of the key: the relay runs on, or is started by the watch, never stopped by it
  if (v.phase === 'unreachable' || v.phase === 'load-failed' || v.phase === 'blocked' || (v.phase === 'loading' && v.connected === null)) return
  // a ready view on no plan runs the relay for the session's own records (plan_id null); any other view (signed out, revoked) runs none
  if (!isSignedIn(v)) {
    relayHalted = null
    stopRelay()
    await stopKeepalive($)
    return
  }
  startRelay($, v.connected?.id ?? null)
}

// THE start of the relay, from a plan id however it was learned (the view, a session_connect answer, the light plan read). Never async:
// the check that no loop runs for this plan and the registration of the new one are one step, so two starts landing together make one loop.
function startRelay($: any, planId: number | null): void {
  // the keepalive follows the plan connection, not the relay's health: a halted or ended relay does not end it.
  // it stays plan-only; a move to no plan ends it.
  if (planId === null) detach($, 'Plan tab keepalive stop', stopKeepalive($))
  else followPlan($, planId)
  if (relayRun !== null && relayRun.planId === planId) return
  // a halt belongs to the plan it happened on: any other plan starts a relay of its own
  if (relayHalted !== null && relayHalted.planId !== planId) relayHalted = null
  if (relayHalted !== null) return
  stopRelay()
  // what is still waiting for delivery stays for a run of the same plan (it polls on from there); another plan's events are dropped, and so is
  // the failure being retried when its event was one of them (the new plan's band must not keep the old plan's cause)
  const head = outbox[0]
  outbox = onlyPlan(outbox, planId)
  if (outbox[0] !== head) outboxFailure = null
  // every start of a run (a stall restart, a replacing session_connect, a plan move) starts the refusal backoff afresh: earlier refusals do not lengthen the new run's first wait
  outboxRefusals = 0
  const run: RelayRun = { planId, dead: false, told: null, lacking: null, beat: 0 }
  relayRun = run
  if (stallTicker === null) stallTicker = $.clock.every(RELAY_STALL_CHECK_MS, () => detach($, 'Plan event relay stall check', checkRelayStall($)))
  detach($, 'Plan event relay', relayLoop($, run))
}

// starts the relay (the plan's, or the session's own on no plan) when no loop runs, whatever became of the plan load: from the view when it knows the plan,
// else from a light read of the session's own plan binding (the view is an error or still loading, and its error is not a reason for no relay).
// `retry`: the read itself failed (the server not connected yet, a session not bound, a dashboard fault), so the plan is not known yet.
type RelayWatch = 'done' | 'retry'

// at most one watch runs; a burst of triggers (sub-agent events while the dashboard is down) shares its answer instead of each issuing a
// plan read. A handle, so a module variable.
let relayWatching: Promise<RelayWatch> | null = null
// A failure of the watch itself is toasted ONCE here (detach), however many callers share it, and answers `retry` to all of them.
function watchRelay($: any): Promise<RelayWatch> {
  if (relayWatching === null) {
    const watch = watchRelayOnce($)
    detach($, 'Plan event relay watch', watch)
    relayWatching = watch
      .catch((): RelayWatch => 'retry')
      .finally(() => {
        relayWatching = null
      })
  }
  return relayWatching
}

async function watchRelayOnce($: any): Promise<RelayWatch> {
  if (relayRun !== null) return 'done'
  const v = await read($, view)
  if (v.connected !== null) {
    startRelay($, v.connected.id)
    return 'done'
  }
  // a loaded view on no plan runs the session's own relay; the signed-out ones say what the read would
  if (v.phase === 'ready') {
    startRelay($, null)
    return 'done'
  }
  if (v.phase !== 'unreachable' && v.phase !== 'load-failed' && v.phase !== 'blocked' && v.phase !== 'loading') return 'done'
  const plan = await withinDeadline($, RELAY_READ_DEADLINE_MS, sessionPlan($), (): SessionPlan => ({ kind: 'failed', reason: DEADLINE_REASON }))
  // a run that started while the read was out is the newer word (a connect, a load)
  if (relayRun !== null) return 'done'
  if (plan.kind === 'connected') {
    startRelay($, plan.planId)
    // the read that was refused now succeeds: the blocked view is replaced by a real load, never left standing
    if (v.phase === 'blocked') detach($, 'Plan refresh', refresh($, true))
    return 'done'
  }
  if (plan.kind === 'failed' && plan.refusal !== undefined) await tellRefusal($, plan.refusal)
  return plan.kind === 'failed' || plan.kind === 'unreachable' ? 'retry' : 'done'
}

// the relay cannot start yet because the engine's auto mode classifier refused the plugin's own read: told to the session ONCE (the same
// words are not told again while the watch keeps retrying, as the refusal may clear), with the engine's words and the fix that works. A module
// variable: the text is per process, and a reload starts with nothing told.
let refusalTold: string | null = null
async function tellRefusal($: any, refusal: Refusal): Promise<void> {
  const line = refusedLine(refusal.detail, refusal.fix)
  if (refusalTold === line) return
  refusalTold = line
  await tellModel($, line)
}

// the session start's watch: the read is retried after each wait of RELAY_START_RETRY_MS while it fails; what is left after that is the
// watchdog (a turn's end, a sub-agent's start or stop) and the views' own loads.
async function startRelayWhenKnown($: any): Promise<void> {
  for (const wait of [0, ...RELAY_START_RETRY_MS]) {
    try {
      if (wait > 0) await $.clock.sleep(wait)
    } catch {
      // the wait rejects when the plugin's environment is unloaded (a reload): the watch ends with it
      return
    }
    if ((await watchRelay($)) === 'done') return
  }
}

// Ends the loop: its pending call is left to the server (a newer wait supersedes it, or it times out), and everything it answers late is
// ignored (relay state, cursor and delivery are each gated on `dead`). It leaves the relay state as it was: the events warning names that state
// only for the plan it belongs to, and the next run of that plan writes its own first.
function stopRelay(): void {
  if (relayRun === null) return
  relayRun.dead = true
  relayRun = null
}

// the plan-tab keepalive (relay/keepalive.ts says why), for desktop sessions only: the 1800 s timeout is the desktop app's preview pane and
// a terminal session has no plan tab. "The desktop hosts this session" is sticky (`desktopHosted`): the app starts the session itself (surfaces() has
// 'desktop' at session.start, whose own `surface` is null), detaches about 5 s later and attaches again only while the person views it, so the
// surfaces at fire time say nothing. Raised at session.start by CLAUDE_CODE_ENTRYPOINT=claude-desktop (covers a resumed session nobody has
// viewed, whose surfaces() is []) or by surfaces() having 'desktop', and by any session.attach of the desktop; kept by a reload of the module
// ($.state, not a module variable). It follows the plan CONNECTION (`keepalivePlan`),
// set by startRelay and cleared when the plan is disconnected or the process ends, not the relay loop's health.
// One pending `$.clock.after` timer at a time, a slice of the wait (a handle, so module variables). An idle period starts at relay start and at every main-loop turn end
// (armKeepalive), and is recorded in `idleSince` ($.state) so a reload resumes it instead of restarting it; a turn start (which also clears
// `idleSince`), a plan move or the plan's end cancels it (cancelKeepalive). `keepaliveEpoch` makes a cancel reach an attempt already running:
// whatever it finds afterwards is dropped, nothing is sent or scheduled for a period that is over.
// the timer is never the whole wait. `$.clock.after` is a relative setTimeout, which does not count the time the computer sleeps, while
// `$.clock.now()` is the wall clock, which does (relay/keepalive.ts). Every wait is a slice of at most KEEPALIVE_WAKE_CHECK_MS, and the wall
// clock decides whether the attempt is due (`dueAt`, epoch ms), so a wake is noticed within a slice. A turn that starts after the wake finds
// the period stale (`idleSince` is a wall-clock time too) and has the session re-check the tab (recheckTab).
let keepalivePlan: number | null = null
let keepaliveTimer: { cancel: () => void } | null = null
let keepaliveEpoch = 0

function cancelKeepalive(): void {
  keepaliveEpoch++
  keepaliveTimer?.cancel()
  keepaliveTimer = null
}

async function stopKeepalive($: any): Promise<void> {
  keepalivePlan = null
  cancelKeepalive()
  await update($, idleSince, () => null)
}

// A fresh module (a load, a reload) that finds the plan arms from the period in `idleSince`; a move from one plan to another starts a period.
function followPlan($: any, planId: number): void {
  if (keepalivePlan === planId) return
  const resume = keepalivePlan === null
  keepalivePlan = planId
  detach($, 'Plan tab keepalive arm', armKeepalive($, resume))
}

// Starts the idle period: now, or (`resume`) the one in `idleSince` when there is one, whose attempt is due at once when its 25 minutes are past.
async function armKeepalive($: any, resume: boolean): Promise<void> {
  cancelKeepalive()
  if (keepalivePlan === null) return
  const epoch = keepaliveEpoch
  // a turn running now (a reload found it) arms nothing: its end does
  if ((await read($, turn)).isRunning) return
  const now = await $.clock.now()
  const since = (resume ? await read($, idleSince) : null) ?? now
  await startPeriod($, epoch, since, now)
}

// `since`: when the period began (its attempt is due KEEPALIVE_IDLE_MS on); `now`: the wall clock as the caller read it.
// A cancel while the write ran drops the period.
async function startPeriod($: any, epoch: number, since: number, now: number): Promise<void> {
  if (epoch !== keepaliveEpoch) return
  await update($, idleSince, () => since)
  if (epoch === keepaliveEpoch) waitSlice($, { epoch, dueAt: since + KEEPALIVE_IDLE_MS, deadline: null }, now)
}

// What the wait for one attempt holds: the epoch it belongs to, the wall-clock time the attempt is due (epoch ms), and the last time an attempt
// of this period may start (null until the first attempt starts, which sets it).
type KeepaliveWait = { epoch: number; dueAt: number; deadline: number | null }

// One slice of the wait: at most KEEPALIVE_WAKE_CHECK_MS, after which the wall clock is read again.
function waitSlice($: any, wait: KeepaliveWait, now: number): void {
  const slice = Math.min(KEEPALIVE_WAKE_CHECK_MS, Math.max(0, wait.dueAt - now))
  keepaliveTimer = $.clock.after(slice, () => detach($, 'Plan tab keepalive', keepaliveWake($, wait)))
}

async function keepaliveWake($: any, wait: KeepaliveWait): Promise<void> {
  keepaliveTimer = null
  const now = await $.clock.now()
  if (wait.epoch !== keepaliveEpoch) return
  if (now < wait.dueAt) return waitSlice($, wait, now)
  // an attempt that is long overdue (the computer slept through its time) has the retry window of its own, from when it starts: the network is
  // often still down just after a wake, and a window measured from the period's start would have closed hours ago
  const deadline = wait.deadline ?? (now - wait.dueAt > KEEPALIVE_WAKE_CHECK_MS ? now : wait.dueAt) + KEEPALIVE_RETRY_WINDOW_MS
  await keepaliveAttempt($, wait.epoch, deadline)
}

// whether the session is in an unexpired agent pause (reports/pause.ts), by the one read that does not end it. Signed out, revoked, or
// on no plan: `nothing` (the caller has nothing to check either). A dashboard without the route (404) is free too, told once, never silently. Any other
// failure is returned, and the Stop check allows the stop.
async function readAgentPause($: any): Promise<PauseRead> {
  const r = await api($, 'GET', PAUSE_PATH)
  if (isNothingToCheck(r)) return { kind: 'nothing' }
  // a session that has made no dashboard call yet is not registered: it has no pause, and this is not an older dashboard
  if (r.status === 404 && isUnregisteredSession(r.body)) return { kind: 'free' }
  if (r.status === 404) {
    let first = false
    await update($, olderDashboardTold, cur => {
      first = !cur
      return true
    })
    if (first) $.ui.toast(OLDER_DASHBOARD_LINE)
    return { kind: 'free' }
  }
  if (!r.ok) return { kind: 'failed', reason: errText(r) }
  return pauseOf(r.body, await $.clock.now())
}

// What an attempt came to: the pane holds the plan page's tab (it was there, or has been opened again), the session is not on the desktop (nothing to
// keep open), the desktop has no Browser pane server in this session (nothing to look at), or why it failed.
type Fired = { kind: 'checked' } | { kind: 'not-desktop' } | { kind: 'no-browser' } | { kind: 'failed'; why: string }

// One attempt: look at the pane, then decide what comes next. A failure is toasted and retried KEEPALIVE_RETRY_MS later until `deadline`
// (KEEPALIVE_GIVE_UP_MS after the period began, or the end of the retry window of an attempt that woke late), then it gives up, loudly, and starts the next period.
// a look costs no model turn. A session whose tab is held (or opened again) is looked at again an idle period on, the cadence the keepalive
// always had, so a tab the person closes on purpose is not reopened more often than it was; so is a session that is not on the desktop at this
// moment (it may attach later; the surface is read now, not at session start) or has no Browser pane server (the app may add it later; it was told once).
async function keepaliveAttempt($: any, epoch: number, deadline: number): Promise<void> {
  const fired = await fireKeepalive($, () => epoch === keepaliveEpoch)
  const endedAt = await $.clock.now()
  // a cancel (a turn began, the plan ended or moved) while the attempt ran: whatever it found is dropped, nothing is toasted or scheduled
  if (epoch !== keepaliveEpoch) return
  if (fired.kind === 'checked' || fired.kind === 'not-desktop' || fired.kind === 'no-browser') return startPeriod($, epoch, endedAt, endedAt)
  if (endedAt + KEEPALIVE_RETRY_MS > deadline) {
    $.ui.toast(`Plan tab keepalive gave up: ${fired.why}`.slice(0, TOAST_ERROR_MAX))
    // a give-up ends this period only; the next is started here, not left to a turn end that an idle session never has
    return startPeriod($, epoch, endedAt, endedAt)
  }
  $.ui.toast(`Plan tab keepalive failed, trying again: ${fired.why}`.slice(0, TOAST_ERROR_MAX))
  waitSlice($, { epoch, dueAt: endedAt + KEEPALIVE_RETRY_MS, deadline }, endedAt)
}

// one call to the Browser pane's server, through the engine's own connection (relay/browser.ts says why a hook can). null: the session has no
// such server (the engine's own words); a rejection otherwise (a refused or timed-out call) is the caller's failure.
async function browserCall($: any, tool: BrowserTool, args: Record<string, unknown>): Promise<BrowserResult | null> {
  try {
    return (await $.mcp.call(BROWSER_SERVER, tool, args)) as BrowserResult
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/no connected MCP tool/.test(message)) return null
    // auto mode refusing the pane's tool is told in a sentence, not the engine's raw text
    if (classifierRefusal(message) !== null) throw new Error(`${tool}: auto mode refused the call to the Browser pane; allow its tools in /permissions`)
    throw new Error(`${tool}: ${message}`)
  }
}

// a desktop-hosted, plan-connected session whose tool list has no callable Browser pane is never kept alive, and nothing else would say so:
// told once per session, in words that name the consequence. No prompt stands in for the pane (it could not tell whether the tab is missing, so it
// would ask every idle period again).
async function noBrowser($: any): Promise<Fired> {
  let first = false
  await update($, browserMissingTold, cur => {
    first = !cur
    return true
  })
  if (first) $.ui.toast(BROWSER_MISSING_LINE)
  return { kind: 'no-browser' }
}

// Looks at the Browser pane and opens the plan page's tab again when it is missing, with no model turn. `isLive` is checked again before
// the pane is changed. A closed pane is opened by `navigate` itself; an open pane without the tab gets a background tab of its own, so a page the
// person is reading is never navigated away.
async function fireKeepalive($: any, isLive: () => boolean): Promise<Fired> {
  let fired: Fired
  try {
    fired = await lookAtPane($, isLive)
  } catch (error) {
    fired = { kind: 'failed', why: error instanceof Error ? error.message : String(error) }
  }
  return fired
}

async function lookAtPane($: any, isLive: () => boolean): Promise<Fired> {
  if (!(await read($, desktopHosted))) return { kind: 'not-desktop' }
  const plan = (await read($, view)).connected
  // the page named is the one the view holds: a move is followed by a view refresh at once, and the arm that came with the move restarts the period
  if (plan === null) return { kind: 'failed', why: 'the connected plan is not loaded' }
  const page = planUrl(plan)
  try {
    const looked = await browserCall($, 'tabs_context', {})
    if (looked === null) return noBrowser($)
    const pane = paneState(looked)
    if (pane.kind === 'unreadable') return { kind: 'failed', why: pane.why }
    if (pane.kind === 'open' && holdsPlanTab(pane, page)) return { kind: 'checked' }
    if (!isLive()) return { kind: 'checked' }
    let tabId: string | undefined
    if (pane.kind === 'open') {
      const created = await browserCall($, 'tabs_create', {})
      if (created === null) return noBrowser($)
      const failure = failureOf('tabs_create', created)
      if (failure !== null) return { kind: 'failed', why: failure }
      const made = createdTab(created)
      if (made.kind === 'refused') return { kind: 'failed', why: made.why }
      tabId = made.tabId
    }
    const opened = await browserCall($, 'navigate', tabId === undefined ? { url: page } : { url: page, tabId })
    if (opened === null) return noBrowser($)
    const failure = failureOf('navigate', opened)
    return failure === null ? { kind: 'checked' } : { kind: 'failed', why: failure }
  } catch (error) {
    return { kind: 'failed', why: error instanceof Error ? error.message : String(error) }
  }
}

// a turn began after the app has closed the tab (an idle period older than the app's timeout that no attempt answered: the computer
// slept through it and the wake check did not run first). The turn's own end starts the next period, 25 minutes on, so the pane is looked at now
// and the plan page opened again if its tab is missing (no prompt). It follows the plan connection, not the keepalive epoch: the turn's own end
// restarts the period (bumping the epoch) and must not drop it.
async function recheckTab($: any): Promise<void> {
  const plan = keepalivePlan
  const fired = await fireKeepalive($, () => keepalivePlan === plan)
  if (keepalivePlan !== plan || fired.kind !== 'failed') return
  $.ui.toast(`Plan tab re-check failed: ${fired.why}`.slice(0, TOAST_ERROR_MAX))
}

// THE gate for what an ended run (a move to another plan, the process's end) may say: its relay state, the halt that follows from
// it and the line told to the model all come after this write, which does not happen for a dead run (false). The new run owns the state.
async function setRelay($: any, run: RelayRun, phase: RelayState['phase'], detail: string | null): Promise<boolean> {
  if (run.dead) return false
  let changed = false
  await update($, relay, cur => {
    changed = !(cur.phase === phase && cur.detail === detail && cur.planId === run.planId)
    return changed ? { phase, planId: run.planId, detail } : cur
  })
  // the events warning follows the relay's state (a write path, never the draw)
  await noteEventsWarning($)
  // so does the title's connection mark (a stopped relay is a lost connection), on a change only: the relay writes its state every round
  if (changed) detach($, 'The session title mark', syncTitleMark($))
  return true
}

// One failure, stored as the events warning, toasted and told to the session ONCE (the same text is not told again until a wait succeeds).
// `stopped` also halts the relay for this plan until something asks for it again (syncRelay).
async function relayFailed($: any, run: RelayRun, phase: 'retrying' | 'stopped', detail: string, line: string): Promise<void> {
  if (!(await setRelay($, run, phase, detail))) return
  if (phase === 'stopped') relayHalted = { planId: run.planId }
  if (run.told === line) return
  run.told = line
  await tellModel($, line)
}

// An error nothing anticipated stopped the run (the loop's own, or the pump's cursor store): shown in the band and told once.
async function haltRelay($: any, run: RelayRun, err: any): Promise<void> {
  const detail = `the relay hit an error: ${errMessage(err)}`
  await relayFailed($, run, 'stopped', RELAY_ERROR_FIX, stoppedLine(detail, RELAY_ERROR_FIX))
}

async function loadCursor($: any, planId: number | null): Promise<string | null> {
  return cursorFor(await storeOp($, { op: 'get', key: cursorKey(await $.session.id()) }), planId)
}

// The cursor is stored AFTER the event was delivered, under the session id as it is now (a /clear or a resume changes it).
// an event of a plan the session has since left must not write over the new plan's cursor. A delivery outlives the run that polled
// it (a run replaced while its prompt waited), so the gate is the plan the live run serves, not the run that took the event.
async function saveCursor($: any, planId: number | null, cursor: string): Promise<void> {
  if (relayRun === null || relayRun.planId !== planId) return
  await storeOp($, { op: 'set', key: cursorKey(await $.session.id()), value: { planId, cursor, at: await $.clock.now() } })
}

// The store keeps one record per session ever held: the oldest past CURSOR_KEEP go.
async function pruneCursors($: any): Promise<void> {
  const entries: { key: string; at: number }[] = []
  for (const key of await storeOp($, { op: 'keys' })) {
    if (!key.startsWith(CURSOR_PREFIX)) continue
    const rec: any = await storeOp($, { op: 'get', key })
    entries.push({ key, at: typeof rec?.at === 'number' ? rec.at : 0 })
  }
  for (const key of staleCursorKeys(entries)) await storeOp($, { op: 'delete', key })
}

// A prompt that wakes an idle session (or queues behind the running turn). Null when it entered, else why it did not.
async function submitEvent($: any, line: string): Promise<string | null> {
  try {
    const r = await $.prompt.submit({ text: line })
    return typeof r?.drop === 'string' ? notTakenLine(r.drop) : null
  } catch (err: any) {
    return notTakenLine(errMessage(err))
  }
}

// A note the model reads in the turn that is running. A refused or throwing append is a failure like any other (no silent fallback to
// a prompt): the event is not delivered: it is put back and issued again after the backoff (its cursor was stored when the call was made, so the re-issue stores none).
async function appendNote($: any, line: string): Promise<string | null> {
  try {
    const r = await $.session.append(modelRow(line))
    return typeof r?.deny === 'string' ? notTakenLine(r.deny) : null
  } catch (err: any) {
    return notTakenLine(errMessage(err))
  }
}

// One event into the session, the same `[50 Arms plan event] ...` text as ever, by the one decision in relay/delivery.ts: a non-urgent
// event is a prompt (queued behind a running turn, waking an idle session); an urgent one is a note in a running turn.
// resolves as soon as the engine call has been MADE; `done` settles with the outcome, null when delivered, else the cause. A plugin's
// `$.prompt.submit` settles only when the queued prompt enters the session (after the running turn), so a caller that must not wait for that (the
// relay's pump, relay/outbox.ts) issues the next event while `done` is still out, and a caller that must (deliverEvent) awaits it.
async function issueEvent($: any, text: string, urgent: boolean): Promise<{ done: Promise<string | null> }> {
  if (deliveryMode(urgent, (await read($, turn)).isRunning) === 'prompt') return { done: submitEvent($, relayLine(text)) }
  return { done: appendTrackedNote($, text) }
}

// A note into the running turn, and the turn atom told of it (noteAppended): a turn that ends with no tool result after the note tells it once as a prompt
// (promptNotes), so no note is stranded. The one place a note is appended for an event (issueEvent, and the resume briefing of a turn that began during its reads).
async function appendTrackedNote($: any, text: string): Promise<string | null> {
  const failure = await appendNote($, relayLine(text))
  if (failure !== null) return failure
  // the note is in the turn from here: a bookkeeping failure after it is a toast, never a failed delivery (a retry would append the note again)
  try {
    // `prompt` is set inside the updater, which sees the turn as it is when the write happens
    let prompt = null as string | null
    await update($, turn, cur => {
      const appended = noteAppended(cur, text)
      prompt = appended.prompt
      return appended.turn
    })
    if (prompt !== null) detach($, 'Telling the session', promptNotes($, [prompt]))
  } catch (err: any) {
    $.ui.toast(`Plan event delivered, but the turn's record failed: ${errMessage(err)}`.slice(0, TOAST_ERROR_MAX))
  }
  return null
}

// One event delivered, awaited: null when delivered, else the cause.
async function deliverEvent($: any, text: string, urgent: boolean): Promise<string | null> {
  return (await issueEvent($, text, urgent)).done
}

// notes nothing will read (the turn ended after them, with no tool result between), each told once more as a prompt that says it is a
// repeat, in order; every note is tried even when an earlier one was refused. Detached from the hook or delivery that found them: a prompt
// the session did not take is a toast.
async function promptNotes($: any, texts: string[]): Promise<void> {
  for (const text of texts) {
    const failure = await submitEvent($, repeatLine(text))
    if (failure !== null) $.ui.toast(`Plan events not told to the session: ${failure}`.slice(0, TOAST_ERROR_MAX))
  }
}

// the outbox (relay/outbox.ts says why the poll loop does not deliver). The records of one answer are queued in the order the server sent them
// and issued to the session strictly in that order (only the head of the outbox is issued), each as soon as the one before it has been ISSUED (a prompt queued
// behind a running turn is out, and must not hold the next event: an urgent note behind it is for the running turn). A refused event goes back to its place and
// holds the events behind it until its backoff ends: a refusal hits every event alike, so nothing is lost by waiting, and no event overtakes an earlier one.
// An event is DELIVERED when its engine call is made, not when the call's promise settles: the engine keeps a queued prompt across a reload (relay/outbox.ts),
// while the promise the old module instance awaited is lost with it (whether the promise of a prompt merged into a queued turn settles is not measured), so
// waiting for it re-sent the whole backlog at every reload. At the call the event's cursor is stored as the resume cursor (in order: events are issued in order)
// and the event leaves the outbox and the atom. The instance that made the call watches its outcome (`settleOutbox`): a refusal puts the event back and issues it
// again after the backoff, and the band says so. The poll acknowledges a taken event to the server (which then drops it), so every queued event is also written to the
// `relayOutbox` atom BEFORE the poll that carries its cursor, and removed from it once called for: a reload of this module (which empties `outbox`) finds
// the ones not yet called for there and issues them (`restoreOutbox`). Delivered means handed over, not acknowledged: the one window left is a reload between the
// engine call and the end of the atom write that follows the cursor store, where the event is repeated. An event that asks to be acknowledged (`acks`) is sent again by the dashboard until the session acknowledges it,
// which covers Claude Code exiting while the prompt is still queued; `ackInFlight` lets a re-send of one the session already holds be dropped while its turn runs (relay/outbox.ts).
// `queueEvents` and `restoreOutbox` are idempotent; `issueOutbox` is single-flight (whoever queues or starts a run calls it).
let outboxIssuing = false
// the cause of the delivery failure being retried, null when none: the poll's own success must not draw over it (handleAnswer)
let outboxFailure: string | null = null
// refusals seen in a row, one per refused event (a delivery that works resets it): the backoff of the next re-issue steps once per refusal, so a burst of
// refused events backs off faster than a lone one
let outboxRefusals = 0
// the last sequence number given to a queued event: the order the server sent them in, which a put-back event goes back to (relay/outbox.ts)
let outboxSeq = 0

async function queueEvents($: any, run: RelayRun, events: RelayEvent[]): Promise<void> {
  for (const event of events) outbox.push({ planId: run.planId, seq: ++outboxSeq, event, held: false })
  // the copy first: the next poll presents these cursors, and the server drops what they cover
  await persistOutbox($)
  detach($, 'Plan event delivery', issueOutbox($))
}

// The atom holds exactly what `outbox` holds; every change to `outbox` is followed by this write.
async function persistOutbox($: any): Promise<void> {
  // the snapshot is taken inside the update, so overlapping saves each write what `outbox` holds when they run, never an older copy
  await update($, relayOutbox, () => toPending(outbox))
}

// A run's start: a reloaded module has an empty outbox, so what the atom kept for this plan is the outbox again (another plan's events are dropped, as a
// move drops them). Then whatever waits is issued: the run that polls on from its newest cursor never asks the server for it again.
async function restoreOutbox($: any, run: RelayRun): Promise<void> {
  const saved = fromPending(await read($, relayOutbox), run.planId, outboxSeq + 1)
  if (outbox.length === 0) {
    outbox = saved
    outboxSeq += saved.length
  }
  await persistOutbox($)
  if (outbox.length > 0) detach($, 'Plan event delivery', issueOutbox($))
  detach($, 'Queued job', resumeQueueJob($))
}

// The delivered tail of the head event (issued, or dropped as a re-send): the cursor first, then the atom (a reload between the two repeats this event, where the other
// order would lose the resume point); a delivery that leaves no put-back event waiting ends the retrying state here, not only when its own outcome settles (a re-issued
// put-back may never settle).
async function markDelivered($: any, next: Queued): Promise<void> {
  if (next.again !== true) await saveCursor($, next.planId, next.event.cursor)
  const at = outbox.indexOf(next)
  if (at >= 0) outbox.splice(at, 1)
  await persistOutbox($)
  if (!outbox.some(q => q.again === true)) await clearRetrying($, next.planId)
}

async function issueOutbox($: any): Promise<void> {
  if (outboxIssuing) return
  outboxIssuing = true
  try {
    for (;;) {
      // strictly in order: only the head goes, and a head that waits out its backoff holds everything behind it
      const next = outbox[0]
      // no live run on that plan: the events wait for a run that serves it (startRelay starts this again)
      if (next === undefined || next.held || relayRun === null || relayRun.planId !== next.planId) return
      // a re-send of an event the session already holds, while its turn runs, is delivered in effect (its cursor moves, it leaves the outbox) but not issued again
      // (a record that asks for no acknowledgement, the common case, reads nothing and awaits nothing extra)
      const asks = next.event.acks.length > 0
      const resend = asks && shouldDropResend(next.event.acks, await read($, ackInFlight), (await read($, turn)).isRunning)
      if (resend) {
        if (outbox.includes(next)) await markDelivered($, next)
        continue
      }
      // a queued job offered to this session: the plugin takes it and tells the model only once its worktree is ready (ready/offer.ts); the record's own text,
      // which asks the model to take it, is never told. Delivered at once, so the take and the command never hold the events behind it
      const offer = next.event.offer
      if (offer !== null) {
        await markDelivered($, next)
        detach($, 'Queued job', takeQueueJob($, offer, next.event.urgent))
        continue
      }
      const issued = await issueEvent($, next.event.text, next.event.urgent)
      // the outcome gets its rejection handler at once, before anything awaits (the in-flight record and the cursor store below), so a rejection is never unhandled
      const outcome = issued.done.catch((err: any) => notTakenLine(errMessage(err)))
      if (asks) await update($, ackInFlight, cur => markInFlight(cur, next.event.acks))
      // a move to another plan dropped it while the call was made: it is no longer this module's to deliver
      if (!outbox.includes(next)) continue
      await markDelivered($, next)
      detach($, 'Plan event delivery', settleOutbox($, next, outcome))
    }
  } catch (err: any) {
    // the cursor store failing is the loop's own kind of error (an unexpected one): the relay stops for the plan, never restarted behind the person's back
    const run = relayRun
    if (run !== null) {
      await haltRelay($, run, err)
      stopRelay()
    }
  } finally {
    outboxIssuing = false
  }
}

// The retrying state of an outbox failure clears once no put-back event waits. A delivery's call does this too, not only its settle: a re-issued put-back
// whose submit never settles would otherwise hold the state for good. The band goes back to streaming only when the outbox had a failure to clear.
async function clearRetrying($: any, planId: number | null): Promise<void> {
  if (outboxFailure === null) return
  // events held by a Stop clear only when a delivery settles (settleOutbox): a re-issue the engine drops again would otherwise flip the state off and back
  // on at every retry, a toast each time
  if ((await read($, relay)).phase === 'held') return
  outboxFailure = null
  const live = relayRun !== null && relayRun.planId === planId ? relayRun : null
  if (live !== null) {
    live.told = null
    await setRelay($, live, 'streaming', null)
  }
}

// How a delivery that was called for ended, seen by the module instance that made the call (a reload loses this watch, and the engine's queue keeps
// the prompt). Delivered: the retrying state clears once no put-back event waits. Refused (`drop`, a throw, a refused note, a rejected call): the event goes back at its place in the original order
// (`seq`), in the outbox and the atom, is held for the backoff, and is issued again (only the head is ever issued, so nothing behind it goes first); its cursor was stored at the
// first call, so it stores none.
async function settleOutbox($: any, event: Queued, outcome: Promise<string | null>): Promise<void> {
  // `outcome` never rejects: issueOutbox turned a rejection into its failure line at the call
  const failure = await outcome
  const live = relayRun !== null && relayRun.planId === event.planId ? relayRun : null
  if (failure === null) {
    // a late success says nothing about an event that is still put back
    if (outbox.some(q => q.again === true)) return
    outboxRefusals = 0
    outboxFailure = null
    if (live !== null) {
      live.told = null
      await setRelay($, live, 'streaming', null)
    }
    return
  }
  // a run on another plan has left this event behind with its plan
  if (relayRun !== null && relayRun.planId !== event.planId) return
  outboxFailure = failure
  outboxRefusals++
  // the refused event never reached the session, so it is not an event the session holds
  if (event.event.acks.length > 0) await update($, ackInFlight, cur => clearInFlight(cur, event.event.acks.map(a => a.eventId)))
  const held: Queued = { ...event, again: true, held: true }
  putBack(outbox, held)
  await persistOutbox($)
  // a Stop holds every plugin prompt until the person sends a message: shown to the person once (toast and band), never told to the model, which
  // reads nothing until then and would get each repeat at once when it resumes
  if (live !== null && heldForInput(failure)) await setRelay($, live, 'held', HELD_FOR_INPUT_NOTICE)
  else if (live !== null) await relayFailed($, live, 'retrying', failure, delayedLine(failure))
  // a session held by a person's Stop can take no work, so it must not wait on the list
  if (heldForInput(failure) && (await read($, readyLoop)) !== null) await leaveReady($, READY_STOPPED)
  await $.clock.sleep(backoffMs(outboxRefusals))
  // a move to another plan dropped it while it waited
  if (!outbox.includes(held)) return
  held.held = false
  detach($, 'Plan event delivery', issueOutbox($))
}

// the stall watch, every RELAY_STALL_CHECK_MS. A loop that has made no step for RELAY_STALL_MS is awaiting a call that never settles (the poll,
// the cursor store, the plan read): nothing it could say reaches anyone, so the watch tells the person (a toast) and the session (a note, detached: the
// note's own call is one of the things that may be stuck), then starts the relay again. Events waiting in the outbox survive the restart (the outbox).
async function checkRelayStall($: any): Promise<void> {
  const run = relayRun
  const now = await $.clock.now()
  // the clock is the wall clock, which keeps running while the machine sleeps and the loop's call cannot answer: a tick that is itself far later than its
  // interval is the machine waking, and judging it would report a stall nobody had. The watch starts counting again from here.
  const woke = isLateTick(now, stallTickAt, RELAY_STALL_CHECK_MS)
  stallTickAt = now
  if (run === null) {
    stallSeen = null
    return
  }
  if (woke || stallSeen === null || stallSeen.run !== run) {
    stallSeen = { run, since: now }
    return
  }
  if (relayRun !== run || !isStalled(now, run.beat, stallSeen.since, RELAY_STALL_MS)) return
  const seconds = Math.round((now - Math.max(run.beat, stallSeen.since)) / 1000)
  stallSeen = null
  $.ui.toast(stalledNotice(seconds).slice(0, TOAST_ERROR_MAX))
  detach($, 'Telling the session', tellModel($, stalledLine(seconds)))
  stopRelay()
  startRelay($, run.planId)
}

// the engine words a tool the server lacks the same as a server that is not connected ("no connected MCP tool"), so that answer is told
// apart by the session's tool list: the plugin server's tools listed without the relay's is evidence of an old pinned server; none listed (the
// server is not connected yet or has gone), or a list that cannot be read (not bound), is none.
async function serverLacksRelayTool($: any): Promise<boolean> {
  let names: string[]
  try {
    names = (await $.tool.list()).map((t: any) => t.name)
  } catch {
    return false
  }
  const ownTools = names.filter(name => name.startsWith(toolName('')))
  return ownTools.length > 0 && !ownTools.includes(toolName(RELAY_TOOL))
}

// what the evidence (a failed wait with the plugin server's tools listed but not the relay's) comes to. It is proof only after
// OLD_SERVER_AFTER_FAILURES of them in a row spanning OLD_SERVER_AFTER_MS: with the backoff that is the 4th failure (3 counted, the 8 s passed). Then the
// dashboard is asked afresh, because the list is dynamic: it lags a sign-in or a grant, and shrinks to the bootstrap tools at a key loss.
//   null: no proof yet (too early, or the dashboard could not say): the run retries.
//   old-server: the session is signed in and still on this run's plan, and the server has no such tool.
//   signed-out: the session is signed out, or on another plan or none: this run has nothing to serve, so it ends the way the real signed-out
//   answer ends it (off, halted for this plan, nothing told) instead of retrying for good.
async function oldServerVerdict($: any, run: RelayRun): Promise<WaitAnswer | null> {
  const now = await $.clock.now()
  run.lacking = run.lacking === null ? { count: 1, since: now } : { count: run.lacking.count + 1, since: run.lacking.since }
  if (run.lacking.count < OLD_SERVER_AFTER_FAILURES || now - run.lacking.since < OLD_SERVER_AFTER_MS) return null
  const plan = await sessionPlan($)
  if (plan.kind === 'failed' || plan.kind === 'unreachable') return null
  // a run on no plan is still this run's while the session is on no plan
  const same = run.planId === null ? plan.kind === 'not-connected' : plan.kind === 'connected' && plan.planId === run.planId
  return same ? { kind: 'old-server' } : { kind: 'signed-out' }
}

async function waitForEvents($: any, run: RelayRun, cursor: string | null): Promise<WaitAnswer> {
  const path = await read($, transcript)
  try {
    const got = readWaitAnswer(await $.mcp.call(SERVER, RELAY_TOOL, waitArgs(run.planId, cursor, path)))
    run.lacking = null
    return got
  } catch (err: any) {
    const message = errMessage(err)
    const lacksTool = isServerNotConnected(message) && (await serverLacksRelayTool($))
    if (!lacksTool) {
      run.lacking = null
      return classifyText(message)
    }
    return (await oldServerVerdict($, run)) ?? classifyText(message)
  }
}

// What one answer to a wait asks of the loop: `again` (the next wait, at once), `retry` (the next wait after the backoff: the answer or its
// delivery failed) or `end` (signed out, or the server said it cannot go on). `cursor` is the loop's, moved by the events delivered.
type Handled = { next: 'again' | 'retry' | 'end'; cursor: string | null }

async function handleAnswer($: any, run: RelayRun, got: WaitAnswer, cursor: string | null, startedAt: number): Promise<Handled> {
  if (got.kind === 'events') {
    // an ended run takes nothing (its events are the new run's to ask for)
    if (run.dead) return { next: 'end', cursor }
    // the events are queued, never delivered here; the poll goes on at once from the newest cursor taken
    // a wait answered, so the calls are allowed again: a blocked view is replaced by a real load
    if ((await read($, view)).phase === 'blocked') detach($, 'Plan refresh', refresh($, true))
    await queueEvents($, run, got.events)
    const last = got.events[got.events.length - 1]
    // the refresh is detached: the environment going away under it is not a failure
    if (last !== undefined) detach($, 'Plan refresh', refresh($, true))
    // a delivery being retried keeps the band's retrying state: a poll that works says nothing about it
    if (outboxFailure === null) {
      run.told = null
      await setRelay($, run, 'streaming', null)
    }
    // a server that answers an empty list at once is not a wait: sleep the rest of the round
    const took = (await $.clock.now()) - startedAt
    if (last === undefined && took < MIN_ROUND_MS) await $.clock.sleep(MIN_ROUND_MS - took)
    return { next: 'again', cursor: last === undefined ? cursor : last.cursor }
  }
  if (got.kind === 'signed-out') {
    // the band already says it (and offer Sign in unless a person revoked the key): nothing more is told
    if (await setRelay($, run, 'off', null)) relayHalted = { planId: run.planId }
    return { next: 'end', cursor }
  }
  if (got.kind === 'refused') {
    // the person sees the sentence and fix; the session is told once with the engine's words. Retried on the backoff: it resumes once the calls are allowed.
    await relayFailed($, run, 'retrying', BLOCKED_LINE, refusedLine(got.detail, got.fix))
    return { next: 'retry', cursor }
  }
  if (got.kind === 'stopped' || got.kind === 'old-server') {
    const detail = got.kind === 'stopped' ? got.detail : OLD_SERVER_DETAIL
    const fix = got.kind === 'stopped' ? got.fix : OLD_SERVER_FIX
    await relayFailed($, run, 'stopped', fix, stoppedLine(detail, fix))
    return { next: 'end', cursor }
  }
  await relayFailed($, run, 'retrying', got.message, delayedLine(got.message))
  return { next: 'retry', cursor }
}

async function relayLoop($: any, run: RelayRun): Promise<void> {
  let failures = 0
  try {
    // the run's first word comes before any await of its own: until then the band would still show the state the last run of this plan left
    await setRelay($, run, 'streaming', null)
    await pruneCursors($)
    try {
      await restoreOutbox($, run)
    } catch (err: any) {
      // a queued event a previous plugin version kept has no acks list: a fault, never a default. The relay stops with the remedy.
      if (!(err instanceof StalePendingError)) throw err
      await relayFailed($, run, 'stopped', STALE_PENDING_FIX, stoppedLine(`${STALE_PENDING_DETAIL} (${err.message})`, STALE_PENDING_FIX))
      return
    }
    // on from the newest event still waiting in the outbox (a run replacing a stuck one, or a reloaded module), else from the stored cursor
    let cursor = pollCursor(outbox, run.planId, await loadCursor($, run.planId))
    let keyedBy = await $.session.id()
    // the loop ends with its run; what a late answer would say is gated in setRelay and handleAnswer
    while (!run.dead) {
      const startedAt = await $.clock.now()
      run.beat = startedAt
      const got = await waitForEvents($, run, cursor)
      // a /clear or a resume gives the process another session id: the stored cursor (the last DELIVERED event's, not the polled one) moves with it
      const sid = await $.session.id()
      if (sid !== keyedBy) {
        const stored = await storeOp($, { op: 'get', key: cursorKey(keyedBy) })
        keyedBy = sid
        const delivered = cursorFor(stored, run.planId)
        if (delivered !== null) await saveCursor($, run.planId, delivered)
      }
      const handled = await handleAnswer($, run, got, cursor, startedAt)
      cursor = handled.cursor
      if (handled.next === 'end') return
      if (handled.next === 'again') {
        failures = 0
        continue
      }
      failures++
      run.beat = await $.clock.now()
      await $.clock.sleep(backoffMs(failures))
    }
  } catch (err: any) {
    // An error nothing above anticipated halts the relay for this plan, stored as the events warning, toasted and told once, never restarted by a refresh
    // behind the person's back (an ended run says nothing: relayFailed's gate). When the environment itself is gone the writes below
    // reject, and settleDetached (the loop's caller) is what drops that one rejection.
    await haltRelay($, run, err)
  } finally {
    if (relayRun === run) relayRun = null
  }
}

// the desktop attached (it does so again each time the person views the session): it hosts this one from now on
async function onSessionAttach($: any, e: any, next: any) {
  if (e.surface === DESKTOP_SURFACE) await update($, desktopHosted, () => true)
  return next(e)
}

async function onSessionStart($: any, e: any, next: any) {
  // only ever raised here, never cleared. A reload of this module (the app's reload_plugins, paced to when the session is hidden) fires
  // session.start with the desktop detached (surfaces() is []); a flag set from that would forget the desktop hosts the session. `desktopHosted` is
  // $.state, which a reload keeps and a new process starts without.
  // the desktop app sets CLAUDE_CODE_ENTRYPOINT=claude-desktop on every process it spawns (fresh or resumed; a reload keeps the process and the atom); a terminal reads `cli`. A resumed
  // session nobody has viewed yet has no attach and a detached roster, so the environment is the source that names its host.
  if ((await $.session.surfaces()).includes(DESKTOP_SURFACE) || (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop') {
    await update($, desktopHosted, () => true)
  }
  // the id the session's MCP server boots under (a reload of this module keeps the first one, the atom survives it)
  const bootId = String(await $.session.id())
  await update($, bootEngineId, cur => cur ?? bootId)
  await unpinStatus($)
  // never a command named after one of the plugin's skills: the engine refuses it (`"/50arms:ready" refused: it is the plugin's /50arms:ready`),
  // and the throw ends this hook here, before the usage ticker and everything below it start. `/50arms:ready` is the skill's own command (onReadyCommand).
  await $.command.register({ name: COMMAND, description: 'Show the 50 Arms plan band (connection + cards that need you)' })
  // a new process or a reload cannot have a write in flight: no key claimed before it is still held
  await update($, busy, () => [])
  await update($, modelPlan, () => null)
  // nor a sign-in request: its watch died with the old process
  await update($, signInRequest, () => null)
  await update($, machineRegistration, () => null)
  // no plan polling timer (the relay's events, the turns and the sub-agents refresh the view).
  startUsageTicker($, USAGE_TICK_MS)
  // a reload starts with no compaction check: the sync below arms it again when the session is under the handshake (syncCompactionTicker)
  compactionTicker?.cancel()
  compactionTicker = null
  await syncCompaction($, { start: false })
  // a reload starts with no fast poll; requests still open in $.state need it again
  permissionTicker?.cancel()
  permissionTicker = null
  await syncPermissionPoll($)
  // a reload starts with no ready-list ticker; a session still in the loop needs it again, and no sign-in watch survives it
  stopReadyTicker()
  await update($, readyLoop, cur => (cur === null ? null : { ...cur, signInAsked: false }))
  if ((await read($, readyLoop)) !== null) startReadyTicker($)
  // a new session starts with no pacing state (never the previous session's last good answer) and reads the verdict now; later reads are a sub-agent start when the cache is a minute old, and every spawn
  resetPacing()
  dashboardAnswered = false
  detach($, 'Usage pacing', primePacing($))
  detach($, 'Foreground lock timeout', applyForegroundLockTimeout($))
  detach($, 'Plan refresh', refresh($, true).then(() => reportUsageNow($)).then(() => adoptThenAskReady($)).then(() => retryWhileNotConnected($)).then(() => adoptThenAskReady($)))
  // the relay does not wait for that load: it starts from the plan the session is on, and is looked for again while the read fails
  detach($, 'Plan event relay start', startRelayWhenKnown($))
  return next(e)
}

// At every session start, on Windows only, the live ForegroundLockTimeout is set to 0 (context/foreground.ts says why). Detached from the session start: the
// PowerShell start costs time. A refused or failed call is told to the model once per start, never ignored.
async function applyForegroundLockTimeout($: any): Promise<void> {
  const argv = foregroundLockArgv(hostKindOf({ SystemDrive: await $.env.get('SystemDrive'), WSL_DISTRO_NAME: await $.env.get('WSL_DISTRO_NAME') }))
  if (argv === null) return
  let verdict: ReturnType<typeof parseForegroundLockAnswer>
  try {
    const run = await $.process.run(argv, { timeoutMs: FOREGROUND_LOCK_TIMEOUT_MS })
    verdict = parseForegroundLockAnswer(run.exitCode, String(run.stdout), String(run.stderr))
  } catch (err: any) {
    verdict = { ok: false, reason: String(err?.message ?? err) }
  }
  if (!verdict.ok) await tellModel($, foregroundLockNotice(verdict.reason))
}

// Reasons after which the process is gone. `clear` and `resume` end THIS session but the process
// goes on, and no session.start follows a /clear: the timers and the relay must keep running then, or
// the band shows stale data and no event arrives for the rest of the process. Any reason not listed keeps them
// too: stopping a timer in a live process is the harm, a timer left in a dying one is not.
const PROCESS_ENDS = ['prompt_input_exit', 'logout', 'other']

// the session that ends frees the team agent it signed in as at once, instead of the dashboard freeing it when the session's liveness lapses (about a minute). Only when the
// process really ends (PROCESS_ENDS): a /clear or a /resume ends this session but the MCP carries on with the same session id and still needs its agent. Best effort and bounded (AGENT_RELEASE_DEADLINE_MS): a failure is one toast, never a held end. A
// session with no key (signed out, revoked) or none to free (the agent gate holds it: it never got one) asks nothing.
async function releaseAgent($: any): Promise<void> {
  const v: PlanView = await read($, view)
  if (v.phase === 'signed-out' || v.phase === 'key-revoked' || v.agentBlock !== null) return
  const r = await releaseAgentCall($)
  if (r.ok || releaseUnneeded(r)) return
  $.ui.toast(releaseFailureToast(errText(r)))
}

// The release of the session's team agent, bounded (AGENT_RELEASE_DEADLINE_MS): the session's end makes it.
function releaseAgentCall($: any): Promise<Api> {
  return withinDeadline($, AGENT_RELEASE_DEADLINE_MS, api($, 'DELETE', AGENT_RELEASE_PATH), (): Api => ({ ok: false, status: 0, body: { error: AGENT_RELEASE_TIMEOUT_REASON }, sentence: true }))
}

// The band's Revoke, bounded the same way: frees the agent and revokes the session's key, answering `{released, revoked: true}`.
function personDisconnectCall($: any): Promise<Api> {
  return withinDeadline($, AGENT_RELEASE_DEADLINE_MS, api($, 'POST', PERSON_DISCONNECT_PATH), (): Api => ({ ok: false, status: 0, body: { error: AGENT_RELEASE_TIMEOUT_REASON }, sentence: true }))
}

// A refused release that needs no word to the person: the session holds no key (the sign-in states say so) or holds no agent to free (the gate says so).
const releaseUnneeded = (r: Api): boolean => isSignedOut(r) || outcomeRevokedBy(r) !== null || agentBlockOf(r) !== null
// A refused Revoke with nothing left to end: the key is already gone (signed out, revoked). Unlike the release, an agent block is not one: the route is open to a session holding no agent.
const endUnneeded = (r: Api): boolean => isSignedOut(r) || outcomeRevokedBy(r) !== null

// Ends the sign-in watch that is running, if any: it stops at its next step, its request is no longer drawn, and its busy key is freed at once (the aborted watch's in-flight session_connect, up to ~45s, must not hold it).
async function abortSignInWatch($: any): Promise<void> {
  signInGeneration++
  await update($, signInRequest, () => null)
  await update($, busy, cur => cur.filter(k => k !== busyKey.signIn))
}

async function onSessionEnd($: any, e: any, next: any) {
  if (PROCESS_ENDS.includes(e.reason)) {
    await endOpenHolds($)
    await releaseAgent($)
  }
  if (e.reason === 'clear' && typeof e.sessionId === 'string') await update($, endedSession, () => e.sessionId)
  // the sign-in watch belongs to the conversation that started it
  if (PROCESS_ENDS.includes(e.reason) || e.reason === 'clear' || e.reason === 'resume') {
    await abortSignInWatch($)
    await abortRegistrationWatch($)
  }
  if (PROCESS_ENDS.includes(e.reason)) {
    // the relay ends with the process; a /clear or a resume goes on (its loop is module code, and the refresh the next
    // conversation's start makes, restoreCarried, restarts it only if that conversation is on another plan)
    stopRelay()
    await stopKeepalive($)
    usageTicker?.cancel()
    usageTicker = null
    stallTicker?.cancel()
    stallTicker = null
    stallTickAt = null
    compactionTicker?.cancel()
    compactionTicker = null
    permissionTicker?.cancel()
    permissionTicker = null
    stopReadyTicker()
  } else if (e.reason === 'clear' || e.reason === 'resume') {
    // another conversation: its sub-agents and transcript are not this one's
    // nor is the plan its model named
    await update($, modelPlan, () => null)
    await update($, transcript, () => null)
    await update($, runningAgents, () => [])
    // last, so what this hook wrote is carried with the rest (the new conversation's start refreshes the view, restoreCarried)
    await carryAcrossConversation($)
  }
  return next(e)
}

// ---- the ready list ----------------------------------------------------------------------------------------------------------------------------------------------
//
// `/50arms:ready` signs the session in and joins the team's list of ready agents for its folder's repo, and tells the model nothing: the join is the plugin's own. The server hands the session work; the model connects to it and works it.
// The dashboard keeps the session's ready loop: the job it took, and whether that job has ended, by its one rule. Once the job has ended the clear is a handshake, so a person still talking keeps the session: 50 Arms
// asks the model to wrap up (the ask reaches it through the MCP's urgent record, in 50 Arms' own words), the model says ready, and 50 Arms releases the clear (the row's `release_id`, read by the look at the end of that turn). This loop
// runs that /clear (Claude Code's own command, which a plugin may run once no turn is running) and marks the session ready again (`PUT /api/plan-sessions/me/ready`, which also leaves the ended job):
// the back of the list, with no context from the job. Every exit from the loop ends the dashboard's loop too (`DELETE /api/plan-sessions/me/ready`). A person's Stop takes the session off the list,
// since Claude Code drops the plugin's prompts until they send a message.
// A plugin's /clear changes `$.session.id()` and keeps the MCP server and the session id it booted with (measured, claude.exe 2.1.309), so the dashboard sees one session and its agent stays held.
// It also empties the plugin's whole $.state (measured, claude.exe 2.1.317): the loop is carried across every /clear, the released one and a person's own, with the rest of it (carryAcrossConversation).
let readyTicker: { cancel: () => void } | null = null
// a look's identity. `turns`: the count of main-loop turns started when the look began (or its own clear ended); a higher count now means the session may have moved (the model connects to work only in
// a turn), so the look acts on nothing it read before
type LookToken = { turns: number }
// the look in flight (`syncReady`): `token` is its identity, `at` when it started or its clear ended
let readySyncing: { token: LookToken; at: number; look: Promise<void> } | null = null
// a clear's commands wait on Claude Code, not the dashboard: no look takes over while one runs
let readyResetting = false
// main-loop turns started, counted for LookToken
let readyTurns = 0
// the loop's newest sign-in watch
let readyWatchId = 0
// the person was told that the session's MCP server is too old to bring a clear (READY_RELAY_OLDER): once per process
let readyRelayOlderTold = false
// the session id whose last look found its compaction file with no clear file beside it (`clearState`'s `olderSign`), or null: only a later look that finds the same tells
let readyRelayOlderSeen: string | null = null
// the last unreadable dashboard loop a new process was told it could not take up (adoptReadyMark), so the same fault is told once
let readyLoopFaultTold: string | null = null

function startReadyTicker($: any): void {
  if (readyTicker === null) readyTicker = $.clock.every(READY_TICK_MS, () => detach($, 'Ready list', syncReady($)))
}

function stopReadyTicker(): void {
  readyTicker?.cancel()
  readyTicker = null
}

async function onReadyCommand($: any, e: any) {
  return { text: await joinReady($, typeof e.args === 'string' ? e.args.trim() : '') }
}

// The agent's own way onto the list: loading the skill does what the command does, and the model is told the same line the person is.
async function onReadySkill($: any, e: any, next: any) {
  const ran = await next(e)
  // only the main session's own load joins: a sub-agent (agentId) that loads the skill is not the session on the list
  if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true || !READY_SKILL.test(String(e.skill))) return ran
  const text = await joinReady($, typeof e.args === 'string' ? e.args.trim() : '')
  return { ...ran, context: [...(ran.context ?? []), text] }
}

// What the command and the skill share: `off` leaves, nothing joins, anything else is the usage line. Returns the words that answer it.
async function joinReady($: any, arg: string): Promise<string> {
  if (arg === 'off') {
    detach($, 'Ready list', leaveReady($, null))
    return READY_OFF
  }
  if (arg !== '') return READY_USAGE
  // running it again starts the told-once memory afresh and keeps the rest: the phase the session is in, and an approval still open
  await update($, readyLoop, cur => (cur === null ? joiningLoop() : { ...cur, told: null, agentBlockTold: null, claimAsked: true }))
  startReadyTicker($)
  detach($, 'Ready list', syncReady($))
  return READY_JOINING
}

// Off the list, for the reason `told` (null: the person asked, and the command's answer said so). Every exit from the loop comes here, and ends the dashboard's loop with the mark: a loop left running there
// would have 50 Arms ask a session that left to clear. The loop goes first, so a sync in flight sees it gone.
async function leaveReady($: any, told: string | null): Promise<void> {
  // its open approvals go with it: a decision that came later would reach someone who left, or the model, which never asked
  const loop = await read($, readyLoop)
  await update($, readyLoop, () => null)
  if (typeof loop?.permissionId === 'string') {
    await update($, permissionRequests, cur => cur.filter(r => r.publicId !== loop.permissionId))
    await syncPermissionPoll($)
  }
  if (loop?.signInAsked === true) await abortSignInWatch($)
  stopReadyTicker()
  if (told !== null) $.ui.toast(told)
  const r = await api($, 'DELETE', READY_PATH)
  if (!r.ok && !isSignedOut(r) && outcomeRevokedBy(r) === null && agentBlockOf(r) === null) $.ui.toast(`Could not take this session off the ready list: ${errText(r)}`.slice(0, FAILURE_TOAST_MAX))
  // last, so a store failure here can never leave the server's loop running
  await markReadyJudged($)
}

// a failure the next tick retries, shown once until it changes or the loop moves on
async function tellReadyOnce($: any, text: string): Promise<void> {
  let changed = false
  await update($, readyLoop, cur => {
    if (cur === null) return null
    changed = cur.told !== text
    return { ...cur, told: text }
  })
  if (changed) $.ui.toast(text.slice(0, FAILURE_TOAST_MAX))
}

// the ready join was refused for want of a team agent (`agent_needed`, `agent_limit_reached`). The toast and the title mark say so to the person; the model is told the server's
// instruction once per refusal state, so it can say what to do, and a retry that meets the same refusal tells nothing. A join (the mark) or a held agent clears the state, so the next refusal is told again.
// Detached: a prompt's promise is not known to settle when it merges into a queued turn.
async function tellAgentRefusal($: any, refusal: Record<string, unknown>): Promise<void> {
  const state = String(refusal.state)
  const instruction = typeof refusal.instruction === 'string' ? refusal.instruction : NO_AGENT[state]
  let first = false
  await update($, readyLoop, cur => {
    if (cur === null) return null
    first = cur.agentBlockTold !== state
    return first ? { ...cur, agentBlockTold: state } : cur
  })
  if (first) detach($, 'Ready list', tellModelAwake($, readyAgentRefusalNote({ ...refusal, instruction })))
}

// what a call says about the session's access: true when it ended the sync
async function readyAccessStop($: any, r: Api): Promise<boolean> {
  const by = outcomeRevokedBy(r)
  if (by !== null) {
    await leaveReady($, readyRevoked(by))
    detach($, 'Plan refresh', refresh($, true))
    return true
  }
  if (!isSignedOut(r)) return false
  // a key that lapsed needs a person's approval again: one watch at a time waits for it, and the next ticks mark the session once it is signed in
  const loop = await read($, readyLoop)
  if (loop === null || loop.signInAsked) return true
  await update($, readyLoop, cur => (cur === null ? null : { ...cur, phase: cur.phase === 'waiting' ? 'joining' : cur.phase, signInAsked: true }))
  // the band draws the approval link and the Sign in button only for a view that knows the session is signed out
  detach($, 'Plan refresh', refresh($, true))
  await startReadySignIn($)
  return true
}

// The loop's own sign-in. A watch that ends with no key and no answer (a /clear during the wait, a thrown call) lets the next look ask again.
async function startReadySignIn($: any): Promise<void> {
  const mine = ++readyWatchId
  await update($, readyLoop, cur => (cur === null ? null : { ...cur, signInAsked: true }))
  const watched = watchSignIn($, { args: await readySignInArgs($), byPress: true, wasSignedOut: true, forReadyLoop: true }).catch(err => toastCallFailedAndReload($, 'Sign in failed', err))
  // an old watch returning late must not clear the flag of the watch started after it, or the next leave would leave that one running. By its own id: `signInGeneration` moves at a /clear too, and a watch a /clear ended must be asked again.
  detach($, 'Ready list', watched.then(() => (mine === readyWatchId ? update($, readyLoop, cur => (cur === null ? null : { ...cur, signInAsked: false })) : undefined)))
}

// a sign-in for the list connects no plan, so never the plan the band's Sign in would resume
async function readySignInArgs($: any): Promise<object> {
  const sessionTitle = await read($, title)
  return sessionTitle ? { title: sessionTitle } : {}
}

// One look at where the session stands, and the step that follows. At most one runs; a trigger during one is answered by the next tick. Nothing moves while a turn or a sub-agent runs.
// A look held past LOCK_STALE_MS outside a clear waits on a call that has not settled (the plugin puts no time limit on a dashboard call, and whether the engine bounds one is UNVERIFIED), so the next
// trigger takes over, as the refresh lock does, and the loop goes on. The look taken over acts on no answer it gets after that (lookGoesOn), and a clear runs one at a time (resetSession).
async function syncReady($: any): Promise<void> {
  const now = await $.clock.now()
  const held = readySyncing
  if (held !== null && (readyResetting || now - held.at <= LOCK_STALE_MS)) return held.look
  const token: LookToken = { turns: readyTurns }
  readySyncing = {
    token,
    at: now,
    look: syncReadyOnce($, token)
      .catch(err => {
        if (!(err instanceof LookTakenOver)) throw err
      })
      .finally(() => {
        // a look taken over must not free the slot of the one that took over
        if (readySyncing?.token === token) readySyncing = null
      }),
  }
  return readySyncing.look
}

// control flow only: thrown by lookGoesOn, caught by syncReady, never seen outside the look
class LookTakenOver extends Error {}

// Checked after every call a look makes. A look acts on no answer it gets once another look took it over (that look reads the session for itself), or once a main-loop turn started since it began: the
// model connects to work, leaves it or agrees to a clear only in a turn, so what the look read may no longer be where the session stands, and the look after that turn judges it. It ends there, with one
// exception: `take-back`, a mark of its own that landed after the loop ended (the person left the list, a Stop), which must not stay on a list the session has left, whatever ran meanwhile.
async function lookGoesOn($: any, token: LookToken, owes: 'take-back' | null = null): Promise<void> {
  if (owes === 'take-back' && (await read($, readyLoop)) === null) return
  if (readySyncing?.token === token && readyTurns === token.turns) return
  throw new LookTakenOver()
}

const readyIsIdle = async ($: any): Promise<boolean> => !(await read($, turn)).isRunning && (await read($, runningAgents)).length === 0

// `token`: the look's identity in `readySyncing`. `again`: a mark refused because the session's state moved (it lost its agent, or its repo's name is gone: markReady), the rejoin after a clear included,
// looks once more at once instead of waiting a minute; once, so a dashboard that keeps refusing is not a tight loop. A session that holds work is never refused: its mark joins the loop on that work.
async function syncReadyOnce($: any, token: LookToken, again = true): Promise<void> {
  const first = await read($, readyLoop)
  if (first === null || !(await readyIsIdle($))) return
  // only the look that follows a person's `/50arms:ready` may call `session_connect`
  const asked = first.claimAsked
  if (asked) await update($, readyLoop, cur => (cur === null ? null : { ...cur, claimAsked: false }))
  let look = await readyLook($, token)
  if (look === null) return
  // a look the hold gate answered says nothing of the row, which keeps its work: only a row read after the claim decides what follows
  if (look.blocked || look.session === null || look.session.agent === null) {
    await update($, readyLoop, cur => (cur === null ? null : { ...cur, phase: cur.phase === 'waiting' ? 'joining' : cur.phase }))
    if (!(await claimReadyAgent($, asked, token))) return
    look = await readyLook($, token)
    if (look === null || look.blocked || look.session === null || look.session.agent === null) return
  }
  const { session, server } = look
  let holds: boolean
  let ownId: string
  let clear: ClearState
  try {
    holds = holdsWork(session, server)
    ownId = sessionIdOf(session)
  } catch (err: any) {
    await tellReadyOnce($, readyFailed('reading this session', errMessage(err)))
    return
  }
  try {
    clear = await clearState($, ownId)
  } catch (err: any) {
    await tellReadyOnce($, readyFailed('reading the clear file', errMessage(err)))
    return
  }
  await lookGoesOn($, token)
  // an MCP server older than the clear handshake never brings 50 Arms' ask or release. The person is told once, whether or not the session holds work, and the loop goes on, since a
  // reconnect of the server fixes it. A current server's first connect writes the compaction file before the clear file, so one look can land between the two: only a later look that
  // still finds no clear file tells.
  const olderSeenBefore = readyRelayOlderSeen === ownId
  readyRelayOlderSeen = clear.olderSign ? ownId : null
  if (clear.olderSign && olderSeenBefore && !readyRelayOlderTold) {
    readyRelayOlderTold = true
    $.ui.toast(READY_RELAY_OLDER)
  }
  // the release 50 Arms stands behind right now: the job has ended and the model said ready. The row's own `release_id` is the one word on it, so the clear runs at the end of the turn that
  // agreed, never at the stream's next frame, which the MCP's clear file waits for (up to 15 s, and the next look a minute)
  const releaseId = server?.ended === true ? server.releaseId : null
  if (releaseId !== null && releaseId !== clear.spent) {
    if (!(await resetSession($, token, ownId, releaseId))) return
    // the clear's own turn count is the look's from here
    token.turns = readyTurns
    return markAfter($, token, again)
  }
  // the release was run, and the rejoin that follows it is still owed (it failed, or a Stop of the mark): the mark leaves the ended job the session holds, with no second /clear
  const owesRejoin = releaseId !== null && releaseId === clear.spent
  if (!owesRejoin && server?.job != null && !holds && !server.ended) {
    // the server took the job while it was still open (a card added to a plan, another session connecting while this one was quiet): the session keeps its conversation and leaves the loop
    await leaveReady($, readyWorkTaken(server.job))
    return
  }
  if (!owesRejoin && server?.job != null) {
    // on the job, or past it and waiting for 50 Arms to ask for and release the clear: the model wraps up in turns of its own, and nothing here acts until the release
    await update($, readyLoop, cur => (cur === null ? null : { ...cur, phase: 'working' }))
    // a claim can hand another agent, and a model carrying on with a job would go on signing as the old one. Not on a job about to clear. Detached: a prompt's promise is not known to settle when it merges into a queued turn
    const last = (await read($, readyLoop))?.agentName ?? null
    if (holds && server?.ended !== true && last !== null && last !== session.agent.name) detach($, 'Ready list', tellEventToModel($, 'session.agent_changed', { agent_name: session.agent.name }, 'plugin.prompt'))
    await update($, readyLoop, cur => (cur === null ? null : { ...cur, agentName: session.agent.name }))
    return
  }
  // no loop job on the server: a session on no work is marked ready, and one that holds work (`/50arms:ready` run on a plan or card, or again after a Stop ended the loop) joins the loop with
  // that work as its job through the same call (markReady)
  await update($, readyLoop, cur => (cur === null ? null : { ...cur, agentName: session.agent.name }))
  const now = await read($, readyLoop)
  if (now === null) return
  // a mark that stands is left alone: it keeps its place, and a write would tell every open tab of the team
  if (now.phase === 'waiting' && now.repo !== null && session?.ready?.repo === now.repo) return
  return markAfter($, token, again)
}

// the mark, and, when the mark was refused because the session's state moved, one more look at once
async function markAfter($: any, token: LookToken, again: boolean): Promise<void> {
  if ((await markReady($, token)) && again) await syncReadyOnce($, token, false)
}

// The session's row and the dashboard's ready loop, or null when the look ended here (told, or the access stopped it). `blocked`: the hold gate answered instead of the row.
type ReadyLookAnswer = { blocked: true } | { blocked: false; session: any; server: ServerLoop | null }
async function readyLook($: any, token: LookToken): Promise<ReadyLookAnswer | null> {
  const me = await api($, 'GET', '/api/plan-sessions/me')
  await lookGoesOn($, token)
  if (me.unreachable === true || (await readyAccessStop($, me))) return null
  if (agentBlockOf(me) !== null) return { blocked: true }
  if (!me.ok) {
    await tellReadyOnce($, readyFailed('reading this session', errText(me)))
    return null
  }
  // a body that is no object at all is as malformed as one with no session field, and is told, never thrown
  if (typeof me.body !== 'object' || me.body === null || meLacksSession(me)) {
    await tellReadyOnce($, readyFailed('reading this session', ME_NO_SESSION))
    return null
  }
  try {
    return { blocked: false, session: me.body.session, server: serverLoopOf(me.body, 'GET /api/plan-sessions/me') }
  } catch (err: any) {
    await tellReadyOnce($, readyFailed('reading this session', errMessage(err)))
    return null
  }
}

// The release this loop last ran (`spent`), kept under the session's dashboard id, and whether the session's MCP server is older than the clear handshake (`olderSign`). The files are the
// ones of the session's dashboard id, which the MCP writes them under; never `$.session.id()`, which a /clear changes. Throws on an id that names no file. Which release 50 Arms stands behind
// is the row's word (`release_id`), never the clear file's: the MCP writes it there only at its stream's next frame.
// `olderSign`: the sign of an MCP server older than the clear handshake. Every MCP server the plugin serves writes the session's compaction file at each connect of its event stream, and a
// current one writes the clear file after it (the stream sends the compaction control, then the clear control). A compaction file with no clear file is a stream that connected through an
// older server, whatever work the session holds, or a current server's first connect caught between its two frames, which a later look tells apart (syncReadyOnce). No file at all is a
// stream not up yet, which says nothing of the server. The compaction file is read first, so both frames landing between the two reads read as a current server.
type ClearState = { spent: string | null; olderSign: boolean }
async function clearState($: any, sessionId: string): Promise<ClearState> {
  const home = await homeDir($)
  if (home === null) throw new Error('no home directory')
  const path = sessionFilePath(home, 'clear', sessionId)
  const compaction = sessionFilePath(home, 'compaction', sessionId)
  if (path === null || compaction === null) throw new Error(`the session id ${JSON.stringify(sessionId)} names no file`)
  const compactionWritten = await $.fs.exists(compaction)
  const olderSign = compactionWritten && !(await $.fs.exists(path))
  return { spent: spentReleaseId(await storeOp($, { op: 'get', key: clearSpentKey(sessionId) })), olderSign }
}


// The plan-less claim, as the plugin's background call: a session that cannot get an agent must not count as working, or its key would never lapse. True once the session holds one.
async function claimReadyAgent($: any, asked: boolean, token: LookToken): Promise<boolean> {
  const claimed = await api($, 'POST', '/api/plan-sessions/me/agent')
  await lookGoesOn($, token)
  if (await readyAccessStop($, claimed)) return false
  if (claimed.ok && claimed.body?.state === 'agent_held') {
    await update($, readyLoop, cur => (cur === null ? null : { ...cur, agentBlockTold: null }))
    detach($, 'Plan refresh', refresh($, true))
    return true
  }
  if (claimed.ok && typeof claimed.body?.state === 'string' && claimed.body.state in NO_AGENT) {
    await tellReadyOnce($, NO_AGENT[claimed.body.state])
    await tellAgentRefusal($, claimed.body)
    return false
  }
  const refusal = agentRefusalOf(claimed)
  if (refusal === null) {
    await tellReadyOnce($, readyFailed('claiming a team agent', errText(claimed)))
    return false
  }
  // the gate's own answer (`agent_not_held`) says to call session_connect, which only a person's /50arms:ready may do (below); the two refusals that name a person's action are told to the model now
  if (refusal.state !== 'agent_not_held') await tellAgentRefusal($, refusal)
  return claimThroughConnect($, asked)
}

// An earlier `session_connect` found no agent, so the MCP answers every other call with that until a later `session_connect` finds one, and only that lifts it. No timer may call it: a session idle on no agent work must
// lapse like any other. So only a person's `/50arms:ready` does, through the sign-in watch, which also draws an approval the call turns up. A session refused an agent does not join by itself when one frees.
async function claimThroughConnect($: any, asked: boolean): Promise<boolean> {
  const loop = await read($, readyLoop)
  if (loop === null || loop.signInAsked) return false
  if (asked) {
    // the band draws an approval only for a view that knows the gate is closed
    detach($, 'Plan refresh', refresh($, true))
    await startReadySignIn($)
  } else if (loop.told === null) await tellReadyOnce($, READY_NO_AGENT_AGAIN)
  return false
}

// The released clear: /clear alone, only while nothing still runs in the session (a /compact first would only pay for a summary the /clear throws away). A /clear proves itself by the session's id
// changing; one that did not keeps the session off the list, because a session must not rejoin holding its last job, and leaves the release unspent so the next look tries again. A /clear a person's
// Stop rejected takes the session off the list. One clear at a time: no look takes over the look that clears, and a look taken over starts none.
async function resetSession($: any, token: LookToken, sessionId: string, releaseId: string): Promise<boolean> {
  if (readySyncing?.token !== token) return false
  readyResetting = true
  try {
    return await runReset($, sessionId, releaseId)
  } finally {
    readyResetting = false
    // the /clear waited on Claude Code, not the dashboard: the look in flight is timed from here, so its mark after a long /clear is not taken over at once
    if (readySyncing !== null) readySyncing.at = await $.clock.now()
  }
}

// Claude Code's own /clear, run by the plugin: the ready loop's released clear and a compaction by clear are both this one command. A /clear proves itself by the session's id changing: `refused` is the
// engine's reason when it threw, `failure` is why it did not clear (the refusal, or an id that stayed), null when it cleared.
async function clearCommand($: any): Promise<{ refused: string | null; failure: string | null }> {
  const before = await $.session.id()
  let refused: string | null = null
  try {
    await $.command.run({ command: 'clear' })
  } catch (err: any) {
    refused = errMessage(err)
  }
  return { refused, failure: refused ?? (before === (await $.session.id()) ? 'the session id did not change' : null) }
}

async function runReset($: any, sessionId: string, releaseId: string): Promise<boolean> {
  // the guard is taken here, after the last await of the decision, and given back when the clear and its bookkeeping have ended
  const goesOn = async (): Promise<boolean> => {
    if ((await read($, readyLoop)) === null || !(await sessionIsIdleForClear($)) || clearInProgress) return false
    clearInProgress = true
    return true
  }
  if (!(await goesOn())) {
    if ((await read($, readyShells)).length > 0) await tellReadyOnce($, READY_SHELL_HOLDS_RESET)
    return false
  }
  try {
    return await resetAndMark($, sessionId, releaseId)
  } finally {
    clearInProgress = false
  }
}

async function resetAndMark($: any, sessionId: string, releaseId: string): Promise<boolean> {
  await update($, readyLoop, cur => (cur === null ? null : { ...cur, phase: 'resetting', rejoining: true }))
  const { refused, failure } = await clearCommand($)
  if (refused !== null && stoppedByPerson(refused)) {
    await leaveReady($, READY_STOPPED)
    return false
  }
  if (failure !== null) {
    await tellReadyOnce($, readyFailed('resetting this session', failure))
    return false
  }
  // spent once the /clear has run: the release is acted on once, by this process or the next
  const now = await $.clock.now()
  await storeOp($, { op: 'set', key: clearSpentKey(sessionId), value: { releaseId, at: now } })
  await pruneSessionRecords($, CLEAR_SPENT_PREFIX)
  await update($, readyLoop, cur => (cur === null ? null : { ...cur, phase: 'joining', told: null }))
  return true
}

// The queued job this module has in hand now (ready/offer.ts), by item id; null when none. A module variable of THIS module instance. A plugin reload does not end the old instance's work: its in-flight claim,
// worktree command and prompt go on, and the new module starts with this empty. So the job in hand is told apart by its mark's owner (`INSTANCE`), never by this variable.
let queueJobBusy: number | null = null

// The id this module instance minted when it loaded: the owner of every mark it writes (`queueJobTaking`). A reloaded module is a new instance, so it never mistakes the old one's mark for its own.
const INSTANCE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
// The one timer of the module's look at the mark (`resumeQueueJob`): a claim's retry, a mark's `retry_at`, or the window of a mark its owner may still be working. A reload cancels it with the rest of the old environment.
// `resumeTimerPending` says it is armed and has not fired: a look that finds a watched mark waits only on a timer that is really pending.
let resumeTimer: { cancel: () => void } | null = null
let resumeTimerPending = false
// the failures in a row of a claim the dashboard did not answer: they set the wait of its retry (relay/config backoffMs)
let claimFailures = 0
// the foreign mark this module is watching on its own timer, as it saw it (ready/offer.ts, takeoverOf)
let watched: Watch | null = null
// how long a timer that fires while the module is busy waits before it looks again
const RESUME_BUSY_MS = 5_000

function resumeAfter($: any, ms: number, timerFired = false): void {
  resumeTimer?.cancel()
  resumeTimerPending = true
  resumeTimer = $.clock.after(ms, () => {
    resumeTimerPending = false
    detach($, 'Queued job', resumeQueueJob($, timerFired))
  })
}

// A queued job offered to this session, claimed by the plugin (ready/offer.ts): the claim, then the repo's worktree command when the claim answers a worktree, then one prompt that tells the model
// the job with the claim's whole answer and the worktree's path. A claim that is refused holds nothing: the person is told, the model is not.
async function takeQueueJob($: any, offer: Offer, urgent: boolean): Promise<void> {
  // a held main conversation takes no new work: it gives the job back at once with the hold's reason, so the job returns to the queue
  const holding = (await read($, behavior)).holds[mainContext]
  if (leavesQueue(holding)) {
    await leaveQueueJob($, offer.item_id, `the session is held (${(holding as Hold).detail}), so it takes no new work`, true)
    return
  }
  await workQueueJob($, { item_id: offer.item_id, urgent, prepared: null }, null, false)
}

// The model's own claim of a queue job (a handed-back job it claims again, ready/offer.ts `jobHandedBack`): the claim is made and its answer is the model's, so the session makes the worktree and tells the model the
// job, exactly as for a claim it made itself.
function onTakeClaimed($: any, itemId: number, answer: unknown): void {
  detach($, 'Queued job', workQueueJob($, { item_id: itemId, urgent: false, prepared: null }, answer, false))
}

// A job a module had in hand when the plugin reloaded (CP-181, DEC-3425). A reload cancels the old module's timers but not its command or prompt, so the module that finds the mark cannot tell whether its owner still works it,
// and judges by signs of life (`takeoverOf`): a mark of its own (a claim it retries) it carries on; a mark waiting on a retry (`retry_at`) any module takes over once that time has passed, since no command runs behind it; any
// other mark of another instance it watches on its own timer, noting the mark's `at` and taking the job over only if `at` is the same when the window has passed (the owner rewrites it at every step, and a relative timer pauses
// with a sleeping machine as the owner's command does), never comparing `at` with the clock. Taking over claims the job again, which for the session that holds it answers the job once more and writes nothing (DX-8401), so
// the job stays the session's. A mark of another shape belongs to an older plugin's module, which may still be working it: never read, never handed back.
async function resumeQueueJob($: any, timerFired = false): Promise<void> {
  // a fire that finds the module busy looks again soon, so the window that has passed is never lost; the end of the work looks too (workQueueJob)
  if (queueJobBusy !== null) {
    if (timerFired) resumeAfter($, RESUME_BUSY_MS, true)
    return
  }
  const job = takingJobOf(await read($, queueJobTaking))
  const now = await $.clock.now()
  // the last await is above: from this check to the work there is none, so no offer or claim can take the module between the decision and the work
  if (queueJobBusy !== null) {
    if (timerFired) resumeAfter($, RESUME_BUSY_MS, true)
    return
  }
  if (job === null) {
    watched = null
    return
  }
  const step = takeoverOf(job, INSTANCE, now, watched, timerFired, resumeTimerPending)
  if (step.kind === 'waiting') return
  if (step.kind === 'retry') return resumeAfter($, step.waitMs)
  if (step.kind === 'watch') {
    watched = { item_id: job.item_id, owner: job.owner, at: job.at }
    return resumeAfter($, OWNER_SILENT_MS, true)
  }
  watched = null
  // a takeover replaces exactly the owner and `at` it judged
  await workQueueJob($, job, null, true, step.kind === 'take' ? { owner: job.owner, at: job.at } : null)
}

// The mark this instance last wrote and has not dropped, as the module's own copy: the authority `restoreCarried` writes back over the value read at `session.end` (a /clear's carry gap overwrites what a loop wrote in between)
let ownMark: TakingJob | null = null
// the job items this instance handed back since it last told them: a /clear's restore must not bring them back onto the told list
const jobsLeft = new Set<number>()

// What a /clear's restore writes for the mark: this instance's own copy when it has one, else the value read at `session.end` unless that is a mark this instance has dropped since (a restored ghost would tell the job twice)
function markToRestore(carried: unknown): unknown {
  if (ownMark !== null) return ownMark
  const mark = takingJobOf(carried)
  return mark !== null && mark.owner === INSTANCE ? null : carried
}

// The job in hand written with this instance as owner, at the time of the write, unless another instance's mark stands in the way: that mark is returned, and the job is its owner's. A write after the first one that
// finds its mark gone stops only when another instance took the job over from this one (`queueTakenOver`): a mark that went missing for any other reason (a /clear's carry gap, an older module clearing it) is written again,
// the claim having landed. `first`: the first write of this module's work on the job; a takeover's first write records the taker, a fresh one forgets a takeover of an earlier round.
// `retryAt`: the mark says its owner waits on a retry from then, so any module may take the job over once it has passed.
async function keepMark($: any, hand: Hand, over: Judged | null, first: boolean, retryAt: number | null = null): Promise<{ kept: true } | { kept: false; by: TakingJob | null }> {
  const now = await $.clock.now()
  const lost = !first && lostToTakeover(await read($, queueTakenOver), hand.item_id, INSTANCE)
  let blocker = null as { by: TakingJob | null } | null
  let written = null as TakingJob | null
  await update($, queueJobTaking, cur => {
    const can = markWritable(cur, INSTANCE, hand.item_id, over, lost)
    if (!can.ok) {
      blocker = { by: can.by }
      return cur
    }
    written = { item_id: hand.item_id, urgent: hand.urgent, prepared: hand.prepared, owner: INSTANCE, at: now, retry_at: retryAt }
    return written
  })
  if (blocker !== null) return { kept: false, by: (blocker as { by: TakingJob | null }).by }
  ownMark = written
  if (first) await update($, queueTakenOver, cur => (over !== null ? withTakenOver(cur, hand.item_id, INSTANCE) : withoutTakenOver(cur, hand.item_id)))
  return { kept: true }
}

// The owner's sign of life before a call that may wait on the network (the hand-back's DELETE): its own mark of the job gets a new `at`, and a mark that is not its own is left as it is
async function touchMark($: any, itemId: number): Promise<void> {
  const now = await $.clock.now()
  let touched = null as TakingJob | null
  await update($, queueJobTaking, cur => {
    const mark = takingJobOf(cur)
    if (mark === null || mark.owner !== INSTANCE || mark.item_id !== itemId) return cur
    touched = { ...mark, at: now, retry_at: null }
    return touched
  })
  if (touched !== null) ownMark = touched
}

// This instance's mark of job `itemId` gone: the job is told, left or refused. Another instance's mark, and this instance's mark of another job, are not this job's to clear.
async function dropMark($: any, itemId: number): Promise<void> {
  await update($, queueJobTaking, cur => {
    const mark = takingJobOf(cur)
    return mark?.owner === INSTANCE && mark.item_id === itemId ? null : cur
  })
  if (ownMark?.item_id === itemId) ownMark = null
}

// One queued job in hand, from the claim to the model's prompt. `claimed` is the answer of a claim the model made itself (null: this module claims it). `hand` says how far the job got (`prepared`: the worktree is made),
// and each step is written to the mark (`keepMark`), so an instance that finds another owns the job stops, and a reloaded module can take the job over once this one is silent. `resumed`: the module carries a job on after a
// reload, which it claims again; a claim the dashboard refuses with anything but "this session holds nothing of the job" hands the job back, since the session may hold it from before the reload. A claim that is refused
// holds nothing: the person is told, the model is not. A claim the dashboard did not answer keeps the mark and is made again after the relay's backoff. Anything after the claim that fails leaves the job with the error
// (it goes back to the queue). When the claim had landed and its worktree could not be made (a malformed answer, the command's exit, a timeout, no path) the model is told what failed, once per job and error
// (`tellHandedBack`), at every failure when the model made the claim itself; a prompt the session refused and an unexpected fault tell it nothing. The check and the set of `queueJobBusy` are one step, so two callers
// never work at once.
async function workQueueJob($: any, hand: Hand, claimed: unknown, resumed: boolean, over: Judged | null = null): Promise<void> {
  const itemId = hand.item_id
  const leave = (error: string, quietWhenNotHeld: boolean, answer?: unknown) => leaveQueueJob($, itemId, error, quietWhenNotHeld, answer, claimed !== null)
  // a claim the session cannot work now, handed back: the model waits for the job in hand, and is told once per job and reason, never at every claim (no loop)
  const leaveBusy = (busyWith: number, error: string) => leaveQueueJob($, itemId, error, false, claimed, false, busyWith)
  // The model's claim has already landed: the session holds the job, so a session that cannot work it now hands it back and tells the model, never leaving it held with nobody working it. An offer claimed nothing yet.
  if (queueJobBusy !== null) {
    if (claimed !== null) await leaveBusy(queueJobBusy, `this session is still preparing queued job ${queueJobBusy}`)
    else if (!resumed) $.ui.toast(busyToast(itemId, queueJobBusy).slice(0, TOAST_ERROR_MAX))
    return
  }
  queueJobBusy = itemId
  let job = hand
  try {
    const first = await keepMark($, job, over, true)
    if (!first.kept) {
      // (a first write is refused by a mark that stands in the way, or, for a takeover, because the mark it judged has vanished: by is null and there is nothing to do)
      const by = first.by
      if (by !== null) {
        if (claimed !== null) await leaveBusy(by.item_id, `this session has queued job ${by.item_id} in hand`)
        else if (!resumed) $.ui.toast(busyToast(itemId, by.item_id).slice(0, TOAST_ERROR_MAX))
      }
      return
    }
    // an item already told to the model is never claimed or told again: the mark that brought this work back (another instance's, restored over a gap) is a ghost
    if ((await read($, queueJobsTold)).includes(itemId)) {
      await dropMark($, itemId)
      return
    }
    let answer = claimed
    if (answer === null) {
      const taken = await api($, 'POST', takePath(itemId))
      if (!taken.ok) {
        if (taken.status === 0 || taken.status >= 500) {
          if (++claimFailures === 1) $.ui.toast(claimUnreadToast(itemId, errText(taken)).slice(0, TOAST_ERROR_MAX))
          // the mark says its owner waits on this retry: a reload cancels the timer, and any module takes the job over once it has passed
          const wait = backoffMs(claimFailures)
          if (!(await keepMark($, job, null, false, (await $.clock.now()) + wait)).kept) return
          resumeAfter($, wait)
          return
        }
        claimFailures = 0
        if (resumed && !claimHoldsNothing(taken.body)) return await leave(`the claim made again after the plugin reloaded was refused: ${errText(taken)}`, true)
        await dropMark($, itemId)
        $.ui.toast(notTakenToast(itemId, errText(taken)).slice(0, TOAST_ERROR_MAX))
        return
      }
      claimFailures = 0
      answer = taken.body
      // the session's own claim of a job it handed back is the claim that brings it back: the model's claim of it is no longer the session's to prepare
      await update($, queueHandedBack, cur => withoutHandedBack(cur, itemId))
    }
    // a job whose worktree is made needs no command: the claim answers the repo's command as it stands now, which the repo may have cleared since
    const plan = job.prepared !== null ? ({ worktree: null } as const) : takePlanOf(answer)
    if ('malformed' in plan) return await leave(plan.malformed, false, answer)
    if (job.prepared === null && plan.worktree !== null) {
      // the owner's silence is measured from here: the command is the longest step
      if (!(await keepMark($, job, null, false)).kept) return
      let run: { exitCode: number; stdout: string; stderr: string }
      try {
        const out = await $.process.run(plan.argv, { cwd: await $.session.cwd(), timeoutMs: WORKTREE_COMMAND_TIMEOUT_MS })
        run = { exitCode: out.exitCode, stdout: String(out.stdout), stderr: String(out.stderr) }
      } catch (err: any) {
        return await leave(commandFailed(plan.argv, errMessage(err)), false, answer)
      }
      const path = worktreePathOf(plan.argv, run)
      if ('error' in path) return await leave(path.error, false, answer)
      job = { ...job, prepared: { path: path.path, worktree: plan.worktree } }
    }
    // an instance that finds another owns the job tells nothing: that owner does
    if (!(await keepMark($, job, null, false)).kept) return
    // told from here: on the list before the prompt's call, so no other copy tells it, and a failed call leaves the job (which takes it off)
    jobsLeft.delete(itemId)
    await update($, queueJobsTold, cur => withJobTold(cur, itemId))
    const issued = await issueEvent($, jobPrompt(itemId, answer, job.prepared), job.urgent)
    // the prompt is the engine's from its call (relay/outbox.ts): a reload from here on must not carry on a job the model is being told
    await dropMark($, itemId)
    const failure = await issued.done.catch((err: any) => notTakenLine(errMessage(err)))
    if (failure !== null) await leave(PROMPT_REFUSED(failure), false)
    // the model holds the job now: a later failure of it, even an identical one, is told again
    else await update($, queueFailuresTold, cur => withoutFailuresOf(cur, itemId))
  } catch (err: any) {
    // an unexpected fault (a state write, the session's directory) with the job maybe held: it is left, never kept untold
    await leave(errMessage(err), true)
  } finally {
    queueJobBusy = null
    // a window that passed while this work ran is looked at again now
    detach($, 'Queued job', resumeQueueJob($))
  }
}

// The job goes back to the queue with the error that kept it from being worked here, and the person is told. `answer`: the take's answer, given when the model is to be told too (a taken job whose
// worktree could not be made), and only once the leave landed, since the session then no longer holds the job. `quietWhenNotHeld`: a leave the dashboard refuses because the session does not hold
// the job (a take that never landed) says nothing. `forceTold`: the model made the claim itself and waits for the job, so it is told at every failure, never once per job and error.
async function leaveQueueJob($: any, itemId: number, error: string, quietWhenNotHeld = false, answer?: unknown, forceTold = false, busyWith: number | null = null): Promise<void> {
  await touchMark($, itemId)
  const left = await api($, 'DELETE', takePath(itemId), { body: { error } })
  await dropMark($, itemId)
  // the job is no longer told to the model: it is claimed and told afresh when it is next worked
  jobsLeft.add(itemId)
  await update($, queueJobsTold, cur => withoutJobTold(cur, itemId))
  if (left.ok) {
    $.ui.toast(leftToast(itemId, error).slice(0, TOAST_ERROR_MAX))
    if (answer !== undefined) {
      // the model may claim it again: that claim, and no other, is the session's to prepare
      await update($, queueHandedBack, cur => withHandedBack(cur, itemId))
      await tellHandedBack($, itemId, answer, error, forceTold, busyWith)
    }
  } else if (!(quietWhenNotHeld && left.body?.error === NOT_HOLDER)) $.ui.toast(leaveFailedToast(itemId, error, errText(left)).slice(0, TOAST_ERROR_MAX))
}

// The model of the session that took a job it could not prepare hears what failed, so it can repair a local cause at once (a person away reads no toast). Told once per job and error:
// the mark is written before the telling, so a repeat of the identical failure at the next offer adds no model turn. Detached: the prompt may wait behind a running turn, and the next offer must not wait for it.
async function tellHandedBack($: any, itemId: number, answer: unknown, error: string, force: boolean, busyWith: number | null): Promise<void> {
  let first = false
  await update($, queueFailuresTold, cur => {
    first = force || !failureWasTold(cur, itemId, error)
    return first ? withFailureTold(cur, itemId, error) : cur
  })
  if (first) detach($, 'Queued job', tellModelAwake($, busyWith === null ? jobHandedBack(itemId, answer, error) : jobBusyHandedBack(itemId, answer, busyWith)))
}

// The folder's repo as the team registered it. The names the setup guide gives a repo are read one by one, which the key may do as it stands; only a repo registered under another name needs the team's list, and so a person's
// approval. A failure that retrying cannot fix takes the session off the list and says why.
async function readyRepo($: any, token: LookToken): Promise<string | null> {
  const out = await $.process.run(['git', 'remote', 'get-url', 'origin'], { cwd: await $.session.cwd(), timeoutMs: GIT_STATUS_TIMEOUT_MS })
  await lookGoesOn($, token)
  if (out.exitCode !== 0) {
    await leaveReady($, READY_NO_ORIGIN)
    return null
  }
  const origin = parseGithubOrigin(out.stdout)
  if (origin === null) {
    await leaveReady($, READY_NOT_GITHUB)
    return null
  }
  for (const candidate of repoNameCandidates(origin)) {
    const one = await api($, 'GET', `/api/repos/${candidate}`, { query: { fields: { github_remote: true } } })
    await lookGoesOn($, token)
    if (one.ok && remoteIs(one.body, origin)) return candidate
    if (!one.ok && one.status !== 404) {
      await tellReadyOnce($, readyFailed("looking up this folder's repo", errText(one)))
      return null
    }
  }
  return readyRepoFromList($, origin, token)
}

async function readyRepoFromList($: any, origin: GithubOrigin, token: LookToken): Promise<string | null> {
  for (let offset = 0; ; ) {
    const page = await api($, 'GET', '/api/repos', { query: { fields: { github_remote: true }, limit: READY_REPOS_PAGE, offset } })
    await lookGoesOn($, token)
    if (page.status === 403 && page.body?.permission === REPOS_PERMISSION) {
      await askReposPermission($, token)
      return null
    }
    if (!page.ok) {
      await tellReadyOnce($, readyFailed("looking up this folder's repo", errText(page)))
      return null
    }
    let name: string | null
    try {
      name = repoNameFor(page.body?.repos, origin)
    } catch (err: any) {
      await tellReadyOnce($, readyFailed("looking up this folder's repo", errMessage(err)))
      return null
    }
    if (name !== null) return name
    offset += page.body.repos.length
    if (page.body.repos.length === 0 || offset >= page.body.total) break
  }
  await leaveReady($, READY_NOT_REGISTERED)
  return null
}

// a person approves the list once, through the band's approval link. The decision is the loop's alone (settlePermissionRequests): the model made no such call, so it is told nothing.
async function askReposPermission($: any, token: LookToken): Promise<void> {
  const loop = await read($, readyLoop)
  if (loop === null) return
  if (loop.permissionId !== null) {
    // still open: the band shows it. Decided and the list still refuses: a person's role does not reach the list, and asking again cannot help
    if (!(await read($, permissionRequests)).some(r => r.publicId === loop.permissionId)) await leaveReady($, READY_PERMISSION_ENDED)
    return
  }
  let asked
  try {
    asked = await $.mcp.call(SERVER, 'request_permission', { permissions: [REPOS_PERMISSION], reason: REPOS_PERMISSION_REASON })
  } catch (err: any) {
    await lookGoesOn($, token)
    if ((await read($, readyLoop)) !== null) await leaveReady($, readyPermissionRefused(errMessage(err)))
    return
  }
  await lookGoesOn($, token)
  // the person left while the ask was on its way: neither its approval nor its refusal is theirs to see
  if ((await read($, readyLoop)) === null) return
  const request = permissionRequestOf(mcpText(asked), [REPOS_PERMISSION])
  if (request === null) {
    await leaveReady($, readyPermissionRefused(refusalText(toolOutcome(asked)).slice(0, CALL_ERROR_MAX)))
    return
  }
  await update($, readyLoop, cur => (cur === null ? null : { ...cur, permissionId: request.publicId }))
  await showPermissionRequest($, request)
}

// True when the mark was refused because the session's state moved, so a look at it decides the next step. After a released clear the mark is the rejoin, and the dashboard leaves the ended job in
// the same call. For a session that holds work the same call marks nothing: it joins the dashboard's loop with that work as the loop's job.
async function markReady($: any, token: LookToken): Promise<boolean> {
  const before = await read($, readyLoop)
  if (before === null) return false
  const repo = before.repo ?? (await readyRepo($, token))
  if (repo === null || (await read($, readyLoop)) === null) return false
  const r = await api($, 'PUT', READY_PATH, { body: { repo } })
  await lookGoesOn($, token, 'take-back')
  if (await readyAccessStop($, r)) return false
  // the person left while the mark was on its way: it must not stay
  if ((await read($, readyLoop)) === null) {
    if (r.ok) await api($, 'DELETE', READY_PATH)
    return false
  }
  if (r.ok) {
    let answer: MarkAnswer
    try {
      answer = markAnswerOf(r.body)
    } catch (err: any) {
      await tellReadyOnce($, readyFailed('marking this session ready', errMessage(err)))
      return false
    }
    if (answer.kind === 'joined') {
      // on its job as a session handed one is: it waits for 50 Arms to ask for and release the clear, then clears and rejoins
      await update($, readyLoop, cur => (cur === null ? null : { ...cur, phase: 'working', repo, told: null, agentBlockTold: null, signInAsked: false, permissionId: null }))
      if (before.phase !== 'working') $.ui.toast(readyJoinedOnWork(repo, answer.job))
      return false
    }
    await update($, readyLoop, cur => (cur === null ? null : { ...cur, phase: 'waiting', repo, rejoining: false, told: null, agentBlockTold: null, signInAsked: false, permissionId: null }))
    if (before.phase !== 'waiting') $.ui.toast(before.rejoining ? readyRejoined(repo) : readyJoined(repo))
    // a rejoin may have left the plan the band shows
    if (before.rejoining) detach($, 'Plan refresh', refresh($, true))
    return false
  }
  // the session lost its agent between the look and the mark: the gate answers before the route does, or the route's own `no_agent` when the gate let it through. Either clears by a claim, so the next look makes one
  if (agentBlockOf(r) !== null || (r.status === 409 && r.body?.error === 'no_agent')) {
    await update($, readyLoop, cur => (cur === null ? null : { ...cur, phase: 'joining' }))
    return true
  }
  const code = r.body?.error
  // the repo left the team: the name is looked up again, once, and a repo that is really gone takes the session off the list there
  if (r.status === 404 && code === 'repo_not_found') {
    await update($, readyLoop, cur => (cur === null ? null : { ...cur, repo: null, phase: 'joining' }))
    return true
  }
  // any other refusal cannot pass by itself (a role that may not mark, say): retried every minute it would only repeat
  if (r.status >= 400 && r.status < 500) {
    await leaveReady($, readyMarkRefused(refusalText(r)))
    return false
  }
  await tellReadyOnce($, readyFailed('marking this session ready', errText(r)))
  return false
}

// The one record that this session was asked, or left the list on its own account: a session that left is never asked to rejoin.
async function markReadyJudged($: any): Promise<void> {
  const id = String(await $.session.id())
  await storeOp($, { op: 'set', key: readyJudgedKey(id), value: { at: await $.clock.now() } })
  await pruneSessionRecords($, READY_JUDGED_PREFIX)
}

// How the latest session start began (the classic start names it); a restart of the app resumes the session. Read by the chain that follows session.start, which first waits on the
// dashboard's plan read, so the classic start (a hook of the same start) has, as inferred and not verified live, set it long before; a module reload starts null and asks nothing.
let lastStartSource: string | null = null

// A resumed session that is signed in and in no ready loop (this process's, or the row's) is asked once to judge whether its person's work is 50 Arms work, and to load the skill when it is.
// A row whose loop could not be read says nothing about being off the list, so it asks nothing.
async function askReadyJudgement($: any): Promise<void> {
  if (lastStartSource !== 'resume' || (await read($, readyLoop)) !== null) return
  const loaded = await read($, view)
  if (!isSignedIn(loaded) || loaded.readyRepo !== null || loaded.readyLoopFault !== null) return
  if ((await storeOp($, { op: 'get', key: readyJudgedKey(String(await $.session.id())) })) != null) return
  await markReadyJudged($)
  await tellModelAwake($, READY_JUDGE_PROMPT)
}

// The loop the row still holds is taken up first; a session that is then in none is asked once to judge.
async function adoptThenAskReady($: any): Promise<void> {
  await adoptReadyMark($)
  await askReadyJudgement($)
}

// A process restarted while the dashboard still keeps its loop (a mark, or a job the loop took: the view's `readyRepo`) is in that loop without the plugin's half, and would take work and never clear:
// it takes up the loop the row says it was in, since a session that never left the list rejoins it by default. The next look reads where in the loop the session is.
// A row whose dashboard loop it cannot read (the view's `readyLoopFault`) leaves a process with no mark unable to tell whether it was in a loop: it takes none up and says so, once per fault.
// A process already in the loop hears the fault from its own look instead.
async function adoptReadyMark($: any): Promise<void> {
  const loaded = await read($, view)
  const repo = loaded.readyRepo
  if ((await read($, readyLoop)) !== null) return
  if (repo === null) {
    if (loaded.readyLoopFault !== null && readyLoopFaultTold !== loaded.readyLoopFault) $.ui.toast(readyLoopUnread(loaded.readyLoopFault).slice(0, FAILURE_TOAST_MAX))
    readyLoopFaultTold = loaded.readyLoopFault
    return
  }
  await update($, readyLoop, () => ({ ...joiningLoop(), phase: 'waiting', repo, claimAsked: false }))
  startReadyTicker($)
  $.ui.toast(readyAdopted(repo))
}

// A person's own Disconnect of a plan or a card, or Revoke of the sign-in: they have taken the session back, so the loop ends first and nothing clears. Rejoining without a clear would carry this job into the next.
async function personDisconnect($: any, hold: BandHold): Promise<void> {
  if ((await read($, readyLoop)) !== null) await leaveReady($, READY_DISCONNECTED)
  await disconnect($, hold)
}

async function personRevoke($: any, hold: BandHold): Promise<void> {
  if ((await read($, readyLoop)) !== null) await leaveReady($, READY_REVOKED)
  await revoke($, hold)
}

async function onCommand($: any) {
  await showPlan($)
  detach($, 'Plan refresh', refresh($, true))
  return { text: 'Plan band shown.' }
}

// the model's own pickup of a card (`POST /api/issues/<id>/transition` with `action: pickup`)
const CARD_TRANSITION_PATH = /^\/api\/issues\/([^/]+)\/transition$/
const isPickup = (e: any): boolean => typeof e.method === 'string' && e.method.toUpperCase() === 'POST' && typeof e.path === 'string' && CARD_TRANSITION_PATH.test(e.path) && e.body?.action === 'pickup'

// what a tool call's answer says happened: its text, read as a refusal when the call errored or was denied
function answerOf(ran: any) {
  return textOutcome(typeof ran.text === 'string' ? ran.text : '', ran.isError === true || ran.deny !== undefined)
}

// The model held a stand-alone card (session_connect with a card's id, a first connect or a move): the dashboard gets the session's current activity at once, and the view is
// refreshed so the turn reports see the card the session holds. A refused connect (`card_on_plan`) changes nothing and reports nothing; a leave
// (`disconnect: true`) refreshes the view so the card clears, but reports nothing, the session holding neither a plan nor a card.
async function afterCardConnect($: any, e: any, next: any) {
  const ran = await next(e)
  if (!answerOf(ran).ok) return ran
  if (e.disconnect !== true) await reportActivityOnConnect($)
  detach($, 'Plan refresh', refresh($, true))
  return ran
}

// The model connected (or moved) this session to a plan, left it, or only signed in (`plan`: the plan target it named, null for neither): show it at once.
async function afterPlanConnect($: any, e: any, next: any, plan: { id: number } | null) {
  // the model's leave, or its move to another plan, closes what the session opened under the plan it is on first; a leave or move
  // its answer says did not happen takes that back
  const leaving = e.disconnect === true && plan !== null
  const why = leaving ? 'leaving the plan' : `moving to plan ${plan?.id}`
  const moving = !leaving && plan !== null && (await movesOffReportedPlan($, plan.id))
  const closes = leaving || moving ? await closeOwedBeforeLeave($, why) : null
  let ran
  try {
    ran = await next(e)
  } catch (err) {
    // the call itself failed: nothing left or moved
    await settleLeave($, closes, false, why)
    throw err
  }
  const answer = answerOf(ran)
  // the plan the answer says the session is on now, read once: whether the move happened, the relay, the loop's job, and what the blocked view names when the plugin's own reads are refused
  const modelConnected = connectedPlanOf(answer)
  await settleLeave($, closes, leaving ? answer.ok : modelConnected !== null && modelConnected.id === plan?.id, why)
  // the model's connect to a plan starts the relay (or restarts it on a move to another plan) from the plan the answer says it connected, not
  // from the view the refresh below loads (a load that is slow or fails must not keep the relay down)
  relayHalted = null
  if (modelConnected !== null) startRelay($, modelConnected.id)
  // connected mid-turn or mid-compaction, the dashboard must not read idle until the next change
  if (modelConnected !== null) await reportActivityOnConnect($)
  if (modelConnected !== null) await update($, modelPlan, () => modelConnected)
  else if (leaving && answer.ok) await update($, modelPlan, () => null)
  detach($, 'Plan refresh', refresh($, true).then(() => reportUsageNow($)))
  return ran
}

// whether a tool answer shows the session signed in, as the sign-in watch reads it (signInStep)
const signedInAnswer = (ran: any): boolean => signInStep({ content: [{ type: 'text', text: typeof ran.text === 'string' ? ran.text : '' }] }).kind === 'done'

// The model's `session_connect` (one tool for a plan, a card, or only a sign-in; `target` says which): show what it settled at once. A signed-out session's `approval_required`
// answer draws the approval link and the code in the band, for any target; the plan page is not opened (there is no connection to show yet).
async function onSessionConnect($: any, e: any, next: any) {
  // the plugin's own read of the machine's registration (watchRegistration) is no connect of the model's
  if (e.registration_only === true) return next(e)
  const target = connectTargetOf(e.target)
  let ran = target?.kind === 'card' ? await afterCardConnect($, e, next) : await afterPlanConnect($, e, next, target)
  await noteDashboardVersion($, answerOf(ran).appVersion)
  // the model's own leave of a plan or card, accepted, is a natural break (a pause never is: the dashboard always gives it an expiry); the band's Disconnect (the plugin's own call) is a person's press and clears nothing
  if (isModelLeave(e, target, next.origin)) {
    const outcome = answerOf(ran)
    if (outcome.ok) clearAtBreak = true
    await noteBreak($, outcome.ok ? 'flag-set' : 'leave-not-accepted', { call: 'session_connect', target: e.target, ...outcomeFacts(ran, outcome) })
  }
  const named = !raisedByPlugin(next.origin) && e.disconnect !== true ? await applyNaming($, e.target, answerOf(ran).body?.naming) : null
  if (named !== null) ran = withNamedNote(ran, named)
  // the model's own connect answered signed in, so the session holds a key: the sign-in it waited on is over, and its link and code leave the band with this answer
  // (any answer the sign-in watch reads as signed in: a connect's `{ok: true}` envelope, or the bare `signed_in` / `agent_held` state of a plan-less one)
  if (!raisedByPlugin(next.origin) && signedInAnswer(ran) && (await read($, signInRequest)) !== null) await abortSignInWatch($)
  const registration = registrationOf(ran.text)
  if (registration !== null) {
    // an unregistered machine: the band shows the link and code, and the model is told to send the person there (and woken when they accept)
    // (a press of Sign in raises this call itself: the band shows the link, and nobody was told to send the person)
    const byModel = !raisedByPlugin(next.origin)
    await showRegistration($, registration, byModel)
    detach($, 'Machine registration', watchRegistration($))
    return byModel ? { ...ran, context: [...(ran.context ?? []), registrationShownNote(registration)] } : ran
  }
  const approval = approvalRequestOf(ran.text, ['approval_required', 'approval_pending'])
  if (approval === null) return ran
  const waiting = await read($, signInRequest)
  // a request with no id cannot be told once, so it is refused before anything is drawn (as permissionRequestOf refuses one):
  // nothing stays in $.state for it
  if (waiting === null && publicIdOf(approval.url) === undefined) {
    $.ui.toast(signInFailedToast('the approval request had no id'))
    return withSignInNote(ran, approval)
  }
  // a request is shown by its URL, never by the answer's state: a request renewed after an expiry answers
  // `approval_pending` to the model's next call and must still reach the person
  if (waiting?.url !== approval.url) await showSignInRequest($, approval)
  // the model started this sign-in, so the plugin waits on it and tells the model how it ended
  if (waiting === null) {
    const args = { ...(typeof e.target === 'string' && e.target !== '' ? { target: e.target } : {}), ...(typeof e.title === 'string' && e.title !== '' ? { title: e.title } : {}) }
    void watchSignIn($, { args, byPress: false, known: approval }).catch(err => toastCallFailedAndReload($, 'Sign in failed', err))
  }
  return withSignInNote(ran, approval)
}

// the model asked for a permission: keep the request for the band, which draws its approval link and code at once
// (no page is opened by the plugin); never a toast.
async function onRequestPermission($: any, e: any, next: any) {
  const ran = await next(e)
  const request = permissionRequestOf(ran.text, e.permissions)
  if (request === null) return ran
  return withPermissionNote(ran, await showPermissionRequest($, request))
}

// a permission request is kept for the band, which draws its approval link and code at once
async function showPermissionRequest($: any, request: PermissionRequest) {
  await update($, permissionRequests, cur => [...cur.filter(r => r.publicId !== request.publicId), request])
  await syncPermissionPoll($)
  const approval = asApproval(request)
  return approval
}

// the session acknowledged an event (POST /api/plan-sessions/me/events/<N>/ack): it is no longer in flight. A refusal comes back as a normal result with
// ok:false (a 400 is not an error result), so success is the envelope's ok, never the absence of isError.
async function onAckCall($: any, e: any, next: any) {
  const ran = await next(e)
  // the session's own card or plan write reaches it as no plan event (the relay hears other members' writes), so the band and the title's
  // Needs You mark re-read the plan the moment the write lands, never at the turn's end
  // The agent's own pause or resume (PUT / DELETE of its pause) changes the title's pause mark the same way, so it re-reads at once too.
  if (isRecordWrite(e.method, e.path) || (typeof e.method === 'string' && e.method.toUpperCase() !== 'GET' && e.path === PAUSE_PATH)) {
    detach($, 'Plan refresh', refresh($, true))
  }
  const answer = answerOf(ran)
  await noteDashboardVersion($, answer.appVersion)
  // a manual pickup by a session holding nothing connects it, as session_connect does, so the dashboard gets its activity at once. Its answer carries the connect's whole answer, which can pass the
  // MCP's size limit, so only here is an answer sent as a file read whole; nothing else this hook reads needs the body
  let named: string | null = null
  if (answer.ok && isPickup(e)) {
    const connected = (await wholeAnswer($, answer, false)).body
    if (connected?.connectedByPickup === true) {
      await reportActivityOnConnect($)
      if (!raisedByPlugin(next.origin)) named = await applyNaming($, CARD_TRANSITION_PATH.exec(e.path)?.[1], connected.naming)
    }
  }
  const id = ackedEventId(e.method, e.path)
  if (id !== null && answer.ok) await update($, ackInFlight, cur => clearInFlight(cur, [id]))
  // The model's claim of a queue job the session handed back: the session makes its worktree and tells it the job (CP-181). Any other successful take is the model's own and passes untouched: DX-8401 answers a holder's
  // claim with its job again (a holder reading its job back, after a /clear, a compaction or from a sub-agent), and that must neither make the worktree again nor tell the job twice. The plugin's own claims never come through this hook.
  const claimedJob = claimedItemOf(e.method, e.path)
  if (claimedJob !== null && answer.ok && !raisedByPlugin(next.origin)) {
    let handedBack = false
    await update($, queueHandedBack, cur => {
      handedBack = cur.includes(claimedJob)
      return handedBack ? withoutHandedBack(cur, claimedJob) : cur
    })
    if (handedBack) onTakeClaimed($, claimedJob, (await wholeAnswer($, answer, false)).body)
  }
  return named === null ? ran : withNamedNote(ran, named)
}

// what the session is doing now, for its title's mark: any sub-agent running, and the main loop's turn
async function titleActivity($: any): Promise<TitleActivity> {
  return { subAgents: (await read($, runningAgents)).length > 0, turnRunning: (await read($, turn)).isRunning, slotRefused: slotWaiting() }
}

// the main loop's turn started or ended: the hand and the waiting mark trade places only while Needs You is shown, so the title is
// synced then and never on any other turn
async function syncTitleOnTurn($: any): Promise<void> {
  if (needsYouShown(await read($, view))) detach($, 'The session title mark', syncTitleMark($))
}

// a sub-agent started or ended: the running set changes, and the title is synced only when it crosses empty / not empty. An id that is not a
// non-empty string cannot be counted, so it changes nothing (no guess).
async function noteRunningAgent($: any, id: unknown, running: boolean): Promise<void> {
  if (typeof id !== 'string' || id === '') return
  let crossed = false
  await update($, runningAgents, cur => {
    const next = running ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter(a => a !== id)
    crossed = (cur.length === 0) !== (next.length === 0)
    return next
  })
  if (crossed) detach($, 'The session title mark', syncTitleMark($))
}

async function onSubagentChange($: any, e: any, next: any, isStart: boolean) {
  await noteTranscript($, e)
  const r = await next(e)
  // a sub-agent that stopped owes no briefing, and must not make a later restart read as its own
  if (!isStart) await forgetCompactingAgent($, e.agent_id)
  if (!isStart) await markMeasured($)
  detach($, 'Plan refresh', refresh($))
  void watchRelay($)
  return r
}

// the `clock_time` slot of a prompt's texts. One stamp per prompt (never a tool call), counted from the last one.
async function timeLine($: any): Promise<string> {
  const now = await $.clock.now()
  const offsetMinutes = -new Date(now).getTimezoneOffset()
  // the line is set inside the updater, which sees the last stamp as it is when the write happens
  let line = ''
  await update($, lastStamp, last => {
    const next = nextStamp(now, offsetMinutes, last)
    line = next.line
    return next.state
  })
  return line
}

// The one-shot state reads below take a value and clear it in one write, so two callers landing together get it once. The engine's scan wants each
// `update` to name its atom, so each atom has its own take.
async function takePendingStart($: any): Promise<PendingStart> {
  let taken: PendingStart = null
  await update($, pendingStart, cur => {
    taken = cur
    return null
  })
  return taken
}

async function takeFinishedAgents($: any): Promise<FinishedAgent[]> {
  let taken: FinishedAgent[] = []
  await update($, finishedAgents, cur => {
    taken = cur
    return []
  })
  return taken
}

// the finish of sub-agents, handed with the main session's next action (a prompt or a tool result): who finished (`extra`: one whose final task notice is this very prompt), then the
// bundle's `subagent.stop` texts once; none when nothing finished since the last action
async function subagentStopEntries($: any, budget: Budget, extra: FinishedAgent[] = []): Promise<string[]> {
  const finished = [...(await takeFinishedAgents($)), ...extra]
  if (finished.length === 0) return []
  // who finished is the `subagent.finished` text, then the `subagent.stop` texts
  const named = await tellEvent($, 'subagent.finished', null, budget, { extra: { sub_agent_labels: finished.map(f => f.label).join('; ') } })
  // a delivery that failed is told as the hold line and kept on the hold to be told again, never dropped
  if (named.kind === 'refused') return [named.text]
  const outcome = await tellEvent($, 'subagent.stop', null, budget, { extra: { sub_agent_id: finished.map(f => f.id).join(', ') } })
  if (outcome.kind === 'refused') return [outcome.text]
  const texts = [...textsOf(named), ...textsOf(outcome)]
  return texts.length === 0 ? [] : [texts.join('\n\n')]
}

async function takeEndedSession($: any): Promise<string | null> {
  let taken: string | null = null
  await update($, endedSession, cur => {
    taken = cur
    return null
  })
  return taken
}

// A pending session start is told once: the next prompt or tool result, whichever comes first, carries its line beside the stamp (a start with no
// prompt coming, such as a compaction in the middle of a turn, reaches the model on the next tool result). It is gone once taken, so work that throws is one warning line here, never a rejected hook that
// would lose the time stamp beside it.
async function renderStart($: any, start: NonNullable<PendingStart>, budget: Budget): Promise<string | null> {
  try {
    return await sessionContext($, start, budget)
  } catch (err: any) {
    // a start that could not be read is no start told: the context is held with the failure and the start owed (the floor's loading line), never a line of the plugin's own
    const event = startEventOf(start)
    return event === null || !(await signedInWithAgent($)) ? null : owedStart($, event, { reason: 'fetch_failed', detail: `reading what this start carries failed (${String(err?.message ?? err).slice(0, CALL_ERROR_MAX)})`, values: {} })
  }
}

// A conversation the plugin's own /clear opened (the ready loop's, or a compaction by clear) is fresh: it is told what a new session is told. Any other start is told by its source.
const isFreshStart = (start: NonNullable<PendingStart>): boolean => start.loopReset === true || start.compactionClear === true
// the bundle event a start is told (null: a start with no text of its own). A fresh conversation the plugin's own /clear opened for the ready loop is told what a new session is told; a clear (a person's, or a compaction by clear) is told the after-clear event
const startEventOf = (start: NonNullable<PendingStart>): string | null => (start.compactionClear === true ? 'session.after_clear' : start.loopReset === true ? 'session.start' : sessionEvent(start.source))

// the entries a hook adds to the model's context: the disk notice, the checkout-behind notice and, when there is one, the session start line. The time stamp is no entry of the
// plugin's: it is the `clock_time` slot of the bundle's `prompt.submit` texts (AC 72124).
// The start is TAKEN by the hook (`takePendingStart`) before the start's own slow reads, in the one order of arrival, so two hooks landing together (a fresh desktop session's first prompt runs the hook twice) never both tell it.
async function noticeStartEntries($: any, pending: PendingStart, trigger: 'prompt' | 'tool', agent: string, budget: Budget): Promise<string[]> {
  const disk = await diskEntries($, trigger, agent, budget)
  // only the main agent is told its checkout is behind (the plugin knows the session's folder, never a sub-agent's own)
  const behind = agent === MAIN_AGENT ? await appVersionNotice($, budget) : []
  const head = [...disk, ...behind]
  const start = pending === null ? null : await renderStart($, pending, budget)
  // the role is an entry of its own, never joined with an event text
  const role = agent === MAIN_AGENT ? await roleEntries($, budget) : []
  return [...head, ...(start === null ? [] : [start]), ...role]
}

// The session's role: fetched from the dashboard (`GET /api/plan-sessions/me/role`, as a file) and told as the `session.bind` event, to the main conversation once per role it holds (a plan, a card, or neither),
// again after each compaction or clear of it, and each time as an entry of its own. The role text is never part of the bundle and the plugin keeps no copy of it.
const BIND_EVENT = 'session.bind'
const roleKeyOf = (v: { card: { id: unknown } | null; connected: { id: unknown } | null }): string => (v.card !== null ? `card:${v.card.id}` : v.connected !== null ? `plan:${v.connected.id}` : 'none')

async function roleEntries($: any, budget: Budget): Promise<string[]> {
  if (!(await signedInWithAgent($))) return []
  const key = roleKeyOf(await read($, view))
  const now = await read($, behavior)
  if (now.roleTold === key) return []
  // a role that failed is told again by the hold's retell, the one retry (the next tool call): this hook starts no fetch of its own
  if ((now.holds[mainContext]?.retell ?? []).some(r => r.event === BIND_EVENT)) return []
  const outcome = await tellEvent($, BIND_EVENT, null, budget)
  // a role that could not be fetched holds the context: the hook tells the loading or hold line, and the next tool call is refused with it
  return outcome.kind === 'texts' ? outcome.entries : outcome.kind === 'refused' ? [outcome.text] : []
}

// A role fetch that failed: a text that cannot be delivered, held with the failure it met (a 426 names the version to update to).
class RoleFetchError extends BundleShapeError {
  constructor(message: string, readonly failure: Failure) {
    super(message)
  }
}

// The role, fetched when `session.bind` is told: the answer's one computed entry, or none for a session on neither a plan nor a card. `api()` reads the reply file and checks it against the sha256 the answer names, so a body that fails
// the check is a failed call. A fetch that fails or ends past the hook's deadline throws, and the caller holds the context.
async function fetchRole($: any, budget: Budget): Promise<BundleComputed[]> {
  let failure: Failure | null = null
  const source = await boundedBy($, budget.deadlineAt, briefingSource<BundleComputed | null>(async () => {
    const r = await api($, 'GET', ROLE_PATH, { query: roleQuery(await pluginVersion($)), reply_to_file: true })
    if (!r.ok) {
      failure = await answerFailure($, r, 'role fetch')
      throw new Error(errText(r))
    }
    return readRoleBody(r.body)
  }))
  if (!source.ok) {
    const message = `bad_response: the role could not be fetched (${source.reason.slice(0, CALL_ERROR_MAX)})`
    throw new RoleFetchError(message, failure ?? { reason: 'fetch_failed', detail: message, values: {} })
  }
  return source.value === null ? [] : [source.value]
}

// remember the app version a dashboard answer carried (`app_version`, which the MCP copies from the `X-50Arms-Version` header). It adds no request: only answers the session already got
// are read, the model's own `50arms_api` / `session_connect` results and the plugin's own calls (both reach their tool's `tool.call` handler).
async function noteDashboardVersion($: any, version: string | undefined): Promise<void> {
  if (version === undefined) return
  await update($, appVersion, cur => (cur.dashboard === version ? cur : { ...cur, dashboard: version }))
}

// The line telling the agent to rebase, or null. A dashboard version and a folder are compared ONCE (the pair is claimed before the slow reads, so hooks landing together tell it once, and a
// pair already compared costs nothing): the checkout's version is `<git toplevel>/50ARMS_VERSION`, and a repo without that file carries none. A new dashboard version or another folder compares again.
async function appVersionNotice($: any, budget: Budget): Promise<string[]> {
  const dashboard = (await read($, appVersion)).dashboard
  if (dashboard === null) return []
  const cwd = String(await $.session.cwd())
  const pair = `${dashboard}\n${cwd}`
  const claim = { won: false }
  await update($, appVersion, cur => {
    if (cur.checked === pair) return cur
    claim.won = true
    return { ...cur, checked: pair }
  })
  if (!claim.won) return []
  try {
    const behind = checkoutBehind(await checkoutVersionText($, cwd), dashboard)
    return behind === null ? [] : textsOrRefusal(await tellEvent($, 'checkout.behind', null, budget, { extra: { dashboard_version: behind.dashboard, checkout_version: behind.checkout } }))
  } catch (err: any) {
    return [versionFaultLine(dashboard, String(err?.message ?? err))]
  }
}

// the content of the checkout's version file, or null when the folder is no git checkout or the repo has no such file
async function checkoutVersionText($: any, cwd: string): Promise<string | null> {
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: GIT_STATUS_TIMEOUT_MS })
  if (top.exitCode !== 0) return null
  const path = `${String(top.stdout).trim()}/${APP_VERSION_FILE}`
  return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : null
}

// The machine's free-space notice (hooks/context/disk.ts), in every repo: a person's prompt, a session start (it clears the memory, so the first
// tool call after it tells) and autonomous tool calls, sub-agents' included. A tool call answers from the last measurement and, once it is older
// than DISK_MEASURE_MS, refreshes it in the background (a person's prompt measures again before it answers). An unchanged notice is repeated to
// the same agent only after DISK_REPEAT_MS.
async function diskEntries($: any, trigger: 'prompt' | 'tool', agent: string, budget: Budget): Promise<string[]> {
  const now = await $.clock.now()
  const facts = await diskReading($, trigger, now)
  let tell = false
  await update($, diskTold, told => {
    const d = diskDecision(diskKey(facts), now, told, trigger, agent)
    tell = d.line !== null
    return d.told
  })
  if (!tell) return []
  // the window is the more urgent, then the plugin's own fault lines, then the free space; every sentence about them is the bundle's
  const agentId = agent === MAIN_AGENT ? null : agent
  const entries: string[] = []
  if (facts.window !== null) entries.push(...textsOrRefusal(await tellEvent($, 'disk.maintenance_window', agentId, budget, { extra: { window_opened_at: facts.window.openedAt, window_reason: facts.window.reason } })))
  entries.push(...facts.floor)
  if (facts.low !== null) {
    entries.push(...textsOrRefusal(await tellEvent($, 'disk.low', agentId, budget, { extra: { disk_free_amount: facts.low.free, disk_floor_amount: facts.low.floor } })))
    if (facts.low.hardMinimum !== null) entries.push(...textsOrRefusal(await tellEvent($, 'disk.below_hard_minimum', agentId, budget, { extra: { disk_hard_minimum_amount: facts.low.hardMinimum } })))
  }
  return entries
}

async function diskReading($: any, trigger: 'prompt' | 'tool', now: number): Promise<DiskFacts> {
  const last = await read($, diskMeasured)
  if (trigger === 'tool' && last !== null) {
    if (now - last.at >= DISK_MEASURE_MS) detach($, 'Disk check', probeDisk($))
    return last.facts
  }
  return probeDisk($)
}

// What is running now, by session, so concurrent hooks share one probe and one home lookup instead of each starting their own.
const diskProbes = new Map<string, Promise<DiskFacts>>()
const homeLookups = new Map<string, Promise<string | null>>()
function sharedRun<T>(running: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
  const found = running.get(key)
  if (found !== undefined) return found
  const started = run().finally(() => running.delete(key))
  running.set(key, started)
  return started
}

async function probeDisk($: any): Promise<DiskFacts> {
  return sharedRun(diskProbes, String(await $.session.id()), async () => {
    const measured = await measureDisk($)
    const at = await $.clock.now()
    await update($, diskMeasured, () => ({ facts: measured.facts, freeBytes: measured.freeBytes, at }))
    return measured.facts
  })
}

const WSL_INTEROP_TIMEOUT_MS = 10_000
const DISK_PROBE_TIMEOUT_MS = 10_000
const WSL_USERS_DIR = '/mnt/c/Users'

// '' for a machine this policy does not concern (no C:, or no Windows home holding a `.danxbot` directory: the machine has not opted in to 50 Arms'
// machine tooling) or when all is well; else the notice. Every fault is ONE line, never silence.
async function measureDisk($: any): Promise<{ facts: DiskFacts; freeBytes: number | null }> {
  try {
    // each variable by its own literal name: `$.env.get` takes a literal so the variables a module reads can be listed
    const env: DiskEnv = {
      SystemDrive: await $.env.get('SystemDrive'),
      WSL_DISTRO_NAME: await $.env.get('WSL_DISTRO_NAME'),
      USERPROFILE: await $.env.get('USERPROFILE'),
      DANXBOT_DISK_FLOOR_GIB: await $.env.get('DANXBOT_DISK_FLOOR_GIB'),
      DANXBOT_DISK_HARD_MINIMUM_GIB: await $.env.get('DANXBOT_DISK_HARD_MINIMUM_GIB'),
    }
    const kind = hostKindOf(env)
    if (kind === null) return { facts: NO_DISK_FACTS, freeBytes: null }
    const home = await machineHome($, kind, env)
    if (home === null) return { facts: NO_DISK_FACTS, freeBytes: null }
    const dir = joinPath(kind, home, '.danxbot')
    const floorsPath = joinPath(kind, dir, 'machine-disk-floors')
    const windowPath = joinPath(kind, dir, 'compaction-window')
    const floorsText = (await $.fs.exists(floorsPath)) ? String(await $.fs.read(floorsPath)) : null
    const windowText = (await $.fs.exists(windowPath)) ? String(await $.fs.read(windowPath)) : null
    // `$` has no statfs: the system drive's free space is asked of a bounded process (powershell.exe, or df in WSL)
    const free = await $.process.run(freeSpaceArgv(kind, env), { timeoutMs: DISK_PROBE_TIMEOUT_MS })
    if (free.exitCode !== 0) throw new Error(`the free-space command exited ${free.exitCode}`)
    const freeBytes = parseFreeBytes(free.stdout)
    return { facts: diskNotice({ env, freeBytes, floorsText, floorsPath, windowText }), freeBytes }
  } catch (err) {
    return { facts: diskFault(err), freeBytes: null }
  }
}

// The Windows home that holds `.danxbot`, or null when the machine has not opted in. Found and failed answers are kept for the session (a stalled
// interop call is never retried per tool call); "not opted in" is asked again, which costs a directory listing and never an interop call.
async function machineHome($: any, kind: HostKind, env: DiskEnv): Promise<string | null> {
  return sharedRun(homeLookups, String(await $.session.id()), async () => {
    const kept = await read($, diskHome)
    if (kept !== null) {
      if ('fault' in kept) throw new Error(kept.fault)
      return kept.home
    }
    try {
      const home = kind === 'windows' ? await windowsProfileHome($, env) : await wslHome($)
      if (home !== null) await update($, diskHome, () => ({ home }))
      return home
    } catch (err: any) {
      await update($, diskHome, () => ({ fault: String(err?.message ?? err) }))
      throw err
    }
  })
}

async function windowsProfileHome($: any, env: DiskEnv): Promise<string | null> {
  if (!env.USERPROFILE) throw new Error('USERPROFILE is not set, so the Windows home cannot be located')
  return (await $.fs.exists(joinPath('windows', env.USERPROFILE, '.danxbot'))) ? env.USERPROFILE : null
}

// In WSL the opt-in is decided from the mounted C: alone: the user folders holding `.danxbot`. No interop call happens before that, so a machine
// that has not opted in is never told anything, even with interop off. Only several candidates need cmd.exe, to say which one is the signed-in user's.
async function wslHome($: any): Promise<string | null> {
  if (!(await $.fs.exists(WSL_USERS_DIR))) return null
  const candidates: string[] = []
  for (const entry of await $.fs.list(WSL_USERS_DIR)) {
    if (entry.kind === 'dir' && (await $.fs.exists(joinPath('wsl', WSL_USERS_DIR, entry.name, '.danxbot')))) candidates.push(joinPath('wsl', WSL_USERS_DIR, entry.name))
  }
  if (candidates.length <= 1) return candidates[0] ?? null
  const cmd = await $.process.run(['cmd.exe', '/c', 'echo %USERPROFILE%'], { timeoutMs: WSL_INTEROP_TIMEOUT_MS })
  if (cmd.exitCode !== 0) throw new Error(`cmd.exe exited ${cmd.exitCode}`)
  const converted = await $.process.run(['wslpath', '-u', parseWindowsProfile(cmd.stdout)], { timeoutMs: WSL_INTEROP_TIMEOUT_MS })
  if (converted.exitCode !== 0) throw new Error(`wslpath exited ${converted.exitCode}`)
  const profile = String(converted.stdout).trim()
  const chosen = candidates.find(c => c.toLowerCase() === profile.toLowerCase())
  if (chosen === undefined) throw new Error(`the Windows home ${profile} has no .danxbot directory, but ${candidates.join(' and ')} do`)
  return chosen
}

// the prompt as typed (a task notification included) reaches the model with its time beside it, and with the session start it carries, if any.
// The desktop app's notice that a side session this session started ended a turn arrives as a prompt too, and it also carries the reminder to
// archive that session once its work is finished (the registry's side_session_turn_end text). A finished sub-agent's reminder to record its result,
// owed by the main session, rides this prompt too when it has not ridden a tool result.
async function onPromptStamp($: any, e: any, next: any) {
  const held = await holdInterimNotice($, e)
  if (held !== null) return { drop: held }
  const budget = await hookBudget($)
  // the start is taken and the clock stamped in the one order of arrival, before the start's own slow reads: of two prompts landing together, whoever takes the start also takes the first stamp
  const pending = await takePendingStart($)
  const signedIn = await signedInWithAgent($)
  // a prompt of the main conversation: what the bundle tells at a prompt (the time stamp is its `clock_time` slot; the start texts it was owed before this hook ride with it), or the line that holds it. It comes first: what a prompt carries begins with its time
  const bundled = signedIn ? textsOrRefusal(await tellEvent($, 'prompt.submit', null, budget, { owed: 'with', waitMs: pending === null ? BUNDLE_WAIT_MS : CONTEXT_DEADLINE_MS })) : []
  const entries = await noticeStartEntries($, pending, 'prompt', MAIN_AGENT, budget)
  const side = isSideSessionNotice(e.text) && signedIn ? textsOf(await tellEvent($, 'side_session.turn_end', null, budget)) : []
  const finished = await finishNoticeLabel($, taskNoticeOf(e.origin, e.text))
  return next({ ...e, context: [...(e.context ?? []), ...bundled, ...entries, ...side, ...(await subagentStopEntries($, budget, finished))] })
}

// An interim sub-agent notice (the sub-agent ended a turn with a command of its own still running) is kept from the model: it notifies again with its
// result, and a wake-up for every interim one is a paid turn. The result for the same task, or the wait running out (releaseDueNotices), settles it.
// Returns the reason shown to the person when the notice is held, else null (the prompt goes on). A reload cancels the timer, so each prompt re-arms it.
async function holdInterimNotice($: any, e: any): Promise<string | null> {
  const notice = taskNoticeOf(e.origin, e.text)
  if (notice === null) {
    await armNoticeRelease($)
    return null
  }
  const now = await $.clock.now()
  let holds = false
  await update($, heldNotices, cur => {
    const r = receive(cur, notice, e.text, now)
    holds = r.holds
    return r.held
  })
  await armNoticeRelease($)
  return holds ? heldReason(notice.taskId) : null
}

let noticeTimer: { cancel: () => void } | null = null

// One pending timer, a slice of the wait for the soonest held notice (a handle, so a module variable).
async function armNoticeRelease($: any): Promise<void> {
  const held = await read($, heldNotices)
  const wait = nextWakeMs(held, await $.clock.now())
  noticeTimer?.cancel()
  noticeTimer = wait === null ? null : $.clock.after(wait, () => detach($, 'Held sub-agent notice', releaseDueNotices($)))
}

// The held notices whose wait is over are told to the model, as a prompt a plugin sends (it wakes an idle session and queues behind a running turn).
async function releaseDueNotices($: any): Promise<void> {
  noticeTimer = null
  const now = await $.clock.now()
  let due: HeldNotice[] = []
  await update($, heldNotices, cur => {
    const split = splitDue(cur, now)
    due = split.due
    return split.rest
  })
  await armNoticeRelease($)
  for (const h of due) {
    const text = releasedText(h, now)
    const failure = await submitEvent($, text)
    if (failure !== null) notToldToast($, failure, text)
  }
}

// the texts the bundle tells for a finished tool call of a signed-in session: the matcher fields are the tool, its command and its path
async function toolBundleTexts($: any, e: any, budget: Budget): Promise<string[]> {
  if (!(await signedInWithAgent($))) return []
  const matchers: Record<string, string> = { tool_name: String(e.tool) }
  if (typeof e.command === 'string') matchers.tool_command = e.command
  const path = typeof e.file_path === 'string' ? e.file_path : typeof e.path === 'string' ? e.path : null
  if (path !== null) matchers.tool_path = path
  // a delivery that failed is told as the hold line (textsOrRefusal) and kept on the hold to be told again, never dropped
  const texts = [...textsOrRefusal(await tellEvent($, 'tool.before', e.agentId, budget, { matchers })), ...textsOrRefusal(await tellEvent($, 'tool.after', e.agentId, budget, { matchers }))]
  if (e.tool === 'Skill' && typeof e.skill === 'string') texts.push(...textsOrRefusal(await tellEvent($, 'skill.loaded', e.agentId, budget, { extra: { skill_name: e.skill } })))
  return texts
}

// a tool call's result is never stamped; the MAIN loop's result carries the session start, if any, the disk notice, and
// a finished sub-agent's reminder to record its result; a denied call has no result to put them beside. A call with an `agentId` is a sub-agent's or an engine fork's, and the start and the reminder are the main session's
async function onToolStamp($: any, e: any, next: any) {
  const budget = await hookBudget($)
  // a held agent context runs no tool but `session_connect`, which lets the person sign in again; the plugin's own calls are never held
  if (!raisedByPlugin(next.origin) && e.tool !== toolName('session_connect')) {
    const refusal = await refuseWhileHeld($, e.agentId, budget)
    if (refusal !== null) return { deny: refusal }
  }
  const r = await next(e)
  // a plugin's own `$.mcp.call` (this one's dashboard reads) is raised as a `tool.call` too, with no agentId. Its result goes to the plugin,
  // never the model, so the start text or a reminder put beside it is lost. The signal is the
  // documented `next.origin` (`e.origin` does not exist on tool.call): `engine` for the model's call, the plugin's name for one it raised (probed against the real engine). These calls also carry `toolu_plugin_` ids on 2.1.295, which is not relied on.
  // Returning here also skips the session start, the disk notice and the finished sub-agent's reminder, which would be lost. A test pins that it is seated.
  if (raisedByPlugin(next.origin)) return r
  // a background shell a ready-agent loop must not reset under, whether or not the loop is on yet: `reportShellEnds` clears the list
  if (r.deny === undefined && typeof r.result?.backgroundTaskId === 'string') {
    const started = r.result.backgroundTaskId as string
    await update($, readyShells, cur => (cur.includes(started) ? cur : [...cur, started]))
  }
  // the main loop's result carries the notes appended so far: they are read (a sub-agent's or a fork's result is not the main loop's)
  if (e.agentId === undefined && (await read($, turn)).pending.length > 0) await update($, turn, cur => toolResultSent(cur))
  // a background shell's start, and a working sub-agent's liveness
  detach($, '50 Arms activity report', reportShellStart($, e, r))
  if (e.agentId !== undefined) detach($, '50 Arms activity report', reportSubagentAlive($, e.agentId))
  if (r.deny !== undefined) return r
  // a sub-agent's compaction briefs that sub-agent, in its own tool result
  const briefing = e.agentId === undefined ? null : await takeAgentBriefing($, e.agentId, budget)
  // what the bundle tells at this call: the tool events (matched by the tool, its command and its path) and, for a skill, the skill's own
  const bundled = await toolBundleTexts($, e, budget)
  // a finished sub-agent's reminder to record its result is the MAIN session's, handed with its next action
  const stopped = e.agentId === undefined ? await subagentStopEntries($, budget) : []
  return { ...r, context: [...(r.context ?? []), ...(await noticeStartEntries($, e.agentId === undefined ? await takePendingStart($) : null, 'tool', e.agentId ?? MAIN_AGENT, budget)), ...(briefing === null ? [] : [briefing]), ...bundled, ...stopped] }
}

// what the dashboard says of this session's plan. `signed-out`: the session holds no usable key (never approved, or lapsed): a session start gives it the one sign-in invitation. `silent`:
// nothing can be said, never a line: a person revoked its key, or the agent gate holds it (its own tools already tell the model). `failed`: the read itself broke (a dashboard fault).
// `connected` carries the plan the session is on (the relay starts from it); `unreachable` is the plugin's server not connected yet (quiet to
// the model, retried by the relay's start).
type SessionPlan = { kind: 'connected'; planId: number } | { kind: 'not-connected' } | { kind: 'signed-out' } | { kind: 'silent' } | { kind: 'unreachable' } | { kind: 'failed'; reason: string; refusal?: Refusal }

// The ONE place a key that is gone or revoked is made quiet (its own tools say so, never a failure line): this read is the first of every
// context lookup, so a later read that finds the key gone in between is an ordinary failure line.
// a `GET /api/plan-sessions/me` answer that carries no `session` field at all (a null one is a session on no row) is malformed
const ME_NO_SESSION = 'bad_response: GET /api/plan-sessions/me answered no session field'
function meLacksSession(r: Api): boolean {
  return !('session' in (r.body ?? {}))
}

function meIsQuiet(r: Api): boolean {
  return isSignedOut(r) || outcomeRevokedBy(r) !== null || agentBlockOf(r) !== null
}

async function sessionPlan($: any): Promise<SessionPlan> {
  const r = await api($, 'GET', '/api/plan-sessions/me')
  if (r.unreachable === true) return { kind: 'unreachable' }
  if (isSignedOut(r)) return { kind: 'signed-out' }
  // the agent gate holds the session (no team agent yet, or a resume after the agent was released): quiet here, because the dashboard's 403 {state, instruction} on the model's first dashboard call is what tells the model what to do
  if (meIsQuiet(r)) return { kind: 'silent' }
  if (!r.ok) return { kind: 'failed', reason: errText(r), refusal: r.refusal }
  if (meLacksSession(r)) return { kind: 'failed', reason: ME_NO_SESSION }
  if (r.body.session === null) return { kind: 'not-connected' }
  const planId = r.body.session.plan_id
  // a registered session on no plan (it holds a team agent, a stand-alone card, or neither yet) is a row whose plan_id is null
  if (planId === null) return { kind: 'not-connected' }
  return typeof planId === 'number' ? { kind: 'connected', planId } : { kind: 'failed', reason: 'bad_response: GET /api/plan-sessions/me answered a session whose plan_id is neither a plan id nor null' }
}

// Whether the session is KNOWN to be on a plan without asking the dashboard: the connection record the dashboard MCP server writes
// at `session_connect` (`~/.config/danxbot/plan-sessions/<session id>.json`, only its existence is
// read). It decides who a dashboard fault speaks to: a connected session gets one warning line, any other stays silent.
async function isPlanConnected($: any, id: string, resolve: boolean = true): Promise<boolean> {
  const home = await homeDir($)
  const path = home === null ? null : sessionFilePath(home, 'plan-sessions', id)
  // an id that names no file has no connection record
  if (path === null) return false
  if (await $.fs.exists(path)) return true
  if (!resolve) return false
  // after a /clear the record is under the MCP server's own id
  const own = (await mcpSessionId($, id)).id
  return own !== id && $.fs.exists(sessionFilePath(home!, 'plan-sessions', own)!)
}

// The id the MCP server writes its per-session files under, for the engine's session `id`. Those files are named by the id the server booted with; a /clear changes `$.session.id()` and not the
// server's id (measured on claude.exe 2.1.308/2.1.309), so a reader that names a file by `$.session.id()` finds nothing after a /clear. Local first: when `id`'s own compaction file exists the server
// runs under `id` (no read). Otherwise, for the live session only, the dashboard's row of this session names the server's id (`sessionIdOf`), asked once and kept; a failed ask is retried after
// MCP_ID_RETRY_MS. Anything it cannot establish answers `id` itself, so the readers fail open exactly as before. An id other than the live one (a predecessor) cannot ask and is its own.
async function mcpSessionId($: any, id: string): Promise<{ id: string; fault: string | null }> {
  const home = await homeDir($)
  const own = home === null ? null : sessionFilePath(home, 'compaction', id)
  if (own === null || (await $.fs.exists(own)) || id !== String(await $.session.id())) return { id, fault: null }
  if ((await read($, bootEngineId)) === id) return { id, fault: null }
  const known = (await read($, mcpIds))[id]
  if (known !== undefined && 'id' in known) return { id: known.id, fault: null }
  const now = await $.clock.now()
  if (known !== undefined && now - known.failedAt < MCP_ID_RETRY_MS) return { id, fault: known.fault }
  let found: string | null = null
  let fault: string | null = null
  try {
    const me = await api($, 'GET', '/api/plan-sessions/me')
    // the same sorting as sessionPlan: a plugin server not there, a gone or revoked key and the agent gate are quiet (the engine's id stands); only a real dashboard fault is told
    if (me.unreachable === true || meIsQuiet(me)) {
      // nothing to say
    } else if (!me.ok) fault = errText(me).slice(0, TOAST_ERROR_MAX)
    else if (meLacksSession(me)) fault = ME_NO_SESSION
    else if (me.body.session !== null) found = sessionIdOf(me.body.session)
  } catch (err: any) {
    fault = errMessage(err).slice(0, TOAST_ERROR_MAX)
  }
  await update($, mcpIds, cur => ({ ...cur, [id]: found === null ? { failedAt: now, fault } : { id: found } }))
  return { id: found ?? id, fault: found === null ? fault : null }
}

// The home directory the session's MCP server keeps its per-session files under (`sessionFilePath`): HOME, else Windows' USERPROFILE; null when neither names one.
async function homeDir($: any): Promise<string | null> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  return typeof home === 'string' && home !== '' ? home : null
}

// TEMPORARY dual name. The text of each settings file that exists (user, project, local), read only; the plugin never writes them.
async function readLegacySettings($: any): Promise<string[]> {
  const home = await homeDir($)
  if (home === null) return []
  // any host that is neither Windows nor WSL joins with '/', as WSL does
  const kind = hostKindOf({ SystemDrive: await $.env.get('SystemDrive'), WSL_DISTRO_NAME: await $.env.get('WSL_DISTRO_NAME') } as any) ?? 'wsl'
  const paths = legacySettingsPaths({ kind, configDir: await $.env.get('CLAUDE_CONFIG_DIR'), home, cwd: await $.session.cwd() })
  const texts: string[] = []
  for (const path of paths) if (await $.fs.exists(path)) texts.push(String(await $.fs.read(path)))
  return texts
}

// What a session start's wait for the plugin's server came to: it is there, its environment was unloaded, or the deadline came first.
type ServerState = 'ready' | 'unloaded' | 'not-yet'

// A session START may reach its hook before the plugin's own server has connected: the server's `50arms_api` shows in the
// session's tool list once it has. Polled until `deadlineAt`, the hook's one deadline (its `Budget`), and not a tick
// after. A
// sub-agent's start is mid-session and does not call this.
async function serverState($: any, deadlineAt: number): Promise<ServerState> {
  const own = toolName('50arms_api')
  for (;;) {
    let names: string[]
    try {
      names = (await $.tool.list()).map((t: any) => t.name)
    } catch {
      // a tool list that cannot be read cannot say: the call itself will
      return 'ready'
    }
    if (names.includes(own)) return 'ready'
    const left = deadlineAt - (await $.clock.now())
    if (left <= 0) return 'not-yet'
    try {
      await $.clock.sleep(Math.min(SERVER_POLL_MS, left))
    } catch {
      // the wait rejects when the plugin's environment is unloaded (a reload): this start's lookup ends with it
      return 'unloaded'
    }
  }
}

// ONE deadline over the plugin's own work in a context lookup, as the bash hook's `timeout 8s` was: a hung dashboard answers `late()` instead of
// holding the start, however many reads the work makes (the plugin puts no time limit on one read, and whether the engine bounds one is UNVERIFIED).
async function withinDeadline<T>($: any, ms: number, work: Promise<T>, late: () => T): Promise<T> {
  let cancel = () => {}
  const timedOut = new Promise<T>(resolve => {
    const timer = $.clock.after(ms, () => resolve(late()))
    cancel = () => timer.cancel()
  })
  try {
    return await Promise.race([work, timedOut])
  } finally {
    cancel()
  }
}

const toldLine = (t: Told, failure: (reason: string) => string): string | null => {
  if (t.kind === 'text') return t.text
  return t.kind === 'failed' ? failure(t.reason) : null
}

// a session that is not on a plan (or has no key yet) but replaced one that was is told which plan and what waits there. The
// session's own dashboard server finds the earlier session and answers; its `restart_notice` tool works before sign-in and owns its
// lookup's 8 s deadline (a `lookup_timeout` stop carries the server's fix text), so the plugin sets no deadline of its own around the call. A stop
// it answers, or a call that fails, is one warning line, never quiet. The arguments depend on how the session started (restartAsk).
async function restartNotice($: any, asked: RestartAsk): Promise<string | null> {
  let told: Told
  if (asked.kind === 'failed') {
    told = asked
  } else {
    try {
      told = restartNoticeText(await $.mcp.call(SERVER, RESTART_NOTICE_TOOL, asked.args))
    } catch (err: any) {
      const message = String(err?.message ?? err)
      const refusal = classifierRefusal(message)
      // a refused call says the person's sentence, the session's line carries the fix
      told = { kind: 'failed', reason: refusal === null ? `error: ${message.slice(0, CALL_ERROR_MAX)}` : `${BLOCKED_LINE} ${refusal.fix}` }
    }
  }
  return toldLine(told, restartFailureLine)
}

// What the plugin's own reads of a session start came to: the line to tell, or that the restart notice is to be asked next.
type StartReads = { line: string | null; askRestart: boolean }

// A /clear: it has no event text, and it is a restart only when the session it ended was on a plan (that session's connection record is on disk),
// which is also what names the predecessor to the server. Any other clear is quiet, the server is never asked.
async function clearNotice($: any, start: NonNullable<PendingStart>, deadlineAt: number): Promise<string | null> {
  const ended = start.predecessorId
  if (ended === null || !(await isPlanConnected($, ended)) || (await isPlanConnected($, start.sessionId, false))) return null
  const server = await serverState($, deadlineAt)
  if (server === 'unloaded') return null
  if (server === 'not-yet') return restartFailureLine(SERVER_NOT_CONNECTED_REASON)
  return restartNotice($, { kind: 'ask', args: { predecessor_id: ended } })
}

// The reads a pending start asks of the dashboard: the wait for the plugin's server, the plan read and the event text read share ONE deadline, the hook's (`budget.deadlineAt`), which the hook's own bundle wait obeys too. A session
// the plan read finds signed in is told the event text, on a plan or not; one on no plan then also asks the restart notice. Whatever fails before
// the plan read answers, a session KNOWN to be on a plan (its record on disk) is told in one warning line; any other stays silent and, on a start
// or resume, still asks the restart notice, which is the server's own lookup and needs neither the dashboard read nor a key.
async function sessionContext($: any, start: NonNullable<PendingStart>, budget: Budget): Promise<string | null> {
  const event = startEventOf(start)
  // a clear a person typed is told the after-clear texts and, when it ended a session on a plan, the restart notice
  const clear = start.source === 'clear' && !isFreshStart(start) ? await clearNotice($, start, budget.deadlineAt) : null
  if (event === null) return clear
  const deadlineAt = budget.deadlineAt
  const connected = await isPlanConnected($, start.sessionId)
  // a sign-in's start is the same session going on: it asks no restart notice; a compaction and a clear are the same session too
  const askRestart = start.source !== 'compact' && start.source !== 'clear' && start.source !== SIGN_IN_SOURCE && !isFreshStart(start)
  // THE owner of "this start is owed": the first caller owes it and holds the context (the loading line), every later one finds the flag set and owes nothing, so the start is owed exactly once on every ordering
  // of the deadline fallback, the plan read's answer and the slot reads. The flag is set before any await.
  let owed = false
  const oweOnce = async (failure: Failure): Promise<string | null> => {
    if (owed) return null
    owed = true
    return owedStart($, event, failure)
  }
  // a start the plugin cannot read for: a session known to be signed in has no bundle for this context, so the start is owed and the context held (the loading line); any other stays silent
  const fault = async (failure: Failure): Promise<StartReads> => ({ line: connected || (await signedInWithAgent($)) ? await oweOnce(failure) : null, askRestart: !connected && askRestart })
  const server = await serverState($, deadlineAt)
  if (server === 'unloaded') return clear
  if (server === 'not-yet') return joined([(await fault(fetchFailureOf({ status: 0, body: {}, serverNotConnected: true, classifierRefused: false, keyRevoked: false, staleMcp: false, relayDown: await relayDownOf($) }))).line, clear])
  // set when the deadline passes: the reads then go on in the background and tell nothing, since their texts would be used up with nobody to read them
  let expired = false
  const reads = async (): Promise<StartReads | null> => {
    const plan = await sessionPlan($)
    // a key that works asks for the start texts now; one that does not leaves the conversation owing them (giveOwedMantra)
    if (plan.kind !== 'failed' && plan.kind !== 'unreachable') await update($, mantraOwed, () => plan.kind === 'signed-out' || plan.kind === 'silent')
    // the bundle read waits only for what is left of the deadline: a lookup that ended after it would decide the start (count its once-only texts told) with no hook left to show them
    const left = deadlineAt - (await $.clock.now())
    // the plan read has said the session is signed in: a start given up from here, in time or late, is owed on that answer, whatever the view or the connection record say (`fault` owes only on those); the flag says whether the fallback already did
    const gaveUp = async (): Promise<StartReads | null> => ({ line: await oweOnce(timeoutFailure(await relayDownOf($))), askRestart: false })
    const signedIn = plan.kind === 'connected' || plan.kind === 'not-connected'
    if (expired || left <= 0) return signedIn ? gaveUp() : null
    if (signedIn) {
      // the bundle's texts for this start; a session on no plan also asks the restart notice, if it replaced one that was on a plan
      const outcome = await tellEvent($, event, null, budget, { owes: true, waitMs: left, abandoned: async () => expired || deadlineAt - (await $.clock.now()) <= 0 })
      if (outcome.kind === 'abandoned') return gaveUp()
      return { line: textsOrRefusal(outcome).join('\n') || null, askRestart: plan.kind === 'not-connected' && askRestart }
    }
    if (plan.kind === 'failed') return fault({ reason: 'fetch_failed', detail: `the session could not be read (${plan.reason.slice(0, CALL_ERROR_MAX)})`, values: {} })
    // a signed-out resume is the one a restart leaves without a key: the notice is for it. A signed-out startup carries the one invitation to sign in and nothing else: no notice, no lookup, no failure line
    if (plan.kind === 'signed-out') return start.source === 'startup' ? { line: SIGN_IN_INVITATION, askRestart: false } : { line: null, askRestart }
    return { line: null, askRestart }
  }
  // `null`: the deadline passed, whether its timer fired first or a read ended after it
  const done = await withinDeadline<StartReads | null>($, Math.max(deadlineAt - (await $.clock.now()), 0), reads(), () => {
    expired = true
    return null
  })
  // reads that outlast the hook's deadline: the start is owed and the context held (AC 72591), never dropped; no restart notice, which has its own 8 s
  if (done === null) return joined([(await fault(timeoutFailure(await relayDownOf($)))).line, clear])
  const notice = done.askRestart ? await restartNotice($, restartAsk(start)) : null
  return joined([done.line, notice, clear])
}

const joined = (lines: (string | null)[]): string | null => lines.filter((l): l is string => l !== null).join('\n') || null

// A start the plugin could not read for: the context is held with the failure, the start is owed, and the line told is the loading line (never nothing).
async function owedStart($: any, event: string, failure: Failure): Promise<string> {
  const at = await $.clock.now()
  let hold!: Hold
  await update($, behavior, cur => {
    const holds = holdOn(cur.holds, mainContext, failure, event, at)
    hold = holds[mainContext] as Hold
    return { ...cur, holds, owed: owe(cur.owed, mainContext, event) }
  })
  keepRetrying($)
  return refusalOf(hold, at)
}

// the entries still within COMPACTING_NOTE_TTL_MS
function liveCompacting(cur: CompactingState, now: number): CompactingState {
  const fresh = (at: number) => now - at <= COMPACTING_NOTE_TTL_MS
  return { main: cur.main !== null && fresh(cur.main) ? cur.main : null, agents: Object.fromEntries(Object.entries(cur.agents).filter(([, a]) => fresh(a.at))) }
}

// A `compact` restart. The main agent is briefed when it has an entry (consumed here), or when no agent has one (a compaction nobody noted, the unattributable kinds); a restart that only
// sub-agents account for briefs nobody here: each of them is told on its own first tool result, whichever restart came first. `briefsMain` says whether the main agent is briefed;
// `own` says the main agent's OWN entry was consumed: the only proof the main agent was compacted, since the fallback also fits an unattributed sub-agent compaction.
async function restartBriefsMain($: any): Promise<{ briefsMain: boolean; own: boolean }> {
  const now = await $.clock.now()
  let result = { briefsMain: true, own: false }
  await update($, compacting, cur => {
    const live = liveCompacting(cur, now)
    result = { briefsMain: live.main !== null || Object.keys(live.agents).length === 0, own: live.main !== null }
    return { ...live, main: null }
  })
  return result
}

async function noteCompacting($: any, agentId: string | null): Promise<void> {
  const now = await $.clock.now()
  await update($, compacting, cur => {
    const live = liveCompacting(cur, now)
    return agentId === null ? { ...live, main: now } : { ...live, agents: { ...live.agents, [agentId]: { at: now, done: false } } }
  })
}

// The compaction of this agent finished (`done`), or did not happen (skipped, or failed: the entry goes).
async function settleCompacting($: any, agentId: string | null, completed: boolean): Promise<void> {
  const now = await $.clock.now()
  await update($, compacting, cur => {
    if (agentId === null) return completed ? cur : { ...cur, main: null }
    const entry = cur.agents[agentId]
    if (entry === undefined) return cur
    const { [agentId]: _gone, ...rest } = cur.agents
    return { ...cur, agents: completed ? { ...rest, [agentId]: { at: now, done: true } } : rest }
  })
}

async function forgetCompactingAgent($: any, agentId: unknown): Promise<void> {
  if (typeof agentId !== 'string' || agentId === '') return
  await update($, compacting, cur => {
    if (!(agentId in cur.agents)) return cur
    const { [agentId]: _gone, ...rest } = cur.agents
    return { ...cur, agents: rest }
  })
}

// the briefing of the sub-agent whose tool result this is, once its own compaction finished: once, to that sub-agent only, and only when the session is on a plan (an unconnected
// session gets no 50 Arms text at all). The engine's list names its type and task; a list that fails is toasted and the briefing names the id alone.
async function takeAgentBriefing($: any, agentId: string, budget: Budget): Promise<string | null> {
  const now = await $.clock.now()
  let waiting = false
  await update($, compacting, cur => {
    const live = liveCompacting(cur, now)
    waiting = live.agents[agentId]?.done === true
    if (!waiting) return live
    const { [agentId]: _taken, ...rest } = live.agents
    return { ...live, agents: rest }
  })
  if (!waiting || !(await signedInWithAgent($))) return null
  let listed: { id: string; type: string; description: string }[] = []
  try {
    listed = await $.agent.list()
  } catch (err: any) {
    $.ui.toast(`The sub-agent briefing could not read the agent list: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`)
  }
  const found = listed.find(a => a.id === agentId)
  // the sub-agent's own compaction, told to it by its id: the bundle's texts for the event, owed and held like a start when there is no bundle
  // the sub-agent's own context size (`context_tokens`) is the last one its model requests noted; none is a slot left unfilled and named
  const size = agentSizes.get(subagentKey(agentId))
  const outcome = await tellEvent($, 'subagent.compacted', agentId, budget, { owes: true, extra: { sub_agent_id: agentId, sub_agent_name: found === undefined ? agentId : `${found.type} ${found.description}`.trim(), ...(size === undefined ? {} : { context_tokens: String(size.tokens) }) } })
  return textsOrRefusal(outcome).join('\n\n') || null
}

// SessionStart: the session title is noted and the start is recorded for the next prompt or tool result. The session is not bound yet on a
// desktop or headless startup, resume or fork, so no `$.mcp.call` or `$.tool.list` here (the next prompt or tool result tells the model, see noticeStartEntries).
// The one exception: a compaction that ends with no turn running detaches the resume prompt, whose reads wait for the session to bind.
async function onClassicSessionStart($: any, e: any, next: any) {
  // first, so every read below (the ended session, the start's own `loopReset`) sees what the ended conversation held
  await restoreCarried($, e.source)
  const below = await onTitle($, e, next)
  const path = typeof e.transcript_path === 'string' ? e.transcript_path : null
  // the ended session is consumed by this start only: a later clear that saw no end must not be asked about this one's
  const ended = await takeEndedSession($)
  lastStartSource = typeof e.source === 'string' ? e.source : null
  // a restart only sub-agents account for is theirs to be briefed about; the main agent's pending start is for its own compaction (and every other start, and a restart nobody noted)
  const restart = e.source === 'compact' ? await restartBriefsMain($) : { briefsMain: true, own: false }
  // every start, a sub-agent's compaction included, loses what the model was told: the disk notice is told again and measured afresh
  await update($, diskTold, () => ({}))
  await update($, diskMeasured, () => null)
  // the rebase line is told again too: the dashboard's version stays, the comparison starts over
  await update($, appVersion, cur => ({ ...cur, checked: null }))
  if (!restart.briefsMain) return below
  const loopResetting = (await read($, readyLoop))?.phase === 'resetting'
  // a process's first start is read after the carried values are back, so a /clear (which carries it) is never one
  const firstOfProcess = !(await read($, startSeen))
  await update($, startSeen, () => true)
  const clearedHolds = await takeCompactionClearMark($, e, firstOfProcess)
  const clearedForCompaction = clearedHolds !== null
  const start: NonNullable<PendingStart> = {
    sessionId: e.session_id,
    source: e.source,
    transcriptPath: path,
    predecessorId: ended,
    ...(loopResetting && e.source === 'clear' ? { loopReset: true as const } : {}),
    ...(clearedHolds !== null ? { compactionClear: true as const, reconnect: clearedHolds.holds } : {}),
  }
  await update($, pendingStart, () => start)
  // a compaction that ends while no turn runs (the plugin's own after a ready, or a typed /compact) leaves nothing to carry the briefing: the plugin starts the turn, but only for
  // the main agent's OWN compaction (`restart.own`). A restart with no entry at all (an unattributed sub-agent compaction, a host without session.compact) is briefed passively and starts no turn.
  // The isRunning read is a deliberate fast path: a running turn carries the briefing on its next tool result, with no reads or take here.
  // The same for a compaction by clear: the new conversation holds nothing, so the plugin starts its turn with the resume briefing (only a plan-connected session gets one, as for a compaction).
  if ((restart.own || clearedForCompaction) && !(await read($, turn)).isRunning) detach($, 'Resume after compaction', resumeAfterCompaction($))
  return below
}

// `session_connect` to each target a cleared session held, as the model would; the refusals, one per target that did not connect. The plan view is read again either way.
async function reconnectHeld($: any, targets: string[]): Promise<string[]> {
  const failed: string[] = []
  for (const target of targets) {
    try {
      const outcome = connectToolOutcome(await $.mcp.call(SERVER, 'session_connect', { target }))
      if (!outcome.ok) failed.push(`${target}: ${refusalText(outcome)}`)
    } catch (err: any) {
      failed.push(`${target}: ${errMessage(err).slice(0, CALL_ERROR_MAX)}`)
    }
  }
  detach($, 'Plan refresh', refresh($, true))
  return failed
}

// the main agent's resume prompt, by the relay's one prompt path (submitEvent). Only a session on a plan gets one (its connection record is on disk, as
// isPlanConnected says; any other session stays quiet). The pending start is TAKEN first, so the briefing it renders is in this prompt and the prompt's own
// stamp hook finds none (told once). A turn that began while the reads ran is the person's: the built briefing goes into that running turn as a note (no prompt queues
// behind it); a note the session refuses puts the start back for the next tool result. A prompt the session refuses puts it back the same way.
async function resumeAfterCompaction($: any): Promise<void> {
  // checked before the start is taken: a session that is not on a plan leaves it for the prompt or tool result that tells it (or nothing)
  const pending = await read($, pendingStart)
  if (pending === null) return
  const owed = pending.reconnect ?? []
  const connected = await isPlanConnected($, pending.sessionId)
  if (!connected && owed.length === 0) return
  const start = await takePendingStart($)
  if (start === null) return
  // a clear that left the session unconnected (the new conversation has no connection record): it is connected again to what it held, and told when that was refused
  const reconnectFailures = connected ? [] : await reconnectHeld($, owed)
  // the briefing is the bundle's texts for the start (the loading line when there is no bundle: the start is owed and told when one arrives); a start that said nothing starts no turn
  const briefing = await renderStart($, start, await hookBudget($))
  if (briefing === null) return
  const text = reconnectFailures.length === 0 ? briefing : `${briefing}
The clear left you unconnected and reconnecting failed (${reconnectFailures.join('; ')}): call session_connect for what you held first.`
  if ((await read($, turn)).isRunning) {
    // by the relay's one note path, so a turn that ends with no tool result after it still tells the briefing as a prompt
    if ((await appendTrackedNote($, text)) !== null) await restoreStart($, start)
    return
  }
  const failure = await submitEvent($, relayLine(text))
  if (failure === null) return
  // the session did not take the prompt: the briefing is still owed, to the next prompt or tool result
  await restoreStart($, start)
  $.ui.toast(`The resume prompt was not taken by the session: ${failure}`.slice(0, TOAST_ERROR_MAX))
}

// A start taken for a briefing that was not delivered goes back (unless a newer start has arrived meanwhile): the next prompt or tool result tells it.
async function restoreStart($: any, start: NonNullable<PendingStart>): Promise<void> {
  await update($, pendingStart, cur => cur ?? start)
}

// the new sub-agent also gets 50 Arms' pacing line (additionalContext), when 50 Arms has one for this session
// and, first, the registry's sub_agent_start text when its parent session is on a plan
async function onSubagentStart($: any, e: any, next: any) {
  await noteRunningAgent($, e.agent_id, true)
  if (typeof e.agent_id === 'string' && e.agent_id !== '') {
    const now = await $.clock.now()
    await update($, agentBriefs, cur => briefClaimed(cur, e.agent_id, now))
  }
  const r = await onSubagentChange($, e, next, true)
  // its activity row opens
  detach($, '50 Arms activity report', reportSubagentStart($, e))
  const started = (await signedInWithAgent($)) ? textsOrRefusal(await tellEvent($, 'subagent.start', e.agent_id, await hookBudget($), { owes: true, extra: { sub_agent_id: String(e.agent_id), profile: String(e.agent_type ?? ''), ...(pacingLevel(await $.clock.now()) === null ? {} : { pacing_level: pacingLevel(await $.clock.now()) as string }) } })) : []
  const pacing = await pacingLine(pacingEnv($))
  return withLine(started.reduce((acc, text) => withLine(acc, text), r), pacing)
}

// a sub-agent's brief ends; its cards stay worked for a few minutes (briefRecent)
async function endBrief($: any, agentId: string) {
  const now = await $.clock.now()
  const briefs = await read($, agentBriefs)
  await update($, recentBriefs, cur => briefRecent(cur, briefs, agentId, now))
  await update($, agentBriefs, cur => briefEnded(cur, agentId))
}

// The background-wait guard's one-toast-per-reason memory: the same fault (a missing transcript path, an unreadable file) is told once, not at every sub-agent stop.
let bgWaitFaultTold: string | null = null
const bgWaitFault = ($: any, reason: string) => {
  if (bgWaitFaultTold === reason) return
  bgWaitFaultTold = reason
  $.ui.toast(`50 Arms sub-agent background-wait check skipped: ${reason}`)
}

// What a stopping sub-agent's own transcript says about the background work it started (reports/bg-wait-guard.ts), or null when the check could not be made. It reads the sub-agent's OWN
// transcript (`agent_transcript_path`; the event's `transcript_path` is the main session's and holds none of its lines, so there is never a fallback to it). A missing path, a missing or
// unreadable file is one toast and the stop goes on, never a block on a guess. A moved run's output file counts only when it exists and was written at or after the Bash call (`$.fs.stat`'s mtimeMs).
async function bgWaitVerdictOf($: any, e: any): Promise<Verdict | null> {
  const path = e.agent_transcript_path
  if (typeof path !== 'string' || path === '') return bgWaitFault($, 'the SubagentStop event has no agent_transcript_path'), null
  try {
    if (!(await $.fs.exists(path))) return bgWaitFault($, `agent_transcript_path does not exist: ${path}`), null
    const { lines, texts } = parseTranscript(String(await $.fs.read(path)))
    const existing = new Map<string, number>()
    for (const out of movedOutputPaths(lines)) {
      // a file that cannot be read (a quote naming a path this host never had) is a file this host does not have
      const stat = await $.fs.stat(out).catch(() => null)
      if (stat !== null) existing.set(out, stat.mtimeMs)
    }
    let verdict: Verdict = { kind: 'pass' }
    await update($, bgWaitCounts, cur => {
      const decided = bgWaitVerdict({ lines, texts, agentId: e.agent_id, sessionId: String(e.session_id ?? ''), stopHookActive: e.stop_hook_active === true, existing, counts: cur })
      verdict = decided.verdict
      return decided.counts
    })
    return verdict
  } catch (err: any) {
    bgWaitFault($, `reading the transcript failed (${String(err?.message ?? err).slice(0, CALL_ERROR_MAX)})`)
    return null
  }
}

async function onSubagentStop($: any, e: any, next: any) {
  // a refused stop is no stop: the sub-agent goes on, so none of the bookkeeping below happens. The refusal follows the other Stop blocks (the chain runs, then the block is merged in)
  const verdict = typeof e.agent_id === 'string' && e.agent_id !== '' ? await bgWaitVerdictOf($, e) : null
  if (verdict?.kind === 'refuse') return { ...(await next(e)), block: verdict.reason }
  // the third refusal in a row was spent: the stop goes through, and the person is told which run is left behind
  if (verdict?.kind === 'left_behind') $.ui.toast(leftBehindLine(verdict.runs))
  await noteRunningAgent($, e.agent_id, false)
  const id = typeof e.agent_id === 'string' && e.agent_id !== '' ? e.agent_id : null
  const agent = id === null ? undefined : (await read($, spawnedAgents))[id]
  const by = announcedBy(agent)
  // read before the brief ends: it names the cards a foreground agent's finish carries
  const cards = id === null || by !== 'stop' ? [] : ((await read($, agentBriefs)).byAgent[id] ?? [])
  // a background agent's brief stays until its final notice ends it: a stop is no end for it (it fires at every turn's end, and the agent may only be waiting on background work)
  if (id !== null && by !== 'notice') await endBrief($, id)
  // a foreground sub-agent's stop is its real end: a hold it still has is released and reported, its owed texts dropped. A background one's stop fires at every turn end while it lives; its real end is its final notice (finishNoticeLabel). An agent never recorded as spawned has no known end.
  if (id !== null && agent !== undefined && !agent.background) await endAgentContext($, id, false)
  const r = await onSubagentChange($, e, next, false)
  // the shells' ends (its own row closes at its turn.complete)
  detach($, '50 Arms shell-end report', reportShellEnds($, 'SubagentStop', e))
  // the finish is for the MAIN session that started the sub-agent: context a SubagentStop hook returns goes back to the stopping sub-agent and wakes it for a turn, and a message of
  // its own to the main session costs a turn per sub-agent. It is owed here and handed with the main session's next tool result or prompt (subagentStopEntries), one text for all that finished.
  // Only a foreground sub-agent's stop is its finish (announcedBy): a background one's is its task notice (finishNoticeLabel), which the engine sends only when no work of its own is left.
  if (by === 'stop' && agent !== undefined && id !== null && (await signedInWithAgent($))) {
    const finished = { id, label: finishedAgentLabel(id, agent, cards) }
    await update($, finishedAgents, cur => [...cur, finished])
  }
  return r
}

// A final task notice for a sub-agent the main loop spawned in the background is that agent's finish (an interim notice is held before it gets here): the
// finish rides the notice's own prompt (with the registry's `sub_agent_stop` text). The agent's brief ends with it, so a resume that ends again names no stale card.
async function finishNoticeLabel($: any, notice: TaskNotice | null): Promise<FinishedAgent[]> {
  if (notice === null || notice.interim) return []
  const agent = (await read($, spawnedAgents))[notice.taskId]
  if (announcedBy(agent) !== 'notice' || agent === undefined) return []
  // the final notice is a background sub-agent's real end: its holds and owed texts end with it, a hold past the hold line reported
  await endAgentContext($, notice.taskId, true)
  if (!(await signedInWithAgent($))) return []
  const cards = (await read($, agentBriefs)).byAgent[notice.taskId] ?? []
  await endBrief($, notice.taskId)
  return [{ id: notice.taskId, label: finishedAgentLabel(notice.taskId, agent, cards) }]
}

// the main loop's turn ended (a sub-agent's `turn.complete` carries its agentId and is not this).
async function onTurnComplete($: any, e: any, next: any) {
  const r = await next(e)
  if (e.agentId === undefined) {
    // a break is waiting for this turn end: the record shows the host raised the event (a missing turn-complete after a flag-set means it did not, or a step below threw before the decision)
    if (clearAtBreak) await noteBreak($, 'turn-complete', { isAborted: e.isAborted === true, reason: e.reason })
    // `prompts` is set inside the updater, which sees the turn as it is when the write happens
    let prompts = [] as string[]
    await update($, turn, cur => {
      const ended = turnEnded(cur, e.isAborted === true)
      prompts = ended.prompts
      return ended.turn
    })
    // detached: the turn.complete hook does not wait on the session taking a prompt
    if (prompts.length > 0) detach($, 'Telling the session', promptNotes($, prompts))
    await reportTurnActivity($, 'idle')
    // a sub-agent's end is not the session going idle
    await armKeepalive($, false)
    // the agent's ready, said during this turn, starts the compaction now that the turn is over
    await syncCompaction($, { start: true })
    await clearAtNaturalBreak($)
    // a person's Stop takes the session off the ready list; any other turn's end is when finished work is noticed
    if (e.isAborted === true && (await read($, readyLoop)) !== null) detach($, 'Ready list', leaveReady($, READY_STOPPED))
    else detach($, 'Ready list', syncReady($))
    await syncTitleOnTurn($)
  } else {
    // a sub-agent's turn ended, cleanly or not: its activity row closes
    detach($, '50 Arms activity report', reportSubagentEnd($, e.agentId))
    await noteRunningAgent($, e.agentId, false)
  }
  detach($, 'Plan refresh', refresh($))
  void watchRelay($)
  return r
}

// the main loop's turn began. Turn.start also fires for a sub-agent's turn and an engine fork (they carry an agentId), and only the main loop's
// turn.complete clears the turn state, so a sub-agent's start is no part of the main loop's state: it would leave isRunning true and the resume prompt unsent.
async function onTurnStart($: any, e: any, next: any) {
  if (e.agentId !== undefined) return next(e)
  // a look of the ready loop acts on nothing it read before a turn began (lookGoesOn)
  readyTurns++
  cancelKeepalive()
  const since = await read($, idleSince)
  const now = await $.clock.now()
  // a running turn is no idle period; a reload that finds one running resumes from nothing (armKeepalive), never from the last turn's end
  await update($, idleSince, () => null)
  if (keepalivePlan !== null && since !== null && now >= since + KEEPALIVE_GIVE_UP_MS) detach($, 'Plan tab re-check', recheckTab($))
  await update($, turn, () => turnStarted())
  await reportTurnActivity($, 'in_turn')
  await syncCompaction($, { start: false })
  await syncTitleOnTurn($)
  return next(e)
}

// The app's session title (without any mark), handed to `session_connect`; and the main transcript's path. The answer's `sessionTitle` sets
// the marks (sessionTitle) on Claude Code's own title, the one a terminal shows; the desktop app's title is syncTitleMark's.
async function onTitle($: any, e: any, next: any) {
  await noteTranscript($, e)
  const held = typeof e.session_title === 'string' ? e.session_title.trim() : ''
  // a session start or a prompt: the session is about to act, so its turn counts as running (the waiting mark follows the turn's end)
  const marked = held ? sessionTitle(held, await read($, view), await read($, relay), { ...(await titleActivity($)), turnRunning: true }) : ''
  const t = unmarkedTitle(held)
  // on a desktop session the app's title, which syncTitleMark keeps in `title`, is the latest; the event's copy may be older
  if (t && (!(await read($, desktopHosted)) || (await read($, title)) === null)) await update($, title, () => t)
  const below = await next(e)
  return marked && marked !== held ? { ...below, sessionTitle: marked } : below
}

// a prompt also checks the desktop app's title, which may have been renamed since the last load (a session start does not: the session is not
// bound yet, so `$.mcp.call` throws there)
async function onPromptTitle($: any, e: any, next: any) {
  const r = await onTitle($, e, next)
  detach($, 'The session title mark', syncTitleMark($))
  return r
}

// the events warning's reason, toasted once on the transition into the warning (a redraw that shows the same warning says nothing).
// One pass: read the view and relay, compute the warning, store it atomically, toast if the update changed it. The update cannot read those two
// atoms itself, so a snapshot that went stale between the read and the update can only repeat one toast or miss one, never store a wrong warning
// for long: the next write path (a load or a relay state change) computes it again from the latest state.
async function noteEventsWarning($: any): Promise<void> {
  const v: PlanView = await read($, view)
  const relayState: RelayState = await read($, relay)
  const warning = eventsWarning(v, relayState)
  let changed = false
  await update($, eventsWarned, cur => {
    changed = cur !== warning
    return warning
  })
  if (!changed) return
  const reason = eventsReason(v, relayState)
  if (reason !== null) $.ui.toast(reason.slice(0, TOAST_ERROR_MAX))
}

async function drawBand($: any, e: any, next: any) {
  if (e.props.hasSurvey) return next(e)
  const v = await read($, view)
  // a dismissed band draws nothing, whatever the connection (the footer button brings it back)
  if (await read($, dismissed)) return next(e)
  const permissions = await read($, permissionRequests)
  const newestPermission = permissions.at(-1)
  const relayState: RelayState = await read($, relay)
  const heldInput = relayState.phase === 'held' && v.connected !== null && relayState.planId === v.connected.id ? HELD_FOR_INPUT_BAND : null
  // a report to 50 Arms that failed loudly shows here for the rest of the session
  const held = heldInput ?? bandLine((await read($, behavior)).queue)
  return renderBand(
    $.ui.resolve(e),
    handlers($),
    v,
    e.surface === DESKTOP_SURFACE,
    await read($, busy),
    newestPermission === undefined ? null : { count: permissions.length, newest: asApproval(newestPermission) },
    await read($, signInRequest),
    e.props.bodyColumns,
    held,
    await read($, machineRegistration),
  )
}

// The footer: the engine's own mode labels (next) stay, with ONE plan button beside them. Nothing
// to say (loading) leaves the site untouched; no MCP server reads `50 Arms · off`.
async function drawSessionMode($: any, e: any, next: any) {
  const v = await read($, view)
  const label = footerLabel(v)
  if (label === null) return next(e)
  return renderFooter($.ui.resolve(e), handlers($), label, footerTone(v), await next(e), e.surface)
}

// 50 Arms refs in an assistant reply drawn as links to the dashboard's ref redirect. Reads only the `view` atom (filled at refresh): no network in the draw.
// The text is rewritten in the props and handed on (the engine's type declarations, ui.render: "rewrite `props`"), so the engine's own drawing
// and any hook below stay in effect; the stored message is untouched, and `onScreen` rides along as received. Nothing to link
// (the view not loaded, no dashboard origin known, no ref in the text) leaves the event as it is.
async function drawAssistantMessage($: any, e: any, next: any) {
  const v = await read($, view)
  // a view not loaded or with no dashboard origin: the reply is drawn as written. So is a text that is not a string (the engine's declarations type it `string`;
  // this only guards the engine one day sending a block with none, which `linkRefs` would throw on)
  if (v.phase !== 'ready' || v.dashboardUrl === null || typeof e.props.text !== 'string') return next(e)
  const text = linkRefs(e.props.text, v.dashboardUrl, v.connected?.id ?? null)
  return next(text === e.props.text ? e : { ...e, props: { ...e.props, text } })
}

// The dashboard server this session has now (serverOf, hooks/plan/server.ts, reads the session's tool list). A session with neither name, or a list
// that cannot be read (the engine has not bound the session yet), is the plugin's own name: the call then fails as the engine's "no such server",
// which the pacing claim waits out and then refuses (the strict cap). Nothing is remembered: the list is the live state.
async function liveServer($: any): Promise<string> {
  try {
    return serverOf((await $.tool.list()).map((t: any) => t.name)) ?? SERVER
  } catch {
    return SERVER
  }
}

// the model and effort a plugin's own agent type runs on: what its agent file (`agents/<name>.md` under the plugin's root) names, null for each it names none.
// Another type's are not read here (undefined: they cannot be told), since only this plugin's agent files are in reach.
async function ownAgentGrade($: any, subagentType: string): Promise<{ model: string | null; effort: string | null } | undefined> {
  const file = ownAgentFile($.plugin.name, $.plugin.root, subagentType)
  if (file === null) return undefined
  const text = String(await $.fs.read(file))
  return { model: agentFileModel(text) ?? null, effort: agentFileEffort(text) ?? null }
}

// every agent type this plugin defines: each `.md` file under `agents/` of the plugin's root, with the model and effort it names (the same read as ownAgentGrade).
async function ownAgentTypes($: any): Promise<{ type: string; model: string | null; effort: string | null }[]> {
  const dir = `${$.plugin.root}/agents`
  const entries = await $.fs.list(dir)
  return Promise.all(
    entries
      .filter((f: any) => f.kind === 'file' && f.name.endsWith('.md'))
      .map(async (f: any) => {
        const text = String(await $.fs.read(`${dir}/${f.name}`))
        return { type: `${$.plugin.name}:${f.name.slice(0, -3)}`, model: agentFileModel(text) ?? null, effort: agentFileEffort(text) ?? null }
      }),
  )
}

// the engine calls the pacing guard makes, as closures (the engine follows `$` only into a function in this file).
function pacingEnv($: any) {
  return {
    agentGrade: (subagentType: string) => ownAgentGrade($, subagentType),
    ownAgentTypes: () => ownAgentTypes($),
    now: () => $.clock.now(),
    within: <T,>(ms: number, work: Promise<T>, late: () => T) => withinDeadline($, ms, work, late),
    // the pacing calls go to the server the session has: a dispatched agent's is `platform`, not the plugin's (DASHBOARD_SERVERS)
    call: async (method: string, path: string, body?: object, query?: object) => api($, method, path, { ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) }, await liveServer($)),
    reading: () => currentUsageBody($),
    signedIn: async () => dashboardAnswered || isSignedIn(await read($, view)),
    sleep: (ms: number) => $.clock.sleep(ms),
    toast: (text: string) => $.ui.toast(text),
    // the hourglass is the title's: a change of the slot-refused state redraws it (desktop; a terminal's title follows at each prompt)
    onSlotChange: () => detach($, 'The session title mark', syncTitleMark($)),
  }
}

// the session's usage reading right now, as the usage report's body, for the spawn claim to carry. A spawn is a model tool call, so the
// harness holds windows from an API response by then; `measuredAt` (the last response the main thread's measure event saw) may not be set yet in a
// session's very first turn, and the reading is then measured now. Null when the reading fails or has no window; never rejects.
async function currentUsageBody($: any): Promise<UsageBody | null> {
  try {
    const now = await $.clock.now()
    const limits = (await $.session.usage()).rateLimits
    return usageBody(limits, now, (await read($, measuredAt)) ?? now, await $.env.get('CLAUDE_CODE_ACCOUNT_UUID'))
  } catch {
    return null
  }
}

// the reports. A plan session tells the dashboard what it is running (activity rows) and has
// its stop checked for ready cards. Every call goes through the session's own server (`api`) and runs detached, so no event
// waits on it; a report the dashboard does not take is one toast, never swallowed (`report`).
//
// What each needs of the state the module holds (`reportingState`):
// - OPENING something (a sub-agent's row, a shell's row, a liveness post) needs the session known to be signed in (`on`): on a plan or not
//   (a sub-agent is a row of the account's running-agent count, plan or not; the dashboard opens the session's dispatch for it).
// - CLOSING what was opened (a sub-agent's finish, a shell's end) is owed because its start was posted, so it is posted whatever the view
//   says, while it is `unknown` too (a failed refresh empties the view's plan for a moment; a stuck row would be exactly a close
//   that never went out). Only `off` drops it: the key was revoked, and the dashboard refuses every report from it.
// - The ready-cards check runs unless `off`: its own read asks the dashboard which plan the session is on.

// `on`: the view holds the plan the session is on, or the session is signed in on no plan. `off`: a person revoked its key. `unknown`:
// nothing is known (loading, a failed load, a session signed out with its key lapsed).
type ReportingState = 'on' | 'off' | 'unknown'
async function reportingState($: any): Promise<ReportingState> {
  const v = await read($, view)
  if (v.connected !== null) return 'on'
  // a signed-in session on no plan reports its sub-agents too: they are rows of the account's running-agent count, plan or not
  if (isSignedIn(v)) return 'on'
  return v.phase === 'key-revoked' ? 'off' : 'unknown'
}

// A plan state that is `off` takes the reports' memory with it: nothing opened under the plan can be closed from here any more.
async function forgetReports($: any): Promise<void> {
  await update($, reports, () => ({ agents: {}, shells: [], planId: null }))
}

// The plan a new row opens under: the one the view holds, or null when the session is not known to be on one (nothing opens then).
async function openingPlan($: any): Promise<number | null> {
  return (await read($, view)).connected?.id ?? null
}

// What the closes before a leave came to: the memory they took, how many rows they posted, and whether the dashboard took them.
type LeaveCloses = { owed: ReportState; rows: number; posted: boolean }

const activities = (n: number) => `${n} running activit${n === 1 ? 'y' : 'ies'}`

// before the session leaves its plan or moves to another, every close it owes (a running sub-agent's finish, an
// open shell's end) is posted, in one call: after the leave the dashboard takes no report from it, and rows left running would stay stuck.
// Bounded by LEAVE_CLOSE_DEADLINE_MS so a dead dashboard never holds
// the leave; a failure is one toast naming what may stay running, and the leave goes on. The memory is cleared first, so a sub-agent's turn.complete racing the leave
// posts nothing twice. `why` names the leave in the toast. The caller hands the answer to `leaveDidNotHappen` when the leave failed.
async function closeOwedBeforeLeave($: any, why: string): Promise<LeaveCloses> {
  const owed = await read($, reports)
  await forgetReports($)
  const now = await $.clock.now()
  const rows = [...Object.keys(owed.agents).map(id => agentRow(id, null, now, now)), ...owed.shells.map(id => shellRow(id, null, now, now))]
  if (rows.length === 0) return { owed, rows: 0, posted: false }
  const failure = await withinDeadline(
    $,
    LEAVE_CLOSE_DEADLINE_MS,
    api($, 'POST', ACTIVITY_PATH, { body: { activities: rows } }).then(r => (r.ok ? null : errText(r))),
    () => `timeout: no answer within ${LEAVE_CLOSE_DEADLINE_MS / 1000} s`,
  )
  if (failure !== null) $.ui.toast(`50 Arms could not close ${activities(rows.length)} before ${why} (${failure.slice(0, TOAST_ERROR_MAX)}): the dashboard may show them running`)
  return { owed, rows: rows.length, posted: failure === null }
}

// hands the closes a leave took back when the leave did not happen (`left` false); nothing to do when the leave took none (`closes`
// null: a move that left no reported plan) or happened.
async function settleLeave($: any, closes: LeaveCloses | null, left: boolean, why: string): Promise<void> {
  if (closes !== null && !left) await leaveDidNotHappen($, closes, why)
}

// the leave did not happen (refused, or the call failed): the session is still on its plan, so what the closes took comes back.
// Closes the dashboard did not take are owed again: the memory returns, merged with anything opened since (one finish each, later). Closes
// it took cannot be undone: the dashboard keeps a row's FIRST finish (a stored finish is never overwritten), so a reopening post would change nothing; they stay forgotten (nothing is posted twice) and one toast says
// they read as finished while they run. The plan always comes back.
async function leaveDidNotHappen($: any, closes: LeaveCloses, why: string): Promise<void> {
  const { owed } = closes
  const rowsBack = !closes.posted
  await update($, reports, cur => ({
    agents: rowsBack ? { ...owed.agents, ...cur.agents } : cur.agents,
    shells: rowsBack ? [...owed.shells.filter(s => !cur.shells.includes(s)), ...cur.shells] : cur.shells,
    planId: cur.planId ?? owed.planId,
  }))
  if (closes.posted) $.ui.toast(`50 Arms: ${why} did not happen, but its ${activities(closes.rows)} were already reported finished: the dashboard keeps them finished while they run`)
}

// Whether a move to `planId` leaves the plan the open rows belong to.
async function movesOffReportedPlan($: any, planId: number): Promise<boolean> {
  const from = (await read($, reports)).planId
  return from !== null && from !== planId
}

async function report($: any, what: string, method: string, path: string, body: object, quietWhenNoRow = false): Promise<void> {
  const r = await api($, method, path, { body })
  // a signed-in session on no plan and no card may hold no `plan_sessions` row (404): that is no failure, it has nothing to report on
  if (!r.ok && !(quietWhenNoRow && r.status === 404)) $.ui.toast(`50 Arms ${what} report failed: ${errText(r).slice(0, TOAST_ERROR_MAX)}`)
}

// the session's activity (idle, in a turn, compacting) and when it began, for the dashboard's Comments drawer. A session on a plan or holding a
// stand-alone card has a row to report it on; so may a signed-in session holding only a queued job (its job nudge and stall alarm read these), and one with no
// row is answered 404, which is quiet. A session not signed in sends nothing. Detached like the other reports; a send the dashboard does not take is one toast (`report`), never swallowed.
async function reportTurnActivity($: any, activity: TurnActivity): Promise<void> {
  const v = await read($, view)
  const onPlanOrCard = v.connected !== null || v.card !== null
  if (!onPlanOrCard && !isSignedIn(v)) return
  await sendTurnActivity($, activity, !onPlanOrCard)
}

async function sendTurnActivity($: any, activity: TurnActivity, quietWhenNoRow = false): Promise<void> {
  const now = await $.clock.now()
  let since = now
  await update($, turnReportedAt, last => {
    since = nextSince(now, last)
    return since
  })
  detach($, '50 Arms turn activity report', report($, 'turn activity', 'PUT', TURN_ACTIVITY_PATH, turnActivityBody(activity, since), quietWhenNoRow))
}

// The main agent's compaction ended (finished, skipped or failed): back to the turn it interrupted, else idle.
async function reportCompactionEnd($: any): Promise<void> {
  await reportTurnActivity($, afterCompaction((await read($, turn)).isRunning))
}

// A plan or card connect landed (a first connect, a move or a reconnect): the dashboard's row has no activity yet, or a stale one, so the session's current
// activity is sent now. The view is not loaded yet at this point (its refresh is detached), so the send does not wait on it.
async function reportActivityOnConnect($: any): Promise<void> {
  const busy = await mainIsCompacting($)
  await sendTurnActivity($, busy ? 'compacting' : (await read($, turn)).isRunning ? 'in_turn' : 'idle')
}

function postActivity($: any, rows: ActivityChange[]): void {
  detach($, '50 Arms activity report', report($, 'activity', 'POST', ACTIVITY_PATH, { activities: rows }))
}

// a sub-agent started: its row opens and it is remembered as running, its liveness clock starting now.
async function reportSubagentStart($: any, e: any): Promise<void> {
  if (typeof e.agent_id !== 'string' || e.agent_id === '') return
  if ((await reportingState($)) !== 'on') return
  const planId = await openingPlan($)
  const id = subagentKey(e.agent_id)
  const now = await $.clock.now()
  await update($, reports, cur => ({ ...cur, agents: { ...cur.agents, [id]: now }, planId: planId ?? cur.planId }))
  postActivity($, [agentRow(id, typeof e.agent_type === 'string' && e.agent_type !== '' ? e.agent_type : null, now, null)])
}

// a sub-agent's turn ended, cleanly or not (a failed sub-agent raises no SubagentStop, but its turn.complete still comes): the
// finish its posted start is owed goes out, and it is forgotten. An agent this session never reported (an engine fork, a workflow's
// agent, one already finished) reports nothing; a resumed sub-agent is reported again from its next start.
async function reportSubagentEnd($: any, agentId: string): Promise<void> {
  const id = subagentKey(agentId)
  if ((await read($, reports)).agents[id] === undefined) return
  const state = await reportingState($)
  if (state === 'off') return forgetReports($)
  await update($, reports, cur => {
    const { [id]: _ended, ...running } = cur.agents
    return { ...cur, agents: running }
  })
  const now = await $.clock.now()
  postActivity($, [agentRow(id, null, now, now)])
}

// a tool call whose result names a background task (a `run_in_background` shell, or one the person backgrounded) opens that
// shell's row, keyed by its task id (the id the engine's `background_tasks` lists it under), labelled by the call's own
// `description`, redacted (never its command).
async function reportShellStart($: any, e: any, r: any): Promise<void> {
  const taskId = r.deny === undefined ? r.result?.backgroundTaskId : undefined
  if (typeof taskId !== 'string' || taskId === '') return
  // every signed-in session reports its shells, plan or card or neither, the same rule its sub-agent rows follow
  if ((await reportingState($)) !== 'on') return
  const planId = await openingPlan($)
  const now = await $.clock.now()
  await update($, reports, cur => ({ ...cur, shells: [...cur.shells.filter(s => s !== taskId), taskId], planId: planId ?? cur.planId }))
  postActivity($, [shellRow(taskId, labelOf(e.description), now, null)])
}

// a running sub-agent's own tool call re-posts its row with a fresh lastActivityAt, at most once a LIVENESS_MS, so a sub-agent
// working for minutes never reads as silent.
async function reportSubagentAlive($: any, agentId: string): Promise<void> {
  const id = subagentKey(agentId)
  const now = await $.clock.now()
  const state = await read($, reports)
  const lastPost = state.agents[id]
  if (lastPost === undefined || now - lastPost < LIVENESS_MS || (await reportingState($)) !== 'on') return
  await update($, reports, cur => (cur.agents[id] === undefined ? cur : { ...cur, agents: { ...cur.agents, [id]: now } }))
  postActivity($, [agentRow(id, null, now, null)])
}

// a Stop or SubagentStop carries the engine's list of the background work in flight. It finishes the row of every shell this
// session opened that the list no longer shows running (every start the reports open gets its end). A snapshot that is not
// a list is one toast.
async function reportShellEnds($: any, event: 'Stop' | 'SubagentStop', e: any): Promise<void> {
  if (Array.isArray(e.background_tasks)) {
    const ended = endedShells(await read($, readyShells), e.background_tasks)
    if (ended.length > 0) await update($, readyShells, cur => cur.filter(s => !ended.includes(s)))
  }
  const state = await reportingState($)
  if (state === 'off') return forgetReports($)
  const tasks = e.background_tasks
  if (!Array.isArray(tasks)) {
    $.ui.toast(`50 Arms shell-end report failed: the ${event} event carried no background_tasks list`)
    return
  }
  const now = await $.clock.now()
  const ended = endedShells((await read($, reports)).shells, tasks)
  if (ended.length === 0) return
  await update($, reports, cur => ({ ...cur, shells: cur.shells.filter(s => !ended.includes(s)) }))
  postActivity($, ended.map(id => shellRow(id, null, now, now)))
}

// What the ready-cards read came to: the ready cards, nothing to say, or why it failed.
type ReadyRead = { kind: 'cards'; cards: ReadyCard[]; reviewable: ReviewableCard[]; held: HeldCard[]; heldSkipped: string | null } | { kind: 'quiet' } | { kind: 'failed'; reason: string }

// the answers that end the read quietly, the ordinary ones for a session with nothing to check: it holds no usable key (signed
// out, or a person revoked it: its own tools say so), or the dashboard has it on no plan (409 `session_not_connected`). Any other
// refusal is a failure the person sees.
function isNothingToCheck(r: Api): boolean {
  return isSignedOut(r) || outcomeRevokedBy(r) !== null || (r.status === 409 && r.body?.error === 'session_not_connected')
}

// the plan this session is on and its boards, then the plan's ToDo cards on each board (a plan can span boards; an issues read
// names its board with the 50arms_api tool's own `board` argument).
async function readReadyCards($: any): Promise<ReadyRead> {
  // the pause is read FIRST, and while the session is in an agent pause neither card read is made: both carry the session header, so
  // they would count as the agent's own dashboard call and end the pause (the pause read does not). The stop is allowed.
  const pause = await readAgentPause($)
  if (pause.kind === 'paused' || pause.kind === 'nothing') return { kind: 'quiet' }
  if (pause.kind === 'failed') return { kind: 'failed', reason: pause.reason }
  const mine = await api($, 'GET', '/api/plans/mine')
  if (isNothingToCheck(mine)) return { kind: 'quiet' }
  if (!mine.ok) return { kind: 'failed', reason: errText(mine) }
  const plan = planOf(mine.body)
  if (!plan.ok) return { kind: 'failed', reason: plan.reason }
  const query = issuesQuery(plan.value.planId)
  const [boards, detail] = await Promise.all([
    Promise.all(plan.value.boards.map(board => api($, 'GET', '/api/issues', { board, query }))),
    api($, 'GET', detailPath(plan.value.planId)),
  ])
  const cards: ReadyCard[] = []
  const reviewable: ReviewableCard[] = []
  for (const r of boards) {
    if (!r.ok) return { kind: 'failed', reason: errText(r) }
    const read = readyCardsOf(r.body)
    if (!read.ok) return { kind: 'failed', reason: read.reason }
    cards.push(...read.value.ready)
    reviewable.push(...read.value.reviewable)
  }
  // the held-idle read fails open on its own (a dashboard without the route never costs the ready-cards check)
  let held: HeldCard[] = []
  let heldSkipped: string | null = null
  if (!detail.ok) heldSkipped = errText(detail)
  else {
    const idle = heldIdleOf(detail.body, workedCards(await read($, agentBriefs), await read($, runningAgents), await read($, recentBriefs), await $.clock.now()))
    if (idle.ok) held = idle.value
    else heldSkipped = idle.reason
  }
  // a ready card a running sub-agent of the session was briefed on is being worked: it is left out, and with every card left out the report says nothing
  const worked = briefedCards(await read($, agentBriefs), await read($, runningAgents))
  return { kind: 'cards', cards: cards.filter(c => !worked.has(c.id)), reviewable, held, heldSkipped }
}

// the main session's stop. Reports the shells' ends, then blocks the stop once while the plan has ready cards nobody holds.
// Never on a stop the hook already forced (`stop_hook_active`, so it cannot loop), never on its own failure (one toast, the stop goes on),
// and within one deadline over all its reads.
async function onReportStop($: any, e: any, next: any) {
  // the shell-end report runs in every plan state: off, it forgets what the reports owe (reportShellEnds)
  detach($, '50 Arms shell-end report', reportShellEnds($, 'Stop', e))
  if ((await reportingState($)) === 'off') return next(e)
  // a held main conversation is told it is held by the refusal of each tool call, and never also told to pick up cards
  if (e.agent_id === undefined && (await read($, behavior)).holds[mainContext] !== undefined) return next(e)
  // the hook's one deadline starts here: the bundle's text for this stop and the slot reads it names end by it
  const budget = await hookBudget($)
  const verdict: ReadyRead =
    e.agent_id === undefined && e.stop_hook_active !== true
      ? await withinDeadline($, READY_CARDS_DEADLINE_MS, readReadyCards($), () => ({ kind: 'failed', reason: `timeout: no answer within ${READY_CARDS_DEADLINE_MS / 1000} s` }))
      : { kind: 'quiet' }
  const r = await next(e)
  if (verdict.kind === 'failed') $.ui.toast(skippedLine(verdict.reason))
  if (verdict.kind === 'cards' && verdict.heldSkipped !== null) $.ui.toast(heldSkippedLine(verdict.heldSkipped))
  // one block carries both reasons, each only when it has cards
  const reasons = verdict.kind === 'cards' ? [...(verdict.held.length > 0 ? [heldIdleReason(verdict.held)] : []), ...(verdict.cards.length > 0 ? [blockReason(verdict.cards)] : []), ...(verdict.reviewable.length > 0 ? [reviewReason(verdict.reviewable)] : [])] : []
  if (reasons.length === 0) return r
  const own = reasons.join('\n\n')
  // `turn.stop` is the moment ready cards or held work are idle (its catalog description): the bundle's texts for it join the plugin's own refusal, which they name as `next_step`. Never a stop that a Stop hook already
  // blocked (`stop_hook_active`), so no attached policy can keep a session from stopping
  if (e.agent_id !== undefined || e.stop_hook_active === true || !(await signedInWithAgent($))) return { ...r, block: own }
  // only the Stop block carries it: a text of another mechanism is never decided here, and a stop is no channel for the start texts a context is owed
  const told = await tellEvent($, 'turn.stop', null, budget, { extra: { next_step: own }, mechanisms: ['plugin.stop_block'] })
  // a context that turned out held at this stop is told so by its tool refusals, never by a pick-up-cards block
  if (told.kind === 'refused') return r
  return { ...r, block: [own, ...textsOf(told)].join('\n\n') }
}

// ---- an operator session is compacted only after its agent says ready ----------------------------------------------
// The control is a local file the session's dashboard MCP relay writes (hooks/compaction/control.ts has the shape and the reasoning). This block
// starts the compaction when the agent says ready (`$.command.run({ command: 'compact' })` at the main loop's turn end), clears what older plugin versions armed,
// and answers every automatic compaction proposal (`classic.PreCompact`) with a refusal while the session is under the handshake. It fails
// OPEN: whatever it cannot establish lets Claude Code's own compaction through (a refusal with no way out ends the session), and says so once.

// The last reason told to the person that the control file is unreadable; the same reason is told once.
let compactionFaultTold: string | null = null
// true from the moment the plugin has decided to run a /clear until it has ended: the ready loop's released clear and a compaction by clear are never in progress together, whichever decided first
// (the decision and this flag are set with no await between them)
let clearInProgress = false
// the model left its plan or card, and the session is at a natural break: the next main turn end clears it when nothing runs. Set by the model's own call that the
// dashboard accepted; spent at that turn end whether or not it cleared (work still running means nothing new happens). A module variable, not $.state: a clear ends it either way.
let clearAtBreak = false
// the relay-older-than-plugin notice last shown (null while the control is whole); shown once, and again if it changes or the session returns to a whole control and falls back
let relayOlderTold: string | null = null
// the person was told once that the engine's release could not be read, so sub-agent compaction waits for the first compaction event
let engineVersionTold = false
// each sub-agent's last model response (its context size and model), noted at `turn.step`: `session.compact` names the proposing sub-agent but not its size, and
// `$.session.usage()` is the main conversation's. A Map keeps insertion order, so the oldest agent goes first once AGENT_SIZES_KEEP are held; a reload starts empty (the
// next response of each agent fills it), and an agent whose size is unknown is refused and told, never guessed (agentVerdict).
const agentSizes = new Map<string, AgentSize>()
// the sub-agent refusals already told to the person (`agent id: reason`), each once
// bounded like agentSizes: past AGENT_FAULT_TOLD_KEEP distinct faults the oldest is forgotten, so a long-lived process holds no more than that
const agentFaultTold = new Set<string>()
// true the first time `fault` is seen (the caller then tells the person), false after
function firstTimeAgentFault(fault: string): boolean {
  // the fault text can embed an id of any length, so the remembered key is cut to a fixed size
  const memory = fault.slice(0, AGENT_FAULT_KEY_MAX)
  if (agentFaultTold.has(memory)) return false
  agentFaultTold.add(memory)
  if (agentFaultTold.size > AGENT_FAULT_TOLD_KEEP) agentFaultTold.delete(agentFaultTold.values().next().value as string)
  return true
}
// the git read of the resume briefing is a local status: it needs no longer than this
const GIT_STATUS_TIMEOUT_MS = 5000
// how often an idle session looks for an agent's ready in the local control file (a file read, no network)
const COMPACTION_IDLE_CHECK_MS = 5000

async function compactionControl($: any): Promise<ControlFile> {
  const home = await homeDir($)
  if (home === null) return { kind: 'bad', reason: 'no home directory' }
  const engineId = String(await $.session.id())
  const { id, fault } = await mcpSessionId($, engineId)
  // a lookup that failed (not one that found no row) cannot say where the control is: told once as an unreadable control is, and Claude Code's own compaction applies
  if (fault !== null) return { kind: 'bad', reason: `the session's id on the dashboard could not be read: ${fault}` }
  const path = sessionFilePath(home, 'compaction', id)
  if (path === null) return { kind: 'bad', reason: `the session id ${JSON.stringify(engineId)} names no file` }
  if (!(await $.fs.exists(path))) return { kind: 'absent' }
  return parseControlFile(await $.fs.read(path), id)
}

// The size of the context now and the session's real window; each null when the engine cannot say yet (before the first response).
async function contextReading($: any): Promise<{ tokens: number | null; window: number | null }> {
  const context = (await $.session.usage())?.context
  const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
  return { tokens: count(context?.tokens), window: count(context?.window) }
}

// The store keeps one record per spent release under USED_RELEASE_PREFIX: the oldest past USED_RELEASE_KEEP go.
async function pruneReleaseRecords($: any): Promise<void> {
  const entries: { key: string; at: number }[] = []
  for (const key of await storeOp($, { op: 'keys' })) {
    if (!key.startsWith(USED_RELEASE_PREFIX)) continue
    const rec: any = await storeOp($, { op: 'get', key })
    entries.push({ key, at: typeof rec?.at === 'number' ? rec.at : 0 })
  }
  for (const key of staleReleaseKeys(entries)) await storeOp($, { op: 'delete', key })
}

// The desktop's own id for this session (`CLAUDE_CODE_HOST_SESSION_ID`, the one the sidebar names it by): every process of one desktop session sees it, a clear that ends the process keeps it, and no other session has it. A terminal
// host does not set it (null): a terminal's clear keeps its process, so nothing needs to outlive it.
async function hostSessionId($: any): Promise<string | null> {
  const id = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
  return typeof id === 'string' && id !== '' ? id : null
}

// The store keeps one record per session under `prefix` (a compaction's spent release, the ready loop's spent clear, or its judged mark) of every session ever held: the oldest sessions' past USED_RELEASE_KEEP go, the way pruneCursors does for the relay cursors.
async function pruneSessionRecords($: any, prefix: string): Promise<void> {
  const entries: { key: string; at: number }[] = []
  for (const key of await storeOp($, { op: 'keys' })) {
    if (!key.startsWith(prefix)) continue
    const rec: any = await storeOp($, { op: 'get', key })
    entries.push({ key, at: typeof rec?.at === 'number' ? rec.at : 0 })
  }
  for (const key of staleSessionKeys(entries, prefix)) await storeOp($, { op: 'delete', key })
}

// one read of the control file per main-loop moment (a turn's start, its end, the idle check) serves everything the plugin does with it: telling the person the
// file is unreadable, clearing what an older plugin version armed, and starting the compaction an agent asked for. Never throws: a failure is one line to the person.
async function syncCompaction($: any, { start }: { start: boolean }): Promise<void> {
  try {
    const file = await compactionControl($)
    if (file.kind === 'bad') {
      if (compactionFaultTold !== file.reason) $.ui.toast(`Compaction control unreadable (${file.reason}): Claude Code's own automatic compaction applies until it is fixed.`)
      compactionFaultTold = file.reason
    } else compactionFaultTold = null
    const relayOlder = file.kind === 'control' && file.control !== null && file.control.subagents === null ? RELAY_OLDER_NOTICE : null
    if (relayOlder !== null && relayOlderTold !== relayOlder) $.ui.toast(relayOlder)
    relayOlderTold = relayOlder
    syncCompactionTicker($, file)
    await clearLeftoverArming($, file)
    await armSubAgents($, file)
    if (start) await startReadyCompaction($, file)
  } catch (err: any) {
    $.ui.toast(`Compaction handshake could not run: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`)
  }
}

// the idle check runs only while the session is under the handshake (its control file carries a control): a ready can only come to such a session. A session
// with no handshake pays nothing; the check stops the moment the control goes (the switch off, the file pruned or unreadable). A ready lands after the sync that read the
// file, so the check cannot wait for a release to appear in it.
function syncCompactionTicker($: any, file: ControlFile): void {
  const wanted = underHandshake(file)
  if (wanted && compactionTicker === null) compactionTicker = $.clock.every(COMPACTION_IDLE_CHECK_MS, () => idleCompactionCheck($))
  else if (!wanted && compactionTicker !== null) {
    compactionTicker.cancel()
    compactionTicker = null
  }
}

// The plugin arms nothing for the MAIN agent's own start (it runs /compact itself). An older plugin version armed CLAUDE_CODE_AUTO_COMPACT_WINDOW and
// then CLAUDE_AUTOCOMPACT_PCT_OVERRIDE in this process, and a variable stays in a running process after a plugin reload: the first shrinks the context meter's window,
// the second makes every loop propose early. Once the session has a control file (it is under the handshake) both are cleared, ONCE per process (`leftoverArmingCleared`): the
// sub-agents' percent (armSubAgents), which outlives main turns, is never wiped by a later turn, and armSubAgents sets the flag BEFORE it first sets the variable, so
// the clear can never wipe the value it armed. `$.env.set(name)` with no value restores the default at once (verified, Claude Code 2.1.299). The literal names are kept so
// the engine lists them as writes of this module. A session with no control file keeps whatever its person set.
async function clearLeftoverArming($: any, file: ControlFile): Promise<void> {
  if (file.kind === 'absent' || (await read($, leftoverArmingCleared))) return
  if ((await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')) !== undefined) await $.env.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW')
  if ((await $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')) !== undefined) await $.env.set('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')
  await update($, leftoverArmingCleared, () => true)
}

// a sub-agent has no command form that starts its compaction (`$.command.run` compacts the main session only), so the only compaction it can have is Claude Code's own
// automatic proposal. The plugin makes that proposal come early, from the floor: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, a process-wide variable (the main loop proposes early too; the gate
// holds its proposals, onSessionCompact). It is armed while the session is under the handshake, re-armed when the floor moves, and taken back when the handshake ends or the file
// cannot be read: an armed percent with nothing holding the proposals would compact every agent at the floor. A variable set at runtime DOES reach a sub-agent that is already
// running (verified live, Claude Code 2.1.299: a running sub-agent proposed three times within 12 s of the set).
// It is armed only once this host is known to run `session.compact` (`hostRunsSessionCompact`: an event seen, or an engine release from the floor): the per-agent gate lives there, and on a host without it the classic gate alone
// would hold every agent's early proposal, which can end an agent's work.
// whether this host runs `session.compact`, known at the first sync without waiting for a compaction: the event was seen (`sessionCompactSeen`), or the engine's release is one that
// serves it per agent (SESSION_COMPACT_FLOOR; the runtime has no capability flag). A version reading that throws or names no release is a host that is not known to run it: nothing arms.
async function engineCompactState($: any): Promise<'runs' | 'older' | 'unreadable'> {
  const known = await read($, engineCompact)
  if (known !== 'unread') return known
  let state: 'runs' | 'older' | 'unreadable'
  try {
    const base = (await $.session.version()).base
    state = base === undefined ? 'unreadable' : runsSessionCompact(base) ? 'runs' : 'older'
  } catch {
    state = 'unreadable'
  }
  await update($, engineCompact, () => state)
  return state
}

// ONE answer for both decisions that hang on it: whether the sub-agents' percent is armed (armSubAgents) and whether the classic PreCompact gate steps aside for an automatic proposal
// (onPreCompact). Arming without stepping aside would hold, at the classic gate, every early proposal that never reaches `session.compact`, for good.
async function hostRunsSessionCompact($: any): Promise<boolean> {
  return (await read($, sessionCompactSeen)) || (await engineCompactState($)) === 'runs'
}

async function armSubAgents($: any, file: ControlFile): Promise<void> {
  const asked = armedPercentOf(file)
  const wanted = (await hostRunsSessionCompact($)) ? asked : null
  // an engine release that cannot be read is not armed, and the person is told once (the compaction handshake's sub-agent half is off until a compaction event shows the host runs it)
  if (!engineVersionTold && asked !== null && !(await read($, sessionCompactSeen)) && (await engineCompactState($)) === 'unreadable') {
    engineVersionTold = true
    $.ui.toast(ENGINE_VERSION_NOTICE)
  }
  if (wanted === (await read($, armedPercent))) return
  // the once-per-process clear must never wipe the value armed here, so `leftoverArmingCleared` is already true when this first sets it: syncCompaction runs
  // clearLeftoverArming first, and it raises the flag on the first control file of the session (the one that can arm). A test pins the order.
  if (wanted === null) await $.env.set('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')
  else await $.env.set('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', String(wanted))
  await update($, armedPercent, () => wanted)
}

// whether the main agent's compaction is running: its entry stands from the moment core starts it until the session restarts from it (or it is skipped, fails, or outlives its TTL)
async function mainIsCompacting($: any): Promise<boolean> {
  return liveCompacting(await read($, compacting), await $.clock.now()).main !== null
}

// The file's unexpired release, if the plugin has not spent it: spent now (kept in $.store, so one release is acted on once however many turns follow) and returned.
async function spendReadyRelease($: any, file: ControlFile): Promise<string | null> {
  // the record names the release and the desktop session (never the engine id, which a clear moves): a clear that ends the process leaves a new process with a new engine id and an empty $.state, whose relay names its file
  // by its own id, while the dashboard keeps sending the same release until it expires. The desktop session's host id is the same in every process of the session, so the release stays spent for it.
  const waiting = file.kind === 'control' && file.control !== null ? file.control.releaseId : null
  if (waiting === null) return null
  const key = usedReleaseKey(await hostSessionId($), waiting)
  const now = await $.clock.now()
  const releaseId = readyRelease(file, spentReleaseId(await storeOp($, { op: 'get', key })), now)
  if (releaseId === null) return null
  // the store record outlives this process (claimedRelease below does not): a new process must not start the same release again
  // the claim, one compare-and-set before any further await: of every caller that read the release as waiting, exactly one gets it
  let won = false
  await update($, claimedRelease, cur => {
    won = cur !== releaseId
    return won ? releaseId : cur
  })
  if (!won) return null
  await storeOp($, { op: 'set', key, value: { releaseId, at: now } })
  await pruneReleaseRecords($)
  return releaseId
}

// the agent said ready, so the compaction runs: when no main-loop turn is running (its turn end, or the idle check below) the plugin queues Claude Code's own
// /compact, which the host runs once the session is idle. Never from inside a turn or a command hook. The file's unexpired release is the ready.
// The compaction reaches PreCompact and `session.compact` as trigger `manual`. The command takes no arguments: the control carries no instructions.
// A failure is one line to the person, and the dashboard re-asks once the release has expired.
// A control `mode` of `clear` is the main agent's own choice (it said `clear: true` on its ready, only when it knew nothing runs): the compaction is a clear instead, the conversation resets, the handoff lives on the cards,
// and the new conversation is briefed to resume from them (onClassicSessionStart).
// A /compact can run beside a sub-agent (it carries on through one); a /clear would end its work. So a `clear` ready that finds a sub-agent or a background command running compacts instead, and never waits:
// the agent's choice was a clear only for a session with nothing running, and a busy one must still shrink on time.
// Nothing starts while a /clear is in progress (the ready loop's, or an earlier compaction's): its release stays in the file for the next check.
async function startReadyCompaction($: any, file: ControlFile): Promise<void> {
  if (clearInProgress) return
  // the main agent's compaction is already running, so it has already done what this ready asked for: the release is spent without a second /compact or a /clear, as a person's own /compact
  // spends a waiting ready. A later release acts as usual
  if (await mainIsCompacting($)) {
    await spendReadyRelease($, file)
    return
  }
  const clears = file.kind === 'control' && file.control !== null && file.control.mode === 'clear' && (await sessionIsIdleForClear($))
  if (!clears) {
    if ((await spendReadyRelease($, file)) === null) return
    detach($, 'Compaction', $.command.run({ command: 'compact' }))
    return
  }
  // the guard is taken before the release is spent: the spend awaits, and a ready-loop clear deciding meanwhile must find it held
  if (clearInProgress) return
  clearInProgress = true
  let spent: string | null = null
  try {
    spent = await spendReadyRelease($, file)
  } finally {
    if (spent === null) clearInProgress = false
  }
  if (spent === null) return
  detach($, 'Compaction clear', clearForCompaction($, spent, await heldTargets($)))
}

// the turn ended after the model left its plan or card: clear the session when nothing runs (no sub-agent, no background command), as the ready loop's own clear needs. The break is spent here
// whatever happens. Left to others: a ready-list session (its loop owns the clear), a compaction already running, and a /clear in progress. A failed /clear is one line to the person.
async function clearAtNaturalBreak($: any): Promise<void> {
  if (!clearAtBreak) return
  clearAtBreak = false
  // each gate's value, read once, is recorded with the outcome
  const gates = {
    inProgress: clearInProgress,
    readyLoop: (await read($, readyLoop)) !== null,
    compacting: await mainIsCompacting($),
    turnRunning: (await read($, turn)).isRunning,
    agents: (await read($, runningAgents)).length,
    shells: (await read($, readyShells)).length,
  }
  if (gates.inProgress || gates.readyLoop || gates.compacting || gates.turnRunning || gates.agents > 0 || gates.shells > 0 || clearInProgress) {
    await noteBreak($, 'skipped', gates)
    return
  }
  clearInProgress = true
  // the leave's own refresh may still be loading: what the session holds is read after it, never from a view that still shows what it left
  let holds: string[]
  try {
    await refresh($, true)
    holds = await heldTargets($)
  } catch (err) {
    clearInProgress = false
    throw err
  }
  // written before the clear: a clear that ends the process leaves no later chance to write
  await noteBreak($, 'clear-attempted', { ...gates, holds })
  detach($, 'Natural-break clear', clearCommandOnce($, holds))
}

// what the session holds now, as the targets `session_connect` names: its plan, and its card
async function heldTargets($: any): Promise<string[]> {
  const v = await read($, view)
  return [...(v.connected === null ? [] : [planTarget(v.connected.id)]), ...(v.card === null ? [] : [v.card.id])]
}

// A session that holds nothing (the leave was of the only thing it held) has nothing to brief or reconnect: it gets the plain /clear. One that still holds a plan or card gets the compaction by
// clear's own path: the cleared resume briefing, and a reconnect to what it held when the clear left it unconnected.
async function clearCommandOnce($: any, holds: string[]): Promise<void> {
  try {
    if (holds.length === 0) {
      const { failure } = await clearCommand($)
      if (failure !== null) throw new Error(failure)
    } else await clearForCompaction($, 'natural-break', holds)
    await noteBreak($, 'clear-done', {})
  } catch (err: any) {
    await noteBreak($, 'clear-failed', { error: errMessage(err).slice(0, 300) })
    throw err
  } finally {
    clearInProgress = false
  }
}

// What a natural-break decision leaves for an agent to read afterwards (the plugin has no log): the newest NATURAL_BREAK_KEEP entries, one `$.store` key, so the file is
// ~/.claude/plugins/store/<plugin>-<hash>.json, the one `$.store` writes (`50arms_inline-*.json` for the preview folder, `50arms_50arms-*.json` for the cache copy). It never throws:
// a diagnostic that failed must not turn a clear into a failure.
const NATURAL_BREAK_KEY = 'naturalBreakLog'
const NATURAL_BREAK_KEEP = 60
async function noteBreak($: any, stage: string, facts: Record<string, unknown>): Promise<void> {
  try {
    const at = new Date(await $.clock.now()).toISOString()
    const prior = await storeOp($, { op: 'get', key: NATURAL_BREAK_KEY })
    const entries = Array.isArray(prior) ? prior : []
    const entry = { at, stage, session: await hostSessionId($), engineSession: await $.session.id(), ...facts }
    await storeOp($, { op: 'set', key: NATURAL_BREAK_KEY, value: [...entries, entry].slice(-NATURAL_BREAK_KEEP) })
  } catch (err: any) {
    $.ui.toast(`50 Arms: the natural-break record could not be written: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`)
  }
}

// how the host handed a call's answer to the hook: the fields answerOf reads, with a head of the text
function outcomeFacts(ran: any, outcome: { ok: boolean; status: number }): Record<string, unknown> {
  return { ok: outcome.ok, status: outcome.status, isError: ran?.isError === true, denied: ran?.deny !== undefined, hasText: typeof ran?.text === 'string', textHead: typeof ran?.text === 'string' ? ran.text.slice(0, 160) : null }
}

const sessionIsIdleForClear = async ($: any): Promise<boolean> => (await readyIsIdle($)) && (await read($, readyShells)).length === 0

// the plugin's own clear for a compaction, run with `clearInProgress` already taken by startReadyCompaction and given back here. The start of the conversation it opens must resume, so a mark is made first: in $.state
// (the clear's own start, in this process) and in $.store (a clear that ends the process: the new process's first start takes it, takeCompactionClearMark). A failure is one line to the person (detach), and the
// dashboard re-asks once the release has expired.
async function clearForCompaction($: any, releaseId: string, holds: string[]): Promise<void> {
  const host = await hostSessionId($)
  const now = await $.clock.now()
  await update($, compactionClear, () => holds)
  if (host !== null) await storeOp($, { op: 'set', key: compactionClearMarkKey(host), value: { releaseId, at: now, until: now + CLEAR_MARK_TTL_MS, holds } })
  try {
    const { failure } = await clearCommand($)
    if (failure !== null) throw new Error(failure)
  } finally {
    clearInProgress = false
    // a clear that did not happen raised no start to take the marks; one that did has them taken already
    await update($, compactionClear, () => null)
    if (host !== null) await storeOp($, { op: 'delete', key: compactionClearMarkKey(host) })
  }
}

// The marks of a compaction clear for the start `e` of a conversation: the one in $.state (a /clear start in the process that ran the clear) and this desktop session's own in $.store (the clear's own start, or the first start of
// a new process, any source: the clear ended the process that made the mark). Only this session's own key is read, taken and deleted (an expired one is dropped without a resume), so another session's mark is never touched
// and one mark resumes one start. A host with no host id has no store mark.
async function takeCompactionClearMark($: any, e: any, firstOfProcess: boolean): Promise<{ holds: string[] } | null> {
  const own = e.source === 'clear' ? await read($, compactionClear) : null
  if (own !== null) await update($, compactionClear, () => null)
  if (own === null && !firstOfProcess) return null
  const ours = own === null ? null : { holds: own }
  const host = await hostSessionId($)
  if (host === null) return ours
  const key = compactionClearMarkKey(host)
  const mark = clearMarkOf(await storeOp($, { op: 'get', key }))
  if (mark === null) return ours
  await storeOp($, { op: 'delete', key })
  return ours ?? (mark.until > (await $.clock.now()) ? { holds: mark.holds } : null)
}

// The agent's ready is written to the control file by the relay, after its tool call returned, so it can land after the turn that made it already ended (an idle
// session: no turn.complete follows). The plugin cannot watch the file: its `$.fs` is read, write, list, stat, exists and ancestors only (the hook catalog of Claude Code
// 2.1.299 has no watch), so a local file read every COMPACTION_IDLE_CHECK_MS starts it, only while no main turn is running.
// a sub-agent's request is delivered while the main turn runs too (the sub-agents work inside it), so the check runs always and only the START waits for no turn.
async function idleCompactionCheck($: any): Promise<void> {
  await syncCompaction($, { start: !(await read($, turn)).isRunning })
}

// The verdict for one proposal. A person's own /compact passes whatever the file says (it reads the file only to spend a waiting ready, above). Every read that a decision needs happens only for an automatic proposal;
// whatever throws lets the compaction through (fail open, hooks/compaction/control.ts).
async function compactionVerdict($: any, e: any): Promise<Verdict> {
  if (e.trigger === 'manual') {
    // a person's own /compact answers a waiting ready: the plugin must not run a second one at the turn's end (the plugin's own start has spent it already)
    try {
      await spendReadyRelease($, await compactionControl($))
    } catch (err: any) {
      $.ui.toast(`Compaction handshake could not note the compaction: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`)
    }
    return { pass: true, why: 'manual' }
  }
  try {
    // a `precompute` is judged like an automatic proposal (and, installing nothing, announces nothing)
    const judged = e.trigger === 'auto' || e.trigger === 'precompute'
    const reading = judged ? await contextReading($) : { tokens: null, window: null }
    const v = verdict({
      trigger: e.trigger,
      tokens: reading.tokens,
      window: reading.window,
      file: judged ? await compactionControl($) : { kind: 'absent' },
    })
    if (v.pass && v.why === 'valve' && e.trigger === 'auto') $.ui.toast('Compacting now: the context reached the size where holding it would end the session.')
    return v
  } catch (err: any) {
    const told = `Compaction gate could not decide, so Claude Code's own automatic compaction applies: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`
    if (compactionFaultTold !== told) $.ui.toast(told)
    compactionFaultTold = told
    return { pass: true, why: 'unreadable' }
  }
}

async function onPreCompact($: any, e: any, next: any) {
  // on a host that runs `session.compact` every automatic proposal that goes through it was judged there, per agent, before core ran this classic hook, which cannot tell the
  // agents apart (in 2.1.299 its input never names one): it is not judged a second time. Three proposals skip `session.compact` and reach only the classic hooks, and this passes all of
  // them: (1) a model whose window source is `auto` (under 1M in the catalog), (2) the in-process runner, (3) an isolated sub-agent (the built-in comment-thread-analyst,
  // `delegatedObservation`). That assumes the 1M models the handshake is built for: holding any of them by the MAIN agent's size would never release it (its own
  // context is not the main conversation's) and would end that agent's work at its window. Their contexts are short-lived and bounded, and the main agent's compaction stays held.
  if (e.trigger === 'auto' && (await hostRunsSessionCompact($))) return next(e)
  const v = await compactionVerdict($, e)
  let r: any
  try {
    r = await next(e)
  } catch (err) {
    if (v.pass) throw err
    return { block: v.reason }
  }
  return v.pass ? r : { ...r, block: v.reason }
}

// ---- each sub-agent is gated, and recommended, on its own --------------------------------------------------------------------------------------------

// Every model request of a sub-agent notes its context: `turn.step` (streaming) hands back the response with the usage the API reported and the model that answered. Only a
// sub-agent's request reaches this hook: the registration matches an `agentId`, and that matcher is the one place that keeps the main loop out (its size is `$.session.usage()`).
// The bookkeeping is plain arithmetic over a typed usage and a Map; the one thing that can throw is `subagentKey` on an id Claude Code never produces, which is caught, told once and ends the note without failing the request. It returns nothing, which the typed contract of a streaming hook defines as "its last next(e)'s result
// stands": the response the model gave passes on untouched (a test asserts the result a caller reads).
async function* noteAgentStep($: any, e: any, next: any): any {
  const response = yield* next(e)
  const size = response?.usage === null || response?.usage === undefined ? null : sizeOfUsage(response.usage)
  if (size !== null) {
    // sizes are kept under the canonical key the verdict and the handshake's `agents` map use; the event carries Claude Code's bare id
    // this is an observer on a model request, so an id of the wrong form is told once and leaves the request alone (the agent then has no known size, which agentVerdict refuses and tells)
    let key: string
    try {
      key = subagentKey(e.agentId)
    } catch (err: any) {
      const told = `Compaction could not note the context of sub-agent ${JSON.stringify(e.agentId)}: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`
      if (firstTimeAgentFault(told)) $.ui.toast(told)
      return
    }
    agentSizes.delete(key)
    agentSizes.set(key, size)
    if (agentSizes.size > AGENT_SIZES_KEEP) agentSizes.delete(agentSizes.keys().next().value as string)
  }
}

// Every `session.compact` event, whatever the trigger: this host runs it (`sessionCompactSeen`, one of the two inputs to `hostRunsSessionCompact`, with the engine release from 2.1.299), which arms
// the sub-agents' percent and hands the judging of automatic proposals to the per-agent gate below. Observes only.
async function onSessionCompactSeen($: any, e: any, next: any) {
  if (!(await read($, sessionCompactSeen))) await update($, sessionCompactSeen, () => true)
  // a person's own /compact (or the plugin's) is the main agent's, and replaces the note of a sub-agent proposal that never delivered a start
  if (e.trigger !== 'manual') return next(e)
  await noteCompacting($, null)
  return settledCompaction($, null, next, e)
}

// runs core's compaction and settles the agent's entry by what came back: a result that is not a skip is a compaction that finished, a skip or a throw is one that did not happen
// (the throw goes on).
async function settledCompaction($: any, agentId: string | null, next: any, e: any) {
  // only the main agent's compaction is the session's activity; a sub-agent compacts beside the main loop
  const mainAgent = agentId === null
  if (mainAgent) await reportTurnActivity($, 'compacting')
  let r: any
  try {
    r = await next(e)
  } catch (err) {
    await settleCompacting($, agentId, false)
    if (mainAgent) await reportCompactionEnd($)
    throw err
  }
  await settleCompacting($, agentId, r?.skip === undefined)
  if (mainAgent) await reportCompactionEnd($)
  return r
}

// Claude Code's own automatic proposal (`session.compact`, trigger `auto`, and a `precompute`, the same compaction computed ahead of time) for the main agent or, with an `agentId`,
// for a sub-agent. A person's /compact (and the plugin's own start) is not matched here: the classic gate still sees it and spends a waiting ready. The main agent's verdict is the
// one the classic gate has always given (compactionVerdict); a sub-agent's is its own (agentCompactionVerdict). A `precompute` is judged the same way but SPENDS no release (it
// installs nothing; the compaction that follows is an `auto` proposal judged then) and announces nothing. A proposal that passes goes on to core, whose classic PreCompact hook
// leaves it alone (onPreCompact); one that does not is a skip, so core runs nothing.
async function onSessionCompact($: any, e: any, next: any) {
  const v = e.agentId === undefined ? await compactionVerdict($, e) : await agentCompactionVerdict($, e)
  if (!v.pass) return { skip: v.reason }
  // the proposal passed, so this agent compacts next (a precompute installs nothing and names nobody)
  if (e.trigger !== 'auto') return next(e)
  await noteCompacting($, e.agentId ?? null)
  return settledCompaction($, e.agentId ?? null, next, e)
}

async function agentCompactionVerdict($: any, e: any): Promise<AgentVerdict> {
  // the event's `agentId` is Claude Code's bare id; the control's `agents` map is keyed `agent-<id>`, so it is converted once here and the verdict sees only the key
  const spends = e.trigger === 'auto'
  let agentId: string = e.agentId
  try {
    agentId = subagentKey(e.agentId)
    const v = agentVerdict({ agentId, file: await compactionControl($), size: agentSizes.get(agentId) ?? null })
    if (v.pass && v.why === 'valve' && spends) $.ui.toast(`Compacting sub-agent ${agentId} now: its context reached the size where holding it would end its work.`)
    else if (!v.pass && v.told && firstTimeAgentFault(`${agentId}: ${v.reason}`)) $.ui.toast(v.reason)
    return v
  } catch (err: any) {
    const told = `Compaction gate could not decide for sub-agent ${agentId}, so Claude Code's own automatic compaction applies: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`
    if (compactionFaultTold !== told) $.ui.toast(told)
    compactionFaultTold = told
    return { pass: true, why: 'unreadable' }
  }
}

// The briefing's sources, each read on its own: one that cannot be read says so in the briefing and does not take the others with it.
// ---- the policy bundle: every text an agent is told at a hook moment comes from it ---------------------------------------------------------
// 50 Arms renders one bundle per session (`GET /api/behavior-events/bundle`); the plugin caches it, decides each event from it locally (hooks/bundle/bundle.ts), fills the slots it owns,
// reports what it delivered, and keeps only the floor (hooks/bundle/floor.ts). An agent context (the main conversation, or a sub-agent by its id) with no current bundle is held.

const BUNDLE_WAIT_MS = 4_000
// the event told when a compaction restarts the session: the one that is followed by the requested endpoints
const COMPACTION_EVENT = 'session.after_compaction'

// One hook call has ONE deadline (`deadlineAt`, CONTEXT_DEADLINE_MS from its start) for everything it waits on: the bundle fetch and a session start's own reads both end by it, so a hung dashboard never holds a hook past it.
// A hook waits for the bundle fetch at most once, however many events it tells: the first call that finds no current bundle waits for the fetch in flight, and a later call of the same hook is answered
// from what that wait found (`waited.outcome`: null when it timed out), never refused at once with a timeout that may be false. A hook starts its own budget; no hook shares one with another.
type Budget = { deadlineAt: number; waited: { outcome: FetchOutcome | null } | null }
const hookBudget = async ($: any): Promise<Budget> => ({ deadlineAt: (await $.clock.now()) + CONTEXT_DEADLINE_MS, waited: null })
const RETRY_GAP_MS = 5_000
const BUNDLE_CACHE_PREFIX = 'bundle-cache:'
const bundleCacheKey = (sessionId: string): string => `${BUNDLE_CACHE_PREFIX}${sessionId}`
const MAIN_KEY = mainContext
const agentKeyOf = (agentId: unknown): string => (typeof agentId === 'string' && agentId !== '' ? agentId : MAIN_KEY)

// the plugin's own version, read once from its manifest: the bundle read names it (a call below the bundle's floor is refused 426) and the floor and the reports carry it
let ownVersion: string | null = null
async function pluginVersion($: any): Promise<string> {
  if (ownVersion !== null) return ownVersion
  const text = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)
  const version = typeof text === 'string' ? JSON.parse(text).version : undefined
  if (typeof version !== 'string') throw new Error('the plugin manifest names no version')
  ownVersion = version
  return version
}

// the session's bundle file, which the relay writes beside its other per-session files: it names the bundle's current version. A read that throws is a failure the caller tells, never "no file".
async function readBundleFile($: any): Promise<BundleFile> {
  try {
    const home = await homeDir($)
    if (home === null) return { kind: 'unreadable', reason: 'no home directory' }
    const { id, fault } = await mcpSessionId($, String(await $.session.id()))
    if (fault !== null) return { kind: 'unreadable', reason: `the session's id on the dashboard could not be read: ${fault}` }
    const path = sessionFilePath(home, 'behavior-bundle', id)
    if (path === null) return { kind: 'unreadable', reason: `the session id ${JSON.stringify(id)} names no file` }
    if (!(await $.fs.exists(path))) return { kind: 'absent' }
    return bundleFileOf(await $.fs.read(path), id)
  } catch (err: any) {
    return { kind: 'unreadable', reason: `the session file could not be read: ${errMessage(err).slice(0, CALL_ERROR_MAX)}` }
  }
}

// The unreadable session file last told to the person: each distinct reason is told once, and again after the file reads whole.
let signalFaultTold: string | null = null

// What tells this session its bundle changed. The session file counts only while the plugin's relay streams (the MCP never removes it when its stream stops); a file that cannot be read leaves the session with no signal and tells the person why.
async function readChangeSignal($: any): Promise<ChangeSignal> {
  const live = relayStreams((await read($, relay)).phase)
  const signal = changeSignalOf(live, live ? await readBundleFile($) : { kind: 'absent' })
  const why = signal.kind === 'down' ? signal.why : null
  if (why !== null && why !== signalFaultTold) $.ui.toast(`The relay's session file cannot tell this session when its policies change, so the plugin asks 50 Arms every minute instead: ${why}`.slice(0, TOAST_ERROR_MAX))
  signalFaultTold = why
  return signal
}

// The plugin holds a bundle and nothing tells it when that bundle changes: a fetch that fails is then the failed check for a change (the `relay_broken` hold).
async function relayDownOf($: any): Promise<{ why: string | null } | null> {
  if ((await read($, behavior)).held === null) return null
  const signal = await readChangeSignal($)
  return signal.kind === 'down' ? { why: signal.why } : null
}

// A fault of the saved copy, told once per distinct text: the copy is only a head start (a fetch follows), so it never stops a hook, but it is never silent.
let cacheFaultTold: string | null = null
function cacheFault($: any, what: string, err: unknown): void {
  const told = `${what}: ${errMessage(err).slice(0, TOAST_ERROR_MAX)}`
  if (told === cacheFaultTold) return
  cacheFaultTold = told
  $.ui.toast(told)
}

// The bundle kept on disk for this session and dashboard (the store), read when the process holds none: a resumed session finds it again, and it is current only while the session file names its version or an answer confirms it.
async function loadCachedBundle($: any): Promise<void> {
  let bundle: Bundle | null
  try {
    bundle = await cachedBundle($)
  } catch (err: any) {
    cacheFault($, 'The saved policy bundle was not used', err)
    return
  }
  if (bundle === null) return
  const kept = bundle
  await update($, behavior, cur => (cur.held === null ? { ...cur, held: { bundle: kept, confirmedAt: 0 } } : cur))
}

async function cachedBundle($: any): Promise<Bundle | null> {
  const cached: any = await storeOp($, { op: 'get', key: bundleCacheKey(String(await $.session.id())) })
  if (cached === undefined || cached === null) return null
  const origin = await storeOp($, { op: 'get', key: DASHBOARD_ORIGIN_KEY })
  if (cached.origin !== (typeof origin === 'string' ? origin : null)) return null
  const answer = readBundleBody(cached.bundle)
  return answer.kind === 'bundle' ? answer.bundle : null
}

async function cacheBundle($: any, bundle: Bundle): Promise<void> {
  const origin = await storeOp($, { op: 'get', key: DASHBOARD_ORIGIN_KEY })
  await storeOp($, { op: 'set', key: bundleCacheKey(String(await $.session.id())), value: { origin: typeof origin === 'string' ? origin : null, bundle, at: await $.clock.now() } })
  await pruneSessionRecords($, BUNDLE_CACHE_PREFIX)
}

// `ok` carries the bundle the answer left held: a hook that waited on another hook's fetch reads no state to learn it (a read may predate that fetch)
type FetchOutcome = { kind: 'ok'; bundle: Bundle } | { kind: 'signed-out' } | { kind: 'failed'; failure: Failure }

// a failed fetch as the hold reads it (`relayDown`: whether the failed fetch was also the plugin's only check for a change)
async function fetchFailure($: any, f: { status: number; body: unknown; serverNotConnected?: boolean; classifierRefused?: boolean; keyRevoked?: boolean; staleMcp?: boolean }): Promise<FetchOutcome> {
  return { kind: 'failed', failure: fetchFailureOf({ serverNotConnected: false, classifierRefused: false, keyRevoked: false, staleMcp: false, ...f, relayDown: await relayDownOf($) }) }
}

// The hold a failed dashboard answer makes (the one mapping of an answer to a hold reason, for the bundle fetch and the role fetch): `what` names the fetch in the hold line
async function answerFailure($: any, r: Api, what: string): Promise<Failure> {
  return fetchFailureOf({ status: r.status, body: r.body, serverNotConnected: r.unreachable === true, classifierRefused: r.refusal !== undefined, keyRevoked: outcomeRevokedBy(r) !== null, staleMcp: r.staleMcp === true, relayDown: await relayDownOf($) }, what)
}

let bundleFetch: Promise<FetchOutcome> | null = null

// ONE fetch at a time, whoever asks: the answer applies to the whole session, so a second caller waits for the one in flight
function fetchBundle($: any): Promise<FetchOutcome> {
  if (bundleFetch === null) bundleFetch = runFetch($).finally(() => void (bundleFetch = null))
  return bundleFetch
}

async function runFetch($: any): Promise<FetchOutcome> {
  let version: string
  try {
    version = await pluginVersion($)
  } catch (err: any) {
    return fetchFailure($, { status: 0, body: { message: `the plugin version could not be read: ${errMessage(err)}` } })
  }
  const before = (await read($, behavior)).held
  // the bundle comes only as a file (`reply_to_file`), never as a tool result: it is larger than Claude Code takes as one
  const r = await api($, 'GET', BUNDLE_PATH, { query: bundleQuery(version, before === null ? null : before.bundle.version), reply_to_file: true })
  if (!r.ok) {
    // no key, or the agent gate: the session's own tools tell the model, and nothing here holds it
    if (isSignedOut(r) || agentBlockOf(r) !== null) {
      // a session no key or the agent gate answers for holds nothing: every hold ends, each reported as any answer reports its end (a hold placed while the answer was unknown is dropped as one that was only ever loading)
      await releaseHolds($, null, await $.clock.now(), version, cur => cur, true)
      return { kind: 'signed-out' }
    }
    return { kind: 'failed', failure: await answerFailure($, r, 'bundle fetch') }
  }
  let answer: BundleRead
  try {
    answer = readBundleBody(r.body)
  } catch (err: any) {
    return fetchFailure($, { status: 0, body: { message: errMessage(err) } })
  }
  if (answer.kind === 'unchanged' && (before === null || before.bundle.version !== answer.version)) return fetchFailure($, { status: 0, body: { message: 'bad_response: the dashboard answered unchanged for a bundle the plugin does not hold' } })
  const now = await $.clock.now()
  const bundle: Bundle = answer.kind === 'bundle' ? answer.bundle : { ...(before as { bundle: Bundle }).bundle, floor_lines_plugin_version: answer.floorLinesPluginVersion }
  // an answer ends every hold of the session, in the same write that holds the bundle
  await releaseHolds($, null, now, version, cur => ({ ...cur, held: { bundle, confirmedAt: now } }))
  if (answer.kind === 'bundle') {
    try {
      await cacheBundle($, bundle)
    } catch (err: any) {
      cacheFault($, 'The policy bundle could not be saved', err)
    }
  }
  await queueFloorIfStale($, bundle, version)
  keepPolling($)
  return { kind: 'ok', bundle }
}

// THE way holds end: a current bundle for one context (`keys`), an answer for the whole session (`null`: every hold), a signed-out or agent-gate answer (every hold). A hold leaves the state and is reported by what it had
// reported, never by why it ended (`reportStepOf`):
//   never reported, still loading (inside the 2 minutes) ... dropped, nothing was reported and nothing is owed
//   never reported, past the hold line (any reason) ....... its one report, with its end time
//   reported open (`plugin_outdated`, `key_revoked` and `stale_mcp` only: the reasons whose fetch 50 Arms answered, or any other call of it did) ... its end report, which closes the alert episode 50 Arms opened for it
//   already ended .............................................. nothing
// `patch` is applied in the same write (the bundle an answer holds).
// A hold placed for a text that could not be delivered (`undelivered`) is not ended by a bundle answer, which proves nothing about that text: only `withUndelivered` ends it (the owed text was delivered, or the session turned out signed out).
async function releaseHolds($: any, keys: readonly string[] | null, now: number, version: string, patch: (cur: Behavior) => Behavior = cur => cur, withUndelivered = false): Promise<void> {
  let ended: [string, Hold][] = []
  await update($, behavior, cur => {
    const next = patch(cur)
    let holds = next.holds
    ended = []
    for (const key of keys ?? Object.keys(holds)) {
      if (!withUndelivered && holds[key]?.undelivered === true) continue
      const r = release(holds, key)
      holds = r.holds
      if (r.ended !== null) ended.push([key, r.ended])
    }
    return { ...next, holds }
  })
  for (const [key, hold] of ended) await reportHoldEnd($, key, hold, now, version)
}

// a hold that ended: reported with its end when its hold line had started or its open report was sent (one that ended inside the 2 minutes was only ever loading)
async function reportHoldEnd($: any, key: string, hold: Hold, now: number, version: string): Promise<void> {
  if (reportStepOf(hold, phaseOf(hold, now), true) !== 'ended') return
  const item = holdReport(hold, key === MAIN_KEY ? null : key, version, new Date(now).toISOString())
  await update($, behavior, cur => ({ ...cur, queue: enqueueHold(cur.queue, item, key, now) }))
  detach($, 'Reporting a hold', flushReports($))
}

// The process ends while a hold's open report is out (`plugin_outdated`, `key_revoked`): the alert 50 Arms opened for it closes only on the hold's end report, and nothing runs after this hook, so the end is reported
// here, bounded as the agent's release is. Only holds already reported open: a hold never reported (inside its 2 minutes, or an outage no open report was sent for) reports nothing, as it did before the session ended. A session
// with no key (signed out, revoked) cannot send it: 50 Arms closes the alert of a session that has been silent for good.
async function endOpenHolds($: any): Promise<void> {
  const v: PlanView = await read($, view)
  if (v.phase === 'signed-out' || v.phase === 'key-revoked') return
  const open = Object.entries((await read($, behavior)).holds).filter(([, hold]) => hold.reported === 'open').map(([key]) => key)
  if (open.length === 0) return
  await releaseHolds($, open, await $.clock.now(), await pluginVersion($), cur => cur, true)
  await withinDeadline($, AGENT_RELEASE_DEADLINE_MS, flushDueReports($), () => undefined)
}

// The queue's due reports sent, the ones this call enqueued included: a send already in flight began before them and does not carry them.
async function flushDueReports($: any): Promise<void> {
  await flushReports($)
  if (dueRequests((await read($, behavior)).queue, await $.clock.now()).length > 0) await flushReports($)
}

async function queueFloorIfStale($: any, bundle: Bundle, version: string): Promise<void> {
  if (!floorIsStale(bundle.floor_lines_plugin_version, version)) return
  const now = await $.clock.now()
  await update($, behavior, cur => (cur.floorLoud || hasFloorPending(cur.queue) ? cur : { ...cur, queue: enqueueFloor(cur.queue, floorBody(version), now) }))
  detach($, 'Reporting the floor lines', flushReports($))
}

// ---- sending the reports ----

let flushing: Promise<void> | null = null
let flushTimer: { cancel: () => void } | null = null

function flushReports($: any): Promise<void> {
  if (flushing === null) flushing = runFlush($).finally(() => void (flushing = null))
  return flushing
}

async function runFlush($: any): Promise<void> {
  const version = await pluginVersion($)
  const now = await $.clock.now()
  for (const request of dueRequests((await read($, behavior)).queue, now)) {
    const floor = request.path === 'floor'
    const sent = await api($, floor ? 'PUT' : 'POST', floor ? FLOOR_PATH : REPORTS_PATH, { body: request.body })
    if (sent.ok) {
      // the answer to a floor send names the version the team now holds
      const teamVersion = floor && typeof sent.body?.plugin_version === 'string' ? sent.body.plugin_version : null
      await update($, behavior, cur => ({ ...cur, queue: settleOk(cur.queue, request.ids), held: teamVersion !== null && cur.held !== null ? { ...cur.held, bundle: { ...cur.held.bundle, floor_lines_plugin_version: teamVersion } } : cur.held }))
      continue
    }
    await settleSendFailure($, request.ids, sent, version)
  }
  const next = (await read($, behavior)).queue.entries.reduce<number | null>((soonest, e) => (soonest === null || e.nextAt < soonest ? e.nextAt : soonest), null)
  flushTimer?.cancel()
  flushTimer = next === null ? null : $.clock.after(Math.max(next - (await $.clock.now()), 1_000), () => detach($, 'Reporting what the plugin delivered', flushReports($)))
}

async function settleSendFailure($: any, ids: number[], sent: Api, version: string): Promise<void> {
  const at = await $.clock.now()
  let loud: Loud[] = []
  let contexts: string[] = []
  await update($, behavior, cur => {
    const settled = settleFailure(cur.queue, ids, sent.status, errText(sent).slice(0, CALL_ERROR_MAX), at, version)
    const told = toTell(settled.queue, settled.loud)
    loud = settled.loud
    contexts = told.contexts
    return { ...cur, queue: told.queue, floorLoud: cur.floorLoud || settled.loud.some(l => l.what === 'floor send') }
  })
  // a report that failed loudly: each agent context it concerned is told once, and the band shows it for the rest of the session
  for (const l of loud) for (const key of l.contexts) if (contexts.includes(key)) await tellContext($, key, failureLine(l.reason))
}

// a line for an agent context outside its own hook: the main conversation by the relay's delivery, a sub-agent by a message to it
async function tellContext($: any, key: string, text: string): Promise<void> {
  if (key === MAIN_KEY) return tellModelAwake($, text)
  try {
    await $.session.send({ to: { agentId: key }, text })
  } catch (err: any) {
    notToldToast($, errMessage(err), text)
  }
}

// ---- the retry window ----

let retryTimer: { cancel: () => void } | null = null

// While any context is within its 2 minutes, the plugin asks again every few seconds; after them only a prompt or a tool call of a held context asks, never a timer
function keepRetrying($: any): void {
  if (retryTimer !== null) return
  retryTimer = $.clock.after(RETRY_GAP_MS, () => detach($, 'Fetching the policy bundle again', retryTick($)))
}

async function retryTick($: any): Promise<void> {
  retryTimer = null
  const now = await $.clock.now()
  const state = await read($, behavior)
  const holds = Object.values(state.holds)
  await leaveReadyWhenHeld($, state.holds[mainContext], now)
  if (!holds.some(h => phaseOf(h, now) === 'loading')) return
  const outcome = await fetchBundle($)
  // a failure during the window is kept as the newest reason of every hold
  if (outcome.kind === 'failed') await update($, behavior, cur => ({ ...cur, holds: Object.fromEntries(Object.entries(cur.holds).map(([k, h]) => [k, holdOn({ [k]: h }, k, outcome.failure, h.event, now)[k] as Hold])) }))
  keepRetrying($)
}

// ---- the background check for a change ----

let pollTimer: { cancel: () => void } | null = null

// While nothing tells the session its held bundle changed, the plugin asks again every BUNDLE_POLL_MS in the background (`known_version`: an unchanged bundle answers in a line), so the bundle stays confirmed and a policy edit arrives without a hook waiting on the answer.
function keepPolling($: any): void {
  if (pollTimer !== null) return
  pollTimer = $.clock.after(BUNDLE_POLL_MS, () => detach($, 'Checking the policy bundle for a change', pollTick($)))
}

async function pollTick($: any): Promise<void> {
  pollTimer = null
  if ((await read($, behavior)).held === null) return
  if ((await readChangeSignal($)).kind === 'down') {
    // a failure here is not told: the bundle then stops being current 90 s after its last answer, and the next call of a context is held with the failure (`relay_broken`)
    if ((await fetchBundle($)).kind === 'signed-out') return
  }
  keepPolling($)
}

// Once the hold line starts, a held main conversation leaves the ready list as a session held by a person's Stop does; during the loading window it stays listed, so a deploy restart never empties the list
async function leaveReadyWhenHeld($: any, hold: Hold | undefined, now: number): Promise<void> {
  if (!leavesReadyList(hold, now) || (await read($, readyLoop)) === null) return
  detach($, 'Ready list', leaveReady($, `This session left the ready list: 50 Arms could not deliver its instructions (${(hold as Hold).detail}).`))
}

// ---- asking whether an agent context may go on ----

type Ensured = { kind: 'ready'; bundle: Bundle } | { kind: 'signed-out' } | { kind: 'held'; hold: Hold }

async function ensureBundle($: any, key: string, event: string, waitMs: number, budget: Budget): Promise<Ensured> {
  if ((await read($, behavior)).held === null) await loadCachedBundle($)
  const state = await read($, behavior)
  const now = await $.clock.now()
  const signal = await readChangeSignal($)
  if (signal.kind === 'down') keepPolling($)
  if (isCurrent(state.held, signal, now)) {
    const bundle = (state.held as { bundle: Bundle }).bundle
    if (state.holds[key] !== undefined) await endHold($, key, now)
    return { kind: 'ready', bundle }
  }
  const relayDown = state.held === null || signal.kind !== 'down' ? null : { why: signal.why }
  // the hook waits once: a later call is answered from what that wait found, and only a wait that really timed out is refused with a timeout (the hold its own context stands in, else the fetch not having answered)
  if (budget.waited === null) {
    // at most what is left of the hook's one deadline
    budget.waited = { outcome: await withinDeadline<FetchOutcome | null>($, Math.min(waitMs, Math.max(budget.deadlineAt - (await $.clock.now()), 0)), fetchBundle($), () => null) }
  }
  const outcome = budget.waited.outcome
  if (outcome === null) {
    const own = state.holds[key]
    return holdContext($, key, event, own === undefined ? timeoutFailure(relayDown) : { reason: own.reason, detail: own.detail, values: own.values })
  }
  if (outcome.kind === 'ok') return { kind: 'ready', bundle: outcome.bundle }
  if (outcome.kind === 'signed-out') return { kind: 'signed-out' }
  return holdContext($, key, event, outcome.failure)
}

// An agent context with no current bundle: held with the failure (a new hold, or the standing one refreshed), kept asking for, and its report opened once the hold line starts.
async function holdContext($: any, key: string, event: string, failure: Failure, undelivered = false, retell: Retell | null = null): Promise<{ kind: 'held'; hold: Hold }> {
  const at = await $.clock.now()
  let hold!: Hold
  await update($, behavior, cur => {
    const holds = holdOn(cur.holds, key, failure, event, at, undelivered, retell)
    hold = holds[key] as Hold
    return { ...cur, holds }
  })
  keepRetrying($)
  await openHoldReport($, key, hold, at)
  if (key === MAIN_KEY) await leaveReadyWhenHeld($, hold, at)
  return { kind: 'held', hold }
}

const endHold = async ($: any, key: string, now: number): Promise<void> => releaseHolds($, [key], now, await pluginVersion($))

// The open report of a hold whose 50 Arms answered (an outdated plugin, a revoked key): the hold stays, so its report is sent once the hold line starts
async function openHoldReport($: any, key: string, hold: Hold, now: number): Promise<void> {
  if (hold.reported !== 'none' || phaseOf(hold, now) !== 'held' || !(hold.reason === 'plugin_outdated' || hold.reason === 'key_revoked' || hold.reason === 'stale_mcp')) return
  const item = holdReport(hold, key === MAIN_KEY ? null : key, await pluginVersion($), null)
  await update($, behavior, cur => {
    const held = cur.holds[key]
    return held === undefined ? cur : { ...cur, holds: { ...cur.holds, [key]: { ...held, reported: 'open' as const } }, queue: enqueueHold(cur.queue, item, key, now) }
  })
  detach($, 'Reporting a hold', flushReports($))
}

// ---- telling an event ----

type EventOutcome = { kind: 'texts'; entries: string[] } | { kind: 'signed-out' } | { kind: 'refused'; text: string } | { kind: 'abandoned' }

// `owes`: a start event, owed and told once a bundle arrives. `owed`: what the call does with the owed start events (`settleOwed`): only a prompt (`with`) and the refusal of a tool call (`only`) tell them.
// `mechanisms`: the mechanisms this hook can carry; a text of another is never decided, so it is neither counted told nor reported delivered.
// `abandoned`: asked after the slots are filled, before anything is decided; true gives the event up with nothing counted told or reported.
type MomentIn = { matchers?: Record<string, string>; extra?: Record<string, string>; owes?: boolean; waitMs?: number; owed?: OwedTaking; mechanisms?: readonly string[]; abandoned?: () => Promise<boolean> }

// the slots the plugin owns, filled for the ones an event's texts name
// Each source a slot needs is read only when a named slot needs it, and ends by `deadlineAt` (the hook's one deadline), a source cut off by it being a stated failure.
async function slotsOf($: any, event: string, names: string[], extra: Record<string, string>, deadlineAt: number): Promise<Record<string, string>> {
  const slots: Record<string, string> = { ...extra }
  const has = (n: string) => names.includes(n) && slots[n] === undefined
  if (has('clock_time')) {
    // the time stamp is a computed value, never a plugin text: a prompt's stamp counts from the last one stamped, every other event gets the clock alone
    if (event === 'prompt.submit') slots.clock_time = await timeLine($)
    else {
      const now = await $.clock.now()
      slots.clock_time = nextStamp(now, -new Date(now).getTimezoneOffset(), null).line.replace(/ \+0$/, '')
    }
  }
  if (has('owed_list')) slots.owed_list = owedListSlot(await owedSource($, deadlineAt))
  if (has('plan_id') || has('plan_name')) {
    const plan = await briefingPlan($)
    if (has('plan_id')) slots.plan_id = planIdSlot(plan)
    if (has('plan_name')) slots.plan_name = planNameSlot(plan)
  }
  if (has('card_list')) slots.card_list = cardListSlot(await cardsSource($))
  if (has('agent_list')) slots.agent_list = agentListSlot(await agentsSource($))
  if (has('git_status')) slots.git_status = gitStatusSlot(await gitSource($))
  if (has('disk_free')) {
    // the `disk_free` slot (a `tool.after` text's): the free bytes of the last measurement; a machine that has not opted in to the disk notice has none, and the slot is then named as unfilled
    const freeBytes = (await read($, diskMeasured))?.freeBytes ?? null
    if (freeBytes !== null) slots.disk_free = String(freeBytes)
  }
  if (has('context_tokens')) {
    const tokens = (await contextReading($)).tokens
    if (tokens !== null) slots.context_tokens = String(tokens)
  }
  return slots
}

// The carrier of an entry over its mechanism's cap: the full text goes to ONE file and the bundle's pointer names it. The file is complete when this returns and the pointer is told only after, so a reader never meets half of it.
async function carrierFile($: any, event: string, entry: Entry): Promise<string> {
  const home = await homeDir($)
  if (home === null) throw new Error('no home directory')
  const name = `${String(await $.session.id())}-${event}-${entry.mechanism}-${await $.clock.now()}`.replace(/[^a-zA-Z0-9_.-]/g, '_')
  const path = `${home}/.config/danxbot/behavior-text/${name}.txt`
  await $.fs.write(path, entry.text)
  return path
}

// What a hook tells, one entry per mechanism (`entriesOf`): the text itself, or, over the mechanism's cap, the pointer to the file holding it. A text whose file cannot be written was not delivered: the context is held (the caller's catch), never told a warning in its place.
async function renderEntries($: any, bundle: Bundle, event: string, deliveries: readonly Delivery[]): Promise<string[]> {
  const rendered: string[] = []
  for (const entry of entriesOf(bundle, deliveries)) {
    if (entry.overCap === null) {
      rendered.push(entry.text)
      continue
    }
    try {
      rendered.push(deliveredText(entry, await carrierFile($, event, entry)))
    } catch (err: any) {
      throw new BundleShapeError(`bad_response: a text of the "${event}" event (${entry.overCap.fullChars} characters) is over what ${entry.mechanism} carries and could not be saved to a file (${errMessage(err).slice(0, CALL_ERROR_MAX)})`)
    }
  }
  return rendered
}

// The session's requested endpoints, fetched when a compaction is told (`GET /api/behavior-events/requested-endpoints`, built by 50 Arms at that moment, never part of the bundle) and, like the bundle, only as a file. None read: `[]`.
// A fetch that fails or ends past the hook's deadline is a text that cannot be delivered: it throws, and the caller holds the context.
async function requestedEndpoints($: any, budget: Budget): Promise<BundleComputed[]> {
  const source = await boundedBy($, budget.deadlineAt, briefingSource<BundleComputed | null>(async () => {
    const r = await api($, 'GET', REQUESTED_ENDPOINTS_PATH, { query: requestedEndpointsQuery(await pluginVersion($)), reply_to_file: true })
    if (!r.ok) throw new Error(errText(r))
    return readRequestedEndpointsBody(r.body)
  }))
  if (!source.ok) throw new BundleShapeError(`bad_response: the requested endpoints could not be fetched (${source.reason.slice(0, CALL_ERROR_MAX)})`)
  return source.value === null ? [] : [source.value]
}

// The one way an event is told. The main conversation or a sub-agent (by its id) is held when no current bundle can be had: the answer is then the line that refuses (`owes`: a start event, owed and told once a bundle arrives).
async function tellEvent($: any, event: string, agentId: unknown, budget: Budget, moment: MomentIn = {}): Promise<EventOutcome> {
  const key = agentKeyOf(agentId)
  const ensured = await ensureBundle($, key, event, moment.waitMs ?? BUNDLE_WAIT_MS, budget)
  if (ensured.kind === 'signed-out') return { kind: 'signed-out' }
  if (ensured.kind === 'held') {
    if (moment.owes === true) await update($, behavior, cur => ({ ...cur, owed: owe(cur.owed, key, event) }))
    return { kind: 'refused', text: refusalOf(ensured.hold, await $.clock.now()) }
  }
  const bundle = ensured.bundle
  const card = (await read($, view)).card?.id ?? null
  const taking = moment.owed ?? 'none'
  let owed: string[] = []
  await update($, behavior, cur => {
    const settled = settleOwed(cur.owed, key, event, taking)
    owed = settled.events
    return { ...cur, owed: settled.owed }
  })
  const events = [...owed.map(o => ({ event: o, matchers: {} as Record<string, string>, mechanisms: null as readonly string[] | null })), ...(taking === 'only' ? [] : [{ event, matchers: moment.matchers ?? {}, mechanisms: moment.mechanisms ?? null }])]
  // a compaction or a clear of the main conversation starts it again: its role is told again (AC 76950)
  if (key === mainContext && events.some(m => startsNewContext(m.event))) await update($, behavior, cur => ({ ...cur, roleTold: null }))
  // The role is fetched only while the bundle lists `session.bind` (a dashboard that does not carries none), and the key the main conversation holds is claimed before the fetch, so two hooks landing together (or a hook and a retell) fetch and tell it once.
  // A role that is not delivered gives the claim back.
  let roleClaim: { before: string | null } | null = null
  // the key is already told (or being told by another hook): this call delivers nothing, and still ends a hold that nothing keeps
  let roleLost = false
  if (event === BIND_EVENT && key === mainContext && bundle.events.some(e => e.event === BIND_EVENT)) {
    const roleKey = roleKeyOf(await read($, view))
    const claim: { won: boolean; before: string | null } = { won: false, before: null }
    await update($, behavior, cur => {
      if (cur.roleTold === roleKey) return cur
      claim.won = true
      claim.before = cur.roleTold
      return { ...cur, roleTold: roleKey }
    })
    roleLost = !claim.won
    if (claim.won) roleClaim = { before: claim.before }
  }
  const giveBackRole = async (): Promise<void> => {
    if (roleClaim === null) return
    const { before } = roleClaim
    await update($, behavior, cur => ({ ...cur, roleTold: before }))
  }
  // what this call decided, so a call that delivers nothing (the lookup was given up, or a text could not be delivered) puts back what it counted told: the owed event is then told in full when the context is released
  let toldBefore: Told | null = null
  let toldAfter: Told = {}
  const rewind = async (): Promise<void> => {
    if (toldBefore === null) return
    const [before, after] = [toldBefore, toldAfter]
    await update($, behavior, cur => ({ ...cur, told: { ...cur.told, [key]: rewindTold(cur.told[key] ?? {}, before, after) } }))
  }
  const made: { d: Delivery; at: number }[] = []
  let rendered: string[]
  try {
    for (const m of roleLost ? events.filter(e => e.event !== event) : events) {
      const slots = await slotsOf($, m.event, namedSlots(bundle, m.event), m.event === event ? moment.extra ?? {} : {}, budget.deadlineAt)
      // the slot reads may have ended after the lookup was given up (a start's deadline): nothing is then counted told or reported, and the start stays owed
      if (moment.abandoned !== undefined && (await moment.abandoned())) {
        await rewind()
        await giveBackRole()
        return { kind: 'abandoned' }
      }
      // a compaction is followed by the session's requested endpoints, which only 50 Arms can build at this moment
      const fetched = m.event === COMPACTION_EVENT ? await requestedEndpoints($, budget) : roleClaim !== null && m.event === BIND_EVENT ? await fetchRole($, budget) : []
      let decision!: Decision
      await update($, behavior, cur => {
        if (toldBefore === null) toldBefore = cur.told[key] ?? {}
        decision = decide(bundle, { event: m.event, matchers: m.matchers, slots, card, mechanisms: m.mechanisms }, cur.told[key] ?? {}, fetched)
        toldAfter = decision.told
        return { ...cur, told: { ...cur.told, [key]: decision.told } }
      })
      const at = await $.clock.now()
      for (const d of decision.deliveries) made.push({ d, at })
    }
    rendered = await renderEntries($, bundle, event, made.map(x => x.d))
  } catch (err: any) {
    await giveBackRole()
    if (!(err instanceof BundleShapeError)) throw err
    await rewind()
    // a text that cannot be delivered (a bundle that cannot be evaluated, requested endpoints that could not be fetched, a file that could not be written) is no text: the context is held, as for a fetch that failed, and every start event this call took or told is owed again
    // the events owed again are recorded before the hold is placed: a hold for an owed event survives bundle answers until that event is delivered (the bundle is current, so nothing else would end it, and a hold every answer dropped would never leave the loading line)
    const owedAgain = moment.owes === true ? [...owed, event] : owed
    await update($, behavior, cur => ({ ...cur, owed: owedAgain.reduce((acc, o) => owe(acc, key, o), cur.owed) }))
    // an event no start owes (a tool or sub-agent stop text, a prompt's) is kept on the hold to be told again at the context's next tool call: no failed delivery is dropped
    const retell: Retell | null = taking === 'only' || moment.owes === true ? null : { event, matchers: moment.matchers ?? {}, extra: moment.extra ?? {}, mechanisms: moment.mechanisms === undefined ? null : [...moment.mechanisms] }
    const failure: Failure = err instanceof RoleFetchError ? err.failure : { reason: 'fetch_failed', detail: err.message.slice(0, CALL_ERROR_MAX), values: {} }
    const held = await holdContext($, key, event, failure, true, retell)
    return { kind: 'refused', text: refusalOf(held.hold, await $.clock.now()) }
  }
  // reported only once the entries are delivered: a delivery whose file could not be written was never made
  for (const { d, at } of made) await update($, behavior, cur => ({ ...cur, queue: enqueueDelivery(cur.queue, deliveryItem(bundle.version, d, new Date(at).toISOString()), key, at) }))
  // the owed event this call took is delivered: a hold kept for it ends, reported as any hold is
  // a text of this event and these matchers told now supersedes one that failed before
  if (taking !== 'only') await update($, behavior, cur => {
    const held = cur.holds[key]
    if (held?.retell === undefined) return cur
    const { retell: _was, ...rest } = held
    const left = dropRetell(held.retell, event, moment.matchers ?? {})
    return { ...cur, holds: { ...cur.holds, [key]: left.length === 0 ? rest : { ...rest, retell: left } } }
  })
  const after = await read($, behavior)
  if (after.holds[key]?.undelivered === true && after.owed[key] === undefined && after.holds[key]?.retell === undefined) await releaseHolds($, [key], await $.clock.now(), await pluginVersion($), cur => cur, true)
  if (rendered.length > 0) detach($, 'Reporting what the plugin delivered', flushReports($))
  return { kind: 'texts', entries: rendered }
}

// the texts an event told a hook that carries them as context
const textsOf = (outcome: EventOutcome): string[] => (outcome.kind === 'texts' ? outcome.entries : [])

// ... or, for a hook that is also where a held context is told it is held (`TOLD_ON`, hooks/bundle/floor.ts lists them all), the line that refuses
const textsOrRefusal = (outcome: EventOutcome): string[] => (outcome.kind === 'refused' ? [outcome.text] : textsOf(outcome))

// A tool call of a held context is refused with the loading or the hold line, and a context whose owed start texts just arrived reads them as the refusal of its next call (so it reads them, then retries the step).
// That refusal tells the owed events, and the events whose delivery failed and that no start owes (the hold's `retell`), one at a time with the moment they failed on; the tool event's own texts are told with the result of the call that runs.
async function refuseWhileHeld($: any, agentId: unknown, budget: Budget): Promise<string | null> {
  if (!(await signedInWithAgent($))) return null
  const key = agentKeyOf(agentId)
  const ensured = await ensureBundle($, key, 'tool.before', BUNDLE_WAIT_MS, budget)
  if (ensured.kind === 'held') return refusalOf(ensured.hold, await $.clock.now())
  if (ensured.kind !== 'ready') return null
  const told: string[] = []
  // a text already told on this call is counted told and reported delivered, so a later failure answers with it and the hold line together, never the hold line alone
  const refusedWith = (text: string): string => (told.length === 0 ? text : `${OWED_ARRIVED}\n\n${told.join('\n\n')}\n\n${text}`)
  if ((await read($, behavior)).owed[key] !== undefined) {
    const outcome = await tellEvent($, 'tool.before', agentId, budget, { owed: 'only' })
    if (outcome.kind === 'refused') return refusedWith(outcome.text)
    if (outcome.kind === 'texts') told.push(...outcome.entries)
  }
  // each is taken off the hold before it is told, so a failure puts back only itself and the ones not yet tried stay
  for (let again = await takeRetell($, key); again !== null; again = await takeRetell($, key)) {
    const outcome = await tellEvent($, again.event, agentId, budget, { matchers: again.matchers, extra: again.extra, ...(again.mechanisms === null ? {} : { mechanisms: again.mechanisms }) })
    if (outcome.kind === 'refused') return refusedWith(outcome.text)
    if (outcome.kind === 'texts') told.push(...outcome.entries)
  }
  if (told.length === 0) return null
  return `${OWED_ARRIVED}\n\n${told.join('\n\n')}`
}

async function takeRetell($: any, key: string): Promise<Retell | null> {
  let taken: Retell | null = null
  await update($, behavior, cur => {
    const held = cur.holds[key]
    const first = held?.retell?.[0]
    if (held === undefined || first === undefined) return cur
    taken = first
    const { retell: _all, ...rest } = held
    const left = (held.retell as Retell[]).slice(1)
    return { ...cur, holds: { ...cur.holds, [key]: left.length === 0 ? rest : { ...rest, retell: left } } }
  })
  return taken
}

// A sub-agent whose end the engine signalled is no context any more: its holds, kept or not, and its owed and retell texts end with it, and a hold that had passed the hold line is reported with its end.
// The signals are a foreground agent's own stop, a direct background agent's final notice (which also ends the idle agents under it: the engine sends it only when it has no live background child), and the agent's eviction from `spawnedAgents`.
// An end only inferred (a nested agent whose parent stopped, a parent with no record) ends nothing: an agent still alive stays held and told, and a dead one leaves a small entry that its eviction ends.
async function endAgentContext($: any, agentId: string, withChildren: boolean): Promise<void> {
  const ending = [agentId, ...(withChildren ? endedWithParent(await read($, spawnedAgents), agentId, await read($, runningAgents)) : [])]
  await releaseHolds($, ending, await $.clock.now(), await pluginVersion($), cur => {
    const owed = Object.fromEntries(Object.entries(cur.owed).filter(([key]) => !ending.includes(key)))
    return { ...cur, owed }
  }, true)
}

// the sources of the live data a start after a compaction or a clear fills in, one function each so a slot reads only what it names
const briefingPlan = async ($: any): Promise<{ ref: string; name: string } | null> => {
  const v = await read($, view)
  return v.connected === null ? null : { ref: v.connected.ref, name: v.connected.name }
}

const owedSource = ($: any, deadlineAt: number): Promise<Source<OwedComment[]>> =>
  boundedBy($, deadlineAt, briefingSource<OwedComment[]>(async () => {
    const r = await api($, 'GET', '/api/plan-sessions/me/owed-comments')
    if (!r.ok) throw new Error(errText(r))
    const list = r.body?.owedComments
    if (!Array.isArray(list)) throw new Error('bad_response: owed-comments answered no owedComments list')
    // a malformed element is a stated failure, never a briefing that throws while it is worded
    const bad = list.findIndex(c => typeof c?.cardId !== 'string' || typeof c.cardTitle !== 'string' || typeof c.commentId !== 'number' || typeof c.author?.name !== 'string' || typeof c.excerpt?.text !== 'string' || !(c.state === 'sent' || c.state === 'seen') || typeof c.waitedMs !== 'number')
    if (bad !== -1) throw new Error(`bad_response: owed-comments element ${bad} is not an owed comment`)
    return list
  }))

const cardsSource = async ($: any): Promise<Source<BriefingCard[]>> => {
  const v = await read($, view)
  return { ok: true, value: v.inProgress.map(c => ({ id: c.id, title: c.title })) }
}

// the engine's own list and a local `git status` (with its own time limit) are not dashboard reads: they keep their own limits and never share the hook's deadline
const agentsSource = ($: any): Promise<Source<BriefingAgent[]>> =>
  briefingSource<BriefingAgent[]>(async () => {
    const listed: { id: string; type: string; description: string; status: string }[] = await $.agent.list()
    return listed.filter(a => a.type !== 'teammate' && a.status === 'running').map(a => ({ id: a.id, type: a.type, description: a.description }))
  })

const gitSource = ($: any): Promise<Source<GitState>> =>
  briefingSource<GitState>(async () => {
    const out = await $.process.run(['git', 'status', '--porcelain=v1', '-b'], { cwd: await $.session.cwd(), timeoutMs: GIT_STATUS_TIMEOUT_MS })
    if (out.exitCode !== 0) throw new Error(`git status exited ${out.exitCode}`)
    const state = parseGitStatus(out.stdout)
    if (state === null) throw new Error('git status printed nothing readable')
    return state
  })

async function briefingSource<T>(readSource: () => Promise<T>): Promise<Source<T>> {
  try {
    return { ok: true, value: await readSource() }
  } catch (err: any) {
    return { ok: false, reason: errMessage(err) }
  }
}

// a dashboard read that has not answered by the hook's deadline is a stated failure, never a wait past it
async function boundedBy<T>($: any, deadlineAt: number, read: Promise<Source<T>>): Promise<Source<T>> {
  return withinDeadline<Source<T>>($, Math.max(deadlineAt - (await $.clock.now()), 0), read, () => ({ ok: false, reason: 'timeout: no answer by the hook deadline' }))
}

// the plugin's `dashboard_url` option, as the engine passed it to register (the last resort of blockedOrigin)
let dashboardOption: string | undefined

export const register: Register = (on, options) => {
  dashboardOption = optionDashboardUrl(options)
  on('session.start', onSessionStart)
  on('session.attach', onSessionAttach)
  on('session.end', onSessionEnd)
  on('command.run', { command: COMMAND }, onCommand)
  // a person typing /50arms:ready runs the skill's command, which the engine names `50arms:ready`; answering it here joins without the model
  on('command.run', { command: READY_SKILL }, onReadyCommand)
  on('tool.call', { tool: 'Skill' }, onReadySkill)
  // the plugin ships the permission its own calls to its own server need (ownServerCheck, hooks/relay/refusal.ts)
  // the second answer is a TEMPORARY dual name, removed with its tests once installs have moved: the person's allow rule for the old server key still covers the platform tools
  on('tool.check', ($, e, next) => ownServerCheck(e, Object.assign((x: any) => legacyRuleCheck(x, next, () => readLegacySettings($)), { origin: next.origin })))
  on('tool.call', { tool: toolName('session_connect') }, onSessionConnect)
  on('tool.call', { tool: `mcp__${DESKTOP_SESSION_SERVER}__set_session_title` }, onModelSetTitle)
  on('tool.call', { tool: toolName('request_permission') }, onRequestPermission)
  on('tool.call', { tool: toolName('50arms_api') }, onAckCall)
  on('turn.start', onTurnStart)
  on('turn.complete', onTurnComplete)
  // an automatic compaction is held while the session is under the handshake; the agent's ready starts /compact itself (startReadyCompaction)
  on('classic.PreCompact', onPreCompact)
  // Claude Code's own automatic proposals (and the same compaction computed ahead of time) are judged per agent (a person's /compact and the plugin's own start are not matched: the classic gate answers them); each sub-agent's
  // last response is noted at `turn.step`
  on('session.compact', onSessionCompactSeen)
  on('session.compact', { trigger: /^(auto|precompute)$/ }, onSessionCompact)
  // only a sub-agent's requests (an agentId): the main loop's every streamed chunk would otherwise cross into the plugin for nothing
  on('turn.step', { agentId: /.+/ }, noteAgentStep)
  on('session.measure', onMeasure)
  // usage pacing denies or downgrades a sub-agent spawn (never a tool call: saving work stays possible)
  on('agent.spawn', async ($, e, next) => {
    const env = pacingEnv($)
    const started = await spawnGuard(env)(e, ne => bugEvidenceGuard(env)(ne, next))
    if (started.deny === undefined) {
      const now = await $.clock.now()
      await update($, agentBriefs, cur => briefSpawned(cur, e.prompt, now))
      // the spawn's answer is the one place the new agent's id is known before its start: what its finish notice needs is kept under it
      if (typeof started.agentId === 'string' && started.agentId !== '') {
        const parent = typeof e.parentAgentId === 'string' && e.parentAgentId !== '' ? e.parentAgentId : null
        const spawned = { description: typeof e.description === 'string' ? e.description : '', background: e.background === true, direct: e.parentAgentId === undefined, parent }
        let evicted: string[] = []
        await update($, spawnedAgents, cur => {
          const after = spawnedAfter(cur, started.agentId, spawned)
          evicted = after.evicted
          return after.agents
        })
        // an evicted agent's entry is gone, so nothing could end its context later: it ends here, reported if its hold had passed the hold line
        for (const gone of evicted) await endAgentContext($, gone, false)
      }
    }
    return started
  })
  on('classic.SubagentStart', onSubagentStart)
  on('classic.SubagentStop', onSubagentStop)
  on('classic.SessionStart', onClassicSessionStart)
  // the shells' ends and the ready-cards check
  on('classic.Stop', onReportStop)
  on('prompt.submit', onPromptStamp)
  on('tool.call', onToolStamp)
  on('classic.UserPromptSubmit', onPromptTitle)
  on('ui.render', { component: 'AbovePrompt' }, drawBand)
  on('ui.render', { component: 'SessionMode' }, drawSessionMode)
  on('ui.render', { component: 'AssistantMessage' }, drawAssistantMessage)
}
