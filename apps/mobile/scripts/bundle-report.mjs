#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-package breakdown of the Expo web main chunk, plus a size budget.
 *
 *   node apps/mobile/scripts/bundle-report.mjs
 *   node apps/mobile/scripts/bundle-report.mjs --allow-missing
 *
 * Release workflows run this after `bun run web:build`. `--allow-missing`
 * is for checkouts that have not exported the web bundle yet.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_DIR = path.join(__dirname, '..', 'dist', '_expo', 'static', 'js', 'web')

/** Largest `index-*.js` ceiling. After async routes the entry is ~1.12 MB. */
export const MAIN_CHUNK_BUDGET_BYTES = 2_500_000
/** Shared `__common-*.js` loaded with the entry. Measured at ~10.3 MB after lazy imports. */
export const COMMON_CHUNK_BUDGET_BYTES = 12_000_000

export function packageKey(source) {
  const marker = 'node_modules/'
  const at = source.lastIndexOf(marker)
  if (at >= 0) {
    const rest = source.slice(at + marker.length).split('/')
    return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]
  }
  const mobile = source.split('apps/mobile/')[1]
  if (mobile) return `app:${mobile.split('/').slice(0, 2).join('/')}`
  return 'other'
}

export function breakdown(map) {
  const totals = new Map()
  const sources = map.sources || []
  const contents = map.sourcesContent || []
  sources.forEach((source, index) => {
    const key = packageKey(source)
    totals.set(key, (totals.get(key) || 0) + (contents[index] || '').length)
  })
  return [...totals.entries()].sort((a, b) => b[1] - a[1])
}

export function findLargest(webDir, pattern) {
  const files = readdirSync(webDir).filter((name) => pattern.test(name) && !name.endsWith('.map'))
  if (!files.length) return null
  files.sort((a, b) => statSync(path.join(webDir, b)).size - statSync(path.join(webDir, a)).size)
  return files[0]
}

export function findMainChunk(webDir) {
  return findLargest(webDir, /^index-.*\.js$/)
}

function main() {
  const allowMissing = process.argv.includes('--allow-missing')
  let mainFile
  try {
    mainFile = findMainChunk(WEB_DIR)
  } catch {
    if (allowMissing) {
      console.log('bundle-report: no web export, skipping')
      return
    }
    console.error(`bundle-report: missing ${WEB_DIR}`)
    process.exit(1)
  }
  if (!mainFile) {
    if (allowMissing) {
      console.log('bundle-report: no web export, skipping')
      return
    }
    console.error('bundle-report: no index-*.js in the web export')
    process.exit(1)
  }
  const checks = [
    [mainFile, MAIN_CHUNK_BUDGET_BYTES],
    [findLargest(WEB_DIR, /^__common-.*\.js$/), COMMON_CHUNK_BUDGET_BYTES],
  ]
  for (const [file, budget] of checks) {
    if (!file) continue
    const jsPath = path.join(WEB_DIR, file)
    const bytes = statSync(jsPath).size
    console.log(`${file}: ${(bytes / 1e6).toFixed(2)} MB (budget ${(budget / 1e6).toFixed(2)} MB)`)
    try {
      const map = JSON.parse(readFileSync(`${jsPath}.map`, 'utf8'))
      for (const [key, size] of breakdown(map).slice(0, 8)) {
        console.log(`${(size / 1e6).toFixed(2).padStart(6)} MB  ${key}`)
      }
    } catch {
      console.log('bundle-report: source map missing, size check only')
    }
    if (bytes > budget) {
      console.error(`bundle-report: ${file} is ${bytes} bytes, over ${budget}`)
      process.exit(1)
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
