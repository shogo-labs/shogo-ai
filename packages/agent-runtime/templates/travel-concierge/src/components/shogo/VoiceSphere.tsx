import { OrganicSphere } from '@shogo-ai/sdk/voice/react'

interface VoiceSphereProps {
  getFrequencyData: () => Uint8Array | null
  active: boolean
  size?: number
  className?: string
}

export function VoiceSphere({
  getFrequencyData,
  active,
  size = 96,
  className,
}: VoiceSphereProps) {
  return (
    <div
      className={className}
      style={{ width: size, height: size }}
    >
      <OrganicSphere
        getFrequencyData={getFrequencyData}
        active={active}
      />
    </div>
  )
}
