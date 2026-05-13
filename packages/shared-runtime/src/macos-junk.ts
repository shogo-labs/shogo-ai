// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

// Filter for macOS-specific filesystem detritus that must never round-trip
// through a project export. The motivating bug: AppleDouble sidecars (`._foo.ts`,
// `._\_layout.tsx`) are binary resource-fork blobs but share the source-file
// extension. When an imported workspace contains them, Metro's Babel parser
// tries to parse `._\_layout.tsx` as TypeScript and crashes the bundler.
//
// Used by every export path (S3Sync tar, /download tar, .shogo-project ZIP,
// agent-runtime workspace bundle) and by the post-extract scrubber so legacy
// archives already in S3 also get cleaned on import.

const MACOS_JUNK_BASENAMES = new Set([
  '.DS_Store',
  '.AppleDouble',
  '.LSOverride',
  '.Spotlight-V100',
  '.Trashes',
  '.fseventsd',
  '.TemporaryItems',
  '.VolumeIcon.icns',
  '.com.apple.timemachine.donotpresent',
  '__MACOSX',
])

// Finder's custom-icon file is literally named "Icon" followed by a CR.
const ICON_CR = 'Icon\r'

export function isMacOSJunkName(name: string): boolean {
  if (!name) return false
  if (name.startsWith('._')) return true
  if (MACOS_JUNK_BASENAMES.has(name)) return true
  if (name === ICON_CR) return true
  return false
}

export function isMacOSJunkPath(relPath: string): boolean {
  if (!relPath) return false
  return relPath.split('/').some(isMacOSJunkName)
}
