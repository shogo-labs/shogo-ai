/**
 * Extended Test Cases for Shogo Agent Evals
 *
 * Additional test cases covering more scenarios and edge cases.
 */

import type { AgentEval } from './types'
import {
  createTemplateSelectionCriterion,
  createNoClarificationCriterion,
  createToolUsageCriterion,
  createNoManualCommandsCriterion,
  createOfferedCustomizationCriterion,
} from './validators'

// ============================================
// Template Selection - All Templates Direct Match
// ============================================

export const EVAL_INVENTORY_DIRECT: AgentEval = {
  id: 'template-selection-inventory-direct',
  name: 'Direct Match: Inventory',
  category: 'template-selection',
  level: 1,
  input: 'Build an inventory management system',
  expectedTemplate: 'inventory',
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'inventory' },
      required: true,
    },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('inventory', 40),
    createNoClarificationCriterion(20),
    createToolUsageCriterion({ template: 'inventory' }, 20),
    createNoManualCommandsCriterion(10),
    createOfferedCustomizationCriterion(10),
  ],
  antiPatterns: [
    'Selecting expense-tracker for inventory',
    'Asking clarifying questions',
  ],
  variations: [
    'Stock management app',
    'Product tracking system',
    'Warehouse management',
    'Track my inventory',
  ],
  maxScore: 100,
}

export const EVAL_AI_CHAT_DIRECT: AgentEval = {
  id: 'template-selection-ai-chat-direct',
  name: 'Direct Match: AI Chat',
  category: 'template-selection',
  level: 1,
  input: 'Build an AI chatbot',
  expectedTemplate: 'ai-chat',
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'ai-chat' },
      required: true,
    },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('ai-chat', 40),
    createNoClarificationCriterion(20),
    createToolUsageCriterion({ template: 'ai-chat' }, 20),
    createNoManualCommandsCriterion(10),
    createOfferedCustomizationCriterion(10),
  ],
  antiPatterns: [
    'Selecting feedback-form for chatbot',
  ],
  variations: [
    'Create a chat assistant',
    'AI-powered chat interface',
    'Build a conversational AI',
    'Chatbot application',
  ],
  maxScore: 100,
}

export const EVAL_FORM_BUILDER_DIRECT: AgentEval = {
  id: 'template-selection-form-builder-direct',
  name: 'Direct Match: Form Builder',
  category: 'template-selection',
  level: 1,
  input: 'Build a form builder',
  expectedTemplate: 'form-builder',
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'form-builder' },
      required: true,
    },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('form-builder', 40),
    createNoClarificationCriterion(20),
    createToolUsageCriterion({ template: 'form-builder' }, 20),
    createNoManualCommandsCriterion(10),
    createOfferedCustomizationCriterion(10),
  ],
  antiPatterns: [
    'Selecting feedback-form for form builder',
  ],
  variations: [
    'Create dynamic forms',
    'Survey creation tool',
    'Questionnaire builder',
    'Custom form application',
  ],
  maxScore: 100,
}

export const EVAL_FEEDBACK_FORM_DIRECT: AgentEval = {
  id: 'template-selection-feedback-form-direct',
  name: 'Direct Match: Feedback Form',
  category: 'template-selection',
  level: 1,
  input: 'Build a feedback collection form',
  expectedTemplate: 'feedback-form',
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'feedback-form' },
      required: true,
    },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('feedback-form', 40),
    createNoClarificationCriterion(20),
    createToolUsageCriterion({ template: 'feedback-form' }, 20),
    createNoManualCommandsCriterion(10),
    createOfferedCustomizationCriterion(10),
  ],
  antiPatterns: [
    'Selecting form-builder when user specifically wants feedback',
  ],
  variations: [
    'User feedback collection',
    'Rating system',
    'Customer feedback tool',
    'Review collection app',
  ],
  maxScore: 100,
}

