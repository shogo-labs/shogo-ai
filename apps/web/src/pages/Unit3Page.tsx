import { ConversationalAppBuilder } from '../components/Unit3_ConversationalBuilder/ConversationalAppBuilder'
import { WavesmithMetaStoreProvider } from '../contexts/WavesmithMetaStoreContext'

export function Unit3Page() {
  return (
    <WavesmithMetaStoreProvider>
      <div style={{ padding: '2rem', height: 'calc(100vh - 80px)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginBottom: '1rem' }}>
          <h1 style={{ margin: 0 }}>Unit 3: Conversational App Builder</h1>
          <p style={{ margin: '0.5rem 0 0 0', color: '#666' }}>
            Multi-turn chat with Claude to discover requirements, generate schemas, and see working CRUD apps
          </p>
        </div>
        <ConversationalAppBuilder />
      </div>
    </WavesmithMetaStoreProvider>
  )
}
