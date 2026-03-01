/**
 * Business User Test Cases for Shogo Agent Evals
 *
 * These tests are designed for non-technical users (50%+ of our user base) who:
 * - Use vague business language instead of technical terms
 * - Confuse UI changes with schema changes
 * - Have multi-turn conversations with progressive refinement
 * - Ask for impossible features that need graceful degradation
 * - Need help with error recovery
 *
 * Target: Level 4-6 difficulty to challenge even capable models
 */

import type { AgentEval, ValidationCriterion, EvalResult, ValidationPhase } from './types'
import { existsSync, readFileSync } from 'fs'
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

function createSchemaContainsCriterion(
  expectedContent: string | RegExp,
  points: number,
  description: string,
  phase: ValidationPhase = 'execution'
): ValidationCriterion {
  return {
    id: `schema-contains-${description.replace(/\s/g, '-').toLowerCase()}`,
    description,
    points,
    phase, // Schema validation is execution (code was written correctly)
    validate: (result) => {
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

function createSchemaNotContainsCriterion(
  excludedContent: string | RegExp,
  points: number,
  description: string,
  phase: ValidationPhase = 'execution'
): ValidationCriterion {
  return {
    id: `schema-not-contains-${description.replace(/\s/g, '-').toLowerCase()}`,
    description,
    points,
    phase, // Schema validation is execution
    validate: (result) => {
      const projectDir = getProjectDir(result)
      if (!projectDir) return false

      const schemaPath = join(projectDir, 'prisma/schema.prisma')
      if (!existsSync(schemaPath)) return true // No schema = doesn't contain

      const content = readFileSync(schemaPath, 'utf-8')
      if (typeof excludedContent === 'string') {
        return !content.includes(excludedContent)
      }
      return !excludedContent.test(content)
    },
  }
}

function createUIContainsCriterion(
  expectedContent: string | RegExp,
  points: number,
  description: string,
  phase: ValidationPhase = 'execution'
): ValidationCriterion {
  return {
    id: `ui-contains-${description.replace(/\s/g, '-').toLowerCase()}`,
    description,
    points,
    phase, // UI validation is execution (code was written correctly)
    validate: (result) => {
      const projectDir = getProjectDir(result)
      if (!projectDir) return false

      const routesPath = join(projectDir, 'src/routes/index.tsx')
      if (!existsSync(routesPath)) return false

      const content = readFileSync(routesPath, 'utf-8')
      if (typeof expectedContent === 'string') {
        return content.includes(expectedContent)
      }
      return expectedContent.test(content)
    },
  }
}

function createUsedTemplateCriterion(templateName: string, points: number): ValidationCriterion {
  return {
    id: 'used-template',
    description: `Used template.copy with ${templateName} template`,
    points,
    phase: 'intention', // Choosing the right template is intention
    validate: (result) => {
      const copyCall = result.toolCalls.find((t) => t.name === 'template.copy')
      if (copyCall?.params?.template === templateName) return true

      const projectDir = getProjectDir(result)
      if (!projectDir) return false
      return existsSync(join(projectDir, 'prisma/schema.prisma'))
    },
  }
}

function createAskedClarificationCriterion(points: number): ValidationCriterion {
  return {
    id: 'asked-clarification',
    description: 'Asked for clarification instead of guessing',
    points,
    phase: 'intention', // Asking clarification shows understanding of ambiguity
    validate: (result) => {
      const text = result.responseText.toLowerCase()
      return (
        text.includes('?') &&
        (text.includes('what') ||
          text.includes('which') ||
          text.includes('how') ||
          text.includes('could you') ||
          text.includes('would you') ||
          text.includes('do you mean') ||
          text.includes('clarify'))
      )
    },
  }
}

function createExplainedLimitationCriterion(points: number): ValidationCriterion {
  return {
    id: 'explained-limitation',
    description: 'Explained the limitation clearly',
    points,
    validate: (result) => {
      const text = result.responseText.toLowerCase()
      return (
        text.includes('cannot') ||
        text.includes("can't") ||
        text.includes('not supported') ||
        text.includes('not possible') ||
        text.includes('limitation') ||
        text.includes("doesn't support") ||
        text.includes('would require')
      )
    },
  }
}

function createOfferedAlternativeCriterion(points: number): ValidationCriterion {
  return {
    id: 'offered-alternative',
    description: 'Offered a reasonable alternative or workaround',
    points,
    validate: (result) => {
      const text = result.responseText.toLowerCase()
      return (
        text.includes('instead') ||
        text.includes('alternatively') ||
        text.includes('could') ||
        text.includes('workaround') ||
        text.includes('manual') ||
        text.includes('however')
      )
    },
  }
}

function createRanPrismaGenerateCriterion(points: number): ValidationCriterion {
  return {
    id: 'ran-prisma-generate',
    description: 'Ran prisma generate/db push successfully (no errors)',
    points,
    phase: 'execution', // Prisma generate success is execution
    validate: (result) => {
      const prismaCall = result.toolCalls.find((tc) => {
        const name = tc.name.toLowerCase()
        if (name === 'bash' || name === 'shell') {
          const command = String(tc.params?.command || '').toLowerCase()
          return (
            command.includes('prisma generate') ||
            command.includes('prisma db push') ||
            command.includes('prisma migrate')
          )
        }
        return false
      })
      
      if (!prismaCall) return false
      
      // Check if result indicates success (no error)
      const resultStr = String(prismaCall.result || '').toLowerCase()
      const hasError = resultStr.includes('error') && !resultStr.includes('0 errors')
      const hasFailed = resultStr.includes('failed') || resultStr.includes('invalid')
      
      return !hasError && !hasFailed
    },
  }
}

/**
 * Check that TypeScript compilation succeeds (no type errors)
 */
function createTypeCheckSucceededCriterion(points: number): ValidationCriterion {
  return {
    id: 'typecheck-succeeded',
    description: 'TypeScript compiles without errors',
    points,
    phase: 'execution', // TypeScript compilation is execution
    validate: (result) => {
      // Look for tsc or type-check commands
      const tscCall = result.toolCalls.find((tc) => {
        const name = tc.name.toLowerCase()
        if (name === 'bash' || name === 'shell') {
          const command = String(tc.params?.command || '').toLowerCase()
          return (
            command.includes('tsc') ||
            command.includes('type-check') ||
            command.includes('typecheck')
          )
        }
        return false
      })
      
      if (!tscCall) {
        // No explicit type check - verify via prisma generate output (which compiles TS)
        const prismaCall = result.toolCalls.find((tc) => {
          const command = String(tc.params?.command || '').toLowerCase()
          return command.includes('prisma generate')
        })
        if (prismaCall) {
          const resultStr = String(prismaCall.result || '').toLowerCase()
          return !resultStr.includes('type error') && !resultStr.includes('ts error')
        }
        return false
      }
      
      // Check for type errors in result
      const resultStr = String(tscCall.result || '').toLowerCase()
      const hasError = (
        resultStr.includes('error ts') ||
        resultStr.includes('type error') ||
        (resultStr.includes('error') && resultStr.includes('found'))
      )
      
      return !hasError
    },
  }
}

/**
 * Check that the app builds successfully
 */
function createBuildSucceededCriterion(points: number): ValidationCriterion {
  return {
    id: 'build-succeeded',
    description: 'App builds without errors',
    points,
    phase: 'execution', // Build success is execution
    validate: (result) => {
      // Look for build commands
      const buildCall = result.toolCalls.find((tc) => {
        const name = tc.name.toLowerCase()
        if (name === 'bash' || name === 'shell') {
          const command = String(tc.params?.command || '').toLowerCase()
          return (
            command.includes('bun build') ||
            command.includes('npm run build') ||
            command.includes('vite build')
          )
        }
        return false
      })
      
      if (!buildCall) return false
      
      // Check for build errors
      const resultStr = String(buildCall.result || '').toLowerCase()
      const hasError = (
        resultStr.includes('error') ||
        resultStr.includes('failed') ||
        resultStr.includes('exit code 1')
      )
      
      return !hasError
    },
  }
}

/**
 * Verify generated Prisma client exists (proves prisma generate actually worked)
 */
function createPrismaClientExistsCriterion(points: number): ValidationCriterion {
  return {
    id: 'prisma-client-exists',
    description: 'Prisma client was generated (file exists)',
    points,
    phase: 'execution', // Client existence is execution
    validate: (result) => {
      const projectDir = getProjectDir(result)
      if (!projectDir) return false
      
      // Check for generated prisma client
      const clientPath = join(projectDir, 'node_modules/.prisma/client/index.js')
      const altClientPath = join(projectDir, 'src/generated/prisma/client.ts')
      
      return existsSync(clientPath) || existsSync(altClientPath)
    },
  }
}

// ============================================
// CATEGORY 1: Vague Business Language
// Non-technical users rarely use precise terms
// ============================================

export const EVAL_VAGUE_SORTABLE_IMPORTANCE: AgentEval = {
  id: 'business-vague-sortable-importance',
  name: 'Vague: Make contacts sortable by importance',
  category: 'business-language',
  level: 5,
  input:
    'Build me a CRM. I want to be able to sort contacts by how important they are to my business.',
  expectedTemplate: 'crm',
  expectedToolCalls: [{ name: 'template.copy', params: { template: 'crm' }, required: true }],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 15),
    // Should either ask what "importance" means OR add a priority/importance field
    {
      id: 'handled-vague-importance',
      description: 'Either asked for clarification on importance or added appropriate field',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        const askedClarification =
          text.includes('?') &&
          (text.includes('importance') ||
            text.includes('priority') ||
            text.includes('value') ||
            text.includes('revenue'))

        const projectDir = getProjectDir(result)
        if (!projectDir) return askedClarification

        const schemaPath = join(projectDir, 'prisma/schema.prisma')
        if (!existsSync(schemaPath)) return askedClarification

        const schema = readFileSync(schemaPath, 'utf-8')
        const addedField = /priority|importance|tier|value|revenue/i.test(schema)

        return askedClarification || addedField
      },
    },
    {
      id: 'explained-interpretation',
      description: 'Explained how they interpreted "importance"',
      points: 25,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('priority') ||
          text.includes('tier') ||
          text.includes('value') ||
          text.includes('revenue') ||
          text.includes('importance')
        )
      },
    },
  ],
  antiPatterns: ['Adding random fields without explanation', 'Ignoring the request'],
  maxScore: 80,
}

