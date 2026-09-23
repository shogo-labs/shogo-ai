// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Build the desktop API entry with the local-mode define and assert that the
 * cloud dependency island is absent. This is intentionally a small, cheap
 * guardrail for `bundle-api.mjs`: a future static import of Stripe/S3/Redis
 * should fail review instead of silently returning to every desktop install.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = resolveRepoRoot()
const outputDir = mkdtempSync(join(tmpdir(), 'shogo-api-local-bundle-'))
const output = join(outputDir, 'api.js')
const externals = [
  '@prisma/client',
  'prisma',
  'prisma-adapter-bun-sqlite',
  'sqlite-vec',
  'typescript-language-server',
  'typescript',
  'pyright',
]

function resolveRepoRoot(): string {
  return new URL('..', import.meta.url).pathname.replace(/\/$/, '')
}

try {
  execFileSync(process.execPath, [
    'build',
    join(repoRoot, 'apps/api/src/entry.ts'),
    '--target',
    'bun',
    '--outfile',
    output,
    '--define',
    'process.env.SHOGO_LOCAL_MODE="true"',
    ...externals.flatMap((pkg) => ['--external', pkg]),
  ], { cwd: repoRoot, stdio: 'inherit' })

  if (!existsSync(output)) throw new Error(`bundle was not written: ${output}`)
  const source = readFileSync(output, 'utf8')
  const localComposer = readFileSync(join(repoRoot, 'apps/api/src/local-server.ts'), 'utf8')
  const forbidden = [
    'server-cloud-deps',
    '@aws-sdk/client-s3',
    'ioredis',
    "from 'stripe'",
    'from "stripe"',
    "from './routes/marketplace'",
    "from './routes/admin'",
    "from './routes/publish'",
    "from './lib/tunnel-redis'",
  ]
  const found = forbidden.filter((needle) => localComposer.includes(needle) || source.includes(needle))
  if (found.length > 0) {
    throw new Error(`local API composer/bundle still references cloud dependencies: ${found.join(', ')}`)
  }
  const bundleSize = statSync(output).size
  if (bundleSize > 18 * 1024 * 1024) {
    throw new Error(`local API bundle exceeds 18 MiB budget: ${Math.round(bundleSize / 1024)} KiB`)
  }

  console.log(`Local API bundle passed (${Math.round(bundleSize / 1024)} KiB)`)
} finally {
  rmSync(outputDir, { recursive: true, force: true })
}
