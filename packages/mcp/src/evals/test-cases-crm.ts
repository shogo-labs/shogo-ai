/**
 * CRM Template Evals
 * 
 * Non-technical user requests that test the agent's ability to modify
 * a complex CRM application with multiple related models:
 * - Contact, Company, Tag, Note, Deal
 */

import type { AgentEval, ValidationCriterion, EvalResult } from './types'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// ============================================
// Helper Functions
// ============================================

function getProjectDir(result: EvalResult): string | null {
  // Check tool calls for project directory
  for (const tc of result.toolCalls) {
    if (tc.name === 'template.copy') {
      return tc.params?.targetDir || tc.params?.target_dir || '/tmp/shogo-eval-test'
    }
  }
  // Default fallback
  if (existsSync('/tmp/shogo-eval-test/prisma/schema.prisma')) {
    return '/tmp/shogo-eval-test'
  }
  return null
}

function createFileContainsCriterion(
  filePath: string,
  expectedContent: string | RegExp,
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
      if (typeof expectedContent === 'string') {
        return content.includes(expectedContent)
      }
      return expectedContent.test(content)
    },
  }
}

function createSchemaContainsCriterion(
  expectedContent: string | RegExp,
  points: number,
  description: string
): ValidationCriterion {
  return createFileContainsCriterion('prisma/schema.prisma', expectedContent, points, description)
}

function createUsedTemplateCriterion(templateName: string, points: number): ValidationCriterion {
  return {
    id: 'used-template',
    description: `Used template.copy with ${templateName} template`,
    points,
    validate: (result) => {
      const copyCall = result.toolCalls.find(t => t.name === 'template.copy')
      if (copyCall?.params?.template === templateName) return true
      
      // Fallback: check if project structure exists
      const projectDir = getProjectDir(result)
      if (!projectDir) return false
      return existsSync(join(projectDir, 'prisma/schema.prisma'))
    },
  }
}

function createRanPrismaGenerateCriterion(points: number): ValidationCriterion {
  return {
    id: 'ran-prisma-generate',
    description: 'Ran prisma generate/db push after schema changes',
    points,
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
// CRM Evals - Easy (Schema field additions)
// ============================================

/**
 * "I want to know when I last talked to each contact"
 * → Add lastContactedAt field to Contact
 */
export const EVAL_CRM_LAST_CONTACTED: AgentEval = {
  id: 'crm-last-contacted',
  name: 'CRM: Track Last Contact Date',
  category: 'multi-turn',
  level: 4,
  input: 'Build me a CRM and add a way to track when I last talked to each contact.',
  expectedTemplate: 'crm',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'crm' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 15),
    createSchemaContainsCriterion(
      /lastContacted|last_contacted/i,
      30,
      'Added lastContactedAt field to Contact model'
    ),
    createRanPrismaGenerateCriterion(15),
    // Check UI was updated to show the field
    {
      id: 'ui-shows-field',
      description: 'UI displays or allows editing last contacted date',
      points: 20,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        // Check routes file for lastContacted reference
        const routesPath = join(projectDir, 'src/routes/index.tsx')
        if (!existsSync(routesPath)) return false
        
        const content = readFileSync(routesPath, 'utf-8')
        return /lastContacted|last.?contacted/i.test(content)
      },
    },
  ],
  antiPatterns: [],
  maxScore: 80,
}

/**
 * "Add a LinkedIn profile field for contacts"
 * → Add linkedIn field to Contact
 */
export const EVAL_CRM_LINKEDIN: AgentEval = {
  id: 'crm-linkedin',
  name: 'CRM: Add LinkedIn Field',
  category: 'multi-turn',
  level: 4,
  input: 'Build a CRM for me. I want to be able to save each contact\'s LinkedIn profile.',
  expectedTemplate: 'crm',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'crm' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 15),
    createSchemaContainsCriterion(
      /linkedin|linkedIn|linked_in/i,
      30,
      'Added LinkedIn field to Contact model'
    ),
    createRanPrismaGenerateCriterion(15),
  ],
  antiPatterns: [],
  maxScore: 60,
}