export const EVAL_VAGUE_NEEDS_FOLLOWUP: AgentEval = {
  id: 'business-vague-needs-followup',
  name: 'Vague: Show who needs follow-up',
  category: 'business-language',
  level: 5,
  input:
    "Build a CRM for my sales team. I want to quickly see which contacts need follow-up - you know, the ones I haven't talked to in a while.",
  expectedTemplate: 'crm',
  expectedToolCalls: [{ name: 'template.copy', params: { template: 'crm' }, required: true }],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 15),
    // Should add lastContactedAt field
    createSchemaContainsCriterion(
      /lastContacted|last_contacted/i,
      25,
      'Added lastContactedAt field to track contact history'
    ),
    // Should add UI filter or visual indicator
    {
      id: 'followup-ui',
      description: 'Added UI to identify contacts needing follow-up',
      points: 25,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false

        const routesPath = join(projectDir, 'src/routes/index.tsx')
        if (!existsSync(routesPath)) return false

        const content = readFileSync(routesPath, 'utf-8')
        return /lastContacted|follow.?up|overdue|days?.?ago/i.test(content)
      },
    },
    createRanPrismaGenerateCriterion(10),
  ],
  antiPatterns: ['Not understanding "follow-up" context'],
  maxScore: 75,
}

export const EVAL_VAGUE_MONEY_STUFF: AgentEval = {
  id: 'business-vague-money-stuff',
  name: 'Vague: Show me the money stuff',
  category: 'business-language',
  level: 5,
  input: 'I need an app to help me with money stuff for my small business.',
  expectedTemplate: 'clarify',
  expectedToolCalls: [],
  validationCriteria: [
    createAskedClarificationCriterion(50),
    {
      id: 'offered-options',
      description: 'Offered specific options (expenses, revenue, invoices)',
      points: 30,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        const options = [
          'expense',
          'spending',
          'budget',
          'revenue',
          'income',
          'invoice',
          'payment',
          'tracking',
        ]
        const mentioned = options.filter((o) => text.includes(o))
        return mentioned.length >= 2
      },
    },
  ],
  antiPatterns: ['Randomly selecting expense-tracker without clarification'],
  maxScore: 80,
}

