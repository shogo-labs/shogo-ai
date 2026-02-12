/**
 * Pre-defined Test Cases for Shogo Agent Evals
 *
 * These can be used directly in tests or as examples.
 */

import type { AgentEval, ValidationPhase } from './types'
import {
  createTemplateSelectionCriterion,
  createNoClarificationCriterion,
  createToolUsageCriterion,
  createNoManualCommandsCriterion,
  createOfferedCustomizationCriterion,
  createErrorHandlingCriterion,
} from './validators'

// ============================================
// Template Selection - Direct Match
// ============================================

export const EVAL_TODO_DIRECT: AgentEval = {
  id: 'template-selection-todo-direct',
  name: 'Direct Match: Todo App',
  category: 'template-selection',
  level: 1,
  input: 'Build me a todo app',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'todo-app' },
      required: true,
    },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('todo-app', 40),
    createNoClarificationCriterion(20),
    createToolUsageCriterion({ template: 'todo-app' }, 20),
    createNoManualCommandsCriterion(10),
    createOfferedCustomizationCriterion(10),
  ],
  antiPatterns: [
    'Asking unnecessary questions when "todo" was specified',
    'Selecting kanban instead of todo-app',
    'Writing custom code without using template',
  ],
  variations: [
    'Create a todo application',
    'I need a todo list',
    'Make me a task tracker',
    'Build a simple task app',
  ],
  maxScore: 100,
}

export const EVAL_EXPENSE_DIRECT: AgentEval = {
  id: 'template-selection-expense-direct',
  name: 'Direct Match: Expense Tracker',
  category: 'template-selection',
  level: 1,
  input: 'Build an expense tracker',
  expectedTemplate: 'expense-tracker',
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'expense-tracker' },
      required: true,
    },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('expense-tracker', 40),
    createNoClarificationCriterion(20),
    createToolUsageCriterion({ template: 'expense-tracker' }, 20),
    createNoManualCommandsCriterion(10),
    createOfferedCustomizationCriterion(10),
  ],
  antiPatterns: [
    'Selecting todo-app because "tracking" was mentioned',
    'Asking clarifying questions',
  ],
  variations: [
    'Create a budget app',
    'I need to track my spending',
    'Build me a finance tracker',
    'Money management app',
  ],
  maxScore: 100,
}

export const EVAL_CRM_DIRECT: AgentEval = {
  id: 'template-selection-crm-direct',
  name: 'Direct Match: CRM',
  category: 'template-selection',
  level: 1,
  input: 'Build a CRM for my business',
  expectedTemplate: 'crm',
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'crm' },
      required: true,
    },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('crm', 40),
    createNoClarificationCriterion(20),
    createToolUsageCriterion({ template: 'crm' }, 20),
    createNoManualCommandsCriterion(10),
    createOfferedCustomizationCriterion(10),
  ],
  antiPatterns: [
    'Selecting inventory instead of crm',
    'Asking what CRM means',
  ],
  variations: [
    'Customer relationship management system',
    'I need to track my sales leads',
    'Build a customer database',
    'Sales pipeline app',
  ],
  maxScore: 100,
}

export const EVAL_KANBAN_DIRECT: AgentEval = {
  id: 'template-selection-kanban-direct',
  name: 'Direct Match: Kanban',
  category: 'template-selection',
  level: 1,
  input: 'Build a kanban board',
  expectedTemplate: 'kanban',
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'kanban' },
      required: true,
    },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('kanban', 40),
    createNoClarificationCriterion(20),
    createToolUsageCriterion({ template: 'kanban' }, 20),
    createNoManualCommandsCriterion(10),
    createOfferedCustomizationCriterion(10),
  ],
  antiPatterns: [
    'Selecting todo-app instead of kanban',
  ],
  variations: [
    'Project board with drag and drop',
    'Task board with columns',
    'Agile project management app',
  ],
  maxScore: 100,
}

// ============================================
// Template Selection - Semantic Match
// ============================================

