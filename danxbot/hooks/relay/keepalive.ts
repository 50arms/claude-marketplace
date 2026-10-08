import { eventPath } from '../context/events'
import { relayLine } from './delivery'

// DX-3900: the plan-tab keepalive. The desktop app disconnects a session's preview (its in-app browser pane) after 1800 s with no turn
// (main.log: `[WarmLifecycle:preview] Starting idle timeout ...: 1800s` at every turn end, `Idle timeout reached, disconnecting` 30 minutes
// later). A plan-connected desktop session that sits idle past that loses the tab the operator follows it through, so after
// KEEPALIVE_IDLE_MS without a turn the module submits one prompt that has the session re-check the tab; its turn restarts the app's timer.
// 25 minutes: five minutes inside the app's 30, for the turn's own length and the clock's drift.
export const KEEPALIVE_IDLE_MS = 25 * 60_000

// A failed attempt (the registry read, the prompt, the plan view not loaded) is tried again inside that five-minute margin, never a full idle
// period later (which would land after the app already closed the tab): every KEEPALIVE_RETRY_MS, no attempt starting after KEEPALIVE_GIVE_UP_MS
// past the turn's end (an absolute time, so read latency cannot push the last attempt later).
export const KEEPALIVE_RETRY_MS = 60_000
export const KEEPALIVE_GIVE_UP_MS = 29 * 60_000

// The registry event whose effective text is the wording (overridable per plan like the other event texts).
export const KEEPALIVE_PATH = eventPath('tab_keepalive')

// The prompt: the marker (the model knows it as a plan event), the registry's wording, and the plan page the wording refers to.
export const keepalivePrompt = (text: string, planUrl: string) => relayLine(`${text} Plan page: ${planUrl}`)
