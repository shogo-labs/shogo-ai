// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { existsSync, mkdirSync, writeFileSync, cpSync, readFileSync, copyFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAgentTemplateById } from './agent-templates'
import { getTemplateShogoDir, getTemplateCanvasStatePath, getTemplateCanvasCodeDir } from './template-loader'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const DEFAULT_WORKSPACE_FILES: Record<string, string> = {
  'AGENTS.md': `# Operating Instructions

## Approach
- **Plan before you build.** For any canvas or multi-step task, first write a brief plan covering what you'll build, the data model, component layout, and test plan. Then execute.
- **Understand before you fix.** When debugging, trace the error to its root cause before editing. Read the failing code and understand why it fails.
- Use canvas tools to build interactive UIs when the user asks for dashboards, apps, or visual displays
- Use memory tools to persist important facts the user shares
- Prefer action over clarification — make reasonable assumptions and explain what you did

## Canvas Best Practices
- Always set up a CRUD API (canvas_api_schema + canvas_api_seed) when building data-driven apps
- Use mutation actions on buttons so interactions work without agent round-trips
- After building interactive UIs, verify they work using canvas_trigger_action and canvas_inspect
- Never delete and recreate a surface — use canvas_update to fix issues in place

## Priorities
1. User requests — respond promptly and take action
2. Urgent alerts — surface immediately via channels
3. Scheduled checks — run on heartbeat cadence
4. Proactive suggestions — offer when relevant context is available
`,
  'SOUL.md': `# Soul

You are a capable, proactive AI agent. You communicate clearly and get things done efficiently.
You explain what you're about to do, then do it. You prefer showing over telling.

## Tone
- Direct and helpful, not verbose
- Confident but not presumptuous
- Celebrate completions briefly, then move on

## Boundaries
- Never execute destructive commands without explicit confirmation
- Never share credentials in channel messages
- Respect quiet hours for non-urgent notifications
`,
  'IDENTITY.md': `# Identity

- **Name:** Shogo
- **Emoji:** ⚡
- **Tagline:** Your AI agent — ready to build
`,
  'USER.md': `# User

- **Name:** (not set)
- **Timezone:** UTC
`,
  'HEARTBEAT.md': '',
  'TOOLS.md': `# Tools

Notes about available tools and conventions for this agent.
`,
  'MEMORY.md': `# Memory

Long-lived facts and learnings are stored here.
`,
  'config.json': JSON.stringify(
    {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      activeMode: 'canvas',
      canvasMode: 'code',
      model: {
        provider: 'anthropic',
        name: 'claude-sonnet-4-6',
      },
    },
    null,
    2
  ),
}

/**
 * Write default workspace files into a directory, creating subdirectories as needed.
 * Only writes files that don't already exist (won't overwrite user customizations).
 */
/**
 * Resolve a canonical workspace config/markdown file path.
 * Root is preferred (existing behavior); `.shogo/` is used when the workspace was
 * seeded from a template (see `seedWorkspaceFromTemplate`), which only copies into `.shogo/`.
 */
export function resolveWorkspaceConfigFilePath(dir: string, filename: string): string | null {
  const rootPath = join(dir, filename)
  if (existsSync(rootPath)) return rootPath
  const shogoPath = join(dir, '.shogo', filename)
  if (existsSync(shogoPath)) return shogoPath
  return null
}

export function seedWorkspaceDefaults(dir: string): void {
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  mkdirSync(join(dir, '.shogo', 'skills'), { recursive: true })
  mkdirSync(join(dir, '.shogo', 'plans'), { recursive: true })

  for (const [filename, content] of Object.entries(DEFAULT_WORKSPACE_FILES)) {
    const filepath = join(dir, filename)
    if (!existsSync(filepath)) {
      writeFileSync(filepath, content, 'utf-8')
    }
  }
}

/**
 * Force-write all default workspace files (overwrites existing).
 * Used by eval runner to reset workspace between tests.
 */
