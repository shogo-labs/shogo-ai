// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * .github/scripts/promote-metal-runtime-image.sh picks the staging multi-arch
 * image a production release promotes to the metal fleet. Promoting one built
 * from a different runtime chain would bake the wrong guest code into every
 * host's rootfs, so these run the real script against a throwaway git repo and
 * a stubbed `docker` whose registry is a list of published tags.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const SCRIPT = resolve(import.meta.dir, '../../.github/scripts/promote-metal-runtime-image.sh')
const REG = 'reg.example/ns'
const REPO = `${REG}/shogo/shogo-runtime`

let root: string
let repo: string
let bin: string
let published: string
let created: string
/** c1: runtime change. c2, c3: API-only changes on top. c4: runtime change. */
let c1: string, c2: string, c3: string, c4: string

function git(...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function commit(path: string, content: string): string {
  mkdirSync(join(repo, path, '..'), { recursive: true })
  writeFileSync(join(repo, path), content)
  git('add', '-A')
  git('commit', '-qm', path)
  return git('rev-parse', 'HEAD')
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'promote-metal-'))
  repo = join(root, 'repo')
  bin = join(root, 'bin')
  published = join(root, 'published')
  created = join(root, 'created')
  mkdirSync(repo)
  mkdirSync(bin)
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  c1 = commit('packages/agent-runtime/src/a.ts', 'one')
  c2 = commit('apps/api/src/x.ts', 'api')
  c3 = commit('apps/api/src/x.ts', 'api2')
  c4 = commit('packages/agent-runtime/src/a.ts', 'two')

  // `imagetools inspect <ref>` succeeds when <ref> is in $PUBLISHED;
  // `imagetools create` appends its arguments to $CREATED.
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
case "$3" in
  inspect) grep -qxF "$4" "$PUBLISHED" ;;
  create) shift 3; echo "$*" >> "$CREATED" ;;
  *) exit 2 ;;
esac
`,
  )
  chmodSync(join(bin, 'docker'), 0o755)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(created, { force: true })
  writeFileSync(published, '')
})

function publish(sha: string, { docker = true } = {}) {
  const tags = [`${REPO}:staging-multiarch-${sha}`]
  if (docker) tags.push(`${REPO}:staging-docker-multiarch-${sha}`)
  writeFileSync(published, readFileSync(published, 'utf8') + tags.join('\n') + '\n')
}

function run(sha: string, env: Record<string, string> = {}) {
  const out = join(root, 'out')
  rmSync(out, { force: true })
  const r = spawnSync('bash', [SCRIPT], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SHA: sha,
      REGISTRY: REG,
      PUBLISHED: published,
      CREATED: created,
      GITHUB_OUTPUT: out,
      ...env,
    },
  })
  if (r.status !== 0) throw new Error(`script exited ${r.status}: ${r.stderr}${r.stdout}`)
  const outputs = Object.fromEntries(
    readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split('=') as [string, string]),
  )
  const creates = existsSync(created) ? readFileSync(created, 'utf8').trim().split('\n') : []
  return { outputs, creates }
}

describe('promote-metal-runtime-image.sh', () => {
  test("promotes the release commit's own staging image under its sha", () => {
    publish(c4)
    const { outputs, creates } = run(c4)
    expect(outputs).toEqual({ source: 'promoted', image: `${REPO}:production-multiarch-${c4}`, revision: c4 })
    expect(creates).toEqual([
      `--tag ${REPO}:production-multiarch-${c4} --tag ${REPO}:production-multiarch-latest ${REPO}:staging-multiarch-${c4}`,
      `--tag ${REPO}:production-docker-multiarch-${c4} --tag ${REPO}:production-docker-multiarch-latest ${REPO}:staging-docker-multiarch-${c4}`,
    ])
  })

  test('walks back over runtime-neutral commits and keeps the source sha in the tag', () => {
    publish(c1)
    const { outputs } = run(c3)
    expect(outputs).toEqual({ source: 'promoted', image: `${REPO}:production-multiarch-${c1}`, revision: c1 })
  })

  test('prefers the newest matching image', () => {
    publish(c1)
    publish(c2)
    expect(run(c3).outputs.revision).toBe(c2)
  })

  test('never promotes an image from before a runtime change', () => {
    publish(c1)
    const { outputs, creates } = run(c4)
    expect(outputs).toEqual({ source: 'build', image: `${REPO}:production-multiarch-${c4}`, revision: c4 })
    expect(creates).toEqual([])
  })

  test('skips a commit whose docker-class image is missing', () => {
    publish(c1)
    publish(c2, { docker: false })
    expect(run(c3).outputs.revision).toBe(c1)
  })

  test('a dry run reports the image it would promote without retagging', () => {
    publish(c1)
    const { outputs, creates } = run(c3, { DRY_RUN: 'true' })
    expect(outputs).toEqual({ source: 'promoted', image: `${REPO}:production-multiarch-${c1}`, revision: c1 })
    expect(creates).toEqual([])
  })

  test('builds when forced, even with a matching image', () => {
    publish(c4)
    const { outputs, creates } = run(c4, { FORCE_BUILD: 'true' })
    expect(outputs.source).toBe('build')
    expect(creates).toEqual([])
  })
})
