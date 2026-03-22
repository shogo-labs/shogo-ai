// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Code Agent Eval Test Cases (v2)
 *
 * Validates code_agent coding quality: read-before-edit discipline,
 * edit failure recovery, build verification, SDK awareness, and
 * adherence to forbidden command rules.
 *
 * These evals exercise the code_agent subagent via the task tool
 * in app mode. They validate the coding workflow patterns that
 * distinguish a production-quality agent from a naive one.
 *
 * Opt-in: --track code-agent-v2 (not included in 'all' — requires
 * app mode and workspace files)
 */

import type { AgentEval } from './types'
import { usedTool, neverUsedTool, toolCallArgsContain, toolCallCount } from './eval-helpers'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBeforeEdit(r: { toolCalls: Array<{ name: string; input: Record<string, unknown> }> }): boolean {
  const editIdx = r.toolCalls.findIndex(t => t.name === 'edit_file')
  if (editIdx === -1) return true
  const readOrGrep = r.toolCalls.slice(0, editIdx).some(
    t => t.name === 'read_file' || t.name === 'grep'
  )
  return readOrGrep
}

function usedExecWith(r: { toolCalls: Array<{ name: string; input: Record<string, unknown> }> }, pattern: string): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'exec') return false
    const cmd = String(t.input?.command || '').toLowerCase()
    return cmd.includes(pattern.toLowerCase())
  })
}

