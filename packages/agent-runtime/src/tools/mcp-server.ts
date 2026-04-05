// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent Builder MCP Server
 *
 * Provides tools for the builder AI (Claude Code) to configure
 * the agent workspace: identity files, skills, heartbeat, channels, memory.
 *
 * Runs as a subprocess spawned by the Claude Code SDK via .mcp.json.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, rmSync, statSync } from 'fs'
import { join, resolve, extname, dirname } from 'path'
import { randomUUID } from 'crypto'
import { isPreinstalledMcpId, isMcpServerAllowed, getPreinstalledPackages, getCatalogEntry } from '../mcp-catalog'
import { deriveApiUrl, derivePublicApiUrl } from '../internal-api'

/**
 * Resolve a path ensuring it stays within the given base directory.
 * Rejects inputs containing ".." or starting with "/" to prevent path traversal.
 */
function safePath(base: string, ...segments: string[]): string {
  for (const seg of segments) {
    if (seg.includes('..') || seg.startsWith('/') || seg.startsWith('\\')) {
      throw new Error(`Invalid path segment: "${seg}" — path traversal is not allowed`)
    }
  }
  const resolved = resolve(join(base, ...segments))
  const resolvedBase = resolve(base)
  if (!resolved.startsWith(resolvedBase + '/') && resolved !== resolvedBase) {
    throw new Error(`Path "${resolved}" escapes base directory "${resolvedBase}"`)
  }
  return resolved
}

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

const SHOGO_SKILLS_DIR = join(AGENT_DIR, '.shogo', 'skills')

function getSkillDir(name: string): string {
  const sanitized = name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  if (sanitized.includes('..') || sanitized.includes('/')) throw new Error('Invalid skill name')
  return join(SHOGO_SKILLS_DIR, sanitized)
}

defineTool({
  name: 'skill_list',
  description: 'List all installed agent skills from .shogo/skills/',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    if (!existsSync(SHOGO_SKILLS_DIR)) return { skills: [] }

    const skills: Array<{ name: string; description: string; trigger: string; hasScripts: boolean }> = []
    try {
      for (const entry of readdirSync(SHOGO_SKILLS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const skillMd = join(SHOGO_SKILLS_DIR, entry.name, 'SKILL.md')
        if (!existsSync(skillMd)) continue

        const content = readFileSync(skillMd, 'utf-8')
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

        const scriptsDir = join(SHOGO_SKILLS_DIR, entry.name, 'scripts')
        const hasScripts = existsSync(scriptsDir) && readdirSync(scriptsDir).length > 0

        skills.push({
          name: metadata.name || entry.name,
          description: metadata.description || '',
          trigger: metadata.trigger || '',
          hasScripts,
        })
      }
    } catch { /* */ }

    return { skills }
  },
})

