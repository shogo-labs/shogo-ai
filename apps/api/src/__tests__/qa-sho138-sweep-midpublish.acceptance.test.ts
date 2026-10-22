// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-138 acceptance (QA, round 1). The published-site sweep is allowed to
// delete customer-facing infra, so every state a FIRST publish actually passes
// through has to be hands-off.
//
// `publishedSubdomain` is written at the END of publish (routes/publish.ts), so
// while a first publish is in flight the row has NO subdomain — the only thing
// keeping the sweep off it is the publish-status guard. The states that occur
// there are `building` → `uploading` → `configuring` (prisma `PublishStatus`;
// routes/publish.ts setPublishStatus). `configuring` is exactly when
// `published-{id}` and its DomainMapping get created, i.e. when the sweep first
// has something to find.
//
// Red on 36e015468: the guard lists `building` and `publishing` — `publishing`
// is not a member of `PublishStatus`, so it can never match a row, and
// `uploading` / `configuring` are missing.

import { describe, expect, test } from 'bun:test'
import {
  selectOrphanedPublishedSites,
  type ProjectPublishRow,
} from '../services/published-site-sweep'

const HOUR = 60 * 60 * 1000
const NOW = 1_800_000_000_000

const runtime = {
  projectId: 'proj-midpublish',
  substrate: 'knative' as const,
  name: 'published-proj-midpublish',
  subdomain: 'midpublish-site',
  createdAtMs: NOW - 3 * HOUR,
}

function selectWith(row: ProjectPublishRow) {
  return selectOrphanedPublishedSites({
    runtimes: [runtime],
    rowsById: { [runtime.projectId]: row },
    now: NOW,
    minAgeMs: HOUR,
  })
}

describe('published-site sweep — a first publish in flight is hands-off', () => {
  // Every value `setPublishStatus` writes before `publishedSubdomain` exists.
  for (const state of ['building', 'uploading', 'configuring'] as const) {
    test(`skips a publish stuck in "${state}" even after minAge`, () => {
      const { selected, skipped } = selectWith({
        publishedSubdomain: null,
        publishStatus: state,
      })

      expect(
        selected.map((s) => s.projectId),
        `a project mid-publish ("${state}") must never be selected for teardown`,
      ).toEqual([])
      expect(skipped[0]?.reason).toBe('publishing')
    })
  }

  test('still selects a row that is unpublished and idle', () => {
    const { selected } = selectWith({ publishedSubdomain: null, publishStatus: 'idle' })
    expect(selected.map((s) => s.projectId)).toEqual([runtime.projectId])
  })

  test('still never touches a row that has a subdomain', () => {
    const { selected } = selectWith({ publishedSubdomain: 'midpublish-site', publishStatus: 'live' })
    expect(selected).toEqual([])
  })
})
