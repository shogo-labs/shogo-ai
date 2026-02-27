/**
 * MCP Client Manager
 *
 * Spawns and manages external MCP servers for the agent runtime.
 * Discovers their tools and bridges them to Pi Agent Core's AgentTool format
 * so the gateway can use any MCP server as additional agent tools.
 *
 * Lifecycle: startAll() on gateway start, stopAll() on gateway stop.
 * Hot-add/remove: hotAddServer()/hotRemoveServer() for live session changes.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Type } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'

const MAX_MCP_SERVERS = 10
const MCP_CONNECT_TIMEOUT_MS = 90_000
const MCP_TOOL_LIST_TIMEOUT_MS = 15_000

/**
 * Directory where popular MCP packages are pre-installed in the Docker image.
 * When a package exists here, we run it directly with `node` instead of
 * going through `npx` (which takes 30-45s even with a warm npm cache).
 */
export const MCP_PREINSTALL_DIR = process.env.MCP_PREINSTALL_DIR || '/app/mcp-packages'

export interface MCPServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface RemoteMCPServerConfig {
  url: string
  headers?: Record<string, string>
  /** Tool names to exclude from registration (e.g. unwanted Composio meta tools) */
  excludeTools?: string[]
  /** Max characters for a single tool result before truncation (default: unlimited) */
  maxResultChars?: number
}

interface ManagedServer {
  name: string
  config: MCPServerConfig
  client: Client
  transport: StdioClientTransport
  tools: AgentTool[]
}

interface ManagedRemoteServer {
  name: string
  config: RemoteMCPServerConfig
  client: Client
  transport: StreamableHTTPClientTransport
  tools: AgentTool[]
}

function jsonSchemaPropertyToTypebox(p: Record<string, any>): any {
  switch (p.type) {
    case 'string':
      return Type.String({ description: p.description })
    case 'number':
    case 'integer':
      return Type.Number({ description: p.description })
    case 'boolean':
      return Type.Boolean({ description: p.description })
    case 'array': {
      const itemSchema = p.items
        ? jsonSchemaPropertyToTypebox(p.items as Record<string, any>)
        : Type.Any()
      return Type.Array(itemSchema, { description: p.description })
    }
    case 'object': {
      if (p.properties) {
        return jsonSchemaToTypebox(p)
      }
      return Type.Any({ description: p.description })
    }
    default:
      return Type.Any({ description: p.description })
  }
}

function jsonSchemaToTypebox(schema: Record<string, any>): any {
  if (!schema || schema.type !== 'object') {
    return Type.Object({})
  }

  const properties: Record<string, any> = {}
  const required = new Set(schema.required || [])

  for (const [key, prop] of Object.entries(schema.properties || {} as Record<string, any>)) {
    const p = prop as Record<string, any>
    const typeboxProp = jsonSchemaPropertyToTypebox(p)
    properties[key] = required.has(key) ? typeboxProp : Type.Optional(typeboxProp)
  }

  return Type.Object(properties)
}

/**
 * Build a compact schema hint string from a JSON Schema for inclusion in tool
 * descriptions. Helps the LLM understand nested object structures. Only
 * produced when the schema has nested objects or complex arrays.
 */
function buildSchemaHint(schema: Record<string, any>): string | null {
  if (!schema?.properties) return null

  const hasComplex = Object.values(schema.properties).some(
    (p: any) => p.type === 'object' || (p.type === 'array' && p.items?.type === 'object'),
  )
  if (!hasComplex) return null

  const requiredSet = new Set(schema.required || [])

  function describeProperty(p: Record<string, any>, indent: string): string {
    if (p.type === 'object' && p.properties) {
      const inner = Object.entries(p.properties)
        .map(([k, v]: [string, any]) => `${indent}  ${k}: ${describeProperty(v, indent + '  ')}`)
        .join('\n')
      return `{\n${inner}\n${indent}}`
    }
    if (p.type === 'array' && p.items) {
      const itemDesc = describeProperty(p.items as Record<string, any>, indent)
      return `Array<${itemDesc}>`
    }
    let desc = p.type || 'any'
    if (p.description) desc += ` — ${p.description.split('\n')[0].substring(0, 120)}`
    return desc
  }

  const lines = Object.entries(schema.properties).map(([key, prop]: [string, any]) => {
    const opt = requiredSet.has(key) ? '' : '?'
    return `  ${key}${opt}: ${describeProperty(prop, '  ')}`
  })

  return `{\n${lines.join('\n')}\n}`
}

function textResult(data: any): AgentToolResult<any> {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
    details: data,
  }
}

export interface MCPServerInfo {
  name: string
  toolCount: number
  toolNames: string[]
  config: MCPServerConfig
}