const VALID_TOOL_GROUPS = ['shell', 'filesystem', 'web', 'web_fetch', 'web_search', 'browser', 'memory', 'messaging', 'heartbeat', 'audio']
const VALID_TOOL_NAMES = ['exec', 'read_file', 'write_file', 'web', 'web_fetch', 'web_search', 'memory_read', 'send_message', 'heartbeat_configure', 'heartbeat_status', 'transcribe_audio']
const TOOL_GROUP_TO_NAMES: Record<string, string[]> = {
  shell: ['exec'],
  filesystem: ['read_file', 'write_file'],
  web: ['web'],
  web_fetch: ['web'],
  web_search: ['web'],
  browser: ['browser', 'web'],
  memory: ['memory_read'],
  messaging: ['send_message'],
  heartbeat: ['heartbeat_configure', 'heartbeat_status'],
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
  description: 'Create a new agent skill as .shogo/skills/<name>/SKILL.md with YAML frontmatter',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name (used as directory name)' },
      trigger: { type: 'string', description: 'Pipe-separated trigger keywords' },
      description: { type: 'string', description: 'What the skill does' },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: `Tool names or groups. Groups: ${VALID_TOOL_GROUPS.join(', ')}. Individual: ${VALID_TOOL_NAMES.join(', ')}`,
      },
      content: { type: 'string', description: 'Skill instructions (Markdown body)' },
      scripts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            filename: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['filename', 'content'],
        },
        description: 'Optional scripts to create in the skill scripts/ directory',
      },
    },
    required: ['name', 'trigger', 'content'],
  },
  handler: async (input) => {
    let skillDir: string
    try {
      skillDir = getSkillDir(input.name as string)
    } catch {
      return { error: `Invalid skill name: "${input.name}"` }
    }

    if (existsSync(join(skillDir, 'SKILL.md'))) {
      return { error: `Skill "${input.name}" already exists. Use skill_edit to modify it.` }
    }

    mkdirSync(skillDir, { recursive: true })

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

    writeFileSync(join(skillDir, 'SKILL.md'), skillContent, 'utf-8')

    const scriptFiles: string[] = []
    if (Array.isArray(input.scripts)) {
      const scriptsDir = join(skillDir, 'scripts')
      mkdirSync(scriptsDir, { recursive: true })
      for (const s of input.scripts as Array<{ filename: string; content: string }>) {
        if (s.filename.includes('..') || s.filename.includes('/')) continue
        writeFileSync(join(scriptsDir, s.filename), s.content, 'utf-8')
        scriptFiles.push(s.filename)
      }
    }

    return { ok: true, dir: `.shogo/skills/${(input.name as string).replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`, tools: resolvedTools, scripts: scriptFiles }
  },
})

defineTool({
  name: 'skill_edit',
  description: 'Edit an existing agent skill SKILL.md file',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name' },
      content: { type: 'string', description: 'Complete new SKILL.md content (including frontmatter)' },
    },
    required: ['name', 'content'],
  },
  handler: async (input) => {
    const name = input.name as string
    let skillDir: string
    try {
      skillDir = getSkillDir(name)
    } catch {
      return { error: `Invalid skill name: "${name}"` }
    }

    const filepath = join(skillDir, 'SKILL.md')
    if (!existsSync(filepath)) {
      return { error: `Skill "${name}" not found` }
    }

    writeFileSync(filepath, input.content as string, 'utf-8')
    return { ok: true, skill: name }
  },
})

defineTool({
  name: 'skill_delete',
  description: 'Delete an agent skill and its entire directory',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name' },
    },
    required: ['name'],
  },
  handler: async (input) => {
    const name = input.name as string
    let skillDir: string
    try {
      skillDir = getSkillDir(name)
    } catch {
      return { error: `Invalid skill name: "${name}"` }
    }

    if (!existsSync(skillDir)) {
      return { error: `Skill "${name}" not found` }
    }

    rmSync(skillDir, { recursive: true, force: true })
    return { ok: true, deleted: name }
  },
})

defineTool({
  name: 'skill_write_script',
  description: 'Write a script file into a skill\'s scripts/ directory',
  inputSchema: {
    type: 'object',
    properties: {
      skill_name: { type: 'string', description: 'Name of the skill' },
      filename: { type: 'string', description: 'Script filename (e.g. "score.py", "transform.js")' },
      content: { type: 'string', description: 'Script file content' },
    },
    required: ['skill_name', 'filename', 'content'],
  },
  handler: async (input) => {
    const skillName = input.skill_name as string
    const filename = input.filename as string
    const content = input.content as string

    if (filename.includes('..') || filename.includes('/')) {
      return { error: 'Invalid filename' }
    }
    if (content.length > 102400) {
      return { error: 'Script exceeds 100KB limit' }
    }

    let skillDir: string
    try {
      skillDir = getSkillDir(skillName)
    } catch {
      return { error: `Invalid skill name: "${skillName}"` }
    }

    if (!existsSync(join(skillDir, 'SKILL.md'))) {
      return { error: `Skill "${skillName}" not found. Create it first with skill_create.` }
    }

    const scriptsDir = join(skillDir, 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(scriptsDir, filename), content, 'utf-8')

    return { ok: true, skill: skillName, script: filename, size: content.length }
  },
})

