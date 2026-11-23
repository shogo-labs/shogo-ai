// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-308 §2 — what a published pod must NOT redo.
//
// A per-commit image is built from the commit's artifact, so it already carries
// the source tree, the seed DB, `node_modules`, the generated Prisma client and
// the root-based `dist/`. The boot path is where that work gets undone by
// accident: hydrating the durable repo overwrites the baked source (and pays a
// clone on every cold start), and re-running install/prisma/watch repeated the
// boot cost the image exists to remove. `publishedBootPlan` is the single
// contract both call sites read, so this pins it.

import { describe, expect, it } from 'bun:test'
import { isPrebuiltPublishedImage, publishedBootPlan } from '../preview-manager'

describe('isPrebuiltPublishedImage', () => {
  it('is on only for a truthy value', () => {
    expect(isPrebuiltPublishedImage({ SHOGO_PREBUILT_IMAGE: 'true' })).toBe(true)
    expect(isPrebuiltPublishedImage({ SHOGO_PREBUILT_IMAGE: ' TRUE ' })).toBe(true)
  })

  it('is off when unset, blank, false or nonsense', () => {
    expect(isPrebuiltPublishedImage({})).toBe(false)
    expect(isPrebuiltPublishedImage({ SHOGO_PREBUILT_IMAGE: '' })).toBe(false)
    expect(isPrebuiltPublishedImage({ SHOGO_PREBUILT_IMAGE: 'false' })).toBe(false)
    expect(isPrebuiltPublishedImage({ SHOGO_PREBUILT_IMAGE: '1' })).toBe(false)
  })

  it('defaults to this process, so an editing runtime is never mistaken for an image', () => {
    // The E2E and local-mode runtimes import this module too; they must keep the
    // full boot path.
    expect(isPrebuiltPublishedImage()).toBe(
      (process.env.SHOGO_PREBUILT_IMAGE || '').trim().toLowerCase() === 'true',
    )
  })
})

describe('publishedBootPlan', () => {
  it('skips source hydration, install, the watcher and LFS materialization on a prebuilt image', () => {
    expect(publishedBootPlan({ SHOGO_PREBUILT_IMAGE: 'true' })).toEqual({
      fromImage: true,
      hydrateSource: false,
      installDeps: false,
      watchFiles: false,
      materializeLfs: false,
    })
  })

  it('does all four when the pod boots the shared runtime image', () => {
    expect(publishedBootPlan({})).toEqual({
      fromImage: false,
      hydrateSource: true,
      installDeps: true,
      watchFiles: true,
      materializeLfs: true,
    })
  })

  // SHO-485 §1c: media on the pod's 2 Gi volume used to grow with the project
  // (every LFS object copied at every cold start). An image-booted pod serves
  // each object from `<projectId>/lfs/objects` on request instead, so the boot
  // path must not copy it — and the legacy source-hydrate path, which runs a
  // Vite build, still must.
  it('never materializes LFS on an image boot, always on a source hydrate', () => {
    expect(publishedBootPlan({ SHOGO_PREBUILT_IMAGE: 'true' }).materializeLfs).toBe(false)
    expect(publishedBootPlan({ SHOGO_PREBUILT_IMAGE: 'false' }).materializeLfs).toBe(true)
    expect(publishedBootPlan({}).materializeLfs).toBe(true)
  })
})
