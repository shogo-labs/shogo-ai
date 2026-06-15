import * as vscode from 'vscode'
import type { AgentHealth, ChatRequest, ChatResponse } from './types'

function getConfiguredAgentUrl(): string | null {
  const configuredUrl = vscode.workspace.getConfiguration('shogo').get<string>('agentService.url')
  if (!configuredUrl || configuredUrl === 'http://127.0.0.1:0') return null
  return configuredUrl.replace(/\/$/, '')
}

export class ShogoAgentClient {
  async getHealth(): Promise<AgentHealth> {
    const url = getConfiguredAgentUrl()
    if (!url) {
      return {
        ok: false,
        status: 'not-configured',
        url: null,
        message: 'Shogo agent service is not configured yet. Phase 3 runs the extension shell without starting a local agent.',
      }
    }

    try {
      const response = await fetch(`${url}/health`)
      if (!response.ok) {
        return {
          ok: false,
          status: 'error',
          url,
          message: `Shogo agent service returned HTTP ${response.status}.`,
        }
      }

      return {
        ok: true,
        status: 'healthy',
        url,
        message: 'Shogo agent service is healthy.',
      }
    } catch (error) {
      return {
        ok: false,
        status: 'unreachable',
        url,
        message: `Shogo agent service is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  async sendChat(request: ChatRequest): Promise<ChatResponse> {
    const url = getConfiguredAgentUrl()
    if (!url) {
      const contextSummary = request.context.length > 0
        ? `\n\nContext attached: ${request.context.map((item) => item.label).join(', ')}`
        : '\n\nNo context attached yet.'

      return {
        ok: true,
        message:
          `Phase 3 Shogo Core extension shell received your prompt: "${request.prompt}".` +
          contextSummary +
          '\n\nNext phase wires this chat view to the local Shogo agent service for real model/tool execution.',
      }
    }

    try {
      const response = await fetch(`${url}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      const body = await response.json().catch(() => ({})) as Partial<ChatResponse>
      if (!response.ok) {
        return {
          ok: false,
          message: '',
          error: body.error || `Shogo agent chat failed with HTTP ${response.status}.`,
        }
      }
      return {
        ok: body.ok !== false,
        message: body.message || 'Shogo agent returned an empty response.',
        error: body.error,
      }
    } catch (error) {
      return {
        ok: false,
        message: '',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
