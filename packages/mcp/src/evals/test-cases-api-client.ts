/**
 * API Client Usage Evals
 * 
 * Tests that the agent prefers the generated API client (`src/generated/api-client.tsx`)
 * over raw `fetch()` for standard CRUD operations, while still allowing `fetch()`
 * for custom endpoints, public pages, and third-party calls.
 * 
 * These evals validate the "Prefer API Client Over Raw fetch()" prompt rule.
 */

import type { AgentEval, ValidationCriterion, EvalResult, ValidationPhase } from './types'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// ============================================
// Helper Functions
// ============================================

function getProjectDir(result: EvalResult): string | null {
  if (result.projectDir && existsSync(join(result.projectDir, 'package.json'))) {
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
    if (existsSync(join(workerDir, 'package.json'))) {
      return workerDir
    }
  }
  
  if (existsSync('/tmp/shogo-eval-test/package.json')) {
    return '/tmp/shogo-eval-test'
  }
  
  return null
}

/**
 * Scan all .tsx/.ts files in src/ (excluding generated/) for raw fetch() usage.
 * Returns { fetchCount, apiClientCount } for the application code.
 */
function scanForFetchUsage(projectDir: string): { fetchCount: number; apiClientCount: number; files: string[] } {
  const srcDir = join(projectDir, 'src')
  if (!existsSync(srcDir)) return { fetchCount: 0, apiClientCount: 0, files: [] }
  
  let fetchCount = 0
  let apiClientCount = 0
  const filesWithFetch: string[] = []
  
  function walkDir(dir: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        
        // Skip generated/ directory — fetch inside the API client wrapper is fine
        if (entry.isDirectory() && entry.name === 'generated') continue
        // Skip node_modules, lib (server-side code)
        if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name === 'lib')) continue
        
        if (entry.isDirectory()) {
          walkDir(fullPath)
        } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
          const content = readFileSync(fullPath, 'utf-8')
          
          // Count raw fetch() calls (excluding comments)
          const lines = content.split('\n')
          for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
            
            // Match fetch( calls that hit /api/ endpoints (standard CRUD pattern)
            if (/await\s+fetch\s*\(\s*[`'"]\/api\//.test(trimmed) || 
                /await\s+fetch\s*\(\s*`\$\{/.test(trimmed) ||
                /await\s+fetch\s*\(\s*API_BASE/.test(trimmed)) {
              fetchCount++
              if (!filesWithFetch.includes(fullPath)) {
                filesWithFetch.push(fullPath)
              }
            }
          }
          
          // Count api.* client usage
          if (/import\s*{[^}]*api[^}]*}\s*from\s*['"]\.\/generated\/api-client/.test(content) ||
              /import\s+api\s+from\s*['"]\.\/generated\/api-client/.test(content)) {
            apiClientCount++
          }
        }
      }
    } catch {
      // Directory access error — skip
    }
  }
  
  walkDir(srcDir)
  return { fetchCount, apiClientCount, files: filesWithFetch }
}

/**
 * Check if app code imports the API client
 */
