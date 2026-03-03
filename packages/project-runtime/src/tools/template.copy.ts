/**
 * MCP Tool: template.copy
 *
 * Copy a starter template to a new project directory.
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { resolve, join, dirname } from "path"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
} from "fs"
import { execSync } from "child_process"
import { MONOREPO_ROOT } from "./paths"
import { loadTemplates, type TemplateInfo } from "./template.list"

/**
 * Check if running in eval mode (uses SQLite for fast, isolated testing)
 */
function isEvalMode(): boolean {
  return process.env.SHOGO_EVAL_MODE === 'true'
}

// Parameter schema
const Params = t({
  /** Template name to copy (e.g., "todo-app", "expense-tracker", "crm") */
  template: "string",
  /** Name for the new project */
  name: "string",
  /** Output directory (optional, defaults to workspaces/{name}) */
  "output?": "string",
  /** Skip dependency installation */
  "skipInstall?": "boolean",
  /** Dry run - return what would be created without writing */
  "dryRun?": "boolean",
  /** Force overwrite existing files in non-empty directory */
  "force?": "boolean",
  /** Theme ID to apply (e.g., "lavender", "glacier", "default") */
  "theme?": "string",
})

type TemplateCopyParams = typeof Params.infer

// Theme presets - simplified version for MCP tool
// These match the theme IDs from apps/web/src/lib/themes/presets.ts
const THEME_CSS: Record<string, { light: string; dark: string; radius: string }> = {
  default: {
    light: `--background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --card-foreground: 222.2 84% 4.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 210 40% 98%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;`,
    dark: `--background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    --card: 222.2 84% 4.9%;
    --card-foreground: 210 40% 98%;
    --popover: 222.2 84% 4.9%;
    --popover-foreground: 210 40% 98%;
    --primary: 210 40% 98%;
    --primary-foreground: 222.2 47.4% 11.2%;
    --secondary: 217.2 32.6% 17.5%;
    --secondary-foreground: 210 40% 98%;
    --muted: 217.2 32.6% 17.5%;
    --muted-foreground: 215 20.2% 65.1%;
    --accent: 217.2 32.6% 17.5%;
    --accent-foreground: 210 40% 98%;
    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 210 40% 98%;
    --border: 217.2 32.6% 17.5%;
    --input: 217.2 32.6% 17.5%;
    --ring: 212.7 26.8% 83.9%;`,
    radius: '0.5',
  },
  lavender: {
    light: `--background: 270 50% 98%;
    --foreground: 270 50% 10%;
    --card: 0 0% 100%;
    --card-foreground: 270 50% 10%;
    --popover: 0 0% 100%;
    --popover-foreground: 270 50% 10%;
    --primary: 262 83% 58%;
    --primary-foreground: 0 0% 100%;
    --secondary: 270 50% 93%;
    --secondary-foreground: 270 50% 10%;
    --muted: 270 50% 93%;
    --muted-foreground: 270 30% 45%;
    --accent: 262 83% 92%;
    --accent-foreground: 262 83% 35%;
    --destructive: 0 84% 60%;
    --destructive-foreground: 0 0% 100%;
    --border: 270 30% 88%;
    --input: 270 30% 88%;
    --ring: 262 83% 58%;`,
    dark: `--background: 270 50% 5%;
    --foreground: 270 50% 98%;
    --card: 270 50% 8%;
    --card-foreground: 270 50% 98%;
    --popover: 270 50% 8%;
    --popover-foreground: 270 50% 98%;
    --primary: 262 83% 58%;
    --primary-foreground: 270 50% 5%;
    --secondary: 270 30% 17%;
    --secondary-foreground: 270 50% 98%;
    --muted: 270 30% 17%;
    --muted-foreground: 270 30% 65%;
    --accent: 262 83% 20%;
    --accent-foreground: 262 83% 90%;
    --destructive: 0 63% 31%;
    --destructive-foreground: 270 50% 98%;
    --border: 270 30% 17%;
    --input: 270 30% 17%;
    --ring: 262 83% 58%;`,
    radius: '0.625',
  },
  glacier: {
    light: `--background: 210 40% 98%;
    --foreground: 222 47% 11%;
    --card: 0 0% 100%;
    --card-foreground: 222 47% 11%;
    --popover: 0 0% 100%;
    --popover-foreground: 222 47% 11%;
    --primary: 199 89% 48%;
    --primary-foreground: 0 0% 100%;
    --secondary: 210 40% 93%;
    --secondary-foreground: 222 47% 11%;
    --muted: 210 40% 93%;
    --muted-foreground: 215 16% 47%;
    --accent: 199 89% 93%;
    --accent-foreground: 199 89% 30%;
    --destructive: 0 84% 60%;
    --destructive-foreground: 0 0% 100%;
    --border: 214 32% 91%;
    --input: 214 32% 91%;
    --ring: 199 89% 48%;`,
    dark: `--background: 222 47% 6%;
    --foreground: 210 40% 98%;
    --card: 222 47% 9%;
    --card-foreground: 210 40% 98%;
    --popover: 222 47% 9%;
    --popover-foreground: 210 40% 98%;
    --primary: 199 89% 48%;
    --primary-foreground: 222 47% 6%;
    --secondary: 217 33% 17%;
    --secondary-foreground: 210 40% 98%;
    --muted: 217 33% 17%;
    --muted-foreground: 215 20% 65%;
    --accent: 199 89% 20%;
    --accent-foreground: 199 89% 90%;
    --destructive: 0 63% 31%;
    --destructive-foreground: 210 40% 98%;
    --border: 217 33% 17%;
    --input: 217 33% 17%;
    --ring: 199 89% 48%;`,
    radius: '0.5',
  },
  harvest: {
    light: `--background: 40 33% 98%;
    --foreground: 20 14% 10%;
    --card: 40 33% 100%;
    --card-foreground: 20 14% 10%;
    --popover: 40 33% 100%;
    --popover-foreground: 20 14% 10%;
    --primary: 24 95% 53%;
    --primary-foreground: 0 0% 100%;
    --secondary: 40 33% 93%;
    --secondary-foreground: 20 14% 10%;
    --muted: 40 33% 93%;
    --muted-foreground: 20 14% 45%;
    --accent: 24 95% 92%;
    --accent-foreground: 24 95% 30%;
    --destructive: 0 84% 60%;
    --destructive-foreground: 0 0% 100%;
    --border: 40 20% 88%;
    --input: 40 20% 88%;
    --ring: 24 95% 53%;`,
    dark: `--background: 20 14% 6%;
    --foreground: 40 33% 98%;
    --card: 20 14% 9%;
    --card-foreground: 40 33% 98%;
    --popover: 20 14% 9%;
    --popover-foreground: 40 33% 98%;
    --primary: 24 95% 53%;
    --primary-foreground: 20 14% 6%;
    --secondary: 20 14% 17%;
    --secondary-foreground: 40 33% 98%;
    --muted: 20 14% 17%;
    --muted-foreground: 40 20% 65%;
    --accent: 24 95% 20%;
    --accent-foreground: 24 95% 90%;
    --destructive: 0 63% 31%;
    --destructive-foreground: 40 33% 98%;
    --border: 20 14% 17%;
    --input: 20 14% 17%;
    --ring: 24 95% 53%;`,
    radius: '0.5',
  },
  brutalist: {
    light: `--background: 0 0% 100%;
    --foreground: 0 0% 0%;
    --card: 0 0% 100%;
    --card-foreground: 0 0% 0%;
    --popover: 0 0% 100%;
    --popover-foreground: 0 0% 0%;
    --primary: 0 0% 0%;
    --primary-foreground: 0 0% 100%;
    --secondary: 0 0% 95%;
    --secondary-foreground: 0 0% 0%;
    --muted: 0 0% 95%;
    --muted-foreground: 0 0% 40%;
    --accent: 351 100% 50%;
    --accent-foreground: 0 0% 100%;
    --destructive: 351 100% 50%;
    --destructive-foreground: 0 0% 100%;
    --border: 0 0% 0%;
    --input: 0 0% 85%;
    --ring: 0 0% 0%;`,
    dark: `--background: 0 0% 0%;
    --foreground: 0 0% 100%;
    --card: 0 0% 5%;
    --card-foreground: 0 0% 100%;
    --popover: 0 0% 5%;
    --popover-foreground: 0 0% 100%;
    --primary: 0 0% 100%;
    --primary-foreground: 0 0% 0%;
    --secondary: 0 0% 15%;
    --secondary-foreground: 0 0% 100%;
    --muted: 0 0% 15%;
    --muted-foreground: 0 0% 60%;
    --accent: 351 100% 50%;
    --accent-foreground: 0 0% 100%;
    --destructive: 351 100% 50%;
    --destructive-foreground: 0 0% 100%;
    --border: 0 0% 100%;
    --input: 0 0% 20%;
    --ring: 0 0% 100%;`,
    radius: '0',
  },
  obsidian: {
    light: `--background: 240 10% 96%;
    --foreground: 240 10% 10%;
    --card: 0 0% 100%;
    --card-foreground: 240 10% 10%;
    --popover: 0 0% 100%;
    --popover-foreground: 240 10% 10%;
    --primary: 240 6% 25%;
    --primary-foreground: 0 0% 100%;
    --secondary: 240 10% 91%;
    --secondary-foreground: 240 10% 10%;
    --muted: 240 10% 91%;
    --muted-foreground: 240 6% 45%;
    --accent: 240 6% 85%;
    --accent-foreground: 240 6% 20%;
    --destructive: 0 84% 60%;
    --destructive-foreground: 0 0% 100%;
    --border: 240 6% 85%;
    --input: 240 6% 85%;
    --ring: 240 6% 25%;`,
    dark: `--background: 240 6% 6%;
    --foreground: 240 10% 96%;
    --card: 240 6% 10%;
    --card-foreground: 240 10% 96%;
    --popover: 240 6% 10%;
    --popover-foreground: 240 10% 96%;
    --primary: 240 10% 90%;
    --primary-foreground: 240 6% 6%;
    --secondary: 240 6% 15%;
    --secondary-foreground: 240 10% 96%;
    --muted: 240 6% 15%;
    --muted-foreground: 240 6% 55%;
    --accent: 240 6% 20%;
    --accent-foreground: 240 10% 90%;
    --destructive: 0 63% 31%;
    --destructive-foreground: 240 10% 96%;
    --border: 240 6% 15%;
    --input: 240 6% 15%;
    --ring: 240 10% 90%;`,
    radius: '0.375',
  },
  orchid: {
    light: `--background: 330 50% 98%;
    --foreground: 330 50% 10%;
    --card: 0 0% 100%;
    --card-foreground: 330 50% 10%;
    --popover: 0 0% 100%;
    --popover-foreground: 330 50% 10%;
    --primary: 330 81% 60%;
    --primary-foreground: 0 0% 100%;
    --secondary: 330 50% 93%;
    --secondary-foreground: 330 50% 10%;
    --muted: 330 50% 93%;
    --muted-foreground: 330 30% 45%;
    --accent: 330 81% 92%;
    --accent-foreground: 330 81% 35%;
    --destructive: 0 84% 60%;
    --destructive-foreground: 0 0% 100%;
    --border: 330 30% 88%;
    --input: 330 30% 88%;
    --ring: 330 81% 60%;`,
    dark: `--background: 330 50% 5%;
    --foreground: 330 50% 98%;
    --card: 330 50% 8%;
    --card-foreground: 330 50% 98%;
    --popover: 330 50% 8%;
    --popover-foreground: 330 50% 98%;
    --primary: 330 81% 60%;
    --primary-foreground: 330 50% 5%;
    --secondary: 330 30% 17%;
    --secondary-foreground: 330 50% 98%;
    --muted: 330 30% 17%;
    --muted-foreground: 330 30% 65%;
    --accent: 330 81% 25%;
    --accent-foreground: 330 81% 90%;
    --destructive: 0 63% 31%;
    --destructive-foreground: 330 50% 98%;
    --border: 330 30% 17%;
    --input: 330 30% 17%;
    --ring: 330 81% 60%;`,
    radius: '0.5',
  },
  solar: {
    light: `--background: 48 100% 98%;
    --foreground: 20 14% 10%;
    --card: 0 0% 100%;
    --card-foreground: 20 14% 10%;
    --popover: 0 0% 100%;
    --popover-foreground: 20 14% 10%;
    --primary: 45 93% 47%;
    --primary-foreground: 20 14% 10%;
    --secondary: 48 100% 93%;
    --secondary-foreground: 20 14% 10%;
    --muted: 48 100% 93%;
    --muted-foreground: 20 14% 45%;
    --accent: 45 93% 88%;
    --accent-foreground: 45 93% 25%;
    --destructive: 0 84% 60%;
    --destructive-foreground: 0 0% 100%;
    --border: 48 50% 85%;
    --input: 48 50% 85%;
    --ring: 45 93% 47%;`,
    dark: `--background: 20 14% 6%;
    --foreground: 48 100% 98%;
    --card: 20 14% 9%;
    --card-foreground: 48 100% 98%;
    --popover: 20 14% 9%;
    --popover-foreground: 48 100% 98%;
    --primary: 45 93% 47%;
    --primary-foreground: 20 14% 6%;
    --secondary: 20 14% 17%;
    --secondary-foreground: 48 100% 98%;
    --muted: 20 14% 17%;
    --muted-foreground: 48 50% 65%;
    --accent: 45 93% 20%;
    --accent-foreground: 45 93% 90%;
    --destructive: 0 63% 31%;
    --destructive-foreground: 48 100% 98%;
    --border: 20 14% 17%;
    --input: 20 14% 17%;
    --ring: 45 93% 47%;`,
    radius: '0.5',
  },
  tide: {
    light: `--background: 180 30% 98%;
    --foreground: 180 30% 10%;
    --card: 0 0% 100%;
    --card-foreground: 180 30% 10%;
    --popover: 0 0% 100%;
    --popover-foreground: 180 30% 10%;
    --primary: 173 80% 40%;
    --primary-foreground: 0 0% 100%;
    --secondary: 180 30% 93%;
    --secondary-foreground: 180 30% 10%;
    --muted: 180 30% 93%;
    --muted-foreground: 180 20% 45%;
    --accent: 173 80% 90%;
    --accent-foreground: 173 80% 25%;
    --destructive: 0 84% 60%;
    --destructive-foreground: 0 0% 100%;
    --border: 180 20% 88%;
    --input: 180 20% 88%;
    --ring: 173 80% 40%;`,
    dark: `--background: 180 30% 5%;
    --foreground: 180 30% 98%;
    --card: 180 30% 8%;
    --card-foreground: 180 30% 98%;
    --popover: 180 30% 8%;
    --popover-foreground: 180 30% 98%;
    --primary: 173 80% 40%;
    --primary-foreground: 180 30% 5%;
    --secondary: 180 20% 17%;
    --secondary-foreground: 180 30% 98%;
    --muted: 180 20% 17%;
    --muted-foreground: 180 20% 65%;
    --accent: 173 80% 20%;
    --accent-foreground: 173 80% 90%;
    --destructive: 0 63% 31%;
    --destructive-foreground: 180 30% 98%;
    --border: 180 20% 17%;
    --input: 180 20% 17%;
    --ring: 173 80% 40%;`,
    radius: '0.5',
  },
  verdant: {
    light: `--background: 120 30% 98%;
    --foreground: 120 30% 10%;
    --card: 0 0% 100%;
    --card-foreground: 120 30% 10%;
    --popover: 0 0% 100%;
    --popover-foreground: 120 30% 10%;
    --primary: 142 71% 45%;
    --primary-foreground: 0 0% 100%;
    --secondary: 120 30% 93%;
    --secondary-foreground: 120 30% 10%;
    --muted: 120 30% 93%;
    --muted-foreground: 120 20% 45%;
    --accent: 142 71% 90%;
    --accent-foreground: 142 71% 25%;
    --destructive: 0 84% 60%;
    --destructive-foreground: 0 0% 100%;
    --border: 120 20% 88%;
    --input: 120 20% 88%;
    --ring: 142 71% 45%;`,
    dark: `--background: 120 30% 5%;
    --foreground: 120 30% 98%;
    --card: 120 30% 8%;
    --card-foreground: 120 30% 98%;
    --popover: 120 30% 8%;
    --popover-foreground: 120 30% 98%;
    --primary: 142 71% 45%;
    --primary-foreground: 120 30% 5%;
    --secondary: 120 20% 17%;
    --secondary-foreground: 120 30% 98%;
    --muted: 120 20% 17%;
    --muted-foreground: 120 20% 65%;
    --accent: 142 71% 20%;
    --accent-foreground: 142 71% 90%;
    --destructive: 0 63% 31%;
    --destructive-foreground: 120 30% 98%;
    --border: 120 20% 17%;
    --input: 120 20% 17%;
    --ring: 142 71% 45%;`,
    radius: '0.5',
  },
}