export const EVAL_VAGUE_LOOK_PROFESSIONAL: AgentEval = {
  id: 'business-vague-look-professional',
  name: 'Vague: Make it look more professional',
  category: 'business-language',
  level: 5,
  input:
    "Build a CRM for me. Actually, can you make it look more professional? It's too casual right now.",
  expectedTemplate: 'crm',
  expectedToolCalls: [{ name: 'template.copy', params: { template: 'crm' }, required: true }],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 15),
    // Should ask what "professional" means to them
    {
      id: 'clarified-professional',
      description: 'Asked what professional means or offered specific options',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          (text.includes('?') && text.includes('professional')) ||
          text.includes('color') ||
          text.includes('theme') ||
          text.includes('font') ||
          text.includes('layout') ||
          text.includes('darker') ||
          text.includes('clean')
        )
      },
    },
  ],
  antiPatterns: ['Making random styling changes'],
  maxScore: 55,
}

export const EVAL_VAGUE_KEEP_TRACK: AgentEval = {
  id: 'business-vague-keep-track',
  name: 'Vague: Keep track of everything',
  category: 'business-language',
  level: 5,
  input: 'I run a small bakery and need to keep track of everything.',
  expectedTemplate: 'clarify',
  expectedToolCalls: [],
  validationCriteria: [
    createAskedClarificationCriterion(40),
    {
      id: 'bakery-relevant-options',
      description: 'Offered bakery-relevant options (inventory, orders, expenses)',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        const options = [
          'inventory',
          'stock',
          'ingredient',
          'order',
          'customer',
          'expense',
          'sales',
          'product',
        ]
        const mentioned = options.filter((o) => text.includes(o))
        return mentioned.length >= 2
      },
    },
  ],
  antiPatterns: ['Picking a random template'],
  maxScore: 80,
}

// ============================================
// CATEGORY 2: Business Logic vs Schema Confusion
// Users confuse display changes with data changes
// ============================================

export const EVAL_CONFUSE_FILTER_VS_FIELD: AgentEval = {
  id: 'business-confuse-filter-vs-field',
  name: 'Confusion: Filter vs New Field',
  category: 'business-logic-confusion',
  level: 4,
  input: 'Build a CRM for me. I only want to see active deals, not the closed ones.',
  expectedTemplate: 'crm',
  expectedToolCalls: [{ name: 'template.copy', params: { template: 'crm' }, required: true }],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 15),
    // Should NOT add a new isActive field (Deal already has stage)
    // Should add UI filter instead
    {
      id: 'used-filter-not-field',
      description: 'Added UI filter rather than new schema field',
      points: 40,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false

        const routesPath = join(projectDir, 'src/routes/index.tsx')
        if (!existsSync(routesPath)) return false

        const content = readFileSync(routesPath, 'utf-8')
        // Should have filter logic
        return /filter|stage.*!=|stage.*!==|exclude.*closed|active.*deals/i.test(content)
      },
    },
    {
      id: 'explained-existing-stage',
      description: 'Recognized Deal already has stage field',
      points: 25,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('stage') || text.includes('filter') || text.includes('existing')
      },
    },
  ],
  antiPatterns: ['Adding redundant isActive field when stage exists'],
  maxScore: 80,
}

export const EVAL_CONFUSE_COMPUTED_VS_STORED: AgentEval = {
  id: 'business-confuse-computed-vs-stored',
  name: 'Confusion: Computed vs Stored Value',
  category: 'business-logic-confusion',
  level: 4,
  input:
    'Build me an inventory tracker. I want to see the total value of all my inventory at the top.',
  expectedTemplate: 'inventory',
  expectedToolCalls: [{ name: 'template.copy', params: { template: 'inventory' }, required: true }],
  validationCriteria: [
    createUsedTemplateCriterion('inventory', 15),
    // Should NOT add totalValue field to schema
    createSchemaNotContainsCriterion(
      /totalValue|total_value|inventoryValue/i,
      20,
      'Did not add redundant totalValue field to schema'
    ),
    // Should compute in UI
    createUIContainsCriterion(
      /reduce|sum|total|\.price.*\.quantity|\.quantity.*\.price/i,
      35,
      'Computed total value in UI'
    ),
  ],
  antiPatterns: ['Adding totalValue as stored field'],
  maxScore: 70,
}

export const EVAL_CONFUSE_DISPLAY_VS_DATA: AgentEval = {
  id: 'business-confuse-display-vs-data',
  name: 'Confusion: Display Grouping vs Data',
  category: 'business-logic-confusion',
  level: 4,
  input: "Create a CRM. I want to see the deals grouped by which month they're expected to close.",
  expectedTemplate: 'crm',
  expectedToolCalls: [{ name: 'template.copy', params: { template: 'crm' }, required: true }],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 15),
    // First: need expectedCloseDate field
    createSchemaContainsCriterion(
      /expectedClose|expected_close|closeDate|close_date/i,
      25,
      'Added expectedCloseDate field for grouping'
    ),
    // Should NOT add "month" as separate field
    createSchemaNotContainsCriterion(
      /closeMonth|close_month|expectedMonth/i,
      15,
      'Did not add redundant month field'
    ),
    // Should group in UI
    {
      id: 'grouped-in-ui',
      description: 'Implemented grouping logic in UI',
      points: 20,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false

        const routesPath = join(projectDir, 'src/routes/index.tsx')
        if (!existsSync(routesPath)) return false

        const content = readFileSync(routesPath, 'utf-8')
        return /group|getMonth|month.*section|reduce.*month/i.test(content)
      },
    },
  ],
  antiPatterns: ['Adding month as stored field instead of computed grouping'],
  maxScore: 75,
}

