/** allow-remote-steer gate: default off, opt-in on, pump excluded, loopback owner never gated. */
import { describe, expect, it } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  RemoteSteerGate,
  STEER_DENIED_CODE,
  SET_ALLOW_REMOTE_STEER_ENDPOINT,
  isLoopbackAuthority,
  sessionIdOfPayload,
} from '../src/steer-gate.ts'

const REMOTE = '100.102.77.86:3182'
const LOCAL = '127.0.0.1:3182'

function payload(sessionId: string, extra: object = {}): unknown {
  return { args: { request: { sessionId, ...extra } } }
}

describe('isLoopbackAuthority', () => {
  it.each(['127.0.0.1:3182', 'localhost:3080', 'localhost', '[::1]:3080', '127.1.2.3'])('treats %s as the owner origin', (authority) => {
    expect(isLoopbackAuthority(authority)).toBe(true)
  })
  it.each([REMOTE, 'forge.tail1234.ts.net', 'forge.tail1234.ts.net:8443', '10.0.0.5', undefined, '', 'bad host'])('treats %s as remote', (authority) => {
    expect(isLoopbackAuthority(authority)).toBe(false)
  })
})

describe('sessionIdOfPayload', () => {
  it('reads the Typert args.request.sessionId and fails closed on anything else', () => {
    expect(sessionIdOfPayload(payload('s1'))).toBe('s1')
    expect(sessionIdOfPayload({})).toBeUndefined()
    expect(sessionIdOfPayload(null)).toBeUndefined()
    expect(sessionIdOfPayload({ args: { request: {} } })).toBeUndefined()
    expect(sessionIdOfPayload({ args: { request: { sessionId: '' } } })).toBeUndefined()
  })
})

describe('RemoteSteerGate: default OFF', () => {
  it('refuses every gated steer verb from a remote origin when the session never opted in', () => {
    const gate = new RemoteSteerGate()
    expect(gate.state('s1')).toEqual({ sessionId: 's1', allowRemoteSteer: false, eligible: true })
    for (const endpoint of ['session/prompt', 'session/updateQueue', 'session/cancel', 'session/selectModel', 'session/fork', 'session/rename']) {
      const refusal = gate.guard({ endpoint, payload: payload('s1', { requestId: 'r1' }), authority: REMOTE })
      expect(refusal, endpoint).toMatchObject({ code: STEER_DENIED_CODE, details: { sessionId: 's1', reason: 'not-opted-in' } })
    }
  })

  it('refuses a remote steer that does not name a session, and a request with no Host authority', () => {
    const gate = new RemoteSteerGate()
    expect(gate.guard({ endpoint: 'session/prompt', payload: {}, authority: REMOTE })).toMatchObject({ code: STEER_DENIED_CODE })
    expect(gate.guard({ endpoint: 'session/prompt', payload: payload('s1'), authority: undefined })).toMatchObject({ code: STEER_DENIED_CODE })
  })

  it('never gates the owner: a loopback origin steers a session that has not opted in', () => {
    const gate = new RemoteSteerGate()
    expect(gate.guard({ endpoint: 'session/prompt', payload: payload('s1'), authority: LOCAL })).toBeUndefined()
  })

  it('does not gate reads, create, or approval/answer traffic from a remote origin', () => {
    const gate = new RemoteSteerGate()
    for (const endpoint of ['session/list', 'session/page', 'session/follow', 'session/projections', 'session/create', 'dshHostDirectory/list', 'dshHostDirectory/allowRemoteSteer', 'remote-events/result']) {
      expect(gate.guard({ endpoint, payload: payload('s1'), authority: REMOTE }), endpoint).toBeUndefined()
    }
  })
})

