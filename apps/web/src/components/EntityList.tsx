/**
 * EntityList - Isomorphic generic entity list component
 *
 * Works in both standard React apps and Sandpack containers.
 * Wrapped in observer() for automatic MST reactivity.
 */

import { observer } from 'mobx-react-lite'
import { useWavesmithStore } from '../contexts/WavesmithStoreContext'

export interface EntityListProps {
  /** Name of the collection to display (e.g., 'pageCollection') */
  collectionName: string
  /** Render function for each entity */
  renderItem?: (entity: any, index: number) => React.ReactNode
  /** Callback when add button is clicked */
  onAdd?: () => void
  /** Callback when remove button is clicked for an entity */
  onRemove?: (id: string) => void
  /** Optional title for the list */
  title?: string
}

/**
 * Generic entity list that observes an MST collection.
 * Automatically re-renders when collection changes.
 */
export const EntityList = observer(function EntityList({
  collectionName,
  renderItem,
  onAdd,
  onRemove,
  title
}: EntityListProps) {
  const store = useWavesmithStore()
  const collection = store[collectionName]

  if (!collection) {
    return (
      <div style={{ padding: '1rem', color: '#ef4444' }}>
        Collection "{collectionName}" not found in store
      </div>
    )
  }

  const entities = collection.all()

  // Default render function if none provided
  const defaultRenderItem = (entity: any, index: number) => (
    <div
      key={entity.id}
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '0.75rem',
        background: index % 2 === 0 ? '#f9fafb' : '#ffffff',
        borderBottom: '1px solid #e5e7eb'
      }}
    >
      <div>
        <strong>{entity.title || entity.name || entity.id}</strong>
        {entity.status && (
          <span style={{
            marginLeft: '0.5rem',
            padding: '0.125rem 0.5rem',
            background: entity.status === 'published' ? '#d1fae5' : '#fef3c7',
            borderRadius: '9999px',
            fontSize: '0.75rem'
          }}>
            {entity.status}
          </span>
        )}
      </div>
      {onRemove && (
        <button
          onClick={() => onRemove(entity.id)}
          style={{
            padding: '0.25rem 0.5rem',
            background: '#fee2e2',
            border: '1px solid #fecaca',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '0.875rem'
          }}
        >
          Remove
        </button>
      )}
    </div>
  )

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '0.75rem 1rem',
        background: '#f3f4f6',
        borderBottom: '1px solid #e5e7eb'
      }}>
        <h3 style={{ margin: 0, fontSize: '1rem' }}>
          {title || collectionName} ({entities.length})
        </h3>
        {onAdd && (
          <button
            onClick={onAdd}
            style={{
              padding: '0.375rem 0.75rem',
              background: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '0.875rem'
            }}
          >
            + Add
          </button>
        )}
      </div>

      {/* Entity list */}
      <div>
        {entities.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: '#6b7280' }}>
            No entities yet. Click "+ Add" to create one.
          </div>
        ) : (
          entities.map((entity: any, index: number) =>
            renderItem ? renderItem(entity, index) : defaultRenderItem(entity, index)
          )
        )}
      </div>
    </div>
  )
})