export const EVAL_BOOKING_APP_DIRECT: AgentEval = {
  id: 'template-selection-booking-app-direct',
  name: 'Direct Match: Booking App',
  category: 'template-selection',
  level: 1,
  input: 'Build a booking system',
  expectedTemplate: 'booking-app',
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'booking-app' },
      required: true,
    },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('booking-app', 40),
    createNoClarificationCriterion(20),
    createToolUsageCriterion({ template: 'booking-app' }, 20),
    createNoManualCommandsCriterion(10),
    createOfferedCustomizationCriterion(10),
  ],
  antiPatterns: [
    'Selecting CRM instead of booking-app',
  ],
  variations: [
    'Appointment scheduler',
    'Reservation app',
    'Calendar booking tool',
    'Schedule appointments',
  ],
  maxScore: 100,
}

// ============================================
// Semantic Match - More Complex
// ============================================

export const EVAL_SEMANTIC_VISUAL_WORKFLOW: AgentEval = {
  id: 'template-selection-semantic-visual-workflow',
  name: 'Semantic Match: Visual Workflow',
  category: 'template-selection',
  level: 2,
  input: 'I want to visualize my project workflow with draggable cards',
  expectedTemplate: 'kanban',
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'kanban' },
      required: true,
    },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('kanban', 50),
    createNoClarificationCriterion(25),
    createToolUsageCriterion({ template: 'kanban' }, 25),
  ],
  antiPatterns: [
    'Selecting todo-app for visual/card-based request',
  ],
  maxScore: 100,
}

export const EVAL_SEMANTIC_WAREHOUSE: AgentEval = {
  id: 'template-selection-semantic-warehouse',
  name: 'Semantic Match: Warehouse Stock',
  category: 'template-selection',
  level: 2,
  input: "I need to know what's in stock at my warehouse",
  expectedTemplate: 'inventory',
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'inventory' },
      required: true,
    },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('inventory', 50),
    createNoClarificationCriterion(25),
    createToolUsageCriterion({ template: 'inventory' }, 25),
  ],
  antiPatterns: [
    'Selecting expense-tracker for warehouse',
  ],
  maxScore: 100,
}

export const EVAL_SEMANTIC_SCHEDULE_MEETINGS: AgentEval = {
  id: 'template-selection-semantic-schedule',
  name: 'Semantic Match: Schedule Meetings',
  category: 'template-selection',
  level: 2,
  input: 'Help me schedule meetings with clients',
  expectedTemplate: 'booking-app',
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'booking-app' },
      required: true,
    },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('booking-app', 50),
    createNoClarificationCriterion(25),
    createToolUsageCriterion({ template: 'booking-app' }, 25),
  ],
  antiPatterns: [
    'Selecting CRM just because "clients" was mentioned',
  ],
  maxScore: 100,
}

// ============================================
// Tool Usage - Theme Variations
// ============================================

export const EVAL_THEME_BLUE: AgentEval = {
  id: 'tool-params-theme-blue',
  name: 'Tool Usage: Blue Theme',
  category: 'tool-usage',
  level: 2,
  input: 'Build a kanban board with a cool blue theme',
  expectedTemplate: 'kanban',
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'kanban', theme: 'glacier' },
      required: true,
    },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('kanban', 30),
    {
      id: 'correct-theme-glacier',
      description: 'Mapped blue/cool to glacier theme',
      points: 40,
      validate: (result) => {
        const copyCall = result.toolCalls.find((t) => t.name === 'template.copy')
        return copyCall?.params?.theme === 'glacier'
      },
    },
    createNoManualCommandsCriterion(30),
  ],
  antiPatterns: [
    'Using "blue" instead of "glacier"',
    'Not including theme parameter',
  ],
  maxScore: 100,
}

export const EVAL_THEME_DEFAULT_EXPLICIT: AgentEval = {
  id: 'tool-params-theme-default',
  name: 'Tool Usage: Default Theme Explicit',
  category: 'tool-usage',
  level: 2,
  input: 'Build an expense tracker with the standard default theme',
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
    {
      id: 'default-or-no-theme',
      description: 'Used default theme or omitted theme param',
      points: 30,
      validate: (result) => {
        const copyCall = result.toolCalls.find((t) => t.name === 'template.copy')
        return !copyCall?.params?.theme || copyCall?.params?.theme === 'default'
      },
    },
    createNoManualCommandsCriterion(30),
  ],
  maxScore: 100,
}

