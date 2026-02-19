/**
 * shadcn/ui Component Usage Evals
 * 
 * Tests that the agent uses shadcn CLI to add components and
 * imports them properly when building/customizing UI.
 * 
 * These evals verify:
 * - Agent runs `bunx shadcn@latest add <component>` for new components
 * - Agent imports from `@/components/ui/` (not hand-coding)
 * - Agent uses proper shadcn component patterns
 */

import type { AgentEval, ValidationCriterion, EvalResult, ValidationPhase } from './types'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// ============================================
// Helper Functions
// ============================================

function getProjectDir(result: EvalResult): string | null {
  if (result.projectDir && existsSync(join(result.projectDir, 'prisma/schema.prisma'))) {
    return result.projectDir
  }
  
  for (const tc of result.toolCalls) {
    if (tc.name === 'template.copy') {
      if (tc.params?.targetDir) return tc.params.targetDir as string
      if (tc.params?.target_dir) return tc.params.target_dir as string
    }
  }
  
  for (let i = 0; i < 10; i++) {
    const workerDir = `/tmp/shogo-eval-worker-${i}`
    if (existsSync(join(workerDir, 'prisma/schema.prisma'))) {
      return workerDir
    }
  }
  
  if (existsSync('/tmp/shogo-eval-test/prisma/schema.prisma')) {
    return '/tmp/shogo-eval-test'
  }
  
  return null
}

function createUsedTemplateCriterion(templateName: string, points: number): ValidationCriterion {
  return {
    id: 'used-template',
    description: `Used template.copy with ${templateName} template`,
    points,
    phase: 'intention',
    validate: (result) => {
      const copyCall = result.toolCalls.find(t => t.name === 'template.copy')
      if (copyCall?.params?.template === templateName) return true
      
      const projectDir = getProjectDir(result)
      if (!projectDir) return false
      return existsSync(join(projectDir, 'prisma/schema.prisma'))
    },
  }
}

/**
 * Read the main UI source file(s) content.
 * Templates use src/App.tsx as the primary UI file, but the agent may also
 * write components in src/components/ or (rarely) src/routes/index.tsx.
 * This helper reads ALL candidate files and concatenates their contents.
 */
function readUISourceContent(projectDir: string): string | null {
  const candidates = [
    'src/App.tsx',
    'src/routes/index.tsx',
  ]
  
  let combined = ''
  for (const candidate of candidates) {
    const fullPath = join(projectDir, candidate)
    if (existsSync(fullPath)) {
      combined += readFileSync(fullPath, 'utf-8') + '\n'
    }
  }
  
  // Also scan src/components/ for any .tsx files that import from @/components/ui/
  const componentsDir = join(projectDir, 'src/components')
  if (existsSync(componentsDir)) {
    try {
      const files = readdirSync(componentsDir, { recursive: true }) as string[]
      for (const file of files) {
        if (typeof file === 'string' && file.endsWith('.tsx')) {
          const fullPath = join(componentsDir, file)
          try {
            combined += readFileSync(fullPath, 'utf-8') + '\n'
          } catch {}
        }
      }
    } catch {}
  }
  
  return combined || null
}

/**
 * Check that the agent ran `bunx shadcn@latest add <component>` via shell
 */
function createRanShadcnAddCriterion(
  componentNames: string[],
  points: number,
  description: string,
): ValidationCriterion {
  return {
    id: `ran-shadcn-add-${componentNames.join('-')}`,
    description,
    points,
    phase: 'execution',
    validate: (result) => {
      return result.toolCalls.some(tc => {
        const name = tc.name.toLowerCase()
        if (name === 'bash' || name === 'shell') {
          const command = String(tc.params?.command || '').toLowerCase()
          // Match: bunx shadcn add, bunx shadcn@latest add, npx shadcn add, etc.
          const isShadcnAdd = command.includes('shadcn') && command.includes('add')
          if (!isShadcnAdd) return false
          
          // Check if at least one of the expected components is in the command
          return componentNames.some(comp => command.includes(comp.toLowerCase()))
        }
        return false
      })
    },
  }
}

/**
 * Check that the agent ran ANY `bunx shadcn@latest add` command
 */
function createRanAnyShadcnAddCriterion(points: number): ValidationCriterion {
  return {
    id: 'ran-any-shadcn-add',
    description: 'Ran bunx shadcn@latest add to install components',
    points,
    phase: 'execution',
    validate: (result) => {
      return result.toolCalls.some(tc => {
        const name = tc.name.toLowerCase()
        if (name === 'bash' || name === 'shell') {
          const command = String(tc.params?.command || '').toLowerCase()
          return command.includes('shadcn') && command.includes('add')
        }
        return false
      })
    },
  }
}

