import { useState, useEffect } from 'react'
import { mcpService } from '../services'

export interface Artifact {
  id: string
  artifactType: 'schema' | 'entity' | 'other'
  artifactName: string
  toolName: string
  createdAt: number
}

/**
 * Hook to track artifacts created in a chat session
 * Queries the ai-sdk-chat schema for CreatedArtifact entities
 */
export function useArtifactTracker(sessionId: string | null): Artifact[] {
  const [artifacts, setArtifacts] = useState<Artifact[]>([])

  useEffect(() => {
    if (!sessionId) {
      setArtifacts([])
      return
    }

    // Poll for artifacts every 2 seconds
    const fetchArtifacts = async () => {
      try {
        // Ensure schema is loaded
        await mcpService.callTool('schema.load', { name: 'ai-sdk-chat' })

        // Query artifacts for this session
        const result = await mcpService.callTool('store.query', {
          schema: 'ai-sdk-chat',
          model: 'CreatedArtifact',
          filter: {
            // Note: We can't directly filter by reference in the query,
            // so we'll fetch all and filter client-side
          },
          terminal: 'toArray'
        })

        if (result.ok && result.data) {
          // Filter artifacts by session ID
          const sessionArtifacts = result.data
            .filter((a: any) => a.session === sessionId)
            .map((a: any) => ({
              id: a.id,
              artifactType: a.artifactType,
              artifactName: a.artifactName,
              toolName: a.toolName,
              createdAt: a.createdAt
            }))

          setArtifacts(sessionArtifacts)
        }
      } catch (error) {
        // Silently fail - schema might not exist yet
        console.debug('Could not fetch artifacts:', error)
      }
    }

    // Initial fetch
    fetchArtifacts()

    // Set up polling (every 15 seconds)
    const interval = setInterval(fetchArtifacts, 15000)

    return () => clearInterval(interval)
  }, [sessionId])

  return artifacts
}
