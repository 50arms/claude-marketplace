import "./run-tests-with-npm-test.generated"
// CP-43 (PLAN-116 "The agent queue"): `/50arms-ready` signs a session in and joins the team's list of ready agents for its folder's repo. After its plan or card work the session clears
// by handshake (DEC-359: 50 Arms asks, the session wraps up and says ready, 50 Arms releases the clear) and rejoins by itself. A person's Stop takes it off the list and says so.
import { describe, expect } from 'claude-code/testing'

import * as readyLoopModule from '../hooks/ready/loop'
import { READY_COMMAND, READY_DISCONNECTED, READY_JOINING, READY_JUDGE_PROMPT, READY_NOT_GITHUB, READY_NOT_REGISTERED, READY_NO_AGENT_AGAIN, READY_NO_ORIGIN, READY_OFF, READY_PERMISSION_ENDED, READY_RELAY_OLDER, READY_SHELL_HOLDS_RESET, READY_SIGN_IN_ENDED, READY_STOPPED, READY_TICK_MS, READY_USAGE, CLEAR_SPENT_PREFIX, clearSpentKey, holdsWork, markAnswerOf, parseGithubOrigin, readyAdopted, readyAgentChanged, readyJoined, readyJoinedOnWork, readyLoopUnread, readyMarkRefused, readyRejoined, readyRevoked, readyWorkTaken, releaseOfClearFile, repoNameCandidates, repoNameFor, serverLoopOf, sessionIdOf, stoppedByPerson } from '../hooks/ready/loop'
import { LOCK_STALE_MS, NOT_CONNECTED_RETRY_MS, SIGN_IN_MIN_ROUND_MS, toolName } from '../hooks/plan/config'
import { USED_RELEASE_KEEP } from '../hooks/compaction/control'
import { sessionFilePath } from '../hooks/relay/session-file'
import { NO_AGENT, signInStep } from '../hooks/plan/sign-in'
import { connectToolOutcome, isSignedOut, textOutcome, toolOutcome } from '../hooks/plan/mcp'
import { leaveSession, takeLoadPauseReads, test, BAD_SESSION_ID, BAD_SESSION_ID_PATH, SESSION_ID, HOME_DIR, OWN_SESSION, APPROVAL_PENDING, APPROVAL_REQUIRED, APPROVAL_URL, DASHBOARD_URL, KEY_REVOKED_HALT, REVOKER, EVENT_TEXT, dashboard, linksOf, startSession, assertHoldsUsed, makeTest } from './plan-kit'

const AGENT = { id: 6, name: 'Tendai', avatar_url: null }
const REPO = 'acme-app'
const ORIGIN = 'git@github.com:Acme/App.git\n'
const ROWS = [
  { name: 'other', github_remote: { owner: 'acme', repo: 'other' } },
  { name: 'gitlab-one', github_remote: null },
  { name: REPO, github_remote: { owner: 'acme', repo: 'app' } },
]
const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'completed' }
const CARD = { id: 'DX-77', title: 'A held card' }
// the route whose answer carries the server's ready loop on every look
const ME = 'GET /api/plan-sessions/me'
// another session of the same team
const OTHER_SESSION_ID = '7d1f3a52-0c4e-4b8e-9f21-5a6b7c8d9e0f'

describe('reading a folder repo, a session row and a clear file', () => {
  test('every origin form danxbot:start accepts gives the owner and repo; any other host gives none', () => {
    const want = { owner: 'acme', repo: 'app' }
    for (const url of ['https://github.com/acme/app.git', 'https://github.com/acme/app', 'git@github.com:acme/app.git', 'git@github.com-work:acme/app.git', 'ssh://git@github.com/acme/app.git', 'git@github.com:acme/app.git\n']) {
      expect(parseGithubOrigin(url)).toEqual(want)
    }
    for (const url of ['https://gitlab.com/acme/app.git', 'git@gitlab.com:acme/app.git', 'not a url', '']) expect(parseGithubOrigin(url)).toBe(null)
  })

  test('the registered name is found whatever the letter case of the remote, and none for an unregistered repo', () => {
    expect(repoNameFor(ROWS, { owner: 'Acme', repo: 'APP' })).toBe(REPO)
    expect(repoNameFor(ROWS, { owner: 'acme', repo: 'nope' })).toBe(null)
  })

  test('a repos answer with no list is a failure, never no repo', () => {
    expect(() => repoNameFor(undefined, { owner: 'a', repo: 'b' })).toThrow('bad_response')
  })

  test('a row holds work when it names a plan or a card; anything unreadable is a failure, never no work', () => {
    expect(holdsWork({ plan_id: null, card_id: null })).toBe(false)
    expect(holdsWork({ plan_id: 23, card_id: null })).toBe(true)
    expect(holdsWork({ plan_id: null, card_id: 'DX-1' })).toBe(true)
    for (const row of [null, undefined, {}, { plan_id: null }, { plan_id: '23', card_id: null }, { plan_id: null, card_id: 7 }]) expect(() => holdsWork(row)).toThrow('bad_response')
  })

  test("the server's ready loop reads as it answers it: no loop, a loop between jobs, or a job with the server's verdict; anything else is a failure, never no loop", () => {
    expect(serverLoopOf({ ready_loop: null }, ME)).toBe(null)
    expect(serverLoopOf({ ready_loop: { repo: REPO, job: null, ended: false, release_id: null } }, ME)).toEqual({ repo: REPO, job: null, ended: false, releaseId: null })
    expect(serverLoopOf({ ready_loop: { repo: REPO, job: { kind: 'card', id: 'DX-1' }, ended: true, release_id: 'r1' } }, ME)).toEqual({ repo: REPO, job: { kind: 'card', id: 'DX-1' }, ended: true, releaseId: 'r1' })
    expect(serverLoopOf({ ready_loop: { repo: REPO, job: { kind: 'plan', id: 23 }, ended: false, release_id: null } }, ME)).toEqual({ repo: REPO, job: { kind: 'plan', id: 23 }, ended: false, releaseId: null })
    for (const body of [
      {},
      undefined,
      { ready_loop: 'x' },
      { ready_loop: { job: null, ended: false } },
      { ready_loop: { repo: REPO, job: null } },
      { ready_loop: { repo: REPO, job: null, ended: false } },
      { ready_loop: { repo: REPO, job: null, ended: false, release_id: 7 } },
      { ready_loop: { repo: REPO, job: null, ended: 'no' } },
      { ready_loop: { repo: REPO, job: { kind: 'card', id: 7 }, ended: true, release_id: null } },
      { ready_loop: { repo: REPO, job: { kind: 'plan', id: '23' }, ended: true, release_id: null } },
      { ready_loop: { repo: REPO, job: { kind: 'epic', id: 'DX-1' }, ended: true, release_id: null } },
    ]) expect(() => serverLoopOf(body, ME)).toThrow(`bad_response: ${ME} answered`)
  })

  test('a mark answers that the session waits on the list, or, for a session on work, the loop it joined with that work as its job; anything else is a failure, never a mark', () => {
    const route = 'PUT /api/plan-sessions/me/ready'
    expect(markAnswerOf({ ready: true, repo: REPO, since: 'x', ready_loop: null })).toEqual({ kind: 'marked' })
    expect(markAnswerOf({ ready: null, repo: REPO, since: null, ready_loop: { repo: REPO, job: { kind: 'card', id: 'DX-1' }, ended: false, release_id: null } })).toEqual({ kind: 'joined', job: { kind: 'card', id: 'DX-1' } })
    expect(markAnswerOf({ ready: null, repo: REPO, since: null, ready_loop: { repo: REPO, job: { kind: 'plan', id: 23 }, ended: true, release_id: null } })).toEqual({ kind: 'joined', job: { kind: 'plan', id: 23 } })
    for (const body of [{}, undefined, { ready: false }, { ready: 'yes' }, { ready: null, ready_loop: null }, { ready: null }, { ready: null, ready_loop: { repo: REPO, job: null, ended: false, release_id: null } }, { ready: null, ready_loop: { repo: REPO, job: { kind: 'card', id: 7 }, ended: false, release_id: null } }]) {
      expect(() => markAnswerOf(body)).toThrow(`bad_response: ${route} answered`)
    }
  })

  test("the clear file gives the release 50 Arms agreed to; askedAt is the relay's own memory and changes nothing; a file of another session, or one the relay would not write, is refused", () => {
    const file = (over: object) => JSON.stringify({ v: 1, sessionId: SESSION_ID, control: null, askedAt: null, ...over })
    expect(sessionFilePath(HOME_DIR, 'clear', SESSION_ID)).toBe(`${HOME_DIR}/.config/danxbot/clear/${SESSION_ID}.json`)
    // the MCP keeps no file for an id that is not plain, so no such id reaches a path
    for (const id of ['../other', 'a/b', 'a.b', '']) expect(sessionFilePath(HOME_DIR, 'clear', id)).toBe(null)
    expect(releaseOfClearFile(null, SESSION_ID)).toBe(null)
    expect(releaseOfClearFile(file({}), SESSION_ID)).toBe(null)
    for (const askedAt of [null, '2026-10-03T08:00:00.000Z']) {
      expect(releaseOfClearFile(file({ control: { releaseId: 'r1' }, askedAt }), SESSION_ID)).toBe('r1')
      expect(releaseOfClearFile(file({ askedAt }), SESSION_ID)).toBe(null)
    }
    expect(() => releaseOfClearFile(file({ control: { releaseId: 'r1' } }), OTHER_SESSION_ID)).toThrow('written for another session')
    for (const text of ['not json', file({ v: 2 }), JSON.stringify({ v: 1, control: null, askedAt: null }), JSON.stringify({ v: 1, sessionId: SESSION_ID, askedAt: null }), file({ control: { releaseId: '' } }), file({ control: 'r1' }), file({ control: {} })]) {
      expect(() => releaseOfClearFile(text, SESSION_ID)).toThrow('clear file')
    }
  })

  test("a danxbot_api answer the MCP sent as a file names that file and carries no body, so its reader reads the file; an inline answer names none", () => {
    expect(textOutcome(JSON.stringify({ ok: true, status: 200, reply_file: { path: '/tmp/danx-api/a.json', bytes: 1, chars: 1, instruction: 'x' } }), false)).toEqual({ ok: true, status: 200, body: undefined, replyFile: '/tmp/danx-api/a.json' })
    const inline = textOutcome(JSON.stringify({ ok: true, status: 200, body: { a: 1 } }), false)
    expect(inline).toEqual({ ok: true, status: 200, body: { a: 1 } })
    expect('replyFile' in inline).toBe(false)
  })

  test("a Stop's words are the interrupt of a running command and Claude Code's hold, and no other failure", () => {
    expect(stoppedByPerson('HooksError: remote-cancel')).toBe(true)
    expect(stoppedByPerson('danxbot: $.command.run: the session was stopped and nobody has sent input since')).toBe(true)
    expect(stoppedByPerson('no implementation for command.run')).toBe(false)
  })

  test("a session row names the session's own dashboard id; a row without one is a failure, never an id", () => {
    expect(sessionIdOf({ session_id: SESSION_ID, plan_id: null, card_id: null })).toBe(SESSION_ID)
    for (const row of [{ plan_id: null, card_id: null }, { session_id: 7 }, { session_id: '' }]) expect(() => sessionIdOf(row)).toThrow('bad_response')
  })

  // DEC-405: the platform is 50 Arms. The one existing name a person may still be sent to is the `/danxbot:start` command, renamed with the other existing names later.
  test('nothing the ready loop says to a person or the model says danx: every text the loop module defines, and its no-agent words', () => {
    const texts: string[] = [...Object.values(NO_AGENT)]
    for (const [name, value] of Object.entries(readyLoopModule)) {
      if (typeof value === 'string') texts.push(value)
      // every text builder is named ready*; a job, where one takes one, reads as no job here, and its words are what is checked
      else if (typeof value === 'function' && /^ready[A-Z]/.test(name)) texts.push((value as (...args: string[]) => string)('x', 'y'))
    }
    expect(texts.filter(t => t.includes(`/${READY_COMMAND}`)).length).toBeGreaterThan(10)
    for (const text of texts) expect(text.replaceAll('/danxbot:start', '')).not.toMatch(/danx/i)
  })

  test('the names tried first are the ones danxbot:start gives', () => {
    expect(repoNameCandidates({ owner: 'Acme', repo: 'My.App' })).toEqual(['my-app', 'acme-my-app'])
    expect(repoNameCandidates({ owner: 'acme', repo: '...' })).toEqual(['acme----'])
  })
})

describe('a plan-less plan_connect that holds a key', () => {
  const answer = (body: object) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] })

  test('holding its team agent is signed in, never a stopped sign-in', () => {
    expect(signInStep(answer({ state: 'agent_held', agent: AGENT, instruction: 'Use this name.' }))).toEqual({ kind: 'done' })
  })

  test('with no agent to hold it stops and says why in the words of the person', () => {
    for (const [state, words] of [['agent_needed', 'no team agent exists'], ['agent_limit_reached', 'every team agent is in use']]) {
      const step: any = signInStep(answer({ state, instruction: 'Tell the person.' }))
      expect(step.kind).toBe('stop')
      expect(step.message).toContain(words)
      expect(step.message).not.toContain(state)
    }
  })
})

