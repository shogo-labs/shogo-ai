/**
 * Hard Test Cases for Shogo Agent Evals
 * 
 * These tests evaluate the agent's ability to:
 * 1. Modify existing apps (multi-turn conversations)
 * 2. Protect generated files (modify schema, not generated code)
 * 3. Make actual code changes that work
 * 4. Handle edge cases and negative patterns
 */

import type { AgentEval, ValidationCriterion, EvalResult } from './types'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// ============================================
// Helper: Get project directory from eval result
// ============================================

function getProjectDir(result: EvalResult): string | null {
  // Look for template.copy tool call result to find project dir
  const copyCall = result.toolCalls.find(t => t.name === 'template.copy')
  if (copyCall?.result && typeof copyCall.result === 'object') {
    const res = copyCall.result as Record<string, unknown>
    if (res.projectDir) return res.projectDir as string
  }
  // Fallback to eval mode test directory
  return process.env.PROJECT_DIR || '/tmp/shogo-eval-test'
}

// ============================================
// File Content Validators
// ============================================

/**
 * Check if a file contains specific content
 */
function createFileContainsCriterion(
  filePath: string,
  searchText: string | RegExp,
  points: number,
  description: string
): ValidationCriterion {
  return {
    id: `file-contains-${filePath.replace(/\//g, '-')}`,
    description,
    points,
    validate: (result) => {
      const projectDir = getProjectDir(result)
      if (!projectDir) return false
      
      const fullPath = join(projectDir, filePath)
      if (!existsSync(fullPath)) return false
      
      const content = readFileSync(fullPath, 'utf-8')
      if (typeof searchText === 'string') {
        return content.includes(searchText)
      }
      return searchText.test(content)
    },
  }
}

/**
 * Check that a file does NOT contain specific content
 */
function createFileNotContainsCriterion(
  filePath: string,
  searchText: string | RegExp,
  points: number,
  description: string
): ValidationCriterion {
  return {
    id: `file-not-contains-${filePath.replace(/\//g, '-')}`,
    description,
    points,
    validate: (result) => {
      const projectDir = getProjectDir(result)
      if (!projectDir) return false
      
      const fullPath = join(projectDir, filePath)
      if (!existsSync(fullPath)) return true // File doesn't exist = doesn't contain
      
      const content = readFileSync(fullPath, 'utf-8')
      if (typeof searchText === 'string') {
        return !content.includes(searchText)
      }
      return !searchText.test(content)
    },
  }
}

/**
 * Check that agent didn't modify generated files directly
 * (by looking for specific tool calls that write to generated/ paths)
 */
function createNoGeneratedFileEditsCriterion(points: number): ValidationCriterion {
  return {
    id: 'no-generated-file-edits',
    description: 'Did not directly edit files in src/generated/',
    points,
    validate: (result) => {
      // Look for Write/Edit/StrReplace calls to generated paths
      const badEdits = result.toolCalls.filter(tc => {
        const name = tc.name.toLowerCase()
        if (name === 'write' || name === 'edit' || name === 'strreplace' || name === 'str_replace') {
          const path = String(tc.params?.path || tc.params?.file || tc.params?.file_path || '')
          return path.includes('/generated/') || path.includes('\\generated\\')
        }
        return false
      })
      
      if (badEdits.length > 0) {
        console.log(`    ⚠️  Agent edited generated files: ${badEdits.map(e => e.params?.file_path || e.params?.path || e.params?.file).join(', ')}`)
      }
      
      return badEdits.length === 0
    },
  }
}

/**
 * Check that agent modified the Prisma schema
 * (only checks file content - tool calls may not always be captured)
 */
function createSchemaModifiedCriterion(
  expectedContent: string | RegExp,
  points: number,
  description: string
): ValidationCriterion {
  return {
    id: 'schema-modified',
    description,
    points,
    validate: (result) => {
      // Just verify schema contains expected content
      // (tool calls may not always be captured properly)
      const projectDir = getProjectDir(result)
      if (!projectDir) return false
      
      const schemaPath = join(projectDir, 'prisma/schema.prisma')
      if (!existsSync(schemaPath)) return false
      
      const content = readFileSync(schemaPath, 'utf-8')
      if (typeof expectedContent === 'string') {
        return content.includes(expectedContent)
      }
      return expectedContent.test(content)
    },
  }
}