export const EVAL_CONFUSE_SEARCH_VS_FIELD: AgentEval = {
  id: 'business-confuse-search-vs-field',
  name: 'Confusion: Search vs New Field',
  category: 'business-logic-confusion',
  level: 4,
  input: 'Build a CRM. I want to find contacts by their company name.',
  expectedTemplate: 'crm',
  expectedToolCalls: [{ name: 'template.copy', params: { template: 'crm' }, required: true }],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 15),
    // Should NOT add companyName field to Contact (relationship exists)
    createSchemaNotContainsCriterion(
      /companyName.*String|company_name.*String/,
      25,
      'Did not duplicate company name on Contact'
    ),
    // Should add search/filter UI
    {
      id: 'search-by-company',
      description: 'Added search or filter by company',
      points: 30,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false

        const routesPath = join(projectDir, 'src/routes/index.tsx')
        if (!existsSync(routesPath)) return false

        const content = readFileSync(routesPath, 'utf-8')
        return /search|filter.*company|company.*filter|select.*company/i.test(content)
      },
    },
  ],
  antiPatterns: ['Duplicating company data instead of using relationship'],
  maxScore: 70,
}

// ============================================
// CATEGORY 3: Multi-Turn Conversation Coherence
// Users refine requests across multiple messages
// ============================================

export const EVAL_MULTITURN_PROGRESSIVE_REFINEMENT: AgentEval = {
  id: 'business-multiturn-progressive',
  name: 'Multi-turn: Progressive Refinement',
  category: 'multi-turn-coherence',
  level: 5,
  input: 'Actually, make the LinkedIn field required, not optional.',
  conversationHistory: [
    { role: 'user', content: 'Build me a CRM' },
    {
      role: 'assistant',
      content: 'Your CRM is ready!',
      toolCalls: [{ name: 'template.copy', params: { template: 'crm' } }],
    },
    { role: 'user', content: 'Add a LinkedIn field to contacts' },
    {
      role: 'assistant',
      content: "I've added an optional LinkedIn field to the Contact model.",
      toolCalls: [],
    },
  ],
  expectedToolCalls: [],
  validationCriteria: [
    // === INTENTION: Did it understand the request? ===
    {
      id: 'understood-context',
      description: 'Understood reference to previously added LinkedIn field',
      points: 30,
      phase: 'intention',
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('linkedin') || text.includes('required')
      },
    },
    // === EXECUTION: Did the code work? ===
    createSchemaContainsCriterion(
      /linkedIn(Url)?\s+String(\s|@)/,
      25,
      'Made LinkedIn field required (no ? after type)'
    ),
    createRanPrismaGenerateCriterion(15),
    createPrismaClientExistsCriterion(10),
  ],
  antiPatterns: ['Not understanding pronoun reference', 'Adding a second LinkedIn field'],
  maxScore: 80,
}

export const EVAL_MULTITURN_UNDO_SPECIFIC: AgentEval = {
  id: 'business-multiturn-undo',
  name: 'Multi-turn: Undo Specific Change',
  category: 'multi-turn-coherence',
  level: 5,
  input: 'Undo that last change - I want it optional after all.',
  conversationHistory: [
    { role: 'user', content: 'Build me a CRM with a LinkedIn field' },
    {
      role: 'assistant',
      content: 'CRM created with optional LinkedIn field.',
      toolCalls: [{ name: 'template.copy', params: { template: 'crm' } }],
    },
    { role: 'user', content: 'Make LinkedIn required' },
    {
      role: 'assistant',
      content: "I've made the LinkedIn field required.",
      toolCalls: [],
    },
  ],
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'understood-undo',
      description: 'Understood "undo that" refers to making it required',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          (text.includes('optional') || text.includes('undo') || text.includes('revert')) &&
          text.includes('linkedin')
        )
      },
    },
    // Should make field optional again (matches linkedIn or linkedInUrl with ?)
    createSchemaContainsCriterion(
      /linkedIn(Url)?\s+String\?/,
      35,
      'Made LinkedIn field optional again'
    ),
  ],
  antiPatterns: ['Removing LinkedIn entirely', 'Not understanding undo scope'],
  maxScore: 75,
}

export const EVAL_MULTITURN_CONTRADICTORY: AgentEval = {
  id: 'business-multiturn-contradictory',
  name: 'Multi-turn: Replace Previous Feature',
  category: 'multi-turn-coherence',
  level: 5,
  input: "Actually never mind the categories - I want tags instead. Remove categories and add tags.",
  conversationHistory: [
    { role: 'user', content: 'Build a todo app with categories for organizing tasks' },
    {
      role: 'assistant',
      content: 'Created todo app with categories!',
      toolCalls: [{ name: 'template.copy', params: { template: 'todo-app' } }],
    },
  ],
  expectedToolCalls: [],
  validationCriteria: [
    // Should remove category field/model
    createSchemaNotContainsCriterion(/category/i, 25, 'Removed category field/model'),
    // Should add tags
    createSchemaContainsCriterion(/tag|Tag/i, 30, 'Added tag field or model'),
    {
      id: 'acknowledged-replacement',
      description: 'Acknowledged replacing categories with tags',
      points: 20,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          (text.includes('remov') || text.includes('replac')) &&
          text.includes('tag')
        )
      },
    },
  ],
  antiPatterns: ['Keeping both categories and tags', 'Only adding tags without removing categories'],
  maxScore: 75,
}

export const EVAL_MULTITURN_IMPLICIT_REFERENCE: AgentEval = {
  id: 'business-multiturn-implicit',
  name: 'Multi-turn: Implicit Reference',
  category: 'multi-turn-coherence',
  level: 5,
  input: "Can you show it at the top of each contact's card?",
  conversationHistory: [
    { role: 'user', content: 'Build a CRM' },
    {
      role: 'assistant',
      content: 'CRM is ready.',
      toolCalls: [{ name: 'template.copy', params: { template: 'crm' } }],
    },
    { role: 'user', content: 'Add a customer tier field - gold, silver, bronze' },
    {
      role: 'assistant',
      content: "Added a tier field to contacts with gold, silver, and bronze options.",
      toolCalls: [],
    },
  ],
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'understood-it',
      description: 'Understood "it" refers to the tier field',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('tier') || text.includes('gold') || text.includes('badge')
      },
    },
    // Should modify UI placement
    createUIContainsCriterion(/tier/i, 30, 'Shows tier in contact card UI'),
  ],
  antiPatterns: ['Asking what "it" refers to when context is clear'],
  maxScore: 70,
}

// ============================================
// CATEGORY 4: Cross-Model Relationship Changes
// Complex schema modifications
// ============================================

