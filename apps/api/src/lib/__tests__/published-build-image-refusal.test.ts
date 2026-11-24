// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-551 QA round 5: staging published a Postgres environment that shipped the
// shared runtime image, so the pod built the app from a SQLite context and
// `PrismaLibSql` wrote to a per-pod file. A Postgres publish must resolve its
// own `pg` image ref before it reaches the substrate — `publishedImageRef` being
// empty is the whole test, whichever reason left it empty.

import { describe, expect, it } from 'bun:test'
import { postgresImageRefusal } from '../published-build-config'

describe('postgresImageRefusal', () => {
  it('passes once the publish has its own image', () => {
    expect(
      postgresImageRefusal({
        imageRef: 'iad.ocir.io/shogo/published/proj1:abc123def0-pg',
        commitSha: 'abc123def0',
        serverBacked: true,
        missing: [],
      }),
    ).toBeNull()
  })

  it('refuses a publish with no commit to build from', () => {
    expect(
      postgresImageRefusal({ imageRef: undefined, commitSha: null, serverBacked: true, missing: [] }),
    ).toBe('the project has no published commit to build one from.')
  })

  it('refuses a publish that is not server-backed', () => {
    expect(
      postgresImageRefusal({ imageRef: undefined, commitSha: 'abc123def0', serverBacked: false, missing: [] }),
    ).toBe('the publish is not server-backed, so no image is built for it.')
  })

  it('names the variables the image build is missing', () => {
    const refusal = postgresImageRefusal({
      imageRef: undefined,
      commitSha: 'abc123def0',
      serverBacked: true,
      missing: ['PUBLISH_REGISTRY', 'PUBLISH_BUILD_NAMESPACE'],
    })
    expect(refusal).toBe('the build is not configured (missing PUBLISH_REGISTRY, PUBLISH_BUILD_NAMESPACE).')
  })

  it('refuses an environment the flag does not cover', () => {
    expect(
      postgresImageRefusal({ imageRef: undefined, commitSha: 'abc123def0', serverBacked: true, missing: [] }),
    ).toBe('PUBLISH_BUILD_IMAGES does not cover it.')
  })
})