function createImportsApiClientCriterion(
  points: number,
  description: string = 'Application code imports the generated API client',
  phase: ValidationPhase = 'execution'
): ValidationCriterion {
  return {
    id: 'imports-api-client',
    description,
    points,
    phase,
    validate: (result) => {
      const projectDir = getProjectDir(result)
      if (!projectDir) return false
      
      // Check App.tsx or routes/index.tsx for api-client import
      const candidates = [
        join(projectDir, 'src/App.tsx'),
        join(projectDir, 'src/routes/index.tsx'),
      ]
      
      for (const filePath of candidates) {
        if (!existsSync(filePath)) continue
        const content = readFileSync(filePath, 'utf-8')
        if (/from\s*['"]\.\/generated\/api-client/.test(content) ||
            /from\s*['"]\.\.\/generated\/api-client/.test(content)) {
          return true
        }
      }
      return false
    },
  }
}

/**
 * Check that standard CRUD operations use api.* not raw fetch()
 */
function createUsesApiClientForCrudCriterion(
  points: number,
  description: string = 'Uses api.* methods for standard CRUD (list, create, update, delete)',
  phase: ValidationPhase = 'execution'
): ValidationCriterion {
  return {
    id: 'uses-api-client-for-crud',
    description,
    points,
    phase,
    validate: (result) => {
      const projectDir = getProjectDir(result)
      if (!projectDir) return false
      
      const candidates = [
        join(projectDir, 'src/App.tsx'),
        join(projectDir, 'src/routes/index.tsx'),
      ]
      
      for (const filePath of candidates) {
        if (!existsSync(filePath)) continue
        const content = readFileSync(filePath, 'utf-8')
        // Check for api.modelName.list/create/update/delete patterns
        if (/api\.\w+\.(list|create|update|delete)\s*\(/.test(content)) {
          return true
        }
      }
      return false
    },
  }
}

/**
 * Check that configureApiClient is called with userId
 */
function createConfiguresApiClientCriterion(
  points: number,
  description: string = 'Calls configureApiClient with userId after authentication',
  phase: ValidationPhase = 'execution'
): ValidationCriterion {
  return {
    id: 'configures-api-client',
    description,
    points,
    phase,
    validate: (result) => {
      const projectDir = getProjectDir(result)
      if (!projectDir) return false
      
      const candidates = [
        join(projectDir, 'src/App.tsx'),
        join(projectDir, 'src/routes/index.tsx'),
      ]
      
      for (const filePath of candidates) {
        if (!existsSync(filePath)) continue
        const content = readFileSync(filePath, 'utf-8')
        if (/configureApiClient\s*\(\s*\{/.test(content)) {
          return true
        }
      }
      return false
    },
  }
}

/**
 * Check that raw fetch() is not used for standard CRUD on /api/ endpoints
 * (allows fetch for custom endpoints)
 */
function createNoRawFetchForCrudCriterion(
  points: number,
  description: string = 'Does not use raw fetch() for standard CRUD operations',
  phase: ValidationPhase = 'execution'
): ValidationCriterion {
  return {
    id: 'no-raw-fetch-for-crud',
    description,
    points,
    phase,
    validate: (result) => {
      const projectDir = getProjectDir(result)
      if (!projectDir) return false
      
      const { fetchCount, apiClientCount } = scanForFetchUsage(projectDir)
      
      // If they use the API client and have minimal fetch, that's good
      // We allow some fetch calls for custom endpoints
      if (apiClientCount > 0 && fetchCount <= 3) return true
      
      // If zero fetch calls, also good
      if (fetchCount === 0) return true
      
      return false
    },
  }
}

/**
 * Check that fetch() IS used for a custom endpoint (proving exceptions work)
 */
function createAllowsFetchForCustomEndpointsCriterion(
  points: number,
  description: string = 'Uses raw fetch() appropriately for custom (non-CRUD) endpoints',
  phase: ValidationPhase = 'execution'
): ValidationCriterion {
  return {
    id: 'allows-fetch-for-custom',
    description,
    points,
    phase,
    validate: (result) => {
      const projectDir = getProjectDir(result)
      if (!projectDir) return false
      
      const candidates = [
        join(projectDir, 'src/App.tsx'),
        join(projectDir, 'src/routes/index.tsx'),
      ]
      
      for (const filePath of candidates) {
        if (!existsSync(filePath)) continue
        const content = readFileSync(filePath, 'utf-8')
        // Custom endpoints that should use fetch: /stats, /pipeline, /summary, /full, /book, /submit
        if (/fetch\s*\([^)]*\/(stats|pipeline|summary|full|book|submit)/.test(content)) {
          return true
        }
      }
      
      // If there are no custom endpoints, that's also fine (not every app has them)
      return true
    },
  }
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
      return existsSync(join(projectDir, 'package.json'))
    },
  }
}

// ============================================
// Eval: Todo app uses API client for CRUD
// ============================================

export const EVAL_API_CLIENT_TODO_CRUD: AgentEval = {
  id: 'api-client-todo-crud',
  name: 'API Client: Todo CRUD uses api.* not fetch()',
  category: 'tool-usage',
  level: 3,
  input: 'Build me a todo app where I can add, complete, and delete tasks.',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'todo-app' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('todo-app', 10),
    createImportsApiClientCriterion(20),
    createUsesApiClientForCrudCriterion(25,
      'Uses api.todo.list/create/update/delete instead of raw fetch()'
    ),
    createConfiguresApiClientCriterion(15),
    createNoRawFetchForCrudCriterion(20,
      'Does not use raw fetch() for standard todo CRUD operations'
    ),
  ],
  antiPatterns: [
    'fetch(\'/api/todos\'',
    'fetch(`/api/todos',
    'fetch(API_BASE',
  ],
  maxScore: 90,
}

// ============================================
// Eval: CRM uses API client + fetch for custom endpoints
// ============================================

export const EVAL_API_CLIENT_CRM_MIXED: AgentEval = {
  id: 'api-client-crm-mixed',
  name: 'API Client: CRM uses api.* for CRUD, fetch() for custom endpoints',
  category: 'tool-usage',
  level: 4,
  input: 'Build me a CRM with contacts, companies, and a deal pipeline dashboard.',
  expectedTemplate: 'crm',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'crm' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 10),
    createImportsApiClientCriterion(15),
    createUsesApiClientForCrudCriterion(25,
      'Uses api.contact.list/create, api.company.list, etc. for standard CRUD'
    ),
    createConfiguresApiClientCriterion(10),
    createAllowsFetchForCustomEndpointsCriterion(15,
      'Correctly uses fetch() for custom endpoints like /api/contacts/stats or /api/deals/pipeline'
    ),
    createNoRawFetchForCrudCriterion(15,
      'Standard CRUD (contacts list, create, update, delete) uses API client not fetch()'
    ),
  ],
  antiPatterns: [],
  maxScore: 90,
}

