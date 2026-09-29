import { describe, expect, test } from 'bun:test'
import { isRuntimeStillStarting, memberCallFailure, resolveWhileStarting } from '../workspace-member-call'

function timeout(): Error {
  return Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })
}

function sessionError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'WorkspaceSessionError', code })
}

function fakeClock() {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => { t += ms } }
}

describe('resolveWhileStarting', () => {
  test('keeps asking while the runtime is still cold-booting', async () => {
    let calls = 0
    const url = await resolveWhileStarting(
      async () => {
        calls++
        if (calls < 3) throw timeout()
        return 'http://vm'
      },
      { ...fakeClock(), waitMs: 150_000, pollMs: 3_000 },
    )
    expect(url).toBe('http://vm')
    expect(calls).toBe(3)
  })

  test('does not retry a refusal', async () => {
    let calls = 0
    await expect(
      resolveWhileStarting(async () => {
        calls++
        throw new Error('metal /assign 500')
      }, fakeClock()),
    ).rejects.toThrow('metal /assign 500')
    expect(calls).toBe(1)
  })

  test('gives up at the deadline with the timeout', async () => {
    let calls = 0
    const clock = fakeClock()
    await expect(
      resolveWhileStarting(async () => {
        calls++
        await clock.sleep(30_000)
        throw timeout()
      }, { ...clock, waitMs: 150_000, pollMs: 3_000 }),
    ).rejects.toThrow('timed out')
    expect(calls).toBe(5)
  })
})

describe('memberCallFailure', () => {
  test('a project chat asking to mount is a 409 the agent should not retry', () => {
    const f = memberCallFailure(
      sessionError('not_workspace_session', 'Chat session s1 is not a workspace session'),
      'mount',
    )
    expect(f.status).toBe(409)
    expect(f.body).toEqual({ error: 'Chat session s1 is not a workspace session', code: 'not_workspace_session' })
  })

  test('an unknown session is a 404', () => {
    expect(memberCallFailure(sessionError('session_not_found', 'nope'), 'unmount').status).toBe(404)
  })

  test('a runtime still starting is a 503 that says so', () => {
    const f = memberCallFailure(timeout(), 'mount')
    expect(f.status).toBe(503)
    expect(f.body.code).toBe('runtime_starting')
  })

  test('anything else stays a 502 carrying the message', () => {
    expect(memberCallFailure(new Error('No Metal host placement'), 'mount')).toEqual({
      status: 502,
      body: { error: 'No Metal host placement' },
    })
  })
})

describe('isRuntimeStillStarting', () => {
  test('matches fetch timeouts and aborts, including wrapped causes', () => {
    expect(isRuntimeStillStarting(timeout())).toBe(true)
    expect(isRuntimeStillStarting(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true)
    expect(isRuntimeStillStarting(Object.assign(new Error('x'), { cause: { code: 'ETIMEDOUT' } }))).toBe(true)
    expect(isRuntimeStillStarting(new Error('connection refused'))).toBe(false)
    expect(isRuntimeStillStarting(null)).toBe(false)
  })
})