export const EVAL_RELATIONSHIP_MANY_TO_MANY: AgentEval = {
  id: 'business-relationship-m2m',
  name: 'Relationship: Many-to-Many',
  category: 'relationship-changes',
  level: 6,
  input:
    "Build a CRM. Actually, my contacts often work with multiple companies - they're consultants. Can one contact belong to several companies?",
  expectedTemplate: 'crm',
  expectedToolCalls: [{ name: 'template.copy', params: { template: 'crm' }, required: true }],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 10),
    // Should recognize this is a M:N relationship change
    {
      id: 'recognized-m2m',
      description: 'Recognized need for many-to-many relationship',
      points: 25,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('many-to-many') ||
          text.includes('multiple companies') ||
          text.includes('several companies') ||
          text.includes('relationship')
        )
      },
    },
    // Should modify schema appropriately (either join table or array relation)
    createSchemaContainsCriterion(
      /companies\s+Company\[\]|Contact\[\].*Company/i,
      30,
      'Implemented many-to-many relationship'
    ),
    createRanPrismaGenerateCriterion(10),
  ],
  antiPatterns: ['Ignoring the relationship complexity', 'Just adding a second company field'],
  maxScore: 75,
}

export const EVAL_RELATIONSHIP_SELF_REFERENTIAL: AgentEval = {
  id: 'business-relationship-self-ref',
  name: 'Relationship: Self-Referential',
  category: 'relationship-changes',
  level: 6,
  input:
    "Build a CRM. I want contacts to be able to refer other contacts - like who introduced them to me.",
  expectedTemplate: 'crm',
  expectedToolCalls: [{ name: 'template.copy', params: { template: 'crm' }, required: true }],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 10),
    // Should add self-referential relationship
    createSchemaContainsCriterion(
      /referredBy.*Contact|referrer.*Contact/i,
      35,
      'Added self-referential relationship'
    ),
    {
      id: 'explained-self-ref',
      description: 'Explained the referral relationship',
      points: 20,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('refer') || text.includes('introduc') || text.includes('relationship')
      },
    },
    createRanPrismaGenerateCriterion(10),
  ],
  antiPatterns: ['Adding referredBy as String instead of relationship'],
  maxScore: 75,
}

export const EVAL_RELATIONSHIP_CASCADE: AgentEval = {
  id: 'business-relationship-cascade',
  name: 'Relationship: Cascade Delete Question',
  category: 'relationship-changes',
  level: 5,
  input:
    "Build a CRM. Quick question - if I delete a company, what happens to all the contacts at that company?",
  expectedTemplate: 'crm',
  expectedToolCalls: [{ name: 'template.copy', params: { template: 'crm' }, required: true }],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 10),
    // Should explain cascade behavior
    {
      id: 'explained-cascade',
      description: 'Explained cascade/orphan behavior',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('delete') ||
          text.includes('cascade') ||
          text.includes('orphan') ||
          text.includes('null') ||
          text.includes('remove') ||
          text.includes('unlink')
        )
      },
    },
    // Should offer options
    {
      id: 'offered-options',
      description: 'Offered options for handling deletions',
      points: 25,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('option') ||
          text.includes('could') ||
          text.includes('would you') ||
          text.includes('prefer')
        )
      },
    },
  ],
  antiPatterns: ['Not addressing the cascade question'],
  maxScore: 75,
}

// ============================================
// CATEGORY 5: Impossible Requests with Graceful Degradation
// Users ask for features that aren't supported
// ============================================

export const EVAL_IMPOSSIBLE_EMAIL_REMINDER: AgentEval = {
  id: 'business-impossible-email-reminder',
  name: 'Impossible: Email Reminders',
  category: 'graceful-degradation',
  level: 4,
  input: 'Build a todo app. I want it to email me reminders when tasks are due.',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [{ name: 'template.copy', params: { template: 'todo-app' }, required: true }],
  validationCriteria: [
    createUsedTemplateCriterion('todo-app', 10),
    createExplainedLimitationCriterion(25),
    createOfferedAlternativeCriterion(30),
    // Should still add dueDate field
    createSchemaContainsCriterion(/dueDate|due_date/i, 15, 'Added dueDate field despite limitation'),
  ],
  antiPatterns: ['Pretending email is supported', 'Not building the app at all'],
  maxScore: 80,
}

export const EVAL_IMPOSSIBLE_CALENDAR_SYNC: AgentEval = {
  id: 'business-impossible-calendar-sync',
  name: 'Impossible: Calendar Sync',
  category: 'graceful-degradation',
  level: 4,
  input: 'Create a booking app that syncs with my Google Calendar automatically.',
  expectedTemplate: 'booking-app',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'booking-app' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('booking-app', 10),
    createExplainedLimitationCriterion(30),
    createOfferedAlternativeCriterion(25),
    {
      id: 'still-built-app',
      description: 'Still created the booking app',
      points: 15,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        return existsSync(join(projectDir, 'prisma/schema.prisma'))
      },
    },
  ],
  antiPatterns: ['Claiming Google Calendar integration works'],
  maxScore: 80,
}

export const EVAL_IMPOSSIBLE_SCAN_CARDS: AgentEval = {
  id: 'business-impossible-scan-cards',
  name: 'Impossible: Business Card Scanner',
  category: 'graceful-degradation',
  level: 4,
  input:
    "Build a CRM. I want to scan business cards with my phone's camera and have them automatically added as contacts.",
  expectedTemplate: 'crm',
  expectedToolCalls: [{ name: 'template.copy', params: { template: 'crm' }, required: true }],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 10),
    createExplainedLimitationCriterion(30),
    createOfferedAlternativeCriterion(25),
    {
      id: 'suggested-quick-entry',
      description: 'Suggested quick manual entry as alternative',
      points: 15,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('manual') ||
          text.includes('quick') ||
          text.includes('form') ||
          text.includes('add contact')
        )
      },
    },
  ],
  antiPatterns: ['Claiming OCR/camera integration works'],
  maxScore: 80,
}