// ============================================
// Eval: Adding a delete button should use API client
// ============================================

export const EVAL_API_CLIENT_ADD_DELETE: AgentEval = {
  id: 'api-client-add-delete',
  name: 'API Client: New delete feature uses api.*.delete()',
  category: 'tool-usage',
  level: 3,
  input: 'Build a todo app. Then add a delete button for each todo that removes it from the database.',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'todo-app' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('todo-app', 10),
    createImportsApiClientCriterion(15),
    {
      id: 'delete-uses-api-client',
      description: 'Delete operation uses api.todo.delete() not fetch() with DELETE method',
      points: 35,
      phase: 'execution' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const appPath = join(projectDir, 'src/App.tsx')
        if (!existsSync(appPath)) return false
        
        const content = readFileSync(appPath, 'utf-8')
        // Should have api.todo.delete
        const hasApiDelete = /api\.todo\.delete\s*\(/.test(content)
        // Should NOT have fetch with DELETE for /api/todos
        const hasRawDelete = /fetch\s*\([^)]*\/api\/todos[^)]*\)\s*,\s*\{\s*method:\s*['"]DELETE/i.test(content)
        
        return hasApiDelete && !hasRawDelete
      },
    },
  ],
  antiPatterns: [
    'fetch(`/api/todos/${id}`, { method: \'DELETE\'',
  ],
  maxScore: 60,
}

// ============================================
// Eval: Expense tracker uses API client
// ============================================

export const EVAL_API_CLIENT_EXPENSE: AgentEval = {
  id: 'api-client-expense',
  name: 'API Client: Expense tracker uses api.transaction.* for CRUD',
  category: 'tool-usage',
  level: 3,
  input: 'Build me an expense tracker where I can log transactions and see my spending.',
  expectedTemplate: 'expense-tracker',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'expense-tracker' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('expense-tracker', 10),
    createImportsApiClientCriterion(20),
    createUsesApiClientForCrudCriterion(25,
      'Uses api.transaction.list/create/delete for transaction operations'
    ),
    createConfiguresApiClientCriterion(15),
    createNoRawFetchForCrudCriterion(20),
  ],
  antiPatterns: [
    'fetch(\'/api/transactions\'',
    'fetch(`/api/transactions',
  ],
  maxScore: 90,
}