/**
 * Check that UI source files import from @/components/ui/
 * Searches src/App.tsx, src/routes/index.tsx, and src/components/ recursively
 */
function createShadcnImportCriterion(
  _filePath: string,
  componentImport: string | RegExp,
  points: number,
  description: string,
): ValidationCriterion {
  return {
    id: `shadcn-import-${_filePath.replace(/\//g, '-')}`,
    description,
    points,
    phase: 'execution',
    validate: (result) => {
      const projectDir = getProjectDir(result)
      if (!projectDir) return false
      
      const content = readUISourceContent(projectDir)
      if (!content) return false
      
      if (typeof componentImport === 'string') {
        return content.includes(componentImport)
      }
      return componentImport.test(content)
    },
  }
}

/**
 * Check that a shadcn component file was installed
 */
function createShadcnComponentExistsCriterion(
  componentName: string,
  points: number,
): ValidationCriterion {
  return {
    id: `shadcn-component-exists-${componentName}`,
    description: `shadcn ${componentName} component was installed`,
    points,
    phase: 'execution',
    validate: (result) => {
      const projectDir = getProjectDir(result)
      if (!projectDir) return false
      
      return existsSync(join(projectDir, `src/components/ui/${componentName}.tsx`))
    },
  }
}

function createRanPrismaGenerateCriterion(points: number): ValidationCriterion {
  return {
    id: 'ran-prisma-generate',
    description: 'Ran prisma generate/db push after schema changes',
    points,
    phase: 'execution',
    validate: (result) => {
      return result.toolCalls.some(tc => {
        const name = tc.name.toLowerCase()
        if (name === 'bash' || name === 'shell') {
          const command = String(tc.params?.command || '').toLowerCase()
          return command.includes('prisma generate') || 
                 command.includes('prisma db push') ||
                 command.includes('prisma migrate')
        }
        return false
      })
    },
  }
}

// ============================================
// shadcn Evals - Component Installation
// ============================================

/**
 * LEVEL 4: Display data in a table using shadcn Table
 * 
 * Tests: agent uses `bunx shadcn@latest add table` and imports Table components
 */
export const EVAL_SHADCN_DATA_TABLE: AgentEval = {
  id: 'shadcn-data-table',
  name: 'shadcn: Data Table for Products',
  category: 'multi-turn',
  level: 4,
  input: 'Build an inventory tracker. Display all products in a clean data table with columns for name, price, and quantity.',
  expectedTemplate: 'inventory',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'inventory' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('inventory', 15),
    createRanShadcnAddCriterion(
      ['table'],
      25,
      'Ran bunx shadcn@latest add table'
    ),
    createShadcnComponentExistsCriterion('table', 10),
    createShadcnImportCriterion(
      'src/routes/index.tsx',
      /@\/components\/ui\/table/,
      25,
      'Imported Table components from @/components/ui/table'
    ),
    {
      id: 'uses-table-components',
      description: 'Uses Table, TableHeader, TableRow, TableCell components',
      points: 25,
      phase: 'execution' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const content = readUISourceContent(projectDir)
        if (!content) return false
        
        return /Table/.test(content) && /TableRow|TableCell|TableHeader/i.test(content)
      },
    },
  ],
  antiPatterns: [
    'Hand-coding a table with raw HTML <table> tags instead of shadcn',
    'Not running shadcn add before using Table components',
  ],
  maxScore: 100,
}

/**
 * LEVEL 4: Add a create dialog using shadcn Dialog
 * 
 * Tests: agent uses `bunx shadcn@latest add dialog` for modal forms
 */