// ============================================
// Tool Usage - template.list
// ============================================

export const EVAL_LIST_TEMPLATES: AgentEval = {
  id: 'tool-usage-list-templates',
  name: 'Tool Usage: List Templates',
  category: 'tool-usage',
  level: 2,
  input: 'What templates do you have available?',
  expectedToolCalls: [
    {
      name: 'template.list',
      required: true,
    },
  ],
  validationCriteria: [
    {
      id: 'called-template-list',
      description: 'Called template.list',
      points: 40,
      validate: (result) => {
        return result.toolCalls.some((t) => t.name === 'template.list')
      },
    },
    {
      id: 'listed-templates',
      description: 'Listed available templates in response',
      points: 30,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        // Should mention at least 3 templates
        const templates = ['todo', 'expense', 'crm', 'inventory', 'kanban', 'chat', 'form', 'feedback', 'booking']
        const mentioned = templates.filter((t) => text.includes(t))
        return mentioned.length >= 3
      },
    },
    {
      id: 'offered-to-create',
      description: 'Offered to create one',
      points: 30,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('create') || text.includes('build') || text.includes('would you like')
      },
    },
  ],
  antiPatterns: [
    'Creating a template without being asked',
  ],
  maxScore: 100,
}

export const EVAL_SEARCH_TEMPLATES: AgentEval = {
  id: 'tool-usage-search-templates',
  name: 'Tool Usage: Search Templates',
  category: 'tool-usage',
  level: 2,
  input: 'Do you have any templates for tracking money?',
  expectedToolCalls: [
    {
      name: 'template.list',
      params: { query: 'money' },
      required: false, // Could also use template.list() and filter
    },
  ],
  validationCriteria: [
    {
      id: 'searched-or-listed',
      description: 'Used template.list',
      points: 30,
      validate: (result) => {
        return result.toolCalls.some((t) => t.name === 'template.list')
      },
    },
    {
      id: 'mentioned-expense-tracker',
      description: 'Mentioned expense-tracker as relevant',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('expense')
      },
    },
    {
      id: 'offered-to-create',
      description: 'Offered to create it',
      points: 30,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('create') || text.includes('build') || text.includes('?')
      },
    },
  ],
  maxScore: 100,
}

// ============================================
// Edge Cases - Disambiguation
// ============================================

export const EVAL_EDGE_EXPENSE_VS_INVENTORY: AgentEval = {
  id: 'edge-expense-vs-inventory',
  name: 'Edge Case: Expense vs Inventory',
  category: 'edge-cases',
  level: 4,
  input: 'Help me track what I\'m spending on supplies',
  expectedTemplate: 'expense-tracker', // "spending" is the key action
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'expense-tracker' },
      required: false,
    },
  ],
  validationCriteria: [
    {
      id: 'reasonable-choice',
      description: 'Selected expense-tracker or asked for clarification',
      points: 50,
      validate: (result) => {
        const copyCall = result.toolCalls.find((t) => t.name === 'template.copy')
        const template = copyCall?.params?.template
        return template === 'expense-tracker' || result.responseText.includes('?')
      },
    },
    {
      id: 'explained-reasoning',
      description: 'Explained the choice or asked about need',
      points: 50,
      validate: (result) => {
        return result.responseText.length > 50
      },
    },
  ],
  antiPatterns: [
    'Selecting inventory without considering "spending"',
  ],
  maxScore: 100,
}