export function resetWorkspaceDefaults(dir: string): void {
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  mkdirSync(join(dir, '.shogo', 'skills'), { recursive: true })

  for (const [filename, content] of Object.entries(DEFAULT_WORKSPACE_FILES)) {
    writeFileSync(join(dir, filename), content, 'utf-8')
  }
}

/**
 * Seed workspace from a template. Copies the template's .shogo/ directory
 * and .canvas-state.json into the workspace.
 * Only writes files that don't already exist (preserves customizations).
 * Also writes a .template marker file so the runtime knows which template was used.
 */
export function seedWorkspaceFromTemplate(dir: string, templateId: string, agentName?: string): boolean {
  const template = getAgentTemplateById(templateId)
  if (!template) return false

  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })

  const shogoSrc = getTemplateShogoDir(templateId)
  if (shogoSrc) {
    const destShogo = join(dir, '.shogo')
    if (!existsSync(destShogo)) {
      cpSync(shogoSrc, destShogo, { recursive: true })
      if (agentName) {
        for (const fname of ['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'USER.md']) {
          const fp = join(destShogo, fname)
          if (existsSync(fp)) {
            const content = readFileSync(fp, 'utf-8')
            if (content.includes('{{AGENT_NAME}}')) {
              writeFileSync(fp, content.replace(/\{\{AGENT_NAME\}\}/g, agentName), 'utf-8')
            }
          }
        }
      }
    }
  }

  const canvasSrc = getTemplateCanvasStatePath(templateId)
  if (canvasSrc) {
    const canvasDest = join(dir, '.canvas-state.json')
    if (!existsSync(canvasDest)) {
      cpSync(canvasSrc, canvasDest)
    }
  }

  const canvasCodeSrc = getTemplateCanvasCodeDir(templateId)
  if (canvasCodeSrc) {
    const canvasDest = join(dir, 'canvas')
    if (!existsSync(canvasDest)) {
      cpSync(canvasCodeSrc, canvasDest, { recursive: true })
    }
  }

  writeFileSync(join(dir, '.template'), templateId, 'utf-8')
  return true
}

// ---------------------------------------------------------------------------
// Skill Server Seed
// ---------------------------------------------------------------------------

const SKILL_SERVER_SCHEMA = `datasource db {
  provider = "sqlite"
}

generator client {
  provider = "prisma-client"
  output   = "./generated/prisma"
}

// Add your models below. Each model gets CRUD routes at /api/{model-name-plural}.
// The skill server auto-regenerates when you save this file.
`

const SKILL_SERVER_PRISMA_CONFIG = `import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: './schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? 'file:./skill.db',
  },
})
`

const SKILL_SERVER_PORT = Number(process.env.SKILL_SERVER_PORT) || 4100

const SKILL_SERVER_CONFIG = JSON.stringify(
  {
    schema: './schema.prisma',
    outputs: [
      {
        dir: './generated',
        generate: ['routes', 'hooks', 'types'],
      },
      {
        dir: '.',
        generate: ['server'],
        serverConfig: {
          routesPath: './generated',
          dbPath: './db',
          port: SKILL_SERVER_PORT,
          skipStatic: true,
        },
      },
      {
        dir: '.',
        generate: ['db'],
        dbProvider: 'sqlite',
      },
    ],
  },
  null,
  2,
)

/**
 * Seed the skill server skeleton in .shogo/server/.
 * Creates schema.prisma, shogo.config.json, and necessary directories.
 * Only writes files that don't already exist.
 */
export function seedSkillServer(workspaceDir: string): { created: boolean; serverDir: string } {
  const serverDir = join(workspaceDir, '.shogo', 'server')
  const schemaPath = join(serverDir, 'schema.prisma')

  if (existsSync(schemaPath)) {
    return { created: false, serverDir }
  }

  mkdirSync(serverDir, { recursive: true })
  mkdirSync(join(serverDir, 'generated'), { recursive: true })
  mkdirSync(join(serverDir, 'hooks'), { recursive: true })

  writeFileSync(schemaPath, SKILL_SERVER_SCHEMA, 'utf-8')
  writeFileSync(join(serverDir, 'shogo.config.json'), SKILL_SERVER_CONFIG, 'utf-8')
  writeFileSync(join(serverDir, 'prisma.config.ts'), SKILL_SERVER_PRISMA_CONFIG, 'utf-8')

  return { created: true, serverDir }
}