/**
 * "I want to mark deals as hot, warm, or cold"
 * → Add temperature/priority field to Deal
 */
export const EVAL_CRM_DEAL_TEMPERATURE: AgentEval = {
  id: 'crm-deal-temperature',
  name: 'CRM: Deal Temperature',
  category: 'multi-turn',
  level: 4,
  input: 'Set up a CRM for my sales team. I want to mark deals as hot, warm, or cold so we know which ones to focus on.',
  expectedTemplate: 'crm',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'crm' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 15),
    createSchemaContainsCriterion(
      /temperature|priority|hot.*warm.*cold/i,
      30,
      'Added temperature/priority field to Deal model'
    ),
    createRanPrismaGenerateCriterion(15),
  ],
  antiPatterns: [],
  maxScore: 60,
}

// ============================================
// CRM Evals - Medium (UI Changes)
// ============================================

/**
 * "Show me all contacts from the same company on one page"
 * → Modify UI to group/filter contacts by company
 */
export const EVAL_CRM_CONTACTS_BY_COMPANY: AgentEval = {
  id: 'crm-contacts-by-company',
  name: 'CRM: View Contacts by Company',
  category: 'multi-turn',
  level: 5,
  input: 'Build me a CRM. I want to be able to click on a company and see all the contacts who work there.',
  expectedTemplate: 'crm',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'crm' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 15),
    // Check for company-based filtering in UI
    {
      id: 'company-filter-ui',
      description: 'UI has company filtering or company detail view',
      points: 35,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const routesPath = join(projectDir, 'src/routes/index.tsx')
        if (!existsSync(routesPath)) return false
        
        const content = readFileSync(routesPath, 'utf-8')
        // Look for company-based filtering logic
        return /company.*contacts|contacts.*filter.*company|selectedCompany/i.test(content)
      },
    },
  ],
  antiPatterns: [],
  maxScore: 50,
}

/**
 * "Color code my deals by how likely they are to close"
 * → Add visual indicators based on stage/probability
 */
export const EVAL_CRM_DEAL_COLORS: AgentEval = {
  id: 'crm-deal-colors',
  name: 'CRM: Color Code Deals',
  category: 'multi-turn',
  level: 5,
  input: 'Create a CRM for me. I want the deals to be color-coded based on their stage - green for won, red for lost, yellow for in progress.',
  expectedTemplate: 'crm',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'crm' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 15),
    {
      id: 'deal-colors',
      description: 'Deals have conditional coloring based on stage',
      points: 35,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const routesPath = join(projectDir, 'src/routes/index.tsx')
        if (!existsSync(routesPath)) return false
        
        const content = readFileSync(routesPath, 'utf-8')
        // Look for conditional styling based on stage
        return (/stage.*green|stage.*red|won.*green|lost.*red/i.test(content) ||
                /bg-green|bg-red|text-green|text-red/i.test(content))
      },
    },
  ],
  antiPatterns: [],
  maxScore: 50,
}

// ============================================
// CRM Evals - Hard (Multiple model changes)
// ============================================

/**
 * "I want to track expected close dates for my deals"
 * → Add expectedCloseDate field + UI for date picker
 */
export const EVAL_CRM_EXPECTED_CLOSE: AgentEval = {
  id: 'crm-expected-close',
  name: 'CRM: Deal Expected Close Date',
  category: 'multi-turn',
  level: 5,
  input: 'Build a CRM. I need to track when each deal is expected to close so I can forecast my sales.',
  expectedTemplate: 'crm',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'crm' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 15),
    createSchemaContainsCriterion(
      /expectedClose|expected_close|closeDate|close_date/i,
      25,
      'Added expected close date field to Deal model'
    ),
    createRanPrismaGenerateCriterion(10),
    {
      id: 'date-ui',
      description: 'UI allows setting/viewing expected close date',
      points: 20,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const routesPath = join(projectDir, 'src/routes/index.tsx')
        if (!existsSync(routesPath)) return false
        
        const content = readFileSync(routesPath, 'utf-8')
        return /type="date"|expectedClose|closeDate/i.test(content)
      },
    },
  ],
  antiPatterns: [],
  maxScore: 70,
}

