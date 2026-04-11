// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace Parity Evals — validate that the canvas environment is fully
 * functional across execution modes (local, VM, Docker/K8s).
 *
 * These evals require `useRuntimeTemplate: true` so the workspace is seeded
 * with the full Vite + React + Tailwind + shadcn/ui template. They exercise
 * basic operations that should work identically regardless of where the
 * agent-runtime is running:
 *
 * - Lint checking (read_lints returns meaningful results, not "no Vite setup")
 * - File read/write in src/
 * - Workspace tree visibility (the agent can see package.json, vite.config, etc.)
 *
 * Run with: --track workspace-parity
 * Cross-mode: --track workspace-parity --local / --vm
 */

import type { AgentEval, EvalResult } from './types'
import { usedTool } from './eval-helpers'

// ---------------------------------------------------------------------------
// Shared config — canvas code mode
// ---------------------------------------------------------------------------

const V2_CONFIG = JSON.stringify({
  heartbeatInterval: 1800,
  heartbeatEnabled: false,
  channels: [],
  activeMode: 'canvas',
  canvasMode: 'code',
  model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
}, null, 2)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCodeFile(path: string): boolean {
  return /^src\/.*\.(tsx?|jsx?)$/.test(path)
}

function agentReadFile(r: EvalResult, namePattern: RegExp): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'read_file') return false
    const path = String((t.input as any).path ?? '')
    return namePattern.test(path)
  })
}

function agentUsedLints(r: EvalResult): boolean {
  return r.toolCalls.some(t => t.name === 'read_lints')
}

function agentDidNotClaimNoVite(r: EvalResult): boolean {
  const lower = r.responseText.toLowerCase()
  return !lower.includes("doesn't have a") &&
         !lower.includes('no vite') &&
         !lower.includes('not set up') &&
         !lower.includes('no pre-existing')
}