export const EVAL_SHADCN_CREATE_DIALOG: AgentEval = {
  id: 'shadcn-create-dialog',
  name: 'shadcn: Create Item Dialog',
  category: 'multi-turn',
  level: 4,
  input: 'Build a todo app with a modal dialog for creating new todos instead of an inline form.',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'todo-app' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('todo-app', 15),
    createRanShadcnAddCriterion(
      ['dialog'],
      25,
      'Ran bunx shadcn@latest add dialog'
    ),
    createShadcnImportCriterion(
      'src/routes/index.tsx',
      /@\/components\/ui\/dialog/,
      25,
      'Imported Dialog components from @/components/ui/dialog'
    ),
    {
      id: 'uses-dialog-components',
      description: 'Uses Dialog, DialogContent, DialogTrigger components',
      points: 20,
      phase: 'execution' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const content = readUISourceContent(projectDir)
        if (!content) return false
        
        return /Dialog/.test(content) && /DialogContent|DialogTrigger/i.test(content)
      },
    },
    {
      id: 'no-window-prompt',
      description: 'Did not use window.prompt or window.confirm instead of shadcn Dialog',
      points: 15,
      phase: 'intention' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const content = readUISourceContent(projectDir)
        if (!content) return false
        
        return !content.includes('window.prompt') && !content.includes('window.confirm')
      },
    },
  ],
  antiPatterns: [
    'Using window.prompt() or window.confirm() instead of shadcn Dialog',
    'Hand-coding a modal from scratch without shadcn',
  ],
  maxScore: 100,
}

/**
 * LEVEL 4: Add status badges using shadcn Badge
 * 
 * Tests: agent uses Badge component for status indicators
 */
export const EVAL_SHADCN_STATUS_BADGES: AgentEval = {
  id: 'shadcn-status-badges',
  name: 'shadcn: Status Badges',
  category: 'multi-turn',
  level: 4,
  input: 'Build a todo app and add a priority field (low, medium, high). Show the priority as colored badges next to each todo.',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'todo-app' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('todo-app', 10),
    createRanShadcnAddCriterion(
      ['badge'],
      20,
      'Ran bunx shadcn@latest add badge'
    ),
    createShadcnImportCriterion(
      'src/routes/index.tsx',
      /@\/components\/ui\/badge/,
      20,
      'Imported Badge from @/components/ui/badge'
    ),
    {
      id: 'schema-has-priority',
      description: 'Added priority field to Prisma schema',
      points: 15,
      phase: 'execution' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const schemaPath = join(projectDir, 'prisma/schema.prisma')
        if (!existsSync(schemaPath)) return false
        
        const content = readFileSync(schemaPath, 'utf-8')
        return /priority/i.test(content)
      },
    },
    createRanPrismaGenerateCriterion(10),
    {
      id: 'uses-badge-component',
      description: 'Uses Badge component with variant or conditional styling',
      points: 25,
      phase: 'execution' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const content = readUISourceContent(projectDir)
        if (!content) return false
        
        return /Badge/.test(content) && /priority/i.test(content)
      },
    },
  ],
  antiPatterns: [
    'Using plain <span> tags instead of shadcn Badge',
    'Not installing Badge component before using it',
  ],
  maxScore: 100,
}

/**
 * LEVEL 5: Build a form with multiple shadcn components
 * 
 * Tests: agent combines multiple shadcn components (Input, Label, Select, Button)
 */
export const EVAL_SHADCN_FORM_COMPONENTS: AgentEval = {
  id: 'shadcn-form-components',
  name: 'shadcn: Multi-Component Form',
  category: 'multi-turn',
  level: 5,
  input: 'Build a CRM. Add a form to create new contacts with fields for name, email, phone, and a dropdown to select their company. Use proper form components, not just plain inputs.',
  expectedTemplate: 'crm',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'crm' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 10),
    createRanAnyShadcnAddCriterion(20),
    {
      id: 'has-input-import',
      description: 'Uses shadcn Input component',
      points: 15,
      phase: 'execution' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const content = readUISourceContent(projectDir)
        if (!content) return false
        
        return /@\/components\/ui\/input/.test(content) || /from.*["'].*\/ui\/input/.test(content)
      },
    },
    {
      id: 'has-label-import',
      description: 'Uses shadcn Label component',
      points: 10,
      phase: 'execution' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const content = readUISourceContent(projectDir)
        if (!content) return false
        
        return /@\/components\/ui\/label/.test(content) || /from.*["'].*\/ui\/label/.test(content)
      },
    },
    {
      id: 'has-select-import',
      description: 'Uses shadcn Select component for company dropdown',
      points: 20,
      phase: 'execution' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const content = readUISourceContent(projectDir)
        if (!content) return false
        
        return (/@\/components\/ui\/select/.test(content) || /from.*["'].*\/ui\/select/.test(content)) &&
               /company/i.test(content)
      },
    },
    {
      id: 'has-button-usage',
      description: 'Uses shadcn Button component for form submit',
      points: 10,
      phase: 'execution' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const content = readUISourceContent(projectDir)
        if (!content) return false
        
        return /@\/components\/ui\/button/.test(content) || /from.*["'].*\/ui\/button/.test(content)
      },
    },
    {
      id: 'no-plain-html-inputs',
      description: 'Did not use plain <input> without shadcn wrapper',
      points: 15,
      phase: 'intention' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const content = readUISourceContent(projectDir)
        if (!content) return false
        
        // Check that most inputs use shadcn Input, not raw <input>
        const rawInputCount = (content.match(/<input\s/g) || []).length
        const shadcnInputCount = (content.match(/<Input\s/g) || []).length
        // Allow some raw inputs (e.g., hidden fields), but shadcn should dominate
        return shadcnInputCount >= rawInputCount
      },
    },
  ],
  antiPatterns: [
    'Using plain <input> and <select> tags instead of shadcn components',
    'Not running shadcn add to install needed components',
    'Hand-coding a dropdown instead of using shadcn Select',
  ],
  maxScore: 100,
}