export class MCPClientManager {
  private servers: Map<string, ManagedServer> = new Map()
  private remoteServers: Map<string, ManagedRemoteServer> = new Map()
  private workspaceDir: string | null = null
  private onConfigPersisted: (() => void) | null = null

  setWorkspaceDir(dir: string): void {
    this.workspaceDir = dir
  }

  setOnConfigPersisted(callback: () => void): void {
    this.onConfigPersisted = callback
  }

  /**
   * For npx commands, check if the target package is pre-installed in the Docker
   * image and resolve to a direct `node` invocation instead. This drops startup
   * from ~43s (cold npx) to ~1.6s (direct node).
   */
  private resolvePreinstalled(config: MCPServerConfig): MCPServerConfig {
    if (config.command !== 'npx') return config

    const args = config.args || []
    const pkgArg = args.find(a => !a.startsWith('-'))
    if (!pkgArg) return config

    const pkgName = pkgArg.replace(/@(latest|[\d^~>=<].*)$/, '')

    const pkgJsonPath = join(MCP_PREINSTALL_DIR, 'node_modules', pkgName, 'package.json')
    try {
      if (!existsSync(pkgJsonPath)) return config

      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
      let entrypoint: string | undefined
      if (typeof pkg.bin === 'string') {
        entrypoint = pkg.bin
      } else if (pkg.bin && typeof pkg.bin === 'object') {
        entrypoint = Object.values(pkg.bin)[0] as string
      }
      if (!entrypoint) return config

      const fullEntrypoint = join(MCP_PREINSTALL_DIR, 'node_modules', pkgName, entrypoint)
      if (!existsSync(fullEntrypoint)) return config

      const extraArgs = args.filter(a => a !== '-y' && a !== '--yes' && a !== pkgArg)

      console.log(`[MCPClient] Pre-installed hit: ${pkgName} → node ${fullEntrypoint}`)
      return { ...config, command: 'node', args: [fullEntrypoint, ...extraArgs] }
    } catch {
      return config
    }
  }

