// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//!/usr/bin/env bun
/**
 * Patches the @anthropic-ai/claude-agent-sdk V2 Session constructor.
 *
 * As of v0.2.76, `settingSources` and `mcpServers` are fixed upstream.
 * Two patches remain until they're addressed in the SDK:
 *
 *   1. includePartialMessages — hardcoded to false, prevents streaming
 *   2. allowDangerouslySkipPermissions — hardcoded to false
 *
 * Run this after `bun install` via the postinstall script in package.json.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')

function findSdkFiles(dir: string): string[] {
  const results: string[] = []

  function walk(d: string) {
    try {
      const entries = readdirSync(d)
      for (const entry of entries) {
        const full = join(d, entry)
        try {
          const s = statSync(full)
          if (s.isDirectory()) {
            if (entry === '@anthropic-ai' || entry.startsWith('@anthropic-ai+claude-agent-sdk')) {
              walk(full)
            } else if (entry === 'claude-agent-sdk') {
              const sdkFile = join(full, 'sdk.mjs')
              try {
                statSync(sdkFile)
                results.push(sdkFile)
              } catch {}
            } else if (entry === 'node_modules' || entry === '.bun') {
              walk(full)
            }
          }
        } catch {}
      }
    } catch {}
  }

  walk(join(dir, 'node_modules'))
  walk(join(dir, 'apps/api/node_modules'))
  walk(join(dir, 'packages/project-runtime/node_modules'))

  return results
}

const PATCHES = [
  { find: 'includePartialMessages:!1', replace: 'includePartialMessages:X.includePartialMessages??!1' },
  { find: 'allowDangerouslySkipPermissions:!1', replace: 'allowDangerouslySkipPermissions:X.allowDangerouslySkipPermissions??!1' },
]

const sdkFiles = findSdkFiles(ROOT)

if (sdkFiles.length === 0) {
  console.error('❌ No @anthropic-ai/claude-agent-sdk sdk.mjs files found')
  process.exit(1)
}

let patchedCount = 0
for (const file of sdkFiles) {
  let code = readFileSync(file, 'utf-8')
  let modified = false

  for (const patch of PATCHES) {
    if (code.includes(patch.find)) {
      const idx = code.indexOf(patch.find)
      const context = code.substring(Math.max(0, idx - 300), idx + 300)
      // Verify we're in the Session constructor context (minified class names vary by version)
      if (context.includes('canUseTool') || context.includes('mcpServers') || context.includes('settingSources')) {
        code = code.replace(patch.find, patch.replace)
        console.log(`  ✅ Patched: ${patch.find} → ${patch.replace}`)
        modified = true
      }
    } else if (code.includes(patch.replace)) {
      console.log(`  ⏭️  Already patched: ${patch.find}`)
    } else {
      console.log(`  ⚠️  Pattern not found: ${patch.find}`)
    }
  }

  if (modified) {
    writeFileSync(file, code)
    patchedCount++
    console.log(`📝 Patched: ${file}`)
  } else {
    console.log(`⏭️  No changes needed: ${file}`)
  }
}

console.log(`\n✅ Done: ${patchedCount}/${sdkFiles.length} files patched`)