export const EVAL_IMPOSSIBLE_AI_CATEGORIZE: AgentEval = {
  id: 'business-impossible-ai-categorize',
  name: 'Impossible: AI Auto-Categorization',
  category: 'graceful-degradation',
  level: 4,
  input:
    'Build an expense tracker. I want it to automatically categorize my expenses using AI - like, know that Starbucks is food.',
  expectedTemplate: 'expense-tracker',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'expense-tracker' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('expense-tracker', 10),
    createExplainedLimitationCriterion(30),
    createOfferedAlternativeCriterion(25),
    // Should still add category field for manual categorization
    {
      id: 'manual-category',
      description: 'Offered manual category selection',
      points: 15,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('category') ||
          text.includes('manual') ||
          text.includes('select') ||
          text.includes('choose')
        )
      },
    },
  ],
  antiPatterns: ['Claiming AI categorization works'],
  maxScore: 80,
}

// ============================================
// CATEGORY 6: Error Recovery
// Users encounter issues and need help fixing them
// ============================================

export const EVAL_ERROR_APP_CRASHES: AgentEval = {
  id: 'business-error-app-crashes',
  name: 'Error Recovery: App Crashes After Change',
  category: 'error-recovery',
  level: 5,
  input:
    "The app was working but now it crashes when I open it. I think it's because we added that priority field?",
  conversationHistory: [
    { role: 'user', content: 'Build a todo app' },
    {
      role: 'assistant',
      content: 'Todo app created!',
      toolCalls: [{ name: 'template.copy', params: { template: 'todo-app' } }],
    },
    { role: 'user', content: 'Add a priority field' },
    {
      role: 'assistant',
      content: "Added priority field to the Todo model.",
      toolCalls: [],
    },
  ],
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'diagnosed-issue',
      description: 'Identified potential cause (prisma generate, UI sync)',
      points: 35,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('prisma') ||
          text.includes('generate') ||
          text.includes('migrate') ||
          text.includes('sync') ||
          text.includes('update')
        )
      },
    },
    {
      id: 'offered-fix',
      description: 'Offered to fix the issue',
      points: 30,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('fix') ||
          text.includes('run') ||
          text.includes('try') ||
          text.includes('should')
        )
      },
    },
    createRanPrismaGenerateCriterion(15),
  ],
  antiPatterns: ['Blaming the user', 'Not offering to help'],
  maxScore: 80,
}

export const EVAL_ERROR_DATA_MISSING: AgentEval = {
  id: 'business-error-data-missing',
  name: 'Error Recovery: New Field Shows Empty',
  category: 'error-recovery',
  level: 5,
  input:
    "I added the LinkedIn field but all my existing contacts show blank for it. How do I fix that?",
  conversationHistory: [
    { role: 'user', content: 'Build a CRM and add LinkedIn field' },
    {
      role: 'assistant',
      content: 'CRM with LinkedIn field ready.',
      toolCalls: [{ name: 'template.copy', params: { template: 'crm' } }],
    },
  ],
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'explained-null-behavior',
      description: 'Explained that existing records have null values',
      points: 35,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('existing') ||
          text.includes('null') ||
          text.includes('empty') ||
          text.includes('blank') ||
          text.includes('added')
        )
      },
    },
    {
      id: 'offered-solution',
      description: 'Offered solution (manual update, default value, bulk edit)',
      points: 35,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('update') ||
          text.includes('default') ||
          text.includes('edit') ||
          text.includes('add') ||
          text.includes('fill')
        )
      },
    },
  ],
  antiPatterns: ['Not explaining why it happened'],
  maxScore: 70,
}

export const EVAL_ERROR_CANT_DELETE: AgentEval = {
  id: 'business-error-cant-delete',
  name: 'Error Recovery: Cannot Delete Record',
  category: 'error-recovery',
  level: 5,
  input:
    "I'm trying to delete a company but it won't let me. Says something about contacts?",
  conversationHistory: [
    { role: 'user', content: 'Build a CRM' },
    {
      role: 'assistant',
      content: 'CRM ready.',
      toolCalls: [{ name: 'template.copy', params: { template: 'crm' } }],
    },
  ],
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'explained-constraint',
      description: 'Explained foreign key constraint',
      points: 35,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('contact') ||
          text.includes('relationship') ||
          text.includes('reference') ||
          text.includes('linked') ||
          text.includes('associated')
        )
      },
    },
    {
      id: 'offered-options',
      description: 'Offered options to resolve (delete contacts first, unlink, cascade)',
      points: 35,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('first') ||
          text.includes('delete') ||
          text.includes('remove') ||
          text.includes('unlink') ||
          text.includes('move')
        )
      },
    },
  ],
  antiPatterns: ['Not explaining the relationship constraint'],
  maxScore: 70,
}

// ============================================
// CATEGORY 7: Complex Conditional Logic
// Business rules that require more than simple fields
// ============================================

export const EVAL_CONDITIONAL_REQUIRED_FIELD: AgentEval = {
  id: 'business-conditional-required',
  name: 'Conditional: Required Based on Status',
  category: 'conditional-logic',
  level: 6,
  input:
    'Build a CRM. When a deal is marked as "won", the close date should be required. Otherwise it can be empty.',
  expectedTemplate: 'crm',
  expectedToolCalls: [{ name: 'template.copy', params: { template: 'crm' }, required: true }],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 10),
    // Should add closeDate field
    createSchemaContainsCriterion(/closeDate|close_date/i, 20, 'Added closeDate field'),
    {
      id: 'addressed-conditional',
      description: 'Addressed the conditional requirement logic',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        // Either implemented validation or explained limitation
        return (
          text.includes('validation') ||
          text.includes('required') ||
          text.includes('won') ||
          text.includes('conditional') ||
          text.includes('check') ||
          text.includes('ui') ||
          text.includes('form')
        )
      },
    },
  ],
  antiPatterns: ['Ignoring the conditional requirement'],
  maxScore: 70,
}

export const EVAL_CONDITIONAL_AUTO_STATUS: AgentEval = {
  id: 'business-conditional-auto-status',
  name: 'Conditional: Auto-Update Status',
  category: 'conditional-logic',
  level: 6,
  input:
    'Build an inventory tracker. When a product quantity hits zero, it should automatically be marked as "out of stock".',
  expectedTemplate: 'inventory',
  expectedToolCalls: [{ name: 'template.copy', params: { template: 'inventory' }, required: true }],
  validationCriteria: [
    createUsedTemplateCriterion('inventory', 10),
    {
      id: 'addressed-auto-update',
      description: 'Addressed automatic status update logic',
      points: 45,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('automatic') ||
          text.includes('status') ||
          text.includes('zero') ||
          text.includes('out of stock') ||
          text.includes('ui') ||
          text.includes('check')
        )
      },
    },
    // May add status field or computed in UI
    {
      id: 'implementation-approach',
      description: 'Explained implementation approach',
      points: 20,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('field') ||
          text.includes('computed') ||
          text.includes('display') ||
          text.includes('badge') ||
          text.includes('show')
        )
      },
    },
  ],
  antiPatterns: ['Ignoring the auto-update requirement'],
  maxScore: 75,
}

