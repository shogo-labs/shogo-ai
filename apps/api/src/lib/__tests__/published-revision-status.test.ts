// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-536 §C — a deployment row is `ready` only when its revision is.
//
// The card's app carried deployment `cmwp5w12…` as `ready` while revisions
// 00006/00007 had exited with ExitCode137 and none of its DomainMappings
// resolved. This is the decision that turns a Revision object into what the
// Deployment tab is allowed to claim.

import { describe, expect, it } from 'bun:test'
import { publishedRevisionState } from '../published-revision-status'

const revision = (status: Record<string, unknown>, name = 'published-p1-00007') => ({
  metadata: { name },
  status,
})

describe('publishedRevisionState', () => {
  it('is ready only when the Ready condition is true', () => {
    expect(publishedRevisionState(revision({ conditions: [{ type: 'Ready', status: 'True' }] }))).toEqual({
      state: 'ready',
    })
  })

  it('is pending while the revision is still starting', () => {
    const state = publishedRevisionState(
      revision({ conditions: [{ type: 'Ready', status: 'Unknown', reason: 'Deploying' }] }),
    )
    expect(state.state).toBe('pending')
    expect(state.state === 'pending' && state.reason).toContain('Deploying')
  })

  it('names an OOMKilled container as the failure it is', () => {
    const state = publishedRevisionState(
      revision({
        conditions: [{ type: 'Ready', status: 'False', reason: 'ProgressDeadlineExceeded' }],
        containerStatuses: [
          {
            name: 'runtime',
            state: { waiting: { reason: 'CrashLoopBackOff' } },
            lastState: { terminated: { exitCode: 137, reason: 'OOMKilled' } },
          },
        ],
      }),
    )
    expect(state.state).toBe('failed')
    expect(state.state === 'failed' && state.reason).toContain('published-p1-00007 exited with ExitCode137 (OOMKilled)')
  })

  it('reports a failed Ready condition with its reason', () => {
    const state = publishedRevisionState(
      revision({ conditions: [{ type: 'Ready', status: 'False', reason: 'RevisionFailed', message: 'image pull' }] }),
    )
    expect(state.state).toBe('failed')
    expect(state.state === 'failed' && state.reason).toContain('RevisionFailed: image pull')
  })

  it('treats a missing revision as still pending rather than ready', () => {
    expect(publishedRevisionState(null).state).toBe('pending')
    expect(publishedRevisionState(undefined).state).toBe('pending')
    expect(publishedRevisionState(revision({})).state).toBe('pending')
  })
})
