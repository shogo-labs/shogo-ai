// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, mock, test } from 'bun:test'
import { createCodeWorkbenchOpener, type CodeWorkbenchStatus } from '../code-oss-server/status'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createCodeWorkbenchOpener', () => {
  test('returns at once and reports progress, then ready', async () => {
    const opener = createCodeWorkbenchOpener({ logPath: () => '/logs/shogo-ide.log' })
    const events: CodeWorkbenchStatus[] = []
    const gate = deferred()
    const result = opener.open({
      key: 'w1:p1',
      projectId: 'p1',
      emit: (s) => events.push(s),
      run: async (report) => {
        report('downloading', { received: 10, total: 100 })
        report('verifying')
        report('extracting')
        report('starting')
        await gate.promise
      },
    })
    expect(result).toEqual({ ok: true, pending: true })
    expect(opener.isPending('w1:p1')).toBe(true)
    gate.resolve()
    await flush()
    expect(events.map((e) => e.phase)).toEqual(['downloading', 'verifying', 'extracting', 'starting', 'ready'])
    expect(events[0]).toEqual({ projectId: 'p1', phase: 'downloading', received: 10, total: 100 })
    expect(opener.isPending('w1:p1')).toBe(false)
  })

  test.each(['downloading', 'starting'] as const)('a failure while %s ends in an error with the log path', async (phase) => {
    const onError = mock(() => {})
    const opener = createCodeWorkbenchOpener({ logPath: () => '/logs/shogo-ide.log' })
    const events: CodeWorkbenchStatus[] = []
    opener.open({
      key: 'k',
      projectId: 'p1',
      emit: (s) => events.push(s),
      onError,
      run: async (report) => {
        report(phase)
        throw new Error('HTTP 503 from github.com')
      },
    })
    await flush()
    expect(events.map((e) => e.phase)).toEqual([phase, 'error'])
    expect(events[1]).toEqual({ projectId: 'p1', phase: 'error', message: 'HTTP 503 from github.com', logPath: '/logs/shogo-ide.log' })
    expect(onError).toHaveBeenCalledWith(events[1])
  })

  test('a second open while one is pending does not start another run', async () => {
    const opener = createCodeWorkbenchOpener({ logPath: () => '' })
    const gate = deferred()
    const run = mock(async () => gate.promise)
    const first = opener.open({ key: 'w1:p1', projectId: 'p1', emit: () => {}, run })
    const second = opener.open({ key: 'w1:p1', projectId: 'p1', emit: () => {}, run })
    expect(first).toEqual({ ok: true, pending: true })
    expect(second).toEqual({ ok: true, pending: true, alreadyPending: true })
    expect(run).toHaveBeenCalledTimes(1)
    gate.resolve()
    await flush()
    opener.open({ key: 'w1:p1', projectId: 'p1', emit: () => {}, run: async () => {} })
    expect(run).toHaveBeenCalledTimes(1)
  })

  test('different windows open independently', () => {
    const opener = createCodeWorkbenchOpener({ logPath: () => '' })
    const never = () => new Promise<void>(() => {})
    expect(opener.open({ key: 'w1:p1', projectId: 'p1', emit: () => {}, run: never })).toEqual({ ok: true, pending: true })
    expect(opener.open({ key: 'w2:p1', projectId: 'p1', emit: () => {}, run: never })).toEqual({ ok: true, pending: true })
  })

  test('a missing project id is rejected without running', () => {
    const run = mock(async () => {})
    const opener = createCodeWorkbenchOpener({ logPath: () => '' })
    expect(opener.open({ key: 'k', projectId: undefined, emit: () => {}, run })).toEqual({ ok: false, error: 'project-id-required' })
    expect(run).not.toHaveBeenCalled()
  })
})