/**
 * Generate index.css content with theme applied (Tailwind CSS v4 format)
 */
function generateThemeCSS(themeId: string): string {
  const theme = THEME_CSS[themeId] || THEME_CSS.default
  return `@import "tailwindcss";
@import "shadcn/tailwind.css";

@custom-variant dark (&:is(.dark *));

@plugin "tailwindcss-animate";

/* Theme: ${themeId} */

:root {
  ${theme.light}
  --radius: ${theme.radius}rem;
}

.dark {
  ${theme.dark}
}

@theme inline {
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --radius-2xl: calc(var(--radius) + 8px);
  --radius-3xl: calc(var(--radius) + 12px);
  --radius-4xl: calc(var(--radius) + 16px);
  --color-background: hsl(var(--background));
  --color-foreground: hsl(var(--foreground));
  --color-card: hsl(var(--card));
  --color-card-foreground: hsl(var(--card-foreground));
  --color-popover: hsl(var(--popover));
  --color-popover-foreground: hsl(var(--popover-foreground));
  --color-primary: hsl(var(--primary));
  --color-primary-foreground: hsl(var(--primary-foreground));
  --color-secondary: hsl(var(--secondary));
  --color-secondary-foreground: hsl(var(--secondary-foreground));
  --color-muted: hsl(var(--muted));
  --color-muted-foreground: hsl(var(--muted-foreground));
  --color-accent: hsl(var(--accent));
  --color-accent-foreground: hsl(var(--accent-foreground));
  --color-destructive: hsl(var(--destructive));
  --color-border: hsl(var(--border));
  --color-input: hsl(var(--input));
  --color-ring: hsl(var(--ring));
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground antialiased;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
      Oxygen, Ubuntu, Cantarell, 'Helvetica Neue', sans-serif;
  }
}
`
}