// ---------------------------------------------------------------------------
// LSP Configuration Seed
// ---------------------------------------------------------------------------

const WORKSPACE_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2020',
      module: 'none',
      jsx: 'react',
      jsxFactory: 'h',
      strict: false,
      noEmit: true,
      skipLibCheck: true,
      noLib: false,
    },
    include: ['canvas/**/*.ts', '**/*.d.ts'],
    exclude: ['node_modules', '.shogo'],
  },
  null,
  2,
)

const REACT_SHIM_DTS = `declare namespace React {
  type ReactNode = ReactElement | string | number | boolean | null | undefined | ReactNode[];
  type ReactElement = { type: any; props: any; key: any };
  type Key = string | number;
  type Ref<T> = ((instance: T | null) => void) | { current: T | null } | null;
  type RefObject<T> = { current: T | null };
  type FC<P = {}> = (props: P & { children?: ReactNode }) => ReactElement | null;
  type SetStateAction<S> = S | ((prevState: S) => S);
  type Dispatch<A> = (value: A) => void;
  type MutableRefObject<T> = { current: T };
  type DependencyList = readonly unknown[];
  type EffectCallback = () => (void | (() => void));
  type Reducer<S, A> = (prevState: S, action: A) => S;
  type ReducerState<R extends Reducer<any, any>> = R extends Reducer<infer S, any> ? S : never;
  type ReducerAction<R extends Reducer<any, any>> = R extends Reducer<any, infer A> ? A : never;
  function createElement(type: any, props?: any, ...children: any[]): ReactElement;
  const Fragment: any;
  function useState<S>(initialState: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  function useState<S = undefined>(): [S | undefined, Dispatch<SetStateAction<S | undefined>>];
  function useEffect(effect: EffectCallback, deps?: DependencyList): void;
  function useMemo<T>(factory: () => T, deps: DependencyList): T;
  function useCallback<T extends (...args: any[]) => any>(callback: T, deps: DependencyList): T;
  function useRef<T>(initialValue: T): MutableRefObject<T>;
  function useRef<T>(initialValue: T | null): RefObject<T>;
  function useRef<T = undefined>(): MutableRefObject<T | undefined>;
  function useReducer<R extends Reducer<any, any>>(reducer: R, initialState: ReducerState<R>): [ReducerState<R>, Dispatch<ReducerAction<R>>];
  function useReducer<R extends Reducer<any, any>, I>(reducer: R, initialArg: I, init: (arg: I) => ReducerState<R>): [ReducerState<R>, Dispatch<ReducerAction<R>>];
}

// Canvas globals — always available as fallback even if canvas-globals.d.ts fails to load
declare function h(type: any, props?: any, ...children: any[]): React.ReactElement;
declare const Fragment: typeof React.Fragment;
declare const useState: typeof React.useState;
declare const useEffect: typeof React.useEffect;
declare const useMemo: typeof React.useMemo;
declare const useCallback: typeof React.useCallback;
declare const useRef: typeof React.useRef;
declare const useReducer: typeof React.useReducer;
`

