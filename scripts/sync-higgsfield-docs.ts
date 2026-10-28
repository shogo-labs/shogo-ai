// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Refresh the committed Higgsfield docs snapshot, then re-derive the catalog.
 *
 * This is the only script here that touches the network. It writes the snapshot
 * when run by hand after the vendor ships a change; `--check` runs weekly from
 * `.github/workflows/higgsfield-docs-drift.yml` and fails instead of writing
 * when the snapshot has drifted. `check:higgsfield-docs` is the offline gate
 * that fails when the snapshot and our code disagree.
 *
 * Usage:
 *   bun run sync:higgsfield-docs              # fetch and write the snapshot
 *   bun run sync:higgsfield-docs --dry-run    # fetch and diff, write nothing
 *   bun run sync:higgsfield-docs --check      # as --dry-run, exit 1 on drift
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
const CHECK = process.argv.includes('--check')

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

/** Print one file's result; true when the committed copy differs from the vendor's. */
function report(name: string, before: string | null, after: string): boolean {
  const changed = before !== after
  const hash = sha256(after)
  if (!changed) {
    console.log(`  ${name}: unchanged (sha256 ${hash})`)
    return false
  }
  if (CHECK) {
    console.log(`  ${name}: ${before ? 'differs from' : 'missing from'} the committed snapshot (vendor sha256 ${hash})`)
    return true
  }
  const beforeLines = before ? before.split('\n').length : 0
  const afterLines = after.split('\n').length
  console.log(`  ${name}: ${before ? 'updated' : 'added'} — ${beforeLines} → ${afterLines} lines (sha256 ${hash})`)
  return true
}

const llmsPath = join(DOCS_DIR, 'llms-full.txt')

console.log(`Fetching the Higgsfield docs snapshot${CHECK ? ' (check)' : DRY_RUN ? ' (dry run)' : ''}…`)

const llmsFull = await download(SOURCE_URL)

const previousLlms = current(llmsPath)
const llmsDrifted = report('llms-full.txt', previousLlms, llmsFull)

// Derive from the text we just fetched, not the file on disk, so a dry run or a
// check still shows what the catalog would become.
const catalog = renderCatalog(deriveCatalog(llmsFull))
const previousCatalog = current(CATALOG_PATH)
const catalogDrifted = report('catalog.json', previousCatalog, catalog)

const endpointCount = Object.keys(JSON.parse(catalog).endpoints).length
console.log(`\n${endpointCount} documented endpoints.`)

if (CHECK) {
  const drifted = [llmsDrifted && 'llms-full.txt', catalogDrifted && 'catalog.json'].filter(Boolean)
  if (drifted.length > 0) {
    console.error(`\n❌ the committed snapshot has drifted — stale: ${drifted.join(', ')}.`)
    console.error('   Run `bun run sync:higgsfield-docs` to update it, then update the sha256 table in docs/vendors/higgsfield/MANIFEST.md.')
    process.exit(1)
  }
  console.log('\nsnapshot is current.')
  process.exit(0)
}

if (DRY_RUN) {
  console.log('\nDry run: nothing written. Re-run without --dry-run to update the snapshot.')
  process.exit(0)
}

writeFileSync(llmsPath, llmsFull)
writeFileSync(CATALOG_PATH, catalog)

console.log(`
Wrote the snapshot. Now:
  1. Update the sha256 table in docs/vendors/higgsfield/MANIFEST.md with the hashes above.
  2. bun run check:higgsfield-docs   # names every model or parameter that drifted
`)