/**
 * Merge _template base infrastructure into the project directory.
 * Ensures all templates get Tailwind v4 deps, PostCSS config, and shadcn setup
 * regardless of whether the template itself declares them.
 * _template's deps form the base layer; the template's own deps override on conflict.
 */
function ensureBaseInfrastructure(projectDir: string): void {
  const baseTemplateDir = resolve(MONOREPO_ROOT, 'packages/sdk/examples/_template')
  if (!existsSync(baseTemplateDir)) {
    console.warn('[template.copy] _template directory not found, skipping base infrastructure merge')
    return
  }

  const basePackagePath = join(baseTemplateDir, 'package.json')
  const projectPackagePath = join(projectDir, 'package.json')
  if (existsSync(basePackagePath) && existsSync(projectPackagePath)) {
    try {
      const basePkg = JSON.parse(readFileSync(basePackagePath, 'utf-8'))
      const projectPkg = JSON.parse(readFileSync(projectPackagePath, 'utf-8'))

      projectPkg.dependencies = { ...basePkg.dependencies, ...projectPkg.dependencies }
      projectPkg.devDependencies = { ...basePkg.devDependencies, ...projectPkg.devDependencies }

      writeFileSync(projectPackagePath, JSON.stringify(projectPkg, null, 2) + '\n', 'utf-8')
      console.log('[template.copy] Merged _template base deps into package.json')
    } catch (err: any) {
      console.warn(`[template.copy] Warning: Could not merge base package.json: ${err.message}`)
    }
  }

  const postcssConfig = join(projectDir, 'postcss.config.mjs')
  if (!existsSync(postcssConfig)) {
    const basePostcss = join(baseTemplateDir, 'postcss.config.mjs')
    if (existsSync(basePostcss)) {
      copyFileSync(basePostcss, postcssConfig)
      console.log('[template.copy] Copied postcss.config.mjs from _template')
    }
  }

  const componentsJson = join(projectDir, 'components.json')
  if (!existsSync(componentsJson)) {
    const baseComponents = join(baseTemplateDir, 'components.json')
    if (existsSync(baseComponents)) {
      copyFileSync(baseComponents, componentsJson)
      console.log('[template.copy] Copied components.json from _template')
    }
  }
}

