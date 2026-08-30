// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Infer a first-party tech-stack id from an imported .shogo bundle.
 *
 * `settings.techStackId` is the UI/runtime source of truth, but older
 * bundles (and ports that never went through the stack picker) ship
 * without it and without a workspace `.tech-stack` marker. Import then
 * creates a project whose picker shows "None" and whose runtime falls
 * back to Vite/`react-app` — even when the workspace is clearly Expo.
 *
 * Preference order:
 *   1. `settings.techStackId` when it names a known registry entry
 *   2. workspace `.tech-stack` marker
 *   3. workspace files (`package.json`, `app.json`, …)
 *
 * Unknown / unconfident workspaces return `undefined` rather than
 * guessing `react-app`.
 */

/** Keep in sync with `TECH_STACK_REGISTRY` in packages/core. */
const KNOWN_STACK_IDS = new Set([
  'react-app',
  'threejs-game',
  'phaser-game',
  'expo-app',
  'expo-three',
  'react-native',
  'python-data',
  'unity-game',
  'none',
])

export type WorkspaceFileMap = Record<string, Uint8Array | string>

export function isKnownTechStackId(id: string | null | undefined): boolean {
  if (!id) return false
  return KNOWN_STACK_IDS.has(id.trim())
}

function asText(data: Uint8Array | string): string {
  return typeof data === 'string' ? data : new TextDecoder().decode(data)
}

function fileText(files: WorkspaceFileMap, relPath: string): string | null {
  const normalised = relPath.replace(/\\/g, '/')
  const direct = files[normalised] ?? files[`workspace/${normalised}`]
  if (direct != null) return asText(direct)
  return null
}

function knownId(id: string | null | undefined): string | undefined {
  if (!id) return undefined
  const trimmed = id.trim()
  return KNOWN_STACK_IDS.has(trimmed) ? trimmed : undefined
}

function packageDeps(files: WorkspaceFileMap): Set<string> {
  const raw = fileText(files, 'package.json')
  if (!raw) return new Set()
  try {
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ])
  } catch {
    return new Set()
  }
}

function hasExpoAppConfig(files: WorkspaceFileMap): boolean {
  if (fileText(files, 'app.config.js') || fileText(files, 'app.config.ts')) return true
  const appJson = fileText(files, 'app.json')
  if (!appJson) return false
  try {
    const parsed = JSON.parse(appJson) as { expo?: unknown }
    return parsed != null && typeof parsed === 'object' && parsed.expo != null
  } catch {
    return false
  }
}

function inferFromWorkspaceFiles(files: WorkspaceFileMap): string | undefined {
  const deps = packageDeps(files)
  const has = (name: string) => deps.has(name)
  const expoish = has('expo') || has('expo-router') || hasExpoAppConfig(files)
  const threeish =
    has('three') || has('@react-three/fiber') || has('expo-gl') || has('expo-three')

  if (expoish) return threeish ? 'expo-three' : 'expo-app'
  if (has('react-native')) return 'react-native'
  if (has('phaser')) return 'phaser-game'
  if (threeish) return 'threejs-game'

  if (
    fileText(files, 'requirements.txt') ||
    fileText(files, 'pyproject.toml') ||
    fileText(files, 'Pipfile')
  ) {
    return 'python-data'
  }

  if (fileText(files, 'ProjectSettings/ProjectVersion.txt')) return 'unity-game'

  return undefined
}

export function inferTechStackId(opts: {
  settingsTechStackId?: unknown
  files: WorkspaceFileMap
}): string | undefined {
  const fromSettings =
    typeof opts.settingsTechStackId === 'string'
      ? knownId(opts.settingsTechStackId)
      : undefined
  if (fromSettings) return fromSettings

  const fromMarker = knownId(fileText(opts.files, '.tech-stack'))
  if (fromMarker) return fromMarker

  return inferFromWorkspaceFiles(opts.files)
}
