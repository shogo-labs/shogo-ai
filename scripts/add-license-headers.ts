// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Adds license headers to all TypeScript/TSX source files in the repository.
 *
 * - AGPL-3.0 header for core packages
 * - Apache-2.0 header for SDK and templates
 *
 * Usage: bun scripts/add-license-headers.ts [--check]
 *   --check  Only report files missing headers (no modifications)
 */

import { readdir, readFile, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"

const ROOT = join(import.meta.dir, "..")
const COPYRIGHT_LINE = "// Copyright (C) 2026 Shogo Technologies, Inc."
const OLD_COPYRIGHT_PATTERNS = [
  /\/\/ Copyright \(C\) 2024-present Shogo AI, Inc\.\n?/,
  /\/\/ Copyright \(C\) 2024-present Shogo AI\n?/,
  /\/\/ Copyright \(C\) 2026 Shogo AI, Inc\.\n?/,
]

const AGPL_HEADER = `// SPDX-License-Identifier: AGPL-3.0-or-later
${COPYRIGHT_LINE}
`

const APACHE_HEADER = `// SPDX-License-Identifier: Apache-2.0
${COPYRIGHT_LINE}
`

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".next",
  ".expo",
  ".bun",
  "android",
  "ios",
  "build",
  ".git",
])

const EXTENSIONS = new Set([".ts", ".tsx"])

function isApachePath(filePath: string): boolean {
  const rel = relative(ROOT, filePath)
  return (
    rel.startsWith("packages/sdk/") ||
    rel.startsWith("templates/runtime-template/")
  )
}

function isDocPath(filePath: string): boolean {
  const rel = relative(ROOT, filePath)
  return rel.startsWith("apps/docs/")
}

function hasLicenseHeader(content: string): boolean {
  const firstLines = content.slice(0, 200)
  return (
    firstLines.includes("SPDX-License-Identifier") ||
    firstLines.includes("Copyright (C)") ||
    firstLines.includes("@license")
  )
}

function normalizeExistingHeader(content: string): string {
  let next = content
  for (const pattern of OLD_COPYRIGHT_PATTERNS) {
    next = next.replace(pattern, `${COPYRIGHT_LINE}\n`)
  }
  return next
}

async function* walkDir(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkDir(fullPath)
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf("."))
      if (EXTENSIONS.has(ext)) {
        yield fullPath
      }
    }
  }
}

async function main() {
  const checkOnly = process.argv.includes("--check")
  let added = 0
  let skipped = 0
  let missing: string[] = []

  for await (const filePath of walkDir(ROOT)) {
    if (isDocPath(filePath)) {
      skipped++
      continue
    }

    const content = await readFile(filePath, "utf-8")

    const normalized = normalizeExistingHeader(content)
    const header = isApachePath(filePath) ? APACHE_HEADER : AGPL_HEADER

    if (checkOnly) {
      if (!hasLicenseHeader(normalized)) {
        missing.push(relative(ROOT, filePath))
      }
    } else {
      if (hasLicenseHeader(normalized)) {
        if (normalized !== content) {
          await writeFile(filePath, normalized)
          added++
        } else {
          skipped++
        }
      } else {
        await writeFile(filePath, header + normalized)
        added++
      }
    }
  }

  if (checkOnly) {
    if (missing.length > 0) {
      console.log(`${missing.length} files missing license headers:`)
      missing.forEach((f) => console.log(`  ${f}`))
      process.exit(1)
    } else {
      console.log("All files have license headers.")
    }
  } else {
    console.log(`Done. Added headers to ${added} files. Skipped ${skipped}.`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
