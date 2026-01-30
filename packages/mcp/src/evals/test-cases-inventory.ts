/**
 * Inventory Management Template Evals
 * 
 * Non-technical user requests that test the agent's ability to modify
 * an inventory management application with:
 * - Product, Category, Supplier, StockMovement
 */

import type { AgentEval, ValidationCriterion, EvalResult } from './types'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// ============================================
// Helper Functions
// ============================================

function getProjectDir(result: EvalResult): string | null {
  // First, check if projectDir was passed in the result (from parallel runner)
  if (result.projectDir && existsSync(join(result.projectDir, 'prisma/schema.prisma'))) {
    return result.projectDir
  }
  
  // Check tool calls for project directory
  for (const tc of result.toolCalls) {
    if (tc.name === 'template.copy') {
      if (tc.params?.targetDir) return tc.params.targetDir
      if (tc.params?.target_dir) return tc.params.target_dir
    }
  }
  
  // Check worker directories (parallel eval runner uses these)
  for (let i = 0; i < 10; i++) {
    const workerDir = `/tmp/shogo-eval-worker-${i}`
    if (existsSync(join(workerDir, 'prisma/schema.prisma'))) {
      return workerDir
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
// Inventory Evals - Easy (Field additions)
// ============================================

/**
 * "I want to add a barcode to each product"
 * → Add barcode field to Product
 */
export const EVAL_INV_BARCODE: AgentEval = {
  id: 'inv-barcode',
  name: 'Inventory: Add Barcode Field',
  category: 'multi-turn',
  level: 4,
  input: 'Build me an inventory tracker. I need to be able to store a barcode for each product.',
  expectedTemplate: 'inventory',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'inventory' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('inventory', 15),
    createSchemaContainsCriterion(
      /barcode/i,
      30,
      'Added barcode field to Product model'
    ),
    createRanPrismaGenerateCriterion(15),
  ],
  antiPatterns: [],
  maxScore: 60,
}

/**
 * "I want to track where each product is stored"
 * → Add location/shelf field to Product
 */
export const EVAL_INV_LOCATION: AgentEval = {
  id: 'inv-location',
  name: 'Inventory: Storage Location',
  category: 'multi-turn',
  level: 4,
  input: 'Create an inventory system for my warehouse. I need to track which shelf or location each product is stored in.',
  expectedTemplate: 'inventory',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'inventory' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('inventory', 15),
    createSchemaContainsCriterion(
      /location|shelf|warehouse|bin/i,
      30,
      'Added location/shelf field to Product model'
    ),
    createRanPrismaGenerateCriterion(15),
  ],
  antiPatterns: [],
  maxScore: 60,
}

/**
 * "Add an expiration date for perishable items"
 * → Add expirationDate field to Product
 */
export const EVAL_INV_EXPIRATION: AgentEval = {
  id: 'inv-expiration',
  name: 'Inventory: Expiration Date',
  category: 'multi-turn',
  level: 4,
  input: 'I need inventory software for my grocery store. Some items expire so I need to track expiration dates.',
  expectedTemplate: 'inventory',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'inventory' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('inventory', 15),
    createSchemaContainsCriterion(
      /expir|bestBefore|best_before|sellBy|sell_by/i,
      30,
      'Added expiration date field to Product model'
    ),
    createRanPrismaGenerateCriterion(15),
  ],
  antiPatterns: [],
  maxScore: 60,
}

// ============================================
// Inventory Evals - Medium (UI Changes)
// ============================================

/**
 * "Warn me when products are running low"
 * → Show low stock indicator (quantity < minQuantity already exists!)
 */
export const EVAL_INV_LOW_STOCK_WARNING: AgentEval = {
  id: 'inv-low-stock-warning',
  name: 'Inventory: Low Stock Warning',
  category: 'multi-turn',
  level: 5,
  input: 'Build inventory tracking software. I want to see a warning when any product is running low on stock.',
  expectedTemplate: 'inventory',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'inventory' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('inventory', 15),
    {
      id: 'low-stock-ui',
      description: 'UI shows low stock warning (compares quantity to minQuantity)',
      points: 35,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const routesPath = join(projectDir, 'src/routes/index.tsx')
        if (!existsSync(routesPath)) return false
        
        const content = readFileSync(routesPath, 'utf-8')
        // Should compare quantity to minQuantity and show warning
        return (/quantity.*minQuantity|minQuantity.*quantity/i.test(content) ||
                /low.?stock|warning|alert/i.test(content))
      },
    },
  ],
  antiPatterns: [],
  maxScore: 50,
}

