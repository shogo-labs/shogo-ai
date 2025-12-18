import { ConversationalAppBuilder } from '../components/Unit3_ConversationalBuilder/ConversationalAppBuilder'
import { WavesmithMetaStoreProvider } from '../contexts/WavesmithMetaStoreContext'

export function Unit3Page() {
  return (
    <WavesmithMetaStoreProvider>
      <div className="p-8 h-[calc(100vh-80px)] flex flex-col">
        <div className="mb-4">
          <h1 className="text-3xl font-bold">Unit 3: Conversational App Builder</h1>
          <p className="text-muted-foreground mt-2">
            Multi-turn chat with Claude to discover requirements, generate schemas, and see working CRUD apps
          </p>
        </div>
        <ConversationalAppBuilder />
      </div>
    </WavesmithMetaStoreProvider>
  )
}
