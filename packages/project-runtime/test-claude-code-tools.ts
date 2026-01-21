/**
 * Test script to debug Claude Code tool integration
 */

import { streamText, tool } from 'ai'
import { createClaudeCode } from 'ai-sdk-provider-claude-code'
import { z } from 'zod'
import { resolve, dirname } from 'path'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const MONOREPO_ROOT = resolve(__dirname, '../..')

console.log('=== Claude Code Tools Test ===')
console.log('MONOREPO_ROOT:', MONOREPO_ROOT)

// Template loading function
function loadTemplates() {
  const templatesDir = resolve(MONOREPO_ROOT, 'packages/sdk/examples')
  const templates: any[] = []

  if (!existsSync(templatesDir)) {
    console.warn('Templates directory not found:', templatesDir)
    return templates
  }

  const entries = readdirSync(templatesDir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const templateJsonPath = resolve(templatesDir, entry.name, 'template.json')
    if (!existsSync(templateJsonPath)) continue

    try {
      const content = readFileSync(templateJsonPath, 'utf-8')
      const metadata = JSON.parse(content)
      templates.push({
        ...metadata,
        path: resolve(templatesDir, entry.name),
      })
    } catch {
      // Skip invalid template.json files
    }
  }

  return templates
}

// Define native tools
const templateTools = {
  'template_list': tool({
    description: 'List available starter templates',
    parameters: z.object({
      query: z.string().optional().describe('Optional search query'),
    }),
    execute: async ({ query }) => {
      console.log('[TOOL CALLED] template_list with query:', query)
      const templates = loadTemplates()
      const filtered = query 
        ? templates.filter(t => 
            t.name.toLowerCase().includes(query.toLowerCase()) ||
            t.description.toLowerCase().includes(query.toLowerCase())
          )
        : templates
      return JSON.stringify({ ok: true, templates: filtered }, null, 2)
    },
  }),
}

// Create Claude Code provider
const claudeCode = createClaudeCode({
  defaultSettings: {
    cwd: MONOREPO_ROOT,
    verbose: true,
    permissionMode: 'bypassPermissions',
  },
})

async function testWithNativeTools() {
  console.log('\n=== Test 1: Native AI SDK Tools ===')
  
  try {
    const result = await streamText({
      model: claudeCode('sonnet') as any,
      system: 'You are a helpful assistant. When asked about templates, use the template_list tool.',
      messages: [
        { role: 'user', content: 'List all available templates' }
      ],
      tools: templateTools,
      maxSteps: 5,
    })

    console.log('Streaming response...')
    for await (const chunk of result.textStream) {
      process.stdout.write(chunk)
    }
    console.log('\n\nDone!')
    
    // Check tool calls
    const toolCalls = await result.toolCalls
    console.log('Tool calls:', JSON.stringify(toolCalls, null, 2))
    
  } catch (error: any) {
    console.error('Error:', error.message)
    console.error('Stack:', error.stack)
  }
}

async function testWithMCPTools() {
  console.log('\n=== Test 2: MCP Tools via Claude Code ===')
  
  // Create provider with MCP server
  const claudeCodeWithMCP = createClaudeCode({
    defaultSettings: {
      cwd: MONOREPO_ROOT,
      verbose: true,
      permissionMode: 'bypassPermissions',
      mcpServers: {
        wavesmith: {
          command: 'bun',
          args: ['packages/mcp/src/server.ts'],
          cwd: MONOREPO_ROOT,
          env: {
            S3_ENDPOINT: process.env.S3_ENDPOINT || 'http://localhost:9000',
            S3_SCHEMA_BUCKET: process.env.S3_SCHEMA_BUCKET || 'shogo-schemas',
            S3_FORCE_PATH_STYLE: 'true',
            AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || 'minioadmin',
            AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || 'minioadmin',
            AWS_REGION: process.env.AWS_REGION || 'us-east-1',
            SCHEMA_STORAGE: 's3',
          },
        },
      },
      allowedTools: [
        'mcp__wavesmith__template.list',
        'mcp__wavesmith__template.copy',
      ],
    },
  })

  try {
    const result = await streamText({
      model: claudeCodeWithMCP('sonnet') as any,
      system: `You are Shogo. Use template.list to show available templates.`,
      messages: [
        { role: 'user', content: 'What templates are available?' }
      ],
      maxSteps: 5,
    })

    console.log('Streaming response...')
    for await (const chunk of result.textStream) {
      process.stdout.write(chunk)
    }
    console.log('\n\nDone!')
    
  } catch (error: any) {
    console.error('Error:', error.message)
    console.error('Stack:', error.stack)
  }
}

// Run tests
async function main() {
  // First check if templates exist
  const templates = loadTemplates()
  console.log('Found templates:', templates.map(t => t.name))
  
  // Test MCP tools (native tools don't work with Claude Code)
  await testWithMCPTools()
}

main().catch(console.error)
