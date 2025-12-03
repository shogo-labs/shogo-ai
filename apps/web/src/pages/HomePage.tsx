import { Link } from 'react-router-dom'

export function HomePage() {
  return (
    <div style={{ padding: '2rem', maxWidth: '1400px', margin: '0 auto' }}>
      <h1>Wavesmith State API - Browser Integration</h1>
      <p style={{ fontSize: '1.1rem', color: '#666', marginBottom: '3rem' }}>
        Progressive implementation: Node.js runtime → TypeScript execution → Meta-system pipeline
      </p>

      <div style={{
        background: '#1e1e1e',
        padding: '1rem',
        borderRadius: '8px',
        marginBottom: '2rem',
        border: '1px solid #333'
      }}>
        <h3 style={{ margin: '0 0 0.5rem 0' }}>✅ Unit 0: Front-end Scaffold - Complete</h3>
        <p style={{ margin: 0, opacity: 0.8 }}>
          React + Vite + Sandpack infrastructure in place
        </p>
      </div>

      <div style={{
        background: '#1e1e1e',
        padding: '1rem',
        borderRadius: '8px',
        marginBottom: '2rem',
        border: '1px solid #333'
      }}>
        <h3 style={{ margin: '0 0 0.5rem 0' }}>✅ Unit 1: Nodebox Integration - Complete</h3>
        <p style={{ margin: 0, opacity: 0.8 }}>
          Node.js execution, virtual filesystem, and wavesmith dependencies working in browser
        </p>
      </div>

      <div style={{
        background: '#1e1e1e',
        padding: '1rem',
        borderRadius: '8px',
        marginBottom: '2rem',
        border: '1px solid #333'
      }}>
        <h3 style={{ margin: '0 0 0.5rem 0' }}>✅ Unit 1.5: TypeScript Loading - Complete</h3>
        <p style={{ margin: 0, opacity: 0.8 }}>
          TypeScript executes in browser using vite-react-ts template with Vite bundler
        </p>
      </div>

      <div style={{
        background: '#1a2332',
        padding: '1rem',
        borderRadius: '8px',
        marginBottom: '2rem',
        border: '2px solid #2563eb'
      }}>
        <h3 style={{ margin: '0 0 0.5rem 0' }}>🔄 Unit 2: Wavesmith Meta-System - In Progress</h3>
        <p style={{ margin: '0 0 1rem 0', opacity: 0.8 }}>
          Loading complete meta-system (11 files): Schema transformation pipeline in browser
        </p>
        <Link
          to="/unit2"
          style={{
            display: 'inline-block',
            padding: '0.75rem 1.5rem',
            background: '#2196f3',
            color: 'white',
            textDecoration: 'none',
            borderRadius: '4px',
            fontWeight: 'bold',
            fontSize: '1rem'
          }}
        >
          Open Unit 2 Demo →
        </Link>
      </div>

      <div style={{
        marginTop: '3rem',
        padding: '1.5rem',
        background: '#f5f5f5',
        borderRadius: '8px'
      }}>
        <h3 style={{ margin: '0 0 1rem 0' }}>Legacy Test Components</h3>
        <p style={{ margin: '0 0 1rem 0', fontSize: '0.9rem', color: '#666' }}>
          Foundational tests from Unit 0, 1, and 1.5 (kept for reference)
        </p>
        <Link
          to="/legacy-tests"
          style={{
            display: 'inline-block',
            padding: '0.5rem 1rem',
            background: '#666',
            color: 'white',
            textDecoration: 'none',
            borderRadius: '4px',
            fontSize: '0.9rem'
          }}
        >
          View Legacy Tests
        </Link>
      </div>
    </div>
  )
}
