#!/usr/bin/env bun
/**
 * Test: Use (session as any).query.setMcpServers() workaround
 *
 * The V2 SDK does NOT forward mcpServers to the CLI subprocess.
 * The working runtime workaround accesses the internal query object
 * and calls setMcpServers() on it directly.
 */

import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, writeFileSync } from 'fs'
import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk'
import { buildClaudeCodeEnv } from '@shogo/shared-runtime'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const MONOREPO_ROOT = resolve(__dirname, '../../../..')
const MCP_SERVER_PATH = resolve(MONOREPO_ROOT, 'packages/agent-runtime/src/tools/mcp-templates.ts')

const PROJECT_DIR = '/tmp/test-mcp-visibility'
mkdirSync(PROJECT_DIR, { recursive: true })

const claudeCodeEnv = buildClaudeCodeEnv({ useProxy: false, env: {} }, { RUNTIME_PORT: '8080' })

const mcpServers = {
  shogo: {
    command: 'bun',
    args: ['run', MCP_SERVER_PATH],
    env: { PROJECT_DIR, RUNTIME_PORT: '8080', NODE_ENV: 'development' },
  },
}

// Write .mcp.json (belt and suspenders)
writeFileSync(resolve(PROJECT_DIR, '.mcp.json'), JSON.stringify({ mcpServers }, null, 2))

process.chdir(PROJECT_DIR)
console.log(`CWD: ${process.cwd()}`)

const session = unstable_v2_createSession({
  model: 'claude-haiku-4-5',
  settingSources: ['project', 'local'],
  env: claudeCodeEnv,
  includePartialMessages: true,
  mcpServers,
  allowedTools: [
    'Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS', 'Bash',
    'mcp__shogo__template_list',
    'mcp__shogo__template_copy',
  ],
  permissionMode: 'default',
} as any)

// THE WORKAROUND: Access internal query object to register MCP servers
const query = (session as any).query
if (query && typeof query.setMcpServers === 'function') {
  console.log('Found query.setMcpServers — configuring MCP servers...')
  const result = await query.setMcpServers(mcpServers)
  console.log('MCP servers configured:', JSON.stringify(result))
} else {
  console.error('query.setMcpServers NOT FOUND')
  console.log('Session keys:', Object.keys(session))
  console.log('Session query:', typeof query, query ? Object.keys(query) : 'null')
}

console.log('Sending message...\n')
await session.send('Call the mcp__shogo__template_list tool right now. Do not reply with text, just call the tool immediately.')

let text = ''
const toolCalls: string[] = []
for await (const ev of session.stream()) {
  if (ev.type === 'assistant') {
    for (const b of ev.message?.content ?? []) {
      if (b.type === 'text') { text += b.text; process.stdout.write(b.text) }
      if (b.type === 'tool_use') {
        toolCalls.push(b.name)
        console.log(`\n>> TOOL: ${b.name}(${JSON.stringify(b.input).substring(0, 300)})`)
      }
    }
  }
}

console.log(`\n\nTools: [${toolCalls.join(', ')}]`)
const hasMcp = toolCalls.some(t => t.includes('mcp') || t.includes('template'))
console.log(`Result: ${hasMcp ? 'PASS ✓' : 'FAIL ✗'}`)