/**
 * LEVEL 4: Use shadcn Card for item display
 * 
 * Tests: agent uses Card components for content containers
 */
export const EVAL_SHADCN_CARD_LAYOUT: AgentEval = {
  id: 'shadcn-card-layout',
  name: 'shadcn: Card-Based Layout',
  category: 'multi-turn',
  level: 4,
  input: 'Build an expense tracker. Display each expense as a card showing the amount, category, and date. Make it look professional.',
  expectedTemplate: 'expense-tracker',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'expense-tracker' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('expense-tracker', 15),
    createRanShadcnAddCriterion(
      ['card'],
      20,
      'Ran bunx shadcn@latest add card'
    ),
    createShadcnImportCriterion(
      'src/routes/index.tsx',
      /@\/components\/ui\/card/,
      25,
      'Imported Card components from @/components/ui/card'
    ),
    {
      id: 'uses-card-components',
      description: 'Uses Card, CardContent, CardHeader or CardTitle components',
      points: 25,
      phase: 'execution' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const content = readUISourceContent(projectDir)
        if (!content) return false
        
        return /Card/.test(content) && /CardContent|CardHeader|CardTitle/i.test(content)
      },
    },
    {
      id: 'shows-expense-data',
      description: 'Card displays amount, category, and date',
      points: 15,
      phase: 'execution' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const content = readUISourceContent(projectDir)
        if (!content) return false
        
        return /amount/i.test(content) && /category/i.test(content)
      },
    },
  ],
  antiPatterns: [
    'Using plain <div> with manual styling instead of shadcn Card',
    'Not installing Card component before using it',
  ],
  maxScore: 100,
}

/**
 * LEVEL 5: Delete confirmation with shadcn AlertDialog
 * 
 * Tests: agent uses AlertDialog (not window.confirm) for destructive action confirmation
 */
export const EVAL_SHADCN_ALERT_DIALOG: AgentEval = {
  id: 'shadcn-alert-dialog',
  name: 'shadcn: Delete Confirmation AlertDialog',
  category: 'multi-turn',
  level: 5,
  input: 'Build a todo app. When the user clicks delete, show a proper confirmation dialog (not a browser alert) asking "Are you sure?" with Cancel and Delete buttons.',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'todo-app' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('todo-app', 10),
    createRanShadcnAddCriterion(
      ['alert-dialog', 'dialog'],
      25,
      'Ran bunx shadcn@latest add alert-dialog (or dialog)'
    ),
    {
      id: 'imports-alert-dialog',
      description: 'Imported AlertDialog or Dialog from shadcn',
      points: 25,
      phase: 'execution' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const content = readUISourceContent(projectDir)
        if (!content) return false
        
        return /@\/components\/ui\/alert-dialog/.test(content) ||
               /@\/components\/ui\/dialog/.test(content)
      },
    },
    {
      id: 'no-browser-dialogs',
      description: 'Did NOT use window.confirm or window.alert',
      points: 25,
      phase: 'intention' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const content = readUISourceContent(projectDir)
        if (!content) return false
        
        return !content.includes('window.confirm') && !content.includes('window.alert')
      },
    },
    {
      id: 'has-cancel-and-confirm',
      description: 'Dialog has both Cancel and Delete/Confirm actions',
      points: 15,
      phase: 'execution' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const content = readUISourceContent(projectDir)
        if (!content) return false
        
        const lower = content.toLowerCase()
        return (lower.includes('cancel') || lower.includes('nevermind')) &&
               (lower.includes('delete') || lower.includes('confirm') || lower.includes('remove'))
      },
    },
  ],
  antiPatterns: [
    'Using window.confirm() instead of shadcn AlertDialog',
    'Using window.alert() for any UI feedback',
    'Hand-coding a modal from scratch',
  ],
  maxScore: 100,
}