describe('RemoteSteerGate: opt-in ON', () => {
  it('admits a remote steer only for the session that opted in, and revoking turns it off again', () => {
    const gate = new RemoteSteerGate()
    expect(gate.setAllow('s1', true)).toEqual({ sessionId: 's1', allowRemoteSteer: true, eligible: true })
    expect(gate.guard({ endpoint: 'session/prompt', payload: payload('s1'), authority: REMOTE })).toBeUndefined()
    expect(gate.guard({ endpoint: 'session/prompt', payload: payload('s2'), authority: REMOTE })).toMatchObject({ code: STEER_DENIED_CODE })
    expect(gate.allowedSessionIds()).toEqual(['s1'])
    gate.setAllow('s1', false)
    expect(gate.guard({ endpoint: 'session/prompt', payload: payload('s1'), authority: REMOTE })).toMatchObject({ code: STEER_DENIED_CODE })
    expect(gate.allowedSessionIds()).toEqual([])
  })

  it('a remote origin can never grant the opt-in to itself; the owner origin can', () => {
    const gate = new RemoteSteerGate()
    const body = { args: { request: { sessionId: 's1', allow: true } } }
    expect(gate.guard({ endpoint: SET_ALLOW_REMOTE_STEER_ENDPOINT, payload: body, authority: REMOTE }))
      .toMatchObject({ code: STEER_DENIED_CODE, details: { capability: 'allow-remote-steer' } })
    expect(gate.guard({ endpoint: SET_ALLOW_REMOTE_STEER_ENDPOINT, payload: body, authority: LOCAL })).toBeUndefined()
    expect(gate.state('s1').allowRemoteSteer).toBe(false) // the guard decides, it never grants
  })
})

describe('RemoteSteerGate: mesh-pump sessions are never eligible', () => {
  it('refuses to opt in a pump-minted session id, with a typed steer-denied RemoteError', () => {
    const gate = new RemoteSteerGate()
    expect(gate.state('session-mesh-138505-a1')).toEqual({
      sessionId: 'session-mesh-138505-a1', allowRemoteSteer: false, eligible: false, ineligibleReason: 'mesh-pump-owned',
    })
    let thrown: unknown
    try { gate.setAllow('session-mesh-138505-a1', true) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(RemoteError)
    expect(thrown).toMatchObject({ code: STEER_DENIED_CODE, details: { sessionId: 'session-mesh-138505-a1', reason: 'mesh-pump-owned' } })
    expect(gate.guard({ endpoint: 'session/prompt', payload: payload('session-mesh-138505-a1'), authority: REMOTE }))
      .toMatchObject({ code: STEER_DENIED_CODE, details: { reason: 'mesh-pump-owned' } })
  })

  it('a prompt carrying the pump request-id prefix marks the session pump-owned and revokes an existing opt-in', () => {
    const gate = new RemoteSteerGate()
    gate.setAllow('s9', true)
    expect(gate.guard({ endpoint: 'session/prompt', payload: payload('s9'), authority: REMOTE })).toBeUndefined()
    // the pump (loopback origin) prompts into it
    expect(gate.guard({ endpoint: 'session/prompt', payload: payload('s9', { requestId: 'mesh-dispatch-1-1' }), authority: LOCAL })).toBeUndefined()
    expect(gate.state('s9')).toMatchObject({ allowRemoteSteer: false, eligible: false, ineligibleReason: 'mesh-pump-owned' })
    expect(gate.guard({ endpoint: 'session/prompt', payload: payload('s9', { requestId: 'r' }), authority: REMOTE })).toMatchObject({ code: STEER_DENIED_CODE })
    expect(() => gate.setAllow('s9', true)).toThrow(RemoteError)
    expect(gate.allowedSessionIds()).toEqual([])
  })

  it('observing a landed user message with a pump rpcId marks the session even with a non-pump id', () => {
    const gate = new RemoteSteerGate()
    gate.observeRequestId('s7', 'user-typed-1')
    expect(gate.state('s7').eligible).toBe(true)
    gate.observeRequestId('s7', 'mesh-dispatch-5-2')
    expect(gate.state('s7').eligible).toBe(false)
    gate.observeRequestId('s8', undefined)
    expect(gate.state('s8').eligible).toBe(true)
  })
})
