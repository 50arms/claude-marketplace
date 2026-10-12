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
// DX-4952: that bound is for an attempt that starts on time. One that starts late (the computer slept through its time) has the same window
// from when it starts, KEEPALIVE_RETRY_WINDOW_MS, since a bound from the turn's end would have passed hours ago.
export const KEEPALIVE_RETRY_MS = 60_000
export const KEEPALIVE_GIVE_UP_MS = 29 * 60_000
export const KEEPALIVE_RETRY_WINDOW_MS = KEEPALIVE_GIVE_UP_MS - KEEPALIVE_IDLE_MS

// DX-4952: the engine's `$.clock.after` is a relative setTimeout (the time a sleeping computer spends asleep does not count toward it) while
// `$.clock.now()` is the wall clock (Date.now), which keeps counting. A wait of the whole idle period would therefore run on after a wake for as
// long as it had left when the machine slept, while the app's own 30-minute timer, which runs on the wall clock, fires at the wake and closes the
// tab. The keepalive waits in slices of at most this long and reads the wall clock after each, so a wake is noticed within one slice.
export const KEEPALIVE_WAKE_CHECK_MS = 30_000

// The registry event whose effective text is the wording (overridable per plan like the other event texts).
export const KEEPALIVE_PATH = eventPath('tab_keepalive')

// The prompt: the marker (the model knows it as a plan event), the registry's wording, and the plan page the wording refers to.
export const keepalivePrompt = (text: string, planUrl: string) => relayLine(`${text} Plan page: ${planUrl}`)
