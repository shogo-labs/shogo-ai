import { WavesmithMetaDemo } from '../components/Unit2_WavesmithMetaSystem/WavesmithMetaDemo'

export function Unit2Page() {
  return (
    <div style={{ padding: '2rem', maxWidth: '1600px', margin: '0 auto' }}>
      <div style={{ marginBottom: '2rem' }}>
        <h1>Unit 2: Wavesmith Meta-System in Browser</h1>
        <p style={{ fontSize: '1.1rem', color: '#666', margin: '0.5rem 0 0 0' }}>
          Complete transformation pipeline: ArkType Schema → Enhanced JSON Schema → MST Models → Runtime Store
        </p>
      </div>

      <div style={{
        padding: '1rem',
        background: '#e8f5e9',
        border: '2px solid #4caf50',
        borderRadius: '8px',
        marginBottom: '2rem'
      }}>
        <h3 style={{ margin: '0 0 0.5rem 0', color: '#2e7d32' }}>✅ System Status: Tier 1 Loaded</h3>
        <p style={{ margin: 0, fontSize: '0.95rem' }}>
          <strong>11 TypeScript files</strong> loaded from source using Vite ?raw imports:
        </p>
        <ul style={{ margin: '0.5rem 0 0 0', paddingLeft: '1.5rem', fontSize: '0.9rem' }}>
          <li><strong>Schematic Layer (3 files):</strong> arktype-to-json-schema, enhanced-json-schema-to-mst, index</li>
          <li><strong>Meta Layer (4 files):</strong> meta-registry, meta-store, bootstrap, meta-helpers</li>
          <li><strong>Core Layer (2 files):</strong> types, index</li>
          <li><strong>Utils Layer (1 file):</strong> string utilities</li>
          <li><strong>Main Entry (1 file):</strong> package exports</li>
        </ul>
      </div>

      <WavesmithMetaDemo />

      <div style={{
        marginTop: '3rem',
        padding: '1.5rem',
        background: '#f5f5f5',
        borderRadius: '8px',
        fontSize: '0.9rem'
      }}>
        <h3 style={{ margin: '0 0 1rem 0' }}>Architecture Deep Dive</h3>

        <div style={{ marginBottom: '1rem' }}>
          <h4 style={{ margin: '0 0 0.5rem 0', color: '#2196f3' }}>Transformation Pipeline</h4>
          <ol style={{ margin: 0, paddingLeft: '1.5rem' }}>
            <li><strong>ArkType Schema Definition</strong> - Define schemas using arktype.scope()</li>
            <li><strong>Schema Extraction</strong> - Extract Enhanced JSON Schema with computed properties and references</li>
            <li><strong>MST Model Generation</strong> - Generate reactive MobX-State-Tree models with type safety</li>
            <li><strong>Runtime Store Creation</strong> - Instantiate stores with collections and CRUD operations</li>
          </ol>
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <h4 style={{ margin: '0 0 0.5rem 0', color: '#9c27b0' }}>Key Features Demonstrated</h4>
          <ul style={{ margin: 0, paddingLeft: '1.5rem' }}>
            <li>Zero inline strings - all files loaded via ?raw imports</li>
            <li>Full TypeScript type inference and validation</li>
            <li>Reactive state management with MobX observers</li>
            <li>Schema-driven runtime code generation</li>
            <li>Browser-native execution (no Node.js filesystem dependencies)</li>
          </ul>
        </div>

        <div>
          <h4 style={{ margin: '0 0 0.5rem 0', color: '#ff9800' }}>Next Steps (Tier 2 & 3)</h4>
          <ul style={{ margin: 0, paddingLeft: '1.5rem' }}>
            <li><strong>Tier 2:</strong> View system (query/template views), persistence abstractions</li>
            <li><strong>Tier 3:</strong> Behavioral system, browser persistence (localStorage/IndexedDB)</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
