#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Fails the build if any bundled native binary does NOT contain the target
// CPU architecture. This is a build-time guard against the v1.8.14 class of
// bug: macOS x64 builds are cross-compiled on arm64 CI runners, so
// `bun install` / `npm install` resolve native, arch-specific dependencies
// (e.g. `@prisma/engines`'s `schema-engine-*`, sqlite-vec, node-pty,
// playwright shells) for the *host* arch. electron-forge then happily packages
// those arm64 binaries into the x64 `.app`. Packaging "succeeds", and the bug
// only surfaces when an Intel user launches the app and the wrong-arch binary
// can't be loaded/executed — which bricked first launch with
// "PRISMA_SCHEMA_ENGINE_BINARY ... can't be resolved".
//
// We detect Mach-O files cheaply by magic number (no process spawn per file)
// and then ask `lipo -archs` for the slices each one actually contains. A file
// is a violation if the target arch is missing. Universal binaries (both
// slices) pass for either target.
//
// Usage:
//   node check-native-arch.mjs --arch <x64|arm64> [rootPath]
//
// `rootPath` defaults to the packaged `.app` for the given arch under `out/`.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

function parseArgs(argv) {
  let arch = null
  let root = null
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--arch') {
      arch = argv[++i]
    } else if (a.startsWith('--arch=')) {
      arch = a.slice('--arch='.length)
    } else if (!a.startsWith('-')) {
      root = a
    }
  }
  return { arch, root }
}

// Mach-O / fat magic numbers, matched on the first 4 bytes regardless of
// endianness so we never spawn `lipo` on a non-Mach-O file.
const MACHO_MAGICS = new Set([
  0xfeedface, // MH_MAGIC (32-bit)
  0xfeedfacf, // MH_MAGIC_64
  0xcefaedfe, // MH_CIGAM (byte-swapped 32-bit)
  0xcffaedfe, // MH_CIGAM_64
  0xcafebabe, // FAT_MAGIC (universal)
  0xbebafeca, // FAT_CIGAM
])

function isMachO(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(4)
    const read = fs.readSync(fd, buf, 0, 4, 0)
    if (read < 4) return false
    return MACHO_MAGICS.has(buf.readUInt32BE(0)) || MACHO_MAGICS.has(buf.readUInt32LE(0))
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function archsOf(file) {
  // `lipo -archs` prints space-separated slice names, e.g. "x86_64 arm64".
  const out = execFileSync('lipo', ['-archs', file], { encoding: 'utf-8' })
  return out.trim().split(/\s+/).filter(Boolean)
}

function* walk(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

function main() {
  const { arch, root: rootArg } = parseArgs(process.argv)
  if (arch !== 'x64' && arch !== 'arm64') {
    console.error('[check-native-arch] ERROR: --arch must be "x64" or "arm64"')
    process.exit(2)
  }

  // Map Node's arch naming to the Mach-O slice name `lipo` reports.
  const wantSlice = arch === 'x64' ? 'x86_64' : 'arm64'

  const root = rootArg
    ? path.resolve(rootArg)
    : path.resolve(`out/Shogo-darwin-${arch}/Shogo.app`)

  if (!fs.existsSync(root)) {
    console.error(`[check-native-arch] ERROR: scan root does not exist: ${root}`)
    process.exit(2)
  }

  // Arch tokens as they appear in *paths* (dir/package names), not slice names.
  const targetTok = arch === 'x64' ? 'x64' : 'arm64'
  const otherTok = arch === 'x64' ? 'arm64' : 'x64'

  console.log(`[check-native-arch] Scanning ${root}`)
  console.log(`[check-native-arch] Target arch: ${arch} (expecting Mach-O slice "${wantSlice}")`)

  // Pass 1: inventory every Mach-O file and the slices it actually contains.
  const inventory = []
  let machoCount = 0
  let skipped = 0
  for (const file of walk(root)) {
    if (!isMachO(file)) continue
    machoCount++
    let archs
    try {
      archs = archsOf(file)
    } catch (err) {
      // `lipo` couldn't read it (rare); record so it isn't silently ignored.
      skipped++
      console.warn(`[check-native-arch] WARN: lipo failed for ${file}: ${err.message}`)
      continue
    }
    inventory.push({ rel: path.relative(root, file), archs })
  }

  // Set of relative paths that DO contain the target slice — used to detect
  // whether a wrong-arch file's correct-arch sibling ships alongside it.
  const targetOk = new Set(inventory.filter((e) => e.archs.includes(wantSlice)).map((e) => e.rel))

  // Some bundled native binaries legitimately lack the target slice and are
  // still safe to ship. We never want to silently ignore a genuine v1.8.14
  // mismatch, so each exemption is narrow and explained.
  function benignReason(rel) {
    // (1) Multi-arch packages ship a per-arch artifact for EVERY arch and pick
    //     the right one at runtime by process.arch (e.g. node-pty's
    //     prebuilds/darwin-<arch>/, or the sqlite-vec-darwin-<arch> optional
    //     deps). The wrong-arch member is dead weight as long as the
    //     target-arch member is present. Find the sibling by swapping the arch
    //     token in the path and confirming it carries the target slice.
    if (rel.includes(otherTok)) {
      const sibling = rel.split(otherTok).join(targetTok)
      if (sibling !== rel && targetOk.has(sibling)) {
        return `target-arch sibling present (${sibling})`
      }
    }
    // (2) Prisma's NATIVE schema engine is unused: desktop runs migrations via
    //     the architecture-independent WASM schema engine (the v1.8.14 fix in
    //     local-server.ts), so this binary is never loaded/executed.
    if (/@prisma\/engines\/schema-engine-/.test(rel)) {
      return 'unused native Prisma schema engine (desktop uses the WASM engine)'
    }
    return null
  }

  const violations = []
  const exempted = []
  for (const e of inventory) {
    if (e.archs.includes(wantSlice)) continue
    const reason = benignReason(e.rel)
    if (reason) exempted.push({ ...e, reason })
    else violations.push(e)
  }

  console.log(`[check-native-arch] Inspected ${machoCount} Mach-O file(s); ${skipped} unreadable.`)
  if (exempted.length > 0) {
    console.log(`[check-native-arch] ${exempted.length} wrong-arch file(s) exempted as benign:`)
    for (const e of exempted) {
      console.log(`  • ${e.rel}  (has: ${e.archs.join(', ') || 'none'}) — ${e.reason}`)
    }
  }

  if (violations.length > 0) {
    console.error('')
    console.error(`[check-native-arch] FAIL — ${violations.length} bundled binary(ies) are missing the "${wantSlice}" slice for the ${arch} build:`)
    for (const v of violations) {
      console.error(`  - ${v.rel}  (has: ${v.archs.join(', ') || 'none'})`)
    }
    console.error('')
    console.error('  This is the v1.8.14 failure mode: a host-arch native binary was bundled')
    console.error('  into a cross-compiled build. Ensure the dependency that owns each file')
    console.error('  ships the target arch (e.g. install the matching-arch artifact — for')
    console.error('  optional-dep packages pass `npm install --cpu=<arch> --os=darwin`).')
    process.exit(1)
  }

  console.log(`[check-native-arch] OK — every loaded native binary provides the ${wantSlice} slice (${exempted.length} benign wrong-arch file(s) ignored).`)
}

main()