export const EVAL_SEMANTIC_ORGANIZE: AgentEval = {
  id: 'template-selection-semantic-organize',
  name: 'Semantic Match: Stay Organized',
  category: 'template-selection',
  level: 2,
  input: 'I need something to help me stay organized with my daily work',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'todo-app' },
      required: true,
    },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('todo-app', 50),
    createNoClarificationCriterion(25),
    createToolUsageCriterion({ template: 'todo-app' }, 25),
  ],
  antiPatterns: [
    'Selecting crm or inventory for personal organization',
  ],
  maxScore: 100,
}

export const EVAL_SEMANTIC_MONEY: AgentEval = {
  id: 'template-selection-semantic-money',
  name: 'Semantic Match: Track Money',
  category: 'template-selection',
  level: 2,
  input: 'Help me see where my money goes each month',
  expectedTemplate: 'expense-tracker',
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'expense-tracker' },
      required: true,
    },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('expense-tracker', 50),
    createNoClarificationCriterion(25),
    createToolUsageCriterion({ template: 'expense-tracker' }, 25),
  ],
  antiPatterns: [
    'Selecting todo-app or inventory',
  ],
  maxScore: 100,
}

export const EVAL_SEMANTIC_CLIENTS: AgentEval = {
  id: 'template-selection-semantic-clients',
  name: 'Semantic Match: Track Clients',
  category: 'template-selection',
  level: 2,
  input: 'I run a small business and need to keep track of all my clients',
  expectedTemplate: 'crm',
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'crm' },
      required: true,
    },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('crm', 50),
    createNoClarificationCriterion(25),
    createToolUsageCriterion({ template: 'crm' }, 25),
  ],
  antiPatterns: [
    'Selecting inventory instead of crm',
  ],
  maxScore: 100,
}

// ============================================
// Ambiguous Requests
// ============================================

export const EVAL_AMBIGUOUS_TEAM: AgentEval = {
  id: 'ambiguous-team',
  name: 'Ambiguous: Build for Team',
  category: 'template-selection',
  level: 3,
  input: 'Build something for my team',
  expectedToolCalls: [], // Should ask clarification, not call tools
  validationCriteria: [
    {
      id: 'asked-clarification',
      description: 'Asked for clarification',
      points: 40,
      phase: 'intention' as ValidationPhase,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('?') && 
          (text.includes('what') || text.includes('which') || text.includes('would you'))
      },
    },
    {
      id: 'offered-options',
      description: 'Offered concrete options',
      points: 30,
      phase: 'intention' as ValidationPhase,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        // Should mention at least 2 template types
        const mentions = [
          text.includes('todo') || text.includes('task'),
          text.includes('kanban') || text.includes('board'),
          text.includes('crm') || text.includes('customer'),
        ]
        return mentions.filter(Boolean).length >= 2
      },
    },
    {
      id: 'single-question',
      description: 'Asked only one question',
      points: 30,
      phase: 'intention' as ValidationPhase,
      validate: (result) => {
        const questions = (result.responseText.match(/\?/g) || []).length
        return questions <= 2 // Allow some flexibility
      },
    },
  ],
  antiPatterns: [
    'Randomly selecting a template without asking',
    'Asking multiple separate questions',
  ],
  maxScore: 100,
}

export const EVAL_AMBIGUOUS_TRACK: AgentEval = {
  id: 'ambiguous-track-things',
  name: 'Ambiguous: Track Things',
  category: 'template-selection',
  level: 3,
  input: 'I need to track things',
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'asked-clarification',
      description: 'Asked for clarification about WHAT to track',
      points: 50,
      phase: 'intention' as ValidationPhase,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('?') && text.includes('track')
      },
    },
    {
      id: 'offered-categories',
      description: 'Offered different tracking categories',
      points: 50,
      phase: 'intention' as ValidationPhase,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        const categories = [
          'task', 'todo', 'expense', 'money', 'customer', 
          'inventory', 'product', 'project'
        ]
        const mentioned = categories.filter(c => text.includes(c))
        return mentioned.length >= 2
      },
    },
  ],
  antiPatterns: [
    'Selecting todo-app by default',
    'Not offering options',
  ],
  maxScore: 100,
}

// ============================================
// Tool Usage - Parameters
// ============================================

