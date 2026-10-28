// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { TechStackSummary } from './api'

/**
 * Built-in stack list for the native plus-sheet. The API can replace this
 * once `GET /api/tech-stacks` returns, but the accordion must never render
 * empty while that request is in flight or after it fails.
 */
export const FALLBACK_TECH_STACKS: TechStackSummary[] = [
  {
    id: 'react-app',
    name: 'React App',
    description: 'Vite + React + TypeScript + Tailwind + shadcn/ui',
    tags: ['react', 'vite'],
  },
  {
    id: 'expo-app',
    name: 'Expo (React Native)',
    description: 'Cross-platform mobile apps with Expo + TypeScript',
    tags: ['expo', 'react-native'],
  },
  {
    id: 'react-native',
    name: 'React Native (bare)',
    description: 'Bare React Native + TypeScript, no Expo',
    tags: ['react-native'],
  },
  {
    id: 'python-data',
    name: 'Python Data Science',
    description: 'Python, Jupyter, pandas, and plotting',
    tags: ['python', 'data'],
  },
  {
    id: 'video-editor',
    name: 'Video Editor',
    description: 'Programmatic video with Remotion — Player preview, MP4 renders',
    tags: ['video', 'remotion', 'mp4'],
  },
  {
    id: 'threejs-game',
    name: 'Three.js Game Builder',
    description: '3D browser games with Three.js and Vite',
    tags: ['threejs', 'games'],
  },
  {
    id: 'phaser-game',
    name: 'Phaser 2D Game Builder',
    description: '2D browser games with Phaser 3 and Vite',
    tags: ['phaser', 'games'],
  },
  {
    id: 'expo-three',
    name: 'Expo + Three.js',
    description: '3D mobile games with Expo and Three.js',
    tags: ['expo', 'threejs'],
  },
  {
    id: 'unity-game',
    name: 'Unity Game Builder',
    description: 'Games with Unity and C#',
    tags: ['unity'],
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'Bring your own framework — the preview runs your build (Astro, Eleventy, …)',
    tags: ['custom', 'static'],
  },
  {
    id: 'none',
    name: 'None',
    description: 'No preset — the agent picks tools and frameworks',
    tags: ['blank'],
  },
]

export function techStackDisplayName(
  id: string | undefined,
  stacks: TechStackSummary[] = FALLBACK_TECH_STACKS,
): string {
  if (!id) return 'Stack'
  return stacks.find((stack) => stack.id === id)?.name ?? 'Stack'
}

export function mergeTechStacks(
  fetched: TechStackSummary[] | undefined,
  fallback: TechStackSummary[] = FALLBACK_TECH_STACKS,
): TechStackSummary[] {
  return fetched && fetched.length > 0 ? fetched : fallback
}

/**
 * Last list `GET /api/tech-stacks` returned, shared by every picker on the
 * page. The stack chip is part of the builder's first frame, so it paints from
 * this (or the fallback catalog) and the request only refreshes labels.
 */
let cached: TechStackSummary[] | null = null
let request: Promise<TechStackSummary[]> | null = null

/** What a picker paints before the request answers, and if it never does. */
export function cachedTechStacks(): TechStackSummary[] {
  return cached ?? FALLBACK_TECH_STACKS
}

/**
 * One request per page: the toolbar chip and the plus-sheet's list mount
 * together, and a second visit must not refetch before showing the chip.
 * A failed request clears itself so the next mount can retry.
 */
export function loadTechStacks(
  fetch: () => Promise<TechStackSummary[]>,
): Promise<TechStackSummary[]> {
  if (!request) {
    request = fetch()
      .then((fetched) => {
        cached = mergeTechStacks(fetched)
        return cached
      })
      .catch((error) => {
        request = null
        console.error('[tech-stacks] Failed to fetch the catalog:', error)
        return cachedTechStacks()
      })
  }
  return request
}

/** Tests drop the cache so a run starts from the fallback again. */
export function resetTechStackCache(): void {
  cached = null
  request = null
}