/**
 * Apply theme to project by writing index.css
 */
function applyThemeToProject(projectDir: string, themeId: string): void {
  const indexCssPath = join(projectDir, 'src', 'index.css')
  const themeCSS = generateThemeCSS(themeId)
  
  try {
    writeFileSync(indexCssPath, themeCSS, 'utf-8')
    console.log(`[template.copy] Applied theme "${themeId}" to ${indexCssPath}`)
  } catch (err: any) {
    console.warn(`[template.copy] Warning: Could not apply theme: ${err.message}`)
  }
}

/**
 * Recursively copy directory, excluding certain paths
 * Handles symlinks properly by recreating them instead of following them
 */
function copyDir(
  src: string,
  dest: string,
  exclude: string[] = [],
  files: string[] = []
): string[] {
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true })
  }

  const entries = readdirSync(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)

    // Check exclusions
    if (exclude.some((ex) => entry.name === ex || srcPath.includes(ex))) {
      continue
    }

    try {
      // Check if it's a symlink
      const stat = lstatSync(srcPath)
      
      if (stat.isSymbolicLink()) {
        // Copy symlink as symlink (don't follow it)
        const linkTarget = readlinkSync(srcPath)
        try {
          symlinkSync(linkTarget, destPath)
          files.push(destPath)
        } catch (e: any) {
          // Skip broken symlinks or symlinks that can't be created
          if (e.code !== 'EEXIST') {
            console.warn(`[template.copy] Skipping symlink ${entry.name}: ${e.message}`)
          }
        }
      } else if (stat.isDirectory()) {
        copyDir(srcPath, destPath, exclude, files)
      } else {
        copyFileSync(srcPath, destPath)
        files.push(destPath)
      }
    } catch (e: any) {
      console.warn(`[template.copy] Skipping ${entry.name}: ${e.message}`)
    }
  }

  return files
}

