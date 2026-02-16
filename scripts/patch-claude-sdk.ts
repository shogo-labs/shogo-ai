#!/usr/bin/env bun
/**
 * Patches the @anthropic-ai/claude-agent-sdk V2 Session constructor to fix
 * hardcoded options that prevent streaming (includePartialMessages) and
 * other session configuration from being passed through.
 *
 * Bug: The V2 unstable_v2_createSession() constructor hardcodes several Transport
 * options instead of reading them from the user-provided session options (X).
 * This prevents `includePartialMessages: true` from being passed to the CLI,
 * which means the SDK never emits `stream_event` messages for incremental streaming.
 *
 * Run this after `bun install` via the postinstall script in package.json.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')

// Find all installed copies of the SDK
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

  // Search in all node_modules directories
  walk(join(dir, 'node_modules'))
  walk(join(dir, 'apps/api/node_modules'))
  walk(join(dir, 'packages/project-runtime/node_modules'))

  return results
}

// The exact string to find and replace in the V2 Session constructor
const FIND = 'includePartialMessages:!1'
const REPLACE = 'includePartialMessages:X.includePartialMessages??!1'

// Additional patches for other hardcoded options we use
const PATCHES = [
  // Core fix: enable streaming
  { find: 'includePartialMessages:!1', replace: 'includePartialMessages:X.includePartialMessages??!1' },
  // Pass through settingSources (we use ['project', 'local'])
  { find: 'settingSources:[]', replace: 'settingSources:X.settingSources??[]' },
  // Pass through allowDangerouslySkipPermissions
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
      // Only patch within the V9 (Session) constructor context
      // Verify this is the Session class context by checking surrounding code
      const idx = code.indexOf(patch.find)
      const context = code.substring(Math.max(0, idx - 200), idx + 200)
      if (context.includes('class V9') || context.includes('mcpServers:{}') || context.includes('canUseTool:!!X.canUseTool')) {
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