export const EVAL_PARAMS_WITH_NAME: AgentEval = {
  id: 'tool-params-with-name',
  name: 'Tool Usage: With Project Name',
  category: 'tool-usage',
  level: 2,
  input: 'Build a todo app called my-daily-tasks',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'todo-app', name: 'my-daily-tasks' },
      required: true,
    },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('todo-app', 30),
    {
      id: 'correct-name',
      description: 'Used specified project name',
      points: 40,
      phase: 'intention' as ValidationPhase,
      validate: (result) => {
        const copyCall = result.toolCalls.find(t => t.name === 'template.copy')
        return copyCall?.params?.name === 'my-daily-tasks'
      },
    },
    createNoManualCommandsCriterion(30),
  ],
  antiPatterns: [
    'Using different project name',
    'Not including name parameter',
  ],
  maxScore: 100,
}

export const EVAL_PARAMS_WITH_THEME: AgentEval = {
  id: 'tool-params-with-theme',
  name: 'Tool Usage: With Theme',
  category: 'tool-usage',
  level: 2,
  input: 'Create an expense tracker with a purple theme',
  expectedTemplate: 'expense-tracker',
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'expense-tracker', theme: 'lavender' },
      required: true,
    },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('expense-tracker', 30),
    {
      id: 'correct-theme',
      description: 'Mapped purple to lavender theme',
      points: 40,
      phase: 'intention' as ValidationPhase,
      validate: (result) => {
        const copyCall = result.toolCalls.find(t => t.name === 'template.copy')
        return copyCall?.params?.theme === 'lavender'
      },
    },
    createNoManualCommandsCriterion(30),
  ],
  antiPatterns: [
    'Not including theme',
    'Using "purple" instead of "lavender"',
  ],
  maxScore: 100,
}

// ============================================
// Error Handling
// ============================================

export const EVAL_ERROR_INVALID_TEMPLATE: AgentEval = {
  id: 'error-invalid-template',
  name: 'Error Handling: Invalid Template',
  category: 'tool-usage',
  level: 3,
  input: 'Use the social-media template',
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'acknowledged-error',
      description: 'Acknowledged template does not exist',
      points: 30,
      phase: 'intention' as ValidationPhase,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes("don't have") || 
               text.includes('not available') ||
               text.includes('not found')
      },
    },
    {
      id: 'listed-alternatives',
      description: 'Listed available templates',
      points: 40,
      phase: 'intention' as ValidationPhase,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('todo') || text.includes('expense') || text.includes('crm')
      },
    },
    {
      id: 'offered-help',
      description: 'Offered to help with alternatives',
      points: 30,
      phase: 'intention' as ValidationPhase,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('would') || text.includes('help') || text.includes('?')
      },
    },
  ],
  antiPatterns: [
    'Crashing or giving up',
    'Pretending template exists',
  ],
  maxScore: 100,
}

// ============================================
// Edge Cases
// ============================================

export const EVAL_EDGE_TODO_VS_KANBAN: AgentEval = {
  id: 'edge-todo-vs-kanban',
  name: 'Edge Case: Todo vs Kanban',
  category: 'edge-cases',
  level: 4,
  input: 'I need to track tasks for my project',
  expectedTemplate: 'todo-app', // Simpler is preferred when ambiguous
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'todo-app' },
      required: false, // May ask first
    },
  ],
  validationCriteria: [
    {
      id: 'reasonable-choice',
      description: 'Made reasonable template choice or asked',
      points: 50,
      phase: 'intention' as ValidationPhase,
      validate: (result) => {
        const copyCall = result.toolCalls.find(t => t.name === 'template.copy')
        const template = copyCall?.params?.template
        // Either todo-app, kanban, or asked for clarification
        return template === 'todo-app' || 
               template === 'kanban' ||
               result.responseText.includes('?')
      },
    },
    {
      id: 'explained-choice',
      description: 'Explained or justified the choice',
      points: 50,
      phase: 'intention' as ValidationPhase,
      validate: (result) => {
        return result.responseText.length > 50 // Should have some explanation
      },
    },
  ],
  antiPatterns: [
    'Selecting unrelated template (crm, expense-tracker)',
  ],
  maxScore: 100,
}