  async startServer(name: string, config: MCPServerConfig): Promise<AgentTool[]> {
    if (this.servers.has(name)) {
      console.warn(`[MCPClient] Server "${name}" already running, skipping`)
      return this.servers.get(name)!.tools
    }

    config = this.resolvePreinstalled(config)

    const fullCommand = `${config.command} ${(config.args || []).join(' ')}`
    console.log(`[MCPClient] Starting MCP server "${name}": ${fullCommand}`)

    const writableHome = this.workspaceDir || '/tmp'

    let transport: StdioClientTransport
    try {
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...process.env, HOME: writableHome, npm_config_cache: join(writableHome, '.npm'), ...config.env } as Record<string, string>,
        cwd: config.cwd || writableHome,
        stderr: 'pipe',
      })
    } catch (err: any) {
      console.error(`[MCPClient] Failed to create transport for "${name}": ${err.message}`)
      throw new Error(`Transport creation failed for "${name}": ${err.message}`)
    }

    // Log stderr early so we capture npx download output and errors
    const stderr = transport.stderr
    if (stderr && 'on' in stderr) {
      (stderr as any).on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) console.error(`[MCPClient:${name}:stderr] ${text}`)
      })
    }

    const client = new Client(
      { name: `shogo-agent-${name}`, version: '1.0.0' },
      { capabilities: {} },
    )

    try {
      await withTimeout(
        client.connect(transport),
        MCP_CONNECT_TIMEOUT_MS,
        `MCP server "${name}" connection timed out after ${MCP_CONNECT_TIMEOUT_MS / 1000}s. The server process may still be installing dependencies. Command: ${fullCommand}`,
      )
      console.log(`[MCPClient] Connected to "${name}"`)
    } catch (err: any) {
      console.error(`[MCPClient] Failed to connect to "${name}": ${err.message}`)
      try { await transport.close() } catch { /* best effort cleanup */ }
      throw err
    }

    let mcpTools: any[] = []
    try {
      const result = await withTimeout(
        client.listTools(),
        MCP_TOOL_LIST_TIMEOUT_MS,
        `MCP server "${name}" tool listing timed out after ${MCP_TOOL_LIST_TIMEOUT_MS / 1000}s`,
      )
      mcpTools = result.tools || []
      console.log(`[MCPClient] "${name}" provides ${mcpTools.length} tools: ${mcpTools.map((t: any) => t.name).join(', ')}`)
    } catch (err: any) {
      console.error(`[MCPClient] Failed to list tools from "${name}": ${err.message}`)
      mcpTools = []
    }

    const agentTools: AgentTool[] = mcpTools.map((mcpTool: any) => {
      const toolName = `mcp_${name}_${mcpTool.name}`
      const parameters = jsonSchemaToTypebox(mcpTool.inputSchema || {})

      return {
        name: toolName,
        description: mcpTool.description || `MCP tool: ${mcpTool.name} (from ${name})`,
        label: `${name}: ${mcpTool.name}`,
        parameters,
        execute: async (_toolCallId: string, params: unknown) => {
          const args = (params && typeof params === 'object') ? params as Record<string, any> : {}
          try {
            const result = await client.callTool({
              name: mcpTool.name,
              arguments: args,
            })

            const texts = (result.content as any[])
              ?.filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('\n') || ''

            if (result.isError) {
              return textResult({ error: texts || 'MCP tool returned an error' })
            }

            return textResult(texts || JSON.stringify(result.content))
          } catch (err: any) {
            return textResult({ error: `MCP tool "${mcpTool.name}" failed: ${err.message}` })
          }
        },
      } as AgentTool
    })

    this.servers.set(name, { name, config, client, transport, tools: agentTools })
    return agentTools
  }

  async startAll(configs: Record<string, MCPServerConfig>): Promise<AgentTool[]> {
    const allTools: AgentTool[] = []
    const entries = Object.entries(configs)

    if (entries.length === 0) return allTools

    console.log(`[MCPClient] Starting ${entries.length} MCP server(s)...`)

    const results = await Promise.allSettled(
      entries.map(async ([name, config]) => {
        const tools = await this.startServer(name, config)
        return { name, tools }
      })
    )

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allTools.push(...result.value.tools)
      } else {
        console.error(`[MCPClient] Server startup failed:`, result.reason?.message || result.reason)
      }
    }

    console.log(`[MCPClient] ${allTools.length} MCP tools available from ${this.servers.size} server(s)`)
    return allTools
  }

  async startRemoteServer(name: string, config: RemoteMCPServerConfig): Promise<AgentTool[]> {
    if (this.remoteServers.has(name)) {
      console.warn(`[MCPClient] Remote server "${name}" already running, skipping`)
      return this.remoteServers.get(name)!.tools
    }

    console.log(`[MCPClient] Starting remote MCP server "${name}": ${config.url}`)

    const transport = new StreamableHTTPClientTransport(
      new URL(config.url),
      {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      },
    )

    const client = new Client(
      { name: `shogo-agent-${name}`, version: '1.0.0' },
      { capabilities: {} },
    )

    try {
      await withTimeout(
        client.connect(transport),
        MCP_CONNECT_TIMEOUT_MS,
        `Remote MCP server "${name}" connection timed out after ${MCP_CONNECT_TIMEOUT_MS / 1000}s`,
      )
      console.log(`[MCPClient] Connected to remote "${name}"`)
    } catch (err: any) {
      console.error(`[MCPClient] Failed to connect to remote "${name}": ${err.message}`)
      try { await transport.close() } catch { /* best effort cleanup */ }
      throw err
    }

    let mcpTools: any[] = []
    try {
      const result = await withTimeout(
        client.listTools(),
        MCP_TOOL_LIST_TIMEOUT_MS,
        `Remote MCP server "${name}" tool listing timed out after ${MCP_TOOL_LIST_TIMEOUT_MS / 1000}s`,
      )
      mcpTools = result.tools || []
      if (config.excludeTools?.length) {
        const excluded = new Set(config.excludeTools)
        const before = mcpTools.length
        mcpTools = mcpTools.filter((t: any) => !excluded.has(t.name))
        if (mcpTools.length < before) {
          console.log(`[MCPClient] Remote "${name}": filtered ${before - mcpTools.length} excluded tool(s)`)
        }
      }
      console.log(`[MCPClient] Remote "${name}" provides ${mcpTools.length} tools: ${mcpTools.map((t: any) => t.name).join(', ')}`)
    } catch (err: any) {
      console.error(`[MCPClient] Failed to list tools from remote "${name}": ${err.message}`)
      mcpTools = []
    }

    const agentTools: AgentTool[] = mcpTools.map((mcpTool: any) => {
      const toolName = `mcp_${name}_${mcpTool.name}`
      const inputSchema = mcpTool.inputSchema || {}
      const parameters = jsonSchemaToTypebox(inputSchema)

      let description = mcpTool.description || `MCP tool: ${mcpTool.name} (from ${name})`
      const schemaHint = buildSchemaHint(inputSchema)
      if (schemaHint) {
        description += `\n\nInput schema:\n${schemaHint}`
      }

      return {
        name: toolName,
        description,
        label: `${name}: ${mcpTool.name}`,
        parameters,
        execute: async (_toolCallId: string, params: unknown) => {
          const args = (params && typeof params === 'object') ? params as Record<string, any> : {}
          try {
            const result = await client.callTool({
              name: mcpTool.name,
              arguments: args,
            })

            const texts = (result.content as any[])
              ?.filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('\n') || ''

            if (result.isError) {
              return textResult({ error: texts || 'MCP tool returned an error' })
            }

            let raw = texts || JSON.stringify(result.content)
            const maxChars = config.maxResultChars
            if (maxChars && raw.length > maxChars) {
              const headSize = Math.floor(maxChars * 0.75)
              const tailSize = Math.max(0, maxChars - headSize - 100)
              const omitted = raw.length - headSize - tailSize
              raw = raw.substring(0, headSize)
                + `\n\n[... ${omitted} chars truncated ...]\n\n`
                + (tailSize > 0 ? raw.substring(raw.length - tailSize) : '')
            }

            return textResult(raw)
          } catch (err: any) {
            return textResult({ error: `MCP tool "${mcpTool.name}" failed: ${err.message}` })
          }
        },
      } as AgentTool
    })

    this.remoteServers.set(name, { name, config, client, transport, tools: agentTools })
    return agentTools
  }

  async stopServer(name: string): Promise<void> {
    const server = this.servers.get(name)
    if (!server) return

    try {
      await server.transport.close()
      console.log(`[MCPClient] Stopped "${name}"`)
    } catch (err: any) {
      console.error(`[MCPClient] Error stopping "${name}":`, err.message)
    }
    this.servers.delete(name)
  }

  async stopRemoteServer(name: string): Promise<void> {
    const server = this.remoteServers.get(name)
    if (!server) return

    try {
      await server.transport.close()
      console.log(`[MCPClient] Stopped remote "${name}"`)
    } catch (err: any) {
      console.error(`[MCPClient] Error stopping remote "${name}":`, err.message)
    }
    this.remoteServers.delete(name)
  }

  async stopAll(): Promise<void> {
    const names = [...this.servers.keys()]
    const remoteNames = [...this.remoteServers.keys()]
    await Promise.allSettled([
      ...names.map((name) => this.stopServer(name)),
      ...remoteNames.map((name) => this.stopRemoteServer(name)),
    ])
  }

  getTools(): AgentTool[] {
    const tools: AgentTool[] = []
    for (const server of this.servers.values()) {
      tools.push(...server.tools)
    }
    for (const server of this.remoteServers.values()) {
      tools.push(...server.tools)
    }
    return tools
  }

  getServerNames(): string[] {
    return [...this.servers.keys(), ...this.remoteServers.keys()]
  }

  isRunning(name: string): boolean {
    return this.servers.has(name) || this.remoteServers.has(name)
  }

  getServerInfo(): MCPServerInfo[] {
    const info: MCPServerInfo[] = []
    for (const server of this.servers.values()) {
      info.push({
        name: server.name,
        toolCount: server.tools.length,
        toolNames: server.tools.map(t => t.name),
        config: server.config,
      })
    }
    for (const server of this.remoteServers.values()) {
      info.push({
        name: server.name,
        toolCount: server.tools.length,
        toolNames: server.tools.map(t => t.name),
        config: { command: 'remote', args: [server.config.url] },
      })
    }
    return info
  }

  async hotAddServer(name: string, config: MCPServerConfig): Promise<AgentTool[]> {
    if (this.servers.size >= MAX_MCP_SERVERS) {
      throw new Error(`Cannot add server "${name}": maximum of ${MAX_MCP_SERVERS} MCP servers reached`)
    }
    const tools = await this.startServer(name, config)
    this.persistConfig(name, config)
    return tools
  }

  async hotRemoveServer(name: string): Promise<void> {
    await this.stopServer(name)
    this.unpersistConfig(name)
  }

  private persistConfig(name: string, config: MCPServerConfig): void {
    if (!this.workspaceDir) return
    const configPath = join(this.workspaceDir, 'config.json')
    let existing: Record<string, any> = {}
    if (existsSync(configPath)) {
      try { existing = JSON.parse(readFileSync(configPath, 'utf-8')) } catch { /* fresh config */ }
    }
    existing.mcpServers = existing.mcpServers || {}
    existing.mcpServers[name] = { command: config.command, ...(config.args ? { args: config.args } : {}), ...(config.env ? { env: config.env } : {}), ...(config.cwd ? { cwd: config.cwd } : {}) }
    writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8')
    this.onConfigPersisted?.()
  }

  private unpersistConfig(name: string): void {
    if (!this.workspaceDir) return
    const configPath = join(this.workspaceDir, 'config.json')
    if (!existsSync(configPath)) return
    try {
      const existing = JSON.parse(readFileSync(configPath, 'utf-8'))
      if (existing.mcpServers?.[name]) {
        delete existing.mcpServers[name]
        writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8')
      }
    } catch { /* ignore parse errors */ }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms),
    ),
  ])
}
