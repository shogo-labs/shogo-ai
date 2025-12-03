import { NodeboxTest } from '../components/NodeboxTest'
import { WavesmithImportTest } from '../components/WavesmithImportTest'
import { ErrorHandlingTest } from '../components/ErrorHandlingTest'
import { TypeScriptLoadTest } from '../components/TypeScriptLoadTest'

export function LegacyTestsPage() {
  return (
    <div style={{ padding: '2rem', maxWidth: '1400px', margin: '0 auto' }}>
      <h1>Legacy Test Components</h1>
      <p style={{ fontSize: '1.1rem', color: '#666', marginBottom: '2rem' }}>
        Foundational tests from Unit 0, 1, and 1.5
      </p>

      <NodeboxTest />

      <hr style={{ margin: '3rem 0', border: 'none', borderTop: '1px solid #333' }} />

      <WavesmithImportTest />

      <hr style={{ margin: '3rem 0', border: 'none', borderTop: '1px solid #333' }} />

      <ErrorHandlingTest />

      <hr style={{ margin: '3rem 0', border: 'none', borderTop: '1px solid #333' }} />

      <TypeScriptLoadTest />
    </div>
  )
}