/**
 * Check that agent ran prisma generate after schema changes
 */
function createRanPrismaGenerateCriterion(points: number): ValidationCriterion {
  return {
    id: 'ran-prisma-generate',
    description: 'Ran prisma generate after schema changes',
    points,
    validate: (result) => {
      // Check for shell command with prisma generate/db push
      // Support: prisma generate, bunx prisma generate, npx prisma generate, bun exec prisma generate
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

/**
 * Check that a source file (not generated) was modified
 */
function createSourceFileModifiedCriterion(
  filePath: string,
  expectedContent: string | RegExp,
  points: number,
  description: string
): ValidationCriterion {
  return {
    id: `source-modified-${filePath.replace(/\//g, '-')}`,
    description,
    points,
    validate: (result) => {
      const projectDir = getProjectDir(result)
      if (!projectDir) return false
      
      const fullPath = join(projectDir, filePath)
      if (!existsSync(fullPath)) return false
      
      const content = readFileSync(fullPath, 'utf-8')
      if (typeof expectedContent === 'string') {
        return content.includes(expectedContent)
      }
      return expectedContent.test(content)
    },
  }
}

// ============================================
// Hard Test Cases - Schema Modifications
// ============================================

/**
 * LEVEL 4: Add a priority field to todos
 * 
 * Expected behavior:
 * 1. Use template.copy for todo-app first
 * 2. Modify prisma/schema.prisma to add priority field
 * 3. Run prisma generate (or db push)
 * 4. Modify UI to display/set priority
 * 5. NOT modify src/generated/ files directly
 */
export const EVAL_ADD_PRIORITY_FIELD: AgentEval = {
  id: 'hard-add-priority-field',
  name: 'Hard: Add Priority Field to Todos',
  category: 'multi-turn',
  level: 4,
  input: 'Build me a todo app, then add a priority field (low, medium, high) to the todos so users can prioritize their tasks.',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'todo-app' }, required: true },
  ],
  validationCriteria: [
    // Must use template.copy first (check tool calls OR project existence)
    {
      id: 'used-template',
      description: 'Used template.copy to create todo app',
      points: 20,
      validate: (result) => {
        // Check tool calls
        const copyCall = result.toolCalls.find(t => t.name === 'template.copy')
        if (copyCall?.params?.template === 'todo-app') return true
        
        // Fallback: check if project was created with todo-app structure
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        // todo-app has these characteristic files
        const hasSchema = existsSync(join(projectDir, 'prisma/schema.prisma'))
        const hasRoutes = existsSync(join(projectDir, 'src/routes/index.tsx'))
        return hasSchema && hasRoutes
      },
    },
    // Must have priority in schema (check file content)
    {
      id: 'schema-has-priority',
      description: 'Added priority field to Prisma schema',
      points: 25,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const schemaPath = join(projectDir, 'prisma/schema.prisma')
        if (!existsSync(schemaPath)) return false
        
        const content = readFileSync(schemaPath, 'utf-8')
        // Check for priority field (enum or string)
        return /priority\s+(String|Priority|@default)/i.test(content) ||
               /enum\s+Priority/i.test(content)
      },
    },
    // Must NOT edit generated files
    createNoGeneratedFileEditsCriterion(25),
    // Check if prisma generate ran (look at generated files timestamp or tool calls)
    {
      id: 'prisma-regenerated',
      description: 'Prisma client was regenerated',
      points: 15,
      validate: (result) => {
        // Check tool calls first
        const ranGenerate = result.toolCalls.some(tc => {
          const name = tc.name.toLowerCase()
          if (name === 'bash' || name === 'shell') {
            const command = String(tc.params?.command || '')
            return command.includes('prisma generate') || command.includes('prisma db push')
          }
          return false
        })
        if (ranGenerate) return true
        
        // Fallback: check if generated files exist (they should if generate ran)
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        return existsSync(join(projectDir, 'src/generated/prisma/client.ts'))
      },
    },
    // Should modify UI to show priority
    createSourceFileModifiedCriterion(
      'src/routes/index.tsx',
      'priority',
      15,
      'Modified UI to display priority'
    ),
  ],
  antiPatterns: [
    'Editing files in src/generated/ directly',
    'Not running prisma generate after schema change',
    'Skipping the template and writing from scratch',
  ],
  maxScore: 100,
}

