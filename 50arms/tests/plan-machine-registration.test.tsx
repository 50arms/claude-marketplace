import "./run-tests-with-npm-test.generated"
// CP-88: a machine registers once before any of its sessions asks to sign in. The band shows the machine's one registration link and claim code (read with
// `session_connect` + `registration_only`, which makes no access request), the model that meets the state is told to send the person there, and when the
// person accepts, every session drops the link, offers its sign-in, and an idle model that was told about the link is woken exactly once.
import { describe, expect } from 'claude-code/testing'

import { machineRegisteredNote, registrationOf, registrationShownNote, registrationStep } from '../hooks/plan/registration'
import { signInStep } from '../hooks/plan/sign-in'
import { relayLine } from '../hooks/relay/delivery'
import { test, CLAIM_CODE, MACHINE_PENDING, MACHINE_REQUIRED, REGISTRATION_URL, SURFACES, dashboard, forceRefresh, linksOf, startSession, woken } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const buttons = async (ui: any) => (await ui.findAll({ type: 'Button' })).map((b: any) => b.text)
const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' ')
const answer = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false })
const MODEL_CALL = { tool: 'mcp__plugin_50arms_platform__session_connect', target: 'PLAN-23' } as any
// the model's own plain session_connect meets the unregistered machine
const modelMeetsMachine = (on: any) => on('tool.call', { tool: 'mcp__plugin_50arms_platform__session_connect' }, () => ({ result: {}, text: JSON.stringify(MACHINE_REQUIRED), isError: false }) as any)
// the plain calls (the model's or a Sign in press): every session_connect that is not the band's registration read
const plainConnects = (d: any) => d.calls.filter((c: any) => c.tool === 'session_connect')

describe('what an answer means', () => {
  test('the required and pending answers carry the link and code; anything else carries none', () => {
    expect(registrationOf(JSON.stringify(MACHINE_REQUIRED))).toEqual({ url: REGISTRATION_URL, code: CLAIM_CODE })
    expect(registrationOf(JSON.stringify(MACHINE_PENDING))).toEqual({ url: REGISTRATION_URL, code: CLAIM_CODE })
    expect(registrationOf(JSON.stringify({ state: 'machine_registered' }))).toBeNull()
    expect(registrationOf(JSON.stringify({ ...MACHINE_REQUIRED, registrationUrl: 'javascript:alert(1)' }))).toBeNull()
    expect(registrationOf(JSON.stringify({ ...MACHINE_REQUIRED, claimCode: '' }))).toBeNull()
    expect(registrationOf('not json')).toBeNull()
    expect(registrationOf(undefined)).toBeNull()
  })

  test('the watch reads waiting, registered, and stops on anything else', () => {
    expect(registrationStep(answer(MACHINE_PENDING))).toEqual({ kind: 'waiting', request: { url: REGISTRATION_URL, code: CLAIM_CODE } })
    expect(registrationStep(answer({ state: 'machine_registered' }))).toEqual({ kind: 'registered' })
    expect(registrationStep(answer({ state: 'signed_in' }))).toMatchObject({ kind: 'stop' })
    expect(registrationStep({ content: [{ type: 'text', text: 'nope' }] })).toMatchObject({ kind: 'stop' })
  })

  test('a press of Sign in that meets the state waits on the registration: it never stops with the state named', () => {
    expect(signInStep(answer(MACHINE_REQUIRED))).toEqual({ kind: 'registration', request: { url: REGISTRATION_URL, code: CLAIM_CODE } })
    expect(signInStep(answer(MACHINE_PENDING)).kind).toBe('registration')
  })

  test('the notes name the link and code, and the wake asks for session_connect again', () => {
    const note = registrationShownNote({ url: REGISTRATION_URL, code: CLAIM_CODE })
    expect(note).toContain(REGISTRATION_URL)
    expect(note).toContain('Do not open the link yourself')
    expect(machineRegisteredNote(CLAIM_CODE)).toContain('Call session_connect again')
  })
})

