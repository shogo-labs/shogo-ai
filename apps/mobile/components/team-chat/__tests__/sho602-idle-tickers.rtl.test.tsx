// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-602 — an idle screen commits zero times from a clock.
 *
 * Two 1 s `setNow()` tickers were alive with nothing happening: `ProcessPanel`
 * started its interval whether or not it had a single process to time (it
 * renders nothing when it has none), and `EmailCard`'s send countdown kept
 * ticking after its target had passed, forever, for a label that could not
 * change again. On an idle channel that is a React commit every second with no
 * pixels to show for it.
 *
 * The counts here are React commits, taken from a `Profiler` around each card:
 * 30 s of fake clock with nothing running must produce none.
 */
import { describe, expect, jest, mock, test } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { createElement, Profiler } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
  } as any),
)
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))
mock.module('lucide-react-native', () => {
  const Icon = () => createElement('span')
  return {
    AlertTriangle: Icon,
    ArrowDownLeft: Icon,
    ArrowUpRight: Icon,
    Paperclip: Icon,
    ShieldAlert: Icon,
    ShieldCheck: Icon,
    ChevronDown: Icon,
    ChevronUp: Icon,
    Terminal: Icon,
    Clock: Icon,
    X: Icon,
  }
})
mock.module('../../../../lib/workspace-http', () => ({
  workspaceHttpProxy: () => ({ post: async () => ({ data: null }), get: async () => ({ data: '' }) }),
}))
mock.module('../EmailHtmlView', () => ({ EmailHtmlView: () => null }))

const { ProcessPanel } = await import('../../chat/ProcessPanel')
const { EmailCard } = await import('../EmailCard')

/** Commits React performed for the wrapped tree. */
let commits = 0

function commitCount(node: ReturnType<typeof createElement>): void {
  render(
    createElement(
      Profiler,
      { id: 'card', onRender: () => { commits += 1 } } as any,
      node,
    ) as any,
  )
}

function advance(ms: number) {
  let left = ms
  while (left > 0) {
    const step = Math.min(100, left)
    act(() => {
      jest.advanceTimersByTime(step)
    })
    left -= step
  }
}

function reset() {
  cleanup()
  commits = 0
}

describe('SHO-602 idle tickers', () => {
  test('ProcessPanel with nothing to time commits zero times in 30 s', () => {
    jest.useFakeTimers()
    reset()
    commitCount(
      createElement(ProcessPanel as any, { processes: [], onKill: () => {} }),
    )

    // The mount commit is the only one it gets.
    const mounted = commits
    advance(30_000)

    expect(commits).toBe(mounted)
    jest.useRealTimers()
  })

  test('ProcessPanel with a running process still ticks its elapsed label', () => {
    jest.useFakeTimers()
    reset()
    commitCount(
      createElement(ProcessPanel as any, {
        processes: [
          { runId: 'r1', command: 'bun test', startedAt: Date.now() - 5_000 },
        ],
        onKill: () => {},
      }),
    )

    advance(3_000)

    expect(commits).toBeGreaterThan(0)
    jest.useRealTimers()
  })

  test('EmailCard stops counting down once its send time has passed', () => {
    jest.useFakeTimers()
    reset()
    const email = {
      mailId: 'm1',
      threadId: 't1',
      mailboxId: 'mb1',
      direction: 'outbound',
      status: 'scheduled',
      sendAfter: new Date(Date.now() + 2_000).toISOString(),
      from: { address: 'me@shogo.ai', name: 'Me' },
      to: [{ address: 'jane@customer.io', name: 'Jane' }],
      cc: [],
      subject: 'Order #42',
      hasHtml: false,
      attachments: [],
    }
    commitCount(
      createElement(EmailCard as any, { workspaceId: 'w1', body: 'Hi', email }),
    )

    // While it counts down, the label is live: commits are the point.
    const before = commits
    advance(1_000)
    expect(commits).toBeGreaterThan(before)

    // Past the target the label is final, and the timer is gone.
    advance(2_000)
    const settled = commits
    advance(30_000)
    expect(commits).toBe(settled)
    jest.useRealTimers()
  })
})