defineTool({
  name: 'skill_list_scripts',
  description: 'List scripts in a skill\'s scripts/ directory',
  inputSchema: {
    type: 'object',
    properties: {
      skill_name: { type: 'string', description: 'Name of the skill' },
    },
    required: ['skill_name'],
  },
  handler: async (input) => {
    const skillName = input.skill_name as string

    let skillDir: string
    try {
      skillDir = getSkillDir(skillName)
    } catch {
      return { error: `Invalid skill name: "${skillName}"` }
    }

    const scriptsDir = join(skillDir, 'scripts')
    if (!existsSync(scriptsDir)) {
      return { scripts: [] }
    }

    const scripts = readdirSync(scriptsDir)
      .filter(f => !f.startsWith('.'))
      .map(f => {
        const ext = extname(f).slice(1)
        const runtimeMap: Record<string, string> = { py: 'python3', js: 'node', ts: 'bun', mjs: 'node', sh: 'bash' }
        const size = statSync(join(scriptsDir, f)).size
        return { filename: f, runtime: runtimeMap[ext] || ext, size }
      })

    return { skill: skillName, scripts }
  },
})

// =============================================================================
// Channel Tools
// =============================================================================

defineTool({
  name: 'channel_connect',
  description: 'Connect a messaging channel (telegram, discord, email, whatsapp, slack, webhook, teams, or webchat)',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['telegram', 'discord', 'email', 'whatsapp', 'slack', 'webhook', 'teams', 'webchat'], description: 'Channel type' },
      config: {
        type: 'object',
        description: 'Channel configuration. Telegram: { botToken }. Discord: { botToken, guildId? }. Email: { imapHost, smtpHost, username, password }. WhatsApp: { accessToken, phoneNumberId, verifyToken? }. Slack: { botToken, appToken }. Webhook: { secret? }. Teams: { appId, appPassword, botName? }. WebChat: { title?, subtitle?, primaryColor?, position?, welcomeMessage?, avatarUrl?, allowedOrigins? }',
      },
      model: { type: 'string', enum: ['basic', 'advanced'], description: 'AI model tier: "basic" (economy, all plans) or "advanced" (Pro plan required). Defaults to "basic".', default: 'basic' },
    },
    required: ['type', 'config'],
  },
  handler: async (input) => {
    const configPath = join(AGENT_DIR, 'config.json')
    let config: Record<string, any> = {}
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8'))
    }

    if (input.type === 'webchat' && !input.config.widgetSecret) {
      input.config.widgetSecret = randomUUID()
    }

    config.channels = config.channels || []
    const channelModel = input.model || 'basic'

    if (channelModel === 'advanced') {
      const proxyUrl = process.env.AI_PROXY_URL
      const proxyToken = process.env.AI_PROXY_TOKEN
      if (proxyUrl && proxyToken) {
        try {
          const accessUrl = proxyUrl.replace(/\/chat\/completions$/, '').replace(/\/v1$/, '/v1') + '/access'
          const accessRes = await fetch(accessUrl, {
            headers: { 'Authorization': `Bearer ${proxyToken}` },
            signal: AbortSignal.timeout(5000),
          })
          if (accessRes.ok) {
            const access = await accessRes.json() as { hasAdvancedModelAccess?: boolean }
            if (!access.hasAdvancedModelAccess) {
              return {
                ok: false,
                error: 'Advanced model requires a Pro or higher subscription. Please use model: "basic" or upgrade your plan.',
              }
            }
          }
        } catch { /* If check fails, allow and let proxy enforce at runtime */ }
      }
    }
    const existing = config.channels.findIndex(
      (c: any) => c.type === input.type
    )
    const channelEntry = { type: input.type, config: input.config, model: channelModel }
    if (existing >= 0) {
      config.channels[existing] = channelEntry
    } else {
      config.channels.push(channelEntry)
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

    // Hot-connect: tell the running gateway to connect the channel immediately
    const port = process.env.PORT || '8080'
    try {
      const res = await fetch(`http://localhost:${port}/agent/channels/hot-connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: input.type, config: input.config }),
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        if (input.type === 'webchat') {
          const widgetKey = encodeURIComponent(input.config.widgetSecret || '')
          const widgetPath = `/agent/channels/webchat/widget.js?widgetKey=${widgetKey}`
          let widgetUrl: string
          if (process.env.KUBERNETES_SERVICE_HOST) {
            const apiUrl = derivePublicApiUrl()
            widgetUrl = `${apiUrl}/api/projects/${PROJECT_ID}/agent-proxy${widgetPath}`
          } else {
            widgetUrl = `http://localhost:${port}${widgetPath}`
          }
          return {
            ok: true,
            message: [
              `WebChat channel connected and live!`,
              ``,
              `Tell the user to add this single script tag before the closing </body> tag on their website:`,
              ``,
              `<script src="${widgetUrl}"></script>`,
              ``,
              `A chat bubble will appear on the page. Visitors click it to chat with the agent directly. No other setup, libraries, or accounts needed.`,
              ``,
              `The user can also find the embed snippet in the Channels panel.`,
            ].join('\n'),
            embedSnippet: `<script src="${widgetUrl}"></script>`,
            widgetUrl,
          }
        }
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
  description: 'List configured messaging channels with their connection status and model tier',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const port = process.env.PORT || '8080'
    try {
      const res = await fetch(`http://localhost:${port}/agent/status`, {
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) {
        const status = await res.json()
        return { channels: status.channels || [] }
      }
    } catch { /* fall back to config.json */ }

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

const isLocal = process.env.SHOGO_LOCAL_MODE === 'true'

defineTool({
  name: 'mcp_server_configure',
  description: isLocal
    ? `Add an MCP server to the agent config. Any npx-compatible server is supported. Catalog servers: ${getPreinstalledPackages().map(e => e.id).join(', ')}. The server will be spawned when the agent starts.`
    : `Add a preinstalled MCP server to the agent config. Only preinstalled servers are allowed: ${getPreinstalledPackages().map(e => e.id).join(', ')}. The server will be spawned when the agent starts.`,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: isLocal ? 'Server name (any identifier)' : `Server name. Must be one of: ${getPreinstalledPackages().map(e => e.id).join(', ')}` },
      package: isLocal ? { type: 'string', description: 'npm package to run via npx (e.g. "@modelcontextprotocol/server-github@latest"). Required for non-catalog servers.' } : undefined,
      args: isLocal ? { type: 'array', items: { type: 'string' }, description: 'Extra CLI args for the server' } : undefined,
      env: { type: 'object', description: 'Optional environment variables for the server' },
    },
    required: ['name'],
  },
  handler: async (input) => {
    const name = input.name as string
    if (!isMcpServerAllowed(name)) {
      const allowed = getPreinstalledPackages().map(e => e.id).join(', ')
      return { error: `MCP server "${name}" is not available. Only preinstalled servers are supported: ${allowed}` }
    }

    const entry = getCatalogEntry(name)
    const configPath = join(AGENT_DIR, 'config.json')
    let config: Record<string, any> = {}
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8'))
    }

    const pkg = entry?.package || (input.package as string | undefined)
    if (!pkg) {
      return { error: `No package specified for "${name}". Provide a "package" field (e.g. "@modelcontextprotocol/server-github@latest").` }
    }
    const defaultArgs = entry?.defaultArgs || []
    const extraArgs = (input.args as string[] | undefined) || []

    config.mcpServers = config.mcpServers || {}
    config.mcpServers[name] = {
      command: 'npx',
      args: [pkg, ...defaultArgs, ...extraArgs],
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

    try {
      if (file === 'MEMORY.md') {
        filepath = safePath(AGENT_DIR, 'MEMORY.md')
      } else {
        filepath = safePath(join(AGENT_DIR, 'memory'), `${file}.md`)
      }
    } catch {
      return { error: `Invalid memory file name: "${file}"` }
    }

    if (!existsSync(filepath)) {
      return { content: '', exists: false }
    }

    return { content: readFileSync(filepath, 'utf-8'), exists: true }
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
