// What `session_connect` answers while the machine has no registration. Called with `registration_only: true` it makes no
// access request and claims no team agent; it answers one of:
//   { state: 'machine_registration_required' | 'machine_registration_pending', registrationUrl, claimCode, instruction }
//   { state: 'machine_registered' }
// A plain call from the model meeting an unregistered machine answers the first shape too.
import { mcpText } from './mcp'
import type { ApprovalRequest } from './approval'

// The machine's one registration link and claim code, drawn like a sign-in request (link and code).
export type MachineRegistration = ApprovalRequest

const OPEN_STATES = ['machine_registration_required', 'machine_registration_pending']

// The registration an answer's text carries, or null for any other answer.
export function registrationOf(text: string | undefined): MachineRegistration | null {
  if (!text) return null
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || !OPEN_STATES.includes(parsed.state)) return null
  const { registrationUrl, claimCode } = parsed
  // only a web link is shown
  if (typeof registrationUrl !== 'string' || !/^https?:\/\//.test(registrationUrl)) return null
  if (typeof claimCode !== 'string' || claimCode === '') return null
  return { url: registrationUrl, code: claimCode }
}

// What one `registration_only` answer means to the registration watch.
export type RegistrationStep =
  // the registration is open: show its link and code, then call again (the call waits for the person)
  | { kind: 'waiting'; request: MachineRegistration }
  // the person accepted: the machine is registered
  | { kind: 'registered' }
  // anything else: the watch stops, and says why
  | { kind: 'stop'; message: string }

export function registrationStep(result: any): RegistrationStep {
  const text = mcpText(result)
  const request = registrationOf(text)
  if (request !== null) return { kind: 'waiting', request }
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'stop', message: 'the answer could not be read' }
  }
  if (parsed !== null && typeof parsed === 'object' && parsed.state === 'machine_registered') return { kind: 'registered' }
  const state = parsed !== null && typeof parsed === 'object' && typeof parsed.state === 'string' ? parsed.state : 'no state'
  return { kind: 'stop', message: `the answer was ${state}` }
}

// The label of the band's registration link.
export const REGISTER_MACHINE_LABEL = 'Register machine ↗'

export const registrationFailedToast = (message: string) => `Machine registration check failed: ${message.slice(0, 200)}`

// What the model reads after its own `session_connect` met an unregistered machine: the band already shows the person the link and code.
export const registrationShownNote = (r: MachineRegistration) =>
  `The 50 Arms plugin already shows the person this machine's registration link (${r.url}) and claim code ${r.code} in the band. Do not open the link yourself; tell the user to open it and check that claim code ${r.code} matches. Once they accept, the plugin tells you to call session_connect again.`

// Told once, waking the model, when the person has registered the machine.
export const machineRegisteredNote = (code: string) =>
  `[50 Arms] The person registered this machine (claim code ${code}). Call session_connect again now to request sign-in.`
