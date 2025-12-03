/**
 * App-HostDemo - Isomorphic Meta-Store Demo with Full CRUD (Sandpack Version)
 *
 * Demonstrates the complete isomorphic pattern:
 * 1. Dynamic schema loading via meta-store + MCPPersistence
 * 2. Runtime store creation with CollectionPersistable mixin
 * 3. Full CRUD operations with server persistence
 * 4. Observer reactivity via mobx-react-lite
 *
 * This proves that the same MST code works identically in Node.js (MCP server)
 * and browser contexts - only the persistence backend differs.
 */

import React, { useState, useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { v4 as uuid } from 'uuid'

import { WavesmithMetaStoreProvider, useWavesmithMetaStore } from '/client/src/contexts/WavesmithMetaStoreContext'
import { getRuntimeStore } from '/src/meta/runtime-store-cache'

/**
 * Main demo component - wraps in MetaStoreProvider
 */
export default function App() {
  return (
    <WavesmithMetaStoreProvider>
      <DynamicSchemaDemo />
    </WavesmithMetaStoreProvider>
  )
}

/**
 * Inner component that loads schema dynamically and shows CRUD demo
 */
const DynamicSchemaDemo = observer(function DynamicSchemaDemo() {
  const metaStore = useWavesmithMetaStore()
  const [schema, setSchema] = useState<any>(null)
  const [schemaId, setSchemaId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadSchemaOnce() {
      if (cancelled) return
      await loadSchema()
    }

    loadSchemaOnce()

    return () => {
      cancelled = true
    }
  }, [])

  async function loadSchema() {
    try {
      setLoading(true)
      setError(null)
      console.log('[App] Loading schema via meta-store...')

      // Dynamic schema loading via meta-store
      // This uses MCPPersistence under the hood
      const loadedSchema = await metaStore.loadSchema('minimal-cms')
      console.log('[App] Schema loaded:', loadedSchema.name)

      // Store both schema and its ID
      setSchema(loadedSchema)
      setSchemaId(loadedSchema.id)

      // Load existing data from server
      // Access runtime store directly from bootstrap cache instead of through schema entity
      const runtimeStore = getRuntimeStore(loadedSchema.id)
      if (!runtimeStore) {
        throw new Error('Runtime store not found after schema load')
      }

      console.log('[App] Loading existing data from server...')
      await runtimeStore.pageCollection.loadAll()
      console.log('[App] Data loaded:', runtimeStore.pageCollection.all().length, 'pages')

    } catch (err: any) {
      console.error('[App] Error:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>Loading schema from MCP server...</div>
        <div style={{ color: '#6b7280' }}>Fetching schema via MCPPersistence</div>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: '2rem' }}>
        <div style={{ color: '#dc2626', fontSize: '1.25rem', marginBottom: '0.5rem' }}>
          Error loading schema
        </div>
        <div style={{ color: '#6b7280', marginBottom: '1rem' }}>{error}</div>
        <button
          onClick={loadSchema}
          style={{
            padding: '0.5rem 1rem',
            background: '#3b82f6',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer'
          }}
        >
          Retry
        </button>
      </div>
    )
  }

  if (!schema) {
    return <div style={{ padding: '2rem' }}>No schema loaded</div>
  }

  // Get runtime store from cache using schema ID
  const runtimeStore = schemaId ? getRuntimeStore(schemaId) : null
  if (!runtimeStore) {
    return <div style={{ padding: '2rem' }}>Runtime store not available</div>
  }

  return <DemoContent schema={schema} runtimeStore={runtimeStore} saveStatus={saveStatus} setSaveStatus={setSaveStatus} />
})

/**
 * Demo content with full CRUD operations
 */