/**
 * Update package.json with new project name
 */
function updatePackageJson(projectDir: string, projectName: string): void {
  const pkgPath = join(projectDir, "package.json")
  if (!existsSync(pkgPath)) return

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
  pkg.name = projectName
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf-8")
}

/**
 * Convert template to SQLite mode for eval/testing
 */
function convertToSqliteMode(projectDir: string): void {
  console.log(`[template.copy] Eval mode detected - converting to SQLite for fast testing`)
  
  const schemaPath = join(projectDir, "prisma/schema.prisma")
  if (existsSync(schemaPath)) {
    let schema = readFileSync(schemaPath, "utf-8")
    schema = schema.replace(/provider\s*=\s*"postgresql"/g, 'provider = "sqlite"')
    schema = schema.replace(/@default\(uuid\(\)\)/g, '@default(cuid())')
    schema = schema.replace(/@default\(dbgenerated\("gen_random_uuid\(\)"\)\)/g, '@default(cuid())')
    schema = schema.replace(/@default\(auto\(\)\)/g, '@default(autoincrement())')
    schema = schema.replace(/@db\.\w+(\([^)]*\))?/g, '')
    writeFileSync(schemaPath, schema, "utf-8")
  }
  
  const dbPath = join(projectDir, "src/lib/db.ts")
  if (existsSync(dbPath)) {
    const sqliteDbCode = `import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from '../generated/prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

const adapter = new PrismaLibSql({
  url: process.env.DATABASE_URL || 'file:./dev.db',
})

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
`
    writeFileSync(dbPath, sqliteDbCode, "utf-8")
  }
  
  const pkgPath = join(projectDir, "package.json")
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
    if (pkg.dependencies) {
      delete pkg.dependencies['@prisma/adapter-pg']
      pkg.dependencies['@prisma/adapter-libsql'] = '^7.3.0'
    }
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf-8")
  }
  
  const envPath = join(projectDir, ".env")
  let envContent = existsSync(envPath) ? readFileSync(envPath, "utf-8") : ''
  const lines = envContent.split('\n').filter(line => {
    const trimmed = line.trim()
    return !trimmed.startsWith('DATABASE_URL=') && !trimmed.startsWith('DATABASE_URL ')
  })
  lines.push('DATABASE_URL="file:./dev.db"')
  writeFileSync(envPath, lines.filter(Boolean).join('\n') + '\n', "utf-8")
  
  try {
    execSync('bunx prisma generate', {
      cwd: projectDir,
      env: { ...process.env, DATABASE_URL: 'file:./dev.db' },
      stdio: 'pipe',
      timeout: 60000,
    })
  } catch (error: any) {
    console.warn(`[template.copy] Failed to regenerate Prisma client: ${error.message}`)
  }
}