export const EVAL_EDGE_CRM_VS_BOOKING: AgentEval = {
  id: 'edge-crm-vs-booking',
  name: 'Edge Case: CRM vs Booking',
  category: 'edge-cases',
  level: 4,
  input: 'I need to manage my client appointments',
  expectedTemplate: 'booking-app', // "appointments" is more specific
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'booking-app' },
      required: false,
    },
  ],
  validationCriteria: [
    {
      id: 'reasonable-choice',
      description: 'Selected booking-app or CRM or asked',
      points: 50,
      validate: (result) => {
        const copyCall = result.toolCalls.find((t) => t.name === 'template.copy')
        const template = copyCall?.params?.template
        return template === 'booking-app' || 
               template === 'crm' || 
               result.responseText.includes('?')
      },
    },
    {
      id: 'recognized-dual-need',
      description: 'Acknowledged both client and appointment aspects',
      points: 50,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (text.includes('client') || text.includes('customer')) &&
               (text.includes('appointment') || text.includes('schedule') || text.includes('booking'))
      },
    },
  ],
  antiPatterns: [
    'Selecting todo-app for client appointments',
  ],
  maxScore: 100,
}

export const EVAL_EDGE_FORM_VS_FEEDBACK: AgentEval = {
  id: 'edge-form-vs-feedback',
  name: 'Edge Case: Form Builder vs Feedback',
  category: 'edge-cases',
  level: 4,
  input: 'I want to collect feedback through a form',
  expectedTemplate: 'feedback-form', // More specific to use case
  expectedToolCalls: [
    {
      name: 'template.copy',
      params: { template: 'feedback-form' },
      required: false,
    },
  ],
  validationCriteria: [
    {
      id: 'preferred-specific',
      description: 'Selected feedback-form (more specific) or asked',
      points: 60,
      validate: (result) => {
        const copyCall = result.toolCalls.find((t) => t.name === 'template.copy')
        const template = copyCall?.params?.template
        return template === 'feedback-form' || 
               template === 'form-builder' || 
               result.responseText.includes('?')
      },
    },
    {
      id: 'acknowledged-options',
      description: 'Mentioned feedback or form option',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('feedback') || text.includes('form')
      },
    },
  ],
  maxScore: 100,
}

// ============================================
// Multi-turn - Context Retention
// ============================================

export const EVAL_MULTITURN_REMEMBER_TEMPLATE: AgentEval = {
  id: 'multi-turn-remember-template',
  name: 'Multi-turn: Remember Template',
  category: 'multi-turn',
  level: 3,
  input: 'Add a priority field to the tasks',
  conversationHistory: [
    { role: 'user', content: 'Build a todo app' },
    {
      role: 'assistant',
      content: "I'll create a todo app for you.",
      toolCalls: [
        { name: 'template.copy', params: { template: 'todo-app', name: 'my-todo' } },
      ],
    },
  ],
  expectedToolCalls: [], // Should modify, not recreate
  validationCriteria: [
    {
      id: 'no-recreate',
      description: 'Did not recreate the project',
      points: 40,
      validate: (result) => {
        return !result.toolCalls.some((t) => t.name === 'template.copy')
      },
    },
    {
      id: 'understood-context',
      description: 'Understood we are working on todo app',
      points: 30,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('todo') || text.includes('task') || text.includes('priority')
      },
    },
    {
      id: 'proposed-modification',
      description: 'Proposed to modify existing app',
      points: 30,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('add') || text.includes('update') || text.includes('modify')
      },
    },
  ],
  antiPatterns: [
    'Recreating the entire project',
    'Asking what app we are working on',
  ],
  maxScore: 100,
}