/**
 * LEVEL 4: Add due date to todos
 * 
 * Tests schema modification with DateTime field
 */
export const EVAL_ADD_DUE_DATE: AgentEval = {
  id: 'hard-add-due-date',
  name: 'Hard: Add Due Date to Todos',
  category: 'multi-turn',
  level: 4,
  input: 'Create a todo app with a due date field so I can set deadlines for my tasks.',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'todo-app' }, required: true },
  ],
  validationCriteria: [
    {
      id: 'used-template',
      description: 'Used template.copy to create todo app',
      points: 20,
      validate: (result) => {
        const copyCall = result.toolCalls.find(t => t.name === 'template.copy')
        return copyCall?.params?.template === 'todo-app'
      },
    },
    createSchemaModifiedCriterion(
      /dueDate|due_date.*DateTime/i,
      25,
      'Added dueDate DateTime field to Prisma schema'
    ),
    createNoGeneratedFileEditsCriterion(25),
    createRanPrismaGenerateCriterion(15),
    createSourceFileModifiedCriterion(
      'src/routes/index.tsx',
      /dueDate|due.*date/i,
      15,
      'Modified UI to show/set due date'
    ),
  ],
  antiPatterns: [
    'Editing generated Prisma client code',
    'Hardcoding due date without schema change',
  ],
  maxScore: 100,
}

// ============================================
// Hard Test Cases - Generated File Protection
// ============================================

/**
 * LEVEL 4: Trick test - ask to modify "the User model"
 * 
 * Agent should recognize this means modifying schema.prisma,
 * NOT the generated src/generated/prisma/models/User.ts
 */
export const EVAL_MODIFY_USER_MODEL: AgentEval = {
  id: 'hard-modify-user-model',
  name: 'Hard: Modify User Model (Protected)',
  category: 'multi-turn',
  level: 4,
  input: 'Build a todo app and then add a "role" field to the User model with values "admin" or "user".',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'todo-app' }, required: true },
  ],
  validationCriteria: [
    {
      id: 'used-template',
      description: 'Used template.copy to create todo app',
      points: 15,
      validate: (result) => {
        const copyCall = result.toolCalls.find(t => t.name === 'template.copy')
        return copyCall?.params?.template === 'todo-app'
      },
    },
    // MUST modify schema.prisma (role can be String or enum like Role/UserRole)
    createSchemaModifiedCriterion(
      /role\s+(\w+)/i,  // Match: role String, role Role, role UserRole, etc.
      30,
      'Added role field to User model in schema.prisma'
    ),
    // MUST NOT edit generated model file
    createNoGeneratedFileEditsCriterion(30),
    createRanPrismaGenerateCriterion(15),
    // Explain the generated file concept
    {
      id: 'explained-generated',
      description: 'Mentioned that generated files should not be edited',
      points: 10,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('generated') || 
               text.includes('schema.prisma') ||
               text.includes('prisma generate')
      },
    },
  ],
  antiPatterns: [
    'Directly editing src/generated/prisma/models/User.ts',
    'Not explaining the correct workflow',
  ],
  maxScore: 100,
}

/**
 * LEVEL 4: Request to "fix the types" 
 * 
 * Agent should NOT edit generated type files
 */