// ============================================
// Import Hard Evals
// ============================================

import { ALL_HARD_EVALS, MULTI_TURN_EVALS, EDGE_CASE_HARD_EVALS } from './test-cases-hard'
import { ALL_CRM_EVALS, CRM_SCHEMA_EVALS, CRM_UI_EVALS, CRM_EDGE_EVALS } from './test-cases-crm'
import { ALL_INVENTORY_EVALS, INVENTORY_SCHEMA_EVALS, INVENTORY_UI_EVALS, INVENTORY_EDGE_EVALS } from './test-cases-inventory'
import { ALL_BUSINESS_USER_EVALS } from './test-cases-business-user'
import { ALL_SHADCN_EVALS, SHADCN_COMPONENT_EVALS, SHADCN_IMPORT_EVALS } from './test-cases-shadcn'

// ============================================
// Export All Evals
// ============================================

export const BASIC_EVALS: AgentEval[] = [
  // Direct matches
  EVAL_TODO_DIRECT,
  EVAL_EXPENSE_DIRECT,
  EVAL_CRM_DIRECT,
  EVAL_KANBAN_DIRECT,
  // Semantic matches
  EVAL_SEMANTIC_ORGANIZE,
  EVAL_SEMANTIC_MONEY,
  EVAL_SEMANTIC_CLIENTS,
  // Ambiguous
  EVAL_AMBIGUOUS_TEAM,
  EVAL_AMBIGUOUS_TRACK,
  // Tool usage
  EVAL_PARAMS_WITH_NAME,
  EVAL_PARAMS_WITH_THEME,
  // Error handling
  EVAL_ERROR_INVALID_TEMPLATE,
  // Edge cases
  EVAL_EDGE_TODO_VS_KANBAN,
]

// All evals including hard tests
export const ALL_EVALS: AgentEval[] = [
  ...BASIC_EVALS,
  ...ALL_HARD_EVALS,
  ...ALL_CRM_EVALS,
  ...ALL_INVENTORY_EVALS,
  ...ALL_BUSINESS_USER_EVALS,
  ...ALL_SHADCN_EVALS,
]

export const TEMPLATE_SELECTION_EVALS = ALL_EVALS.filter(
  e => e.category === 'template-selection'
)

export const TOOL_USAGE_EVALS = ALL_EVALS.filter(
  e => e.category === 'tool-usage'
)

export const EDGE_CASE_EVALS = ALL_EVALS.filter(
  e => e.category === 'edge-cases'
)

// Re-export hard evals for direct access
export { ALL_HARD_EVALS, MULTI_TURN_EVALS, EDGE_CASE_HARD_EVALS }

// Re-export template-specific evals
export { ALL_CRM_EVALS, CRM_SCHEMA_EVALS, CRM_UI_EVALS, CRM_EDGE_EVALS }
export { ALL_INVENTORY_EVALS, INVENTORY_SCHEMA_EVALS, INVENTORY_UI_EVALS, INVENTORY_EDGE_EVALS }

// Re-export business user evals (harder tests for non-technical users)
export {
  ALL_BUSINESS_USER_EVALS,
  VAGUE_BUSINESS_LANGUAGE_EVALS,
  BUSINESS_LOGIC_CONFUSION_EVALS,
  MULTI_TURN_COHERENCE_EVALS,
  RELATIONSHIP_CHANGE_EVALS,
  GRACEFUL_DEGRADATION_EVALS,
  ERROR_RECOVERY_EVALS,
  CONDITIONAL_LOGIC_EVALS,
  MIGRATION_CONCERN_EVALS,
  FRAMEWORK_SPECIFIC_EVALS,
  LEVEL_4_BUSINESS_EVALS,
  LEVEL_5_BUSINESS_EVALS,
  LEVEL_6_BUSINESS_EVALS,
} from './test-cases-business-user'

// Re-export shadcn evals (UI component usage tests)
export {
  ALL_SHADCN_EVALS,
  SHADCN_COMPONENT_EVALS,
  SHADCN_IMPORT_EVALS,
} from './test-cases-shadcn'