const COMMON_LUCIDE_ICONS = [
  'Activity','AlertCircle','AlertTriangle','Archive','ArrowDown','ArrowLeft','ArrowRight',
  'ArrowUp','ArrowUpDown','Award','Ban','BarChart','BarChart2','BarChart3','Bell',
  'BellOff','Bookmark','Box','Calendar','Camera','Check','CheckCircle','ChevronDown',
  'ChevronLeft','ChevronRight','ChevronUp','Circle','Clock','Cloud','Code','Columns',
  'Copy','CreditCard','Database','Delete','Download','Edit','Edit2','Edit3','ExternalLink',
  'Eye','EyeOff','File','FileText','Filter','Flag','Folder','FolderPlus','Gift',
  'Globe','Grid','Hash','Heart','HelpCircle','Home','Image','Inbox','Info','Key',
  'Layers','Layout','Link','List','Loader','Lock','LogIn','LogOut','Mail','Map',
  'MapPin','Maximize','Menu','MessageCircle','MessageSquare','Mic','Minus','Monitor',
  'Moon','MoreHorizontal','MoreVertical','Move','Music','Navigation','Package',
  'Paperclip','Pause','Pen','Phone','PieChart','Pin','Play','Plus','PlusCircle',
  'Power','Printer','RefreshCw','Repeat','RotateCcw','Save','Search','Send',
  'Server','Settings','Share','Shield','ShieldCheck','ShoppingBag','ShoppingCart',
  'Sidebar','Slash','Sliders','Smartphone','Smile','SortAsc','SortDesc','Sparkles',
  'Speaker','Square','Star','Sun','Sunrise','Sunset','Table','Tag','Target',
  'Terminal','ThumbsDown','ThumbsUp','ToggleLeft','ToggleRight','Tool','Trash',
  'Trash2','TrendingDown','TrendingUp','Triangle','Truck','Tv','Type','Umbrella',
  'Underline','Undo','Unlock','Upload','User','UserCheck','UserMinus','UserPlus',
  'Users','Video','Volume','Volume1','Volume2','VolumeX','Wifi','WifiOff','Wind',
  'X','XCircle','Zap','ZoomIn','ZoomOut','Separator',
]

const LUCIDE_ICON_SUBSET =
  '// LUCIDE_ICONS_START — subset for fast LSP loading (full list in canvas-runtime)\n' +
  'type LucideIcon = React.FC<{ className?: string; size?: number; color?: string; strokeWidth?: number }>\n' +
  COMMON_LUCIDE_ICONS.map(n => 'declare const ' + n + ': LucideIcon').join('\n') + '\n'

const WORKSPACE_PYRIGHTCONFIG = JSON.stringify(
  {
    pythonVersion: '3.11',
    typeCheckingMode: 'basic',
    reportMissingImports: true,
    reportMissingModuleSource: false,
    reportOptionalMemberAccess: true,
    exclude: ['.shogo', 'node_modules', 'canvas'],
  },
  null,
  2,
)

/**
 * Seed LSP configuration into a workspace so language servers
 * can provide diagnostics for both TypeScript canvas code and Python files.
 *
 * Creates:
 *   - tsconfig.json (root)
 *   - react-shim.d.ts (React namespace types)
 *   - canvas-globals.d.ts (copied from canvas-runtime if available)
 *   - pyrightconfig.json (Python type checking)
 */
export function seedLSPConfig(dir: string): void {
  writeFileSync(join(dir, 'tsconfig.json'), WORKSPACE_TSCONFIG, 'utf-8')
  writeFileSync(join(dir, 'react-shim.d.ts'), REACT_SHIM_DTS, 'utf-8')
  writeFileSync(join(dir, 'pyrightconfig.json'), WORKSPACE_PYRIGHTCONFIG, 'utf-8')

  const canvasGlobalsSrc = process.env.CANVAS_GLOBALS_DTS
    || resolve(__dirname, '../../canvas-runtime/src/canvas-globals.d.ts')
  if (existsSync(canvasGlobalsSrc)) {
    let content = readFileSync(canvasGlobalsSrc, 'utf-8')
    content = content.replace(
      /^declare const React:\s*typeof import\(['"]react['"]\).*$/m,
      '// React namespace provided by react-shim.d.ts',
    )
    const marker = content.indexOf('// LUCIDE_ICONS_START')
    if (marker !== -1) {
      content = content.slice(0, marker) + LUCIDE_ICON_SUBSET
    }
    writeFileSync(join(dir, 'canvas-globals.d.ts'), content, 'utf-8')
  }
}