export const EVAL_DONT_EDIT_TYPES: AgentEval = {
  id: 'hard-dont-edit-types',
  name: 'Hard: Types Request (Should Modify Schema)',
  category: 'multi-turn',
  level: 4,
  input: 'Build a todo app. The Todo type is missing a "description" field. Please add it.',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'todo-app' }, required: true },
  ],
  validationCriteria: [
    {
      id: 'used-template',
      description: 'Used template.copy to create todo app',
      points: 15,
      validate: (result) => {
        const copyCall = result.toolCalls.find(t => t.name === 'template.copy')
        return copyCall?.params?.template === 'todo-app'
      },
    },
    // Should modify schema
    createSchemaModifiedCriterion(
      /description\s+String/,
      30,
      'Added description field to schema.prisma'
    ),
    // Must NOT edit generated types
    {
      id: 'no-types-edit',
      description: 'Did not directly edit src/generated/types.ts',
      points: 30,
      validate: (result) => {
        const badEdits = result.toolCalls.filter(tc => {
          const name = tc.name.toLowerCase()
          if (name === 'write' || name === 'edit' || name === 'strreplace' || name === 'str_replace') {
            const path = String(tc.params?.path || tc.params?.file || '')
            return path.includes('generated/types')
          }
          return false
        })
        return badEdits.length === 0
      },
    },
    createRanPrismaGenerateCriterion(15),
    createSourceFileModifiedCriterion(
      'src/routes/index.tsx',
      'description',
      10,
      'Updated UI to show description'
    ),
  ],
  antiPatterns: [
    'Editing src/generated/types.ts',
    'Editing src/generated/prisma/ files',
  ],
  maxScore: 100,
}

// ============================================
// Hard Test Cases - UI Modifications
// ============================================

/**
 * LEVEL 4: Change button color
 * 
 * Simple UI modification - should edit source file, not generated
 */
export const EVAL_CHANGE_BUTTON_COLOR: AgentEval = {
  id: 'hard-change-button-color',
  name: 'Hard: Change Add Button to Green',
  category: 'multi-turn',
  level: 4,
  input: 'Build a todo app and change the "Add" button to be green instead of blue.',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'todo-app' }, required: true },
  ],
  validationCriteria: [
    {
      id: 'used-template',
      description: 'Used template.copy to create todo app',
      points: 25,
      validate: (result) => {
        const copyCall = result.toolCalls.find(t => t.name === 'template.copy')
        return copyCall?.params?.template === 'todo-app'
      },
    },
    // Must modify route file with green color
    createSourceFileModifiedCriterion(
      'src/routes/index.tsx',
      /bg-green|green-[456]00|emerald-[456]00/,
      40,
      'Changed button to green color'
    ),
    // Original blue should be replaced
    createFileNotContainsCriterion(
      'src/routes/index.tsx',
      'bg-blue-600',
      20,
      'Removed original blue color from Add button'
    ),
    createNoGeneratedFileEditsCriterion(15),
  ],
  antiPatterns: [
    'Not actually changing the color',
    'Adding inline styles instead of Tailwind classes',
  ],
  maxScore: 100,
}

/**
 * LEVEL 4: Add confirmation dialog for delete
 * 
 * More complex UI modification
 */
export const EVAL_ADD_DELETE_CONFIRMATION: AgentEval = {
  id: 'hard-delete-confirmation',
  name: 'Hard: Add Delete Confirmation',
  category: 'multi-turn',
  level: 4,
  input: 'Create a todo app with a confirmation dialog when deleting tasks to prevent accidental deletions.',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'todo-app' }, required: true },
  ],
  validationCriteria: [
    {
      id: 'used-template',
      description: 'Used template.copy to create todo app',
      points: 20,
      validate: (result) => {
        const copyCall = result.toolCalls.find(t => t.name === 'template.copy')
        return copyCall?.params?.template === 'todo-app'
      },
    },
    // Should have confirm logic
    createSourceFileModifiedCriterion(
      'src/routes/index.tsx',
      /confirm|dialog|modal|window\.confirm/i,
      35,
      'Added confirmation dialog/logic'
    ),
    // Delete handler should be modified
    createSourceFileModifiedCriterion(
      'src/routes/index.tsx',
      /handleDelete.*confirm|confirm.*delete/i,
      25,
      'Modified delete handler to use confirmation'
    ),
    createNoGeneratedFileEditsCriterion(20),
  ],
  antiPatterns: [
    'Removing delete functionality entirely',
    'Not actually implementing confirmation',
  ],
  maxScore: 100,
}