/**
 * Remove DATABASE_URL from .env so the environment variable takes precedence.
 */
function sanitizeEnvFile(projectDir: string): void {
  const envPath = join(projectDir, ".env")
  if (!existsSync(envPath)) return

  try {
    const content = readFileSync(envPath, "utf-8")
    const lines = content.split('\n')
    
    const filteredLines = lines.filter(line => {
      const trimmed = line.trim()
      if (trimmed.startsWith('DATABASE_URL=') || trimmed.startsWith('DATABASE_URL =')) {
        console.log(`[template.copy] Removing DATABASE_URL from .env (will use environment variable)`)
        return false
      }
      return true
    })
    
    writeFileSync(envPath, filteredLines.join('\n'), "utf-8")
  } catch (err: any) {
    console.warn(`[template.copy] Warning: Could not sanitize .env file: ${err.message}`)
  }
}

/**
 * Get default output directory for new projects
 */
function getDefaultOutputDir(projectName: string): string {
  const projectDir = process.env.PROJECT_DIR
  const projectId = process.env.PROJECT_ID
  
  if (projectDir) {
    if (!existsSync(projectDir)) {
      mkdirSync(projectDir, { recursive: true })
    }
    return projectDir
  }

  if (projectId) {
    const workspacesDir = resolve(MONOREPO_ROOT, "workspaces")
    if (!existsSync(workspacesDir)) {
      mkdirSync(workspacesDir, { recursive: true })
    }
    const projectPath = resolve(workspacesDir, projectId)
    if (!existsSync(projectPath)) {
      mkdirSync(projectPath, { recursive: true })
    }
    return projectPath
  }

  const workspacesDir = resolve(MONOREPO_ROOT, "workspaces")
  if (!existsSync(workspacesDir)) {
    mkdirSync(workspacesDir, { recursive: true })
  }
  return resolve(workspacesDir, projectName)
}

function createTimer() {
  const start = performance.now()
  const steps: { name: string; durationMs: number }[] = []
  let lastMark = start
  
  return {
    mark(name: string) {
      const now = performance.now()
      const duration = now - lastMark
      steps.push({ name, durationMs: Math.round(duration) })
      console.log(`[template.copy] ${name}: ${Math.round(duration)}ms`)
      lastMark = now
    },
    total() {
      return Math.round(performance.now() - start)
    },
    getSteps() {
      return steps
    }
  }
}

/**
 * Execute template.copy
 */
