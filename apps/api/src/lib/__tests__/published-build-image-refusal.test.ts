// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-551 QA rounds 5 and 8: a Postgres environment published onto the *shared*
// runtime image, whose boot hydrates the git tag — SQLite schema, LibSQL client —
// so the app answered 200 while writing to a per-pod `dev.db` and left
// `projects-pg` empty. Only a `pg` build carries the PrismaPg client, so a
// server-backed Postgres publish on Knative must have its own image ref.
//
// A first publish used to be the exception that could not work either way: it has
// no `publishedCommitSha` (a publish writes it only once it has succeeded), so it
// built nothing, and refusing it locked every new project out of Postgres for
// good. It is not an exception any more — `resolvePublishCommitSha` asks the pod
// for HEAD — so the same rule now covers it.

import { describe, expect, it } from 'bun:test'
import { postgresImageRefusal } from '../published-build-config'

const image = 'iad.ocir.io/shogo/published/proj1:abc123def0-pg'

describe('postgresImageRefusal', () => {
  it('passes once the publish has its own image', () => {
    expect(
      postgresImageRefusal({ imageRef: image, substrate: 'knative', serverBacked: true, missing: [] }),
    ).toBeNull()
  })

  // The round-8 defect, stated as one assertion: server-backed Postgres on
  // Knative with no image ref is a SQLite client against projects-pg.
  it('refuses a server-backed Knative publish with no image', () => {
    const refusal = postgresImageRefusal({
      imageRef: undefined,
      substrate: 'knative',
      serverBacked: true,
      missing: [],
    })
    expect(refusal).not.toBeNull()
    expect(refusal).toContain('`pg` image')
  })

  // A static app has no client to convert and no server to boot, so it needs no
  // image — refusing it would have killed every static publish on a Postgres
  // region (QA round 7).
  it('does not refuse a publish that is not server-backed', () => {
    expect(
      postgresImageRefusal({ imageRef: undefined, substrate: 'knative', serverBacked: false, missing: [] }),
    ).toBeNull()
  })

  // Metal boots its published microVM from the uploaded artifact, which does
  // carry the Postgres build context, and its substrate never reads `image`.
  it('does not refuse a metal publish, which boots from the artifact', () => {
    expect(
      postgresImageRefusal({ imageRef: undefined, substrate: 'metal', serverBacked: true, missing: [] }),
    ).toBeNull()
  })

  it('names the variables the image build is missing', () => {
    const refusal = postgresImageRefusal({
      imageRef: undefined,
      substrate: 'knative',
      serverBacked: true,
      missing: ['PUBLISH_REGISTRY', 'PUBLISH_BUILD_NAMESPACE'],
    })
    expect(refusal).toBe(
      'per-commit image builds are not configured for this region (missing PUBLISH_REGISTRY, PUBLISH_BUILD_NAMESPACE).',
    )
  })

  it('refuses an environment the flag does not cover', () => {
    expect(
      postgresImageRefusal({ imageRef: undefined, substrate: 'knative', serverBacked: true, missing: [] }),
    ).toBe('no `pg` image was built for this commit (is PUBLISH_BUILD_IMAGES off for it?).')
  })
})