export const EVAL_MULTITURN_THEME_CHANGE: AgentEval = {
  id: 'multi-turn-theme-change',
  name: 'Multi-turn: Theme Change',
  category: 'multi-turn',
  level: 3,
  input: 'Can you make it purple?',
  conversationHistory: [
    { role: 'user', content: 'Create an expense tracker' },
    {
      role: 'assistant',
      content: 'Your expense tracker is ready!',
      toolCalls: [
        { name: 'template.copy', params: { template: 'expense-tracker', name: 'my-expenses' } },
      ],
    },
  ],
  expectedToolCalls: [], // Should modify CSS, not recreate
  validationCriteria: [
    {
      id: 'understood-theme-request',
      description: 'Understood this is a theme change request',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('theme') || text.includes('purple') || text.includes('color') || text.includes('lavender')
      },
    },
    {
      id: 'no-full-recreate',
      description: 'Did not start from scratch',
      points: 30,
      validate: (result) => {
        // Should not call template.copy again (or if it does, acknowledge it's updating)
        const copyCall = result.toolCalls.find((t) => t.name === 'template.copy')
        if (!copyCall) return true
        // If it does call template.copy, it should be updating theme
        return copyCall.params?.theme === 'lavender'
      },
    },
    {
      id: 'mentioned-update',
      description: 'Mentioned updating or changing',
      points: 30,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('update') || text.includes('change') || text.includes('apply') || text.includes("'ll")
      },
    },
  ],
  antiPatterns: [
    'Asking what app they want purple',
    'Creating a brand new project',
  ],
  maxScore: 100,
}

// ============================================
// Export Extended Evals
// ============================================

export const EXTENDED_TEMPLATE_EVALS: AgentEval[] = [
  EVAL_INVENTORY_DIRECT,
  EVAL_AI_CHAT_DIRECT,
  EVAL_FORM_BUILDER_DIRECT,
  EVAL_FEEDBACK_FORM_DIRECT,
  EVAL_BOOKING_APP_DIRECT,
]

export const EXTENDED_SEMANTIC_EVALS: AgentEval[] = [
  EVAL_SEMANTIC_VISUAL_WORKFLOW,
  EVAL_SEMANTIC_WAREHOUSE,
  EVAL_SEMANTIC_SCHEDULE_MEETINGS,
]

export const EXTENDED_TOOL_USAGE_EVALS: AgentEval[] = [
  EVAL_THEME_BLUE,
  EVAL_THEME_DEFAULT_EXPLICIT,
  EVAL_LIST_TEMPLATES,
  EVAL_SEARCH_TEMPLATES,
]

export const EXTENDED_EDGE_CASE_EVALS: AgentEval[] = [
  EVAL_EDGE_EXPENSE_VS_INVENTORY,
  EVAL_EDGE_CRM_VS_BOOKING,
  EVAL_EDGE_FORM_VS_FEEDBACK,
]

export const EXTENDED_MULTI_TURN_EVALS: AgentEval[] = [
  EVAL_MULTITURN_REMEMBER_TEMPLATE,
  EVAL_MULTITURN_THEME_CHANGE,
]

// ============================================
// HARD: Misleading Language
// ============================================

export const EVAL_MISLEADING_TRACK_FITNESS: AgentEval = {
  id: 'misleading-track-fitness',
  name: 'Misleading: Track My Fitness',
  category: 'edge-cases',
  level: 5,
  input: 'Build an app to track my fitness',
  expectedTemplate: 'none', // Fitness tracking not in templates
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'no-wrong-template',
      description: 'Did not select expense-tracker or todo just because of "track"',
      points: 50,
      validate: (result) => {
        const copyCall = result.toolCalls.find((t) => t.name === 'template.copy')
        return !copyCall || copyCall.params?.template === 'none'
      },
    },
    {
      id: 'acknowledged-limitation',
      description: 'Acknowledged fitness tracking not available',
      points: 50,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('fitness') && 
               (text.includes("don't have") || text.includes('not available') || 
                text.includes('no template') || text.includes('custom'))
      },
    },
  ],
  antiPatterns: ['Selecting expense-tracker because it has "track"'],
  maxScore: 100,
}

