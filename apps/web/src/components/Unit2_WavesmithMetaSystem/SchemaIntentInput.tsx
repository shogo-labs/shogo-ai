import { useState } from 'react'
import { useMCPAgent } from '../../hooks/useMCPAgent'

interface SchemaIntentInputProps {
  onSchemaGenerated?: (schemaName: string) => void
}

export function SchemaIntentInput({ onSchemaGenerated }: SchemaIntentInputProps) {
  const [intent, setIntent] = useState('')
  const { isGenerating, error, lastGeneratedSchema, generateSchema } = useMCPAgent()

  const handleGenerate = async () => {
    if (!intent.trim()) return

    const result = await generateSchema(intent)

    if (result) {
      console.log(`✅ Schema generated: ${result.name}`)
      console.log(`📁 Location: .schemas/${result.name}/schema.json`)

      // Notify parent
      onSchemaGenerated?.(result.name)
    }
  }

  return (
    <div style={{
      padding: '1.5rem',
      background: '#f0f9ff',
      border: '2px solid #0284c7',
      borderRadius: '8px',
      marginBottom: '1.5rem'
    }}>
      <h3 style={{ margin: '0 0 1rem 0', color: '#0c4a6e' }}>
        🤖 AI Schema Generator
      </h3>

      <div style={{ marginBottom: '1rem' }}>
        <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
          Describe your schema in natural language:
        </label>
        <textarea
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          placeholder="e.g., 'A task management system with tasks, users, and projects'"
          disabled={isGenerating}
          style={{
            width: '100%',
            minHeight: '80px',
            padding: '0.75rem',
            fontSize: '0.95rem',
            border: '1px solid #cbd5e1',
            borderRadius: '4px',
            fontFamily: 'inherit',
            resize: 'vertical'
          }}
        />
      </div>

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
        <button
          onClick={handleGenerate}
          disabled={!intent.trim() || isGenerating}
          style={{
            padding: '0.75rem 1.5rem',
            background: isGenerating ? '#94a3b8' : '#0284c7',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            fontSize: '0.95rem',
            fontWeight: 'bold',
            cursor: isGenerating || !intent.trim() ? 'not-allowed' : 'pointer',
            transition: 'background 0.2s'
          }}
        >
          {isGenerating ? '⏳ Generating Schema...' : '✨ Generate Schema'}
        </button>

        {lastGeneratedSchema && !isGenerating && (
          <span style={{ color: '#059669', fontWeight: 'bold' }}>
            ✅ Generated: {lastGeneratedSchema}
          </span>
        )}
      </div>

      {error && (
        <div style={{
          marginTop: '1rem',
          padding: '0.75rem',
          background: '#fee2e2',
          border: '1px solid #ef4444',
          borderRadius: '4px',
          color: '#991b1b'
        }}>
          ❌ Error: {error}
        </div>
      )}

      {isGenerating && (
        <div style={{
          marginTop: '1rem',
          padding: '0.75rem',
          background: '#fef3c7',
          border: '1px solid #f59e0b',
          borderRadius: '4px',
          color: '#92400e'
        }}>
          ⏳ Agent is working on your schema... This may take 10-20 seconds.
        </div>
      )}
    </div>
  )
}
