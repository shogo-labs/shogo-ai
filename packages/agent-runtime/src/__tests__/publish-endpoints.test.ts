// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-308: the two publish endpoints share one staging directory, and the first
 * one used to delete it.
 *
 * This is the test that was missing. #1975 shipped a skip that assumed
 * `/agent/publish-artifact` could read `dist.publish.staging` after
 * `/agent/dist-files?publish=true` had run, and its tests mocked the runtime, so
 * they asserted the API's calls instead of the runtime's behaviour. Every
 * server-backed publish on staging then failed with `artifact_missing`.
 *
 * So these cases drive the real handlers, mounted on a real Hono app, against a
 * real directory and a real tar: `keep=true` must leave the staging dir for the
 * artifact call, and without it the artifact call must fail with
 * `dist_not_found` — which is the bug, and it fails on the code before the fix.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import {
  handleDistFiles,
  handlePublishArtifact,
  type PublishEndpointDeps,
} from '../publish-endpoints'
import { PUBLISH_STAGING_DIR } from '../preview-manager'

let workspace: string
let app: Hono

function mount(workspaceDir: string): Hono {
  const deps: PublishEndpointDeps = {
    projectDir: () => workspaceDir,
    outputRoot: (_projectId, projectDir) => projectDir,
  }
  const hono = new Hono()
  hono.get('/agent/dist-files', (c) => handleDistFiles(c, deps))
  hono.get('/agent/publish-artifact', (c) => handlePublishArtifact(c, deps))
  return hono
}

/** A project with a source file and a publish build output, as a real one has. */
function seedProject(dir: string): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo' }))
  writeFileSync(join(dir, 'server.tsx'), 'export default { fetch: () => new Response("ok") }\n')
  const staging = join(dir, PUBLISH_STAGING_DIR)
  mkdirSync(join(staging, 'assets'), { recursive: true })
  writeFileSync(join(staging, 'index.html'), '<!doctype html><title>published</title>')
  writeFileSync(join(staging, 'assets', 'app.js'), 'console.log("published")')
}

const distFiles = (query = '') =>
  app.fetch(new Request(`http://runtime.test/agent/dist-files?publish=true${query}`))
const artifact = () => app.fetch(new Request('http://runtime.test/agent/publish-artifact'))

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'shogo-publish-endpoints-'))
  seedProject(workspace)
  app = mount(workspace)
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('publish endpoints share the staging dir', () => {
  it('keeps the build output for the artifact call when keep=true', async () => {
    const files = await distFiles('&keep=true')
    expect(files.status).toBe(200)
    const body = (await files.json()) as Array<{ path: string; content: string }>
    expect(body.map((f) => f.path).sort()).toEqual(['assets/app.js', 'index.html'])
    // The directory the image build reads is still there.
    expect(existsSync(join(workspace, PUBLISH_STAGING_DIR))).toBe(true)

    const res = await artifact()
    expect(res.status).toBe(200)
    const archive = (await res.json()) as { archive: string; bytes: number }
    expect(archive.bytes).toBeGreaterThan(0)
    expect(Buffer.from(archive.archive, 'base64').subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
    // The artifact call is the last reader, so it cleans up after itself.
    expect(existsSync(join(workspace, PUBLISH_STAGING_DIR))).toBe(false)
  })

  it('deletes the build output without keep, so the artifact call has nothing to read', async () => {
    const files = await distFiles()
    expect(files.status).toBe(200)
    expect(existsSync(join(workspace, PUBLISH_STAGING_DIR))).toBe(false)

    // This is the bug: the publish flow's own download removed the directory the
    // image build needs, and the publish died with artifact_missing.
    const res = await artifact()
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('dist_not_found')
  })

  it('leaves a static publish cleaning up after itself', async () => {
    // No keep, no artifact call: the staging dir must not be left behind.
    await distFiles()
    expect(existsSync(join(workspace, PUBLISH_STAGING_DIR))).toBe(false)
  })

  it('reports a project that is not attached instead of reading the wrong directory', async () => {
    const detached = new Hono()
    detached.get('/agent/dist-files', (c) =>
      handleDistFiles(c, { projectDir: () => null, outputRoot: (_id, dir) => dir }),
    )
    const res = await detached.fetch(new Request('http://runtime.test/agent/dist-files?publish=true'))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('project_not_attached')
  })
})