// ============================================
// Hard Test Cases - Negative Tests
// ============================================

/**
 * LEVEL 4: Impossible request - nonexistent template feature
 * 
 * Agent should explain limitation, not hallucinate
 */
export const EVAL_IMPOSSIBLE_FEATURE: AgentEval = {
  id: 'hard-impossible-feature',
  name: 'Hard: Request Impossible Feature',
  category: 'edge-cases',
  level: 4,
  input: 'Build me a todo app with real-time collaboration and WebSocket sync built into the template.',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'todo-app' }, required: false },
  ],
  validationCriteria: [
    // Should still offer to build
    {
      id: 'offered-alternative',
      description: 'Offered to build todo app or explained limitations',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (text.includes('todo') && text.includes('template')) ||
               text.includes("doesn't include") ||
               text.includes('not built-in') ||
               text.includes('would need') ||
               text.includes('custom implementation')
      },
    },
    // Should be honest about limitations
    {
      id: 'honest-about-limitations',
      description: 'Was honest about template limitations',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('websocket') || 
               text.includes('real-time') ||
               text.includes('sync') ||
               text.includes('additional work') ||
               text.includes('would require')
      },
    },
    // Should not claim it has real-time
    {
      id: 'no-hallucination',
      description: 'Did not claim template has WebSocket support',
      points: 20,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        // Should NOT say "the template includes websocket" or similar
        return !(text.includes('template includes websocket') || 
                 text.includes('built-in real-time') ||
                 text.includes('already has sync'))
      },
    },
  ],
  antiPatterns: [
    'Claiming template has features it does not have',
    'Hallucinating WebSocket functionality',
  ],
  maxScore: 100,
}

/**
 * LEVEL 4: Request to bypass template system
 * 
 * Agent should still use templates, not write from scratch
 */
export const EVAL_BYPASS_TEMPLATE: AgentEval = {
  id: 'hard-bypass-template',
  name: 'Hard: Request to Write from Scratch',
  category: 'edge-cases',
  level: 4,
  input: "I don't want to use templates. Just write me a simple todo list from scratch with React and Prisma.",
  expectedToolCalls: [],
  validationCriteria: [
    // Should explain template benefits
    {
      id: 'explained-benefits',
      description: 'Explained benefits of using templates',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('template') && (
          text.includes('recommend') ||
          text.includes('faster') ||
          text.includes('easier') ||
          text.includes('best practice') ||
          text.includes('starting point') ||
          text.includes('optimized')
        )
      },
    },
    // Should offer template as option
    {
      id: 'offered-template',
      description: 'Still offered template as an option',
      points: 30,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('todo-app') || text.includes('template.copy')
      },
    },
    // Should not just write files from scratch without discussion
    {
      id: 'no-raw-file-creation',
      description: 'Did not immediately create files from scratch',
      points: 30,
      validate: (result) => {
        // Should not have Write calls creating package.json, etc. without template
        const hasTemplateCopy = result.toolCalls.some(t => t.name === 'template.copy')
        const hasRawWrites = result.toolCalls.some(t => {
          const name = t.name.toLowerCase()
          if (name === 'write') {
            const path = String(t.params?.path || '')
            return path.includes('package.json') || path.includes('index.tsx')
          }
          return false
        })
        // Either used template OR didn't write raw files
        return hasTemplateCopy || !hasRawWrites
      },
    },
  ],
  antiPatterns: [
    'Writing app from scratch without recommending templates',
    'Not explaining why templates are better',
  ],
  maxScore: 100,
}

// ============================================
// Hard Test Cases - Complex Multi-Step
// ============================================

/**
 * LEVEL 4: Add a new model with relationship
 * 
 * Tests understanding of Prisma relations
 */
