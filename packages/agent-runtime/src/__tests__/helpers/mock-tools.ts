/**
 * Mock Tools for Pi Agent Core
 *
 * Creates Pi AgentTool instances with mock execute functions that track calls.
 */

import { Type } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'

interface ToolCall {
  name: string
  input: Record<string, any>
  timestamp: number
}

function textResult(data: any): AgentToolResult<any> {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
    details: data,
  }
}

export class MockToolTracker {
  public calls: ToolCall[] = []

  createTool(
    name: string,
    description: string,
    returnValue: any = { ok: true }
  ): AgentTool {
    const self = this
    return {
      name,
      description,
      label: name,
      parameters: Type.Object({
        input: Type.Optional(Type.String()),
        path: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId: string, params: any) => {
        self.calls.push({ name, input: params, timestamp: Date.now() })
        if (typeof returnValue === 'function') {
          return textResult(returnValue(params))
        }
        return textResult(returnValue)
      },
    }
  }

  getCallsFor(name: string): ToolCall[] {
    return this.calls.filter((c) => c.name === name)
  }

  reset(): void {
    this.calls = []
  }
}
