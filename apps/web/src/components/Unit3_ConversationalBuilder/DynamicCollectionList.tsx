/**
 * DynamicCollectionList - Generic observer-wrapped list for any MST collection
 *
 * Renders a simple list view with add/remove capabilities.
 * Uses schema-aware factory for entity creation.
 * Wraps in observer() for MobX reactivity.
 */

import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { createEntityDefaults } from '../../utils/schemaDefaults'

export interface DynamicCollectionListProps {
  /** The MST collection instance (e.g., store.pageCollection) */
  collection: any
  /** Human-readable model name (e.g., "Page") */
  modelName: string
  /** Model entity from meta-store with properties for default generation */
  model: any
  /** Primary field to display for each entity (defaults to 'title', falls back to 'name', then 'id') */
  primaryField?: string
}

export const DynamicCollectionList = observer(function DynamicCollectionList({
  collection,
  modelName,
  model,
  primaryField = 'title'
}: DynamicCollectionListProps) {
  const [saveStatus, setSaveStatus] = useState<string | null>(null)

  const entities = collection.all()

  const handleAdd = async () => {
    // Use schema-aware factory to generate valid defaults
    const newEntity = createEntityDefaults(model)

    // Customize display field if needed
    if (primaryField && (!newEntity[primaryField] || newEntity[primaryField] === '')) {
      newEntity[primaryField] = `New ${modelName}`
    }

    try {
      setSaveStatus('Adding...')
      collection.add(newEntity)

      // Persist if saveOne is available
      if (collection.saveOne) {
        await collection.saveOne(newEntity.id)
      }

      setSaveStatus('Added')
      setTimeout(() => setSaveStatus(null), 1500)
    } catch (err: any) {
      console.error('[DynamicCollectionList] Add failed:', err)
      setSaveStatus(`Failed: ${err.message}`)
    }
  }

  const handleRemove = async (id: string) => {
    try {
      setSaveStatus('Removing...')
      collection.remove(id)
      setSaveStatus('Removed')
      setTimeout(() => setSaveStatus(null), 1500)
    } catch (err: any) {
      console.error('[DynamicCollectionList] Remove failed:', err)
      setSaveStatus(`Failed: ${err.message}`)
    }
  }

  // Get display value for an entity - try primary field, then name, then id
  const getDisplayValue = (entity: any): string => {
    return entity[primaryField] || entity.name || entity.id || '(unnamed)'
  }

  return (
    <div style={{
      marginBottom: '1.5rem',
      padding: '1rem',
      background: 'white',
      borderRadius: '8px',
      border: '1px solid #d1fae5',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '0.75rem',
      }}>
        <h4 style={{ margin: 0, color: '#065f46' }}>
          {modelName} ({entities.length})
        </h4>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {saveStatus && (
            <span style={{
              fontSize: '0.8rem',
              color: saveStatus.startsWith('Failed') ? '#dc2626' : '#059669',
            }}>
              {saveStatus}
            </span>
          )}
          <button
            onClick={handleAdd}
            style={{
              padding: '0.25rem 0.75rem',
              background: '#059669',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '0.9rem',
            }}
          >
            + Add
          </button>
        </div>
      </div>

      {/* Entity List */}
      {entities.length === 0 ? (
        <div style={{
          padding: '1rem',
          textAlign: 'center',
          color: '#64748b',
          fontStyle: 'italic',
        }}>
          No {modelName.toLowerCase()}s yet. Click "Add" to create one.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {entities.map((entity: any, index: number) => (
            <div
              key={entity.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '0.5rem 0.75rem',
                background: index % 2 === 0 ? '#f0fdf4' : '#ecfdf5',
                borderRadius: '4px',
              }}
            >
              <span style={{ color: '#1e293b' }}>
                {getDisplayValue(entity)}
              </span>
              <button
                onClick={() => handleRemove(entity.id)}
                style={{
                  padding: '0.125rem 0.5rem',
                  background: 'transparent',
                  color: '#dc2626',
                  border: '1px solid #fca5a5',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '0.8rem',
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
})
