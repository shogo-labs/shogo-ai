// SPDX-License-Identifier: MIT
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
 *
 * Lifted into the SDK from `@shogo/shared-runtime` (was AGPL) under MIT.
 * The original `@shogo/shared-runtime/tech-stack-registry` re-exports this
 * module unchanged for backwards compatibility.
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
  /**
   * Metal VM class this stack requires. Mirrors `TechStackMeta.runtime.vmClass`
   * (see `packages/agent-runtime/src/workspace-defaults.ts`) so `apps/api` —
   * which does not bundle `tech-stacks/` and cannot read `stack.json` at
   * runtime — can decide placement/gating without it. Omitted = `'standard'`,
   * the default every non-Docker stack uses.
   */
  vmClass?: 'standard' | 'docker'
  /**
   * Smallest instance size (`apps/api/src/config/instance-sizes.ts`
   * `InstanceSizeName`) this stack should be billed/provisioned at. Mirrors
   * `TechStackMeta.runtime.minimumInstanceSize`. Unlike the mobile floor
   * (`applyTechStackFloor`), this floor is BILLED, not just a free headroom
   * bump — see `applyDockerStackFloor`.
   */
  minimumInstanceSize?: 'micro' | 'small' | 'medium' | 'large' | 'xlarge'
  /**
   * Ports the stack's services expose, mirroring
   * `TechStackMeta.runtime.ports` (see `workspace-defaults.ts`) for the same
   * reason `vmClass`/`minimumInstanceSize` are mirrored: apps/api can't read
   * `stack.json` at runtime, but needs this to validate `PATCH .../ports/:port`
   * (a project can only toggle visibility on a port its stack actually
   * declares — never an arbitrary guest port) and to seed
   * `Project.settings.exposedPorts` defaults.
   */
  ports?: Array<{
    port: number
    label?: string
    protocol: 'http' | 'tcp'
    defaultVisibility: 'tunnel' | 'preview'
  }>
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

  // Multi-service backend (dockerd + docker compose). Requires the
  // Docker-capable metal VM class; gated separately by
  // `runtime.docker_class_enabled` (see apps/api/src/lib/runtime-class-setting.ts).
  'docker-compose': {
    id: 'docker-compose',
    target: 'data',
    seedsOwnTemplate: true,
    vmClass: 'docker',
    minimumInstanceSize: 'large',
    ports: [
      { port: 8000, label: 'app', protocol: 'http', defaultVisibility: 'preview' },
      { port: 5432, label: 'postgres', protocol: 'tcp', defaultVisibility: 'tunnel' },
    ],
  },

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

/**
 * True for any stack whose `vmClass` is `'docker'` — i.e. it needs the
 * Docker-capable metal VM class (dockerd + a persistent data volume), not
 * the default standard project VM. Callers must still check the platform
 * gate (`runtime.docker_class_enabled`) before honouring this.
 */
export function isDockerTechStack(techStackId: string | null | undefined): boolean {
  return getStackEntry(techStackId)?.vmClass === 'docker'
}

/** The stack's declared minimum instance size, or `null` if it doesn't set one. */
export function getMinimumInstanceSize(
  techStackId: string | null | undefined,
): StackRegistryEntry['minimumInstanceSize'] | null {
  return getStackEntry(techStackId)?.minimumInstanceSize ?? null
}

/**
 * The stack's declared ports (empty array if it declares none). This is the
 * ONLY allowlist for both the client-side tunnel and the public per-port
 * preview — a project can toggle visibility on a declared port, but can
 * never expose a port its stack doesn't list.
 */
export function getDeclaredPorts(techStackId: string | null | undefined): StackRegistryEntry['ports'] {
  return getStackEntry(techStackId)?.ports ?? []
}