export const EVAL_CONDITIONAL_DEFAULT_BY_TYPE: AgentEval = {
  id: 'business-conditional-default-type',
  name: 'Conditional: Different Defaults by Type',
  category: 'conditional-logic',
  level: 6,
  input:
    "Build a CRM. New contacts from the website form should automatically be tagged as 'lead', but contacts I add manually should be 'direct'.",
  expectedTemplate: 'crm',
  expectedToolCalls: [{ name: 'template.copy', params: { template: 'crm' }, required: true }],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 10),
    // Should add source field
    createSchemaContainsCriterion(/source|type|origin/i, 25, 'Added source/type field to Contact'),
    {
      id: 'addressed-different-sources',
      description: 'Addressed different sources having different defaults',
      points: 35,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          (text.includes('lead') && text.includes('direct')) ||
          text.includes('source') ||
          text.includes('type') ||
          text.includes('default')
        )
      },
    },
  ],
  antiPatterns: ['Only adding one tag option'],
  maxScore: 70,
}

// ============================================
// CATEGORY 8: Migration & Data Questions
// Users worry about existing data
// ============================================

export const EVAL_MIGRATION_EXISTING_DATA: AgentEval = {
  id: 'business-migration-existing',
  name: 'Migration: Existing Data Question',
  category: 'migration-concerns',
  level: 4,
  input:
    "I've been using the CRM for a month and have 200 contacts. If I add this new field, will I lose my data?",
  conversationHistory: [
    { role: 'user', content: 'Build a CRM' },
    {
      role: 'assistant',
      content: 'CRM ready.',
      toolCalls: [{ name: 'template.copy', params: { template: 'crm' } }],
    },
    { role: 'user', content: 'I want to add a birthday field to contacts' },
  ],
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'reassured-data-safe',
      description: 'Reassured that existing data is safe',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('safe') ||
          text.includes("won't lose") ||
          text.includes('keep') ||
          text.includes('preserved') ||
          text.includes('existing')
        )
      },
    },
    {
      id: 'explained-null-default',
      description: 'Explained new field will be null/empty for existing',
      points: 30,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('null') ||
          text.includes('empty') ||
          text.includes('blank') ||
          text.includes('fill in')
        )
      },
    },
  ],
  antiPatterns: ['Scaring user about data loss'],
  maxScore: 70,
}

export const EVAL_MIGRATION_RENAME: AgentEval = {
  id: 'business-migration-rename',
  name: 'Migration: Rename Question',
  category: 'migration-concerns',
  level: 5,
  input:
    'Can I rename "Contact" to "Client" throughout the whole app? We call them clients, not contacts.',
  conversationHistory: [
    { role: 'user', content: 'Build a CRM' },
    {
      role: 'assistant',
      content: 'CRM ready.',
      toolCalls: [{ name: 'template.copy', params: { template: 'crm' } }],
    },
  ],
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'explained-complexity',
      description: 'Explained the complexity of renaming',
      points: 35,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('rename') ||
          text.includes('change') ||
          text.includes('schema') ||
          text.includes('model') ||
          text.includes('multiple')
        )
      },
    },
    {
      id: 'offered-alternatives',
      description: 'Offered alternatives (display name vs model name)',
      points: 35,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('display') ||
          text.includes('ui') ||
          text.includes('label') ||
          text.includes('show') ||
          text.includes('alternatively')
        )
      },
    },
  ],
  antiPatterns: ['Just renaming without explaining impact'],
  maxScore: 70,
}

export const EVAL_MIGRATION_REQUIRED_EXISTING: AgentEval = {
  id: 'business-migration-required',
  name: 'Migration: Making Field Required',
  category: 'migration-concerns',
  level: 5,
  input:
    "I want to make the phone number required for contacts. But I have some contacts without phone numbers already - what happens to them?",
  conversationHistory: [
    { role: 'user', content: 'Build a CRM' },
    {
      role: 'assistant',
      content: 'CRM ready.',
      toolCalls: [{ name: 'template.copy', params: { template: 'crm' } }],
    },
  ],
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'explained-migration-issue',
      description: 'Explained the issue with existing null values',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('existing') ||
          text.includes('null') ||
          text.includes('empty') ||
          text.includes('without')
        )
      },
    },
    {
      id: 'offered-solutions',
      description: 'Offered solutions (default value, update existing, keep optional)',
      points: 30,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('default') ||
          text.includes('update') ||
          text.includes('fill') ||
          text.includes('keep') ||
          text.includes('option')
        )
      },
    },
  ],
  antiPatterns: ['Not addressing existing data concern'],
  maxScore: 70,
}

// ============================================
// CATEGORY 9: Framework-Specific Edge Cases
// Prisma/TanStack specific issues
// ============================================

export const EVAL_FRAMEWORK_UNIQUE_CONSTRAINT: AgentEval = {
  id: 'business-framework-unique',
  name: 'Framework: Unique Constraint',
  category: 'framework-specific',
  level: 5,
  input:
    "Build a CRM. Each contact should have a unique email - I don't want duplicates.",
  expectedTemplate: 'crm',
  expectedToolCalls: [{ name: 'template.copy', params: { template: 'crm' }, required: true }],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 10),
    // Should add @unique constraint
    createSchemaContainsCriterion(/@unique/, 35, 'Added @unique constraint to email'),
    {
      id: 'explained-unique',
      description: 'Explained uniqueness constraint',
      points: 20,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('unique') || text.includes('duplicate') || text.includes('already')
      },
    },
    createRanPrismaGenerateCriterion(10),
  ],
  antiPatterns: ['Not adding unique constraint'],
  maxScore: 75,
}

