import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { v4 as uuid } from 'uuid'

// Wavesmith core (mirrors disk: /src/...)
import { enhancedJsonSchemaToMST } from '/src/schematic/enhanced-json-schema-to-mst'

// Client core (mirrors disk: /client/src/...)
import { WavesmithStoreProvider, useWavesmithStore } from '/client/src/contexts/WavesmithStoreContext'
import { EntityList } from '/client/src/components/EntityList'

// Workspace schema (loaded via HMR from /workspace/...)
import schema from '/workspace/minimal-cms/schema.json'

// Get models for display (store creation happens inside provider)
const { models } = enhancedJsonSchemaToMST(schema)

console.log('Schema loaded:', schema.name)
console.log('Models available:', Object.keys(models))

// Inner app component that uses the store
const AppContent = observer(function AppContent() {
  const store = useWavesmithStore()
  const [newPageTitle, setNewPageTitle] = useState('')

  const handleAddPage = () => {
    const title = newPageTitle.trim() || `Page ${store.pageCollection.all().length + 1}`
    const slug = title.toLowerCase().replace(/\s+/g, '-')

    store.pageCollection.add({
      id: uuid(),
      title,
      slug,
      status: 'draft'
    })

    setNewPageTitle('')
    console.log('Added page:', title)
  }

  const handleRemovePage = (id: string) => {
    store.pageCollection.remove(id)
    console.log('Removed page:', id)
  }

  const handleToggleStatus = (page: any) => {
    const newStatus = page.status === 'draft' ? 'published' : 'draft'
    page.setStatus(newStatus)
    console.log('Updated status:', page.title, '->', newStatus)
  }

  return (
    <div style={{ padding: '1.5rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ marginTop: 0 }}>Wavesmith MST Demo</h1>

      <div style={{
        padding: '1rem',
        background: '#dbeafe',
        borderRadius: '8px',
        marginBottom: '1.5rem'
      }}>
        <p style={{ margin: 0 }}>
          <strong>Schema:</strong> {schema.name} |{' '}
          <strong>Models:</strong> {Object.keys(models).join(', ')}
        </p>
        <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.875rem', color: '#1e40af' }}>
          This demo proves observer() reactivity - changes to MST store automatically re-render components.
        </p>
      </div>

      {/* Add Page Form */}
      <div style={{
        display: 'flex',
        gap: '0.5rem',
        marginBottom: '1rem'
      }}>
        <input
          type="text"
          value={newPageTitle}
          onChange={(e) => setNewPageTitle(e.target.value)}
          placeholder="New page title..."
          style={{
            flex: 1,
            padding: '0.5rem',
            border: '1px solid #d1d5db',
            borderRadius: '4px'
          }}
          onKeyDown={(e) => e.key === 'Enter' && handleAddPage()}
        />
        <button
          onClick={handleAddPage}
          style={{
            padding: '0.5rem 1rem',
            background: '#10b981',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer'
          }}
        >
          Add Page
        </button>
      </div>

      {/* Entity List using core component */}
      <EntityList
        collectionName="pageCollection"
        title="Pages"
        onAdd={handleAddPage}
        onRemove={handleRemovePage}
        renderItem={(page, index) => (
          <div
            key={page.id}
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
              <strong>{page.title}</strong>
              <span style={{ color: '#6b7280', marginLeft: '0.5rem' }}>
                /{page.slug}
              </span>
              <button
                onClick={() => handleToggleStatus(page)}
                style={{
                  marginLeft: '0.75rem',
                  padding: '0.125rem 0.5rem',
                  background: page.status === 'published' ? '#d1fae5' : '#fef3c7',
                  border: 'none',
                  borderRadius: '9999px',
                  fontSize: '0.75rem',
                  cursor: 'pointer'
                }}
              >
                {page.status}
              </button>
            </div>
            <button
              onClick={() => handleRemovePage(page.id)}
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
          </div>
        )}
      />

      {/* Debug: Store state */}
      <details style={{ marginTop: '1.5rem' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 'bold' }}>
          Debug: Store State ({store.pageCollection.all().length} pages)
        </summary>
        <pre style={{
          background: '#f5f5f5',
          padding: '1rem',
          borderRadius: '4px',
          overflow: 'auto',
          maxHeight: '300px',
          fontSize: '0.8rem'
        }}>
          {JSON.stringify(store.pageCollection.all().map((p: any) => ({
            id: p.id,
            title: p.title,
            slug: p.slug,
            status: p.status
          })), null, 2)}
        </pre>
      </details>
    </div>
  )
})

// Root app with provider - store creation happens INSIDE provider
export default function App() {
  return (
    <WavesmithStoreProvider schema={schema}>
      <AppContent />
    </WavesmithStoreProvider>
  )
}
