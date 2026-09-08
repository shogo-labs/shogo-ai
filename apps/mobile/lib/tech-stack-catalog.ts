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