export const EVAL_MISLEADING_MESSAGE_BOARD: AgentEval = {
  id: 'misleading-message-board',
  name: 'Misleading: Message Board',
  category: 'edge-cases',
  level: 5,
  input: 'Build a message board for our community',
  expectedTemplate: 'none', // Forum not in templates
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'no-kanban',
      description: 'Did not select kanban just because of "board"',
      points: 50,
      validate: (result) => {
        const copyCall = result.toolCalls.find((t) => t.name === 'template.copy')
        return !copyCall || copyCall.params?.template !== 'kanban'
      },
    },
    {
      id: 'acknowledged-limitation',
      description: 'Acknowledged forum/message board not available',
      points: 50,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('forum') || text.includes('message') || 
               text.includes('community') || text.includes('discussion')
      },
    },
  ],
  antiPatterns: ['Selecting kanban because "board" was mentioned'],
  maxScore: 100,
}

// ============================================
// HARD: Negative Tests (Explicit Exclusions)
// ============================================

export const EVAL_NEGATIVE_TASKS_NOT_KANBAN: AgentEval = {
  id: 'negative-tasks-not-kanban',
  name: 'Negative: Tasks Without Boards',
  category: 'edge-cases',
  level: 4,
  input: 'I want to track tasks but not as a kanban board',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'todo-app' }, required: true },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('todo-app', 60),
    {
      id: 'respected-exclusion',
      description: 'Respected the explicit exclusion of kanban',
      points: 40,
      validate: (result) => {
        const copyCall = result.toolCalls.find((t) => t.name === 'template.copy')
        return copyCall?.params?.template !== 'kanban'
      },
    },
  ],
  antiPatterns: ['Ignoring explicit kanban exclusion'],
  maxScore: 100,
}

export const EVAL_NEGATIVE_CUSTOMERS_NOT_BOOKING: AgentEval = {
  id: 'negative-customers-not-booking',
  name: 'Negative: Customers Without Appointments',
  category: 'edge-cases',
  level: 4,
  input: 'Track my customers but not their appointments',
  expectedTemplate: 'crm',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'crm' }, required: true },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('crm', 60),
    {
      id: 'respected-exclusion',
      description: 'Respected the explicit exclusion of appointments',
      points: 40,
      validate: (result) => {
        const copyCall = result.toolCalls.find((t) => t.name === 'template.copy')
        return copyCall?.params?.template !== 'booking-app'
      },
    },
  ],
  maxScore: 100,
}

// ============================================
// HARD: No Match Tests
// ============================================

export const EVAL_NO_MATCH_GAME: AgentEval = {
  id: 'no-match-game',
  name: 'No Match: Build a Game',
  category: 'edge-cases',
  level: 5,
  input: 'Build me a simple game',
  expectedTemplate: 'none',
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'no-template-selected',
      description: 'Did not force a template that does not fit',
      points: 50,
      validate: (result) => !result.toolCalls.some((t) => t.name === 'template.copy'),
    },
    {
      id: 'explained-limitation',
      description: 'Explained that games are not supported',
      points: 50,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('game') && 
               (text.includes("don't have") || text.includes('not available') || 
                text.includes('no template') || text.includes('custom'))
      },
    },
  ],
  antiPatterns: ['Forcing a template for a game request'],
  maxScore: 100,
}

export const EVAL_NO_MATCH_ECOMMERCE: AgentEval = {
  id: 'no-match-ecommerce',
  name: 'No Match: E-commerce Store',
  category: 'edge-cases',
  level: 5,
  input: 'Build an e-commerce store with cart and checkout',
  expectedTemplate: 'none',
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'no-template-selected',
      description: 'Did not force inventory template for e-commerce',
      points: 50,
      validate: (result) => {
        const copyCall = result.toolCalls.find((t) => t.name === 'template.copy')
        return !copyCall || copyCall.params?.template !== 'inventory'
      },
    },
    {
      id: 'explained-complexity',
      description: 'Explained that full e-commerce is complex',
      points: 50,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (text.includes('e-commerce') || text.includes('ecommerce') || 
                text.includes('cart') || text.includes('checkout'))
      },
    },
  ],
  maxScore: 100,
}

// ============================================
// HARD: Technical Jargon
// ============================================