/**
 * "Show me which products are most profitable"
 * → Display price - cost as profit margin
 */
export const EVAL_INV_PROFIT_MARGIN: AgentEval = {
  id: 'inv-profit-margin',
  name: 'Inventory: Show Profit Margins',
  category: 'multi-turn',
  level: 5,
  input: 'Create an inventory app for my shop. I want to see the profit margin for each product (the difference between what I pay and what I sell for).',
  expectedTemplate: 'inventory',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'inventory' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('inventory', 15),
    {
      id: 'profit-margin-ui',
      description: 'UI calculates and displays profit margin (price - cost)',
      points: 35,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const routesPath = join(projectDir, 'src/routes/index.tsx')
        if (!existsSync(routesPath)) return false
        
        const content = readFileSync(routesPath, 'utf-8')
        // Should calculate profit = price - cost
        return (/price.*cost|cost.*price|margin|profit/i.test(content))
      },
    },
  ],
  antiPatterns: [],
  maxScore: 50,
}

/**
 * "Color code products by stock level"
 * → Red for low, yellow for medium, green for plenty
 */
export const EVAL_INV_STOCK_COLORS: AgentEval = {
  id: 'inv-stock-colors',
  name: 'Inventory: Color Coded Stock Levels',
  category: 'multi-turn',
  level: 5,
  input: 'Build inventory software. Color code the products: red if almost out of stock, yellow if getting low, green if plenty in stock.',
  expectedTemplate: 'inventory',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'inventory' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('inventory', 15),
    {
      id: 'stock-colors',
      description: 'Products have conditional colors based on stock level',
      points: 35,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const routesPath = join(projectDir, 'src/routes/index.tsx')
        if (!existsSync(routesPath)) return false
        
        const content = readFileSync(routesPath, 'utf-8')
        // Should have conditional coloring
        return (/red.*green|green.*red|bg-red|bg-green|text-red|text-green/i.test(content) &&
                /quantity/i.test(content))
      },
    },
  ],
  antiPatterns: [],
  maxScore: 50,
}

// ============================================
// Inventory Evals - Hard (Complex features)
// ============================================

/**
 * "Track different sizes of the same product"
 * → This might require a ProductVariant model or size field
 */
export const EVAL_INV_PRODUCT_SIZES: AgentEval = {
  id: 'inv-product-sizes',
  name: 'Inventory: Product Sizes/Variants',
  category: 'multi-turn',
  level: 6,
  input: 'I sell t-shirts in my store. I need inventory tracking that lets me track different sizes (S, M, L, XL) of the same shirt separately.',
  expectedTemplate: 'inventory',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'inventory' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('inventory', 15),
    createSchemaContainsCriterion(
      /size|variant|ProductVariant|product_variant/i,
      30,
      'Added size/variant field or model'
    ),
    createRanPrismaGenerateCriterion(15),
  ],
  antiPatterns: [],
  maxScore: 60,
}

/**
 * "Show me a history of all stock changes"
 * → The StockMovement model already exists, ensure it's displayed
 */
export const EVAL_INV_STOCK_HISTORY: AgentEval = {
  id: 'inv-stock-history',
  name: 'Inventory: Stock Movement History',
  category: 'multi-turn',
  level: 5,
  input: 'Create inventory software. I want to see a history of all stock changes - when items came in, when they went out, and why.',
  expectedTemplate: 'inventory',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'inventory' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('inventory', 15),
    {
      id: 'movement-history-ui',
      description: 'UI displays stock movement history',
      points: 35,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const routesPath = join(projectDir, 'src/routes/index.tsx')
        if (!existsSync(routesPath)) return false
        
        const content = readFileSync(routesPath, 'utf-8')
        return /movement|history|stockMovement|stock_movement/i.test(content)
      },
    },
  ],
  antiPatterns: [],
  maxScore: 50,
}

/**
 * "Calculate total inventory value"
 * → Sum of (price * quantity) for all products
 */
export const EVAL_INV_TOTAL_VALUE: AgentEval = {
  id: 'inv-total-value',
  name: 'Inventory: Total Inventory Value',
  category: 'multi-turn',
  level: 5,
  input: 'Build me an inventory tracker. I want to see the total value of all my inventory (what everything is worth if I sold it all).',
  expectedTemplate: 'inventory',
  expectedToolCalls: [
    { name: 'template.copy', params: { template: 'inventory' }, required: true },
  ],
  validationCriteria: [
    createUsedTemplateCriterion('inventory', 15),
    {
      id: 'total-value-ui',
      description: 'UI shows total inventory value calculation',
      points: 35,
      validate: (result) => {
        const projectDir = getProjectDir(result)
        if (!projectDir) return false
        
        const routesPath = join(projectDir, 'src/routes/index.tsx')
        if (!existsSync(routesPath)) return false
        
        const content = readFileSync(routesPath, 'utf-8')
        // Should sum price * quantity
        return (/total.*value|value.*total|price.*quantity|reduce|sum/i.test(content))
      },
    },
  ],
  antiPatterns: [],
  maxScore: 50,
}