describe('a connect tool answer and a request_permission answer', () => {
  const result = (body: object) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] })

  test("a connect tool's access request reads as signed out, a new one and a waiting one alike", () => {
    for (const answer of [APPROVAL_REQUIRED, APPROVAL_PENDING]) expect(isSignedOut(connectToolOutcome(result(answer)))).toBe(true)
  })

  test("request_permission's answer of the same shape on a key that works is no sign-out: only a connect tool's is read as access", () => {
    for (const answer of [APPROVAL_REQUIRED, APPROVAL_PENDING]) expect(isSignedOut(toolOutcome(result(answer)))).toBe(false)
  })
})

describe('the ready-agent loop', () => {
  // a signed-in session on no plan, in a folder whose repo the team has registered; `on('turn.*')` lets the suite end turns
  async function started($: any, on: any, options: Parameters<typeof dashboard>[1] = {}) {
    on('turn.complete', () => ({ text: 'done' }) as any)
    const d = dashboard(on, { connected: false, ...options })
    d.world.agent = AGENT
    d.world.repos = ROWS
    d.world.processes.git = { stdout: ORIGIN }
    await startSession($, d, 'desktop')
    return d
  }
  async function ready($: any, d: any) {
    const answer = await $.command.run({ command: '50arms-ready' })
    await d.clock.settle()
    return answer
  }
  const turnEnds = async ($: any, d: any, extra: object = {}) => {
    await $.turn.complete({ ...TURN, ...extra })
    await d.clock.settle()
  }
  const tick = async (d: any) => {
    await d.clock.advance(READY_TICK_MS)
    await d.clock.settle()
  }
  const bandTexts = async ($: any) => {
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', component: 'AbovePrompt', props: {} } as any)
    return (await band.findAll({ type: 'Text' })).map((t: any) => t.text)
  }
  // the clear file the MCP keeps for the session under its dashboard id (`~/.config/danxbot/clear/<sessionId>.json`), with the release 50 Arms agreed to, or none
  const clearFileAt = (sessionId: string) => `${HOME_DIR}/.config/danxbot/clear/${sessionId}.json`
  const clearFile = (d: any, releaseId: string | null, sessionId = SESSION_ID, at = SESSION_ID) => {
    d.world.files[clearFileAt(at)] = JSON.stringify({ v: 1, sessionId, control: releaseId === null ? null : { releaseId }, askedAt: '2026-10-03T08:00:00.000Z' })
  }
  // the server hands the session a card: the session holds it, the mark goes with the connect, and the server's loop takes the card as its job, ended once it is Done or Cancelled
  const handCard = (d: any, status: string, card = CARD) => {
    d.world.readyMark = null
    d.world.card = card
    d.world.cards.push({ id: card.id, title: card.title, problems: [] } as any)
    d.world.cardStatus[card.id] = status
    d.world.readyLoop = { repo: REPO, job: { kind: 'card', id: card.id }, ended: status === 'Done' || status === 'Cancelled' }
  }
  // the same for a plan: ended as the server judges it
  const handPlan = (d: any, ended: boolean, planId = 23) => {
    d.world.readyMark = null
    d.world.planId = planId
    d.world.readyLoop = { repo: REPO, job: { kind: 'plan', id: planId }, ended }
  }
  // the job has ended as the server judges it, 50 Arms asked, the model said ready, and the MCP wrote the release into the clear file
  const released = (d: any, releaseId = 'r1') => {
    d.world.readyLoop = { ...d.world.readyLoop, ended: true }
    d.world.clearAgreed = true
    d.world.releaseId = releaseId
    clearFile(d, releaseId)
  }
  const readyDeletes = (d: any) => d.calls.filter((c: any) => c.tool === 'danxbot_api' && c.args.method === 'DELETE' && c.args.path === '/api/plan-sessions/me/ready').length

  test('the command registers, and joins the list for the repo of the folder', async ($, on) => {
    const d = await started($, on)
    expect(d.commands).toContain('50arms-ready')
    const answer: any = await ready($, d)
    expect(answer.text).toBe(READY_JOINING)
    expect(d.world.readyMark).toBe(REPO)
    expect(d.toasts).toContain(readyJoined(REPO))
  })

  test('the skill joins the list as the command does, tells the model the same line, and `off` leaves; any other tool or skill is left alone', async ($, on) => {
    on('tool.call', () => ({ result: 'loaded' }) as any)
    const d = await started($, on)
    const other: any = await $.tool.call({ tool: 'Skill', skill: 'danxbot:start' } as any)
    await d.clock.settle()
    expect(d.world.readyMark).toBe(null)
    expect(other.context ?? []).not.toContain(READY_JOINING)
    const joined: any = await $.tool.call({ tool: 'Skill', skill: 'danxbot:50arms-ready' } as any)
    await d.clock.settle()
    expect(joined.context).toContain(READY_JOINING)
    expect(d.world.readyMark).toBe(REPO)
    const left: any = await $.tool.call({ tool: 'Skill', skill: '50arms-ready', args: 'off' } as any)
    await d.clock.settle()
    expect(left.context).toContain(READY_OFF)
    expect(d.world.readyMark).toBe(null)
  })

  test('a signed-out session signs in with the one command, connecting no plan, then joins, and the model is told nothing', async ($, on) => {
    const d = await started($, on)
    d.world.signedOut = 'signed-out'
    await ready($, d)
    expect(d.world.signIn.calls).toHaveLength(1)
    expect((d.world.signIn.calls[0] as any).plan_id).toBe(undefined)
    expect(d.world.readyMark).toBe(null)
    d.world.signIn.approved = true
    await d.clock.advance(60_000)
    await d.clock.settle()
    await tick(d)
    expect(d.world.readyMark).toBe(REPO)
    expect(d.relay.submitted).toEqual([])
  })

  test('a first join that signs in and finds no agent free stays in the loop and says so once, and only /50arms-ready joins it when one frees', async ($, on) => {
    const d = await started($, on)
    d.world.signedOut = 'signed-out'
    d.world.signIn.answer = { text: JSON.stringify({ state: 'agent_limit_reached', instruction: 'Tell the person.' }) }
    await ready($, d)
    expect(d.toasts).not.toContain(READY_SIGN_IN_ENDED)
    expect(d.toasts.filter((t: string) => t.includes('every team agent is in use'))).toHaveLength(1)
    // the MCP's own gate is closed now
    d.world.signedOut = null
    d.world.signIn.answer = undefined
    d.world.agent = null
    d.world.agentGate = 'agent_limit_reached'
    d.world.agentClaim = { state: 'agent_limit_reached', instruction: 'Tell the person.' }
    await tick(d)
    await tick(d)
    expect(d.toasts.filter((t: string) => t.includes('every team agent is in use'))).toHaveLength(1)
    d.world.agentClaim = null
    await tick(d)
    expect(d.world.readyMark).toBe(null)
    await ready($, d)
    expect(d.world.readyMark).toBe(REPO)
  })

  test('a sign-in watch that ends with no answer is asked again, not left silent', async ($, on) => {
    on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
    const d = await started($, on)
    d.world.signedOut = 'signed-out'
    await ready($, d)
    await $.session.end({ reason: 'clear', sessionId: 'sess-own' } as any)
    await d.clock.settle()
    await d.clock.advance(60_000)
    await d.clock.settle()
    const asked = d.world.signIn.calls.length
    await tick(d)
    await tick(d)
    await tick(d)
    expect(d.world.signIn.calls.length).toBeGreaterThan(asked)
  })

  test('a join tells the model nothing: no prompt reaches it, and the normal repo needs no second approval', async ($, on) => {
    const d = await started($, on)
    // the team's list is out of this key's reach, and the join does not need it
    d.world.reposAnswer = { status: 403, body: { error: 'forbidden', permission: 'boards.view' } }
    await ready($, d)
    expect(d.relay.submitted).toEqual([])
    expect(d.world.readyMark).toBe(REPO)
    expect(d.toasts.filter((t: string) => t.includes(APPROVAL_URL))).toEqual([])
  })

  test('a sign-in that is denied leaves the list and says so', async ($, on) => {
    const d = await started($, on)
    d.world.signedOut = 'signed-out'
    await ready($, d)
    d.world.signIn.answer = { text: JSON.stringify({ state: 'denied' }) }
    await d.clock.advance(60_000)
    await d.clock.settle()
    await tick(d)
    expect(d.toasts).toContain(READY_SIGN_IN_ENDED)
    expect(readyDeletes(d)).toBe(1)
    // it left: the approval is gone with it, and a look that would have asked again asks nothing
    const calls = d.world.signIn.calls.length
    await tick(d)
    await tick(d)
    expect(d.world.signIn.calls.length).toBe(calls)
  })

  test('a session holding no agent claims one, then joins', async ($, on) => {
    const d = await started($, on)
    d.world.agent = null
    d.world.agentGate = 'agent_not_held'
    await ready($, d)
    expect(d.world.agent).not.toBe(null)
    expect(d.world.readyMark).toBe(REPO)
  })

  test('with no agent free it says so once, and joins when one is', async ($, on) => {
    const d = await started($, on)
    d.world.agent = null
    d.world.agentGate = 'agent_not_held'
    d.world.agentClaim = { state: 'agent_needed', instruction: 'Ask a person.' }
    await ready($, d)
    await tick(d)
    await tick(d)
    const told = d.toasts.filter((t: string) => t.includes('no team agent exists'))
    expect(told).toHaveLength(1)
    expect(d.world.readyMark).toBe(null)
    d.world.agentClaim = null
    await tick(d)
    expect(d.world.readyMark).toBe(REPO)
  })

  describe('a repo registered under a name danxbot:start would not give it', () => {
    const CUSTOM = [{ name: 'our-name', github_remote: { owner: 'acme', repo: 'app' } }]

    test('asks a person once through the band, tells the model nothing when it is granted, and joins', async ($, on) => {
      const d = await started($, on)
      d.world.repos = CUSTOM
      d.world.reposAnswer = { status: 403, body: { error: 'forbidden', permission: 'boards.view' } }
      await ready($, d)
      await tick(d)
      expect(d.toasts.filter((t: string) => t.includes(APPROVAL_URL))).toHaveLength(1)
      expect(d.world.readyMark).toBe(null)
      d.world.reposAnswer = null
      d.world.permissionClaim = 'approved'
      d.world.permissionGranted = ['boards.view']
      await d.clock.advance(30_000)
      await d.clock.settle()
      await tick(d)
      expect(d.world.readyMark).toBe('our-name')
      expect(d.relay.submitted).toEqual([])
    })

    test('/50arms-ready off takes its open request along: a later approval tells the model nothing', async ($, on) => {
      const d = await started($, on)
      d.world.repos = CUSTOM
      d.world.reposAnswer = { status: 403, body: { error: 'forbidden', permission: 'boards.view' } }
      await ready($, d)
      await $.command.run({ command: '50arms-ready', args: 'off' })
      await d.clock.settle()
      d.world.permissionClaim = 'approved'
      d.world.permissionGranted = ['boards.view']
      await d.clock.advance(30_000)
      await d.clock.settle()
      expect(d.relay.submitted).toEqual([])
    })

    test('approved with nothing granted leaves the list and says so', async ($, on) => {
      const d = await started($, on)
      d.world.repos = CUSTOM
      d.world.reposAnswer = { status: 403, body: { error: 'forbidden', permission: 'boards.view' } }
      await ready($, d)
      d.world.permissionClaim = 'approved'
      d.world.permissionGranted = []
      await d.clock.advance(30_000)
      await d.clock.settle()
      expect(d.toasts).toContain(READY_PERMISSION_ENDED)
    })

    test('a denied approval leaves the list, says so, and tells the model nothing', async ($, on) => {
      const d = await started($, on)
      d.world.repos = CUSTOM
      d.world.reposAnswer = { status: 403, body: { error: 'forbidden', permission: 'boards.view' } }
      await ready($, d)
      d.world.permissionClaim = 'denied'
      await d.clock.advance(30_000)
      await d.clock.settle()
      expect(d.toasts).toContain(READY_PERMISSION_ENDED)
      expect(d.world.readyCleared).toBe(1)
      expect(d.relay.submitted).toEqual([])
      d.world.reposAnswer = null
      await tick(d)
      expect(d.world.readyMarks).toEqual([])
    })

    test('a person who cannot be asked for the permission leaves the list, told why, and it is asked once', async ($, on) => {
      const d = await started($, on)
      d.world.repos = CUSTOM
      d.world.reposAnswer = { status: 403, body: { error: 'forbidden', permission: 'boards.view' } }
      d.world.permissionAskRefused = 'role_lacks_permission'
      await ready($, d)
      await tick(d)
      await tick(d)
      expect(d.world.permissionAsks).toBe(1)
      expect(d.toasts.filter((t: string) => t.startsWith('This session left the ready list: it could not ask') && t.includes('role_lacks_permission'))).toHaveLength(1)
      expect(d.toasts.filter((t: string) => t.includes('{"ok"'))).toEqual([])
    })

    test('/50arms-ready off while an ask that will be refused is on its way: no toast and no second DELETE', async ($, on) => {
      const d = await started($, on)
      d.world.repos = CUSTOM
      d.world.reposAnswer = { status: 403, body: { error: 'forbidden', permission: 'boards.view' } }
      d.world.permissionAskRefused = 'role_lacks_permission'
      let release!: () => void
      d.world.permissionAskHold = new Promise<void>(r => (release = r))
      await $.command.run({ command: '50arms-ready' })
      await d.clock.settle()
      d.world.permissionAskHold = null
      await $.command.run({ command: '50arms-ready', args: 'off' })
      await d.clock.settle()
      const cleared = d.world.readyCleared
      release()
      await d.clock.settle()
      expect(d.world.readyCleared).toBe(cleared)
      expect(d.toasts.filter((t: string) => t.includes('role_lacks_permission'))).toEqual([])
    })

    test('an ask that throws leaves the list and says why, in the words of the person', async ($, on) => {
      const d = await started($, on)
      d.world.repos = CUSTOM
      d.world.reposAnswer = { status: 403, body: { error: 'forbidden', permission: 'boards.view' } }
      d.world.permissionAskDeny = 'request_permission is not available'
      await ready($, d)
      expect(d.toasts.filter((t: string) => t.startsWith('This session left the ready list: it could not ask') && t.includes('request_permission is not available'))).toHaveLength(1)
      expect(d.world.readyCleared).toBe(1)
    })

    test('/50arms-ready off while an ask that will throw is on its way: no toast and no second DELETE', async ($, on) => {
      const d = await started($, on)
      d.world.repos = CUSTOM
      d.world.reposAnswer = { status: 403, body: { error: 'forbidden', permission: 'boards.view' } }
      d.world.permissionAskDeny = 'request_permission is not available'
      let release!: () => void
      d.world.permissionAskHold = new Promise<void>(r => (release = r))
      await $.command.run({ command: '50arms-ready' })
      await d.clock.settle()
      d.world.permissionAskHold = null
      await $.command.run({ command: '50arms-ready', args: 'off' })
      await d.clock.settle()
      const cleared = d.world.readyCleared
      release()
      await d.clock.settle()
      expect(d.world.readyCleared).toBe(cleared)
      expect(d.toasts.filter((t: string) => t.includes('could not ask'))).toEqual([])
    })

    test('/50arms-ready off while the ask is on its way: no link is drawn, and its grant tells the model nothing', async ($, on) => {
      const d = await started($, on)
      d.world.repos = CUSTOM
      d.world.reposAnswer = { status: 403, body: { error: 'forbidden', permission: 'boards.view' } }
      let release!: () => void
      d.world.permissionAskHold = new Promise<void>(r => (release = r))
      await $.command.run({ command: '50arms-ready' })
      await d.clock.settle()
      d.world.permissionAskHold = null
      await $.command.run({ command: '50arms-ready', args: 'off' })
      await d.clock.settle()
      release()
      await d.clock.settle()
      expect(d.toasts.filter((t: string) => t.includes(APPROVAL_URL))).toEqual([])
      d.world.permissionClaim = 'approved'
      d.world.permissionGranted = ['boards.view']
      await d.clock.advance(30_000)
      await d.clock.settle()
      expect(d.relay.submitted).toEqual([])
    })

    test('granted and the list still refuses: the role does not reach it, so it leaves the list and says so', async ($, on) => {
      const d = await started($, on)
      d.world.repos = CUSTOM
      d.world.reposAnswer = { status: 403, body: { error: 'forbidden', permission: 'boards.view' } }
      await ready($, d)
      d.world.permissionClaim = 'approved'
      d.world.permissionGranted = ['boards.view']
      await d.clock.advance(30_000)
      await d.clock.settle()
      await tick(d)
      expect(d.toasts).toContain(READY_PERMISSION_ENDED)
      expect(d.world.permissionAsks).toBe(1)
    })

    test('the team list is read past its first page', async ($, on) => {
      const d = await started($, on)
      d.world.repos = [...Array.from({ length: 60 }, (_, i) => ({ name: `r${i}`, github_remote: { owner: 'acme', repo: `r${i}` } })), ...CUSTOM]
      await ready($, d)
      expect(d.world.readyMark).toBe('our-name')
    })
  })

  test('a session answer that is no object at all is told once too, never thrown', async ($, on) => {
    const d = await started($, on)
    d.world.plansBody = 'not an object'
    await ready($, d)
    await tick(d)
    expect(d.toasts.filter((t: string) => t.includes('answered no session field'))).toHaveLength(1)
    expect(d.world.readyMarks).toEqual([])
  })

  test('a session row with no session field is a failure told once, never a claim of an agent', async ($, on) => {
    const d = await started($, on)
    d.world.plansBody = { dashboard_url: DASHBOARD_URL }
    await ready($, d)
    await tick(d)
    expect(d.toasts.filter((t: string) => t.includes('answered no session field'))).toHaveLength(1)
    expect(d.world.readyMarks).toEqual([])
  })

  for (const [what, stdout, exitCode, told] of [
    ['no origin', '', 2, READY_NO_ORIGIN],
    ['an origin that is not GitHub', 'git@gitlab.com:acme/app.git\n', 0, READY_NOT_GITHUB],
    ['a repo the team has not registered', 'git@github.com:acme/unknown.git\n', 0, READY_NOT_REGISTERED],
  ] as const) {
    test(`${what} leaves the loop and says why`, async ($, on) => {
      const d = await started($, on)
      d.world.processes.git = { stdout, exitCode }
      await ready($, d)
      expect(d.toasts).toContain(told)
      // the folder is fine now, and a session still in the loop would mark: this one left
      d.world.processes.git = { stdout: ORIGIN }
      await tick(d)
      expect(d.world.readyMarks).toEqual([])
    })
  }

  test('marking again keeps running while it waits, and a lost mark comes back with no person', async ($, on) => {
    const d = await started($, on)
    await ready($, d)
    // a mark that stands is not written again
    await tick(d)
    await tick(d)
    expect(d.world.readyMarks).toEqual([REPO])
    d.world.readyMark = null
    await tick(d)
    expect(d.world.readyMark).toBe(REPO)
    expect(d.world.readyMarks).toEqual([REPO, REPO])
    expect(d.clearRuns).toEqual([])
  })

  test('a session that lost its agent while waiting claims one and rejoins, with no reset', async ($, on) => {
    const d = await started($, on)
    await ready($, d)
    // the server's own answer: the hold gate refuses every gated route, this read included, and the mark went with the agent
    d.world.agent = null
    d.world.readyMark = null
    d.world.agentGate = 'agent_not_held'
    await tick(d)
    expect(d.world.agentGate).toBe(null)
    expect(d.world.agent).not.toBe(null)
    expect(d.world.readyMark).toBe(REPO)
    expect(d.clearRuns).toEqual([])
  })

  test('with no agent free after losing one it says so once and waits, and rejoins when one is, since the MCP never refused it', async ($, on) => {
    const d = await started($, on)
    await ready($, d)
    d.world.agent = null
    d.world.readyMark = null
    d.world.agentGate = 'agent_not_held'
    d.world.agentClaim = { state: 'agent_needed', instruction: 'Ask a person.' }
    await tick(d)
    await tick(d)
    expect(d.toasts.filter((t: string) => t.includes('no team agent exists'))).toHaveLength(1)
    expect(d.world.readyMark).toBe(null)
    d.world.agentClaim = null
    await tick(d)
    expect(d.world.readyMark).toBe(REPO)
  })

  test('a mark refused by the hold gate after the look claims the agent at once', async ($, on) => {
    const d = await started($, on)
    await ready($, d)
    d.world.readyMark = null
    d.world.loseAgentAtMark = true
    await tick(d)
    expect(d.world.agentGate).toBe(null)
    expect(d.world.readyMark).toBe(REPO)
    expect(d.toasts.filter((t: string) => t.includes('marking this session ready'))).toEqual([])
  })

  test("a mark the route refuses as holding no agent keeps the loop: the claim clears it, as the hold gate's refusal does", async ($, on) => {
    const d = await started($, on)
    d.world.markRefusal = { status: 409, body: { error: 'no_agent', session_id: 'x' } }
    await ready($, d)
    expect(d.toasts.filter((t: string) => t.includes('refused to mark it ready'))).toEqual([])
    // the race the refusal names: the agent really went, so the next look must claim one before it marks
    d.world.agent = null
    d.world.markRefusal = null
    await tick(d)
    expect(d.world.agent).not.toBe(null)
    expect(d.world.readyMark).toBe(REPO)
    expect(d.toasts).toContain(readyJoined(REPO))
  })

  test('a mark that meets a card the session took in between joins the loop on that card: no mark, no failure told, nothing resets', async ($, on) => {
    const d = await started($, on)
    await ready($, d)
    d.world.readyMark = null
    d.world.cards.push({ id: CARD.id, title: CARD.title, problems: [] } as any)
    d.world.cardStatus[CARD.id] = 'In Progress'
    d.world.cardAtMark = CARD
    d.world.readySteps.length = 0
    await tick(d)
    expect(d.world.readySteps).toEqual([`join ${CARD.id}`])
    expect(d.world.readyLoop).toEqual({ repo: REPO, job: { kind: 'card', id: CARD.id }, ended: false })
    expect(d.world.readyMark).toBe(null)
    expect(d.toasts.filter((t: string) => t.includes('marking this session ready'))).toEqual([])
    expect(d.toasts).toContain(readyJoinedOnWork(REPO, { kind: 'card', id: CARD.id }))
    // on its job from here: no other ready call until the job ends
    await tick(d)
    expect(d.world.readySteps).toEqual([`join ${CARD.id}`])
    expect(d.clearRuns).toEqual([])
  })

  // DX-6697: the rejoin decides under the dashboard's locks before it writes anything, so an ended job that reopened since the release is no leave: the call joins the loop on that job and
  // empties the agreement. The clear file keeps the release this loop ran until the stream's next frame, so the job can end again while the file still holds it: only a new release clears again
  for (const [when, holdAt] of [
    ['while its /clear runs', 'clearHold'],
    ['while its rejoin call is on its way', 'markHold'],
  ] as const) {
    test(`a rejoin whose ended job reopened ${when} joins the loop on that job, told as no failure or reset; the job ending again before a new release clears nothing and leaves nothing, and the new release clears and rejoins`, async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'Done')
      released(d)
      d.world.readySteps.length = 0
      const hold = held()
      d.world[holdAt] = hold.promise
      await tick(d)
      d.world[holdAt] = null
      expect(d.world.clearsStarted).toBe(1)
      d.world.cardStatus[CARD.id] = 'In Progress'
      d.world.readyLoop = { ...d.world.readyLoop, ended: false }
      hold.release()
      await d.clock.settle()
      // the /clear ran and the rejoin met the reopened card: no leave, and the session keeps the card as the loop's job, with the agreement emptied
      expect(d.clearRuns).toHaveLength(1)
      expect(d.world.readySteps).toEqual(['clear', `join ${CARD.id}`])
      expect(d.world.card).toEqual(CARD)
      expect(d.world.readyLoop).toEqual({ repo: REPO, job: { kind: 'card', id: CARD.id }, ended: false })
      expect(d.world.clearAgreed).toBe(false)
      expect(d.toasts).toContain(readyJoinedOnWork(REPO, { kind: 'card', id: CARD.id }))
      expect(d.toasts.filter((t: string) => t.includes('marking this session ready') || t.includes('refused to mark'))).toEqual([])
      expect(d.toasts).not.toContain(readyRejoined(REPO))
      expect(d.world.readyCleared).toBe(0)
      // on the reopened job, which the row no longer judges ended: the file's release clears nothing again, and no other ready call is made while the job is open
      await tick(d)
      await turnEnds($, d)
      expect(d.clearRuns).toHaveLength(1)
      expect(d.world.readySteps).toEqual(['clear', `join ${CARD.id}`])
      // the job ends again while the clear file still holds the release this loop ran, and no agreement stands: the rejoin it still owes only joins the same job again
      d.world.cardStatus[CARD.id] = 'Done'
      d.world.readyLoop = { ...d.world.readyLoop, ended: true }
      await turnEnds($, d)
      await tick(d)
      await tick(d)
      expect(d.clearRuns).toHaveLength(1)
      expect(d.world.readySteps.slice(2).every((step: string) => step === `join ${CARD.id}`)).toBe(true)
      expect(d.world.card).toEqual(CARD)
      expect(d.world.readyMark).toBe(null)
      expect(d.world.readyCleared).toBe(0)
      // 50 Arms asks again, and the model's ready brings a new release: it clears once more, and this rejoin leaves the card and marks the session
      released(d, 'r2')
      await tick(d)
      expect(d.clearRuns).toHaveLength(2)
      expect(d.world.readySteps.slice(-3)).toEqual(['clear', `leave ${CARD.id}`, `mark ${REPO}`])
      expect(d.world.card).toBe(null)
      expect(d.world.readyMark).toBe(REPO)
      expect(d.toasts).toContain(readyRejoined(REPO))
      expect(d.toasts.filter((t: string) => t.includes('left the ready list'))).toEqual([])
    })
  }

  test('a mark answer the session cannot read is told once, never taken as a mark', async ($, on) => {
    const d = await started($, on)
    d.world.markRefusal = { status: 200, body: { ready: 'yes', repo: REPO } }
    await ready($, d)
    await tick(d)
    expect(d.toasts.filter((t: string) => t.includes('marking this session ready failed') && t.includes('neither true nor null'))).toHaveLength(1)
    expect(d.toasts).not.toContain(readyJoined(REPO))
  })

  describe('the clear handshake at the end of a job (DEC-359)', () => {
    test('a job on a card: nothing clears while it is open, nor once it has ended until 50 Arms releases the clear; then it clears once, and its one rejoin leaves the card and marks it, with no /compact', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'In Progress')
      d.world.readySteps.length = 0
      await tick(d)
      await turnEnds($, d)
      expect(d.world.readySteps).toEqual([])
      // ended and asked: the session wraps up and says ready in turns of its own, so nothing clears on the plugin's own say
      d.world.cardStatus[CARD.id] = 'Done'
      d.world.readyLoop = { ...d.world.readyLoop, ended: true }
      await turnEnds($, d)
      await tick(d)
      expect(d.world.readySteps).toEqual([])
      expect(d.world.card).toEqual(CARD)
      expect(readyDeletes(d)).toBe(0)
      released(d)
      await tick(d)
      expect(d.world.readySteps).toEqual(['clear', `leave ${CARD.id}`, `mark ${REPO}`])
      expect(d.world.card).toBe(null)
      expect(d.world.readyMark).toBe(REPO)
      expect(d.toasts).toContain(readyRejoined(REPO))
      // the rejoin left the card: the plugin made no leave of its own
      expect(d.calls.filter((c: any) => c.tool === 'card_connect')).toEqual([])
      // the MCP has not caught up yet, so the file still names the same release: it is run once
      await tick(d)
      await turnEnds($, d)
      expect(d.world.readySteps).toEqual(['clear', `leave ${CARD.id}`, `mark ${REPO}`])
    })

    // CP-55: the clear file names a release the server no longer stands behind (the job reopened and ended again while the stream was down): nothing clears and nothing is sent, until the
    // view names the release the file names
    test('a clear file naming a release the view no longer names clears nothing and sends nothing; once the view names the new release, it clears once and rejoins', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'Done')
      released(d)
      d.world.releaseId = null
      d.world.clearAgreed = false
      d.world.readySteps.length = 0
      const calls = d.calls.length
      await tick(d)
      await turnEnds($, d)
      await tick(d)
      expect(d.clearRuns).toHaveLength(0)
      expect(d.world.readySteps).toEqual([])
      expect(d.calls.slice(calls).filter((c: any) => c.tool === 'danxbot_api' && c.args.method === 'PUT')).toEqual([])
      // the view names a newer release than the file (r2 against r1) with the agreement standing: still nothing
      d.world.releaseId = 'r2'
      d.world.clearAgreed = true
      await tick(d)
      expect(d.clearRuns).toHaveLength(0)
      expect(d.world.readySteps).toEqual([])
      expect(d.calls.slice(calls).filter((c: any) => c.tool === 'danxbot_api' && c.args.method === 'PUT')).toEqual([])
      released(d, 'r2')
      await tick(d)
      expect(d.clearRuns).toHaveLength(1)
      expect(d.world.readySteps).toEqual(['clear', `leave ${CARD.id}`, `mark ${REPO}`])
      await tick(d)
      expect(d.clearRuns).toHaveLength(1)
    })

    test('a job on a plan goes the same way: kept while the server says it goes on, cleared and rejoined once 50 Arms releases the clear', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handPlan(d, false)
      d.world.readySteps.length = 0
      await tick(d)
      await turnEnds($, d)
      expect(d.world.planId).toBe(23)
      expect(d.world.readySteps).toEqual([])
      released(d)
      await turnEnds($, d)
      expect(d.world.readySteps).toEqual(['clear', 'leave 23', `mark ${REPO}`])
      expect(d.world.planId).toBe(null)
      expect(d.calls.filter((c: any) => c.tool === 'plan_connect' && c.args?.disconnect === true)).toEqual([])
    })

    test('the release is run once: a rejoin that failed after the /clear is made again on the next look, with no second /clear', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'Done')
      released(d)
      d.world.readySteps.length = 0
      d.world.markRefusal = { status: 502, body: { error: 'bad gateway' } }
      await tick(d)
      expect(d.clearRuns).toHaveLength(1)
      expect(d.toasts.filter((t: string) => t.includes('marking this session ready failed'))).toHaveLength(1)
      d.world.markRefusal = null
      await tick(d)
      expect(d.clearRuns).toHaveLength(1)
      expect(d.world.readySteps).toEqual(['clear', `leave ${CARD.id}`, `mark ${REPO}`])
      expect(d.toasts).toContain(readyRejoined(REPO))
    })

    test("the store keeps the newest sessions' spent clears only, this session's among them", async ($, on) => {
      const d = await started($, on)
      for (let i = 0; i < USED_RELEASE_KEEP + 5; i++) d.stored.set(`${CLEAR_SPENT_PREFIX}old-${i}`, { releaseId: 'r', at: 100 + i })
      d.stored.set('relayCursor:not-ours', { planId: 1, cursor: 'c', at: 1 })
      await ready($, d)
      handCard(d, 'Done')
      released(d)
      await tick(d)
      expect(d.clearRuns).toHaveLength(1)
      const kept = [...d.stored.keys()].filter((k: string) => k.startsWith(CLEAR_SPENT_PREFIX))
      expect(kept).toHaveLength(USED_RELEASE_KEEP)
      expect(kept).toContain(clearSpentKey(SESSION_ID))
      expect(kept).not.toContain(`${CLEAR_SPENT_PREFIX}old-0`)
      expect(d.stored.has('relayCursor:not-ours')).toBe(true)
    })

    test('a turn that begins while the /clear runs does not hold back the rejoin that follows it', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'Done')
      released(d)
      const clear = held()
      d.world.clearHold = clear.promise
      await tick(d)
      d.world.clearHold = null
      expect(d.world.clearsStarted).toBe(1)
      await $.turn.start({ turnId: 't2', prompt: 'hello' } as any)
      await turnEnds($, d)
      clear.release()
      await d.clock.settle()
      // no tick since: the look that cleared made the rejoin, and took its answer: it says so, and the next look finds the mark standing and writes none
      expect(d.world.readySteps.slice(-3)).toEqual(['clear', `leave ${CARD.id}`, `mark ${REPO}`])
      expect(d.toasts.filter((t: string) => t === readyRejoined(REPO))).toHaveLength(1)
      const marks = d.world.readyMarks.length
      await tick(d)
      expect(d.world.readyMarks).toHaveLength(marks)
      expect(d.toasts.filter((t: string) => t === readyRejoined(REPO))).toHaveLength(1)
    })

    test('a release the server no longer stands behind (its job reopened before the MCP caught up) clears nothing', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'Done')
      released(d)
      d.world.cardStatus[CARD.id] = 'In Progress'
      d.world.readyLoop = { ...d.world.readyLoop, ended: false }
      await tick(d)
      await turnEnds($, d)
      expect(d.clearRuns).toEqual([])
      expect(d.world.card).toEqual(CARD)
      expect(readyDeletes(d)).toBe(0)
    })

    test('a clear file written for another session is refused: told once, and nothing clears', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'Done')
      d.world.clearAgreed = true
      clearFile(d, 'r1', OTHER_SESSION_ID)
      await tick(d)
      await tick(d)
      expect(d.clearRuns).toEqual([])
      expect(d.toasts.filter((t: string) => t.includes('written for another session'))).toHaveLength(1)
    })

    test("a clear file the session cannot read is told once and clears nothing", async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'Done')
      d.world.files[clearFileAt(SESSION_ID)] = 'not json'
      await tick(d)
      await tick(d)
      expect(d.clearRuns).toEqual([])
      expect(d.toasts.filter((t: string) => t.includes('reading the clear file failed'))).toHaveLength(1)
    })

    test("the clear file is the one of the session's dashboard id, which the MCP keeps across a /clear: a release under the engine's own session id is not this session's, and the second job clears as the first did", async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'Done')
      d.world.clearAgreed = true
      // the engine's id, which is not the id the MCP signed the session in under
      clearFile(d, 'r0', OWN_SESSION.session_id, OWN_SESSION.session_id)
      await tick(d)
      expect(d.clearRuns).toEqual([])
      for (const [round, releaseId] of [[1, 'r1'], [2, 'r2']] as const) {
        handCard(d, 'Done')
        released(d, releaseId)
        await tick(d)
        expect(d.clearRuns).toHaveLength(round)
        expect(d.world.readyMark).toBe(REPO)
      }
      // the engine's id moved at each /clear; the file read stayed the dashboard's
      expect(d.clearRuns).toEqual([OWN_SESSION.session_id, `${OWN_SESSION.session_id}-cleared-1`])
    })

    test('nothing clears while a turn runs: a release waits for the turn to end', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'Done')
      released(d)
      await $.turn.start({ turnId: 't1', prompt: 'x' } as any)
      await tick(d)
      expect(d.clearRuns).toEqual([])
      await turnEnds($, d)
      expect(d.clearRuns).toHaveLength(1)
    })

    test('a running sub-agent holds the clear until it stops', async ($, on) => {
      on('classic.SubagentStart', () => ({}) as any)
      on('classic.SubagentStop', () => ({}) as any)
      const d = await started($, on)
      await ready($, d)
      await $.classic.SubagentStart({ agent_id: 'a1b2c3', agent_type: 'danxbot:worker-sonnet-high' } as any)
      handCard(d, 'Done')
      released(d)
      await turnEnds($, d)
      await tick(d)
      expect(d.world.card).toEqual(CARD)
      expect(d.clearRuns).toEqual([])
      await $.classic.SubagentStop({ agent_id: 'a1b2c3', agent_type: 'danxbot:worker-sonnet-high', stop_hook_active: false, agent_transcript_path: '/x/agent-a1b2c3.jsonl', background_tasks: [] } as any)
      await tick(d)
      expect(d.clearRuns).toHaveLength(1)
    })

    test('a background shell holds the clear until a Stop no longer lists it, and keeps the session on its work', async ($, on) => {
      on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' }, text: 'running' }) as any)
      on('classic.Stop', () => ({}) as any)
      const d = await started($, on)
      await ready($, d)
      await $.tool.call({ tool: 'Bash', command: 'sleep 100', run_in_background: true, description: 'sleep' } as any)
      handCard(d, 'Done')
      released(d)
      await turnEnds($, d)
      await tick(d)
      expect(d.clearRuns).toEqual([])
      expect(d.toasts.filter((t: string) => t === READY_SHELL_HOLDS_RESET)).toHaveLength(1)
      expect(d.world.card).toEqual(CARD)
      await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'bg1', status: 'running', type: 'shell' }] } as any)
      await tick(d)
      expect(d.clearRuns).toEqual([])
      await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as any)
      await tick(d)
      expect(d.clearRuns).toHaveLength(1)
    })

    test('a shell started before /50arms-ready holds the clear too', async ($, on) => {
      on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' }, text: 'running' }) as any)
      on('classic.Stop', () => ({}) as any)
      const d = await started($, on)
      await $.tool.call({ tool: 'Bash', command: 'sleep 100', run_in_background: true, description: 'sleep' } as any)
      await ready($, d)
      handCard(d, 'Done')
      released(d)
      await turnEnds($, d)
      expect(d.clearRuns).toEqual([])
      expect(d.toasts).toContain(READY_SHELL_HOLDS_RESET)
    })

    test('a waiting session under a background shell keeps its place: a shell holds only a clear', async ($, on) => {
      on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' }, text: 'running' }) as any)
      const d = await started($, on)
      await ready($, d)
      await $.tool.call({ tool: 'Bash', command: 'sleep 100', run_in_background: true, description: 'sleep' } as any)
      d.world.readyMark = null
      await tick(d)
      expect(d.world.readyMark).toBe(REPO)
    })

    test('a job the server judges ended while the session holds no work (the model left it itself) waits for the ask: no mark, no end of the loop, no clear, until the release', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'In Progress')
      await tick(d)
      d.world.readySteps.length = 0
      d.world.card = null
      d.world.readyLoop = { ...d.world.readyLoop, ended: true }
      await turnEnds($, d)
      await tick(d)
      expect(d.world.readySteps).toEqual([])
      expect(readyDeletes(d)).toBe(0)
      expect(d.world.readyMarks).toEqual([REPO])
      released(d)
      await tick(d)
      expect(d.world.readySteps).toEqual(['clear', `mark ${REPO}`])
    })

    test('the second job after a clear goes the same way', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      for (const round of [1, 2]) {
        handCard(d, 'Done')
        released(d, `r${round}`)
        await turnEnds($, d)
        expect(d.clearRuns).toHaveLength(round)
        expect(d.world.readyMark).toBe(REPO)
      }
    })

    test('a person chatting with a waiting session is no job: it stays on the list with no clear', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      await $.prompt.submit({ text: 'how is it going', origin: { kind: 'sdk' } } as any)
      await turnEnds($, d)
      await tick(d)
      expect(d.clearRuns).toEqual([])
      expect(d.world.readyMark).toBe(REPO)
    })

    test('a /clear that answers but leaves the same session is a failed reset: it is told, the release is not spent, and the session stays off the list', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'Done')
      released(d)
      d.world.clearDoesNothing = true
      await turnEnds($, d)
      expect(d.world.readyMark).toBe(null)
      expect(d.toasts.filter((t: string) => t.includes('the session id did not change'))).toHaveLength(1)
      d.world.clearDoesNothing = false
      await tick(d)
      expect(d.clearRuns).toHaveLength(1)
      expect(d.world.readyMark).toBe(REPO)
    })

    test('a /clear that fails keeps the session off the list, since it would rejoin holding its last job, and it tries again', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'Done')
      released(d)
      d.world.clearFails = 'clear boom'
      await turnEnds($, d)
      await tick(d)
      expect(d.world.readyMark).toBe(null)
      expect(d.toasts.filter((t: string) => t.includes('resetting this session failed'))).toHaveLength(1)
      d.world.clearFails = undefined
      await tick(d)
      expect(d.clearRuns).toHaveLength(1)
      expect(d.world.readyMark).toBe(REPO)
    })

    test("the clear's fresh conversation opens with the start text", async ($, on) => {
      on('classic.SessionStart', () => ({}) as any)
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'Done')
      released(d)
      d.world.clearFails = 'clear boom'
      d.world.localRecord = true
      await turnEnds($, d)
      // the phase a real /clear runs in: the engine raises its session start during the command
      await $.classic.SessionStart({ session_id: 'sess-own-2', source: 'clear', cwd: '/work', transcript_path: '/work/main.jsonl' } as any)
      d.world.localRecord = false
      const told = (await $.prompt.submit({ text: 'next' })).context ?? []
      expect(told.join(' ')).toContain(EVENT_TEXT('session_start'))
    })

    test('a look whose row answer comes back after a turn began and ended acts on nothing it read: a turn in which the model took the next card ends no loop as work taken', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'In Progress')
      await tick(d)
      // the server took the card while it was open, and the look's read of that is on its way back
      d.world.card = null
      const row = held()
      d.world.apiHolds.push({ method: 'GET', path: '/api/plan-sessions/me', hold: row.promise, early: true })
      await tick(d)
      // meanwhile a turn runs in which the model takes the next card, and the server's loop takes it as its job
      await $.turn.start({ turnId: 't2', prompt: 'take the next card' } as any)
      handCard(d, 'In Progress', { id: 'DX-78', title: 'The next card' })
      await turnEnds($, d)
      row.release()
      await d.clock.settle()
      expect(readyDeletes(d)).toBe(0)
      expect(d.toasts.filter((t: string) => t.includes('no longer holds'))).toEqual([])
      // the next look reads the session on its new job
      await tick(d)
      expect(readyDeletes(d)).toBe(0)
      expect(d.world.readyLoop).toEqual({ repo: REPO, job: { kind: 'card', id: 'DX-78' }, ended: false })
    })
  })

  describe('work the server took from a job that had not ended', () => {
    for (const [kind, hand, take, job] of [
      ['card', (d: any) => handCard(d, 'In Progress'), (d: any) => void (d.world.card = null), { kind: 'card', id: CARD.id }],
      ['plan', (d: any) => handPlan(d, false), (d: any) => void (d.world.planId = null), { kind: 'plan', id: 23 }],
    ] as const) {
      test(`a ${kind} still open: the session keeps its conversation, ends the loop on the server, and says why`, async ($, on) => {
        const d = await started($, on)
        await ready($, d)
        hand(d)
        await tick(d)
        // a card added to a plan, or another session connecting while this one was quiet: the row holds nothing, and the server says the job goes on
        take(d)
        await tick(d)
        expect(d.toasts).toContain(readyWorkTaken(job))
        expect(d.world.readyCleared).toBe(1)
        expect(d.world.readyLoop).toBe(null)
        expect(d.clearRuns).toEqual([])
        // ended, not merely quiet: nothing marks it again
        await tick(d)
        await turnEnds($, d)
        expect(d.world.readyMarks).toEqual([REPO])
      })
    }

    test('a session whose row reads a job the server says goes on, while it holds that job, stays on its work', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'In Progress')
      await tick(d)
      await tick(d)
      expect(readyDeletes(d)).toBe(0)
      expect(d.toasts.filter((t: string) => t.includes('no longer holds'))).toEqual([])
    })
  })

  describe('a session that already holds work when /50arms-ready runs joins the loop with that work as its job (the dashboard keeps no loop for it until then)', () => {
    for (const [kind, hold, end, job] of [
      ['card', (d: any) => {
        d.world.card = CARD
        d.world.cards.push({ id: CARD.id, title: CARD.title, problems: [] } as any)
        d.world.cardStatus[CARD.id] = 'In Progress'
      }, (d: any) => {
        d.world.cardStatus[CARD.id] = 'Done'
        d.world.readyLoop = { ...d.world.readyLoop, ended: true }
      }, { kind: 'card', id: CARD.id }],
      ['plan', (d: any) => void (d.world.planId = 23), (d: any) => void (d.world.readyLoop = { ...d.world.readyLoop, ended: true }), { kind: 'plan', id: 23 }],
    ] as const) {
      test(`on a ${kind}: it joins at once and says so, waits on the work, and clears and rejoins once 50 Arms releases the clear`, async ($, on) => {
        const d = await started($, on, { connected: kind === 'plan' })
        hold(d)
        d.world.readySteps.length = 0
        await ready($, d)
        expect(d.world.readySteps).toEqual([`join ${job.id}`])
        expect(d.world.readyLoop).toEqual({ repo: REPO, job, ended: false })
        expect(d.toasts).toContain(readyJoinedOnWork(REPO, job))
        expect(d.world.readyMark).toBe(null)
        // on its work: no ready call and no clear while it goes on, nor once it has ended until the release
        await tick(d)
        await turnEnds($, d)
        end(d)
        await turnEnds($, d)
        await tick(d)
        expect(d.world.readySteps).toEqual([`join ${job.id}`])
        expect(d.clearRuns).toEqual([])
        released(d)
        await tick(d)
        expect(d.world.readySteps).toEqual([`join ${job.id}`, 'clear', `leave ${job.id}`, `mark ${REPO}`])
        expect(d.world.readyMark).toBe(REPO)
        expect(d.toasts).toContain(readyRejoined(REPO))
      })
    }

    test("after a person's Stop during a job ended the loop, /50arms-ready while the card is still held joins again on it, and clears and rejoins once it is released", async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'In Progress')
      await tick(d)
      await turnEnds($, d, { isAborted: true, reason: 'aborted' })
      expect(d.world.readyLoop).toBe(null)
      expect(d.world.card).toEqual(CARD)
      d.world.readySteps.length = 0
      await ready($, d)
      expect(d.world.readySteps).toEqual([`join ${CARD.id}`])
      expect(d.world.readyLoop).toEqual({ repo: REPO, job: { kind: 'card', id: CARD.id }, ended: false })
      d.world.cardStatus[CARD.id] = 'Done'
      released(d)
      await turnEnds($, d)
      expect(d.world.readySteps).toEqual([`join ${CARD.id}`, 'clear', `leave ${CARD.id}`, `mark ${REPO}`])
      expect(d.world.readyMark).toBe(REPO)
    })
  })

  describe("an MCP server older than the clear handshake (it writes no clear file, so 50 Arms' ask and release never come)", () => {
    const compactionFileAt = `${HOME_DIR}/.config/danxbot/compaction/${SESSION_ID}.json`
    const olderTold = (d: any) => d.toasts.filter((t: string) => t === READY_RELAY_OLDER).length
    // the looks that read a session's clear file: only a look checks it, once per look
    const looks = (d: any, sessionId = SESSION_ID) => d.world.fsExists.filter((p: string) => p === clearFileAt(sessionId)).length
    const streamFile = (sessionId = SESSION_ID) => JSON.stringify({ v: 1, sessionId, control: null, askedAt: null })

    test('the join look that finds no clear file tells nothing; the next look, on the ended job the session was handed, tells once what is off and how to fix it, and the session keeps its work and its place in the loop', async ($, on) => {
      const d = await started($, on, { olderRelay: true })
      await ready($, d)
      expect(d.world.files[compactionFileAt]).toBeDefined()
      expect(looks(d)).toBe(1)
      expect(olderTold(d)).toBe(0)
      handCard(d, 'Done')
      await turnEnds($, d)
      // the second look in a row that finds the sign is the one that tells
      for (let i = 0; i < 30 && looks(d) < 2; i++) await tick(d)
      expect(looks(d)).toBe(2)
      expect(olderTold(d)).toBe(1)
      for (let i = 0; i < 30; i++) await tick(d)
      expect(d.world.files[clearFileAt(SESSION_ID)]).toBe(undefined)
      expect(olderTold(d)).toBe(1)
      expect(d.world.card).toEqual(CARD)
      expect(readyDeletes(d)).toBe(0)
      // a reconnect brings a current server, whose file and release then clear and rejoin as ever
      released(d)
      await tick(d)
      expect(d.clearRuns).toHaveLength(1)
      expect(d.world.readyMark).toBe(REPO)
      expect(olderTold(d)).toBe(1)
    })

    test('a session already on a card that runs the ready command beside it is told once, and keeps its work and its place in the loop when the card ends', async ($, on) => {
      const d = await started($, on, { olderRelay: true })
      d.world.card = CARD
      d.world.cards.push({ id: CARD.id, title: CARD.title, problems: [] } as any)
      d.world.cardStatus[CARD.id] = 'In Progress'
      await ready($, d)
      expect(d.world.readySteps).toEqual([`join ${CARD.id}`])
      d.world.cardStatus[CARD.id] = 'Done'
      d.world.readyLoop = { ...d.world.readyLoop, ended: true }
      await turnEnds($, d)
      for (let i = 0; i < 30; i++) await tick(d)
      expect(d.world.card).toEqual(CARD)
      expect(d.clearRuns).toEqual([])
      expect(readyDeletes(d)).toBe(0)
      expect(olderTold(d)).toBe(1)
    })

    test('a stream that comes up through it only once the session holds work is told once while the work is held', async ($, on) => {
      const d = await started($, on, { listener: 'unattached', olderRelay: true })
      await ready($, d)
      handCard(d, 'In Progress')
      await tick(d)
      expect(olderTold(d)).toBe(0)
      // the stream's first connect, through the older server: the compaction file, and no clear file
      d.world.files[compactionFileAt] = JSON.stringify({ v: 1, sessionId: SESSION_ID, control: null, askedAt: null })
      d.world.cardStatus[CARD.id] = 'Done'
      await turnEnds($, d)
      for (let i = 0; i < 30; i++) await tick(d)
      expect(d.world.card).toEqual(CARD)
      expect(olderTold(d)).toBe(1)
    })

    test('a current server, whose clear file holds no release yet, is no older one: nothing is told', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'Done')
      await turnEnds($, d)
      await tick(d)
      expect(d.world.files[clearFileAt(SESSION_ID)]).toBeDefined()
      expect(olderTold(d)).toBe(0)
    })

    // At a session's first connect the dashboard writes the compaction frame, then reads its database for the clear control and writes the clear frame. A look in between finds the
    // compaction file alone from a current server; only a later look that still finds no clear file tells.
    test("a look that lands between a current server's first compaction frame and its clear frame tells nothing, and the looks after the clear frame tell nothing either", async ($, on) => {
      const d = await started($, on, { listener: 'unattached' })
      expect(d.world.files[clearFileAt(SESSION_ID)]).toBe(undefined)
      d.world.files[compactionFileAt] = JSON.stringify({ v: 1, sessionId: SESSION_ID, control: null, askedAt: null })
      await ready($, d)
      expect(d.world.readyMark).toBe(REPO)
      d.world.files[clearFileAt(SESSION_ID)] = JSON.stringify({ v: 1, sessionId: SESSION_ID, control: null, askedAt: null })
      d.world.listener = 'healthy'
      for (let i = 0; i < 3; i++) await tick(d)
      expect(olderTold(d)).toBe(0)
    })

    // The compaction file is read before the clear file, so a current server's clear frame that lands between one look's two checks reads as a current server
    test("a current server's clear frame that lands between a look's two file checks, after a look that found the compaction file alone, tells nothing", async ($, on) => {
      const d = await started($, on, { listener: 'unattached' })
      d.world.files[compactionFileAt] = streamFile()
      await ready($, d)
      expect(looks(d)).toBe(1)
      // the clear frame lands right after the next look's first check of either file
      const rowReads = () => d.api.filter((a: any) => a.method === 'GET' && a.path === '/api/plan-sessions/me').length
      const armedAt = rowReads()
      d.world.afterExists = (path: string) => {
        if (rowReads() === armedAt || (path !== compactionFileAt && path !== clearFileAt(SESSION_ID))) return
        d.world.afterExists = undefined
        d.world.files[clearFileAt(SESSION_ID)] = streamFile()
      }
      await tick(d)
      expect(looks(d)).toBe(2)
      expect(d.world.afterExists).toBe(undefined)
      for (let i = 0; i < 3; i++) await tick(d)
      expect(olderTold(d)).toBe(0)
    })

    // Two looks tell only when both found the sign for the same session id: the clear file is the one of the row's own id
    test('a look whose row names another session id counts afresh: its first look that finds the compaction file alone tells nothing, its second tells once', async ($, on) => {
      const d = await started($, on, { olderRelay: true })
      d.world.card = CARD
      d.world.cards.push({ id: CARD.id, title: CARD.title, problems: [] } as any)
      d.world.cardStatus[CARD.id] = 'In Progress'
      await ready($, d)
      expect(looks(d)).toBe(1)
      expect(olderTold(d)).toBe(0)
      // the row now names another dashboard id, whose stream also came up through the older server
      const otherId = 'second-session'
      d.world.files[`${HOME_DIR}/.config/danxbot/compaction/${otherId}.json`] = streamFile(otherId)
      d.world.plansBody = { dashboard_url: DASHBOARD_URL, session: { session_id: otherId, plan_id: null, card_id: CARD.id, card_title: CARD.title, agent: AGENT, ready: null }, ready_loop: { repo: REPO, job: { kind: 'card', id: CARD.id }, ended: false, release_id: null } }
      await tick(d)
      expect(looks(d, otherId)).toBe(1)
      expect(olderTold(d)).toBe(0)
      await tick(d)
      expect(looks(d, otherId)).toBe(2)
      expect(olderTold(d)).toBe(1)
    })

    // the session holds no work once its job has ended: the card or plan left inside the turn in which the job ended
    for (const [what, leaveInsideTurn] of [
      ['a card job the session took, finished and left', (d: any) => {
        d.world.cards.push({ id: CARD.id, title: CARD.title, problems: [] } as any)
        d.world.cardStatus[CARD.id] = 'Done'
        d.world.card = null
        d.world.readyLoop = { repo: REPO, job: { kind: 'card', id: CARD.id }, ended: true }
      }],
      ['a plan job archived, which takes the session off the plan,', (d: any) => {
        d.world.planId = null
        d.world.readyLoop = { repo: REPO, job: { kind: 'plan', id: 23 }, ended: true }
      }],
    ] as const) {
      test(`${what} inside one turn, so it holds no work once the job has ended, is told once too`, async ($, on) => {
        const d = await started($, on, { olderRelay: true })
        await ready($, d)
        d.world.readyMark = null
        leaveInsideTurn(d)
        await turnEnds($, d)
        for (let i = 0; i < 30; i++) await tick(d)
        expect(olderTold(d)).toBe(1)
        expect(d.clearRuns).toEqual([])
        expect(readyDeletes(d)).toBe(0)
      })
    }

    test('with the event stream never up, no file says anything of the server: nothing is told', async ($, on) => {
      const d = await started($, on, { listener: 'unattached', olderRelay: true })
      await ready($, d)
      handCard(d, 'Done')
      await turnEnds($, d)
      for (let i = 0; i < 3; i++) await tick(d)
      expect(olderTold(d)).toBe(0)
    })
  })

  describe("what the session's row says that it cannot read", () => {
    const row = (over: object) => ({ dashboard_url: DASHBOARD_URL, session: { session_id: SESSION_ID, plan_id: null, card_id: CARD.id, card_title: CARD.title, agent: AGENT, ready: null }, ready_loop: { repo: REPO, job: { kind: 'card', id: CARD.id }, ended: true, release_id: 'r1' }, ...over })

    test('a row with no session_id is told once and clears nothing, since the clear file is named by that id', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'Done')
      released(d)
      d.world.plansBody = row({ session: { plan_id: null, card_id: CARD.id, card_title: CARD.title, agent: AGENT, ready: null } })
      await tick(d)
      await tick(d)
      expect(d.toasts.filter((t: string) => t.includes('a session with no session_id'))).toHaveLength(1)
      expect(d.clearRuns).toEqual([])
    })

    test('a row whose session_id is not a plain id is told once and clears nothing, since such an id names no file', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'Done')
      released(d)
      d.world.plansBody = row({ session: { session_id: BAD_SESSION_ID, plan_id: null, card_id: CARD.id, card_title: CARD.title, agent: AGENT, ready: null } })
      // a release at the path such an id would name, as the runtime resolves it, so a look that built the path would find and read it
      d.world.files[BAD_SESSION_ID_PATH] = JSON.stringify({ v: 1, sessionId: BAD_SESSION_ID, control: { releaseId: 'r9' }, askedAt: '2026-10-03T08:00:00.000Z' })
      await tick(d)
      await tick(d)
      expect(d.toasts.filter((t: string) => t.includes('reading the clear file') && t.includes('names no file'))).toHaveLength(1)
      expect(d.world.fsExists).not.toContain(BAD_SESSION_ID_PATH)
      expect(d.world.fsReads).not.toContain(BAD_SESSION_ID_PATH)
      expect(d.clearRuns).toEqual([])
    })

    test("a ready_loop it cannot read is told once and clears nothing, nor ends the loop", async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'Done')
      released(d)
      d.world.plansBody = row({ ready_loop: { repo: REPO, job: { kind: 'card', id: CARD.id } } })
      await tick(d)
      await tick(d)
      expect(d.toasts.filter((t: string) => t.includes('ready_loop'))).toHaveLength(1)
      expect(d.clearRuns).toEqual([])
      expect(readyDeletes(d)).toBe(0)
    })

    test('a row read the MCP answers as a file is read from that file: the loop goes on as from an inline answer', async ($, on) => {
      const d = await started($, on)
      d.world.replyFilePaths = ['/api/plan-sessions/me']
      await ready($, d)
      expect(d.world.readyMark).toBe(REPO)
      handCard(d, 'Done')
      released(d)
      await tick(d)
      expect(d.clearRuns).toHaveLength(1)
      expect(d.world.readyMark).toBe(REPO)
    })

    test('a reply file that is gone before it is read is a failure told once: nothing clears', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'Done')
      released(d)
      d.world.replyFilePaths = ['/api/plan-sessions/me']
      d.world.replyFileLost = true
      await tick(d)
      await tick(d)
      expect(d.toasts.filter((t: string) => t.startsWith('Ready list: reading this session failed') && t.includes('reply file'))).toHaveLength(1)
      expect(d.clearRuns).toEqual([])
    })
  })

  test('a repo that left the team under its name is looked up again, and the mark follows it', async ($, on) => {
    const d = await started($, on)
    await ready($, d)
    d.world.repos = [{ name: 'app', github_remote: { owner: 'acme', repo: 'app' } }]
    d.world.readyMark = null
    await tick(d)
    expect(d.world.readyMark).toBe('app')
    expect(d.toasts.filter((t: string) => t.includes('marking this session ready'))).toEqual([])
  })

  test('a repo of the same name with another remote is not this folder', async ($, on) => {
    const d = await started($, on)
    d.world.repos = [{ name: 'app', github_remote: { owner: 'someone-else', repo: 'app' } }, { name: REPO, github_remote: { owner: 'acme', repo: 'app' } }]
    await ready($, d)
    expect(d.world.readyMark).toBe(REPO)
    expect(d.world.readyMarks).toEqual([REPO])
  })

  test('a person leaving while the mark is on its way takes it back off', async ($, on) => {
    const d = await started($, on)
    let release!: () => void
    d.world.markHold = new Promise<void>(r => (release = r))
    await $.command.run({ command: '50arms-ready' })
    await d.clock.settle()
    d.world.markHold = null
    await $.command.run({ command: '50arms-ready', args: 'off' })
    await d.clock.settle()
    release()
    await d.clock.settle()
    expect(d.world.readyMarks).toEqual([REPO])
    expect(d.world.readyMark).toBe(null)
  })

  for (const [what, setUp, expected] of [
    ['a card', (d: any) => handCard(d, 'In Progress'), { card: CARD.id, plan: null }],
    ['an open plan', (d: any) => handPlan(d, false), { card: null, plan: 23 }],
  ] as const) {
    test(`on ${what} with the hold gate answering its look, the session claims and keeps its work and its conversation`, async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      setUp(d)
      await tick(d)
      await turnEnds($, d)
      d.world.readySteps.length = 0
      // the server's own answer for a session whose hold lapsed: the row keeps its work
      d.world.agent = null
      d.world.agentGate = 'agent_not_held'
      await tick(d)
      expect(d.world.agentGate).toBe(null)
      expect(d.world.readySteps).toEqual([])
      expect({ card: d.world.card?.id ?? null, plan: d.world.planId }).toEqual(expected)
      expect(d.relay.submitted).toEqual([])
    })
  }

  test('a claim that hands another agent to a session on work tells the model the new name, once', async ($, on) => {
    const d = await started($, on)
    await ready($, d)
    handCard(d, 'In Progress')
    await tick(d)
    await turnEnds($, d)
    d.world.agent = null
    d.world.agentGate = 'agent_not_held'
    d.world.agentNext = { id: 7, name: 'Noor', avatar_url: null }
    await tick(d)
    await tick(d)
    expect(d.relay.submitted.filter((t: string) => t.includes(readyAgentChanged('Noor')))).toHaveLength(1)
    expect(d.clearRuns).toEqual([])
  })

  test('a claim that hands another agent to a session on a card the server says has ended tells the model nothing: it is about to clear', async ($, on) => {
    const d = await started($, on)
    await ready($, d)
    handCard(d, 'In Progress')
    await tick(d)
    await turnEnds($, d)
    // ended, with no release yet: the model wraps up in turns of its own
    d.world.cardStatus[CARD.id] = 'Done'
    d.world.readyLoop = { ...d.world.readyLoop, ended: true }
    d.world.agent = null
    d.world.agentGate = 'agent_not_held'
    d.world.agentNext = { id: 7, name: 'Noor', avatar_url: null }
    await tick(d)
    await tick(d)
    // the claim ran and handed the new agent, and the session still holds its ended card
    expect(d.world.agent?.name).toBe('Noor')
    expect(d.world.card).toEqual(CARD)
    expect(d.relay.submitted.filter((t: string) => t.includes('Noor'))).toEqual([])
    expect(d.clearRuns).toEqual([])
  })

  test('a row the session cannot read is told once and never resets it', async ($, on) => {
    const d = await started($, on)
    await ready($, d)
    handCard(d, 'In Progress')
    await tick(d)
    await turnEnds($, d)
    d.world.plansBody = { dashboard_url: DASHBOARD_URL, session: { session_id: SESSION_ID, agent: AGENT }, ready_loop: null }
    await tick(d)
    await tick(d)
    expect(d.toasts.filter((t: string) => t.includes('plan_id and card_id cannot be read'))).toHaveLength(1)
    expect(d.clearRuns).toEqual([])
  })

  // at least one tick falls past the stale bound of a look started before it
  const pastStale = async (d: any) => {
    await d.clock.advance(LOCK_STALE_MS)
    await tick(d)
  }
  const offList = async ($: any, d: any) => {
    await $.command.run({ command: '50arms-ready', args: 'off' })
    await d.clock.settle()
  }
  // a call held until the test releases it
  const held = () => {
    let release!: () => void
    const promise = new Promise<void>(r => (release = r))
    return { promise, release }
  }

  test("a test body that returns with a one-shot hold that matched no call fails, naming the hold, so a test that set it fails instead of testing nothing", async ($, on) => {
    let d: any
    // the kit's `test` built on a runner that only keeps what it is handed, so the body it runs is the one checked here
    const handed: { name: string; body: (...args: any[]) => unknown }[] = []
    makeTest((name, _options, body) => void handed.push({ name, body }))('holds nothing', async ($: any, on: any) => {
      d = await started($, on)
      d.world.apiHolds.push({ method: 'GET', path: '/api/plan-sessions/elsewhere', hold: held().promise })
      d.world.processHolds.push({ command: 'git remote get-url elsewhere', hold: held().promise })
      await ready($, d)
      expect(d.world.readyMark).toBe(REPO)
    })
    expect(handed.map(h => h.name)).toEqual(['holds nothing'])
    await expect(handed[0].body($, on)).rejects.toThrow('a one-shot hold the test set was never used, so it held nothing: GET /api/plan-sessions/elsewhere, git remote get-url elsewhere')
    // emptied, so this test passes that same check, which the kit runs once its own body returns
    d.world.apiHolds.length = 0
    d.world.processHolds.length = 0
    expect(() => assertHoldsUsed(on)).not.toThrow()
  })


  describe('a look taken over acts on no answer that comes late: the look that took over has read the session for itself', () => {
    // what a look does that a test sees: a dashboard or tool call, a command, a toast, a note to the model, a reset. A held call that answers adds nothing here.
    const effects = (d: any) => ({ api: d.api.length, tools: d.calls.filter((c: any) => c.tool !== 'plan_events_wait').length, runs: d.runCalls.length, toasts: [...d.toasts], told: d.relay.told.length, clears: d.clearRuns.length })
    const answersLate = async (d: any, release: () => void) => {
      const before = effects(d)
      release()
      await d.clock.settle()
      expect(effects(d)).toEqual(before)
    }
    // the look that took over joined; a look that acted on its late answer would mark again
    const joinedByTakeover = (d: any) => {
      expect(d.world.readyMark).toBe(REPO)
      d.world.readyMark = null
    }

    test('its read of the session', async ($, on) => {
      const d = await started($, on)
      const me = held()
      d.world.apiHolds.push({ method: 'GET', path: '/api/plan-sessions/me', hold: me.promise })
      await ready($, d)
      await pastStale(d)
      joinedByTakeover(d)
      await answersLate(d, me.release)
    })

    test('its claim of a team agent', async ($, on) => {
      const d = await started($, on)
      d.world.agent = null
      const claim = held()
      d.world.apiHolds.push({ method: 'POST', path: '/api/plan-sessions/me/agent', hold: claim.promise })
      await ready($, d)
      await pastStale(d)
      joinedByTakeover(d)
      await answersLate(d, claim.release)
    })

    test('its read of the session, answered after the person left and refused by the hold gate: it claims no team agent', async ($, on) => {
      const d = await started($, on)
      const me = held()
      d.world.apiHolds.push({ method: 'GET', path: '/api/plan-sessions/me', hold: me.promise })
      await ready($, d)
      await pastStale(d)
      expect(d.world.readyMark).toBe(REPO)
      await offList($, d)
      // the agent lapsed meanwhile, so the held read meets the hold gate
      d.world.agent = null
      await answersLate(d, me.release)
    })

    test('its mark', async ($, on) => {
      const d = await started($, on)
      const mark = held()
      d.world.markHold = mark.promise
      await ready($, d)
      d.world.markHold = null
      await pastStale(d)
      expect(d.toasts.filter((t: string) => t === readyJoined(REPO))).toHaveLength(1)
      await answersLate(d, mark.release)
    })

    test("its read of the folder's origin", async ($, on) => {
      const d = await started($, on)
      const git = held()
      d.world.processHolds.push({ command: 'git remote get-url origin', hold: git.promise })
      await ready($, d)
      await pastStale(d)
      joinedByTakeover(d)
      await answersLate(d, git.release)
    })

    test('its read of a repo by name', async ($, on) => {
      const d = await started($, on)
      const one = held()
      d.world.apiHolds.push({ method: 'GET', path: '/api/repos/app', hold: one.promise })
      await ready($, d)
      await pastStale(d)
      joinedByTakeover(d)
      await answersLate(d, one.release)
    })

    test("its read of the team's repos", async ($, on) => {
      const d = await started($, on)
      d.world.repos = [{ name: 'our-name', github_remote: { owner: 'acme', repo: 'app' } }]
      const list = held()
      d.world.apiHolds.push({ method: 'GET', path: '/api/repos', hold: list.promise })
      await ready($, d)
      await pastStale(d)
      expect(d.world.readyMark).toBe('our-name')
      d.world.readyMark = null
      await answersLate(d, list.release)
    })

    test('its ask for the permission to read the repos', async ($, on) => {
      const d = await started($, on)
      d.world.repos = [{ name: 'our-name', github_remote: { owner: 'acme', repo: 'app' } }]
      d.world.reposAnswer = { status: 403, body: { error: 'forbidden', permission: 'boards.view' } }
      const ask = held()
      d.world.permissionAskHold = ask.promise
      await ready($, d)
      d.world.permissionAskHold = null
      await pastStale(d)
      expect(d.world.permissionAsks).toBe(2)
      expect(d.toasts.filter((t: string) => t.includes(APPROVAL_URL))).toHaveLength(1)
      await answersLate(d, ask.release)
    })

    test('its ask for the permission, when that ask throws', async ($, on) => {
      const d = await started($, on)
      d.world.repos = [{ name: 'our-name', github_remote: { owner: 'acme', repo: 'app' } }]
      d.world.reposAnswer = { status: 403, body: { error: 'forbidden', permission: 'boards.view' } }
      const ask = held()
      d.world.permissionAskHold = ask.promise
      await ready($, d)
      d.world.permissionAskHold = null
      await pastStale(d)
      expect(d.toasts.filter((t: string) => t.includes(APPROVAL_URL))).toHaveLength(1)
      d.world.permissionAskDeny = 'request_permission refused'
      await answersLate(d, ask.release)
    })

    test('its mark, answered after the person left, though a reset has run since it began: taken back off the list', async ($, on) => {
      const d = await started($, on)
      const mark = held()
      d.world.apiHolds.push({ method: 'PUT', path: '/api/plan-sessions/me/ready', hold: mark.promise })
      await ready($, d)
      await pastStale(d)
      expect(d.world.readyMark).toBe(REPO)
      // the loop goes on to a job, and resets after it
      handCard(d, 'Done')
      released(d)
      await turnEnds($, d)
      expect(d.clearRuns).toHaveLength(1)
      expect(d.world.readyMark).toBe(REPO)
      await offList($, d)
      expect(d.world.readyMark).toBe(null)
      mark.release()
      await d.clock.settle()
      // the held mark landed last, and its look took it back
      expect(d.world.readyMarks).toEqual([REPO, REPO, REPO])
      expect(d.world.readyMark).toBe(null)
    })
  })

  test('off during a sign-in frees it: /50arms-ready after it signs in again, and the session joins', async ($, on) => {
    const d = await started($, on)
    d.world.signedOut = 'signed-out'
    await ready($, d)
    await $.command.run({ command: '50arms-ready', args: 'off' })
    await d.clock.settle()
    await d.clock.advance(60_000)
    await d.clock.settle()
    const calls = d.world.signIn.calls.length
    await ready($, d)
    expect(d.world.signIn.calls.length).toBeGreaterThan(calls)
    d.world.signIn.approved = true
    await d.clock.advance(60_000)
    await d.clock.settle()
    await tick(d)
    expect(d.world.readyMark).toBe(REPO)
  })

  test('off, /50arms-ready, the old watch returning, off: the second off still ends the watch', async ($, on) => {
    const d = await started($, on)
    d.world.signedOut = 'signed-out'
    await ready($, d)
    await $.command.run({ command: '50arms-ready', args: 'off' })
    await d.clock.settle()
    await ready($, d)
    // the first watch was in its minimum round when it was ended: this ends its sleep, and it returns
    await d.clock.advance(SIGN_IN_MIN_ROUND_MS)
    await d.clock.settle()
    await $.command.run({ command: '50arms-ready', args: 'off' })
    await d.clock.settle()
    await d.clock.advance(60_000)
    await d.clock.settle()
    const calls = d.world.signIn.calls.length
    d.world.signIn.answer = { text: JSON.stringify({ state: 'denied' }) }
    await d.clock.advance(5 * 60_000)
    await d.clock.settle()
    expect(d.world.signIn.calls.length).toBe(calls)
    expect(d.toasts).not.toContain(READY_SIGN_IN_ENDED)
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', component: 'AbovePrompt', props: {} } as any)
    expect((await linksOf(band)).map(l => l.href)).not.toContain(APPROVAL_URL)
  })

  test('/50arms-ready off ends the sign-in it started: no more calls, no link, and a later denial reaches nobody', async ($, on) => {
    const d = await started($, on)
    d.world.signedOut = 'signed-out'
    await ready($, d)
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', component: 'AbovePrompt', props: {} } as any)
    expect((await linksOf(band)).map(l => l.href)).toContain(APPROVAL_URL)
    await $.command.run({ command: '50arms-ready', args: 'off' })
    await d.clock.settle()
    await d.clock.advance(60_000)
    await d.clock.settle()
    const calls = d.world.signIn.calls.length
    d.world.signIn.answer = { text: JSON.stringify({ state: 'denied' }) }
    await d.clock.advance(5 * 60_000)
    await d.clock.settle()
    expect(d.world.signIn.calls.length).toBe(calls)
    expect(d.toasts).not.toContain(READY_SIGN_IN_ENDED)
    const after = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', component: 'AbovePrompt', props: {} } as any)
    expect((await linksOf(after)).map(l => l.href)).not.toContain(APPROVAL_URL)
  })

  test('a key that lapses while waiting draws the approval link and Sign in on the band', async ($, on) => {
    const d = await started($, on)
    await ready($, d)
    d.world.signedOut = 'lapsed'
    await tick(d)
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', component: 'AbovePrompt', props: {} } as any)
    expect((await linksOf(band)).map(l => l.href)).toContain(APPROVAL_URL)
    expect(await band.find({ key: 'sign-in' })).toBeDefined()
  })

  test('a claim that hands another agent after a sign-in tells the model, though the view was blanked meanwhile', async ($, on) => {
    const d = await started($, on)
    await ready($, d)
    handCard(d, 'In Progress')
    await tick(d)
    d.world.signedOut = 'lapsed'
    await tick(d)
    d.world.agent = { id: 7, name: 'Noor', avatar_url: null } as any
    d.world.signIn.approved = true
    await d.clock.advance(60_000)
    await d.clock.settle()
    await tick(d)
    expect(d.relay.submitted.filter((t: string) => t.includes(readyAgentChanged('Noor')))).toHaveLength(1)
  })

  test('a session with no agent free retries in the background: no claim counts as its own work', async ($, on) => {
    const d = await started($, on)
    await ready($, d)
    d.world.agent = null
    d.world.readyMark = null
    d.world.agentGate = 'agent_not_held'
    d.world.agentClaim = { state: 'agent_limit_reached', instruction: 'Ask a person.' }
    await tick(d)
    await tick(d)
    expect(d.world.claimsByConnect).toBe(0)
    expect(d.api.filter((a: any) => a.method === 'POST' && a.path === '/api/plan-sessions/me/agent').length).toBeGreaterThan(1)
    expect(d.toasts.filter((t: string) => t.includes('every team agent is in use'))).toHaveLength(1)
  })

  describe("the MCP's own gate closed by an earlier refusal", () => {
    const refused = (d: any) => {
      d.world.agent = null
      d.world.readyMark = null
      d.world.agentGate = 'agent_limit_reached'
      d.world.agentClaim = { state: 'agent_limit_reached', instruction: 'Ask a person.' }
    }

    test('the first /50arms-ready with the gate already closed claims through plan_connect, once', async ($, on) => {
      const d = await started($, on)
      refused(d)
      await ready($, d)
      expect(d.world.claimsByConnect).toBe(1)
      d.world.agentClaim = null
      await d.clock.settle()
      await tick(d)
      expect(d.world.claimsByConnect).toBe(1)
      expect(d.world.readyMark).toBe(null)
      await ready($, d)
      expect(d.world.claimsByConnect).toBe(2)
      expect(d.world.readyMark).toBe(REPO)
    })

    test('six hours with nobody present call plan_connect not once, and a freed agent is not taken: the key lapses as any other', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      refused(d)
      await d.clock.advance(6 * 60 * 60_000)
      await d.clock.settle()
      expect(d.world.claimsByConnect).toBe(0)
      expect(d.toasts.filter((t: string) => t === READY_NO_AGENT_AGAIN)).toHaveLength(1)
      d.world.agentClaim = null
      await tick(d)
      expect(d.world.claimsByConnect).toBe(0)
      expect(d.world.readyMark).toBe(null)
    })

    test('/50arms-ready claims once, and a refusal is not tried again', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      refused(d)
      await tick(d)
      await ready($, d)
      expect(d.world.claimsByConnect).toBe(1)
      await tick(d)
      await tick(d)
      expect(d.world.claimsByConnect).toBe(1)
      expect(d.toasts.some((t: string) => t.includes('every team agent is in use') && t.includes('run /50arms-ready'))).toBe(true)
      expect(d.world.readyMark).toBe(null)
    })

    test('a person frees an agent and runs /50arms-ready: it joins at once', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      refused(d)
      await tick(d)
      d.world.agentClaim = null
      await ready($, d)
      expect(d.world.readyMark).toBe(REPO)
    })

    test('with the key gone behind the gate, /50arms-ready shows the approval link in a toast and on the band', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      refused(d)
      await tick(d)
      d.world.signedOut = 'lapsed'
      await ready($, d)
      expect(d.toasts.some((t: string) => t.includes(APPROVAL_URL))).toBe(true)
      const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } } as any)
      expect((await linksOf(band)).map(l => l.href)).toContain(APPROVAL_URL)
    })

    test('/50arms-ready run again during an open approval keeps it: no second watch, and no word that no agent is free', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      refused(d)
      await tick(d)
      expect(d.toasts.filter((t: string) => t === READY_NO_AGENT_AGAIN)).toHaveLength(1)
      d.world.signedOut = 'lapsed'
      await ready($, d)
      await ready($, d)
      await tick(d)
      expect(d.toasts.filter((t: string) => t === READY_NO_AGENT_AGAIN)).toHaveLength(1)
    })

    test('a key a person revoked behind the gate leaves the list and says who', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      refused(d)
      await tick(d)
      d.world.signedOut = 'signed-out'
      d.world.signIn.answer = { text: KEY_REVOKED_HALT, isError: true }
      await ready($, d)
      expect(d.toasts).toContain(readyRevoked(REVOKER))
      // ended, not merely quiet: neither the ticker nor a turn end looks again
      await tick(d)
      await tick(d)
      await turnEnds($, d)
      await tick(d)
      expect(d.toasts.filter((t: string) => t === readyRevoked(REVOKER))).toHaveLength(1)
    })
  })


  test('a /clear that runs past the stale bound is not taken over: no look runs beside it, and the rejoin follows it', async ($, on) => {
    const d = await started($, on)
    await ready($, d)
    handCard(d, 'Done')
    released(d)
    const clear = held()
    d.world.clearHold = clear.promise
    await tick(d)
    expect(d.world.clearsStarted).toBe(1)
    const rowReads = () => d.api.filter((a: any) => a.method === 'GET' && a.path === '/api/plan-sessions/me').length
    const before = rowReads()
    await pastStale(d)
    expect(rowReads()).toBe(before)
    expect(d.world.clearsStarted).toBe(1)
    d.world.clearHold = null
    clear.release()
    await d.clock.settle()
    expect(d.clearRuns).toHaveLength(1)
    expect(d.world.readyMark).toBe(REPO)
  })

  test('the rejoin after a /clear that ran past the stale bound is timed from the clear: one mark, told once', async ($, on) => {
    const d = await started($, on)
    await ready($, d)
    handCard(d, 'Done')
    released(d)
    d.world.readySteps.length = 0
    const clear = held()
    d.world.clearHold = clear.promise
    await turnEnds($, d)
    await pastStale(d)
    d.world.clearHold = null
    const mark = held()
    d.world.markHold = mark.promise
    clear.release()
    await d.clock.settle()
    await tick(d)
    d.world.markHold = null
    mark.release()
    await d.clock.settle()
    expect(d.world.readySteps).toEqual(['clear', `leave ${CARD.id}`, `mark ${REPO}`])
    expect(d.toasts.filter((t: string) => t === readyRejoined(REPO))).toHaveLength(1)
  })

  describe('every exit from the loop ends it on the server too (`DELETE /api/plan-sessions/me/ready`), so 50 Arms never asks a session that left to clear', () => {
    test("a person's Stop takes the session off the list, says so, and nothing rejoins until they ask", async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      await turnEnds($, d, { isAborted: true, reason: 'aborted' })
      expect(d.world.readyMark).toBe(null)
      expect(d.world.readyCleared).toBe(1)
      expect(d.toasts).toContain(READY_STOPPED)
      await tick(d)
      await turnEnds($, d)
      expect(d.world.readyMark).toBe(null)
      await ready($, d)
      expect(d.world.readyMark).toBe(REPO)
    })

    test("a person's Stop during a job ends the server's loop too: no clear and no rejoin, even with a release left in the file", async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'In Progress')
      await tick(d)
      await turnEnds($, d, { isAborted: true, reason: 'aborted' })
      expect(d.world.readyLoop).toBe(null)
      expect(d.world.readyCleared).toBe(1)
      d.world.cardStatus[CARD.id] = 'Done'
      clearFile(d, 'r1')
      await turnEnds($, d)
      await tick(d)
      expect(d.clearRuns).toEqual([])
      expect(d.world.card).toEqual(CARD)
    })

    test("a person's Disconnect takes the session back: it leaves the list and the server's loop, says so, and keeps its conversation", async ($, on) => {
      const d = await started($, on, { connected: true })
      await ready($, d)
      d.world.readyLoop = { repo: REPO, job: { kind: 'plan', id: 23 }, ended: false }
      const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', component: 'AbovePrompt', props: {} } as any)
      await band.press({ key: 'disconnect' })
      await d.clock.settle()
      await turnEnds($, d)
      await tick(d)
      expect(d.world.planId).toBe(null)
      expect(d.toasts).toContain(READY_DISCONNECTED)
      expect(d.world.readyCleared).toBe(1)
      expect(d.world.readyLoop).toBe(null)
      expect(d.clearRuns).toEqual([])
      expect(d.world.readyMark).toBe(null)
    })

    test('/50arms-ready off leaves the list and the loop; any other word is only the usage', async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      const usage: any = await $.command.run({ command: '50arms-ready', args: 'sideways' })
      await d.clock.settle()
      expect(usage.text).toBe(READY_USAGE)
      expect(d.world.readyMark).toBe(REPO)
      const off: any = await $.command.run({ command: '50arms-ready', args: 'off' })
      await d.clock.settle()
      expect(off.text).toBe(READY_OFF)
      expect(d.world.readyMark).toBe(null)
      expect(d.world.readyCleared).toBe(1)
      await tick(d)
      expect(d.world.readyMark).toBe(null)
    })

    test("a key a person revoked, met by the loop's own look, ends the loop on the server and says who, once", async ($, on) => {
      const d = await started($, on)
      await ready($, d)
      handCard(d, 'In Progress')
      await tick(d)
      d.world.signedOut = 'revoked'
      await tick(d)
      expect(d.toasts).toContain(readyRevoked(REVOKER))
      expect(readyDeletes(d)).toBe(1)
      expect(d.toasts.filter((t: string) => t.includes('STOP ALL WORK'))).toEqual([])
      // ended, not merely quiet: neither the ticker nor a turn end looks again
      await tick(d)
      await turnEnds($, d)
      await tick(d)
      expect(d.toasts.filter((t: string) => t === readyRevoked(REVOKER))).toHaveLength(1)
      expect(readyDeletes(d)).toBe(1)
    })

    test('a mark the dashboard refuses for good (a viewer, say) leaves the list and the loop and says why, once', async ($, on) => {
      const d = await started($, on)
      d.world.markRefusal = { status: 403, body: { error: 'forbidden', permission: 'plans.manage' } }
      await ready($, d)
      await tick(d)
      await tick(d)
      expect(d.world.readyMarks).toEqual([REPO])
      expect(d.toasts).toContain(readyMarkRefused('403 forbidden'))
      expect(d.world.readyCleared).toBe(1)
    })
  })

  // the loop takes a card and starts its /clear, which the test holds while the loop ends; the /clear then runs, and nothing may follow it
  const loopEndsDuringClear = async ($: any, on: any, ends: (d: any) => Promise<void>) => {
    const d = await started($, on)
    await ready($, d)
    handCard(d, 'Done')
    released(d)
    const clear = held()
    d.world.clearHold = clear.promise
    await turnEnds($, d)
    d.world.clearHold = null
    expect(d.world.clearsStarted).toBe(1)
    await ends(d)
    clear.release()
    await d.clock.settle()
    await tick(d)
    await tick(d)
    expect(d.clearRuns).toHaveLength(1)
    // only the join's mark: none after the /clear
    expect(d.world.readyMarks).toEqual([REPO])
    expect(d.world.readyMark).toBe(null)
    expect(d.toasts).not.toContain(readyRejoined(REPO))
    return d
  }

  test('/50arms-ready off while the /clear is held: the /clear runs, and no mark and no rejoin follow', async ($, on) => {
    await loopEndsDuringClear($, on, d => offList($, d))
  })

  test("a person's Stop while the /clear is held: no mark and no rejoin follow, and it says so", async ($, on) => {
    const d = await loopEndsDuringClear($, on, d => turnEnds($, d, { isAborted: true, reason: 'aborted' }))
    expect(d.toasts).toContain(READY_STOPPED)
  })

  test('a session Claude Code holds after a Stop leaves the list and says so, the first time an event cannot reach it', async ($, on) => {
    const d = await started($, on)
    await ready($, d)
    d.relay.dropPrompts('the session was stopped and nobody has sent input since')
    d.relay.push({ cursor: 'c1', text: 'digest' })
    await d.clock.settle()
    await d.clock.advance(1_000)
    await d.clock.settle()
    expect(d.toasts.filter((t: string) => t === READY_STOPPED)).toHaveLength(1)
    expect(d.world.readyMark).toBe(null)
    expect(d.world.readyCleared).toBe(1)
  })

  test('the band gains no line for the loop: what it has to say goes out as toasts', async ($, on) => {
    const d = await started($, on)
    const before = await bandTexts($)
    await ready($, d)
    // read after a fresh load, so a line drawn from what the row says of the mark would show
    await $.command.run({ command: 'danx-plan' })
    await d.clock.settle()
    expect(await bandTexts($)).toEqual(before)
    await turnEnds($, d, { isAborted: true, reason: 'aborted' })
    expect(d.toasts).toContain(READY_STOPPED)
    expect(await bandTexts($)).toEqual(before)
  })

  describe('a process that starts again finds the loop where the server left it (DEC-360: rejoining leans to yes)', () => {
    // a new process: no loop in memory, the row as the server keeps it
    const restarted = async ($: any, on: any, setUp: (d: any) => void, connected = false) => {
      const d = dashboard(on, { connected })
      on('turn.complete', () => ({ text: 'done' }) as any)
      d.world.agent = AGENT
      d.world.repos = ROWS
      d.world.processes.git = { stdout: ORIGIN }
      setUp(d)
      await startSession($, d, 'desktop')
      await d.clock.settle()
      return d
    }

    test('a row still marked takes the loop back up: it says so, and clears and rejoins after its next job', async ($, on) => {
      const d = await restarted($, on, d => void (d.world.readyMark = REPO))
      expect(d.toasts).toContain(readyAdopted(REPO))
      handCard(d, 'Done')
      released(d)
      await turnEnds($, d)
      expect(d.clearRuns).toHaveLength(1)
      expect(d.world.readyMark).toBe(REPO)
    })

    for (const [kind, setUp] of [
      ['card', (d: any) => handCard(d, 'In Progress')],
      ['plan', (d: any) => handPlan(d, false)],
    ] as const) {
      test(`a loop the server still keeps on a ${kind} job, with no mark, is taken back up: it says so, keeps the work, and clears and rejoins when 50 Arms releases the clear`, async ($, on) => {
        const d = await restarted($, on, setUp, kind === 'plan')
        expect(d.toasts).toContain(readyAdopted(REPO))
        await tick(d)
        expect(d.clearRuns).toEqual([])
        expect(readyDeletes(d)).toBe(0)
        d.world.readySteps.length = 0
        released(d)
        await turnEnds($, d)
        expect(d.world.readySteps).toEqual(['clear', `leave ${kind === 'card' ? CARD.id : 23}`, `mark ${REPO}`])
      })
    }

    test('a process that takes up the loop calls no plan_connect by itself: a timer look with the gate closed only says so', async ($, on) => {
      const d = await restarted($, on, d => void (d.world.readyMark = REPO))
      expect(d.toasts).toContain(readyAdopted(REPO))
      d.world.agent = null
      d.world.readyMark = null
      d.world.agentGate = 'agent_limit_reached'
      d.world.agentClaim = { state: 'agent_limit_reached', instruction: 'Ask a person.' }
      await tick(d)
      await tick(d)
      expect(d.world.claimsByConnect).toBe(0)
      expect(d.toasts).toContain(READY_NO_AGENT_AGAIN)
    })

    test("a row whose dashboard loop cannot be read keeps the band of a session on a plan, takes no loop up, and says so once", async ($, on) => {
      const d = await restarted($, on, d => void (d.world.readyLoop = { repo: REPO, job: null } as any), true)
      await $.command.run({ command: 'danx-plan' })
      await d.clock.settle()
      expect(d.toasts.filter((t: string) => t.startsWith('Plan load failed'))).toEqual([])
      expect((await bandTexts($)).join(' ')).toContain('Danxbot plugin')
      // the session start reads the row for a loop to take up twice: after the first load, and again after the not-connected retry's first wait. "Once" is counted
      // only after both, a turn end and a tick
      for (const wait of NOT_CONNECTED_RETRY_MS) await d.clock.advance(wait)
      await d.clock.settle()
      await turnEnds($, d)
      await tick(d)
      const unread = d.toasts.filter((t: string) => t.startsWith(readyLoopUnread('').split('(')[0]))
      expect(unread).toHaveLength(1)
      expect(unread[0]).toContain('ready_loop with no repo or no ended')
      expect(d.toasts).not.toContain(readyAdopted(REPO))
      expect(d.world.readyMarks).toEqual([])
    })

    describe('a resumed session off the list is asked once to judge whether to rejoin', () => {
      const resumed = async ($: any, on: any, setUp: (d: any) => void = () => {}) => {
        const d = dashboard(on, { connected: false })
        on('turn.complete', () => ({ text: 'done' }) as any)
        on('classic.SessionStart', () => ({}) as any)
        d.world.agent = AGENT
        d.world.repos = ROWS
        d.world.processes.git = { stdout: ORIGIN }
        setUp(d)
        d.roster.push('desktop')
        await $.classic.SessionStart({ source: 'resume', cwd: '/work', session_id: OWN_SESSION.session_id, transcript_path: '/work/main.jsonl' })
        await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
        await leaveSession($, d, 'desktop')
        await d.clock.settle()
        takeLoadPauseReads(d)
        return d
      }
      const asked = (d: any) => d.relay.submitted.filter((t: string) => t.includes(READY_JUDGE_PROMPT)).length

      test('the prompt names the skill and says nothing of danx; it leans to yes, asks when unclear and stays off for unrelated work', () => {
        expect(READY_JUDGE_PROMPT).toContain(READY_COMMAND)
        expect(READY_JUDGE_PROMPT).not.toMatch(/danx/i)
        expect(READY_JUDGE_PROMPT.length).toBeLessThan(900)
      })

      test('a resume with no loop anywhere is prompted once, and a second look of the same session is not', async ($, on) => {
        const d = await resumed($, on)
        expect(asked(d)).toBe(1)
        await tick(d)
        await turnEnds($, d)
        expect(asked(d)).toBe(1)
      })

      test('a new session (not a resume) is not prompted', async ($, on) => {
        const fresh = await restarted($, on, () => {})
        expect(asked(fresh)).toBe(0)
      })

      test('a resume whose row still holds the loop takes it up and is not prompted', async ($, on) => {
        const d = await resumed($, on, d => void (d.world.readyMark = REPO))
        expect(d.toasts).toContain(readyAdopted(REPO))
        expect(asked(d)).toBe(0)
      })

      test('a session that left the list is never prompted again, on a later resume with no loop on its row', async ($, on) => {
        const d = await resumed($, on, d => void (d.world.readyMark = REPO))
        await $.command.run({ command: '50arms-ready', args: 'off' })
        await d.clock.settle()
        expect(d.world.readyMark).toBe(null)
        await $.classic.SessionStart({ source: 'resume', cwd: '/work', session_id: OWN_SESSION.session_id, transcript_path: '/work/main.jsonl' })
        await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
        await d.clock.settle()
        expect(asked(d)).toBe(0)
      })

      test('a store that fails when the session leaves still ends the server loop first', async ($, on) => {
        const d = await resumed($, on, d => void (d.world.readyMark = REPO))
        d.relay.breakStore('store unavailable')
        await $.command.run({ command: '50arms-ready', args: 'off' })
        await d.clock.settle()
        expect(d.world.readyMark).toBe(null)
      })
    })

    test('a session in no loop takes none up and makes no ready call at a turn end or a tick', async ($, on) => {
      const d = await restarted($, on, () => {})
      await turnEnds($, d)
      await tick(d)
      expect(d.toasts.filter((t: string) => t === readyAdopted(REPO))).toEqual([])
      expect(d.world.readyMarks).toEqual([])
      expect(d.world.readyCleared).toBe(0)
      expect(d.clearRuns).toEqual([])
    })
  })
})