export const EVAL_ADD_CATEGORY_MODEL: AgentEval = {
  id: 'hard-add-category-model',
  name: 'Hard: Add Category Model for Todos',
  category: 'multi-turn',
  level: 4,
  input: 'Build a todo app and add a Category model so users can organize todos into categories like "Work", "Personal", etc.',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'todo-app' }, required: true },
  ],
  validationCriteria: [
    {
      id: 'used-template',
      description: 'Used template.copy to create todo app',
      points: 15,
      validate: (result) => {
        const copyCall = result.toolCalls.find(t => t.name === 'template.copy')
        return copyCall?.params?.template === 'todo-app'
      },
    },
    // Must add Category model
    createSchemaModifiedCriterion(
      /model\s+Category/,
      25,
      'Added Category model to schema.prisma'
    ),
    // Must add relationship to Todo
    createSchemaModifiedCriterion(
      /categoryId|category\s+Category/i,
      20,
      'Added category relationship to Todo model'
    ),
    createNoGeneratedFileEditsCriterion(20),
    createRanPrismaGenerateCriterion(10),
    // Should update UI
    createSourceFileModifiedCriterion(
      'src/routes/index.tsx',
      /[Cc]ategory/,
      10,
      'Updated UI to show categories'
    ),
  ],
  antiPatterns: [
    'Adding category as a string field only',
    'Not creating proper relationship',
  ],
  maxScore: 100,
}

/**
 * LEVEL 4: Add soft delete functionality
 * 
 * Tests understanding of patterns
 */
export const EVAL_ADD_SOFT_DELETE: AgentEval = {
  id: 'hard-add-soft-delete',
  name: 'Hard: Add Soft Delete for Todos',
  category: 'multi-turn',
  level: 4,
  input: 'Create a todo app with soft delete - when users delete a todo, it should be marked as deleted but not removed from the database.',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'todo-app' }, required: true },
  ],
  validationCriteria: [
    {
      id: 'used-template',
      description: 'Used template.copy to create todo app',
      points: 15,
      validate: (result) => {
        const copyCall = result.toolCalls.find(t => t.name === 'template.copy')
        return copyCall?.params?.template === 'todo-app'
      },
    },
    // Must add deletedAt or isDeleted field
    createSchemaModifiedCriterion(
      /deletedAt.*DateTime|isDeleted.*Boolean/i,
      30,
      'Added soft delete field (deletedAt or isDeleted) to schema'
    ),
    createNoGeneratedFileEditsCriterion(20),
    createRanPrismaGenerateCriterion(10),
    // UI should filter out deleted
    createSourceFileModifiedCriterion(
      'src/routes/index.tsx',
      /deletedAt|isDeleted|!.*deleted/i,
      15,
      'Modified UI to handle soft delete'
    ),
    // Should explain soft delete
    {
      id: 'explained-soft-delete',
      description: 'Explained soft delete pattern',
      points: 10,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('soft delete') || 
               text.includes('mark as deleted') ||
               text.includes('not permanently')
      },
    },
  ],
  antiPatterns: [
    'Implementing actual delete instead of soft delete',
    'Not filtering deleted items in queries',
  ],
  maxScore: 100,
}

// ============================================
// Export All Hard Evals
// ============================================

export const ALL_HARD_EVALS: AgentEval[] = [
  // Schema modifications
  EVAL_ADD_PRIORITY_FIELD,
  EVAL_ADD_DUE_DATE,
  // Generated file protection
  EVAL_MODIFY_USER_MODEL,
  EVAL_DONT_EDIT_TYPES,
  // UI modifications
  EVAL_CHANGE_BUTTON_COLOR,
  EVAL_ADD_DELETE_CONFIRMATION,
  // Negative tests
  EVAL_IMPOSSIBLE_FEATURE,
  EVAL_BYPASS_TEMPLATE,
  // Complex multi-step
  EVAL_ADD_CATEGORY_MODEL,
  EVAL_ADD_SOFT_DELETE,
]

export const MULTI_TURN_EVALS = ALL_HARD_EVALS.filter(
  e => e.category === 'multi-turn'
)

export const EDGE_CASE_HARD_EVALS = ALL_HARD_EVALS.filter(
  e => e.category === 'edge-cases'
)