export async function executeTemplateCopy(
  args: TemplateCopyParams
): Promise<{
  ok: boolean
  projectDir?: string
  files?: string[]
  template?: TemplateInfo
  error?: any
  timings?: { steps: { name: string; durationMs: number }[]; totalMs: number }
}> {
  const timer = createTimer()
  console.log(`[template.copy] Starting template copy for "${args.template}"...`)
  
  try {
    const templates = loadTemplates()
    const template = templates.find((t) => t.name === args.template)
    timer.mark('loadTemplates')

    if (!template) {
      return {
        ok: false,
        error: {
          code: "TEMPLATE_NOT_FOUND",
          message: `Template "${args.template}" not found. Available templates: ${templates.map((t) => t.name).join(", ")}`,
        },
      }
    }

    const projectDir = args.output
      ? resolve(args.output)
      : getDefaultOutputDir(args.name)
    timer.mark('determineOutputDir')

    const isProjectContext = !!process.env.PROJECT_ID
    const shouldForce = args.force || isProjectContext

    if (existsSync(projectDir) && !args.dryRun) {
      const contents = readdirSync(projectDir)
      if (contents.length > 0 && !shouldForce) {
        return {
          ok: false,
          error: {
            code: "DIR_EXISTS",
            message: `Directory "${projectDir}" already exists and is not empty. Use force: true to overwrite.`,
          },
          timings: { steps: timer.getSteps(), totalMs: timer.total() },
        }
      }
    }

    if (args.dryRun) {
      return {
        ok: true,
        projectDir,
        template,
        files: [
          "package.json",
          "tsconfig.json",
          "vite.config.ts",
          "prisma/schema.prisma",
          "src/client.tsx",
          "src/router.tsx",
          "src/routes/__root.tsx",
          "src/routes/index.tsx",
          "src/lib/shogo.ts",
          "src/utils/*.ts",
        ],
        timings: { steps: timer.getSteps(), totalMs: timer.total() },
      }
    }

    if (shouldForce && existsSync(projectDir)) {
      const dirsToClean = ["src", "prisma", ".tanstack"]
      for (const dir of dirsToClean) {
        const dirPath = join(projectDir, dir)
        if (existsSync(dirPath)) {
          rmSync(dirPath, { recursive: true, force: true })
        }
      }
      
      const filesToClean = ["index.html"]
      for (const file of filesToClean) {
        const filePath = join(projectDir, file)
        if (existsSync(filePath)) {
          rmSync(filePath, { force: true })
        }
      }
    }
    timer.mark('cleanConflictingFiles')

    const isArchive = template.isArchive || template.path.endsWith('.tar.gz')
    let copiedFiles: string[] = []
    
    if (isArchive) {
      console.log(`[template.copy] Extracting template archive: ${template.path}`)
      const startTime = performance.now()
      
      try {
        execSync(`tar -xzf "${template.path}" --strip-components=1 -C "${projectDir}"`, {
          stdio: 'pipe',
          timeout: 120000,
        })
        const extractTime = Math.round(performance.now() - startTime)
        console.log(`[template.copy] Template extracted in ${extractTime}ms (with node_modules + .output)`)
        
        if (existsSync(projectDir)) {
          copiedFiles = readdirSync(projectDir, { recursive: true })
            .map(f => String(f))
            .filter(f => !f.startsWith('node_modules/'))
        }
      } catch (tarError: any) {
        return {
          ok: false,
          error: {
            code: "EXTRACT_ERROR",
            message: `Failed to extract template archive: ${tarError.message}`,
          },
          timings: { steps: timer.getSteps(), totalMs: timer.total() },
        }
      }
      timer.mark('extractTemplateArchive')
    } else {
      const templateNodeModules = join(template.path, "node_modules")
      const hasPreinstalledDeps = existsSync(templateNodeModules)
      
      const exclude = [
        ...(hasPreinstalledDeps ? [] : ["node_modules"]),
        "bun.lock",
        ".git",
        "dev.db",
        "dev.db-journal",
        "playwright-report",
        "test-results",
        "template.json",
      ]
      
      if (hasPreinstalledDeps) {
        console.log(`[template.copy] Template has pre-installed node_modules - will copy for faster setup`)
      }

      copiedFiles = copyDir(template.path, projectDir, exclude)
      timer.mark('copyTemplateFiles')
    }

    updatePackageJson(projectDir, args.name)
    timer.mark('updatePackageJson')

    ensureBaseInfrastructure(projectDir)
    timer.mark('ensureBaseInfrastructure')

    if (isEvalMode()) {
      convertToSqliteMode(projectDir)
      timer.mark('convertToSqliteMode')
    } else {
      sanitizeEnvFile(projectDir)
      timer.mark('sanitizeEnvFile')
    }

    if (args.theme) {
      applyThemeToProject(projectDir, args.theme)
      timer.mark('applyTheme')
    }

    const devDbPath = join(projectDir, "prisma", "dev.db")
    if (existsSync(devDbPath)) {
      rmSync(devDbPath, { force: true })
    }

    const relativeFiles = copiedFiles.map((f) =>
      f.replace(projectDir + "/", "")
    )
    
    const excludeFromResponse = [
      'node_modules/',
      'dist/',
      '.output/',
      '.nitro/',
      '.tanstack/',
      'bun.lock',
      '.gitignore',
    ]
    
    const sourceFiles = relativeFiles.filter((f) => 
      !excludeFromResponse.some(exclude => f.startsWith(exclude) || f === exclude.replace('/', ''))
    )
    timer.mark('filterFiles')

    const response: any = {
      ok: true,
      projectDir,
      template,
      filesSummary: {
        totalFilesCopied: relativeFiles.length,
        files: sourceFiles,
      },
    }

    if (isProjectContext) {
      const projectId = process.env.PROJECT_ID
      response.projectId = projectId

      const runtimePort = process.env.RUNTIME_PORT || '8080'

      try {
        console.log(`[template.copy] Triggering preview restart for project ${projectId} on port ${runtimePort}...`)

        const restartResponse = await fetch(`http://localhost:${runtimePort}/preview/restart`, {
          method: 'POST',
        })
        timer.mark('previewRestartCall')
        
        if (restartResponse.ok) {
          const restartResult = await restartResponse.json() as { mode: string; port: number | null; timings?: any }
          response.setup = {
            success: true,
            steps: ['bun install', 'prisma generate', 'prisma db push', 'vite build', `start ${restartResult.mode} server`],
            message: `Template fully set up and running in ${restartResult.mode} mode`,
            mode: restartResult.mode,
            port: restartResult.port,
            timings: restartResult.timings,
          }
        } else {
          const errorData = await restartResponse.json().catch(() => ({})) as { error?: string }
          response.setup = {
            success: false,
            error: errorData.error || `Setup failed with status ${restartResponse.status}`,
          }
        }
      } catch (restartError: any) {
        response.setup = {
          success: false,
          error: `Could not reach runtime server: ${restartError.message}`,
        }
        timer.mark('previewRestartCall (failed)')
      }
      
      response.message = response.setup?.success 
        ? `Template "${template.name}" copied and fully set up. The preview should now show the app.`
        : `Template copied but setup failed: ${response.setup?.error}. Try refreshing the preview.`
    } else if (!args.skipInstall) {
      const installResults: { step: string; success: boolean; error?: string; durationMs?: number }[] = []
      
      try {
        const bunInstallStart = performance.now()
        execSync("bun install", {
          cwd: projectDir,
          stdio: "pipe",
          timeout: 120000,
        })
        installResults.push({ step: "bun install", success: true, durationMs: Math.round(performance.now() - bunInstallStart) })
      } catch (error: any) {
        installResults.push({ step: "bun install", success: false, error: error.message })
      }
      timer.mark('bunInstall')

      if (installResults[0]?.success) {
        try {
          const prismaGenStart = performance.now()
          execSync("bunx prisma generate", {
            cwd: projectDir,
            stdio: "pipe",
            timeout: 60000,
          })
          installResults.push({ step: "prisma generate", success: true, durationMs: Math.round(performance.now() - prismaGenStart) })
        } catch (error: any) {
          installResults.push({ step: "prisma generate", success: false, error: error.message })
        }
        timer.mark('prismaGenerate')
      }

      if (installResults.every(r => r.success)) {
        try {
          const prismaPushStart = performance.now()
          execSync("bunx prisma db push", {
            cwd: projectDir,
            stdio: "pipe",
            timeout: 60000,
          })
          installResults.push({ step: "prisma db push", success: true, durationMs: Math.round(performance.now() - prismaPushStart) })
        } catch (error: any) {
          installResults.push({ step: "prisma db push", success: false, error: error.message })
        }
        timer.mark('prismaDbPush')
      }

      response.install = {
        ran: true,
        steps: installResults,
        allSucceeded: installResults.every(r => r.success),
      }
      
      response.message = installResults.every(r => r.success)
        ? `Template copied and dependencies installed. Run "cd ${projectDir} && bun run dev" to start.`
        : `Template copied but some setup steps failed. Check the install results.`
    }

    const totalMs = timer.total()
    response.timings = { steps: timer.getSteps(), totalMs }

    return response
  } catch (error: any) {
    const totalMs = timer.total()
    return {
      ok: false,
      error: {
        code: "COPY_ERROR",
        message: error.message || "Failed to copy template",
      },
      timings: { steps: timer.getSteps(), totalMs },
    }
  }
}