/**
 * "Add a way to track meeting notes with contacts"
 * → The Note model already exists, but ensure type="meeting" is used/displayed
 */
export const EVAL_CRM_MEETING_NOTES: AgentEval = {
  id: 'crm-meeting-notes',
  name: 'CRM: Meeting Notes',
  category: 'multi-turn',
  level: 5,
  input: 'I need a CRM where I can log meeting notes for each contact. I want to see a history of all my meetings with them.',
  expectedTemplate: 'crm',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'crm' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('crm', 15),
    {
      id: 'meeting-notes-ui',
      description: 'UI shows meeting notes or allows creating notes with type=meeting',
      points: 35,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const routesPath = join(projectDir, 'src/routes/index.tsx')
        if (!existsSync(routesPath)) return false
        
        const content = readFileSync(routesPath, 'utf-8')
        return /meeting|notes|type.*meeting/i.test(content)
      },
    },
  ],
  antiPatterns: [],
  maxScore: 50,
}

// ============================================
// CRM Evals - Edge Cases
// ============================================

/**
 * "Send automated emails to my contacts" 
 * → Should explain this isn't supported
 */
export const EVAL_CRM_AUTO_EMAILS: AgentEval = {
  id: 'crm-auto-emails',
  name: 'CRM: Automated Emails (Unsupported)',
  category: 'edge-cases',
  level: 4,
  input: 'Build me a CRM that can automatically send follow-up emails to my contacts.',
  expectedTemplate: 'crm',
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'explains-limitation',
      description: 'Explains that automated emails are not supported',
      points: 50,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (text.includes('cannot') || text.includes("can't") || text.includes('not supported') ||
                text.includes('limitation') || text.includes('not possible') || 
                text.includes('would require') || text.includes('email service'))
      },
    },
    createUsedTemplateCriterion('crm', 20),
  ],
  antiPatterns: [],
  maxScore: 70,
}

/**
 * "Import my contacts from Salesforce"
 * → Should explain import isn't directly supported
 */
export const EVAL_CRM_IMPORT: AgentEval = {
  id: 'crm-import',
  name: 'CRM: Import from Salesforce (Unsupported)',
  category: 'edge-cases',
  level: 4,
  input: 'I need a CRM. Can you import all my contacts from Salesforce?',
  expectedTemplate: 'crm',
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'explains-import-limitation',
      description: 'Explains that direct import is not supported',
      points: 50,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (text.includes('cannot') || text.includes("can't") || text.includes('not supported') ||
                text.includes('manual') || text.includes('limitation') ||
                text.includes('csv') || text.includes('integration'))
      },
    },
  ],
  antiPatterns: [],
  maxScore: 50,
}

// ============================================
// Export all CRM evals
// ============================================

export const ALL_CRM_EVALS: AgentEval[] = [
  // Easy - field additions
  EVAL_CRM_LAST_CONTACTED,
  EVAL_CRM_LINKEDIN,
  EVAL_CRM_DEAL_TEMPERATURE,
  // Medium - UI changes
  EVAL_CRM_CONTACTS_BY_COMPANY,
  EVAL_CRM_DEAL_COLORS,
  // Hard - multiple changes
  EVAL_CRM_EXPECTED_CLOSE,
  EVAL_CRM_MEETING_NOTES,
  // Edge cases
  EVAL_CRM_AUTO_EMAILS,
  EVAL_CRM_IMPORT,
]

export const CRM_SCHEMA_EVALS = ALL_CRM_EVALS.filter(e => 
  e.validationCriteria.some(c => c.id === 'schema-modified' || c.description.includes('schema'))
)

export const CRM_UI_EVALS = ALL_CRM_EVALS.filter(e =>
  e.validationCriteria.some(c => c.description.toLowerCase().includes('ui'))
)

export const CRM_EDGE_EVALS = ALL_CRM_EVALS.filter(e => e.category === 'edge-cases')