export const EVAL_JARGON_JIRA_LIKE: AgentEval = {
  id: 'jargon-jira-like',
  name: 'Jargon: JIRA-like App',
  category: 'template-selection',
  level: 4,
  input: 'Build something like JIRA for our team',
  expectedTemplate: 'kanban',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'kanban' }, required: true },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('kanban', 60),
    {
      id: 'understood-jira',
      description: 'Understood JIRA means issue tracking / kanban',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('kanban') || text.includes('board') || 
               text.includes('issue') || text.includes('project')
      },
    },
  ],
  maxScore: 100,
}

export const EVAL_JARGON_TICKETING: AgentEval = {
  id: 'jargon-ticketing',
  name: 'Jargon: Ticketing System',
  category: 'template-selection',
  level: 4,
  input: 'Build a ticketing system for support requests',
  expectedTemplate: 'kanban', // Tickets in columns
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'kanban' }, required: true },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('kanban', 60),
    {
      id: 'understood-tickets',
      description: 'Understood ticketing maps to kanban workflow',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('kanban') || text.includes('board') || 
               text.includes('ticket') || text.includes('column')
      },
    },
  ],
  maxScore: 100,
}

// ============================================
// HARD: Noisy Context
// ============================================

export const EVAL_NOISY_DEADLINE: AgentEval = {
  id: 'noisy-deadline',
  name: 'Noisy: Ignore Deadline Context',
  category: 'template-selection',
  level: 3,
  input: 'My boss wants me to build a todo app by Friday morning, can you help?',
  expectedTemplate: 'todo-app',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'todo-app' }, required: true },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('todo-app', 60),
    createNoClarificationCriterion(40),
  ],
  antiPatterns: ['Asking about the deadline instead of building'],
  maxScore: 100,
}

export const EVAL_NOISY_LIKE_TRELLO: AgentEval = {
  id: 'noisy-like-trello',
  name: 'Noisy: Like Trello',
  category: 'template-selection',
  level: 3,
  input: 'Build something like Trello for managing our sprint',
  expectedTemplate: 'kanban',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'kanban' }, required: true },
  ],
  validationCriteria: [
    createTemplateSelectionCriterion('kanban', 60),
    {
      id: 'understood-trello',
      description: 'Understood Trello reference means kanban',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return text.includes('kanban') || text.includes('board') || text.includes('trello')
      },
    },
  ],
  maxScore: 100,
}

// Export new hard test collections
export const HARD_MISLEADING_EVALS: AgentEval[] = [
  EVAL_MISLEADING_TRACK_FITNESS,
  EVAL_MISLEADING_MESSAGE_BOARD,
]

export const HARD_NEGATIVE_EVALS: AgentEval[] = [
  EVAL_NEGATIVE_TASKS_NOT_KANBAN,
  EVAL_NEGATIVE_CUSTOMERS_NOT_BOOKING,
]

export const HARD_NO_MATCH_EVALS: AgentEval[] = [
  EVAL_NO_MATCH_GAME,
  EVAL_NO_MATCH_ECOMMERCE,
]

export const HARD_JARGON_EVALS: AgentEval[] = [
  EVAL_JARGON_JIRA_LIKE,
  EVAL_JARGON_TICKETING,
]

export const HARD_NOISY_EVALS: AgentEval[] = [
  EVAL_NOISY_DEADLINE,
  EVAL_NOISY_LIKE_TRELLO,
]

export const ALL_HARD_EVALS: AgentEval[] = [
  ...HARD_MISLEADING_EVALS,
  ...HARD_NEGATIVE_EVALS,
  ...HARD_NO_MATCH_EVALS,
  ...HARD_JARGON_EVALS,
  ...HARD_NOISY_EVALS,
]

export const ALL_EXTENDED_EVALS: AgentEval[] = [
  ...EXTENDED_TEMPLATE_EVALS,
  ...EXTENDED_SEMANTIC_EVALS,
  ...EXTENDED_TOOL_USAGE_EVALS,
  ...EXTENDED_EDGE_CASE_EVALS,
  ...EXTENDED_MULTI_TURN_EVALS,
  ...ALL_HARD_EVALS,
]