// ============================================
// Inventory Evals - Edge Cases
// ============================================

/**
 * "Connect to my barcode scanner"
 * → Hardware integration not supported
 */
export const EVAL_INV_SCANNER: AgentEval = {
  id: 'inv-scanner',
  name: 'Inventory: Barcode Scanner (Unsupported)',
  category: 'edge-cases',
  level: 4,
  input: 'I need inventory software that connects to my handheld barcode scanner.',
  expectedTemplate: 'inventory',
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'explains-limitation',
      description: 'Explains hardware integration limitations',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (text.includes('cannot') || text.includes("can't") || 
                text.includes('not supported') || text.includes('limitation') ||
                text.includes('hardware') || text.includes('manual'))
      },
    },
    createUsedTemplateCriterion('inventory', 20),
  ],
  antiPatterns: [],
  maxScore: 60,
}

/**
 * "Automatically reorder when stock is low"
 * → Automatic ordering not supported
 */
export const EVAL_INV_AUTO_REORDER: AgentEval = {
  id: 'inv-auto-reorder',
  name: 'Inventory: Auto Reorder (Unsupported)',
  category: 'edge-cases',
  level: 4,
  input: 'Build inventory software that automatically places orders with my suppliers when stock runs low.',
  expectedTemplate: 'inventory',
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'explains-limitation',
      description: 'Explains automatic ordering limitations',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (text.includes('cannot') || text.includes("can't") || 
                text.includes('not supported') || text.includes('limitation') ||
                text.includes('manual') || text.includes('integration') ||
                text.includes('notification') || text.includes('alert'))
      },
    },
    createUsedTemplateCriterion('inventory', 20),
  ],
  antiPatterns: [],
  maxScore: 60,
}

/**
 * "Import my products from a spreadsheet"
 * → CSV import not directly supported
 */
export const EVAL_INV_IMPORT: AgentEval = {
  id: 'inv-import',
  name: 'Inventory: Import from Spreadsheet',
  category: 'edge-cases',
  level: 4,
  input: 'I have 500 products in an Excel spreadsheet. Can you import them into the inventory system?',
  expectedTemplate: 'inventory',
  expectedToolCalls: [],
  validationCriteria: [
    {
      id: 'explains-import',
      description: 'Explains import limitations or manual entry needed',
      points: 40,
      validate: (result) => {
        const text = result.responseText.toLowerCase()
        return (text.includes('cannot') || text.includes("can't") || 
                text.includes('not supported') || text.includes('limitation') ||
                text.includes('manual') || text.includes('csv') ||
                text.includes('one by one') || text.includes('add them'))
      },
    },
    createUsedTemplateCriterion('inventory', 20),
  ],
  antiPatterns: [],
  maxScore: 60,
}

// ============================================
// Export all Inventory evals
// ============================================

export const ALL_INVENTORY_EVALS: AgentEval[] = [
  // Easy - field additions
  EVAL_INV_BARCODE,
  EVAL_INV_LOCATION,
  EVAL_INV_EXPIRATION,
  // Medium - UI changes
  EVAL_INV_LOW_STOCK_WARNING,
  EVAL_INV_PROFIT_MARGIN,
  EVAL_INV_STOCK_COLORS,
  // Hard - complex features
  EVAL_INV_PRODUCT_SIZES,
  EVAL_INV_STOCK_HISTORY,
  EVAL_INV_TOTAL_VALUE,
  // Edge cases
  EVAL_INV_SCANNER,
  EVAL_INV_AUTO_REORDER,
  EVAL_INV_IMPORT,
]

export const INVENTORY_SCHEMA_EVALS = ALL_INVENTORY_EVALS.filter(e =>
  e.validationCriteria.some(c => c.description.toLowerCase().includes('field') || c.description.toLowerCase().includes('model'))
)

export const INVENTORY_UI_EVALS = ALL_INVENTORY_EVALS.filter(e =>
  e.validationCriteria.some(c => c.description.toLowerCase().includes('ui'))
)

export const INVENTORY_EDGE_EVALS = ALL_INVENTORY_EVALS.filter(e => e.category === 'edge-cases')