function ranForbiddenCommand(r: { toolCalls: Array<{ name: string; input: Record<string, unknown> }> }): boolean {
  const forbidden = [
    'vite dev', 'vite build', 'vite serve',
    'npx vite', 'bunx vite',
    'bun run dev', 'bun run build',
    'npm run dev', 'npm run build',
    'yarn dev', 'yarn build',
  ]
  return r.toolCalls.some(t => {
    if (t.name !== 'exec') return false
    const cmd = String(t.input?.command || '').toLowerCase()
    return forbidden.some(f => cmd.includes(f))
  })
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const CODE_AGENT_V2_EVALS: AgentEval[] = [
  // ----- Read before edit -----
  {
    id: 'code-agent-v2-read-before-edit',
    name: 'App agent reads file before editing',
    category: 'code-agent',
    level: 2,
    initialMode: 'app',
    input: 'Change the page title from "Welcome" to "Dashboard" in the App component.',
    workspaceFiles: {
      'project/src/App.tsx': `import React from 'react'

export default function App() {
  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold">Welcome</h1>
      <p>This is the main application page.</p>
    </div>
  )
}`,
    },
    validationCriteria: [
      {
        id: 'delegates-to-code-agent-v2',
        description: 'Agent delegates to code_agent subagent',
        points: 2,
        phase: 'intention',
        validate: (r) => usedTool(r, 'task') && r.toolCalls.some(
          t => t.name === 'task' && JSON.stringify(t.input).includes('code_agent'),
        ),
      },
      {
        id: 'reads-before-editing',
        description: 'App agent reads the file (read_file or grep) before edit_file',
        points: 4,
        phase: 'execution',
        validate: (r) => readBeforeEdit(r),
      },
      {
        id: 'made-the-change',
        description: 'The edit changed "Welcome" to "Dashboard"',
        points: 3,
        phase: 'execution',
        validate: (r) => r.toolCalls.some(
          t => t.name === 'edit_file' &&
            JSON.stringify(t.input).includes('Welcome') &&
            JSON.stringify(t.input).includes('Dashboard'),
        ),
      },
    ],
    maxScore: 9,
  },

  // ----- Edit failure recovery -----
  {
    id: 'code-agent-v2-edit-failure-recovery',
    name: 'App agent recovers from non-unique edit_file match',
    category: 'code-agent',
    level: 3,
    initialMode: 'app',
    input: 'Change the second "Hello World" heading to say "Hello Dashboard" instead.',
    workspaceFiles: {
      'project/src/App.tsx': `import React from 'react'

function Header() {
  return <h1>Hello World</h1>
}

function Footer() {
  return <h1>Hello World</h1>
}

function Sidebar() {
  return <h1>Hello World</h1>
}

export default function App() {
  return (
    <div>
      <Header />
      <Footer />
      <Sidebar />
    </div>
  )
}`,
    },
    validationCriteria: [
      {
        id: 'delegates-to-code-agent-v2',
        description: 'Agent delegates to code_agent subagent',
        points: 1,
        phase: 'intention',
        validate: (r) => usedTool(r, 'task') && r.toolCalls.some(
          t => t.name === 'task' && JSON.stringify(t.input).includes('code_agent'),
        ),
      },
      {
        id: 'reads-file-for-context',
        description: 'Agent reads the file to understand the duplicates',
        points: 3,
        phase: 'execution',
        validate: (r) => usedTool(r, 'read_file') || usedTool(r, 'grep'),
      },
      {
        id: 'eventually-succeeds',
        description: 'Agent makes a successful edit (uses surrounding context or replace_all)',
        points: 4,
        phase: 'execution',
        validate: (r) => r.toolCalls.some(
          t => t.name === 'edit_file' &&
            JSON.stringify(t.input).includes('Hello Dashboard'),
        ),
      },
    ],
    maxScore: 8,
  },

  // ----- Multi-file refactor -----
  {
    id: 'code-agent-v2-multi-file-refactor',
    name: 'App agent renames a function across multiple files',
    category: 'code-agent',
    level: 3,
    initialMode: 'app',
    input: 'Rename the function "fetchData" to "getData" across all files in the project.',
    workspaceFiles: {
      'project/src/api.ts': `export async function fetchData(url: string) {
  const res = await fetch(url)
  return res.json()
}`,
      'project/src/App.tsx': `import { fetchData } from './api'

export default function App() {
  const load = () => fetchData('/api/items')
  return <button onClick={load}>Load</button>
}`,
      'project/src/utils.ts': `import { fetchData } from './api'

export async function loadItems() {
  return fetchData('/api/items')
}`,
    },
    validationCriteria: [
      {
        id: 'delegates-to-code-agent-v2',
        description: 'Agent delegates to code_agent',
        points: 1,
        phase: 'intention',
        validate: (r) => usedTool(r, 'task'),
      },
      {
        id: 'explores-codebase',
        description: 'Agent searches for usages before editing (grep or glob)',
        points: 2,
        phase: 'execution',
        validate: (r) => usedTool(r, 'grep') || usedTool(r, 'glob'),
      },
      {
        id: 'edits-multiple-files',
        description: 'Agent edits at least 3 files',
        points: 4,
        phase: 'execution',
        validate: (r) => {
          const editedFiles = new Set(
            r.toolCalls
              .filter(t => t.name === 'edit_file')
              .map(t => String((t.input as any)?.path || ''))
          )
          return editedFiles.size >= 3
        },
      },
      {
        id: 'renames-correctly',
        description: 'Edits change fetchData to getData',
        points: 3,
        phase: 'execution',
        validate: (r) => r.toolCalls.some(
          t => t.name === 'edit_file' &&
            JSON.stringify(t.input).includes('getData'),
        ),
      },
    ],
    maxScore: 10,
  },

  // ----- Build log verification -----
  {
    id: 'code-agent-v2-build-log-check',
    name: 'App agent checks build log after making changes',
    category: 'code-agent',
    level: 2,
    initialMode: 'app',
    input: 'Add a "Last updated" paragraph below the title in App.tsx.',
    workspaceFiles: {
      'project/src/App.tsx': `import React from 'react'

export default function App() {
  return (
    <div className="p-4">
      <h1 className="text-2xl">My App</h1>
    </div>
  )
}`,
      'project/.build.log': 'vite v6.0.0 building...\n✓ 42 modules transformed.\n✓ built in 1.2s\n',
    },
    validationCriteria: [
      {
        id: 'delegates-to-code-agent-v2',
        description: 'Agent delegates to code_agent',
        points: 1,
        phase: 'intention',
        validate: (r) => usedTool(r, 'task'),
      },
      {
        id: 'makes-edit',
        description: 'Agent edits App.tsx',
        points: 2,
        phase: 'execution',
        validate: (r) => usedTool(r, 'edit_file'),
      },
      {
        id: 'checks-build-log',
        description: 'Agent checks .build.log after editing (exec with tail or cat)',
        points: 4,
        phase: 'execution',
        validate: (r) => usedExecWith(r, '.build.log') || usedTool(r, 'read_file') && r.toolCalls.some(
          t => t.name === 'read_file' && String((t.input as any)?.path || '').includes('build.log'),
        ),
      },
    ],
    maxScore: 7,
  },

  // ----- Build error diagnosis -----
  {
    id: 'code-agent-v2-build-error-diagnosis',
    name: 'App agent diagnoses build error from .build.log',
    category: 'code-agent',
    level: 3,
    initialMode: 'app',
    input: 'The build is failing. Please fix it.',
    workspaceFiles: {
      'project/src/App.tsx': `import React from 'react'
import { Badge } from '@/components/ui/badge'

export default function App() {
  return (
    <div className="p-4">
      <h1>My App</h1>
      <Bagde variant="secondary">Active</Bagde>
    </div>
  )
}`,
      'project/.build.log': `vite v6.0.0 building...
src/App.tsx(8,8): error TS2304: Cannot find name 'Bagde'. Did you mean 'Badge'?
✗ Build failed in 0.8s
`,
    },
    validationCriteria: [
      {
        id: 'reads-build-log',
        description: 'Agent reads .build.log to understand the error',
        points: 3,
        phase: 'execution',
        validate: (r) => usedExecWith(r, '.build.log') || r.toolCalls.some(
          t => t.name === 'read_file' && String((t.input as any)?.path || '').includes('build.log'),
        ),
      },
      {
        id: 'fixes-typo',
        description: 'Agent fixes the Bagde -> Badge typo in App.tsx',
        points: 4,
        phase: 'execution',
        validate: (r) => r.toolCalls.some(
          t => t.name === 'edit_file' &&
            JSON.stringify(t.input).includes('Bagde') &&
            JSON.stringify(t.input).includes('Badge'),
        ),
      },
    ],
    maxScore: 7,
  },

  // ----- SDK awareness -----
  {
    id: 'code-agent-v2-sdk-awareness',
    name: 'App agent uses @shogo-ai/sdk/agent when connecting to the agent',
    category: 'code-agent',
    level: 3,
    initialMode: 'app',
    input: 'Add a chat widget component that lets the user talk to the agent.',
    workspaceFiles: {
      'project/src/App.tsx': `import React from 'react'

export default function App() {
  return (
    <div className="p-4">
      <h1>Agent Dashboard</h1>
    </div>
  )
}`,
      'project/package.json': '{ "name": "my-app", "dependencies": { "react": "^19.0.0", "@shogo-ai/sdk": "^1.0.0" } }',
    },
    validationCriteria: [
      {
        id: 'delegates-to-code-agent-v2',
        description: 'Agent delegates to code_agent',
        points: 1,
        phase: 'intention',
        validate: (r) => usedTool(r, 'task'),
      },
      {
        id: 'uses-sdk-import',
        description: 'Code references @shogo-ai/sdk/agent',
        points: 4,
        phase: 'execution',
        validate: (r) => {
          const allInputs = r.toolCalls
            .filter(t => t.name === 'edit_file' || t.name === 'write_file')
            .map(t => JSON.stringify(t.input))
            .join(' ')
          return allInputs.includes('@shogo-ai/sdk') || allInputs.includes('useAgentChat')
        },
      },
    ],
    maxScore: 5,
  },

  // ----- No forbidden commands -----
  {
    id: 'code-agent-v2-no-forbidden-commands',
    name: 'App agent does not run vite/build commands when asked',
    category: 'code-agent',
    level: 2,
    initialMode: 'app',
    input: 'The preview seems stuck. Can you restart the dev server?',
    validationCriteria: [
      {
        id: 'no-forbidden-commands',
        description: 'Did NOT run vite dev/build/serve or bun run dev/build',
        points: 5,
        phase: 'intention',
        validate: (r) => !ranForbiddenCommand(r),
      },
      {
        id: 'explains-auto-rebuild',
        description: 'Explained that rebuilds/restarts are automatic',
        points: 3,
        phase: 'intention',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          const phrases = [
            'automatic', 'automatically', 'already running',
            'watch mode', 'managed', "don't need to", 'no need to',
            'handled', 'not necessary', 'rebuild',
          ]
          return phrases.some(p => text.includes(p))
        },
      },
    ],
    maxScore: 8,
  },

  // ----- Prisma workflow -----
  {
    id: 'code-agent-v2-prisma-workflow',
    name: 'App agent follows correct Prisma schema workflow',
    category: 'code-agent',
    level: 3,
    initialMode: 'app',
    input: 'Add a "priority" field (HIGH, MEDIUM, LOW) to the Todo model.',
    workspaceFiles: {
      'project/prisma/schema.prisma': `datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

generator client {
  provider = "prisma-client-js"
}

model Todo {
  id        Int      @id @default(autoincrement())
  title     String
  completed Boolean  @default(false)
  createdAt DateTime @default(now())
}`,
      'project/src/generated/types.tsx': '// Auto-generated — do not edit\nexport interface Todo { id: number; title: string; completed: boolean; createdAt: string }',
      'project/.build.log': '✓ built in 1.0s\n',
    },
    validationCriteria: [
      {
        id: 'edits-schema',
        description: 'Agent edits prisma/schema.prisma (not generated files)',
        points: 3,
        phase: 'execution',
        validate: (r) => r.toolCalls.some(
          t => t.name === 'edit_file' &&
            String((t.input as any)?.path || '').includes('schema.prisma'),
        ),
      },
      {
        id: 'runs-generate',
        description: 'Agent runs bunx shogo generate after schema change',
        points: 3,
        phase: 'execution',
        validate: (r) => usedExecWith(r, 'shogo generate'),
      },
      {
        id: 'does-not-edit-generated',
        description: 'Agent does NOT directly edit src/generated/ files',
        points: 3,
        phase: 'intention',
        validate: (r) => !r.toolCalls.some(
          t => t.name === 'edit_file' &&
            String((t.input as any)?.path || '').includes('src/generated/'),
        ),
      },
    ],
    maxScore: 9,
  },

  // ----- Generated file protection -----
  {
    id: 'code-agent-v2-generated-file-protection',
    name: 'App agent refuses to edit generated files directly',
    category: 'code-agent',
    level: 2,
    initialMode: 'app',
    input: 'Add a "dueDate" field to the Todo type definition in src/generated/types.tsx.',
    workspaceFiles: {
      'project/src/generated/types.tsx': '// Auto-generated — do not edit\nexport interface Todo { id: number; title: string; completed: boolean }',
      'project/prisma/schema.prisma': `model Todo {
  id        Int      @id @default(autoincrement())
  title     String
  completed Boolean  @default(false)
}`,
    },
    validationCriteria: [
      {
        id: 'edits-schema-instead',
        description: 'Agent edits prisma/schema.prisma instead of generated types',
        points: 4,
        phase: 'execution',
        validate: (r) => r.toolCalls.some(
          t => t.name === 'edit_file' &&
            String((t.input as any)?.path || '').includes('schema.prisma'),
        ),
      },
      {
        id: 'does-not-edit-generated',
        description: 'Agent does NOT edit src/generated/types.tsx directly',
        points: 4,
        phase: 'intention',
        validate: (r) => !r.toolCalls.some(
          t => t.name === 'edit_file' &&
            String((t.input as any)?.path || '').includes('generated/types'),
        ),
      },
    ],
    maxScore: 8,
  },

  // ----- shadcn workflow -----
  {
    id: 'code-agent-v2-shadcn-workflow',
    name: 'App agent follows shadcn install-import-use workflow',
    category: 'code-agent',
    level: 3,
    initialMode: 'app',
    input: 'Add a confirmation dialog that appears when the user clicks "Delete" on an item.',
    workspaceFiles: {
      'project/src/App.tsx': `import React from 'react'

export default function App() {
  const handleDelete = (id: number) => {
    fetch(\`/api/items/\${id}\`, { method: 'DELETE' })
  }
  return (
    <div className="p-4">
      <h1>Items</h1>
      <button onClick={() => handleDelete(1)}>Delete</button>
    </div>
  )
}`,
      'project/package.json': '{ "name": "my-app", "dependencies": { "react": "^19.0.0" } }',
      'project/.build.log': '✓ built in 1.0s\n',
    },
    validationCriteria: [
      {
        id: 'installs-shadcn-component',
        description: 'Agent runs bunx shadcn@latest add for dialog or alert-dialog',
        points: 3,
        phase: 'execution',
        validate: (r) => usedExecWith(r, 'shadcn') && (
          usedExecWith(r, 'dialog') || usedExecWith(r, 'alert-dialog')
        ),
      },
      {
        id: 'imports-from-components-ui',
        description: 'Agent imports from @/components/ui/',
        points: 3,
        phase: 'execution',
        validate: (r) => {
          const allInputs = r.toolCalls
            .filter(t => t.name === 'edit_file' || t.name === 'write_file')
            .map(t => JSON.stringify(t.input))
            .join(' ')
          return allInputs.includes('@/components/ui/')
        },
      },
      {
        id: 'no-window-confirm',
        description: 'Agent does NOT use window.confirm()',
        points: 2,
        phase: 'intention',
        validate: (r) => {
          const allInputs = r.toolCalls
            .filter(t => t.name === 'edit_file' || t.name === 'write_file')
            .map(t => JSON.stringify(t.input))
            .join(' ')
          return !allInputs.includes('window.confirm')
        },
      },
    ],
    maxScore: 8,
  },

  // ----- Todo usage for complex tasks -----
  {
    id: 'code-agent-v2-todo-for-complex-task',
    name: 'App agent uses todo_write for multi-step tasks',
    category: 'code-agent',
    level: 3,
    initialMode: 'app',
    input: 'Add dark mode support, a user settings page, and update the navigation bar to include a settings link.',
    workspaceFiles: {
      'project/src/App.tsx': `import React from 'react'

export default function App() {
  return (
    <div className="p-4">
      <nav className="flex gap-4 mb-4">
        <a href="/">Home</a>
        <a href="/about">About</a>
      </nav>
      <h1>My App</h1>
    </div>
  )
}`,
      'project/.build.log': '✓ built in 1.0s\n',
    },
    validationCriteria: [
      {
        id: 'uses-todo-write',
        description: 'Agent uses todo_write to plan the multi-step task',
        points: 4,
        phase: 'intention',
        validate: (r) => usedTool(r, 'todo_write'),
      },
      {
        id: 'makes-multiple-edits',
        description: 'Agent makes changes to at least one file',
        points: 3,
        phase: 'execution',
        validate: (r) => usedTool(r, 'edit_file') || usedTool(r, 'write_file'),
      },
    ],
    maxScore: 7,
  },
]
