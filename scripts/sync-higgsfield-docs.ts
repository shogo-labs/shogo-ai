// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Refresh the committed Higgsfield docs snapshot, then re-derive the catalog.
 *
 * This is the only script here that touches the network — it runs by hand when
 * the vendor ships a change, never in CI. `check:higgsfield-docs` is the
 * offline gate that fails when the snapshot and the code disagree.
 *
 * Usage:
 *   bun run sync:higgsfield-docs
 *   bun run sync:higgsfield-docs --dry-run   # fetch and diff, write nothing
 *
 * Afterwards, update the sha256 table in `docs/vendors/higgsfield/MANIFEST.md`
 * with the hashes this prints, then run `bun run check:higgsfield-docs`.
 */

import { createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { CATALOG_PATH, SOURCE_URL, deriveCatalog, renderCatalog } from './derive-higgsfield-catalog'

const REPO_ROOT = resolve(import.meta.dir, '..')
const DOCS_DIR = join(REPO_ROOT, 'docs/vendors/higgsfield')
const DRY_RUN = process.argv.includes('--dry-run')

const OPENAPI_URL = 'https://docs.higgsfield.ai/docs/openapi.json'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

async function download(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`${url} → ${response.status} ${response.statusText}`)
  return response.text()
}

function current(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function report(name: string, before: string | null, after: string) {
  const changed = before !== after
  const hash = sha256(after)
  if (!changed) {
    console.log(`  ${name}: unchanged (sha256 ${hash})`)
    return
  }
  const beforeLines = before ? before.split('\n').length : 0
  const afterLines = after.split('\n').length
  console.log(`  ${name}: ${before ? 'updated' : 'added'} — ${beforeLines} → ${afterLines} lines (sha256 ${hash})`)
}

const llmsPath = join(DOCS_DIR, 'llms-full.txt')
const openapiPath = join(DOCS_DIR, 'openapi.json')

console.log(`Fetching the Higgsfield docs snapshot${DRY_RUN ? ' (dry run)' : ''}…`)

const [llmsFull, openapi] = await Promise.all([download(SOURCE_URL), download(OPENAPI_URL)])

const previousLlms = current(llmsPath)
const previousOpenapi = current(openapiPath)
report('llms-full.txt', previousLlms, llmsFull)
report('openapi.json', previousOpenapi, openapi)

// Derive from the text we just fetched, not the file on disk, so a dry run
// still shows what the catalog would become.
const catalog = renderCatalog(deriveCatalog(llmsFull))
const previousCatalog = current(CATALOG_PATH)
report('catalog.json', previousCatalog, catalog)

const endpointCount = Object.keys(JSON.parse(catalog).endpoints).length
console.log(`\n${endpointCount} documented endpoints.`)

if (DRY_RUN) {
  console.log('\nDry run: nothing written. Re-run without --dry-run to update the snapshot.')
  process.exit(0)
}

writeFileSync(llmsPath, llmsFull)
writeFileSync(openapiPath, openapi)
writeFileSync(CATALOG_PATH, catalog)

console.log(`
Wrote the snapshot. Now:
  1. Update the sha256 table in docs/vendors/higgsfield/MANIFEST.md with the hashes above.
  2. bun run check:higgsfield-docs   # names every model or parameter that drifted
`)
