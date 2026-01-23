import { useState } from 'react'
import { mcpService } from '../services'

export interface AgentState {
  isGenerating: boolean
  error: string | null
  lastGeneratedSchema: string | null
}

export function useMCPAgent() {
  const [state, setState] = useState<AgentState>({
    isGenerating: false,
    error: null,
    lastGeneratedSchema: null,
  })

  const generateSchema = async (intent: string): Promise<{ name: string } | null> => {
    setState({ isGenerating: true, error: null, lastGeneratedSchema: null })

    try {
      const result = await mcpService.generateSchema(intent)

      if (!result.ok) {
        setState({
          isGenerating: false,
          error: result.error?.message || 'Schema generation failed',
          lastGeneratedSchema: null,
        })
        return null
      }

      setState({
        isGenerating: false,
        error: null,
        lastGeneratedSchema: result.schemaName || null,
      })

      return { name: result.schemaName! }
    } catch (error: any) {
      setState({
        isGenerating: false,
        error: error.message || 'Unknown error',
        lastGeneratedSchema: null,
      })
      return null
    }
  }

  const reset = () => {
    setState({ isGenerating: false, error: null, lastGeneratedSchema: null })
  }

  return {
    ...state,
    generateSchema,
    reset,
  }
}
