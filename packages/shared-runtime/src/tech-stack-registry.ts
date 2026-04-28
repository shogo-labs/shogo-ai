// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tech-Stack Registry
 * --------------------------------------------------------------------------
 * Single source of truth for "what kind of project is this?" answered at
 * runtime by the API and the agent-runtime.
 *
 * Why this exists: we used to do `techStackId.startsWith('expo')` to decide
 * whether a project was mobile. That heuristic broke the moment we added a
 * stack like `expo-cli-tools` (would falsely match) and would silently miss
 * a future stack like `react-native-bare` or `flutter` (would falsely not
 * match).
 *
 * The replacement is an explicit, typed map keyed by stack id, with a
 * `target` field that captures the platform the stack actually runs on.
 * `apps/api` reads it to size pods correctly; the agent-runtime mirrors
 * the same metadata in each stack's `stack.json` so the registry and the
 * stack files stay in sync.
 *
 * Adding a new stack:
 *   1. Add an entry below with `target: 'mobile' | 'web' | 'data' | 'native'`.
 *   2. Add the matching `target` field to the stack's `stack.json`.
 *   3. The runtime/API automatically pick up the new stack's class —
 *      no `if (id.startsWith(…))` to update.
 */

/**
 * Platform a stack ultimately runs on. Drives:
 *   - instance-size floors (mobile needs `small`+ for Metro/RN node_modules)
 *   - disk overlay (mobile needs ~6 GiB for node_modules + Metro caches)
 *   - runtime image variant (mobile uses the bun-cache pre-warmed image)
 *   - dev-server selection (mobile → Metro, web → Vite)
 */
export type StackTarget = 'mobile' | 'web' | 'data' | 'native' | 'none'

export interface StackRegistryEntry {
  id: string
  target: StackTarget
  /**
   * Whether this stack runs Metro/Expo bundler. Distinct from `target` —
   * a future `flutter` stack would be `target: 'mobile'` but `metro: false`.
   */
  metro?: boolean
  /**
   * Whether the agent-runtime's `seedTechStack(id)` is responsible for laying
   * down this stack's initial files. When `true`, apps/api skips copying the
   * bundled Vite template into the workspace and instead just creates an
   * empty directory; the agent-runtime fills it on first start. When `false`
   * (or omitted), the legacy bundled-template path is used.
   *
   * The default `react-app`/`threejs-game`/`phaser-game` stacks use the
   * bundled Vite template; everything else seeds itself.
   */
  seedsOwnTemplate?: boolean
}

/**
 * Canonical registry of every first-party tech stack we ship. Kept here in
 * code (not loaded from disk) because `apps/api` doesn't have the
 * `packages/agent-runtime/tech-stacks/` directory bundled into its
 * container image, so it can't `readFileSync` stack.json at runtime.
 *
 * The agent-runtime side validates these entries against the on-disk
 * stack.json files at boot — see `assertRegistryMatchesDisk()` in
 * `packages/agent-runtime/src/workspace-defaults.ts`.
 */
export const TECH_STACK_REGISTRY: Record<string, StackRegistryEntry> = {
  // Web (Vite-based) — share a bundled Vite template, so apps/api seeds them.
  'react-app': { id: 'react-app', target: 'web' },
  'threejs-game': { id: 'threejs-game', target: 'web' },
  'phaser-game': { id: 'phaser-game', target: 'web' },

  // Mobile (Metro/Expo) — agent-runtime owns the seed.
  'expo-app': { id: 'expo-app', target: 'mobile', metro: true, seedsOwnTemplate: true },
  'expo-three': { id: 'expo-three', target: 'mobile', metro: true, seedsOwnTemplate: true },
  'react-native': { id: 'react-native', target: 'mobile', metro: true, seedsOwnTemplate: true },

  // Data / scripting
  'python-data': { id: 'python-data', target: 'data', seedsOwnTemplate: true },

  // Native (full game engines)
  'unity-game': { id: 'unity-game', target: 'native', seedsOwnTemplate: true },

  // Bare / no-stack
  none: { id: 'none', target: 'none', seedsOwnTemplate: true },
}

/** Lookup an entry, returning `null` for unknown ids. */
export function getStackEntry(
  techStackId: string | null | undefined,
): StackRegistryEntry | null {
  if (!techStackId) return null
  return TECH_STACK_REGISTRY[techStackId] ?? null
}

/**
 * True for any stack whose `target` is `mobile`. Replaces the old
 * `techStackId.startsWith('expo') || techStackId === 'react-native'`
 * heuristic.
 */
export function isMobileTechStack(techStackId: string | null | undefined): boolean {
  return getStackEntry(techStackId)?.target === 'mobile'
}

/** True if the stack is bundled with Metro (Expo / RN). */
export function usesMetroBundler(techStackId: string | null | undefined): boolean {
  return getStackEntry(techStackId)?.metro === true
}

/**
 * True if the agent-runtime's `seedTechStack(id)` is responsible for laying
 * down this stack's initial files. apps/api uses this to decide whether to
 * skip copying the bundled Vite template into the workspace.
 *
 * Unknown stacks default to `false` (legacy bundled-template path) so that
 * adding a new stack doesn't accidentally break the default behaviour.
 */
export function stackSeedsItself(techStackId: string | null | undefined): boolean {
  return getStackEntry(techStackId)?.seedsOwnTemplate === true
}
