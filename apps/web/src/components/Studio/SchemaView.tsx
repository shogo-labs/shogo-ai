/**
 * SchemaView - ReactFlow visualization of feature's schema
 *
 * Uses existing SchemaVisualizer component with feature-specific loading.
 */

import { useState, useEffect } from "react"
import { SchemaVisualizer, type SchemaModel } from "../SchemaVisualizer"
import { mcpService } from "../../services/mcpService"

interface SchemaViewProps {
  feature: any
}

export function SchemaView({ feature }: SchemaViewProps) {
  const [schemaModels, setSchemaModels] = useState<SchemaModel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const schemaName = feature?.schemaName

  // Load schema when feature changes
  useEffect(() => {
    if (!schemaName) {
      setSchemaModels([])
      return
    }

    const loadSchema = async () => {
      setLoading(true)
      setError(null)

      try {
        const result = await mcpService.loadSchema(schemaName)
        if (result.ok && result.models) {
          setSchemaModels(result.models)
        } else {
          setError(`Failed to load schema: ${schemaName}`)
        }
      } catch (err: any) {
        setError(err.message || `Failed to load schema: ${schemaName}`)
      } finally {
        setLoading(false)
      }
    }

    loadSchema()
  }, [schemaName])

  return (
    <div className="schema-view">
      <style>{schemaViewStyles}</style>

      {!schemaName ? (
        <div className="schema-empty">
          <h3>No Schema</h3>
          <p>This feature doesn't have an associated schema yet.</p>
          <p className="schema-hint">
            Schemas are created during the design phase when defining
            the domain model for the feature.
          </p>
        </div>
      ) : loading ? (
        <div className="schema-loading">
          <div className="loading-spinner" />
          <p>Loading schema: {schemaName}</p>
        </div>
      ) : error ? (
        <div className="schema-error">
          <h3>Error Loading Schema</h3>
          <p>{error}</p>
          <button
            className="retry-button"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </div>
      ) : schemaModels.length === 0 ? (
        <div className="schema-empty">
          <h3>Empty Schema</h3>
          <p>No models found in schema: {schemaName}</p>
        </div>
      ) : (
        <div className="schema-container">
          <SchemaVisualizer
            models={schemaModels}
            schemaName={schemaName}
          />
        </div>
      )}
    </div>
  )
}

const schemaViewStyles = `
  .schema-view {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .schema-container {
    flex: 1;
    padding: 1rem;
    overflow: hidden;
  }

  .schema-empty,
  .schema-loading,
  .schema-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    text-align: center;
    padding: 2rem;
  }

  .schema-empty h3,
  .schema-error h3 {
    margin: 0 0 0.5rem;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--studio-text);
  }

  .schema-empty p,
  .schema-loading p,
  .schema-error p {
    margin: 0;
    font-size: 0.875rem;
    color: var(--studio-text-muted);
    max-width: 400px;
  }

  .schema-hint {
    margin-top: 1rem !important;
    font-size: 0.75rem !important;
    opacity: 0.7;
  }

  .loading-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--studio-border);
    border-top-color: var(--studio-accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-bottom: 1rem;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .retry-button {
    margin-top: 1rem;
    padding: 0.5rem 1rem;
    background: var(--studio-accent);
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .retry-button:hover {
    background: var(--studio-accent-hover);
  }
`