export const EVAL_FRAMEWORK_SOFT_DELETE: AgentEval = {
  id: 'business-framework-soft-delete',
  name: 'Framework: Soft Delete Pattern',
  category: 'framework-specific',
  level: 5,
  input:
    "Build a CRM. When I delete a contact, I want to be able to restore them later if I made a mistake. Don't actually delete them permanently.",
  expectedTemplate: 'crm',
  expectedToolCalls: [{ name: 'template.copy', params: { template: 'crm' }, required: true }],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 10),
    // Should add deletedAt or isDeleted field
    createSchemaContainsCriterion(
      /deletedAt|deleted_at|isDeleted|is_deleted/i,
      30,
      'Added soft delete field'
    ),
    {
      id: 'explained-soft-delete',
      description: 'Explained soft delete pattern',
      points: 25,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('soft') ||
          text.includes('mark') ||
          text.includes('restore') ||
          text.includes('recover')
        )
      },
    },
    createRanPrismaGenerateCriterion(10),
  ],
  antiPatterns: ['Not explaining restoration process'],
  maxScore: 75,
}

export const EVAL_FRAMEWORK_INDEX_PERFORMANCE: AgentEval = {
  id: 'business-framework-index',
  name: 'Framework: Performance Question',
  category: 'framework-specific',
  level: 5,
  input:
    "Build a CRM. I'll have about 50,000 contacts eventually. Will searching by company be slow? Should I do something special?",
  expectedTemplate: 'crm',
  expectedToolCalls: [{ name: 'template.copy', params: { template: 'crm' }, required: true }],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 10),
    {
      id: 'addressed-performance',
      description: 'Addressed the performance concern',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('performance') ||
          text.includes('index') ||
          text.includes('fast') ||
          text.includes('scale') ||
          text.includes('50,000') ||
          text.includes('handle')
        )
      },
    },
    {
      id: 'gave-honest-assessment',
      description: 'Gave honest assessment of capabilities',
      points: 25,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (
          text.includes('should') ||
          text.includes('can') ||
          text.includes('work') ||
          text.includes('fine') ||
          text.includes('consider')
        )
      },
    },
  ],
  antiPatterns: ['Ignoring the scale question', 'Over-promising performance'],
  maxScore: 75,
}

// ============================================
// Export All Business User Evals
// ============================================

export const VAGUE_BUSINESS_LANGUAGE_EVALS: AgentEval[] = [
  EVAL_VAGUE_SORTABLE_IMPORTANCE,
  EVAL_VAGUE_NEEDS_FOLLOWUP,
  EVAL_VAGUE_MONEY_STUFF,
  EVAL_VAGUE_LOOK_PROFESSIONAL,
  EVAL_VAGUE_KEEP_TRACK,
]

export const BUSINESS_LOGIC_CONFUSION_EVALS: AgentEval[] = [
  EVAL_CONFUSE_FILTER_VS_FIELD,
  EVAL_CONFUSE_COMPUTED_VS_STORED,
  EVAL_CONFUSE_DISPLAY_VS_DATA,
  EVAL_CONFUSE_SEARCH_VS_FIELD,
]

export const MULTI_TURN_COHERENCE_EVALS: AgentEval[] = [
  EVAL_MULTITURN_PROGRESSIVE_REFINEMENT,
  EVAL_MULTITURN_UNDO_SPECIFIC,
  EVAL_MULTITURN_CONTRADICTORY,
  EVAL_MULTITURN_IMPLICIT_REFERENCE,
]

export const RELATIONSHIP_CHANGE_EVALS: AgentEval[] = [
  EVAL_RELATIONSHIP_MANY_TO_MANY,
  EVAL_RELATIONSHIP_SELF_REFERENTIAL,
  EVAL_RELATIONSHIP_CASCADE,
]

export const GRACEFUL_DEGRADATION_EVALS: AgentEval[] = [
  EVAL_IMPOSSIBLE_EMAIL_REMINDER,
  EVAL_IMPOSSIBLE_CALENDAR_SYNC,
  EVAL_IMPOSSIBLE_SCAN_CARDS,
  EVAL_IMPOSSIBLE_AI_CATEGORIZE,
]

export const ERROR_RECOVERY_EVALS: AgentEval[] = [
  EVAL_ERROR_APP_CRASHES,
  EVAL_ERROR_DATA_MISSING,
  EVAL_ERROR_CANT_DELETE,
]

export const CONDITIONAL_LOGIC_EVALS: AgentEval[] = [
  EVAL_CONDITIONAL_REQUIRED_FIELD,
  EVAL_CONDITIONAL_AUTO_STATUS,
  EVAL_CONDITIONAL_DEFAULT_BY_TYPE,
]

export const MIGRATION_CONCERN_EVALS: AgentEval[] = [
  EVAL_MIGRATION_EXISTING_DATA,
  EVAL_MIGRATION_RENAME,
  EVAL_MIGRATION_REQUIRED_EXISTING,
]

export const FRAMEWORK_SPECIFIC_EVALS: AgentEval[] = [
  EVAL_FRAMEWORK_UNIQUE_CONSTRAINT,
  EVAL_FRAMEWORK_SOFT_DELETE,
  EVAL_FRAMEWORK_INDEX_PERFORMANCE,
]

// All business user evals combined
export const ALL_BUSINESS_USER_EVALS: AgentEval[] = [
  ...VAGUE_BUSINESS_LANGUAGE_EVALS,
  ...BUSINESS_LOGIC_CONFUSION_EVALS,
  ...MULTI_TURN_COHERENCE_EVALS,
  ...RELATIONSHIP_CHANGE_EVALS,
  ...GRACEFUL_DEGRADATION_EVALS,
  ...ERROR_RECOVERY_EVALS,
  ...CONDITIONAL_LOGIC_EVALS,
  ...MIGRATION_CONCERN_EVALS,
  ...FRAMEWORK_SPECIFIC_EVALS,
]

// By difficulty level
export const LEVEL_4_BUSINESS_EVALS = ALL_BUSINESS_USER_EVALS.filter((e) => e.level === 4)
export const LEVEL_5_BUSINESS_EVALS = ALL_BUSINESS_USER_EVALS.filter((e) => e.level === 5)
export const LEVEL_6_BUSINESS_EVALS = ALL_BUSINESS_USER_EVALS.filter((e) => e.level === 6)
