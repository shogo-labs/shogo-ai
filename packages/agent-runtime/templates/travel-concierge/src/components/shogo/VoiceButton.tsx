import { lazy, Suspense } from 'react'
import { useShogoVoice, ShogoVoiceProvider } from '@shogo-ai/sdk/voice/react'
import { Button } from '@/components/ui/button'
import { Mic, MicOff, Loader2 } from 'lucide-react'

const VoiceSphere = lazy(() =>
  import('./VoiceSphere').then((m) => ({ default: m.VoiceSphere }))
)

interface VoiceButtonProps {
  characterName?: string
  className?: string
  showSphere?: boolean
}

export function VoiceButton(props: VoiceButtonProps) {
  return (
    <ShogoVoiceProvider>
      <VoiceButtonInner {...props} />
    </ShogoVoiceProvider>
  )
}

function VoiceButtonInner({
  characterName = 'Shogo',
  className,
  showSphere = true,
}: VoiceButtonProps) {
  const { start, end, status, getOutputByteFrequencyData } = useShogoVoice({
    characterName,
  })

  const connecting = status === 'connecting'
  const active = status === 'connected' || connecting

  return (
    <div className={`flex items-center gap-3 ${className ?? ''}`}>
      {showSphere && active ? (
        <Suspense fallback={null}>
          <VoiceSphere
            getFrequencyData={getOutputByteFrequencyData}
            active={status === 'connected'}
            size={48}
          />
        </Suspense>
      ) : null}
      <Button
        onClick={() => (active ? end() : start())}
        variant={active ? 'destructive' : 'default'}
        size="sm"
        disabled={connecting}
      >
        {connecting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : active ? (
          <MicOff className="h-4 w-4" />
        ) : (
          <Mic className="h-4 w-4" />
        )}
        <span className="ml-2">
          {connecting ? 'Connecting…' : active ? 'End call' : `Talk to ${characterName}`}
        </span>
      </Button>
    </div>
  )
}
