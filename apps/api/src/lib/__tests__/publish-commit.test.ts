// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-551 QA rounds 7 and 8 — the commit a publish ships decides whether it can
// build the `pg` image it needs, and a publish used to read `publishedCommitSha`,
// the record of the last publish that SUCCEEDED. Two consequences, one cause:
// a first publish had no commit at all (so it built no image, booted the shared
// runtime, and served a LibSQL client against Postgres), and every later publish
// built the previous publish's commit.

import { describe, expect, it } from 'bun:test'
import { resolvePublishCommitSha } from '../publish-commit'

/** A pod that owns a repo at `sha`. */
const podHead = (sha: string | null) => async () => ({ sha })

describe('resolvePublishCommitSha', () => {
  it('uses the pod HEAD on a first publish, which has no recorded commit', async () => {
    const sha = await resolvePublishCommitSha({
      serverBacked: true,
      flushHead: podHead('sha-head'),
      recordedCommitSha: async () => null,
    })
    expect(sha).toBe('sha-head')
  })

  // The off-by-one: the image used to be labelled with whatever the *previous*
  // publish committed.
  it('prefers the commit being published over the previous publish\'s commit', async () => {
    const sha = await resolvePublishCommitSha({
      serverBacked: true,
      flushHead: podHead('sha-now'),
      recordedCommitSha: async () => 'sha-previous',
    })
    expect(sha).toBe('sha-now')
  })

  it('falls back to the recorded commit when the pod has no HEAD to report', async () => {
    const sha = await resolvePublishCommitSha({
      serverBacked: true,
      flushHead: podHead(null),
      recordedCommitSha: async () => 'sha-recorded',
    })
    expect(sha).toBe('sha-recorded')
  })

  it('does not touch a pod for a static publish', async () => {
    let flushed = false
    const sha = await resolvePublishCommitSha({
      serverBacked: false,
      flushHead: async () => {
        flushed = true
        return { sha: 'sha-pod' }
      },
      recordedCommitSha: async () => 'sha-recorded',
    })
    expect(flushed).toBe(false)
    expect(sha).toBe('sha-recorded')
  })

  // `flushGitSync` is documented as never throwing, but a publish must not fail
  // because a best-effort flush did.
  it('survives a flush that throws', async () => {
    const sha = await resolvePublishCommitSha({
      serverBacked: true,
      flushHead: async () => {
        throw new Error('pod unreachable')
      },
      recordedCommitSha: async () => 'sha-recorded',
    })
    expect(sha).toBe('sha-recorded')
  })

  it('survives a recorded-commit read that throws', async () => {
    const sha = await resolvePublishCommitSha({
      serverBacked: false,
      flushHead: podHead('sha-pod'),
      recordedCommitSha: async () => {
        throw new Error('database unavailable')
      },
    })
    expect(sha).toBeNull()
  })
})