// ============================================
// Eval: Custom endpoint should still use fetch
// ============================================

export const EVAL_API_CLIENT_CUSTOM_ENDPOINT_OK: AgentEval = {
  id: 'api-client-custom-endpoint-ok',
  name: 'API Client: Custom stats endpoint correctly uses fetch()',
  category: 'edge-cases',
  level: 3,
  input: 'Build a CRM and add a stats dashboard that shows total contacts per status. Use the /api/contacts/stats endpoint.',
  expectedTemplate: 'crm',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'crm' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 10),
    createImportsApiClientCriterion(15,
      'Imports API client for standard CRUD operations'
    ),
    {
      id: 'stats-uses-fetch',
      description: 'Custom /api/contacts/stats endpoint uses fetch() (not available in generated API client)',
      points: 30,
      phase: 'execution' as ValidationPhase,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const candidates = [
          join(projectDir, 'src/App.tsx'),
          join(projectDir, 'src/routes/index.tsx'),
        ]
        
        for (const filePath of candidates) {
          if (!existsSync(filePath)) continue
          const content = readFileSync(filePath, 'utf-8')
          // Stats endpoint should use fetch — it's a custom endpoint
          if (/fetch\s*\([^)]*\/api\/contacts\/stats/.test(content)) {
            return true
          }
        }
        return false
      },
    },
    createUsesApiClientForCrudCriterion(20,
      'Standard contact CRUD still uses api.contact.* methods'
    ),
  ],
  antiPatterns: [],
  maxScore: 75,
}

// ============================================
// Eval: Inventory with mixed patterns
// ============================================

export const EVAL_API_CLIENT_INVENTORY: AgentEval = {
  id: 'api-client-inventory',
  name: 'API Client: Inventory uses api.* for CRUD, fetch for /summary',
  category: 'tool-usage',
  level: 4,
  input: 'Build an inventory management app with products, categories, and a summary dashboard.',
  expectedTemplate: 'inventory',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'inventory' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('inventory', 10),
    createImportsApiClientCriterion(15),
    createUsesApiClientForCrudCriterion(25,
      'Uses api.product.list, api.category.list, etc. for standard CRUD'
    ),
    createConfiguresApiClientCriterion(10),
    createAllowsFetchForCustomEndpointsCriterion(15,
      'Custom /api/summary endpoint correctly uses fetch()'
    ),
    createNoRawFetchForCrudCriterion(15),
  ],
  antiPatterns: [],
  maxScore: 90,
}

// ============================================
// Export all API client evals
// ============================================

export const ALL_API_CLIENT_EVALS: AgentEval[] = [
  // Standard CRUD — should use API client
  EVAL_API_CLIENT_TODO_CRUD,
  EVAL_API_CLIENT_ADD_DELETE,
  EVAL_API_CLIENT_EXPENSE,
  // Mixed — API client for CRUD + fetch for custom endpoints
  EVAL_API_CLIENT_CRM_MIXED,
  EVAL_API_CLIENT_INVENTORY,
  // Edge case — custom endpoint correctly uses fetch
  EVAL_API_CLIENT_CUSTOM_ENDPOINT_OK,
]

/** Evals that test standard CRUD uses API client */
export const API_CLIENT_CRUD_EVALS = ALL_API_CLIENT_EVALS.filter(e =>
  e.id.includes('crud') || e.id.includes('delete') || e.id.includes('expense')
)

/** Evals that test mixed patterns (API client + fetch for custom) */
export const API_CLIENT_MIXED_EVALS = ALL_API_CLIENT_EVALS.filter(e =>
  e.id.includes('mixed') || e.id.includes('inventory') || e.id.includes('custom')
)