function agentWroteCodeFile(r: EvalResult): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file' && t.name !== 'edit_file') return false
    const path = String((t.input as any).path ?? '')
    return isCodeFile(path)
  })
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const WORKSPACE_PARITY_EVALS: AgentEval[] = [
  {
    id: 'parity-template-readiness',
    name: 'Workspace Parity: Template files + deps present',
    category: 'canvas-v2',
    level: 0,
    useRuntimeTemplate: true,
    input: 'Check if the project is set up correctly. Run `read_lints` and tell me the tech stack.',
    workspaceFiles: {
      'config.json': V2_CONFIG,
    },
    validationCriteria: [
      {
        id: 'vite-build-ready',
        description: 'Runtime check: ViteBuildReadiness reports ready',
        points: 5,
        phase: 'runtime',
        validate: (r) => r.runtimeCheckResults?.viteBuildReadiness?.ready === true,
      },
      {
        id: 'has-package-json',
        description: 'Runtime check: package.json exists',
        points: 1,
        phase: 'runtime',
        validate: (r) => r.runtimeCheckResults?.viteBuildReadiness?.hasPackageJson === true,
      },
      {
        id: 'has-vite-config',
        description: 'Runtime check: vite.config.ts exists',
        points: 1,
        phase: 'runtime',
        validate: (r) => r.runtimeCheckResults?.viteBuildReadiness?.hasViteConfig === true,
      },
      {
        id: 'has-app-tsx',
        description: 'Runtime check: src/App.tsx exists',
        points: 1,
        phase: 'runtime',
        validate: (r) => r.runtimeCheckResults?.viteBuildReadiness?.hasAppTsx === true,
      },
      {
        id: 'has-vite-bin',
        description: 'Runtime check: node_modules/.bin/vite exists (deps installed)',
        points: 2,
        phase: 'runtime',
        validate: (r) => r.runtimeCheckResults?.viteBuildReadiness?.hasViteBin === true,
      },
      {
        id: 'agent-recognizes-stack',
        description: 'Agent identifies Vite/React stack',
        points: 2,
        phase: 'execution',
        validate: (r) => {
          const lower = r.responseText.toLowerCase()
          return (lower.includes('vite') || lower.includes('react')) && !lower.includes('no vite')
        },
      },
    ],
    antiPatterns: [
      'claimed workspace is empty or missing setup',
      'tried to initialize a new project from scratch',
    ],
    maxScore: 12,
  },

  {
    id: 'parity-lint-check',
    name: 'Workspace Parity: Lint check recognizes Vite setup',
    category: 'canvas-v2',
    level: 1,
    useRuntimeTemplate: true,
    input: 'Can you lint the code to make sure everything is working?',
    workspaceFiles: {
      'config.json': V2_CONFIG,
    },
    validationCriteria: [
      {
        id: 'used-read-lints',
        description: 'Agent used the read_lints tool',
        points: 3,
        phase: 'execution',
        validate: (r) => agentUsedLints(r),
      },
      {
        id: 'no-vite-confusion',
        description: 'Agent did not claim the Vite setup is missing',
        points: 4,
        phase: 'execution',
        validate: (r) => agentDidNotClaimNoVite(r),
      },
      {
        id: 'acknowledged-workspace',
        description: 'Agent recognizes the workspace as a functional app',
        points: 3,
        phase: 'execution',
        validate: (r) => {
          const lower = r.responseText.toLowerCase()
          return lower.includes('lint') || lower.includes('clean') || lower.includes('error') || lower.includes('warning') || lower.includes('ok')
        },
      },
    ],
    antiPatterns: [
      'claimed no Vite or React setup exists',
      'tried to install Vite from scratch',
    ],
    maxScore: 10,
  },

  {
    id: 'parity-read-workspace-tree',
    name: 'Workspace Parity: Agent can see template files',
    category: 'canvas-v2',
    level: 1,
    useRuntimeTemplate: true,
    input: 'What files are in the project? Give me a quick overview of the structure.',
    workspaceFiles: {
      'config.json': V2_CONFIG,
    },
    validationCriteria: [
      {
        id: 'mentions-package-json',
        description: 'Agent mentions package.json in the workspace',
        points: 2,
        phase: 'execution',
        validate: (r) => r.responseText.toLowerCase().includes('package.json'),
      },
      {
        id: 'mentions-vite-config',
        description: 'Agent mentions vite.config in the workspace',
        points: 2,
        phase: 'execution',
        validate: (r) => r.responseText.toLowerCase().includes('vite'),
      },
      {
        id: 'mentions-src-app',
        description: 'Agent mentions src/App.tsx or the src directory',
        points: 2,
        phase: 'execution',
        validate: (r) => {
          const lower = r.responseText.toLowerCase()
          return lower.includes('app.tsx') || lower.includes('src/')
        },
      },
      {
        id: 'mentions-react-or-tailwind',
        description: 'Agent identifies the stack as React and/or Tailwind',
        points: 2,
        phase: 'execution',
        validate: (r) => {
          const lower = r.responseText.toLowerCase()
          return lower.includes('react') || lower.includes('tailwind')
        },
      },
    ],
    antiPatterns: [
      'claimed workspace is empty',
      'said there are no files',
    ],
    maxScore: 8,
  },

  {
    id: 'parity-edit-app-tsx',
    name: 'Workspace Parity: Edit existing App.tsx',
    category: 'canvas-v2',
    level: 2,
    useRuntimeTemplate: true,
    input: 'Add a "Hello World" heading to the app.',
    workspaceFiles: {
      'config.json': V2_CONFIG,
    },
    validationCriteria: [
      {
        id: 'wrote-code',
        description: 'Agent wrote or edited a code file in src/',
        points: 3,
        phase: 'execution',
        validate: (r) => agentWroteCodeFile(r),
      },
      {
        id: 'read-before-edit',
        description: 'Agent read the existing file before editing',
        points: 2,
        phase: 'execution',
        validate: (r) => agentReadFile(r, /App\.tsx/),
      },
      {
        id: 'hello-world-in-code',
        description: 'The written code contains "Hello World"',
        points: 3,
        phase: 'execution',
        validate: (r) => {
          return r.toolCalls
            .filter(t => t.name === 'write_file' || t.name === 'edit_file')
            .some(t => {
              const content = String((t.input as any).content ?? (t.input as any).new_string ?? '')
              return content.toLowerCase().includes('hello world')
            })
        },
      },
      {
        id: 'no-vite-confusion',
        description: 'Agent did not claim the Vite setup is missing',
        points: 2,
        phase: 'execution',
        validate: (r) => agentDidNotClaimNoVite(r),
      },
    ],
    antiPatterns: [
      'created a new project from scratch instead of editing',
      'claimed no Vite setup exists',
    ],
    maxScore: 10,
  },
]