/**
 * Register template.copy tool
 */
export function registerTemplateCopy(server: FastMCP) {
  server.addTool({
    name: "template.copy",
    description: `Copy a starter template to set up the current project. The template provides a working app structure with Prisma schema, React components, TanStack Router, and Shogo SDK integration.

IMPORTANT: This tool handles EVERYTHING automatically:
1. Copies template files to the project root
2. Runs "bun install" to install dependencies
3. Runs "prisma generate" to generate Prisma client
4. Runs "prisma db push" to set up the database
5. Builds the project with "vite build"
6. Starts the production server
7. The preview will automatically show the running app

You do NOT need to run any commands after using this tool. Just call template.copy and the app will be ready.

Available templates:
- todo-app: Simple task management (beginner)
- expense-tracker: Personal finance with categories/transactions (intermediate)
- crm: Customer relationship management with contacts/deals (intermediate)
- inventory: Stock and product management with suppliers (intermediate)
- kanban: Project boards with drag-and-drop cards (intermediate)
- ai-chat: AI chatbot with conversation history, Vercel AI SDK (advanced)
- form-builder: Dynamic form creation (intermediate)
- feedback-form: User feedback collection (beginner)
- booking-app: Appointment/booking system (intermediate)

Available themes (optional):
- default: Clean dark gray/blue (shadcn default)
- lavender: Soft purple tones
- glacier: Cool blue tones
- (more themes available: harvest, brutalist, obsidian, orchid, solar, tide, verdant)

Options:
- dryRun: true - Preview what would be copied without writing
- theme: "lavender" - Apply a theme to the project's index.css

Examples:
- template.copy({ template: "todo-app", name: "my-tasks" })
- template.copy({ template: "todo-app", name: "my-tasks", theme: "lavender" })
- template.copy({ template: "expense-tracker", name: "my-expenses", theme: "glacier" })`,
    parameters: Params as any,
    execute: async (args: any) => {
      const result = await executeTemplateCopy(args)
      return JSON.stringify(result, null, 2)
    },
  })
}