/**
 * LEVEL 5: Use Tabs for section navigation
 * 
 * Tests: agent uses shadcn Tabs to organize different views
 */
export const EVAL_SHADCN_TABS_NAVIGATION: AgentEval = {
  id: 'shadcn-tabs-navigation',
  name: 'shadcn: Tabs for Multi-View',
  category: 'multi-turn',
  level: 5,
  input: 'Build a CRM. I want tabs to switch between viewing Contacts, Companies, and Deals - all on the same page.',
  expectedTemplate: 'crm',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'crm' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 10),
    createRanShadcnAddCriterion(
      ['tabs'],
      25,
      'Ran bunx shadcn@latest add tabs'
    ),
    createShadcnImportCriterion(
      'src/routes/index.tsx',
      /@\/components\/ui\/tabs/,
      25,
      'Imported Tabs components from @/components/ui/tabs'
    ),
    {
      id: 'uses-tabs-components',
      description: 'Uses Tabs, TabsList, TabsTrigger, TabsContent',
      points: 25,
      phase: 'execution' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const content = readUISourceContent(projectDir)
        if (!content) return false
        
        return /Tabs/.test(content) && 
               (/TabsList|TabsTrigger|TabsContent/.test(content))
      },
    },
    {
      id: 'has-multiple-tab-views',
      description: 'Has at least 2 distinct tab content sections',
      points: 15,
      phase: 'execution' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const content = readUISourceContent(projectDir)
        if (!content) return false
        
        const tabContentCount = (content.match(/TabsContent/g) || []).length
        return tabContentCount >= 2
      },
    },
  ],
  antiPatterns: [
    'Using manual state + conditional rendering instead of shadcn Tabs',
    'Creating separate pages instead of tabs on the same page',
  ],
  maxScore: 100,
}

/**
 * LEVEL 4: General test - agent should use shadcn CLI for ANY UI customization
 * 
 * Broad test that the agent's instinct is to reach for shadcn
 */
export const EVAL_SHADCN_GENERAL_USAGE: AgentEval = {
  id: 'shadcn-general-usage',
  name: 'shadcn: General CLI Usage Pattern',
  category: 'tool-usage',
  level: 4,
  input: 'Build a kanban board. Customize it with a nice dropdown menu for each card that lets users move cards between columns, edit the card, or delete it.',
  expectedTemplate: 'kanban',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'kanban' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('kanban', 10),
    createRanAnyShadcnAddCriterion(30),
    {
      id: 'imports-from-ui',
      description: 'Imports components from @/components/ui/',
      points: 30,
      phase: 'execution' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const content = readUISourceContent(projectDir)
        if (!content) return false
        
        return /@\/components\/ui\//.test(content)
      },
    },
    {
      id: 'dropdown-functionality',
      description: 'Has dropdown/menu with edit, move, and delete actions',
      points: 30,
      phase: 'execution' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const content = readUISourceContent(projectDir)
        if (!content) return false
        
        const lower = content.toLowerCase()
        return (lower.includes('dropdown') || lower.includes('menu')) &&
               (lower.includes('edit') || lower.includes('move') || lower.includes('delete'))
      },
    },
  ],
  antiPatterns: [
    'Building dropdown menu from scratch with useState and CSS',
    'Not using any shadcn components for new UI',
  ],
  maxScore: 100,
}

// ============================================
// Export all shadcn evals
// ============================================

export const ALL_SHADCN_EVALS: AgentEval[] = [
  // Component-specific tests
  EVAL_SHADCN_DATA_TABLE,
  EVAL_SHADCN_CREATE_DIALOG,
  EVAL_SHADCN_STATUS_BADGES,
  EVAL_SHADCN_CARD_LAYOUT,
  EVAL_SHADCN_ALERT_DIALOG,
  EVAL_SHADCN_TABS_NAVIGATION,
  // Form composition
  EVAL_SHADCN_FORM_COMPONENTS,
  // General usage
  EVAL_SHADCN_GENERAL_USAGE,
]

export const SHADCN_COMPONENT_EVALS = ALL_SHADCN_EVALS.filter(e =>
  e.validationCriteria.some(c => c.id.startsWith('ran-shadcn-add-'))
)

export const SHADCN_IMPORT_EVALS = ALL_SHADCN_EVALS.filter(e =>
  e.validationCriteria.some(c => c.id.startsWith('shadcn-import-'))
)