for (const surface of SURFACES) {
  describe(`an unregistered machine on ${surface}`, () => {
    test('a signed-out band shows the registration link and claim code, offers no Sign in, and the load made no access request', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out', unregistered: true })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect((await linksOf(band)).map(l => l.href)).toContain(REGISTRATION_URL)
      expect(await texts(band)).toContain(`code ${CLAIM_CODE}`)
      expect(await buttons(band)).not.toContain('Sign in')
      // the band's reads carry the flag and nothing else; no plain session_connect was made
      expect(d.world.machine.calls.length).toBeGreaterThan(0)
      for (const args of d.world.machine.calls) expect(args).toEqual({ registration_only: true })
      expect(plainConnects(d)).toHaveLength(0)
    })

    test('the person accepts: the link goes within one wait round and Sign in returns; no access request was made meanwhile', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out', unregistered: true })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      await d.clock.advance(45_000)
      expect((await linksOf(band)).map(l => l.href)).toContain(REGISTRATION_URL)
      d.world.machine.registered = true
      await d.clock.advance(45_000)
      await d.clock.settle()
      expect((await linksOf(band)).map(l => l.href)).not.toContain(REGISTRATION_URL)
      expect(await buttons(band)).toContain('Sign in')
      expect(plainConnects(d)).toHaveLength(0)
      // a model nobody told about the link is not woken
      expect(woken(d)).toEqual([])
    })

    test('the registration read is repeated about every minimum round', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out', unregistered: true })
      d.world.machine.waitMs = 0
      await startSession($, d, surface)
      await d.clock.advance(60_000)
      // 60 s at a minimum round of 5 s: about twelve calls, never a tight loop
      expect(d.world.machine.calls.length).toBeLessThanOrEqual(14)
      expect(d.world.machine.calls.length).toBeGreaterThan(3)
    })

    test("the model's own session_connect is told to send the person to the link, and not to open it, and starts no second registration read", async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out', unregistered: true })
      modelMeetsMachine(on)
      await startSession($, d, surface)
      const ran = await $.tool.call(MODEL_CALL)
      const note = ran.context.filter((c: string) => c.includes(REGISTRATION_URL))
      expect(note).toHaveLength(1)
      expect(note[0]).toContain('Do not open the link yourself')
      expect(note[0]).toContain(CLAIM_CODE)
      // the model's call joins the band's running watch while its read is still waiting
      await d.clock.advance(1_000)
      expect(d.world.machine.maxActive).toBe(1)
    })

    test('the model that was told is woken when the person accepts, and the wake needs no key in the machine-wide store', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out', unregistered: true })
      modelMeetsMachine(on)
      await startSession($, d, surface)
      await $.tool.call(MODEL_CALL)
      await d.clock.settle()
      expect(woken(d)).toEqual([])
      d.world.machine.registered = true
      await d.clock.advance(45_000)
      await d.clock.settle()
      expect(woken(d)).toEqual([relayLine(machineRegisteredNote(CLAIM_CODE))])
      expect(d.relay.told).toEqual([])
      expect(d.relay.storeSets.filter(k => k === 'permissionTold')).toEqual([])
    })

    test("another session's telling of the same claim code (the store every session on the machine shares) does not keep this session's model asleep", async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out', unregistered: true })
      // what a guard in the shared store would hold after another session's model was woken for this very code
      d.stored.set('permissionTold', [`registration:${CLAIM_CODE}`])
      modelMeetsMachine(on)
      await startSession($, d, surface)
      await $.tool.call(MODEL_CALL)
      d.world.machine.registered = true
      await d.clock.advance(45_000)
      await d.clock.settle()
      expect(woken(d)).toEqual([relayLine(machineRegisteredNote(CLAIM_CODE))])
    })

    test('a re-registration that keeps the claim code and is accepted again wakes the model that was told about it again, and a model never told is not woken', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out', unregistered: true })
      modelMeetsMachine(on)
      await startSession($, d, surface)
      await $.tool.call(MODEL_CALL)
      d.world.machine.registered = true
      await d.clock.advance(45_000)
      await d.clock.settle()
      expect(woken(d)).toHaveLength(1)
      // the machine is unregistered again; this time nobody told the model, so accepting wakes nobody
      d.world.machine.registered = false
      d.world.machine.requested = false
      await forceRefresh($, d)
      await d.clock.advance(10_000)
      d.world.machine.registered = true
      await d.clock.advance(45_000)
      await d.clock.settle()
      expect(woken(d)).toHaveLength(1)
      // and once more with the model told: it is woken a second time
      d.world.machine.registered = false
      d.world.machine.requested = false
      await $.tool.call(MODEL_CALL)
      d.world.machine.registered = true
      await d.clock.advance(45_000)
      await d.clock.settle()
      expect(woken(d)).toEqual([relayLine(machineRegisteredNote(CLAIM_CODE)), relayLine(machineRegisteredNote(CLAIM_CODE))])
    })

    test('a press of Sign in that meets an unregistered machine shows the link, never stops naming the state, makes no access request, and Sign in returns when the person accepts', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out' })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(await buttons(band)).toContain('Sign in')
      // the machine lost its registration after the band drew: the press meets it
      d.world.machine.registered = false
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      expect(plainConnects(d)).toHaveLength(1)
      expect(d.world.signIn.requested).toBe(false)
      expect(d.toasts.some(t => /Sign in stopped|machine_registration/.test(t))).toBe(false)
      expect((await linksOf(band)).map(l => l.href)).toEqual([REGISTRATION_URL])
      expect(await buttons(band)).not.toContain('Sign in')
      expect(await buttons(band)).not.toContain('Signing in…')
      d.world.machine.registered = true
      await d.clock.advance(60_000)
      await d.clock.settle()
      expect((await linksOf(band)).map(l => l.href)).toEqual([])
      expect(await buttons(band)).toContain('Sign in')
      expect(plainConnects(d)).toHaveLength(1)
    })

    for (const refuse of ['deny', 'error'] as const) {
      test(`an older platform MCP that refuses registration_only (${refuse === 'deny' ? 'a thrown call' : 'an error result'}) is told as a failed check, and the band still offers Sign in`, async ($, on) => {
        const d = dashboard(on, { signedOut: 'signed-out', unregistered: true })
        d.world.machine.refuse = refuse
        await startSession($, d, surface)
        const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
        await d.clock.settle()
        expect(d.toasts.some(t => t.startsWith('Machine registration check failed'))).toBe(true)
        expect(await buttons(band)).toContain('Sign in')
      })
    }

    test('a watch stopped on an error is not started again by a later signed-out load, so its failure toasts once', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out', unregistered: true })
      d.world.machine.refuse = 'error'
      await startSession($, d, surface)
      await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      await d.clock.settle()
      const failures = () => d.toasts.filter(t => t.startsWith('Machine registration check failed')).length
      expect(failures()).toBe(1)
      await forceRefresh($, d)
      await d.clock.settle()
      expect(failures()).toBe(1)
      expect(d.world.machine.calls).toHaveLength(1)
    })
  })
}