const DemoContent = observer(function DemoContent({
  schema,
  runtimeStore,
  saveStatus,
  setSaveStatus
}: {
  schema: any
  runtimeStore: any
  saveStatus: string | null
  setSaveStatus: (status: string | null) => void
}) {
  const store = runtimeStore
  const [newPageTitle, setNewPageTitle] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleAddPage = async () => {
    const title = newPageTitle.trim() || `Page ${store.pageCollection.all().length + 1}`
    const slug = title.toLowerCase().replace(/\s+/g, '-')
    const id = uuid()

    store.pageCollection.add({
      id,
      title,
      slug,
      status: 'draft'
    })

    setNewPageTitle('')

    // Auto-save to server immediately
    try {
      setSaveStatus('Saving...')
      await store.pageCollection.saveOne(id)
      setSaveStatus('Saved')
      setTimeout(() => setSaveStatus(null), 1000)
    } catch (err: any) {
      setSaveStatus(`Save failed: ${err.message}`)
    }

    console.log('[App] Added and saved page:', title)
  }

  const handleRemovePage = (id: string) => {
    store.pageCollection.remove(id)
    setSaveStatus('Unsaved changes')
    console.log('[App] Removed page:', id)
  }

  const handleToggleStatus = async (page: any) => {
    const newStatus = page.status === 'draft' ? 'published' : 'draft'
    page.setStatus(newStatus)

    // Auto-save to server immediately
    try {
      setSaveStatus('Saving...')
      await store.pageCollection.saveOne(page.id)
      setSaveStatus('Saved')
      setTimeout(() => setSaveStatus(null), 1000)
    } catch (err: any) {
      setSaveStatus(`Save failed: ${err.message}`)
    }

    console.log('[App] Updated and saved status:', page.title, '->', newStatus)
  }

  const handleLoad = async () => {
    try {
      setIsLoading(true)
      setSaveStatus('Loading...')
      console.log('[App] Loading from MCP server...')

      await store.pageCollection.loadAll()

      setSaveStatus('Loaded from server!')
      console.log('[App] Loaded from MCP server!')

      // Clear success message after 2 seconds
      setTimeout(() => setSaveStatus(null), 2000)
    } catch (err: any) {
      console.error('[App] Load error:', err)
      setSaveStatus(`Load failed: ${err.message}`)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      {/* Header */}
      <div style={{
        padding: '1rem',
        background: '#dbeafe',
        borderRadius: '8px',
        marginBottom: '1rem'
      }}>
        <p style={{ margin: 0 }}>
          <strong>Schema:</strong> {schema.name}{' '}
          <span style={{ color: '#6b7280', fontSize: '0.875rem' }}>(loaded dynamically via MCP)</span>
        </p>
        <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.875rem', color: '#1e40af' }}>
          This demo proves isomorphic persistence with auto-save - changes persist immediately to server.
        </p>
      </div>

      {/* Persistence Actions */}
      <div style={{
        display: 'flex',
        gap: '0.5rem',
        marginBottom: '1rem',
        padding: '1rem',
        background: '#f3f4f6',
        borderRadius: '8px',
        alignItems: 'center'
      }}>
        <button
          onClick={handleLoad}
          disabled={isLoading}
          style={{
            padding: '0.5rem 1rem',
            background: isLoading ? '#9ca3af' : '#3b82f6',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: isLoading ? 'not-allowed' : 'pointer'
          }}
        >
          {isLoading ? 'Syncing...' : 'Sync from Server'}
        </button>
        {saveStatus && (
          <span style={{
            marginLeft: '0.5rem',
            color: saveStatus.includes('failed') ? '#dc2626' :
                   saveStatus.includes('Unsaved') ? '#d97706' : '#16a34a',
            fontSize: '0.875rem'
          }}>
            {saveStatus}
          </span>
        )}
        <span style={{ marginLeft: 'auto', color: '#6b7280', fontSize: '0.875rem' }}>
          {store.pageCollection.all().length} pages
        </span>
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
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewPageTitle(e.target.value)}
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

      {/* Page List */}
      <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden' }}>
        {store.pageCollection.all().length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: '#6b7280' }}>
            No pages yet. Add one above!
          </div>
        ) : (
          store.pageCollection.all().map((page: any, index: number) => (
            <div
              key={page.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '0.75rem',
                background: index % 2 === 0 ? '#f9fafb' : '#ffffff',
                borderBottom: index < store.pageCollection.all().length - 1 ? '1px solid #e5e7eb' : 'none'
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
          ))
        )}
      </div>

      {/* Debug: Store state */}
      <details style={{ marginTop: '1.5rem' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 'bold' }}>
          Debug: Store State
        </summary>
        <pre style={{
          background: '#f5f5f5',
          padding: '1rem',
          borderRadius: '4px',
          overflow: 'auto',
          maxHeight: '300px',
          fontSize: '0.8rem'
        }}>
          {JSON.stringify({
            schema: {
              name: schema.name,
              id: schema.id,
              models: schema.models?.map((m: any) => m.name)
            },
            pages: store.pageCollection.all().map((p: any) => ({
              id: p.id,
              title: p.title,
              slug: p.slug,
              status: p.status
            }))
          }, null, 2)}
        </pre>
      </details>
    </div>
  )
})
