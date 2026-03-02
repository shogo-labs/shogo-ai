/**
 * Agent Builder MCP Server
 *
 * Provides tools for the builder AI (Claude Code) to configure
 * the agent workspace: identity files, skills, heartbeat, channels, memory.
 *
 * Runs as a subprocess spawned by the Claude Code SDK via .mcp.json.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync } from 'fs'
import { join, extname, dirname } from 'path'
import { isPreinstalledMcpId, getPreinstalledPackages, getCatalogEntry } from '../mcp-catalog'

const AGENT_DIR = process.env.AGENT_DIR || '/app/agent'
const PROJECT_ID = process.env.PROJECT_ID || 'unknown'

function ensureAgentDir(): void {
  try {
    mkdirSync(AGENT_DIR, { recursive: true })
  } catch (err: any) {
    console.error(`[MCP] FATAL: Cannot create AGENT_DIR "${AGENT_DIR}": ${err.message}`)
    process.exit(1)
  }

  try {
    const testFile = join(AGENT_DIR, '.mcp-probe')
    writeFileSync(testFile, 'ok', 'utf-8')
    unlinkSync(testFile)
  } catch (err: any) {
    console.error(`[MCP] FATAL: AGENT_DIR "${AGENT_DIR}" is not writable: ${err.message}`)
    process.exit(1)
  }
}

ensureAgentDir()

// =============================================================================
// Tool definitions (MCP protocol over stdio)
// =============================================================================

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, any>
  handler: (input: Record<string, any>) => Promise<any>
}

const tools: ToolDef[] = []

function defineTool(def: ToolDef) {
  tools.push(def)
}

// =============================================================================
// Identity Tools
// =============================================================================

const IDENTITY_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md', 'TOOLS.md']

defineTool({
  name: 'identity_get',
  description: 'Read an agent workspace file (AGENTS.md, SOUL.md, USER.md, IDENTITY.md, TOOLS.md)',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        enum: IDENTITY_FILES,
        description: 'Which workspace file to read',
      },
    },
    required: ['file'],
  },
  handler: async (input) => {
    const file = input.file as string
    if (!IDENTITY_FILES.includes(file)) {
      return { error: `Invalid file: ${file}. Must be one of: ${IDENTITY_FILES.join(', ')}` }
    }
    const filepath = join(AGENT_DIR, file)
    if (!existsSync(filepath)) {
      return { content: '', exists: false }
    }
    return { content: readFileSync(filepath, 'utf-8'), exists: true }
  },
})

defineTool({
  name: 'identity_set',
  description: 'Write an agent workspace file (AGENTS.md, SOUL.md, USER.md, IDENTITY.md, TOOLS.md)',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        enum: IDENTITY_FILES,
        description: 'Which workspace file to write',
      },
      content: {
        type: 'string',
        description: 'Full content of the file',
      },
    },
    required: ['file', 'content'],
  },
  handler: async (input) => {
    const file = input.file as string
    if (!IDENTITY_FILES.includes(file)) {
      return { error: `Invalid file: ${file}` }
    }
    const filepath = join(AGENT_DIR, file)
    writeFileSync(filepath, input.content as string, 'utf-8')
    return { ok: true, file, bytes: (input.content as string).length }
  },
})

// =============================================================================
// Skill Tools
// =============================================================================

defineTool({
  name: 'skill_list',
  description: 'List all installed agent skills',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const skillsDir = join(AGENT_DIR, 'skills')
    if (!existsSync(skillsDir)) return { skills: [] }

    const files = readdirSync(skillsDir).filter((f) => extname(f) === '.md')
    const skills = files.map((file) => {
      const content = readFileSync(join(skillsDir, file), 'utf-8')
      const match = content.match(/^---\n([\s\S]*?)\n---/)
      const metadata: Record<string, string> = {}
      if (match) {
        for (const line of match[1].split('\n')) {
          const idx = line.indexOf(':')
          if (idx !== -1) {
            metadata[line.substring(0, idx).trim()] = line.substring(idx + 1).trim()
          }
        }
      }
      return {
        file,
        name: metadata.name || file.replace('.md', ''),
        description: metadata.description || '',
        trigger: metadata.trigger || '',
      }
    })

    return { skills }
  },
})

const VALID_TOOL_GROUPS = ['shell', 'filesystem', 'web', 'web_fetch', 'web_search', 'browser', 'memory', 'messaging', 'cron']
const VALID_TOOL_NAMES = ['exec', 'read_file', 'write_file', 'web', 'web_fetch', 'web_search', 'memory_read', 'memory_write', 'send_message', 'cron']
const TOOL_GROUP_TO_NAMES: Record<string, string[]> = {
  shell: ['exec'],
  filesystem: ['read_file', 'write_file'],
  web: ['web'],
  web_fetch: ['web'],
  web_search: ['web'],
  browser: ['browser', 'web'],
  memory: ['memory_read', 'memory_write'],
  messaging: ['send_message'],
  cron: ['cron'],
}

function normalizeToolRefs(refs: string[]): string[] {
  const normalized = new Set<string>()
  for (const ref of refs) {
    if (TOOL_GROUP_TO_NAMES[ref]) {
      for (const name of TOOL_GROUP_TO_NAMES[ref]) normalized.add(name)
    } else if (VALID_TOOL_NAMES.includes(ref)) {
      normalized.add(ref)
    }
  }
  return [...normalized]
}

defineTool({
  name: 'skill_create',
  description: 'Create a new agent skill as a Markdown file with YAML frontmatter',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name (used as filename)' },
      trigger: { type: 'string', description: 'Pipe-separated trigger keywords' },
      description: { type: 'string', description: 'What the skill does' },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: `Tool names or groups. Groups: ${VALID_TOOL_GROUPS.join(', ')}. Individual: ${VALID_TOOL_NAMES.join(', ')}`,
      },
      content: { type: 'string', description: 'Skill instructions (Markdown body)' },
    },
    required: ['name', 'trigger', 'content'],
  },
  handler: async (input) => {
    const skillsDir = join(AGENT_DIR, 'skills')
    mkdirSync(skillsDir, { recursive: true })

    const filename = `${(input.name as string).replace(/[^a-z0-9-]/gi, '-').toLowerCase()}.md`
    const filepath = join(skillsDir, filename)

    if (existsSync(filepath)) {
      return { error: `Skill "${input.name}" already exists. Use skill_edit to modify it.` }
    }

    const rawTools = Array.isArray(input.tools) ? input.tools : []
    const resolvedTools = normalizeToolRefs(rawTools)
    const skillContent = `---
name: ${input.name}
version: 1.0.0
description: ${input.description || ''}
trigger: "${input.trigger}"
tools: [${resolvedTools.join(', ')}]
---

${input.content}
`

    writeFileSync(filepath, skillContent, 'utf-8')
    return { ok: true, file: filename, tools: resolvedTools }
  },
})

defineTool({
  name: 'skill_edit',
  description: 'Edit an existing agent skill file',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name or filename' },
      content: { type: 'string', description: 'Complete new file content (including frontmatter)' },
    },
    required: ['name', 'content'],
  },
  handler: async (input) => {
    const skillsDir = join(AGENT_DIR, 'skills')
    const name = input.name as string
    const filename = name.endsWith('.md') ? name : `${name}.md`
    const filepath = join(skillsDir, filename)

    if (!existsSync(filepath)) {
      return { error: `Skill "${name}" not found` }
    }

    writeFileSync(filepath, input.content as string, 'utf-8')
    return { ok: true, file: filename }
  },
})

defineTool({
  name: 'skill_delete',
  description: 'Delete an agent skill',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name or filename' },
    },
    required: ['name'],
  },
  handler: async (input) => {
    const skillsDir = join(AGENT_DIR, 'skills')
    const name = input.name as string
    const filename = name.endsWith('.md') ? name : `${name}.md`
    const filepath = join(skillsDir, filename)

    if (!existsSync(filepath)) {
      return { error: `Skill "${name}" not found` }
    }

    unlinkSync(filepath)
    return { ok: true, deleted: filename }
  },
})

// =============================================================================
// Heartbeat Tools
// =============================================================================

defineTool({
  name: 'heartbeat_configure',
  description: 'Configure the heartbeat system (interval, quiet hours, enable/disable)',
  inputSchema: {
    type: 'object',
    properties: {
      interval: { type: 'number', description: 'Heartbeat interval in seconds (default: 1800)' },
      enabled: { type: 'boolean', description: 'Enable or disable heartbeat' },
      quietHoursStart: { type: 'string', description: 'Quiet hours start (HH:MM)' },
      quietHoursEnd: { type: 'string', description: 'Quiet hours end (HH:MM)' },
      timezone: { type: 'string', description: 'Timezone for quiet hours' },
    },
  },
  handler: async (input) => {
    const configPath = join(AGENT_DIR, 'config.json')
    let config: Record<string, any> = {}
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8'))
    }

    if (input.interval !== undefined) config.heartbeatInterval = input.interval
    if (input.enabled !== undefined) config.heartbeatEnabled = input.enabled
    if (input.quietHoursStart || input.quietHoursEnd || input.timezone) {
      config.quietHours = config.quietHours || {}
      if (input.quietHoursStart) config.quietHours.start = input.quietHoursStart
      if (input.quietHoursEnd) config.quietHours.end = input.quietHoursEnd
      if (input.timezone) config.quietHours.timezone = input.timezone
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    return { ok: true, config }
  },
})

defineTool({
  name: 'heartbeat_status',
  description: 'Get current heartbeat configuration and status',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const configPath = join(AGENT_DIR, 'config.json')
    let config: Record<string, any> = {}
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8'))
    }

    const heartbeatPath = join(AGENT_DIR, 'HEARTBEAT.md')
    const heartbeatContent = existsSync(heartbeatPath)
      ? readFileSync(heartbeatPath, 'utf-8')
      : ''

    return {
      enabled: config.heartbeatEnabled ?? false,
      interval: config.heartbeatInterval ?? 1800,
      quietHours: config.quietHours ?? null,
      checklistLength: heartbeatContent.trim().length,
      checklistPreview: heartbeatContent.substring(0, 500),
    }
  },
})

defineTool({
  name: 'heartbeat_trigger',
  description: 'Manually trigger one heartbeat tick (for testing)',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    // This sends an HTTP request to the agent-runtime server's trigger endpoint
    const port = process.env.PORT || '8080'
    try {
      const response = await fetch(
        `http://localhost:${port}/agent/heartbeat/trigger`,
        { method: 'POST' }
      )
      return await response.json()
    } catch (error: any) {
      return { error: `Failed to trigger heartbeat: ${error.message}` }
    }
  },
})

// =============================================================================
// Channel Tools
// =============================================================================

defineTool({
  name: 'channel_connect',
  description: 'Connect a messaging channel (telegram, discord, email, whatsapp, or slack)',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['telegram', 'discord', 'email', 'whatsapp', 'slack', 'webhook', 'teams'], description: 'Channel type' },
      config: {
        type: 'object',
        description: 'Channel configuration. Telegram: { botToken }. Discord: { botToken, guildId? }. Email: { imapHost, smtpHost, username, password }. WhatsApp: { accessToken, phoneNumberId, verifyToken? }. Slack: { botToken, appToken }. Webhook: { secret? }. Teams: { appId, appPassword, botName? }',
      },
    },
    required: ['type', 'config'],
  },
  handler: async (input) => {
    const configPath = join(AGENT_DIR, 'config.json')
    let config: Record<string, any> = {}
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8'))
    }

    config.channels = config.channels || []
    const existing = config.channels.findIndex(
      (c: any) => c.type === input.type
    )
    if (existing >= 0) {
      config.channels[existing] = { type: input.type, config: input.config }
    } else {
      config.channels.push({ type: input.type, config: input.config })
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

    // Hot-connect: tell the running gateway to connect the channel immediately
    const port = process.env.PORT || '8080'
    try {
      const res = await fetch(`http://localhost:${port}/agent/channels/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: input.type, config: input.config }),
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        return {
          ok: true,
          message: `${input.type} channel connected and live.`,
        }
      }
      const err = await res.json().catch(() => ({}))
      return {
        ok: true,
        message: `${input.type} channel configured but hot-connect failed (${(err as any).error || res.status}). Restart the agent to connect.`,
      }
    } catch {
      return {
        ok: true,
        message: `${input.type} channel configured. Restart the agent to connect.`,
      }
    }
  },
})

defineTool({
  name: 'channel_disconnect',
  description: 'Remove a messaging channel configuration',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'Channel type to disconnect' },
    },
    required: ['type'],
  },
  handler: async (input) => {
    const configPath = join(AGENT_DIR, 'config.json')
    let config: Record<string, any> = {}
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8'))
    }

    config.channels = (config.channels || []).filter(
      (c: any) => c.type !== input.type
    )
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    return { ok: true, message: `${input.type} removed. Restart to apply.` }
  },
})

defineTool({
  name: 'channel_list',
  description: 'List configured messaging channels',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const configPath = join(AGENT_DIR, 'config.json')
    let config: Record<string, any> = {}
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8'))
    }
    return { channels: config.channels || [] }
  },
})

defineTool({
  name: 'channel_test',
  description: 'Send a test message through a connected channel',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'Channel type' },
      channelId: { type: 'string', description: 'Target channel/chat ID' },
      message: { type: 'string', description: 'Test message to send' },
    },
    required: ['type', 'channelId', 'message'],
  },
  handler: async (input) => {
    // Not directly possible from MCP subprocess — needs to go through server
    return {
      info: 'Channel testing requires the agent to be running. Use agent_start first, then test from the preview panel.',
    }
  },
})

// =============================================================================
// MCP Server Configuration Tools
// =============================================================================

defineTool({
  name: 'mcp_server_configure',
  description: `Add a preinstalled MCP server to the agent config. Only preinstalled servers are allowed: ${getPreinstalledPackages().map(e => e.id).join(', ')}. The server will be spawned when the agent starts.`,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: `Server name. Must be one of: ${getPreinstalledPackages().map(e => e.id).join(', ')}` },
      env: { type: 'object', description: 'Optional environment variables for the server' },
    },
    required: ['name'],
  },
  handler: async (input) => {
    const name = input.name as string
    if (!isPreinstalledMcpId(name)) {
      const allowed = getPreinstalledPackages().map(e => e.id).join(', ')
      return { error: `MCP server "${name}" is not available. Only preinstalled servers are supported: ${allowed}` }
    }

    const entry = getCatalogEntry(name)!
    const configPath = join(AGENT_DIR, 'config.json')
    let config: Record<string, any> = {}
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8'))
    }

    config.mcpServers = config.mcpServers || {}
    config.mcpServers[name] = {
      command: 'npx',
      args: [entry.package, ...entry.defaultArgs],
      ...(input.env ? { env: input.env } : {}),
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    return {
      ok: true,
      server: name,
      message: `MCP server "${name}" configured. Restart the agent to activate.`,
    }
  },
})

defineTool({
  name: 'mcp_server_remove',
  description: 'Remove an MCP server from the agent config',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Server name to remove' },
    },
    required: ['name'],
  },
  handler: async (input) => {
    const configPath = join(AGENT_DIR, 'config.json')
    if (!existsSync(configPath)) return { ok: false, error: 'No config.json found' }

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    if (!config.mcpServers?.[input.name as string]) {
      return { ok: false, error: `MCP server "${input.name}" not found in config` }
    }

    delete config.mcpServers[input.name as string]
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    return { ok: true, removed: input.name }
  },
})

defineTool({
  name: 'mcp_server_list',
  description: 'List configured MCP servers',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const configPath = join(AGENT_DIR, 'config.json')
    if (!existsSync(configPath)) return { servers: {} }

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    return { servers: config.mcpServers || {} }
  },
})

// =============================================================================
// Memory Tools
// =============================================================================

defineTool({
  name: 'memory_read',
  description: 'Read agent memory (MEMORY.md or daily logs)',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'File to read: "MEMORY.md" or a date like "2026-02-18"',
      },
    },
    required: ['file'],
  },
  handler: async (input) => {
    const file = input.file as string
    let filepath: string

    if (file === 'MEMORY.md') {
      filepath = join(AGENT_DIR, 'MEMORY.md')
    } else {
      filepath = join(AGENT_DIR, 'memory', `${file}.md`)
    }

    if (!existsSync(filepath)) {
      return { content: '', exists: false }
    }

    return { content: readFileSync(filepath, 'utf-8'), exists: true }
  },
})

defineTool({
  name: 'memory_write',
  description: 'Write to agent memory (MEMORY.md or daily logs)',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '"MEMORY.md" or a date' },
      content: { type: 'string', description: 'Content to write' },
      append: { type: 'boolean', description: 'Append instead of overwrite' },
    },
    required: ['file', 'content'],
  },
  handler: async (input) => {
    const file = input.file as string
    let filepath: string

    if (file === 'MEMORY.md') {
      filepath = join(AGENT_DIR, 'MEMORY.md')
    } else {
      const memoryDir = join(AGENT_DIR, 'memory')
      mkdirSync(memoryDir, { recursive: true })
      filepath = join(memoryDir, `${file}.md`)
    }

    if (input.append && existsSync(filepath)) {
      const existing = readFileSync(filepath, 'utf-8')
      writeFileSync(filepath, existing + '\n' + (input.content as string), 'utf-8')
    } else {
      writeFileSync(filepath, input.content as string, 'utf-8')
    }

    return { ok: true, file: filepath }
  },
})

defineTool({
  name: 'memory_search',
  description: 'Search across all agent memory files using hybrid keyword + semantic search. Returns the most relevant memory chunks ranked by relevance score.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural language search query' },
      limit: { type: 'number', description: 'Max results (default: 10)' },
    },
    required: ['query'],
  },
  handler: async (input) => {
    const { MemorySearchEngine } = await import('../memory-search')
    const engine = new MemorySearchEngine(AGENT_DIR)
    try {
      const results = engine.search(input.query as string, (input.limit as number) || 10)
      return {
        query: input.query,
        results: results.map((r) => ({
          file: r.file,
          lines: `${r.lineStart}-${r.lineEnd}`,
          score: Math.round(r.score * 100) / 100,
          matchType: r.matchType,
          content: r.chunk,
        })),
        totalMatches: results.length,
      }
    } finally {
      engine.close()
    }
  },
})

// =============================================================================
// Agent Control Tools
// =============================================================================

defineTool({
  name: 'agent_status',
  description: 'Get the current agent gateway status (running, heartbeat, channels, skills)',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const port = process.env.PORT || '8080'
    try {
      const response = await fetch(`http://localhost:${port}/agent/status`)
      return await response.json()
    } catch (error: any) {
      return { error: `Agent not reachable: ${error.message}` }
    }
  },
})

defineTool({
  name: 'agent_template_list',
  description: 'List available agent starter templates. Returns templates grouped by category with descriptions, settings, and skills.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    return {
      categories: TEMPLATE_CATEGORIES,
      templates: getTemplateSummaries(),
    }
  },
})

defineTool({
  name: 'agent_template_copy',
  description: 'Initialize the agent workspace from a starter template',
  inputSchema: {
    type: 'object',
    properties: {
      template: { type: 'string', description: 'Template ID' },
      name: { type: 'string', description: 'Agent name' },
    },
    required: ['template'],
  },
  handler: async (input) => {
    const templateId = input.template as string
    const agentName = (input.name as string) || 'My Agent'

    const templateData = getAgentTemplate(templateId)
    if (!templateData) {
      return { error: `Template "${templateId}" not found` }
    }

    mkdirSync(AGENT_DIR, { recursive: true })

    const written: string[] = []
    const errors: string[] = []

    for (const [filename, content] of Object.entries(templateData.files)) {
      try {
        const filepath = join(AGENT_DIR, filename)
        const parentDir = dirname(filepath)
        if (parentDir !== AGENT_DIR) {
          mkdirSync(parentDir, { recursive: true })
        }
        const resolvedContent = content.replace(/\{\{AGENT_NAME\}\}/g, agentName)
        writeFileSync(filepath, resolvedContent, 'utf-8')
        written.push(filename)
      } catch (err: any) {
        errors.push(`${filename}: ${err.message}`)
      }
    }

    if (errors.length > 0) {
      return { ok: written.length > 0, template: templateId, name: agentName, written, errors }
    }

    return { ok: true, template: templateId, name: agentName, filesWritten: written.length }
  },
})

// =============================================================================
// Agent Templates (loaded from external registry)
// =============================================================================

import { getAgentTemplateById, getTemplateSummaries, TEMPLATE_CATEGORIES, type AgentTemplate as ExternalTemplate } from '../agent-templates'

interface AgentTemplate {
  files: Record<string, string>
}

function getAgentTemplate(id: string): AgentTemplate | null {
  const external = getAgentTemplateById(id)
  if (!external) return null
  return { files: external.files }
}

// =============================================================================
// MCP Protocol (stdio JSON-RPC)
// =============================================================================

const TOOL_TIMEOUT_MS = 30_000

async function handleRequest(request: {
  jsonrpc: string
  id?: number | string
  method: string
  params?: any
}): Promise<any> {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'shogo-agent-tools', version: '0.1.0' },
      }

    case 'notifications/initialized':
    case 'initialized':
      return undefined

    case 'tools/list':
      return {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      }

    case 'tools/call': {
      const toolName = request.params?.name
      const toolInput = request.params?.arguments || {}
      const tool = tools.find((t) => t.name === toolName)

      if (!tool) {
        return {
          content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
          isError: true,
        }
      }

      try {
        const result = await Promise.race([
          tool.handler(toolInput),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Tool "${toolName}" timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS)
          ),
        ])

        const hasError = result && typeof result === 'object' && 'error' in result
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          ...(hasError ? { isError: true } : {}),
        }
      } catch (error: any) {
        console.error(`[MCP] Tool "${toolName}" error:`, error.message)
        return {
          content: [{ type: 'text', text: `Error in ${toolName}: ${error.message}` }],
          isError: true,
        }
      }
    }

    default:
      if (request.method?.startsWith('notifications/')) {
        return undefined
      }
      return { error: { code: -32601, message: `Unknown method: ${request.method}` } }
  }
}

function sendResponse(data: object): void {
  const json = JSON.stringify(data)
  const bytes = new TextEncoder().encode(json)
  process.stdout.write(`Content-Length: ${bytes.length}\r\n\r\n${json}`)
}

async function main() {
  console.error(`[MCP] Server starting — AGENT_DIR=${AGENT_DIR}, PROJECT_ID=${PROJECT_ID}, tools=${tools.length}`)

  // Verify stdout is writable
  try {
    process.stdout.write('')
    console.error('[MCP] stdout health check: OK')
  } catch (err: any) {
    console.error(`[MCP] FATAL: stdout not writable: ${err.message}`)
    process.exit(1)
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let requestCount = 0

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk)

    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) break

      const header = buffer.substring(0, headerEnd)
      const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i)
      if (!contentLengthMatch) {
        buffer = buffer.substring(headerEnd + 4)
        continue
      }

      const contentLength = parseInt(contentLengthMatch[1], 10)
      const bodyStart = headerEnd + 4
      if (buffer.length < bodyStart + contentLength) break

      const body = buffer.substring(bodyStart, bodyStart + contentLength)
      buffer = buffer.substring(bodyStart + contentLength)

      try {
        const request = JSON.parse(body)
        requestCount++

        if (request.method === 'tools/call') {
          console.error(`[MCP] Tool call #${requestCount}: ${request.params?.name}`)
        }

        const result = await handleRequest(request)

        // Notifications (no id) don't get responses
        if (request.id === undefined) continue
        // Handlers returning undefined are silent acks (e.g. notifications with id)
        if (result === undefined) continue

        if (result?.error && result.error.code) {
          sendResponse({ jsonrpc: '2.0', id: request.id, error: result.error })
        } else {
          sendResponse({ jsonrpc: '2.0', id: request.id, result })
        }

        if (request.method === 'tools/call') {
          const isError = result?.isError || result?.content?.[0]?.text?.includes('Error')
          console.error(`[MCP] Tool call #${requestCount} ${request.params?.name}: ${isError ? 'FAILED' : 'OK'}`)
        }
      } catch (error: any) {
        console.error(`[MCP] Request #${requestCount} parse error:`, error.message)

        try {
          const partial = JSON.parse(body)
          if (partial.id !== undefined) {
            sendResponse({
              jsonrpc: '2.0',
              id: partial.id,
              error: { code: -32700, message: `Parse error: ${error.message}` },
            })
          }
        } catch {}
      }
    }
  }

  console.error(`[MCP] Stdin stream ended after ${requestCount} requests`)
}

main().catch((error) => {
  console.error('[MCP] Fatal error:', error)
  process.exit(1)
})
